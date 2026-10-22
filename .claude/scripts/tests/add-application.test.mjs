import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';
import { hostOf, urlProblem } from '../lib/applications.mjs';

const RECIPIENT = 'age1vzdled3c3dn54gxvkjh8rf4zxcqm7tjgs4th54dxjhf3qc8rpysqd98mph';
const SHA = 'a'.repeat(40);

// A throwaway workspace: the real schemas and layout, an empty applications/ and a stand-in `sops` on PATH that
// wraps its input in sops metadata (no key material involved), so the tests need neither sops nor network.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-app-'));
  mkdirSync(join(dir, '.claude/scripts'), { recursive: true });
  symlinkSync(join(WORKSPACE, '.claude/schemas'), join(dir, '.claude/schemas'));
  symlinkSync(join(WORKSPACE, '.claude/scripts/validate-data.mjs'), join(dir, '.claude/scripts/validate-data.mjs'));
  symlinkSync(join(WORKSPACE, '.claude/scripts/lib'), join(dir, '.claude/scripts/lib'));
  symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
  const bin = join(dir, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sops'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('sops 3.9.0 (stand-in)'); process.exit(0); }
const doc = JSON.parse(fs.readFileSync(a[a.length - 1], 'utf8'));
const enc = (v) => Array.isArray(v) ? v.map(enc) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : 'ENC[AES256_GCM,data:x,iv:y,tag:z,type:str]';
process.stdout.write(JSON.stringify({ ...enc(doc), sops: { age: [{ recipient: a[a.indexOf('--age') + 1], enc: 'stand-in' }], version: '3.9.0' } }));
`);
  chmodSync(join(bin, 'sops'), 0o755);
  return { dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAXWELL_RUN_ID: '' } };
}

const run = (ws, args, input, extraEnv = {}) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/apps/add.mjs'), ...args], { cwd: ws.dir, input, encoding: 'utf8', env: { ...ws.env, ...extraEnv } });
const spec = (over = {}) => JSON.stringify({ appId: 'payments-api', description: 'Card payments API.', sopsRecipients: [RECIPIENT], repos: [{ repoId: 'payments', url: 'https://github.com/acme/payments.git', pinnedCommit: SHA }], ...over });

test('a valid spec writes a README, a schema-valid repo manifest and an encrypted, empty credentials.json', () => {
  const ws = workspace();
  try {
    const r = run(ws, ['-', '--now', '2026-10-22T00:00:00Z'], spec());
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.validated, true);
    assert.deepEqual(out.defaulted.payments, ['host', 'visibility', 'defaultBranch', 'languages', 'buildSystem', 'ciSystem', 'containsIac', 'containsHelmChart', 'containsAgentCode', 'codeownersPresent']);
    const repo = JSON.parse(readFileSync(join(ws.dir, 'applications/payments-api/repos/payments.json'), 'utf8'));
    assert.equal(repo.host, 'github');
    assert.equal(repo.pinnedCommit, SHA);
    assert.equal(repo.localCheckout, undefined);
    assert.deepEqual(repo.provenance, { harness: 'script', generatedAt: '2026-10-22T00:00:00Z', agent: '.claude/scripts/apps/add.mjs' });
    const creds = JSON.parse(readFileSync(join(ws.dir, 'applications/payments-api/credentials.json'), 'utf8'));
    assert.ok(creds.sops && creds.sops.age[0].recipient === RECIPIENT);
    assert.match(readFileSync(join(ws.dir, 'applications/payments-api/README.md'), 'utf8'), /^# payments-api\n\nCard payments API\./);
    assert.deepEqual(readdirSync(join(ws.dir, 'applications')), ['payments-api']);
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test('an invalid spec writes nothing and says why', () => {
  const ws = workspace();
  try {
    for (const [bad, re] of [
      [spec({ appId: 'Payments API' }), /appId must be a slug/],
      [spec({ repos: [{ repoId: 'payments', url: 'https://github.com/acme/payments.git', pinnedCommit: 'abc1234' }] }), /full 40-character commit SHA/],
      [spec({ repos: [{ repoId: 'payments', url: 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/p.git', pinnedCommit: SHA }] }), /must not contain a user name or token/],
      [spec({ repos: [{ repoId: 'payments', url: 'https://github.com/acme/payments.git', pinnedCommit: SHA, buildSystem: 'rake' }] }), /does not match repo.schema.json/],
      [spec({ sopsRecipients: undefined }), /at least one age recipient/],
      [spec({ owner: 'x' }), /unknown spec key 'owner'/],
    ]) {
      const r = run(ws, ['-'], bad, { SOPS_AGE_RECIPIENTS: '' });
      assert.equal(r.status, 2, r.stdout);
      assert.match(r.stderr, re);
      assert.doesNotMatch(r.stderr, /ghp_/);
    }
    assert.equal(existsSync(join(ws.dir, 'applications')), false);
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test('an existing application is not overwritten without --force, and --force keeps credentials.json', () => {
  const ws = workspace();
  try {
    assert.equal(run(ws, ['-'], spec()).status, 0);
    const credsBefore = readFileSync(join(ws.dir, 'applications/payments-api/credentials.json'), 'utf8');
    const again = run(ws, ['-'], spec({ description: 'Changed.' }));
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists/);
    assert.match(readFileSync(join(ws.dir, 'applications/payments-api/README.md'), 'utf8'), /Card payments API/);
    const forced = run(ws, ['-', '--force'], spec({ description: 'Changed.', sopsRecipients: undefined }));
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(JSON.parse(forced.stdout).kept, ['applications/payments-api/credentials.json']);
    assert.match(readFileSync(join(ws.dir, 'applications/payments-api/README.md'), 'utf8'), /Changed\./);
    assert.equal(readFileSync(join(ws.dir, 'applications/payments-api/credentials.json'), 'utf8'), credsBefore);
    assert.deepEqual(readdirSync(join(ws.dir, 'applications')), ['payments-api']);
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test('--dry-run prints the files and writes nothing; without sops nothing is written either', () => {
  const ws = workspace();
  try {
    const r = run(ws, ['-', '--dry-run'], spec());
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.contents['applications/payments-api/repos/payments.json']);
    assert.equal(existsSync(join(ws.dir, 'applications')), false);
    const noSops = run(ws, ['-'], spec(), { PATH: '/nonexistent' });
    assert.equal(noSops.status, 3);
    assert.equal(existsSync(join(ws.dir, 'applications')), false);
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test('--checkout fetches the pinned commit at depth 1; a missing commit leaves nothing behind', () => {
  const ws = workspace();
  const src = join(ws.dir, '.src');
  try {
    const git = (args, cwd = src) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    mkdirSync(src);
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(src, 'main.tf'), 'resource "x" "y" {}\n');
    git(['add', '.']); git(['commit', '-q', '-m', 'one']);
    const first = git(['rev-parse', 'HEAD']);
    writeFileSync(join(src, 'later.txt'), 'later\n');
    git(['add', '.']); git(['commit', '-q', '-m', 'two']);
    // The manifest keeps the real https URL; git is pointed at the local fixture for this test only.
    const redirect = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${src}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://git.example.com/acme/payments.git' };
    const s = spec({ repos: [{ repoId: 'payments', url: 'https://git.example.com/acme/payments.git', pinnedCommit: first }] });
    const r = run(ws, ['-', '--checkout', '--now', '2026-10-22T00:00:00Z'], s, redirect);
    assert.equal(r.status, 0, r.stderr);
    const dir = join(ws.dir, 'applications/payments-api/repos/payments');
    assert.equal(git(['rev-parse', 'HEAD'], dir), first);
    assert.equal(existsSync(join(dir, 'later.txt')), false);
    assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '1');
    const repo = JSON.parse(readFileSync(join(ws.dir, 'applications/payments-api/repos/payments.json'), 'utf8'));
    assert.equal(repo.localCheckout, 'applications/payments-api/repos/payments');
    assert.equal(repo.lastFetchedAt, '2026-10-22T00:00:00Z');
    assert.equal(repo.host, 'other');
    // --force without --checkout keeps recording an unchanged checkout, with its original fetch time.
    const refreshed = run(ws, ['-', '--force', '--now', '2026-10-23T00:00:00Z'], s);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const after = JSON.parse(readFileSync(join(ws.dir, 'applications/payments-api/repos/payments.json'), 'utf8'));
    assert.equal(after.localCheckout, 'applications/payments-api/repos/payments');
    assert.equal(after.lastFetchedAt, '2026-10-22T00:00:00Z');

    const missing = run(ws, ['-', '--checkout'], spec({ appId: 'other-app', repos: [{ repoId: 'payments', url: 'https://git.example.com/acme/payments.git', pinnedCommit: 'b'.repeat(40) }] }), redirect);
    assert.equal(missing.status, 5);
    assert.deepEqual(readdirSync(join(ws.dir, 'applications')), ['payments-api']);
  } finally { rmSync(ws.dir, { recursive: true, force: true }); }
});

test('hosts are derived from the clone URL; tokens in URLs are refused', () => {
  assert.equal(hostOf('git@github.com:acme/x.git'), 'github');
  assert.equal(hostOf('https://gitlab.com/acme/x.git'), 'gitlab');
  assert.equal(hostOf('https://dev.azure.com/acme/p/_git/x'), 'azure-devops');
  assert.equal(hostOf('ssh://git@bitbucket.org/acme/x.git'), 'bitbucket');
  assert.equal(hostOf('https://git.internal.example/x.git'), 'other');
  assert.match(urlProblem('https://x-access-token:abc@github.com/a/b.git'), /must not contain/);
  assert.match(urlProblem('https://user@bitbucket.org/a/b.git'), /must not contain/);
  assert.equal(urlProblem('ssh://git@bitbucket.org/a/b.git'), null);
  assert.equal(urlProblem('git@github.com:a/b.git'), null);
});
