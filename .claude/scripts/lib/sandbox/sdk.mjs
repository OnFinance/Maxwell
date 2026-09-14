// Loads a hosted sandbox SDK pinned in toolchain.json. The SDK is installed on first use outside the workspace with
// `npm ci` from the committed lockfile in scanner-toolchain/references/sdk-locks/<provider>/, so every transitive
// package is pinned by integrity, and the installed top-level package (and each pinned companion, such as the S3 client
// Lambda MicroVMs needs) must match the pinned version and integrity.
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TOOLCHAIN_DIR, WORKSPACE } from '../toolchain.mjs';
import { ExecutorError } from './common.mjs';

export function sdkRoot(env = process.env) {
  return env.MAXWELL_SDK_CACHE || join(env.HOME || homedir(), '.cache', 'maxwell', 'sandbox-sdk');
}

// The entry point Node itself would load: the exports map, else "main". The bundler-only "module" field is a last
// resort, because Node never reads it (the AWS SDK's dist-es build does not load as plain ESM).
export function entryPoint(pkgDir, pkg) {
  const pick = (target) => {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) return target.map(pick).find(Boolean);
    if (target && typeof target === 'object') return pick(target.import) || pick(target.node) || pick(target.default) || pick(target.require);
    return undefined;
  };
  const exp = pkg.exports && (typeof pkg.exports === 'string' || Array.isArray(pkg.exports) || !Object.keys(pkg.exports).some((k) => k.startsWith('.')) ? pkg.exports : pkg.exports['.']);
  const rel = pick(exp) || pkg.main || pkg.module || 'index.js';
  return join(pkgDir, rel);
}

const pinnedPackages = (pin) => [pin, ...(pin.companions || [])];

// Checks every pinned package against the lockfile and the installed copy; returns the one named (default: the SDK).
export function verifyInstall(dir, pin, name = pin.package) {
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new ExecutorError('sdk-integrity', `${pin.package}: no package-lock.json in ${dir}`);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')).packages;
  let found = null;
  for (const p of pinnedPackages(pin)) {
    const entry = lock[`node_modules/${p.package}`];
    if (!entry || entry.version !== p.version || entry.integrity !== p.integrity) {
      throw new ExecutorError('sdk-integrity', `${p.package}: the lockfile pins ${entry ? `${entry.version} ${entry.integrity}` : 'nothing'}, toolchain.json pins ${p.version} ${p.integrity}`);
    }
    const pkgDir = join(dir, 'node_modules', ...p.package.split('/'));
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.version !== p.version) throw new ExecutorError('sdk-integrity', `${p.package}: installed ${pkg.version}, pinned ${p.version}`);
    if (p.package === name) found = { pkgDir, pkg };
  }
  if (!found) throw new ExecutorError('sdk-not-pinned', `${name} is not pinned with the ${pin.package} SDK`);
  return found;
}

export async function loadSdk(manifest, provider, { root = sdkRoot(), run = spawnSync, importer = (url) => import(url), pkg: name } = {}) {
  const pin = (manifest.sdks || []).find((s) => s.provider === provider);
  if (!pin) throw new ExecutorError('sdk-not-pinned', `no SDK is pinned for ${provider}`);
  const dir = join(root, `${provider}-${pin.version}`);
  if (dir.startsWith(WORKSPACE)) throw new ExecutorError('sdk-in-workspace', 'the SDK cache must be outside the workspace');
  const src = join(TOOLCHAIN_DIR, 'sdk-locks', provider);
  if (pinnedPackages(pin).some((p) => !existsSync(join(dir, 'node_modules', ...p.package.split('/'), 'package.json')))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(src, f), join(dir, f));
    const r = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], { cwd: dir, encoding: 'utf8', timeout: 600000 });
    if (r.status !== 0) throw new ExecutorError('sdk-install-failed', `npm ci for ${pin.package}@${pin.version} failed: ${(r.stderr || '').trim().slice(-400)}`);
  }
  const { pkgDir, pkg } = verifyInstall(dir, pin, name || pin.package);
  return importer(pathToFileURL(entryPoint(pkgDir, pkg)).href);
}
