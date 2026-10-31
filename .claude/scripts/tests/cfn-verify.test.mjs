// cfn-verify (toolchain/cfn-verify.mjs, lib/cfn/*): templates and their lines, the AWS call policy (read-only against
// real AWS, create/delete only against a loopback emulator), the SARIF it writes, and the whole command with stand-in
// tools: no credential (live AWS not run, said so), a read-only credential (only read calls, against a stand-in AWS
// CLI), an emulator on loopback (create-stack, read-back, delete-stack, with throwaway credentials only).
// With MAXWELL_CFN_REAL_TOOLS=<dir of cfn-lint, cfn-guard, aws, moto_server> and RUN_TOOLS_DATA (the platform's run
// tools), the same command runs the real tools over the fixture template and checks what they found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';
import { findTemplates, isTemplate, parameterValues, readTemplate, withoutTags, declared } from '../lib/cfn/templates.mjs';
import { awsCall, awsContext, awsEnv, checkAwsCall, emulatorContext, loopbackEndpoint, MUTATING, READ_ONLY } from '../lib/cfn/aws.mjs';
import { emulatorError, policyDocument } from '../lib/cfn/emulator.mjs';
import { liveCredential } from '../lib/cfn/live.mjs';
import { toSarif } from '../lib/cfn/sarif.mjs';

const FIXTURE = `AWSTemplateFormatVersion: '2010-09-09'
Description: a fixture with known issues
Parameters:
  Tier:
    Type: String
    AllowedValues: [dev, prod]
  Name:
    Type: String
    AllowedPattern: '^[a-z][a-z0-9-]{2,20}$'
Resources:
  PublicBucket:
    Type: AWS::S3::Bucket
    Properties:
      AccessControl: PublicRead
      Tags:
        - Key: team
          Value: core
  OpenGroup:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: open
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 22
          ToPort: 22
          CidrIp: 0.0.0.0/0
  Unsupported:
    Type: AWS::Pipes::Pipe
    Properties:
      RoleArn: !GetAtt Role.Arn
Outputs:
  B:
    Value: !Ref PublicBucket
`;

