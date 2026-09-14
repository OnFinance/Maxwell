// docker (or podman): runs the digest-pinned image with no network, a read-only root filesystem, all capabilities
// dropped, no privilege escalation and resource limits. The checkout is mounted read-only; only /work/out is writable.
// Tools without an image run a checksum-verified binary or a hash-locked Python install mounted into a pinned base.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureArtifact, ensurePythonTarget, getTool, imageRef, versionMatches } from '../../toolchain.mjs';
import { ExecutorError, IN_SANDBOX, clip, linuxPlatform, scannerEnv, substitute } from '../common.mjs';

// Which image runs a tool, and what to mount into it.
export async function containerPlan(manifest, tool, { platform = linuxPlatform(), fetchImpl, run } = {}) {
  if (tool.image) return { image: imageRef(tool.image), invoke: tool.image.invoke, user: tool.image.user, mounts: [], env: {}, pin: { image: imageRef(tool.image) } };
  if (tool.artifacts && tool.artifacts[platform]) {
    const bin = await ensureArtifact(tool, { platform, fetchImpl });
    return { image: imageRef(manifest.baseImages.static), invoke: `${IN_SANDBOX.opt}/${tool.name}`, user: '', mounts: [[bin, `${IN_SANDBOX.opt}/${tool.name}`]], env: {}, pin: { image: imageRef(manifest.baseImages.static), artifactSha256: tool.artifacts[platform].sha256 } };
  }
  if (tool.python) {
    const site = await ensurePythonTarget(manifest, tool, { linuxPlatform: platform, fetchImpl, run });
    return { image: imageRef(manifest.baseImages.python), invoke: 'python', prefixArgs: ['-m', tool.python.package], user: '', mounts: [[site, `${IN_SANDBOX.opt}/site`]], env: { PYTHONPATH: `${IN_SANDBOX.opt}/site`, PYTHONDONTWRITEBYTECODE: '1' }, pin: { image: imageRef(manifest.baseImages.python), lockSha256: tool.python.lockSha256 } };
  }
  throw new ExecutorError('no-container-source', `${tool.name} has no image, linux artifact or Python lock`);
}

export function runArgs({ plan, argv, repoDir, outDir, network, limits, versionCheck = false }) {
  const args = ['run', '--rm', '--pull=missing', '--network', network === 'none' ? 'none' : 'bridge', '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=1g', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '1024',
    '--cpus', String(limits.cpu), '--memory', `${limits.memoryMb}m`, '--workdir', '/tmp'];
  if (!plan.user) args.push('--user', '65532:65532');
  for (const [k, v] of Object.entries({ ...scannerEnv(), ...plan.env })) args.push('-e', `${k}=${v}`);
  if (!versionCheck) args.push('-v', `${repoDir}:${IN_SANDBOX.src}:ro`, '-v', `${outDir}:/work/out:rw`);
  for (const [from, to] of plan.mounts) args.push('-v', `${from}:${to}:ro`);
  args.push('--entrypoint', plan.invoke, plan.image, ...(plan.prefixArgs || []), ...argv);
  return args;
}

export async function runTool({ manifest, tool, argv, repoDir, resultPath, network, limits, providerConfig = {}, deps = {} }) {
  const run = deps.run || spawnSync;
  const engine = providerConfig.engine || 'docker';
  const plan = await containerPlan(manifest, tool, { fetchImpl: deps.fetchImpl, run });
  const version = run(engine, runArgs({ plan, argv: tool.versionCheck.args, network: 'none', limits, versionCheck: true }), { encoding: 'utf8', timeout: 600000 });
  const versionOutput = `${version.stdout || ''}${version.stderr || ''}`.trim();
  if (!versionMatches(tool, versionOutput)) throw new ExecutorError('version-mismatch', `${tool.name} in ${plan.image} printed "${versionOutput.split('\n')[0].slice(0, 160)}", expected ${tool.version}`);
  const outDir = mkdtempSync(join(tmpdir(), 'maxwell-out-'));
  chmodSync(outDir, 0o777);
  try {
    const r = run(engine, runArgs({ plan, argv: substitute(argv, IN_SANDBOX), repoDir, outDir, network, limits }), { encoding: 'utf8', timeout: limits.timeoutSeconds * 1000 + 60000, maxBuffer: 256 << 20 });
    const produced = join(outDir, 'result');
    if (existsSync(produced)) copyFileSync(produced, resultPath);
    return { exitCode: r.status ?? 124, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), stdout: r.stdout || '', stderr: clip(r.stderr), provenance: { provider: engine, isolation: 'container', network, toolVersion: tool.version, versionOutput: versionOutput.split('\n')[0], ...plan.pin } };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Runtime commands: the CLI's pinned image with the credential files mounted read-only; network is allowed because the
// command talks to the target, and the command itself has already passed the rules-of-engagement policy.
export async function runCommand({ manifest, argv, env = {}, files = {}, stdin, timeoutSeconds, providerConfig = {}, deps = {} }) {
  const run = deps.run || spawnSync;
  const engine = providerConfig.engine || 'docker';
  const tool = getTool(manifest, argv[0]);
  if (!tool.image) throw new ExecutorError('no-image', `${argv[0]} has no pinned image`);
  const credDir = mkdtempSync(join(tmpdir(), 'maxwell-cred-'));
  try {
    const args = ['run', '--rm', '-i', '--pull=missing', '--read-only', '--tmpfs', '/tmp:rw,size=256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '512m', '--user', '65532:65532', '-e', 'HOME=/tmp'];
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(credDir, name), content, { mode: 0o644 });
      args.push('-v', `${join(credDir, name)}:/run/maxwell/${name}:ro`);
    }
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
    args.push('--entrypoint', tool.image.invoke, imageRef(tool.image), ...argv.slice(1));
    const r = run(engine, args, { encoding: 'utf8', input: stdin || '', timeout: timeoutSeconds * 1000 + 30000, maxBuffer: 8 << 20 });
    return { exitCode: r.status ?? 124, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), stdout: r.stdout || '', stderr: clip(r.stderr, 2000), provenance: { provider: engine, isolation: 'container', pinned: true, image: imageRef(tool.image) } };
  } finally {
    rmSync(credDir, { recursive: true, force: true });
  }
}
