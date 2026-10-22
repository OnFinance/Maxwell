#!/usr/bin/env node
// Adds an application to the workspace from a short JSON spec, validated before anything is written.
// Usage: node .claude/scripts/apps/add.mjs <spec.json | -> [--checkout] [--force] [--dry-run] [--now <rfc3339>]
//   spec: { "appId": "payments-api", "description": "...", "sopsRecipients": ["age1..."],
//           "repos": [{ "repoId": "payments", "url": "https://github.com/acme/payments.git",
//                       "pinnedCommit": "<40-hex sha>", "defaultBranch": "main", "visibility": "private" }] }
// Writes applications/<app_id>/README.md, repos/<repo_id>.json (repo.schema.json) and, when the application has none,
// an empty credentials.json (no entries, sops-encrypted to the given age recipients). --checkout also fetches each
// repository at its pinned commit (depth 1) into applications/<app_id>/repos/<repo_id>/. Everything is prepared in a
// staging directory and moved into place only when every file validated and every fetch succeeded.
// An existing application is left alone unless --force; credentials.json is never replaced.
// Private repositories authenticate through git's own credential helper or SSH agent: URLs never carry a token.
// Exit codes: 0 done, 1 usage, 2 invalid spec or refused, 3 not configured (sops missing), 5 fetch failed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planApplication } from '../lib/applications.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const source = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--now');
const fail = (code, message) => { console.error(message); process.exit(code); };
if (!source) fail(1, 'usage: add.mjs <spec.json | -> [--checkout] [--force] [--dry-run] [--now <rfc3339>]');