const tmp = () => mkdtempSync(join(tmpdir(), 'maxwell-cfn-test-'));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('templates: found by content, resources and parameters with their lines, tags stripped from a copy only', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'infra'), { recursive: true }); mkdirSync(join(d, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(d, 'infra', 'stack.yaml'), FIXTURE);
    writeFileSync(join(d, 'infra', 'stack.json'), JSON.stringify({ AWSTemplateFormatVersion: '2010-09-09', Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { Tags: [{ Key: 'a', Value: 'b' }] } } } }, null, 2));
    writeFileSync(join(d, 'infra', 'values.yaml'), 'replicas: 2\nimage: x\n');
    writeFileSync(join(d, 'node_modules', 'x', 't.yaml'), FIXTURE);
    assert.deepEqual(findTemplates(d).templates, ['infra/stack.json', 'infra/stack.yaml'], 'templates by content; node_modules skipped; a values file is not a template');
    assert.equal(isTemplate('Resources:\n  A:\n    Type: AWS::S3::Bucket\n'), true);
    const t = readTemplate(FIXTURE);
    assert.deepEqual(t.resources.map((r) => [r.logicalId, r.type, r.line]), [['PublicBucket', 'AWS::S3::Bucket', 11], ['OpenGroup', 'AWS::EC2::SecurityGroup', 18], ['Unsupported', 'AWS::Pipes::Pipe', 27]]);
    assert.equal(declared(t.resources[0], 'AccessControl'), 'PublicRead');
    assert.equal(declared(t.resources[0], 'BucketEncryption'), undefined);
    const p = parameterValues(t.parameters);
    assert.deepEqual(p.values, [{ ParameterKey: 'Tier', ParameterValue: 'dev' }, { ParameterKey: 'Name', ParameterValue: 'maxwell-verify' }], 'the first allowed value; a placeholder that matches the pattern');
    const j = readTemplate(readFileSync(join(d, 'infra', 'stack.json'), 'utf8'));
    assert.deepEqual(j.resources.map((r) => [r.logicalId, r.line]), [['Q', 4]]);
    const untagged = withoutTags(FIXTURE);
    assert.ok(!/Tags:|Key: team/.test(untagged) && /AccessControl: PublicRead/.test(untagged) && /CidrIp: 0.0.0.0\/0/.test(untagged), 'only the Tags blocks go');
    assert.ok(!withoutTags(readFileSync(join(d, 'infra', 'stack.json'), 'utf8')).includes('Tags'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the AWS policy: real AWS gets read-only calls only; create and delete go only to a loopback emulator', async () => {
  const live = awsContext({ accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'x'.repeat(40) }, 'ap-south-1');
  for (const [svc, op] of [['cloudformation', 'create-stack'], ['cloudformation', 'update-stack'], ['cloudformation', 'delete-stack'], ['cloudformation', 'execute-change-set'],
    ['cloudformation', 'create-change-set'], ['cloudformation', 'set-stack-policy'], ['s3api', 'put-bucket-acl'], ['iam', 'attach-role-policy'], ['ec2', 'terminate-instances'], ['cloudformation', 'deploy']])
    assert.throws(() => checkAwsCall(live, svc, op, []), /refused/, `${svc} ${op}`);
  assert.throws(() => checkAwsCall(live, 's3', 'ls', []), /not one of the read-only calls/);
  for (const [svc, ops] of Object.entries(READ_ONLY)) for (const op of ops) { assert.doesNotThrow(() => checkAwsCall(live, svc, op, [])); assert.ok(!MUTATING.test(op), op); }
  assert.throws(() => checkAwsCall(live, 'cloudformation', 'describe-stacks', ['--endpoint-url', 'http://127.0.0.1:1']), /not allowed/);
  assert.throws(() => checkAwsCall(live, 'cloudformation', 'describe-stacks', ['--profile=prod']), /not allowed/);
  // The emulator's endpoint: loopback only, a name only when every address it resolves to is loopback.
  for (const bad of ['https://cloudformation.us-east-1.amazonaws.com', 'http://169.254.169.254', 'http://10.0.0.5:4566', 'http://user:pw@127.0.0.1:4566', 'file:///etc/passwd', 'http://127.0.0.1:4566/x?y=1'])
    await assert.rejects(loopbackEndpoint(bad, { resolve: async () => [{ address: '52.94.0.1' }] }), /refused|must be|not a URL/, bad);
  await assert.rejects(loopbackEndpoint('http://emulator.local:4566', { resolve: async () => [{ address: '127.0.0.1' }, { address: '52.94.0.1' }] }), /not on loopback/, 'a name that also resolves elsewhere');
  await assert.rejects(loopbackEndpoint('http://localhost:4566', { resolve: async () => [{ address: '54.239.28.85' }] }), /not on loopback/, 'a hijacked localhost');
  assert.equal(await loopbackEndpoint('http://127.0.0.1:4566'), 'http://127.0.0.1:4566');
  assert.equal(await loopbackEndpoint('http://[::1]:4566'), 'http://[::1]:4566');
  assert.equal(await loopbackEndpoint('http://localhost:4566', { resolve: async () => [{ address: '127.0.0.1' }, { address: '::1' }] }), 'http://localhost:4566');
  const em = await emulatorContext('http://127.0.0.1:4566');
  assert.doesNotThrow(() => checkAwsCall(em, 'cloudformation', 'create-stack', []), 'against the emulator create-stack is allowed');
  assert.doesNotThrow(() => checkAwsCall(em, 'cloudformation', 'delete-stack', []));
  assert.throws(() => checkAwsCall({ mode: 'emulator', endpoint: 'https://cloudformation.us-east-1.amazonaws.com' }, 'cloudformation', 'create-stack', []), /not checked for loopback/, 'an unchecked endpoint never gets a call');
  assert.throws(() => checkAwsCall({ ...em, endpoint: 'http://52.94.0.1:443' }, 'cloudformation', 'create-stack', []), /not on loopback/, 'a context changed after the check');
  // The CLI's environment: the emulator's has throwaway credentials and no proxy whatever the parent holds; real AWS's
  // never inherits an endpoint override.
  const base = { PATH: '/usr/bin', AWS_ACCESS_KEY_ID: 'AKIAREALREALREAL0000', AWS_SECRET_ACCESS_KEY: 'real', AWS_ENDPOINT_URL: 'http://evil.example', HTTPS_PROXY: 'http://127.0.0.1:3128', AWS_PROFILE: 'prod' };
  const ee = awsEnv(em, base, '/tmp');
  assert.equal(ee.AWS_ACCESS_KEY_ID, 'test'); assert.equal(ee.AWS_SECRET_ACCESS_KEY, 'test'); assert.equal(ee.AWS_ENDPOINT_URL, 'http://127.0.0.1:4566');
  assert.equal(ee.HTTPS_PROXY, undefined); assert.equal(ee.AWS_PROFILE, undefined);
  const le = awsEnv(live, base, '/tmp');
  assert.equal(le.AWS_ENDPOINT_URL, undefined); assert.equal(le.AWS_PROFILE, undefined); assert.equal(le.HTTPS_PROXY, 'http://127.0.0.1:3128', 'real AWS through the run\'s proxy');
  assert.equal(le.AWS_ACCESS_KEY_ID, 'AKIAEXAMPLEEXAMPLE00');
  // awsCall refuses before anything runs.
  let ran = false;
  assert.throws(() => awsCall(live, 'cloudformation', 'create-stack', ['--stack-name', 'x'], { run: () => { ran = true; return { status: 0 }; } }), /refused/);
  assert.equal(ran, false, 'the CLI never ran');
  const r = awsCall(em, 'cloudformation', 'create-stack', ['--stack-name', 'x'], { run: (bin, argv, o) => { ran = argv; return { status: 0, stdout: '{"StackId":"s"}', env: o.env }; } });
  assert.deepEqual(ran.slice(0, 2), ['--endpoint-url', 'http://127.0.0.1:4566'], 'every emulator call names its endpoint');
  assert.equal(r.json.StackId, 's');
});

