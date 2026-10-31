// A local AWS emulator for cfn-verify: each template is created in it (create-stack), its events and resources read,
// the security posture of what was created read back with describe calls, and the stack deleted. Nothing here reaches
// real AWS: every call is an emulator call (lib/cfn/aws.mjs: loopback only, "test" credentials).
//   moto        moto_server (pinned, hash-locked: the run tools' moto, or the toolchain pin) on 127.0.0.1:<port>
//   localstack  LocalStack's image by digest, only when Docker answers this user and LOCALSTACK_AUTH_TOKEN is set
//               (LocalStack needs an auth token since 2026-03; its free plan is non-commercial only)
// A resource the emulator does not model is "not verified", never passed; an emulator crash is "not verified" for the
// resources it did not create, with the emulator's own reason.
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { awsCall, emulatorContext } from './aws.mjs';
import { declared, parameterValues } from './templates.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port, host = '127.0.0.1') => new Promise((r) => { const s = connect({ port, host }); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

/** Starts the first emulator available; returns { name, version, ctx, stop, log } or { name: null, why }. */
export async function startEmulator({ port, tmp, moto, localstack, env = process.env, run = spawnSync }) {
  const reasons = [];
  if (await portOpen(port)) return { name: null, why: `something already listens on 127.0.0.1:${port}: no emulator started` };
  // LocalStack first when it can run here (Docker for this user and a token); else moto.
  if (localstack && env.LOCALSTACK_AUTH_TOKEN) {
    const info = run('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20000 });
    if (info.status === 0) {
      const name = `maxwell-cfn-${process.pid}`;
      const r = run('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:4566`, '-e', 'LOCALSTACK_AUTH_TOKEN', `${localstack.ref}@${localstack.digest}`],
        { encoding: 'utf8', timeout: 600000, env: { PATH: env.PATH, HOME: env.HOME || tmp, LOCALSTACK_AUTH_TOKEN: env.LOCALSTACK_AUTH_TOKEN } });
      if (r.status === 0) {
        const stop = () => run('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: 60000 });
        for (let i = 0; i < 180; i += 1) {
          try { const h = await fetch(`http://127.0.0.1:${port}/_localstack/health`); if (h.ok) { const j = await h.json(); if (j.services && j.services.cloudformation) return { name: 'localstack', version: localstack.version, ctx: await emulatorContext(`http://127.0.0.1:${port}`), stop, log: () => '' }; } } catch { /* starting */ }
          await sleep(1000);
        }
        stop();
        reasons.push('LocalStack did not become ready in 180 s');
      } else reasons.push(`LocalStack did not start: ${String(r.stderr || '').trim().slice(-300)}`);
    } else reasons.push('LocalStack not run: Docker does not answer this user (a hosted run sandbox gives its run user no Docker)');
  } else if (localstack) reasons.push('LocalStack not run: no LOCALSTACK_AUTH_TOKEN (LocalStack needs an auth token to start)');
  if (moto && moto.bin) {
    const logFile = join(tmp, 'moto.log');
    const fd = openSync(logFile, 'w');
    const child = spawn(moto.bin, ['-H', '127.0.0.1', '-p', String(port)], { stdio: ['ignore', fd, fd], env: { PATH: env.PATH, HOME: tmp, LANG: 'C.UTF-8' }, detached: false });
    closeSync(fd);
    let up = false;
    for (let i = 0; i < 150 && !up; i += 1) { await sleep(200); up = await portOpen(port); if (child.exitCode !== null) break; }
    const stop = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    if (up) return { name: 'moto', version: moto.version, ctx: await emulatorContext(`http://127.0.0.1:${port}`), stop, log: () => { try { return readFileSync(logFile, 'utf8'); } catch { return ''; } } };
    stop();
    reasons.push(`moto_server did not start: ${(() => { try { return readFileSync(logFile, 'utf8').slice(-300); } catch { return ''; } })()}`);
  } else reasons.push('moto not run: moto_server is not installed here');
  return { name: null, why: reasons.join('; ') };
}

/** The CLI's last error line, without an emulator's HTML error page. */
export function cliError(stderr) {
  const t = String(stderr || '');
  if (/500 Internal Server Error/.test(t)) return 'the emulator answered 500 Internal Server Error';
  return t.split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || 'no answer';
}

/** The emulator's last error for the resources of a failed create (moto's traceback: its service and exception). */
export function emulatorError(log) {
  const lines = String(log || '').split('\n');
  const svc = [...lines].reverse().map((l) => /moto\/([a-z0-9]+)\/models\.py/.exec(l)).find((m) => m && m[1] !== 'cloudformation' && m[1] !== 'core');
  const exc = [...lines].reverse().find((l) => /^[A-Za-z_.]+(Error|Exception|Exhausted)\b.*:?/.test(l.trim()) && !/^Traceback/.test(l));
  return { service: svc ? svc[1] : null, error: exc ? exc.trim().slice(0, 300) : null };
}

const PUBLIC_GRANTEES = /acs\.amazonaws\.com\/groups\/global\/(AllUsers|AuthenticatedUsers)/;
/** A policy document as an emulator returns it: an object, JSON, URL-encoded JSON (AWS) or a Python literal (moto). */
export function policyDocument(doc) {
  if (doc && typeof doc === 'object') return doc;
  if (typeof doc !== 'string') return null;
  for (const t of [doc, (() => { try { return decodeURIComponent(doc); } catch { return doc; } })()]) {
    try { return JSON.parse(t); } catch { /* next */ }
    if (/^\s*\{'/.test(t)) {
      try { return JSON.parse(t.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')); } catch { /* next */ }
    }
  }
  return null;
}
const wildcardStatements = (d) => {
  const st = d && d.Statement ? (Array.isArray(d.Statement) ? d.Statement : [d.Statement]) : [];
  return st.filter((s) => s.Effect === 'Allow' && [].concat(s.Action || []).some((a) => a === '*' || /^[a-z0-9-]+:\*$/i.test(a)) && [].concat(s.Resource || []).some((r) => r === '*'));
};

/**
 * The posture of one created resource, read back: [{ check, status: 'finding'|'pass'|'not-verified', message,
 * severity? }]. `res`: the template's resource (its declared properties tell an emulator gap from a real one).
 */
export function readPosture(call, res, physical) {
  const out = [];
  const add = (check, status, message, severity) => out.push({ check, status, message, ...(severity ? { severity } : {}) });
  switch (res.type) {
    case 'AWS::S3::Bucket': {
      const acl = call('s3api', 'get-bucket-acl', ['--bucket', physical]);
      const declaredAcl = declared(res, 'AccessControl');
      if (acl.ok) {
        const pub = (acl.json.Grants || []).filter((g) => PUBLIC_GRANTEES.test((g.Grantee && g.Grantee.URI) || ''));
        if (pub.length) add('s3-public-acl', 'finding', `the created bucket's ACL grants ${pub.map((g) => `${g.Permission} to ${g.Grantee.URI.split('/').pop()}`).join(', ')}`, 'high');
        else if (declaredAcl && /Public|Authenticated/i.test(declaredAcl)) add('s3-public-acl', 'not-verified', `the template sets AccessControl: ${declaredAcl}, which the emulator did not apply`);
        else add('s3-public-acl', 'pass', 'no public grant in the created bucket\'s ACL');
      } else add('s3-public-acl', 'not-verified', `get-bucket-acl failed in the emulator: ${acl.stderr.slice(-160)}`);
      const pab = call('s3api', 'get-public-access-block', ['--bucket', physical]);
      const declaredPab = declared(res, 'PublicAccessBlockConfiguration');
      if (pab.ok && pab.json && pab.json.PublicAccessBlockConfiguration) {
        const off = Object.entries(pab.json.PublicAccessBlockConfiguration).filter(([, v]) => v === false).map(([k]) => k);
        if (off.length) add('s3-public-access-block-off', 'finding', `the created bucket's public access block has ${off.join(', ')} off`, 'high');
        else add('s3-public-access-block-off', 'pass', 'all four public access block settings on');
      } else if (declaredPab !== undefined) add('s3-public-access-block-off', 'not-verified', 'the template declares PublicAccessBlockConfiguration, which the emulator did not apply');
      else add('s3-public-access-block-off', 'not-verified', 'no public access block in the template; real AWS turns it on for new buckets, the emulator does not model that default');
      const enc = call('s3api', 'get-bucket-encryption', ['--bucket', physical]);
      if (enc.ok) add('s3-no-default-encryption', 'pass', `default encryption ${JSON.stringify(((enc.json.ServerSideEncryptionConfiguration || {}).Rules || []).map((r) => r.ApplyServerSideEncryptionByDefault && r.ApplyServerSideEncryptionByDefault.SSEAlgorithm))}`);
      else if (declared(res, 'BucketEncryption') !== undefined) add('s3-no-default-encryption', 'not-verified', 'the template declares BucketEncryption, which the emulator did not apply');
      else add('s3-no-default-encryption', 'finding', 'the created bucket has no default encryption configuration (real AWS applies SSE-S3 by default since 2023-01; no KMS key is configured)', 'low');
      break;
    }
    case 'AWS::SQS::Queue': {
      const q = call('sqs', 'get-queue-attributes', ['--queue-url', physical, '--attribute-names', 'All']);
      if (!q.ok) { add('sqs-unencrypted', 'not-verified', `get-queue-attributes failed in the emulator: ${q.stderr.slice(-160)}`); break; }
      const a = (q.json && q.json.Attributes) || {};
      if (a.KmsMasterKeyId || a.SqsManagedSseEnabled === 'true') add('sqs-unencrypted', 'pass', a.KmsMasterKeyId ? 'encrypted with a KMS key' : 'SQS-managed encryption on');
      else if (declared(res, 'KmsMasterKeyId') !== undefined || /true/i.test(declared(res, 'SqsManagedSseEnabled') || '')) add('sqs-unencrypted', 'not-verified', 'the template sets encryption, which the emulator did not apply');
      else add('sqs-unencrypted', 'finding', 'the created queue has neither a KMS key nor SQS-managed encryption', 'medium');
      break;
    }
    case 'AWS::EC2::Volume': {
      const v = call('ec2', 'describe-volumes', ['--volume-ids', physical]);
      const vol = v.ok && v.json && v.json.Volumes && v.json.Volumes[0];
      if (!vol) { add('ebs-unencrypted', 'not-verified', `describe-volumes failed in the emulator: ${v.stderr.slice(-160)}`); break; }
      if (vol.Encrypted) add('ebs-unencrypted', 'pass', 'the created volume is encrypted');
      else add('ebs-unencrypted', 'finding', 'the created volume is not encrypted', 'high');
      break;
    }
    case 'AWS::EC2::SecurityGroup': {
      const g = call('ec2', 'describe-security-groups', ['--group-ids', physical]);
      const sg = g.ok && g.json && g.json.SecurityGroups && g.json.SecurityGroups[0];
      if (!sg) { add('sg-open-ingress', 'not-verified', `describe-security-groups failed in the emulator: ${g.stderr.slice(-160)}`); break; }
      const open = (sg.IpPermissions || []).filter((p) => (p.IpRanges || []).some((r) => r.CidrIp === '0.0.0.0/0') || (p.Ipv6Ranges || []).some((r) => r.CidrIpv6 === '::/0'));
      if (open.length) add('sg-open-ingress', 'finding', `the created security group admits the whole internet on ${open.map((p) => (p.IpProtocol === '-1' ? 'all traffic' : `${p.IpProtocol} ${p.FromPort === p.ToPort ? p.FromPort : `${p.FromPort}-${p.ToPort}`}`)).join(', ')}`, open.some((p) => p.IpProtocol === '-1' || [22, 3389].some((x) => p.FromPort <= x && x <= p.ToPort)) ? 'high' : 'medium');
      else add('sg-open-ingress', 'pass', 'no ingress from 0.0.0.0/0 or ::/0');
      break;
    }
    case 'AWS::IAM::Role': case 'AWS::IAM::User': case 'AWS::IAM::Group': {
      const kind = res.type.split('::')[2];
      const flag = { Role: '--role-name', User: '--user-name', Group: '--group-name' }[kind];
      const lower = kind.toLowerCase();
      const names = call('iam', `list-${lower}-policies`, [flag, physical]);
      const docs = [];
      for (const n of (names.ok && names.json && names.json.PolicyNames) || []) {
        const p = call('iam', `get-${lower}-policy`, [flag, physical, '--policy-name', n]);
        if (p.ok && p.json) docs.push([`inline policy ${n}`, p.json.PolicyDocument]);
      }
      const att = call('iam', `list-attached-${lower}-policies`, [flag, physical]);
      for (const a of (att.ok && att.json && att.json.AttachedPolicies) || []) {
        const pol = call('iam', 'get-policy', ['--policy-arn', a.PolicyArn]);
        const ver = pol.ok && pol.json && pol.json.Policy && pol.json.Policy.DefaultVersionId;
        if (!ver) continue;
        const pv = call('iam', 'get-policy-version', ['--policy-arn', a.PolicyArn, '--version-id', ver]);
        if (pv.ok && pv.json) docs.push([`attached policy ${a.PolicyName}`, pv.json.PolicyVersion.Document]);
      }
      if (!names.ok && !att.ok) { add('iam-wildcard', 'not-verified', `the emulator did not list the ${lower}'s policies`); break; }
      const unread = docs.filter(([, d]) => !policyDocument(d));
      const wild = docs.filter(([, d]) => wildcardStatements(policyDocument(d)).length);
      if (wild.length) add('iam-wildcard', 'finding', `the created ${lower} is allowed every action on every resource (or a whole service on *) through ${wild.map(([n]) => n).join(', ')}`, 'high');
      else if (unread.length) add('iam-wildcard', 'not-verified', `the emulator returned ${unread.map(([n]) => n).join(', ')} in a form Maxwell could not read`);
      else add('iam-wildcard', 'pass', `no Allow of * or <service>:* on Resource * in the ${lower}'s ${docs.length} policies`);
      break;
    }
    case 'AWS::IAM::ManagedPolicy': case 'AWS::IAM::Policy': {
      if (res.type === 'AWS::IAM::Policy') { add('iam-wildcard', 'not-verified', 'an inline AWS::IAM::Policy is read through the role, user or group it attaches to'); break; }
      const pol = call('iam', 'get-policy', ['--policy-arn', physical]);
      const ver = pol.ok && pol.json && pol.json.Policy && pol.json.Policy.DefaultVersionId;
      const pv = ver ? call('iam', 'get-policy-version', ['--policy-arn', physical, '--version-id', ver]) : null;
      if (!pv || !pv.ok) { add('iam-wildcard', 'not-verified', 'the emulator did not return the policy\'s document'); break; }
      const pd = policyDocument(pv.json.PolicyVersion.Document);
      if (!pd) add('iam-wildcard', 'not-verified', 'the emulator returned the policy document in a form Maxwell could not read');
      else if (wildcardStatements(pd).length) add('iam-wildcard', 'finding', 'the created managed policy allows every action (or a whole service) on Resource *', 'high');
      else add('iam-wildcard', 'pass', 'no Allow of * or <service>:* on Resource *');
      break;
    }
    default: break;
  }
  return out;
}

/**
 * Creates `templateFile` (its parsed form `tpl`) as a stack in the emulator, waits, reads events, resources and
 * posture, deletes it. Returns { status, reason, params, created: [...], notVerified: [...], failed: [...], posture: [...] }.
 */
export async function verifyInEmulator(em, { templateFile, tpl, stackName, tmp, awsBin, timeoutMs = 180000 }) {
  const call = (service, op, args) => awsCall(em.ctx, service, op, args, { bin: awsBin, home: tmp });
  const p = parameterValues(tpl.parameters);
  const paramsFile = join(tmp, `${stackName}.params.json`);
  writeFileSync(paramsFile, JSON.stringify(p.values));
  const out = { stackName, params: p.filled, paramsMissing: p.missing, status: null, reason: null, created: [], notVerified: [], failed: [], posture: [] };
  const all = tpl.resources.map((r) => r.logicalId);
  const create = call('cloudformation', 'create-stack', ['--stack-name', stackName, '--template-body', `file://${templateFile}`, '--parameters', `file://${paramsFile}`,
    '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND', '--disable-rollback']);
  const emErr = () => emulatorError(em.log());
  if (!create.ok) {
    const e = emErr();
    out.status = 'EMULATOR_ERROR';
    out.reason = `the emulator could not create the stack: ${cliError(create.stderr)}${e.error ? ` (${e.service ? `in its ${e.service} model: ` : ''}${e.error})` : ''}`;
    out.emulatorService = e.service;
  } else {
    const t0 = Date.now();
    for (;;) {
      const d = call('cloudformation', 'describe-stacks', ['--stack-name', stackName]);
      const s = d.ok && d.json && d.json.Stacks && d.json.Stacks[0];
      if (s && !/_IN_PROGRESS$/.test(s.StackStatus)) { out.status = s.StackStatus; out.reason = s.StackStatusReason || null; break; }
      if (!d.ok) { const e = emErr(); out.status = 'EMULATOR_ERROR'; out.reason = `describe-stacks failed: ${cliError(d.stderr)}${e.error ? ` (${e.error})` : ''}`; break; }
      if (Date.now() - t0 > timeoutMs) { out.status = 'TIMEOUT'; out.reason = `still ${s ? s.StackStatus : 'unknown'} after ${timeoutMs / 1000} s`; break; }
      await sleep(1000);
    }
  }
  const ev = call('cloudformation', 'describe-stack-events', ['--stack-name', stackName]);
  for (const e of (ev.ok && ev.json && ev.json.StackEvents) || []) {
    if (/FAILED$/.test(e.ResourceStatus || '') && e.LogicalResourceId && e.LogicalResourceId !== stackName)
      out.failed.push({ logicalId: e.LogicalResourceId, type: e.ResourceType, status: e.ResourceStatus, reason: e.ResourceStatusReason || null });
  }
  const rs = call('cloudformation', 'describe-stack-resources', ['--stack-name', stackName]);
  const got = new Map();
  for (const r of (rs.ok && rs.json && rs.json.StackResources) || []) if (r.LogicalResourceId && all.includes(r.LogicalResourceId)) got.set(r.LogicalResourceId, r);
  for (const res of tpl.resources) {
    const r = got.get(res.logicalId);
    if (r && /COMPLETE$/.test(r.ResourceStatus || '') && !/DELETE/.test(r.ResourceStatus) && r.PhysicalResourceId) {
      out.created.push({ logicalId: res.logicalId, type: res.type, physicalId: r.PhysicalResourceId });
      for (const c of readPosture(call, res, r.PhysicalResourceId)) out.posture.push({ logicalId: res.logicalId, type: res.type, ...c });
    } else if (!out.failed.some((f) => f.logicalId === res.logicalId)) {
      out.notVerified.push({ logicalId: res.logicalId, type: res.type,
        reason: out.status === 'EMULATOR_ERROR' ? out.reason : r ? `the emulator left it ${r.ResourceStatus}${r.ResourceStatusReason ? `: ${r.ResourceStatusReason}` : ''}` : `${em.name} does not model ${res.type || 'this resource'}` });
    }
  }
  call('cloudformation', 'delete-stack', ['--stack-name', stackName]);
  return out;
}
