import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packBundle } from '../lib/sandbox/common.mjs';
import * as lambdaMicrovms from '../lib/sandbox/backends/lambda-microvms.mjs';
import { checkToolArgs } from '../lib/sandbox/scan-policy.mjs';
import { applyCredentials, readCredentials, writeCredentials } from '../lib/sandbox/credentials.mjs';
import { runArgs } from '../lib/sandbox/backends/docker.mjs';
import { podPlan, scanPod } from '../lib/sandbox/backends/kubernetes.mjs';
import { runtimeExecutor, staticExecutor } from '../lib/sandbox/index.mjs';
import * as e2b from '../lib/sandbox/backends/e2b.mjs';
import * as daytona from '../lib/sandbox/backends/daytona.mjs';
import * as modal from '../lib/sandbox/backends/modal.mjs';
import * as vercel from '../lib/sandbox/backends/vercel.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'maxwell-sbx-'));
const digest = (c) => `sha256:${c.repeat(64)}`;

test('scanner arguments stay inside the checkout and never phone home', () => {
  const ok = (tool, argv) => assert.equal(checkToolArgs(tool, argv).ok, true, `${tool} ${argv.join(' ')}: ${checkToolArgs(tool, argv).reason}`);
  const no = (tool, argv, re) => { const r = checkToolArgs(tool, argv); assert.equal(r.ok, false, `${tool} ${argv.join(' ')}`); assert.match(r.reason, re); };
  ok('trivy', ['config', '--format', 'sarif', '--output', '{result}', '{src}']);
  ok('semgrep', ['--config', '{src}/.semgrep.yml', '--sarif', '-o', '{result}', '{src}']);
  ok('gitleaks', ['detect', '--no-git', '--redact', '--source', '{src}', '-f', 'sarif', '-r', '{result}']);
  ok('trufflehog', ['filesystem', '--no-verification', '--json', '{src}']);
  no('semgrep', ['--config', 'auto', '{src}'], /registry packs/);
  no('semgrep', ['--config=p/secrets', '{src}'], /registry packs/);
  no('gitleaks', ['detect', '--no-git', '--source', '{src}'], /--redact/);
  no('trufflehog', ['filesystem', '{src}'], /--no-verification/);
  no('trufflehog', ['github', '--org', 'x', '--no-verification', '{src}'], /filesystem/);
  no('trivy', ['image', 'alpine:3', '{src}'], /fs, config or sbom/);
  no('grype', ['registry:docker.io/library/alpine', '{src}'], /dir:/);
  no('checkov', ['-d', '{src}', '--bc-api-key', 'x'], /third party/);
  no('trivy', ['fs', '--output', '/etc/passwd', '{src}'], /outside the checkout/);
  no('trivy', ['fs', '{src}/../../secrets'], /\.\./);
  no('trivy', ['fs', '.'], /\{src\}/);
  no('trivy', ['fs', '-o', '{result}', '--cache-dir', '{result}', '{src}'], /at most once/);
});