test('what the read-only credential is; an emulator\'s errors and policy documents', () => {
  assert.equal(liveCredential({}).kind, null);
  assert.match(liveCredential({}).why, /no AWS read-only role/);
  assert.equal(liveCredential({ MAXWELL_AWS_RO_ACCESS_KEY_ID: 'A', MAXWELL_AWS_RO_SECRET_ACCESS_KEY: 'B' }).kind, 'keys');
  assert.match(liveCredential({ MAXWELL_AWS_RO_ROLE_ARN: 'arn:aws:iam::123456789012:role/maxwell-ro' }).why, /no principal to assume it/);
  assert.equal(liveCredential({ MAXWELL_AWS_RO_ROLE_ARN: 'arn:aws:iam::123456789012:role/maxwell-ro', MAXWELL_AWS_RO_EXTERNAL_ID: 'e', MAXWELL_AWS_ASSUMER_ACCESS_KEY_ID: 'a', MAXWELL_AWS_ASSUMER_SECRET_ACCESS_KEY: 'b' }).kind, 'role');
  assert.match(liveCredential({ MAXWELL_AWS_RO_ROLE_ARN: 'not-an-arn' }).why, /not a role ARN/);
  assert.deepEqual(emulatorError('  File "/x/moto/kms/models.py", line 409, in create_key\n  File "/x/moto/utilities/tagging_service.py"\nKeyError: \'TagKey\'\n'), { service: 'kms', error: "KeyError: 'TagKey'" });
  assert.deepEqual(policyDocument("{'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Action': '*', 'Resource': '*'}]}").Statement[0].Action, '*', "moto's Python literal");
  assert.equal(policyDocument(encodeURIComponent('{"Statement":[]}')).Statement.length, 0, "AWS's URL-encoded JSON");
  assert.equal(policyDocument('not a policy'), null);
});