let spec;
try { spec = JSON.parse(source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')); } catch (e) { fail(2, `spec is not readable JSON: ${e.message}`); }
const now = opt('--now') || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const checkout = flag('--checkout');
const force = flag('--force');
const dryRun = flag('--dry-run');

const appId = spec && typeof spec.appId === 'string' ? spec.appId : '';
const appDir = join('applications', appId);
const appExists = Boolean(appId) && existsSync(appDir);
const keepCredentials = appExists && existsSync(join(appDir, 'credentials.json'));
// Without --checkout, an existing checkout stays recorded only when the pin is unchanged (--force on an existing app).
const previous = (repoId) => { try { return JSON.parse(readFileSync(join(appDir, 'repos', `${repoId}.json`), 'utf8')); } catch { return {}; } };
const kept = (r) => { const p = previous(r.repoId); return appExists && existsSync(join(appDir, 'repos', r.repoId)) && p.pinnedCommit === r.pinnedCommit && p.localCheckout ? p.lastFetchedAt || true : false; };
const checkedOut = Object.fromEntries((Array.isArray(spec && spec.repos) ? spec.repos : []).filter((r) => r && typeof r.repoId === 'string')
  .map((r) => [r.repoId, checkout || kept(r)]));
const plan = planApplication(spec, { now, checkedOut, recipients: keepCredentials ? null : undefined });
if (plan.problems.length) fail(2, `nothing written; the spec has problems:\n- ${plan.problems.join('\n- ')}`);
if (appExists && !force) fail(2, `${appDir} already exists; nothing written. Pass --force to update its README and repository manifests (credentials.json is kept).`);
if (force) for (const r of plan.repos) {
  if (checkout && existsSync(join(appDir, 'repos', r.repoId)) && !existsSync(join(appDir, 'repos', `${r.repoId}.json`))) fail(2, `${appDir}/repos/${r.repoId}/ exists without a manifest; remove it first`);
}

const files = { [`${appDir}/README.md`]: plan.readme };
for (const r of plan.repos) files[`${appDir}/repos/${r.repoId}.json`] = JSON.stringify(r.doc, null, 2) + '\n';
const summary = {
  appId, dryRun, files: Object.keys(files).concat(plan.credentials ? [`${appDir}/credentials.json`] : []),
  kept: keepCredentials ? [`${appDir}/credentials.json`] : [],
  checkouts: checkout ? plan.repos.map((r) => `${appDir}/repos/${r.repoId}`) : [],
  defaulted: Object.fromEntries(plan.repos.map((r) => [r.repoId, r.defaulted])),
};
if (dryRun) {
  console.log(JSON.stringify({ ...summary, contents: { ...files, ...(plan.credentials ? { [`${appDir}/credentials.json`]: '(sops-encrypted) ' + JSON.stringify(plan.credentials) } : {}) } }, null, 2));
  process.exit(0);
}
if (plan.credentials && spawnSync('sops', ['--version'], { encoding: 'utf8' }).status !== 0) {
  fail(3, 'sops is not installed, so credentials.json cannot be encrypted; nothing written. Install sops (https://github.com/getsops/sops) and run again.');
}

mkdirSync('applications', { recursive: true });
const stage = mkdtempSync(join('applications', `.add-${appId}-`));
const abort = (code, message) => { rmSync(stage, { recursive: true, force: true }); fail(code, message); };
try {
  mkdirSync(join(stage, 'repos'), { recursive: true });
  for (const [path, body] of Object.entries(files)) writeFileSync(join(stage, path.slice(appDir.length + 1)), body);
  if (plan.credentials) {
    const tmp = mkdtempSync(join(tmpdir(), 'maxwell-app-'));
    try {
      const plain = join(tmp, 'credentials.json');
      writeFileSync(plain, JSON.stringify(plan.credentials, null, 2), { mode: 0o600 });
      const res = spawnSync('sops', ['--encrypt', '--age', plan.credentials.sopsRecipients.join(','), '--input-type', 'json', '--output-type', 'json', plain], { encoding: 'utf8', env: process.env });
      if (res.status !== 0) abort(3, `sops could not encrypt credentials.json; nothing written: ${(res.stderr || '').trim().slice(-500)}`);
      writeFileSync(join(stage, 'credentials.json'), res.stdout.endsWith('\n') ? res.stdout : res.stdout + '\n');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  if (checkout) {
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const r of plan.repos) {
      const dir = join(stage, 'repos', r.repoId);
      const git = (args) => spawnSync('git', args, { encoding: 'utf8', env: gitEnv });
      mkdirSync(dir, { recursive: true });
      for (const args of [['init', '-q', dir], ['-C', dir, 'fetch', '-q', '--depth', '1', '--', r.doc.url, r.doc.pinnedCommit], ['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD']]) {
        const res = git(args);
        if (res.status !== 0) abort(5, `could not fetch ${r.repoId} at ${r.doc.pinnedCommit}; nothing written: ${(res.stderr || '').trim().slice(-500)}`);
      }
      const head = (git(['-C', dir, 'rev-parse', 'HEAD']).stdout || '').trim();
      if (head !== r.doc.pinnedCommit) abort(5, `${r.repoId} checked out ${head || 'nothing'}, not the pinned ${r.doc.pinnedCommit}; nothing written`);
    }
  }
  if (!appExists) {
    renameSync(stage, appDir);
  } else {
    mkdirSync(join(appDir, 'repos'), { recursive: true });
    for (const r of plan.repos) {
      if (checkout) {
        rmSync(join(appDir, 'repos', r.repoId), { recursive: true, force: true });
        renameSync(join(stage, 'repos', r.repoId), join(appDir, 'repos', r.repoId));
      }
      renameSync(join(stage, 'repos', `${r.repoId}.json`), join(appDir, 'repos', `${r.repoId}.json`));
    }
    renameSync(join(stage, 'README.md'), join(appDir, 'README.md'));
    if (plan.credentials && readdirSync(stage).includes('credentials.json')) renameSync(join(stage, 'credentials.json'), join(appDir, 'credentials.json'));
    rmSync(stage, { recursive: true, force: true });
  }
} catch (e) {
  abort(2, `nothing written: ${e.message}`);
}

const check = spawnSync(process.execPath, ['.claude/scripts/validate-data.mjs', ...summary.files], { encoding: 'utf8', env: process.env });
console.log(JSON.stringify({ ...summary, validated: check.status === 0 }, null, 2));
if (check.status !== 0) fail(2, `written, but validation failed:\n${(check.stdout || '') + (check.stderr || '')}`);
