import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const tool = { name: 'faketool', category: 'scanner', version: '1.2.3', versionCheck: { args: ['--version'], expect: '1.2.3' }, artifacts: { 'linux-amd64': { url: 'https://example.com/faketool', sha256: createHash('sha256').update(bin).digest('hex'), sha256Source: 'computed-at-pin', archive: 'none' } } };
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