test('SARIF: cfn-guard\'s real line from its message, rule sets merged, not-verified never a pass', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 't.yaml'), FIXTURE);
    const msg = 'Check was not compliant as property value [Path=/Resources/OpenGroup/Properties/SecurityGroupIngress/0[L:23,C:10] Value=...]\n    Guard Rule Set: rbi-md-itf\n    Controls: RBI-MD-ITF-4.4\n';
    const sarif = toSarif({
      report: { emulator: { name: 'moto', version: '5.2.4', endpoint: 'http://127.0.0.1:1', stacks: [] }, liveAws: { ran: false } },
      lint: [{ ruleId: 'E3045', message: { text: 'x' }, locations: [{ physicalLocation: { artifactLocation: { uri: join(d, 't.yaml') }, region: { startLine: 13 } } }], path: 't.yaml' }],
      guard: [{ ruleId: 'INCOMING_SSH_DISABLED', level: 'error', message: { text: msg }, path: 't.yaml', ruleSet: 'guard-rules-registry-all-rules' }, { ruleId: 'INCOMING_SSH_DISABLED', level: 'error', message: { text: msg }, path: 't.yaml', ruleSet: 'rbi-md-itf' }],
      emulated: [{ path: 't.yaml', result: { status: 'CREATE_COMPLETE', failed: [], created: [], notVerified: [{ logicalId: 'Unsupported', type: 'AWS::Pipes::Pipe', reason: 'moto does not model AWS::Pipes::Pipe' }],
        posture: [{ logicalId: 'OpenGroup', type: 'AWS::EC2::SecurityGroup', check: 'sg-open-ingress', status: 'finding', severity: 'high', message: 'open on tcp 22' }] } }],
      live: [], tools: { 'cfn-lint': { version: '1.56.3' }, 'cfn-guard': { version: '3.2.1' } }, ruleSets: [{ name: 'guard-rules-registry-all-rules', sha256: 'a' }, { name: 'rbi-md-itf', sha256: 'b' }],
      pins: { guardRules: { version: '1.0.2' } }, checkout: d });
    const [lint, guard, emu] = sarif.runs;
    assert.equal(lint.results[0].level, 'error'); assert.equal(lint.results[0].locations[0].physicalLocation.artifactLocation.uri, 't.yaml');
    assert.equal(lint.results[0].properties.resource, 'PublicBucket', 'the resource the line falls in');
    assert.equal(guard.results.length, 1, 'one place, one result');
    assert.equal(guard.results[0].locations[0].physicalLocation.region.startLine, 23, 'the line cfn-guard names in its message');
    assert.deepEqual(guard.results[0].properties.ruleSets, ['guard-rules-registry-all-rules', 'rbi-md-itf']);
    assert.equal(guard.results[0].properties.controls, 'RBI-MD-ITF-4.4');
    assert.equal(guard.results[0].properties.resource, 'OpenGroup');
    const nv = emu.results.find((r) => r.ruleId === 'emulator-not-verified');
    assert.equal(nv.kind, 'review'); assert.equal(nv.level, 'none'); assert.equal(nv.properties.verification, 'not-verified');
    assert.equal(nv.locations[0].physicalLocation.region.startLine, 27, 'at the resource');
    const f = emu.results.find((r) => r.ruleId === 'emulated-sg-open-ingress');
    assert.equal(f.level, 'error'); assert.equal(f.properties['security-severity'], '7.5'); assert.equal(f.locations[0].physicalLocation.region.startLine, 18);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---------- the command, with stand-in tools ----------
