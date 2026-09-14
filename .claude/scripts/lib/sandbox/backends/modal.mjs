// modal: Modal sandbox from the digest-pinned base image with the network blocked, optionally pinned to a region
// (ap-south is Mumbai). Credentials: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET. Commands run as argv, never through a shell.
// SDK: modal, pinned in toolchain.json (API from the package's type definitions; not yet exercised live).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageRef, versionMatches } from '../../toolchain.mjs';
import { loadSdk } from '../sdk.mjs';
import { stageTool } from '../stage.mjs';
import { ExecutorError, HOSTED_ROOT, clip, packBundle, sandboxPaths, scannerEnv, substitute } from '../common.mjs';

export const CREDENTIALS = ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'];

async function openSandbox(sdk, image, { providerConfig = {}, region, limits }) {
  const modal = new sdk.ModalClient();
  const app = await modal.apps.fromName(providerConfig.appName || 'maxwell-scanners', { createIfMissing: true, ...(providerConfig.environment ? { environment: providerConfig.environment } : {}) });
  return modal.sandboxes.create(app, modal.images.fromRegistry(image), {
    cpu: limits.cpu, memoryMiB: limits.memoryMb, timeoutMs: (limits.timeoutSeconds + 900) * 1000, blockNetwork: true,
    ...(region ? { regions: [region] } : {}),
  });
}

async function execArgv(sb, argv, { cwd, seconds, env }) {
  const p = await sb.exec(argv, { workdir: cwd, timeoutMs: seconds * 1000, ...(env ? { env } : {}) });
  const [stdout, stderr, exitCode] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
  return { stdout, stderr, exitCode };
}

export async function runTool({ manifest, tool, argv, repoDir, resultPath, network, limits, region, providerConfig = {}, deps = {} }) {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) throw new ExecutorError('not-configured', 'MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set; run /connect-sandbox');
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'modal');
  const root = HOSTED_ROOT; const paths = sandboxPaths(root);
  const staged = await stageTool(manifest, tool, { oci: true, network, provider: 'modal', root, fetchImpl: deps.fetchImpl, run: deps.run });
  const staging = mkdtempSync(join(tmpdir(), 'maxwell-bundle-'));
  let sb;
  try {
    const bundle = packBundle(repoDir, join(staging, 'bundle.tgz'), { optDir: staged.optDir, run: deps.run });
    sb = await openSandbox(sdk, staged.image, { providerConfig, region, limits });
    await execArgv(sb, ['mkdir', '-p', `${root}/out`, `${root}/home`], { cwd: '/', seconds: 60 });
    await sb.filesystem.copyFromLocal(bundle, `${root}/bundle.tgz`);
    const unpack = await execArgv(sb, ['tar', '-xzf', `${root}/bundle.tgz`, '-C', root], { cwd: root, seconds: 600 });
    if (unpack.exitCode !== 0) throw new ExecutorError('upload-failed', `unpacking in Modal failed: ${clip(unpack.stderr, 400)}`);
    for (const step of staged.prepare) {
      const r = await execArgv(sb, ['sh', '-c', step], { cwd: root, seconds: 600 });
      if (r.exitCode !== 0) throw new ExecutorError('install-failed', `${tool.name} setup in Modal failed: ${clip(r.stderr, 400)}`);
    }
    const env = { ...scannerEnv({ HOME: `${root}/home`, TMPDIR: `${root}/home` }), ...staged.env };
    const version = await execArgv(sb, [...staged.invoke, ...tool.versionCheck.args], { cwd: root, seconds: 300, env });
    const versionOutput = `${version.stdout}${version.stderr}`.trim();
    if (!versionMatches(tool, versionOutput)) throw new ExecutorError('version-mismatch', `${tool.name} in Modal printed "${versionOutput.split('\n')[0].slice(0, 160)}", expected ${tool.version}`);
    const r = await execArgv(sb, [...staged.invoke, ...substitute(argv, paths)], { cwd: root, seconds: limits.timeoutSeconds, env });
    const bytes = await sb.filesystem.readBytes(paths.result).catch(() => null);
    if (bytes) writeFileSync(resultPath, Buffer.from(bytes));
    return { exitCode: r.exitCode, timedOut: false, stdout: r.stdout || '', stderr: clip(r.stderr), provenance: { provider: 'modal', isolation: 'sandbox', network: 'none', ...(region ? { region } : {}), toolVersion: tool.version, versionOutput: versionOutput.split('\n')[0], ...staged.pin } };
  } finally {
    if (sb) await sb.terminate().catch(() => {});
    staged.cleanup();
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function smokeTest({ manifest, providerConfig = {}, region, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'modal');
  const sb = await openSandbox(sdk, imageRef(manifest.baseImages.static), { providerConfig, region, limits: { cpu: 1, memoryMb: 512, timeoutSeconds: 120 } });
  try {
    const r = await execArgv(sb, ['uname', '-m'], { cwd: '/', seconds: 60 });
    return { ok: r.exitCode === 0, detail: `Modal sandbox answered: ${String(r.stdout).trim()}${region ? ` (region ${region})` : ''}` };
  } finally {
    await sb.terminate().catch(() => {});
  }
}