test('provider credentials are stored outside the workspace with mode 0600 and applied without printing', () => {
  const dir = tmp();
  try {
    const env = { MAXWELL_SANDBOX_CREDENTIALS_DIR: dir };
    const file = writeCredentials('modal', { MODAL_TOKEN_ID: 'ak-test', MODAL_TOKEN_SECRET: 'as-test' }, env);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readCredentials('modal', env), { MODAL_TOKEN_ID: 'ak-test', MODAL_TOKEN_SECRET: 'as-test' });
    const target = { ...env };
    assert.deepEqual(applyCredentials('modal', target), { needed: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], present: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'], missing: [] });
    assert.equal(target.MODAL_TOKEN_ID, 'ak-test');
    assert.throws(() => writeCredentials('e2b', { AWS_SECRET_ACCESS_KEY: 'x' }, env), /does not use/);
    assert.throws(() => writeCredentials('e2b', { E2B_API_KEY: 'a\nb' }, env), /single-line/);
    assert.throws(() => writeCredentials('e2b', { E2B_API_KEY: 'x' }, { MAXWELL_SANDBOX_CREDENTIALS_DIR: join(WORKSPACE, 'kpis') }), { code: 'credentials-in-workspace' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('docker runs the digest-pinned image without network, capabilities or a writable root', () => {
  const plan = { image: `docker.io/aquasec/trivy:0.74.0@${digest('a')}`, invoke: 'trivy', user: '', mounts: [], env: {} };
  const args = runArgs({ plan, argv: ['fs', '/work/src'], repoDir: '/repo', outDir: '/out', network: 'none', limits: { cpu: 2, memoryMb: 2048, timeoutSeconds: 60 } });
  const joined = args.join(' ');
  for (const part of ['--network none', '--read-only', '--cap-drop ALL', 'no-new-privileges', '--user 65532:65532', '-v /repo:/work/src:ro', '-v /out:/work/out:rw', `--entrypoint trivy ${plan.image} fs /work/src`]) assert.ok(joined.includes(part), part);
  assert.ok(!args.includes('bridge'));
  const version = runArgs({ plan: { ...plan, user: 'guest' }, argv: ['--version'], network: 'none', limits: { cpu: 1, memoryMb: 512 }, versionCheck: true }).join(' ');
  assert.ok(!version.includes('/repo') && !version.includes('--user'), 'version check mounts nothing and keeps the image user');
});

test('kubernetes scan pods are non-root, token-less and see the checkout read-only', () => {
  const manifest = { baseImages: { static: { ref: 'docker.io/library/debian:bookworm-slim', digest: digest('b'), invoke: '/bin/sh' }, python: { ref: 'docker.io/library/python:3.12-slim-bookworm', digest: digest('c'), invoke: '/bin/sh' } } };
  const tool = { name: 'gosec', version: '2.29.0', versionCheck: { args: ['-version'], expect: '2.29.0' }, artifacts: { 'linux-amd64': { sha256: 'd'.repeat(64) } } };
  const plan = podPlan(manifest, tool);
  assert.equal(plan.upload, 'binary');
  assert.equal(plan.invoke, '/work/opt/gosec');
  const pod = scanPod({ name: 'maxwell-scan-gosec-x', namespace: 'maxwell', plan, argv: ['-fmt', 'sarif', '/work/src/...'], versionArgs: ['-version'], limits: { cpu: 1, memoryMb: 1024, timeoutSeconds: 600 }, cfg: {} });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.restartPolicy, 'Never');
  assert.deepEqual(pod.spec.initContainers.map((c) => c.name), ['upload', 'version']);
  const toolC = pod.spec.containers.find((c) => c.name === 'tool');
  assert.equal(toolC.securityContext.runAsNonRoot, true);
  assert.equal(toolC.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(toolC.securityContext.capabilities.drop, ['ALL']);
  assert.equal(toolC.volumeMounts.find((m) => m.mountPath === '/work/src').readOnly, true);
  assert.equal(toolC.image, `docker.io/library/debian:bookworm-slim@${digest('b')}`);
});

test('executor selection refuses missing executors and hosted runtime executors', () => {
  assert.throws(() => staticExecutor({ static: { provider: 'none' } }), { code: 'no-executor' });
  assert.throws(() => staticExecutor(null), { code: 'no-executor' });
  assert.throws(() => runtimeExecutor({ runtime: { provider: 'e2b' } }), { code: 'invalid-config' });
  assert.equal(staticExecutor({ static: { provider: 'modal', region: 'ap-south' }, providers: { modal: { appName: 'm' } } }).network, 'none');
});

// Hosted backends against mock SDKs: the calls match the pinned SDKs' type definitions, the verified binary travels in
// the bundle, egress is blocked, the version is checked before the result is kept, and the sandbox is always destroyed.
function hostedFixture() {
  const cache = tmp();
  const repo = tmp();
  writeFileSync(join(repo, 'main.tf'), 'resource "x" "y" {}\n');
  const bin = Buffer.from('#!/bin/sh\necho faketool 1.2.3\n');
  const artifact = { url: 'https://example.com/faketool', sha256: createHash('sha256').update(bin).digest('hex'), sha256Source: 'computed-at-pin', archive: 'none' };
  const tool = { name: 'faketool', category: 'scanner', version: '1.2.3', versionCheck: { args: ['--version'], expect: '1.2.3' }, artifacts: { 'linux-amd64': artifact, 'linux-arm64': artifact } };
  const manifest = { tools: [tool], sdks: [], baseImages: { static: { ref: 'docker.io/library/debian:bookworm-slim', digest: digest('e'), invoke: '/bin/sh' }, python: { ref: 'docker.io/library/python:3.12-slim-bookworm', digest: digest('f'), invoke: '/bin/sh' } } };
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length) });
  const resultPath = join(repo, 'result.out');
  const prev = process.env.MAXWELL_TOOLCHAIN_CACHE;
  process.env.MAXWELL_TOOLCHAIN_CACHE = cache;
  return { tool, manifest, fetchImpl, repo, resultPath, cleanup: () => { process.env.MAXWELL_TOOLCHAIN_CACHE = prev; rmSync(cache, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); } };
}
const job = (f, extra = {}) => ({ manifest: f.manifest, tool: f.tool, argv: ['scan', '{src}', '-o', '{result}'], repoDir: f.repo, resultPath: f.resultPath, network: 'none', limits: { cpu: 2, memoryMb: 2048, timeoutSeconds: 300 }, ...extra });
const withEnv = async (vars, fn) => { const prev = {}; for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; process.env[k] = v; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } } };

test('e2b: blocked internet, bundle upload, version check, result download, sandbox killed', async () => {
  const f = hostedFixture();
  const calls = { create: null, runs: [], writes: [], killed: 0 };
  const sdk = { ALL_TRAFFIC: '0.0.0.0/0', Sandbox: { create: async (opts) => { calls.create = opts; return {
    sandboxId: 'sbx', files: { write: async (files) => calls.writes.push(...files.map((x) => x.path)), read: async () => Buffer.from('{"runs":[]}') },
    commands: { run: async (cmd) => { calls.runs.push(cmd); return { exitCode: 0, stdout: cmd.includes('--version') ? 'faketool 1.2.3' : 'done', stderr: '' }; } },
    kill: async () => { calls.killed += 1; } }; } } };
  try {
    const r = await withEnv({ E2B_API_KEY: 'test' }, () => e2b.runTool({ ...job(f), deps: { loadSdk: async () => sdk, fetchImpl: f.fetchImpl } }));
    assert.equal(calls.create.allowInternetAccess, false);
    assert.deepEqual(calls.writes, ['/tmp/maxwell/bundle.tgz']);
    assert.ok(calls.runs.some((c) => c.includes('/tmp/maxwell/opt/faketool') && c.includes('/tmp/maxwell/src') && c.includes('/tmp/maxwell/out/result')));
    assert.equal(readFileSync(f.resultPath, 'utf8'), '{"runs":[]}');
    assert.equal(r.provenance.artifactSha256, f.tool.artifacts['linux-amd64'].sha256);
    assert.equal(calls.killed, 1);
    const pr = await withEnv({ E2B_API_KEY: 'test' }, () => e2b.runTool({ ...job(f, { network: 'package-registries' }), deps: { loadSdk: async () => sdk, fetchImpl: f.fetchImpl } }));
    assert.deepEqual(calls.create.network.denyOut, ['0.0.0.0/0']);
    assert.ok(pr);
  } finally { f.cleanup(); }
});

test('daytona: pinned base image, network blocked, sandbox deleted even when the version is wrong', async () => {
  const f = hostedFixture();
  const calls = { create: null, deleted: 0 };
  const sdk = { Daytona: class { constructor(o) { calls.client = o; } async create(opts) { calls.create = opts; return {
    process: { executeCommand: async (cmd) => ({ exitCode: 0, result: cmd.includes('--version') ? 'faketool 9.9.9' : '' }) },
    fs: { uploadFile: async () => {}, downloadFile: async () => {} }, delete: async () => { calls.deleted += 1; } }; } } };
  try {
    await withEnv({ DAYTONA_API_KEY: 'test' }, () => assert.rejects(daytona.runTool({ ...job(f), providerConfig: { target: 'eu' }, deps: { loadSdk: async () => sdk, fetchImpl: f.fetchImpl } }), { code: 'version-mismatch' }));
    assert.equal(calls.create.image, `docker.io/library/debian:bookworm-slim@${digest('e')}`);
    assert.equal(calls.create.networkBlockAll, true);
    assert.equal(calls.create.ephemeral, true);
    assert.equal(calls.client.target, 'eu');
    assert.equal(calls.deleted, 1);
  } finally { f.cleanup(); }
});