const STANDINS = {
  'cfn-lint': `#!/bin/sh
[ "$1" = "--version" ] && { echo "cfn-lint 1.56.3"; exit 0; }
f=""; for a in "$@"; do f="$a"; done
printf '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"cfn-lint"}},"results":[{"ruleId":"W3045","message":{"text":"legacy AccessControl"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"%s"},"region":{"startLine":14}}}]}]}]}' "$f"
exit 4
`,
  'cfn-guard': `#!/bin/sh
[ "$1" = "--version" ] && { echo "cfn-guard 3.2.1"; exit 0; }
exit 0
`,
  // A stand-in AWS CLI (the "fake AWS endpoint"): every call is logged (beside its directory: the CLI gets no
  // environment of the test's) with its endpoint and key, answers come from a table.
  aws: `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('aws-cli/2.37.5 stand-in'); process.exit(0); }
const ep = a[0] === '--endpoint-url' ? a[1] : null;
const rest = ep ? a.slice(2) : a;
const i = rest.indexOf('--no-cli-pager'); const [svc, op, ...args] = rest.slice(i + 1);
fs.appendFileSync(require('node:path').join(__dirname, '..', 'aws.log'), JSON.stringify({ svc, op, args, endpoint: ep, key: process.env.AWS_ACCESS_KEY_ID, envEndpoint: process.env.AWS_ENDPOINT_URL || null }) + '\\n');
const out = (o) => { console.log(JSON.stringify(o)); process.exit(0); };
const err = (m) => { console.error(m); process.exit(254); };
const k = svc + ' ' + op;
if (k === 'sts get-caller-identity') out({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/maxwell-ro' });
if (k === 'cloudformation validate-template') out({ Parameters: [], Capabilities: [] });
if (k === 'cloudformation describe-stacks' && !ep) return args.includes('demo-stack') ? out({ Stacks: [{ StackName: 'demo-stack', StackStatus: 'UPDATE_COMPLETE' }] }) : err('Stack does not exist');
if (k === 'cloudformation detect-stack-drift') out({ StackDriftDetectionId: 'd-1' });
if (k === 'cloudformation describe-stack-drift-detection-status') out({ DetectionStatus: 'DETECTION_COMPLETE', StackDriftStatus: 'DRIFTED', DriftedStackResourceCount: 1 });
if (k === 'cloudformation describe-stack-resource-drifts') out({ StackResourceDrifts: [{ LogicalResourceId: 'OpenGroup', ResourceType: 'AWS::EC2::SecurityGroup', StackResourceDriftStatus: 'MODIFIED', PropertyDifferences: [{ PropertyPath: '/SecurityGroupIngress/0/CidrIp', DifferenceType: 'NOT_EQUAL' }] }] });
if (k === 'cloudformation create-stack') out({ StackId: 'arn:stack/maxwell-verify-1' });
if (k === 'cloudformation describe-stacks') out({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] });
if (k === 'cloudformation describe-stack-events') out({ StackEvents: [] });
if (k === 'cloudformation describe-stack-resources') out({ StackResources: [
  { LogicalResourceId: 'PublicBucket', ResourceType: 'AWS::S3::Bucket', ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: 'bkt-1' },
  { LogicalResourceId: 'OpenGroup', ResourceType: 'AWS::EC2::SecurityGroup', ResourceStatus: 'CREATE_COMPLETE', PhysicalResourceId: 'sg-1' }] });
if (k === 's3api get-bucket-acl') out({ Grants: [{ Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' }, Permission: 'READ' }] });
if (k === 's3api get-public-access-block') err('NoSuchPublicAccessBlockConfiguration');
if (k === 's3api get-bucket-encryption') err('ServerSideEncryptionConfigurationNotFoundError');
if (k === 'ec2 describe-security-groups') out({ SecurityGroups: [{ IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }] });
if (k === 'cloudformation delete-stack') out({});
err('stand-in: no answer for ' + k);
`,
  // A stand-in emulator: it only has to listen on its port (the stand-in CLI answers the calls).
  moto_server: `#!/usr/bin/env node
const p = Number(process.argv[process.argv.indexOf('-p') + 1]);
require('node:net').createServer((s) => s.end()).listen(p, '127.0.0.1');
setTimeout(() => process.exit(0), 60000);
`,
};

