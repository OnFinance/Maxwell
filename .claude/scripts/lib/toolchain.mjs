// Pinned toolchain: resolves tools from scanner-toolchain/references/toolchain.json and installs release binaries or
// hash-locked Python tools into a cache outside the workspace. Every artifact is checked against its pinned sha256
// before it is unpacked or run, the cached binary is re-hashed on every use, and the version it prints must match.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const TOOLCHAIN_DIR = join(WORKSPACE, '.claude/skills/scanner-toolchain/references');
export const TOOLCHAIN_PATH = join(TOOLCHAIN_DIR, 'toolchain.json');

export class ToolchainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const isInside = (dir, path) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function loadToolchain(path = TOOLCHAIN_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function getTool(manifest, name) {
  const tool = (manifest.tools || []).find((t) => t.name === name);
  if (!tool) throw new ToolchainError('not-pinned', `${name} is not pinned in toolchain.json; only pinned tools may run`);
  return tool;
}

export function hostPlatform(platform = process.platform, arch = process.arch) {
  const os = { linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch];
  return os && cpu ? `${os}-${cpu}` : null;
}

export function cacheRoot(env = process.env) {
  const root = env.MAXWELL_TOOLCHAIN_CACHE || join(env.HOME || homedir(), '.cache', 'maxwell', 'toolchain');
  if (isInside(WORKSPACE, root)) throw new ToolchainError('cache-in-workspace', `the toolchain cache ${root} must be outside the workspace`);
  return root;
}

// repo:tag@sha256:... - the digest decides what runs, the tag keeps it readable.
export const imageRef = (image) => `${image.ref}@${image.digest}`;

export function sha256File(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

export const versionMatches = (tool, output) => String(output || '').includes(tool.versionCheck.expect);

export function checkVersion(tool, path, run = spawnSync) {
  const r = run(path, tool.versionCheck.args, { encoding: 'utf8', timeout: 120000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (!versionMatches(tool, output)) throw new ToolchainError('version-mismatch', `${tool.name} at ${path} printed "${output.split('\n')[0].slice(0, 120)}", expected version ${tool.versionCheck.expect}`);
  return output.split('\n')[0];
}

// Downloads, verifies and unpacks a release artifact for one platform. Returns the executable path.
export async function ensureArtifact(tool, { platform = hostPlatform(), root = cacheRoot(), fetchImpl = globalThis.fetch } = {}) {
  const art = tool.artifacts && tool.artifacts[platform];
  if (!art) throw new ToolchainError('no-artifact', `${tool.name} ${tool.version} has no pinned release artifact for ${platform}`);
  const dir = join(root, tool.name, tool.version, platform);
  const bin = join(dir, tool.name);
  const marker = join(dir, '.verified');
  if (existsSync(bin) && existsSync(marker)) {
    const [artifactSha, binSha] = readFileSync(marker, 'utf8').trim().split(' ');
    if (artifactSha === art.sha256 && binSha === sha256File(bin)) return bin;
  }
  mkdirSync(dir, { recursive: true });
  const res = await fetchImpl(art.url, { redirect: 'follow' });
  if (!res.ok) throw new ToolchainError('download-failed', `${tool.name}: downloading ${art.url} failed with HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== art.sha256) throw new ToolchainError('checksum-mismatch', `${tool.name} ${tool.version} ${platform}: downloaded sha256 ${got} does not match the pin ${art.sha256}`);
  const staging = mkdtempSync(join(dir, '.staging-'));
  try {
    let extracted;
    if (art.archive === 'tar.gz') {
      const archive = join(staging, 'artifact.tar.gz');
      writeFileSync(archive, body);
      const r = spawnSync('tar', ['-xzf', archive, '-C', staging, '--no-same-owner', '--', art.binaryPath], { encoding: 'utf8' });
      if (r.status !== 0) throw new ToolchainError('unpack-failed', `${tool.name}: ${art.binaryPath} not found in the archive: ${(r.stderr || '').trim()}`);
      extracted = join(staging, art.binaryPath);
    } else {
      extracted = join(staging, tool.name);
      writeFileSync(extracted, body);
    }
    chmodSync(extracted, 0o755);
    renameSync(extracted, bin);
    writeFileSync(marker, `${art.sha256} ${sha256File(bin)}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return bin;
}

// Installs a Python tool with the pinned uv from its hash-locked requirements. Returns the executable path.
export async function ensurePythonTool(manifest, tool, { platform = hostPlatform(), root = cacheRoot(), fetchImpl = globalThis.fetch, run = spawnSync } = {}) {
  const lock = join(TOOLCHAIN_DIR, tool.python.lock);
  if (sha256File(lock) !== tool.python.lockSha256) throw new ToolchainError('lock-mismatch', `${tool.python.lock} does not match its pinned sha256`);
  const dir = join(root, tool.name, tool.version, `python${tool.python.pythonVersion}-${platform}`);
  const bin = join(dir, 'venv', 'bin', tool.name);
  const marker = join(dir, '.verified');
  if (existsSync(bin) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === tool.python.lockSha256) return bin;
  const uv = await ensureArtifact(getTool(manifest, 'uv'), { platform, root, fetchImpl });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, UV_PYTHON_DOWNLOADS: 'automatic', UV_NO_CONFIG: '1' };
  const venv = run(uv, ['venv', '--quiet', '--python', tool.python.pythonVersion, join(dir, 'venv')], { encoding: 'utf8', env, timeout: 900000 });
  if (venv.status !== 0) throw new ToolchainError('install-failed', `${tool.name}: uv venv failed: ${(venv.stderr || '').trim().slice(-400)}`);
  const install = run(uv, ['pip', 'install', '--quiet', '--require-hashes', '--no-deps', '--python', join(dir, 'venv', 'bin', 'python'), '-r', lock], { encoding: 'utf8', env, timeout: 1800000 });
  if (install.status !== 0) throw new ToolchainError('install-failed', `${tool.name}: hash-locked install failed: ${(install.stderr || '').trim().slice(-400)}`);
  writeFileSync(marker, `${tool.python.lockSha256}\n`);
  return bin;
}

// Installs a Python tool's hash-locked wheels into a plain directory for a Linux container or sandbox (mounted or
// uploaded next to the pinned Python base image and run as `python -m <package>` with PYTHONPATH). Wheels only, so
// nothing is compiled; the pinned uv resolves them for the target platform, not this machine.
export async function ensurePythonTarget(manifest, tool, { linuxPlatform = 'linux-amd64', root = cacheRoot(), fetchImpl = globalThis.fetch, run = spawnSync } = {}) {
  const lock = join(TOOLCHAIN_DIR, tool.python.lock);
  if (sha256File(lock) !== tool.python.lockSha256) throw new ToolchainError('lock-mismatch', `${tool.python.lock} does not match its pinned sha256`);
  const dir = join(root, tool.name, tool.version, `site-python${tool.python.pythonVersion}-${linuxPlatform}`);
  const site = join(dir, 'site');
  const marker = join(dir, '.verified');
  if (existsSync(site) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === tool.python.lockSha256) return site;
  const uv = await ensureArtifact(getTool(manifest, 'uv'), { platform: hostPlatform(), root, fetchImpl });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const pyPlatform = linuxPlatform === 'linux-arm64' ? 'aarch64-manylinux_2_28' : 'x86_64-manylinux_2_28';
  const r = run(uv, ['pip', 'install', '--quiet', '--require-hashes', '--no-deps', '--only-binary', ':all:', '--target', site, '--python-platform', pyPlatform, '--python-version', tool.python.pythonVersion, '-r', lock], { encoding: 'utf8', env: { ...process.env, UV_NO_CONFIG: '1' }, timeout: 1800000 });
  if (r.status !== 0) throw new ToolchainError('install-failed', `${tool.name}: hash-locked wheel install for ${linuxPlatform} failed: ${(r.stderr || '').trim().slice(-400)}`);
  writeFileSync(marker, `${tool.python.lockSha256}\n`);
  return site;
}

// The executable for a tool on this machine, installed and version-checked.
export async function ensureHostTool(manifest, name, options = {}) {
  const tool = getTool(manifest, name);
  const platform = options.platform || hostPlatform();
  let bin;
  if (tool.artifacts && tool.artifacts[platform]) bin = await ensureArtifact(tool, { ...options, platform });
  else if (tool.python) bin = await ensurePythonTool(manifest, tool, { ...options, platform });
  else throw new ToolchainError('no-host-install', `${name} ships only as an image; run it through a container executor (docker, kubernetes, daytona, modal)`);
  const versionOutput = checkVersion(tool, bin, options.run);
  return { tool, path: bin, versionOutput };
}