test('modal: argv execution, Mumbai region, network blocked, sandbox terminated', async () => {
  const f = hostedFixture();
  const calls = { create: null, execs: [], terminated: 0 };
  const proc = (out) => ({ stdout: { readText: async () => out }, stderr: { readText: async () => '' }, wait: async () => 0 });
  const sdk = { ModalClient: class { constructor() {
    this.apps = { fromName: async (name, o) => ({ name, o }) };
    this.images = { fromRegistry: (ref) => ({ ref }) };
    this.sandboxes = { create: async (app, image, opts) => { calls.create = { app, image, opts }; return {
      exec: async (argv) => { calls.execs.push(argv); return proc(argv.includes('--version') ? 'faketool 1.2.3' : ''); },
      filesystem: { copyFromLocal: async () => {}, readBytes: async () => new Uint8Array(Buffer.from('ok')) }, terminate: async () => { calls.terminated += 1; } }; } };
  } } };
  try {
    await withEnv({ MODAL_TOKEN_ID: 'a', MODAL_TOKEN_SECRET: 'b' }, () => modal.runTool({ ...job(f), region: 'ap-south', deps: { loadSdk: async () => sdk, fetchImpl: f.fetchImpl } }));
    assert.equal(calls.create.image.ref, `docker.io/library/debian:bookworm-slim@${digest('e')}`);
    assert.equal(calls.create.opts.blockNetwork, true);
    assert.deepEqual(calls.create.opts.regions, ['ap-south']);
    assert.ok(calls.execs.some((a) => a[0] === '/tmp/maxwell/opt/faketool' && a.includes('/tmp/maxwell/out/result')), 'the tool runs as argv, not through a shell');
    assert.equal(readFileSync(f.resultPath, 'utf8'), 'ok');
    assert.equal(calls.terminated, 1);
  } finally { f.cleanup(); }
});

test('vercel: deny-all policy, team and project, Mumbai region, sandbox stopped', async () => {
  const f = hostedFixture();
  const calls = { create: null, stopped: 0 };
  const cmd = (out) => ({ exitCode: 0, stdout: async () => out, stderr: async () => '' });
  const sdk = { Sandbox: { create: async (opts) => { calls.create = opts; return {
    writeFiles: async () => {}, runCommand: async ({ args }) => cmd(args.join(' ').includes('--version') ? 'faketool 1.2.3' : ''),
    readFileToBuffer: async () => Buffer.from('ok'), stop: async () => { calls.stopped += 1; } }; } } };
  try {
    await withEnv({ VERCEL_TOKEN: 'test' }, () => vercel.runTool({ ...job(f), region: 'bom1', providerConfig: { teamId: 'team_abcdefgh', projectId: 'prj_abcdefgh' }, deps: { loadSdk: async () => sdk, fetchImpl: f.fetchImpl } }));
    assert.equal(calls.create.networkPolicy, 'deny-all');
    assert.equal(calls.create.region, 'bom1');
    assert.equal(calls.create.teamId, 'team_abcdefgh');
    assert.equal(calls.stopped, 1);
    await withEnv({ VERCEL_TOKEN: 'test' }, () => assert.rejects(vercel.runTool({ ...job(f), deps: { loadSdk: async () => sdk, fetchImpl: f.fetchImpl } }), { code: 'not-configured' }));
  } finally { f.cleanup(); }
});

test('a Python scanner on a hosted VM needs the package-registries network', async () => {
  const f = hostedFixture();
  const py = { name: 'bandit', category: 'scanner', version: '1.9.4', versionCheck: { args: ['--version'], expect: '1.9.4' }, python: { package: 'bandit', lock: 'locks/bandit.txt', lockSha256: 'a'.repeat(64), installer: 'uv', pythonVersion: '3.12' } };
  try {
    await withEnv({ E2B_API_KEY: 'test' }, () => assert.rejects(e2b.runTool({ ...job(f), tool: py, manifest: { ...f.manifest, tools: [py] }, deps: { loadSdk: async () => ({ Sandbox: {} }), fetchImpl: f.fetchImpl } }), { code: 'needs-network' }));
    assert.equal(existsSync(f.resultPath), false);
  } finally { f.cleanup(); }
});

