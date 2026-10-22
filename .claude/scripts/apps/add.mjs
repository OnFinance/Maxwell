#!/usr/bin/env node
// Adds an application to the workspace from a short JSON spec, validated before anything is written.
// Usage: node .claude/scripts/apps/add.mjs <spec.json | -> [--checkout] [--force] [--dry-run] [--now <rfc3339>]
//   spec: { "appId": "payments-api", "description": "...", "sopsRecipients": ["age1..."],
//           "repos": [{ "repoId": "payments", "url": "https://github.com/acme/payments.git",
//                       "pinnedCommit": "<40-hex sha>", "defaultBranch": "main", "visibility": "private" }] }
// Writes applications/<app_id>/README.md, repos/<repo_id>.json (repo.schema.json) and, when the application has none,
// an empty credentials.json (no entries, sops-encrypted to SOPS_AGE_RECIPIENTS or the spec's sopsRecipients).
// --checkout also fetches each repository at its pinned commit (depth 1) into applications/<app_id>/repos/<repo_id>/
// and reads containsIac, containsHelmChart, containsAgentCode and codeownersPresent from it. Other repository facts
// stay at their "not yet known" values (listed as `unverified`): run /refresh-apps before any probe.
//
// A new application is validated, built in a staging directory under the git-ignored .claude/worktrees/ and moved into
// place with one rename, so it appears whole or not at all. An existing application is left alone unless --force;
// then its manifests are merged (the spec's fields win, earlier facts are kept), credentials.json is never replaced,
// and the staged files are moved in one by one (each move is atomic, the set is not). The staging directory is removed
// on exit, Ctrl-C, SIGTERM or SIGHUP (fetches stop with it).
// Private repositories authenticate through git's own credential helper or SSH agent: URLs never carry a token.
// Exit codes: 0 done, 1 usage, 2 invalid spec or refused, 3 not configured (sops missing), 5 fetch failed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { deriveFacts, jsonErrorWhere, planApplication } from '../lib/applications.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const source = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--now');
const fail = (code, message) => { console.error(message); process.exit(code); };
if (!source) fail(1, 'usage: add.mjs <spec.json | -> [--checkout] [--force] [--dry-run] [--now <rfc3339>]');

let text;
try { text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8'); } catch (e) { fail(2, `spec could not be read: ${e.code || 'error'}`); }
let spec;
try { spec = JSON.parse(text); } catch (e) { fail(2, `spec is not JSON: ${jsonErrorWhere(text, e)}`); }
const now = opt('--now') || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const checkout = flag('--checkout');
const force = flag('--force');
const dryRun = flag('--dry-run');

const appId = spec && typeof spec.appId === 'string' ? spec.appId : '';
const appDir = join('applications', appId);
const appExists = /^[a-z0-9][a-z0-9-]{1,62}$/.test(appId) && existsSync(appDir);
if (appExists && !force) fail(2, `${appDir} already exists; nothing written. Pass --force to update its README and repository manifests (credentials.json is kept).`);
const keepCredentials = appExists && existsSync(join(appDir, 'credentials.json'));
const specRepos = (Array.isArray(spec && spec.repos) ? spec.repos : []).filter((r) => r && typeof r.repoId === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(r.repoId));
const readPrevious = (repoId) => { try { return JSON.parse(readFileSync(join(appDir, 'repos', `${repoId}.json`), 'utf8')); } catch { return null; } };
const previous = appExists ? Object.fromEntries(specRepos.map((r) => [r.repoId, readPrevious(r.repoId)]).filter(([, p]) => p)) : {};
const checkedOut = {};
for (const r of specRepos) {
  const dir = join(appDir, 'repos', r.repoId);
  const p = previous[r.repoId];
  if (checkout) {
    if (appExists && existsSync(dir) && !p) fail(2, `${dir}/ exists without a manifest; remove it first`);
    checkedOut[r.repoId] = true;
  } else if (appExists && existsSync(dir)) {
    if (!p || p.pinnedCommit !== r.pinnedCommit) fail(2, `${dir}/ holds a checkout of another commit; pass --checkout to fetch ${r.pinnedCommit}, or remove the checkout first`);
    if (p.localCheckout) checkedOut[r.repoId] = p.lastFetchedAt || true;
  }
}
const recipients = keepCredentials ? null : undefined;
let plan = planApplication(spec, { now, checkedOut, previous, recipients });
if (plan.problems.length) fail(2, `nothing written; the spec has problems:\n- ${plan.problems.join('\n- ')}`);

const filesOf = (p) => {
  const files = { [`${appDir}/README.md`]: p.readme };
  for (const r of p.repos) files[`${appDir}/repos/${r.repoId}.json`] = JSON.stringify(r.doc, null, 2) + '\n';
  return files;
};
const summaryOf = (p) => ({
  appId, dryRun, files: Object.keys(filesOf(p)).concat(p.credentials ? [`${appDir}/credentials.json`] : []),
  kept: keepCredentials ? [`${appDir}/credentials.json`] : [],
  checkouts: checkout ? p.repos.map((r) => `${appDir}/repos/${r.repoId}`) : [],
  unverified: Object.fromEntries(p.repos.map((r) => [r.repoId, r.unverified])),
  next: 'Run /refresh-apps before any probe: probes pick their targets from these repository facts.',
});
if (dryRun) {
  const contents = { ...filesOf(plan), ...(plan.credentials ? { [`${appDir}/credentials.json`]: '(sops-encrypted) ' + JSON.stringify(plan.credentials) } : {}) };
  console.log(JSON.stringify({ ...summaryOf(plan), ...(checkout ? { note: 'facts read from the checkout are not shown in a dry run' } : {}), contents }, null, 2));
  process.exit(0);
}
if (plan.credentials && spawnSync('sops', ['--version'], { encoding: 'utf8' }).status !== 0) {
  fail(3, 'sops is not installed, so credentials.json cannot be encrypted; nothing written. Install sops (https://github.com/getsops/sops) and run again.');
}

// Staging lives under .claude/worktrees/ (git-ignored and skipped by the layout validators) so a half-built application
// is never visible under applications/, and on the same filesystem so the final move is a rename.
mkdirSync(join('.claude', 'worktrees'), { recursive: true });
const stage = mkdtempSync(join('.claude', 'worktrees', `maxwell-add-${appId}-`));
const cleanup = () => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);
// Fetches and encryption run asynchronously so a signal is handled while they run: the child is stopped and the
// staging directory removed.
let child = null;
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { if (child) child.kill('SIGTERM'); cleanup(); process.exit(code); });
const run = (cmd, args, env) => new Promise((resolve) => {
  let stdout = ''; let stderr = '';
  child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (e) => { child = null; resolve({ status: 127, stdout, stderr: e.message }); });
  child.on('close', (status) => { child = null; resolve({ status, stdout, stderr }); });
});
const abort = (code, message) => { cleanup(); fail(code, message); };

