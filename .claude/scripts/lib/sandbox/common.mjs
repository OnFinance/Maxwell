// Shared pieces of the executor backends: sandbox paths, quoting, repository bundles and resource defaults.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

export class ExecutorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const PROVIDERS = ['docker', 'kubernetes', 'e2b', 'daytona', 'modal', 'vercel', 'lambda-microvms', 'host'];
export const HOSTED = ['e2b', 'daytona', 'modal', 'vercel', 'lambda-microvms'];
export const RUNTIME_PROVIDERS = ['docker', 'kubernetes', 'host'];

// Paths a scanner sees inside a sandbox. Agents write {src} (the checkout, read-only) and {result} (the one file the
// scanner writes) in their arguments.
export const sandboxPaths = (root) => ({ root, src: `${root}/src`, result: `${root}/out/result`, opt: `${root}/opt` });
export const IN_SANDBOX = sandboxPaths('/work');
export const HOSTED_ROOT = '/tmp/maxwell';

// Domains a sandbox may reach when static.network is package-registries: the pinned uv, CPython builds and PyPI.
export const PACKAGE_REGISTRY_DOMAINS = ['pypi.org', 'files.pythonhosted.org', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

export function substitute(argv, paths) {
  return argv.map((a) => String(a).split('{src}').join(paths.src).split('{result}').join(paths.result));
}

export function shellQuote(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_/.:=@%+,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

export function limitsOf(cfg = {}) {
  return { cpu: cfg.cpu ?? 2, memoryMb: cfg.memoryMb ?? 4096, timeoutSeconds: cfg.timeoutSeconds ?? 900 };
}

// Linux platform for container images on this host's CPU.
export const linuxPlatform = (arch = process.arch) => (arch === 'arm64' ? 'linux-arm64' : 'linux-amd64');

// A gzip tar with the checkout under src/ (without .git) and optional extras under opt/. Symlinks inside the
// checkout are stored as symlinks, never followed, so no file outside the checkout can be packed.
export function packBundle(repoDir, dest, { optDir, run = spawnSync, platform = process.platform } = {}) {
  const rename = (prefix) => (platform === 'darwin' ? ['-s', `,^\\.,${prefix},`] : [`--transform=s,^\\.,${prefix},`]);
  const tarFile = dest.replace(/\.tgz$|\.tar\.gz$/, '') + '.tar';
  rmSync(tarFile, { force: true });
  const steps = [['-cf', tarFile, '--exclude=./.git', ...rename('src'), '-C', repoDir, '.']];
  if (optDir) steps.push(['-rf', tarFile, ...rename('opt'), '-C', optDir, '.']);
  for (const args of steps) {
    const r = run('tar', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new ExecutorError('bundle-failed', `packing ${repoDir} failed: ${(r.stderr || '').trim()}`);
  }
  const z = run('gzip', ['-f', '-n', tarFile], { encoding: 'utf8' });
  if (z.status !== 0) throw new ExecutorError('bundle-failed', `compressing the bundle failed: ${(z.stderr || '').trim()}`);
  const gz = `${tarFile}.gz`;
  if (gz !== dest) {
    const mv = run('mv', ['-f', gz, dest], { encoding: 'utf8' });
    if (mv.status !== 0) throw new ExecutorError('bundle-failed', `moving the bundle failed: ${(mv.stderr || '').trim()}`);
  }
  return dest;
}

// Environment for a scanner: nothing from the host except a locale, so host credentials never reach a tool, and every
// telemetry or update check the pinned tools support is off.
export function scannerEnv(extra = {}) {
  return { HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', NO_COLOR: '1', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', TRIVY_NO_PROGRESS: 'true', DO_NOT_TRACK: '1', SCARF_ANALYTICS: 'false', ...extra };
}

export const clip = (s, n = 8000) => {
  const t = String(s || '');
  return t.length > n ? `…${t.slice(-n)}` : t;
};
