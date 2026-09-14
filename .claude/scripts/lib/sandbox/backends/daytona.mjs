// daytona: Daytona sandbox from the digest-pinned base image, ephemeral, with all network blocked (Python tools use
// wheels installed for linux-amd64 on this machine, so no egress is needed). Credentials: DAYTONA_API_KEY; the API URL
// and target (region, or a BYOC custom region) come from providers.daytona.
// SDK: @daytona/sdk, pinned in toolchain.json (API from the package's type definitions; not yet exercised live).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionMatches } from '../../toolchain.mjs';
import { loadSdk } from '../sdk.mjs';
import { stageTool, toolCommand } from '../stage.mjs';
import { ExecutorError, HOSTED_ROOT, clip, packBundle, sandboxPaths, scannerEnv, shellQuote, substitute } from '../common.mjs';

export const CREDENTIALS = ['DAYTONA_API_KEY'];

export function client(sdk, providerConfig = {}) {
  return new sdk.Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    ...(providerConfig.apiUrl ? { apiUrl: providerConfig.apiUrl } : {}),
    ...(providerConfig.target ? { target: providerConfig.target } : {}),
  });
}

export async function runTool({ manifest, tool, argv, repoDir, resultPath, network, limits, providerConfig = {}, deps = {} }) {
  if (!process.env.DAYTONA_API_KEY) throw new ExecutorError('not-configured', 'DAYTONA_API_KEY is not set; run /connect-sandbox');
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'daytona');
  const root = HOSTED_ROOT; const paths = sandboxPaths(root);
  const staged = await stageTool(manifest, tool, { oci: true, network, provider: 'daytona', root, fetchImpl: deps.fetchImpl, run: deps.run });
  const staging = mkdtempSync(join(tmpdir(), 'maxwell-bundle-'));
  let sb;
  try {
    const bundle = packBundle(repoDir, join(staging, 'bundle.tgz'), { optDir: staged.optDir, run: deps.run });
    sb = await client(sdk, providerConfig).create({
      image: staged.image,
      resources: { cpu: limits.cpu, memory: Math.max(1, Math.ceil(limits.memoryMb / 1024)), disk: 8 },
      envVars: {}, networkBlockAll: true, ephemeral: true, autoStopInterval: Math.ceil(limits.timeoutSeconds / 60) + 15,
    }, { timeout: 300 });
    // executeCommand returns { exitCode, result } with stdout only, so stderr is folded into the output.
    const exec = (cmd, seconds) => sb.process.executeCommand(`sh -c ${shellQuote([`${cmd} 2>&1`])}`, root, undefined, seconds);
    await sb.process.executeCommand(shellQuote(['mkdir', '-p', root]), '/', undefined, 60);
    await sb.fs.uploadFile(bundle, `${root}/bundle.tgz`);
    const unpack = await exec(`tar -xzf ${root}/bundle.tgz -C ${root} && mkdir -p ${root}/out ${root}/home`, 600);
    if (unpack.exitCode !== 0) throw new ExecutorError('upload-failed', `unpacking in Daytona failed: ${clip(unpack.result, 400)}`);
    for (const step of staged.prepare) {
      const r = await exec(step, 600);
      if (r.exitCode !== 0) throw new ExecutorError('install-failed', `${tool.name} setup in Daytona failed: ${clip(r.result, 400)}`);
    }
    const env = scannerEnv({ HOME: `${root}/home`, TMPDIR: `${root}/home` });
    const version = await exec(toolCommand(staged, tool.versionCheck.args, env), 300);
    const versionOutput = String(version.result || '').trim();
    if (!versionMatches(tool, versionOutput)) throw new ExecutorError('version-mismatch', `${tool.name} in Daytona printed "${versionOutput.split('\n')[0].slice(0, 160)}", expected ${tool.version}`);
    const r = await exec(toolCommand(staged, substitute(argv, paths), env), limits.timeoutSeconds);
    let resultWritten = true;
    await sb.fs.downloadFile(paths.result, resultPath).catch(() => { resultWritten = false; });
    return { exitCode: r.exitCode, timedOut: false, stdout: r.result || '', stderr: '', resultWritten, provenance: { provider: 'daytona', isolation: 'sandbox', network: 'none', ...(providerConfig.target ? { region: providerConfig.target } : {}), toolVersion: tool.version, versionOutput: versionOutput.split('\n')[0], ...staged.pin } };
  } finally {
    if (sb) await sb.delete().catch(() => {});
    staged.cleanup();
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function smokeTest({ manifest, providerConfig = {}, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'daytona');
  const { imageRef } = await import('../../toolchain.mjs');
  const sb = await client(sdk, providerConfig).create({ image: imageRef(manifest.baseImages.static), networkBlockAll: true, ephemeral: true, autoStopInterval: 15 }, { timeout: 300 });
  try {
    const r = await sb.process.executeCommand('uname -m', '/', undefined, 60);
    return { ok: r.exitCode === 0, detail: `Daytona sandbox answered: ${String(r.result).trim()}` };
  } finally {
    await sb.delete().catch(() => {});
  }
}
