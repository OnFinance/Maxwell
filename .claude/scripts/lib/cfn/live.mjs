// The company's own AWS account, read-only (optional): with the company's "AWS read-only role" credential, each
// template is validated by CloudFormation itself (validate-template) and, when the application's environment names
// the template's stack, the deployed stack is described and its drift detected (detect-stack-drift reads resources and
// changes none). Every call goes through lib/cfn/aws.mjs in "aws" mode: read-only calls only, anything that starts
// like a change refused before the CLI runs.
//   MAXWELL_AWS_RO_ROLE_ARN + MAXWELL_AWS_RO_EXTERNAL_ID   a role in the company's account Maxwell assumes, with
//        Maxwell's own principal (MAXWELL_AWS_ASSUMER_ACCESS_KEY_ID / MAXWELL_AWS_ASSUMER_SECRET_ACCESS_KEY)
//   MAXWELL_AWS_RO_ACCESS_KEY_ID + MAXWELL_AWS_RO_SECRET_ACCESS_KEY   or an access key pair of a read-only principal
//   MAXWELL_AWS_RO_REGION   the region (else the environment's hosting.region, else us-east-1)
import { statSync } from 'node:fs';
import { awsCall, awsContext } from './aws.mjs';

export const VALIDATE_BODY_MAX = 51200; // validate-template --template-body limit; larger needs an S3 URL (not used)

/** Which read-only credential the environment holds: { kind: 'role'|'keys', ... } or { kind: null, why }. Never logs a value. */
export function liveCredential(env = process.env) {
  if (env.MAXWELL_AWS_RO_ROLE_ARN) {
    if (!/^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/.test(env.MAXWELL_AWS_RO_ROLE_ARN)) return { kind: null, why: 'the AWS read-only role ARN is not a role ARN' };
    if (!env.MAXWELL_AWS_ASSUMER_ACCESS_KEY_ID || !env.MAXWELL_AWS_ASSUMER_SECRET_ACCESS_KEY) return { kind: null, why: 'a role ARN is set but the platform holds no principal to assume it with' };
    return { kind: 'role', roleArn: env.MAXWELL_AWS_RO_ROLE_ARN, externalId: env.MAXWELL_AWS_RO_EXTERNAL_ID || null,
      assumer: { accessKeyId: env.MAXWELL_AWS_ASSUMER_ACCESS_KEY_ID, secretAccessKey: env.MAXWELL_AWS_ASSUMER_SECRET_ACCESS_KEY } };
  }
  if (env.MAXWELL_AWS_RO_ACCESS_KEY_ID && env.MAXWELL_AWS_RO_SECRET_ACCESS_KEY)
    return { kind: 'keys', creds: { accessKeyId: env.MAXWELL_AWS_RO_ACCESS_KEY_ID, secretAccessKey: env.MAXWELL_AWS_RO_SECRET_ACCESS_KEY } };
  return { kind: null, why: "no AWS read-only role is set on the company's Credentials page: live AWS checks not run (cfn-lint, cfn-guard and the emulator ran offline)" };
}

/** A read-only context (the role assumed when it is a role). Returns { ctx, identity } or { ctx: null, why }. */
export function liveContext(cred, { region, awsBin, home, run, base }) {
  const o = { bin: awsBin, home, run, base };
  let ctx;
  if (cred.kind === 'role') {
    const assumer = awsContext(cred.assumer, region);
    const r = awsCall(assumer, 'sts', 'assume-role', ['--role-arn', cred.roleArn, '--role-session-name', 'maxwell-cfn-verify', '--duration-seconds', '3600',
      ...(cred.externalId ? ['--external-id', cred.externalId] : [])], o);
    const c = r.ok && r.json && r.json.Credentials;
    if (!c) return { ctx: null, why: `the read-only role could not be assumed: ${r.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'no answer'}` };
    ctx = awsContext({ accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }, region);
  } else ctx = awsContext(cred.creds, region);
  const who = awsCall(ctx, 'sts', 'get-caller-identity', [], o);
  if (!who.ok) return { ctx: null, why: `AWS did not accept the read-only credential: ${who.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'no answer'}` };
  return { ctx, identity: { account: who.json && who.json.Account, arn: who.json && who.json.Arn } };
}

/** validate-template, then (with a stack name) describe-stacks and drift detection. */
export async function liveChecks(ctx, { templateFile, stackName, awsBin, home, run, base, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), driftTimeoutMs = 300000 }) {
  const o = { bin: awsBin, home, run, base };
  const out = { validate: null, stack: null, drift: null };
  const size = statSync(templateFile).size;
  if (size > VALIDATE_BODY_MAX) out.validate = { status: 'not-run', reason: `the template is ${size} bytes; validate-template takes ${VALIDATE_BODY_MAX} inline and Maxwell uploads nothing to S3` };
  else {
    const v = awsCall(ctx, 'cloudformation', 'validate-template', ['--template-body', `file://${templateFile}`], o);
    out.validate = v.ok ? { status: 'valid', capabilities: (v.json && v.json.Capabilities) || [], parameters: ((v.json && v.json.Parameters) || []).map((p) => p.ParameterKey) }
      : { status: 'invalid', reason: v.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'no answer' };
  }
  if (!stackName) { out.stack = { status: 'not-run', reason: "no stack is named for this template in the application's environment files (iac[].stackName)" }; return out; }
  const d = awsCall(ctx, 'cloudformation', 'describe-stacks', ['--stack-name', stackName], o);
  const s = d.ok && d.json && d.json.Stacks && d.json.Stacks[0];
  if (!s) { out.stack = { status: 'absent', reason: d.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'no such stack' }; return out; }
  out.stack = { status: s.StackStatus, lastUpdated: s.LastUpdatedTime || s.CreationTime, driftStatus: s.DriftInformation && s.DriftInformation.StackDriftStatus };
  const det = awsCall(ctx, 'cloudformation', 'detect-stack-drift', ['--stack-name', stackName], o);
  const id = det.ok && det.json && det.json.StackDriftDetectionId;
  if (!id) { out.drift = { status: 'not-run', reason: det.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'no detection id' }; return out; }
  const t0 = Date.now();
  for (;;) {
    const st = awsCall(ctx, 'cloudformation', 'describe-stack-drift-detection-status', ['--stack-drift-detection-id', id], o);
    const j = st.ok && st.json;
    if (j && j.DetectionStatus !== 'DETECTION_IN_PROGRESS') { out.drift = { status: j.StackDriftStatus || j.DetectionStatus, detection: j.DetectionStatus, reason: j.DetectionStatusReason || null, drifted: j.DriftedStackResourceCount ?? null }; break; }
    if (!st.ok || Date.now() - t0 > driftTimeoutMs) { out.drift = { status: 'not-finished', reason: st.ok ? 'drift detection did not finish in time' : st.stderr.slice(-200) }; break; }
    await sleep(3000);
  }
  if (out.drift && out.drift.status === 'DRIFTED') {
    const rd = awsCall(ctx, 'cloudformation', 'describe-stack-resource-drifts', ['--stack-name', stackName, '--stack-resource-drift-status-filters', 'MODIFIED', 'DELETED'], o);
    out.drift.resources = ((rd.ok && rd.json && rd.json.StackResourceDrifts) || []).map((r) => ({ logicalId: r.LogicalResourceId, type: r.ResourceType, status: r.StackResourceDriftStatus,
      properties: (r.PropertyDifferences || []).map((p) => `${p.PropertyPath} (${p.DifferenceType})`).slice(0, 20) }));
  }
  return out;
}
