// e2b: E2B sandbox (Firecracker microVM) from the default template. Egress is blocked unless static.network is
// package-registries, in which case only the package registries are reachable. Credentials: E2B_API_KEY.
// SDK: e2b, pinned in toolchain.json (API from the package's type definitions; not yet exercised against a live account).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionMatches } from '../../toolchain.mjs';
import { loadSdk } from '../sdk.mjs';
import { stageTool, toolCommand } from '../stage.mjs';
import { ExecutorError, HOSTED_ROOT, PACKAGE_REGISTRY_DOMAINS, clip, packBundle, sandboxPaths, scannerEnv, shellQuote, substitute } from '../common.mjs';

export const CREDENTIALS = ['E2B_API_KEY'];

export async function runTool({ manifest, tool, argv, repoDir, resultPath, network, limits, providerConfig = {}, deps = {} }) {
  if (!process.env.E2B_API_KEY) throw new ExecutorError('not-configured', 'E2B_API_KEY is not set; run /connect-sandbox');
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'e2b');
  const root = HOSTED_ROOT; const paths = sandboxPaths(root);
  const staged = await stageTool(manifest, tool, { oci: false, network, provider: 'e2b', root, fetchImpl: deps.fetchImpl, run: deps.run });
  const staging = mkdtempSync(join(tmpdir(), 'maxwell-bundle-'));
  const options = { timeoutMs: (limits.timeoutSeconds + 900) * 1000, ...(providerConfig.domain ? { domain: providerConfig.domain } : {}) };
  if (network === 'package-registries') options.network = { allowOut: PACKAGE_REGISTRY_DOMAINS, denyOut: [sdk.ALL_TRAFFIC] };
  else options.allowInternetAccess = false;
  let sbx;
  try {
    const bundle = packBundle(repoDir, join(staging, 'bundle.tgz'), { optDir: staged.optDir, run: deps.run });
    sbx = await sdk.Sandbox.create(options);
    // A non-zero exit rejects with CommandExitError, which carries exitCode, stdout and stderr.
    const exec = (cmd, seconds, envs) => sbx.commands.run(cmd, { cwd: root, timeoutMs: seconds * 1000, ...(envs ? { envs } : {}) })
      .catch((err) => (err && typeof err.exitCode === 'number' ? err : Promise.reject(err)));
    await sbx.commands.run(shellQuote(['mkdir', '-p', root]), { timeoutMs: 60000 });
    await sbx.files.write([{ path: `${root}/bundle.tgz`, data: readFileSync(bundle) }]);
    const unpack = await exec(`tar -xzf bundle.tgz -C ${root} && mkdir -p ${root}/out ${root}/home`, 600);
    if (unpack.exitCode !== 0) throw new ExecutorError('upload-failed', `unpacking in E2B failed: ${clip(unpack.stderr, 400)}`);
    for (const step of staged.prepare) {
      const r = await exec(step, 1800, staged.prepareEnv);
      if (r.exitCode !== 0) throw new ExecutorError('install-failed', `${tool.name} install in E2B failed: ${clip(r.stderr, 400)}`);
    }
    const env = scannerEnv({ HOME: `${root}/home`, TMPDIR: `${root}/home` });
    const version = await exec(toolCommand(staged, tool.versionCheck.args, env), 300);
    const versionOutput = `${version.stdout || ''}${version.stderr || ''}`.trim();
    if (!versionMatches(tool, versionOutput)) throw new ExecutorError('version-mismatch', `${tool.name} in E2B printed "${versionOutput.split('\n')[0].slice(0, 160)}", expected ${tool.version}`);
    const r = await exec(toolCommand(staged, substitute(argv, paths), env), limits.timeoutSeconds);
    const bytes = await sbx.files.read(paths.result, { format: 'bytes' }).catch(() => null);
    if (bytes) writeFileSync(resultPath, Buffer.from(bytes));
    return { exitCode: r.exitCode, timedOut: false, stdout: r.stdout || '', stderr: clip(r.stderr), provenance: { provider: 'e2b', isolation: 'microvm', network, toolVersion: tool.version, versionOutput: versionOutput.split('\n')[0], ...staged.pin } };
  } finally {
    if (sbx) await sbx.kill().catch(() => {});
    staged.cleanup();
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function smokeTest({ manifest, deps = {} }) {
  const sdk = await (deps.loadSdk || loadSdk)(manifest, 'e2b');
  const sbx = await sdk.Sandbox.create({ allowInternetAccess: false, timeoutMs: 120000 });
  try {
    const r = await sbx.commands.run('uname -m', { timeoutMs: 60000 });
    return { ok: r.exitCode === 0, detail: `E2B sandbox ${sbx.sandboxId || ''} answered: ${String(r.stdout).trim()}` };
  } finally {
    await sbx.kill().catch(() => {});
  }
}
