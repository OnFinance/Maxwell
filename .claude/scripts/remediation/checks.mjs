import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../incident-investigation/core.mjs';
import { requireValue } from '../feature-runtime/store.mjs';
const exec = promisify(execFile);
export function validateCheck(check) {
  requireValue(check && check.version === 1 && ['json-field-equals', 'file-sha256'].includes(check.type), 'unsupported deterministic check');
  requireValue(typeof check.path === 'string' && check.path.length <= 512 && !isAbsolute(check.path) && !check.path.split(/[\\/]/).some((p) => !p || p === '..' || p === '.' || p.startsWith('-')), 'invalid check path');
  if (check.type === 'file-sha256') requireValue(/^[a-f0-9]{64}$/.test(check.expected), 'invalid expected digest');
  else requireValue(Array.isArray(check.field) && check.field.length > 0 && check.field.length <= 20
    && check.field.every((k) => typeof k === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(k) && !['__proto__', 'prototype', 'constructor'].includes(k))
    && ['string', 'number', 'boolean'].includes(typeof check.expected), 'invalid JSON assertion');
}
export async function checkArtifact({ checkout, revision, check }) {
  validateCheck(check); requireValue(/^[a-f0-9]{40}$/.test(revision), 'full commit required');
  const root = await realpath(checkout);
  const gitEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete gitEnv[key];
  const git = async (...args) => (await exec('git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 1048576,
    env: gitEnv })).stdout.trim();
  // Strip inherited Git overrides rather than accidentally reading the caller's repository.
  const snapshot = async () => { requireValue(await git('rev-parse', 'HEAD') === revision, 'target revision changed'); requireValue(await git('status', '--porcelain', '--untracked-files=normal') === '', 'target checkout is dirty'); };
  await snapshot();
  const file = await realpath(resolve(root, check.path)); const inside = relative(root, file);
  requireValue(inside && !inside.startsWith('..') && !isAbsolute(inside) && (await stat(file)).size <= 5 * 1024 * 1024, 'unsafe or oversized artifact');
  await git('ls-files', '--error-unmatch', '--', check.path);
  const bytes = await readFile(file); let passed;
  if (check.type === 'file-sha256') passed = createHash('sha256').update(bytes).digest('hex') === check.expected;
  else { let value = JSON.parse(bytes.toString('utf8')); for (const key of check.field) value = value && Object.hasOwn(value, key) ? value[key] : undefined; passed = value === check.expected; }
  await snapshot();
  return { outcome: passed ? 'passed' : 'failed', revision, checkHash: sha256(check), artifactHash: createHash('sha256').update(bytes).digest('hex') };
}