try {
  mkdirSync(join(stage, 'repos'), { recursive: true });
  if (checkout) {
    // A caller's GIT_DIR or GIT_WORK_TREE would point these commands at another repository.
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(k)));
    gitEnv.GIT_TERMINAL_PROMPT = '0';
    const facts = {};
    for (const r of plan.repos) {
      const dir = join(stage, 'repos', r.repoId);
      const git = (args) => run('git', args, gitEnv);
      mkdirSync(dir, { recursive: true });
      for (const args of [['init', '-q', dir], ['-C', dir, 'fetch', '-q', '--depth', '1', '--', r.doc.url, r.doc.pinnedCommit], ['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD']]) {
        const res = await git(args);
        if (res.status !== 0) abort(5, `could not fetch ${r.repoId} at ${r.doc.pinnedCommit}; nothing written: ${(res.stderr || '').trim().slice(-500)}`);
      }
      const head = ((await git(['-C', dir, 'rev-parse', 'HEAD'])).stdout || '').trim();
      if (head !== r.doc.pinnedCommit) abort(5, `${r.repoId} checked out ${head || 'nothing'}, not the pinned ${r.doc.pinnedCommit}; nothing written`);
      facts[r.repoId] = deriveFacts(dir);
    }
    plan = planApplication(spec, { now, checkedOut, previous, facts, recipients });
    if (plan.problems.length) abort(2, `nothing written:\n- ${plan.problems.join('\n- ')}`);
  }
  for (const [path, body] of Object.entries(filesOf(plan))) writeFileSync(join(stage, path.slice(appDir.length + 1)), body);
  if (plan.credentials) {
    const tmp = mkdtempSync(join(tmpdir(), 'maxwell-app-'));
    try {
      const plain = join(tmp, 'credentials.json');
      writeFileSync(plain, JSON.stringify(plan.credentials, null, 2), { mode: 0o600 });
      const res = await run('sops', ['--encrypt', '--age', plan.credentials.sopsRecipients.join(','), '--input-type', 'json', '--output-type', 'json', plain], process.env);
      if (res.status !== 0) abort(3, `sops could not encrypt credentials.json; nothing written: ${(res.stderr || '').trim().slice(-500)}`);
      writeFileSync(join(stage, 'credentials.json'), res.stdout.endsWith('\n') ? res.stdout : res.stdout + '\n');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  if (!appExists) {
    mkdirSync('applications', { recursive: true });
    renameSync(stage, appDir);
  } else {
    // Checkouts first, then the manifests that point at them, then README and credentials.
    mkdirSync(join(appDir, 'repos'), { recursive: true });
    for (const r of plan.repos) {
      if (checkout) {
        rmSync(join(appDir, 'repos', r.repoId), { recursive: true, force: true });
        renameSync(join(stage, 'repos', r.repoId), join(appDir, 'repos', r.repoId));
      }
      renameSync(join(stage, 'repos', `${r.repoId}.json`), join(appDir, 'repos', `${r.repoId}.json`));
    }
    renameSync(join(stage, 'README.md'), join(appDir, 'README.md'));
    if (plan.credentials) renameSync(join(stage, 'credentials.json'), join(appDir, 'credentials.json'));
  }
} catch (e) {
  abort(2, `stopped: ${e.message}${appExists ? ' (an update may be partly applied; run again with --force)' : '; nothing written'}`);
}
cleanup();

const summary = summaryOf(plan);
const check = spawnSync(process.execPath, ['.claude/scripts/validate-data.mjs', ...summary.files], { encoding: 'utf8', env: process.env });
console.log(JSON.stringify({ ...summary, validated: check.status === 0 }, null, 2));
// Every file was validated before it was written, so this only fails if the files changed underneath the writer.
if (check.status !== 0) fail(2, `the files are in place, but checking them again failed:\n${(check.stdout || '') + (check.stderr || '')}`);