function world({ moto = false } = {}) {
  const d = tmp();
  const bin = join(d, 'bin'); mkdirSync(bin);
  for (const [n, body] of Object.entries(STANDINS)) {
    if (n === 'moto_server') continue;
    writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755);
  }
  if (moto) { const m = join(d, 'moto', '5.2.4', 'bin'); mkdirSync(m, { recursive: true }); writeFileSync(join(m, 'moto_server'), STANDINS.moto_server); chmodSync(join(m, 'moto_server'), 0o755); }
  const app = `cfn-verify-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const checkout = join(WORKSPACE, 'applications', app, 'repos', 'infra-repo');
  mkdirSync(join(checkout, 'cfn'), { recursive: true });
  writeFileSync(join(checkout, 'cfn', 'stack.yaml'), FIXTURE);
  mkdirSync(join(WORKSPACE, 'applications', app, 'env'), { recursive: true });
  writeFileSync(join(WORKSPACE, 'applications', app, 'env', 'prod.json'), JSON.stringify({ hosting: { provider: 'aws', region: 'ap-south-1' }, iac: [{ repoId: 'infra-repo', path: 'cfn/stack.yaml', tool: 'cloudformation', stackName: 'demo-stack' }] }));
  const session = `cfn-test-${app}`;
  return {
    d, bin, app, log: join(d, 'aws.log'), out: `kpis/data/raw/sessions/${session}/probe-iac.${app}.infra-repo.cfn.export.json`,
    path: [bin, ...(moto ? [join(d, 'moto', '5.2.4', 'bin')] : []), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    cleanup: () => { rmSync(join(WORKSPACE, 'applications', app), { recursive: true, force: true }); rmSync(join(WORKSPACE, 'kpis', 'data', 'raw', 'sessions', session), { recursive: true, force: true }); rmSync(d, { recursive: true, force: true }); },
  };
}
const runCli = (w, env) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/toolchain/cfn-verify.mjs'), '--company', 'acme', '--app', w.app, '--repo', 'infra-repo', '--out', w.out],
  { cwd: WORKSPACE, encoding: 'utf8', timeout: 120000, env: { PATH: w.path, HOME: w.d, MAXWELL_PLATFORM_TOOLS: '1', ...env } });
const calls = (w) => existsSync(w.log) ? readFileSync(w.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('without the platform\'s tools it changes nothing and says so (exit 3)', () => {
  const w = world();
  try {
    const r = runCli(w, { MAXWELL_PLATFORM_TOOLS: '' });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /no-platform-tools/);
    assert.equal(existsSync(join(WORKSPACE, w.out)), false);
  } finally { w.cleanup(); }
});

test('no AWS credential: lint runs, the emulator\'s absence is explained, live AWS is not run and the export says so', () => {
  const w = world();
  try {
    const r = runCli(w, { AWS_ACCESS_KEY_ID: 'AKIASHOULDNOTBEUSED00', AWS_SECRET_ACCESS_KEY: 'nope' });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.match(s.liveAws, /not run \(no AWS read-only role is set/);
    assert.match(s.emulator, /none \(no emulator ran: .*moto not run: moto_server is not installed here/);
    const doc = JSON.parse(readFileSync(join(WORKSPACE, w.out), 'utf8'));
    assert.equal(doc.version, '2.1.0');
    const lint = doc.runs.find((x) => x.tool.driver.name === 'cfn-lint');
    assert.equal(lint.results[0].ruleId, 'W3045'); assert.equal(lint.results[0].locations[0].physicalLocation.artifactLocation.uri, 'cfn/stack.yaml');
    assert.equal(lint.results[0].properties.resource, 'PublicBucket');
    const report = doc.properties['maxwell:cfn-verify'];
    assert.equal(report.liveAws.ran, false);
    assert.ok(report.skipped.some((x) => x.step === 'cfn-guard' && /rule sets are not among this run's tools/.test(x.reason)), 'guard without its rule sets: skipped, said so');
    assert.deepEqual(calls(w), [], 'no AWS call at all (a stray AWS_ACCESS_KEY_ID in the environment is never used)');
  } finally { w.cleanup(); }
});

test('a read-only credential: only read calls reach (stand-in) AWS, drift and validation reported', () => {
  const w = world();
  try {
    const r = runCli(w, { MAXWELL_AWS_RO_ACCESS_KEY_ID: 'AKIAMAXWELLRO0000000', MAXWELL_AWS_RO_SECRET_ACCESS_KEY: 's'.repeat(40) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).liveAws, /read-only, keys/);
    const c = calls(w);
    assert.ok(c.length >= 5);
    for (const x of c) {
      assert.equal(x.endpoint, null, 'real AWS: no endpoint override');
      assert.equal(x.envEndpoint, null);
      assert.ok((READ_ONLY[x.svc] || []).includes(x.op) && !MUTATING.test(x.op), `${x.svc} ${x.op} is read-only`);
      assert.equal(x.key, 'AKIAMAXWELLRO0000000');
    }
    assert.deepEqual(c.map((x) => x.op), ['get-caller-identity', 'validate-template', 'describe-stacks', 'detect-stack-drift', 'describe-stack-drift-detection-status', 'describe-stack-resource-drifts']);
    const doc = JSON.parse(readFileSync(join(WORKSPACE, w.out), 'utf8'));
    const aws = doc.runs.find((x) => x.tool.driver.name === 'aws-cloudformation');
    assert.equal(aws.properties.region, 'ap-south-1', 'the environment\'s region');
    const drift = aws.results.find((x) => x.ruleId === 'aws-stack-drift');
    assert.equal(drift.properties.resource, 'OpenGroup'); assert.equal(drift.locations[0].physicalLocation.region.startLine, 18);
    assert.ok(!readFileSync(join(WORKSPACE, w.out), 'utf8').includes('s'.repeat(40)), 'the secret is in no output');
  } finally { w.cleanup(); }
});

test('the emulator on loopback: create, read back, delete, with throwaway credentials only; a resource it lacks is not verified', async () => {
  const w = world({ moto: true });
  try {
    const port = await freePort();
    const r = runCli(w, { MAXWELL_CFN_EMULATOR_PORT: String(port), AWS_ENDPOINT_URL: 'https://cloudformation.us-east-1.amazonaws.com' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).emulator, /^moto 5\.2\.4$/);
    const c = calls(w);
    assert.ok(c.some((x) => x.op === 'create-stack') && c.some((x) => x.op === 'delete-stack'));
    for (const x of c) { assert.equal(x.endpoint, `http://127.0.0.1:${port}`, `${x.op} to the emulator`); assert.equal(x.key, 'test', 'throwaway credentials'); assert.equal(x.envEndpoint, `http://127.0.0.1:${port}`); }
    const doc = JSON.parse(readFileSync(join(WORKSPACE, w.out), 'utf8'));
    const emu = doc.runs.find((x) => x.tool.driver.name === 'maxwell-cfn-emulator');
    const by = (id) => emu.results.filter((x) => x.ruleId === id);
    assert.equal(by('emulated-s3-public-acl')[0].level, 'error', 'a public grant read back');
    assert.equal(by('emulated-sg-open-ingress')[0].properties.resource, 'OpenGroup');
    assert.equal(by('emulator-not-verified')[0].properties.resource, 'Unsupported');
    assert.match(by('emulator-not-verified')[0].message.text, /moto does not model AWS::Pipes::Pipe/);
    assert.equal(by('emulated-s3-public-access-block-off')[0].kind, 'review', 'what the emulator does not model is never a pass');
  } finally { w.cleanup(); }
});

