// vercel: Vercel Sandbox (microVM) from Vercel's default image, networkPolicy deny-all unless static.network is
// package-registries, optionally in a region (bom1 is Mumbai). Vercel runs only images from its own registry, so the
// verified binary travels in the upload bundle. Credentials: VERCEL_TOKEN; team and project come from providers.vercel.
// SDK: @vercel/sandbox, pinned in toolchain.json (API from the package's type definitions; not yet exercised live).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionMatches } from '../../toolchain.mjs';
import { loadSdk } from '../sdk.mjs';
import { stageTool, toolCommand } from '../stage.mjs';
import { ExecutorError, HOSTED_ROOT, PACKAGE_REGISTRY_DOMAINS, clip, packBundle, sandboxPaths, scannerEnv, shellQuote, substitute } from '../common.mjs';

export const CREDENTIALS = ['VERCEL_TOKEN'];

function createOptions(providerConfig, { network, region, limits }) {
  return {
    teamId: providerConfig.teamId, projectId: providerConfig.projectId, token: process.env.VERCEL_TOKEN,
    resources: { vcpus: Math.max(1, limits.cpu) }, timeout: (limits.timeoutSeconds + 900) * 1000, persistent: false,
    networkPolicy: network === 'package-registries' ? { allow: PACKAGE_REGISTRY_DOMAINS } : 'deny-all',
    ...(region ? { region } : {}),
  };
}

async function sh(sb, line, { cwd, seconds, env }) {
  const r = await sb.runCommand({ cmd: 'sh', args: ['-c', line], cwd, ...(env ? { env } : {}), signal: AbortSignal.timeout(seconds * 1000) });
  return { exitCode: r.exitCode, stdout: await r.stdout(), stderr: await r.stderr() };
}

export async function runTool({ manifest, tool, argv, repoDir, resultPath, network, limits, region, providerConfig = {}, deps = {} }) {
  if (!process.env.VERCEL_TOKEN) throw new ExecutorError('not-configured', 'VERCEL_TOKEN is not set; run /connect-sandbox');
  if (!providerConfig.teamId || !providerConfig.projectId) throw new ExecutorError('not-configured', 'providers.vercel.teamId and projectId are required');
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'vercel');
  const root = HOSTED_ROOT; const paths = sandboxPaths(root);
  const staged = await stageTool(manifest, tool, { oci: false, network, provider: 'vercel', root, fetchImpl: deps.fetchImpl, run: deps.run });
  const staging = mkdtempSync(join(tmpdir(), 'maxwell-bundle-'));
  let sb;
  try {
    const bundle = packBundle(repoDir, join(staging, 'bundle.tgz'), { optDir: staged.optDir, run: deps.run });
    sb = await sdk.Sandbox.create(createOptions(providerConfig, { network, region, limits }));
    await sh(sb, shellQuote(['mkdir', '-p', root]), { cwd: '/', seconds: 60 });
    await sb.writeFiles([{ path: `${root}/bundle.tgz`, content: readFileSync(bundle) }]);
    const unpack = await sh(sb, `tar -xzf ${root}/bundle.tgz -C ${root} && mkdir -p ${root}/out ${root}/home`, { cwd: root, seconds: 600 });
    if (unpack.exitCode !== 0) throw new ExecutorError('upload-failed', `unpacking in Vercel Sandbox failed: ${clip(unpack.stderr, 400)}`);
    for (const step of staged.prepare) {
      const r = await sh(sb, step, { cwd: root, seconds: 1800, env: staged.prepareEnv });
      if (r.exitCode !== 0) throw new ExecutorError('install-failed', `${tool.name} install in Vercel Sandbox failed: ${clip(r.stderr, 400)}`);
    }
    const env = scannerEnv({ HOME: `${root}/home`, TMPDIR: `${root}/home` });
    const version = await sh(sb, toolCommand(staged, tool.versionCheck.args, env), { cwd: root, seconds: 300 });
    const versionOutput = `${version.stdout}${version.stderr}`.trim();
    if (!versionMatches(tool, versionOutput)) throw new ExecutorError('version-mismatch', `${tool.name} in Vercel Sandbox printed "${versionOutput.split('\n')[0].slice(0, 160)}", expected ${tool.version}`);
    const r = await sh(sb, toolCommand(staged, substitute(argv, paths), env), { cwd: root, seconds: limits.timeoutSeconds });
    const bytes = await sb.readFileToBuffer({ path: paths.result }).catch(() => null);
    if (bytes) writeFileSync(resultPath, bytes);
    return { exitCode: r.exitCode, timedOut: false, stdout: r.stdout || '', stderr: clip(r.stderr), provenance: { provider: 'vercel', isolation: 'microvm', network, ...(region ? { region } : {}), toolVersion: tool.version, versionOutput: versionOutput.split('\n')[0], ...staged.pin } };
  } finally {
    if (sb) await sb.stop().catch(() => {});
    staged.cleanup();
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function smokeTest({ manifest, providerConfig = {}, region, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'vercel');
  const sb = await sdk.Sandbox.create(createOptions(providerConfig, { network: 'none', region, limits: { cpu: 1, memoryMb: 2048, timeoutSeconds: 120 } }));
  try {
    const r = await sh(sb, 'uname -m', { cwd: '/', seconds: 60 });
    return { ok: r.exitCode === 0, detail: `Vercel Sandbox answered: ${String(r.stdout).trim()}${region ? ` (region ${region})` : ''}` };
  } finally {
    await sb.stop().catch(() => {});
  }
}
