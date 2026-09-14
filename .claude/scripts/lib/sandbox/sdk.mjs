// Loads a hosted sandbox SDK pinned in toolchain.json. The SDK is installed on first use outside the workspace with
// `npm ci` from the committed lockfile in scanner-toolchain/references/sdk-locks/<provider>/, so every transitive
// package is pinned by integrity, and the installed top-level package must match the pinned version and integrity.
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

// The ESM entry point of an installed package, from its exports map.
export function entryPoint(pkgDir, pkg) {
  const pick = (target) => {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) return target.map(pick).find(Boolean);
    if (target && typeof target === 'object') return pick(target.import) || pick(target.node) || pick(target.default) || pick(target.require);
    return undefined;
  };
  const exp = pkg.exports && (typeof pkg.exports === 'string' || Array.isArray(pkg.exports) || !Object.keys(pkg.exports).some((k) => k.startsWith('.')) ? pkg.exports : pkg.exports['.']);
  const rel = pick(exp) || pkg.module || pkg.main || 'index.js';
  return join(pkgDir, rel);
}

export function verifyInstall(dir, pin) {
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new ExecutorError('sdk-integrity', `${pin.package}: no package-lock.json in ${dir}`);
  const entry = JSON.parse(readFileSync(lockPath, 'utf8')).packages[`node_modules/${pin.package}`];
  if (!entry || entry.version !== pin.version || entry.integrity !== pin.integrity) {
    throw new ExecutorError('sdk-integrity', `${pin.package}: the lockfile pins ${entry ? `${entry.version} ${entry.integrity}` : 'nothing'}, toolchain.json pins ${pin.version} ${pin.integrity}`);
  }
  const pkgDir = join(dir, 'node_modules', ...pin.package.split('/'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.version !== pin.version) throw new ExecutorError('sdk-integrity', `${pin.package}: installed ${pkg.version}, pinned ${pin.version}`);
  return { pkgDir, pkg };
}

export async function loadSdk(manifest, provider, { root = sdkRoot(), run = spawnSync, importer = (url) => import(url) } = {}) {
  const pin = (manifest.sdks || []).find((s) => s.provider === provider);
  if (!pin) throw new ExecutorError('sdk-not-pinned', `no SDK is pinned for ${provider}`);
  const dir = join(root, `${provider}-${pin.version}`);
  if (dir.startsWith(WORKSPACE)) throw new ExecutorError('sdk-in-workspace', 'the SDK cache must be outside the workspace');
  const src = join(TOOLCHAIN_DIR, 'sdk-locks', provider);
  if (!existsSync(join(dir, 'node_modules', ...pin.package.split('/'), 'package.json'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(src, f), join(dir, f));
    const r = run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], { cwd: dir, encoding: 'utf8', timeout: 600000 });
    if (r.status !== 0) throw new ExecutorError('sdk-install-failed', `npm ci for ${pin.package}@${pin.version} failed: ${(r.stderr || '').trim().slice(-400)}`);
  }
  const { pkgDir, pkg } = verifyInstall(dir, pin);
  return importer(pathToFileURL(entryPoint(pkgDir, pkg)).href);
}