test('renderers only render: helm template, lint or show and kustomize build', () => {
  assert.equal(checkToolArgs('helm', ['template', '{src}/charts/api', '-f', '{src}/charts/api/values.yaml']).ok, true);
  assert.equal(checkToolArgs('kustomize', ['build', '{src}/overlays/prod']).ok, true);
  assert.match(checkToolArgs('helm', ['install', 'api', '{src}/charts/api']).reason, /only helm template/);
  assert.match(checkToolArgs('helm', ['dependency', 'update', '{src}/charts/api']).reason, /only helm template/);
  assert.match(checkToolArgs('kustomize', ['edit', 'set', 'image', '{src}']).reason, /only kustomize build/);
});

test('lambda-microvms: runner image built once, VPC egress connector, token-authenticated runner, arm64 binary, MicroVM terminated', async () => {
  const f = hostedFixture();
  const calls = { sent: [], s3: [], http: [], terminated: 0, config: null };
  let imageState = null;
  const command = (name) => class { constructor(input) { this.name = name; this.input = input; } };
  const mv = Object.fromEntries(['GetMicrovmImageCommand', 'CreateMicrovmImageCommand', 'GetMicrovmImageVersionCommand', 'RunMicrovmCommand', 'GetMicrovmCommand', 'CreateMicrovmAuthTokenCommand', 'TerminateMicrovmCommand'].map((n) => [n, command(n)]));
  mv.LambdaMicrovmsClient = class {
    constructor(config) { calls.config = config; }
    async send(c) {
      calls.sent.push([c.name, c.input]);
      switch (c.name) {
        case 'GetMicrovmImageCommand':
          if (!imageState) throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
          if (imageState === 'CREATING') { imageState = 'CREATED'; return { state: 'CREATING', imageArn: 'arn:img' }; }
          return { state: 'CREATED', imageArn: 'arn:img', latestActiveImageVersion: '1' };
        case 'CreateMicrovmImageCommand': imageState = 'CREATING'; return { state: 'CREATING', imageArn: 'arn:img' };
        case 'GetMicrovmImageVersionCommand': return { state: 'SUCCESSFUL', baseImageVersion: '2026.09.01' };
        case 'RunMicrovmCommand': return { microvmId: 'mvm-1', state: 'PENDING', endpoint: 'abc.lambda-microvm.ap-south-1.on.aws' };
        case 'GetMicrovmCommand': return { microvmId: 'mvm-1', state: 'RUNNING', endpoint: 'abc.lambda-microvm.ap-south-1.on.aws' };
        case 'CreateMicrovmAuthTokenCommand': return { authToken: { 'X-aws-proxy-auth': 'jwe-token' } };
        case 'TerminateMicrovmCommand': calls.terminated += 1; return {};
        default: throw new Error(`unexpected ${c.name}`);
      }
    }
  };
  const s3 = { PutObjectCommand: command('PutObjectCommand'), S3Client: class { async send(c) { calls.s3.push(c.input); return {}; } } };
  const jobs = [];
  const http = async (url, init) => {
    calls.http.push({ url, auth: init.headers['X-aws-proxy-auth'], port: init.headers['X-aws-proxy-port'] });
    const path = new URL(url).pathname;
    const reply = (status, body) => {
      const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      return { ok: status < 300, status, text: async () => bytes.toString(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
    };
    if (path === '/maxwell/v1/bundle') return reply(200, { bytes: init.body.length });
    if (path === '/maxwell/v1/exec') { jobs.push(JSON.parse(init.body)); return reply(202, { jobId: String(jobs.length - 1) }); }
    if (path.startsWith('/maxwell/v1/jobs/')) return reply(200, { state: 'done', exitCode: 0, stdout: jobs[Number(path.split('/').pop())].argv.includes('--version') ? 'faketool 1.2.3' : '', stderr: '' });
    if (path === '/maxwell/v1/result') return reply(200, 'ok');
    return reply(404, {});
  };
  const providerConfig = { buildRoleArn: 'arn:aws:iam::123456789012:role/maxwell-microvm-build', artifactBucket: 'maxwell-artifacts-mumbai', egressConnectorArn: 'arn:aws:lambda:ap-south-1:123456789012:network-connector:maxwell-no-egress', profile: 'maxwell' };
  const manifest = { ...f.manifest, baseImages: { ...f.manifest.baseImages, microvm: { ref: 'public.ecr.aws/lambda/microvms:al2023-minimal', digest: digest('9'), invoke: '/bin/sh', platforms: ['linux/arm64'] } } };
  const deps = { loadSdk: async (m, provider, o = {}) => (o.pkg === '@aws-sdk/client-s3' ? s3 : mv), fetchImpl: f.fetchImpl, http, sleep: async () => {} };
  const sent = (name) => calls.sent.filter(([n]) => n === name).map(([, input]) => input);
  try {
    const r = await lambdaMicrovms.runTool({ ...job(f), manifest, region: 'ap-south-1', providerConfig, deps });
    const [create] = sent('CreateMicrovmImageCommand');
    assert.deepEqual(create.cpuConfigurations, [{ architecture: 'ARM_64' }]);
    assert.deepEqual(create.logging, { disabled: {} }, 'nothing from a scan reaches CloudWatch');
    assert.equal(create.buildRoleArn, providerConfig.buildRoleArn);
    assert.equal(create.baseImageArn, 'arn:aws:lambda:ap-south-1:aws:microvm-image:al2023-1');
    assert.match(create.codeArtifact.uri, /^s3:\/\/maxwell-artifacts-mumbai\/maxwell\/microvm-runner\/maxwell-runner-[0-9a-f]{16}-2048\.zip$/);
    assert.equal(calls.s3[0].Bucket, 'maxwell-artifacts-mumbai');
    assert.deepEqual(calls.config, { region: 'ap-south-1', profile: 'maxwell' });
    const [run] = sent('RunMicrovmCommand');
    assert.deepEqual(run.egressNetworkConnectors, [providerConfig.egressConnectorArn]);
    assert.deepEqual(run.ingressNetworkConnectors, ['arn:aws:lambda:ap-south-1:aws:network-connector:aws-network-connector:ALL_INGRESS']);
    assert.deepEqual(run.logging, { disabled: {} });
    assert.deepEqual(sent('CreateMicrovmAuthTokenCommand')[0].allowedPorts, [{ port: 8080 }]);
    assert.ok(calls.http.length > 0 && calls.http.every((h) => h.auth === 'jwe-token' && h.port === '8080' && h.url.startsWith('https://abc.lambda-microvm.ap-south-1.on.aws/')));
    const toolRun = jobs.find((j) => j.argv[0] === '/tmp/maxwell/opt/faketool' && j.argv.includes('/tmp/maxwell/out/result'));
    assert.ok(toolRun, 'the tool runs as argv with the sandbox paths');
    assert.equal(toolRun.env.HOME, '/tmp/maxwell/home');
    assert.equal(readFileSync(f.resultPath, 'utf8'), 'ok');
    assert.equal(r.provenance.artifactSha256, f.tool.artifacts['linux-arm64'].sha256);
    assert.equal(r.provenance.baseImageVersion, '2026.09.01');
    assert.equal(r.provenance.image, `public.ecr.aws/lambda/microvms:al2023-minimal@${digest('9')}`);
    assert.equal(calls.terminated, 1);
    await lambdaMicrovms.runTool({ ...job(f), manifest, region: 'ap-south-1', providerConfig, deps });
    assert.equal(sent('CreateMicrovmImageCommand').length, 1, 'the runner image is built once and reused');
    assert.equal(calls.terminated, 2);
    await assert.rejects(lambdaMicrovms.runTool({ ...job(f), manifest, providerConfig, deps }), { code: 'not-configured' });
    await assert.rejects(lambdaMicrovms.runTool({ ...job(f), manifest, region: 'ap-south-1', providerConfig: { ...providerConfig, egressConnectorArn: undefined }, deps }), { code: 'not-configured' });
    await assert.rejects(lambdaMicrovms.runTool({ ...job(f, { network: 'package-registries' }), manifest, region: 'ap-south-1', providerConfig, deps }), { code: 'invalid-config' });
  } finally { f.cleanup(); }
});

test('lambda-microvms runner: unpacks only inside its root, runs argv with the environment it is given, serves only the result', async (t) => {
  if (spawnSync('python3', ['-c', 'import tarfile; tarfile.data_filter'], { encoding: 'utf8' }).status !== 0) return t.skip('needs python3 with tarfile extraction filters');
  const dir = tmp();
  const root = join(dir, 'root');
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'main.tf'), 'resource "x" "y" {}\n');
  writeFileSync(join(dir, 'runner.py'), lambdaMicrovms.RUNNER_PY);
  const port = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn('python3', [join(dir, 'runner.py')], { env: { PATH: process.env.PATH, MAXWELL_RUNNER_ROOT: root, MAXWELL_RUNNER_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    for (let i = 0; ; i++) {
      const up = await fetch(`${base}/maxwell/v1/health`).then((res) => res.ok, () => false);
      if (up) break;
      if (i > 100) throw new Error('the runner did not start');
      await pause(100);
    }
    assert.equal((await fetch(`${base}/aws/lambda-microvms/runtime/v1/ready`, { method: 'POST' })).status, 200);
    const bundle = packBundle(repo, join(dir, 'bundle.tgz'));
    assert.equal((await fetch(`${base}/maxwell/v1/bundle`, { method: 'PUT', body: readFileSync(bundle) })).status, 200);
    assert.equal(readFileSync(join(root, 'src', 'main.tf'), 'utf8'), 'resource "x" "y" {}\n');
    const exec = async (body) => {
      const res = await fetch(`${base}/maxwell/v1/exec`, { method: 'POST', body: JSON.stringify(body) });
      if (res.status !== 202) return { status: res.status };
      const { jobId } = await res.json();
      for (;;) {
        const state = await (await fetch(`${base}/maxwell/v1/jobs/${jobId}`)).json();
        if (state.state === 'done') return state;
        await pause(50);
      }
    };
    const ran = await exec({ argv: ['python3', '-c', 'import os, sys; open(sys.argv[1], "w").write("result"); print(sorted(os.environ))', join(root, 'out', 'result')], cwd: root, env: { PATH: process.env.PATH, HOME: join(root, 'home') }, timeoutSeconds: 30 });
    assert.equal(ran.exitCode, 0, ran.stderr);
    assert.ok(ran.stdout.includes("'HOME'") && !ran.stdout.includes('MAXWELL_RUNNER'), 'commands get only the environment Maxwell sends');
    assert.equal(await (await fetch(`${base}/maxwell/v1/result`)).text(), 'result');
    assert.equal((await exec({ argv: ['true'], cwd: '/etc' })).status, 400);
    assert.equal((await exec({ argv: 'rm -rf /' })).status, 400);
    const slow = await exec({ argv: ['sleep', '5'], cwd: root, env: { PATH: process.env.PATH }, timeoutSeconds: 1 });
    assert.equal(slow.timedOut, true);
    const evil = join(dir, 'evil.tgz');
    spawnSync('python3', ['-c', 'import io, sys, tarfile\nt = tarfile.open(sys.argv[1], "w:gz")\ni = tarfile.TarInfo("../escaped")\ni.size = 1\nt.addfile(i, io.BytesIO(b"x"))\nt.close()', evil]);
    assert.equal((await fetch(`${base}/maxwell/v1/bundle`, { method: 'PUT', body: readFileSync(evil) })).status, 400);
    assert.equal(existsSync(join(dir, 'escaped')), false, 'a bundle cannot write outside the runner root');
    const zipPath = join(dir, 'runner.zip');
    writeFileSync(zipPath, lambdaMicrovms.runnerArtifact({ baseImages: { microvm: { ref: 'public.ecr.aws/lambda/microvms:al2023-minimal', digest: digest('9') } } }, 2048).zip);
    const listed = spawnSync('python3', ['-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(",".join(z.namelist()))\nprint(z.read("Dockerfile").decode().splitlines()[0])', zipPath], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, `Dockerfile,runner.py\nFROM public.ecr.aws/lambda/microvms:al2023-minimal@${digest('9')}\n`);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
