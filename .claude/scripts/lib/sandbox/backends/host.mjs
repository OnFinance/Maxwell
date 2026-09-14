// host: runs the pinned, checksum-verified binary (or hash-locked Python install) on the machine hosting the harness.
// No isolation and no network control; chosen only explicitly in /connect-sandbox.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ensureHostTool, hostPlatform } from '../../toolchain.mjs';
import { clip, scannerEnv, substitute } from '../common.mjs';

export async function runTool({ manifest, tool, argv, repoDir, resultPath, limits, deps = {} }) {
  const run = deps.run || spawnSync;
  const platform = hostPlatform();
  const { path, versionOutput } = await ensureHostTool(manifest, tool.name, { fetchImpl: deps.fetchImpl, run });
  const home = mkdtempSync(join(tmpdir(), 'maxwell-scan-'));
  try {
    const r = run(path, substitute(argv, { src: repoDir, result: resultPath }), {
      cwd: dirname(resultPath), encoding: 'utf8', timeout: limits.timeoutSeconds * 1000, maxBuffer: 256 << 20,
      env: { ...scannerEnv({ HOME: home, TMPDIR: home }), PATH: '/usr/bin:/bin' },
    });
    return {
      exitCode: r.status ?? 124, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), stdout: r.stdout || '', stderr: clip(r.stderr),
      provenance: { provider: 'host', isolation: 'none', platform, toolVersion: tool.version, versionOutput, ...(tool.artifacts && tool.artifacts[platform] ? { artifactSha256: tool.artifacts[platform].sha256 } : {}), ...(tool.python ? { lockSha256: tool.python.lockSha256 } : {}) },
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Runtime commands on the host use the pinned binary when one exists (kubectl, jq) and otherwise the CLI installed
// on the host, whose version is recorded but not pinned.
export async function runCommand({ manifest, argv, env, stdin, timeoutSeconds, deps = {} }) {
  const run = deps.run || spawnSync;
  const pinned = (manifest.tools || []).find((t) => t.name === argv[0] && t.artifacts && t.artifacts[hostPlatform()]);
  let bin = argv[0]; let versionOutput; let isPinned = false;
  if (pinned) ({ path: bin, versionOutput } = await ensureHostTool(manifest, argv[0], { fetchImpl: deps.fetchImpl, run }), isPinned = true);
  const r = run(bin, argv.slice(1), { encoding: 'utf8', input: stdin || '', timeout: timeoutSeconds * 1000, maxBuffer: 8 << 20, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...env } });
  return { exitCode: r.status ?? 124, timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'), stdout: r.stdout || '', stderr: clip(r.stderr, 2000), provenance: { provider: 'host', isolation: 'none', pinned: isPinned, ...(versionOutput ? { versionOutput } : {}) } };
}