const REAL = process.env.MAXWELL_CFN_REAL_TOOLS;
test('the real tools over the fixture, offline (MAXWELL_CFN_REAL_TOOLS)', { skip: !REAL || !process.env.RUN_TOOLS_DATA ? 'set MAXWELL_CFN_REAL_TOOLS and RUN_TOOLS_DATA to the platform\'s run tools' : false }, async () => {
  const w = world();
  try {
    w.path = [REAL, '/usr/local/bin', '/usr/bin', '/bin'].join(':');
    const r = runCli(w, { RUN_TOOLS_DATA: process.env.RUN_TOOLS_DATA, MAXWELL_CFN_EMULATOR_PORT: String(await freePort()) });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(readFileSync(join(WORKSPACE, w.out), 'utf8'));
    const ids = (n) => (doc.runs.find((x) => x.tool.driver.name === n) || { results: [] }).results.map((x) => `${x.ruleId}@${x.locations[0].physicalLocation.region.startLine}`);
    assert.ok(ids('cfn-lint').some((x) => /^[EW]\d{4}@/.test(x)), `cfn-lint found something: ${ids('cfn-lint')}`);
    assert.ok(ids('cfn-guard').includes('INCOMING_SSH_DISABLED@22'), `cfn-guard: ${ids('cfn-guard')}`);
    assert.ok(ids('maxwell-cfn-emulator').includes('emulated-sg-open-ingress@18'), `emulator: ${ids('maxwell-cfn-emulator')}`);
    assert.ok(ids('maxwell-cfn-emulator').includes('emulator-not-verified@27'));
  } finally { w.cleanup(); }
});
