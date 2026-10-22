import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, checkResultPath, ledgerAppended, ledgerState, runValidation, summarizeLedger, workspaceSnapshot, writeResultFile } from '../lib/run-result.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

const git = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-result-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'company-profile/acme/soc'), { recursive: true });
  writeFileSync(join(dir, 'company-profile/acme/summary.md'), 'v1\n');
  writeFileSync(join(dir, 'company-profile/acme/details.json'), '{}\n');
  writeFileSync(join(dir, 'company-profile/acme/soc/main.jsonl'), `${JSON.stringify({ kind: 'control', id: 'ctl-1' })}\n`);
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

test('changed files are the ones whose state moved during the run; session files are listed apart', () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, 'company-profile/acme/details.json'), '{"dirty":"before the run"}\n');
    const before = workspaceSnapshot(dir);
    writeFileSync(join(dir, 'company-profile/acme/summary.md'), 'v2\n');
    writeFileSync(join(dir, 'company-profile/acme/details.json'), '{"dirty":"and changed again by the run"}\n');
    mkdirSync(join(dir, 'kpis/data/raw/sessions/claude-code'), { recursive: true });
    writeFileSync(join(dir, 'kpis/data/raw/sessions/claude-code/s1.meta.json'), '{}');
    const { files, sessionFiles } = changedFiles(before, workspaceSnapshot(dir));
    assert.deepEqual(files, ['company-profile/acme/details.json', 'company-profile/acme/summary.md']);
    assert.deepEqual(sessionFiles, ['kpis/data/raw/sessions/claude-code/s1.meta.json']);
    assert.deepEqual(changedFiles(null, new Map()), { files: null, sessionFiles: null });
    const outside = mkdtempSync(join(tmpdir(), 'maxwell-nogit-'));
    assert.equal(workspaceSnapshot(outside), null);
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appended ledger records are counted by kind and new findings are listed without their evidence', () => {
  const dir = repo();
  try {
    const ledger = join(dir, 'company-profile/acme/soc/main.jsonl');
    const before = ledgerState(ledger);
    const finding = { kind: 'finding', id: 'fnd_1', title: 'unpinned base image', severity: 'high', status: 'open', fingerprint: 'abc', firstSeenAt: '2026-09-14T00:00:00Z', lastSeenAt: '2026-09-14T00:00:00Z', description: 'long text', evidence: [{ excerpt: 'token=hunter2' }] };
    appendFileSync(ledger, [{ kind: 'observation', id: 'obs_1' }, { kind: 'observation', id: 'obs_2' }, finding].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { ledger: l, findings } = summarizeLedger(ledgerAppended(ledger, before).text);
    assert.deepEqual(l, { appended: 3, byKind: { observation: 2, finding: 1 }, ids: ['obs_1', 'obs_2', 'fnd_1'], unparsable: 0 });
    assert.deepEqual(findings, [{ id: 'fnd_1', title: 'unpinned base image', severity: 'high', status: 'open', fingerprint: 'abc', firstSeenAt: '2026-09-14T00:00:00Z', lastSeenAt: '2026-09-14T00:00:00Z' }]);
    assert.doesNotMatch(JSON.stringify(findings), /hunter2|long text/);
    assert.deepEqual(ledgerAppended(join(dir, 'missing.jsonl'), ledgerState(join(dir, 'missing.jsonl'))), { text: '' });
    // A rewritten ledger (shrunk, or its first bytes changed) is reported as such, not parsed from a stale offset.
    const after = ledgerState(ledger);
    writeFileSync(ledger, `${JSON.stringify({ kind: 'control', id: 'ctl-X' })}\n`);
    assert.deepEqual(ledgerAppended(ledger, after), { rewritten: true });
    const same = ledgerState(ledger);
    writeFileSync(ledger, `${JSON.stringify({ kind: 'control', id: 'ctl-Y' })}\n${JSON.stringify({ kind: 'observation', id: 'obs_3' })}\n`);
    assert.deepEqual(ledgerAppended(ledger, same), { rewritten: true });
    assert.equal(summarizeLedger('not json\n').ledger.unparsable, 1);
    const keyShaped = ['sk', 'ant', 'y'.repeat(24)].join('-');
    const [titled] = summarizeLedger(JSON.stringify({ kind: 'finding', id: 'fnd_2', title: `leaked ${keyShaped}` })).findings;
    assert.equal(titled.title.includes(keyShaped), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the result file must be outside the workspace and is written whole', () => {
  const dir = repo();
  const out = mkdtempSync(join(tmpdir(), 'maxwell-out-'));
  try {
    assert.match(checkResultPath('result.json', dir), /outside the workspace/);
    assert.match(checkResultPath(join(dir, 'kpis/x.json'), dir), /outside the workspace/);
    assert.match(checkResultPath(join(out, 'nope/result.json'), dir), /does not exist/);
    assert.equal(checkResultPath(join(out, 'result.json'), dir), null);
    assert.equal(checkResultPath(undefined, dir), null);
    assert.match(checkResultPath('..result.json', dir), /outside the workspace/, 'a name starting with two dots is still inside');
    const link = join(out, 'into-workspace');
    symlinkSync(dir, link);
    assert.match(checkResultPath(join(link, 'result.json'), dir), /outside the workspace/, 'a symlinked parent is followed');
    assert.match(checkResultPath(join(link, 'kpis', 'deeper', 'r.json'), dir), /outside the workspace/);
    writeResultFile(join(out, 'result.json'), { outcome: 'success' }, dir);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'result.json'), 'utf8')), { outcome: 'success' });
    assert.deepEqual(readdirSync(out).filter((f) => f.endsWith('.tmp')), [], 'no temporary file is left');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('validation keeps the exit code and a redacted tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-validate-'));
  try {
    const fake = join(dir, 'npm');
    // Built at run time so this file holds no key-shaped string.
    const keyShaped = ['sk', 'ant', 'x'.repeat(24)].join('-');
    writeFileSync(fake, `#!/bin/sh\necho "strict mode: noise"\necho "validate:data FAILED x.json"\necho "token ${keyShaped}"\nexit 1\n`);
    chmodSync(fake, 0o755);
    const v = runValidation(dir, { npm: fake });
    assert.equal(v.ok, false);
    assert.equal(v.exitCode, 1);
    assert.match(v.tail, /validate:data FAILED/);
    assert.doesNotMatch(v.tail, /strict mode/);
    assert.equal(v.tail.includes(keyShaped), false);
    assert.match(v.tail, /\[REDACTED\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a headless run reports the files, ledger records and findings it produced and writes the result file', () => {
  const dir = repo();
  const out = mkdtempSync(join(tmpdir(), 'maxwell-out-'));
  try {
    mkdirSync(join(dir, 'kpis'), { recursive: true });
    mkdirSync(join(dir, '.claude'), { recursive: true });
    copyFileSync(join(WORKSPACE, 'kpis/metrics.json'), join(dir, 'kpis/metrics.json'));
    for (const d of ['schemas', 'skills']) symlinkSync(join(WORKSPACE, '.claude', d), join(dir, '.claude', d));
    writeFileSync(join(dir, '.gitignore'), '.claude/\nkpis/metrics.json\nbin/\n');
    git(dir, 'add', '.gitignore'); git(dir, 'commit', '-qm', 'ignore');
    // A stand-in `claude` that appends a finding and edits the summary as a workflow would, without any model call.
    const finding = JSON.stringify({ kind: 'finding', id: 'fnd_9', title: 't', severity: 'low', status: 'open', fingerprint: 'f9' });
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'claude'), `#!/bin/sh\nprintf '%s\\n' '${finding}' >> company-profile/acme/soc/main.jsonl\necho v3 > company-profile/acme/summary.md\nprintf '%s' '{"type":"result","subtype":"success","is_error":false,"session_id":"3c4d5e6f-7081-4a9b-8c0d-1e2f3a4b5c6d","total_cost_usd":0.5,"num_turns":1,"result":"ok"}'\n`);
    chmodSync(join(dir, 'bin', 'claude'), 0o755);
    const resultFile = join(out, 'result.json');
    const r = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/run-headless.mjs'), '--workflow', 'status', '--company', 'acme', '--result-file', resultFile], {
      cwd: dir, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude') },
    });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.deepEqual(res.files, ['company-profile/acme/soc/main.jsonl', 'company-profile/acme/summary.md']);
    assert.deepEqual(res.ledger, { appended: 1, byKind: { finding: 1 }, ids: ['fnd_9'], unparsable: 0 });
    assert.deepEqual(res.findings.map((f) => f.id), ['fnd_9']);
    assert.deepEqual(res.validation, { ran: false });
    assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), res);
    const refused = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/run-headless.mjs'), '--workflow', 'status', '--company', 'acme', '--result-file', 'result.json'], { cwd: dir, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir } });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /outside the workspace/);
    assert.equal(existsSync(join(dir, 'result.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('workspace paths are relative to a workspace that is a folder of a larger repository, and renames keep their origin', () => {
  const top = mkdtempSync(join(tmpdir(), 'maxwell-sub-'));
  try {
    git(top, 'init', '-q'); git(top, 'config', 'user.email', 't@example.invalid'); git(top, 'config', 'user.name', 't');
    mkdirSync(join(top, 'ws/company-profile/acme'), { recursive: true });
    writeFileSync(join(top, 'outside.txt'), 'x\n');
    writeFileSync(join(top, 'ws/company-profile/acme/a.md'), 'a\n');
    git(top, 'add', '.'); git(top, 'commit', '-qm', 'base');
    const root = join(top, 'ws');
    const before = workspaceSnapshot(root);
    writeFileSync(join(top, 'outside.txt'), 'changed outside the workspace\n');
    git(top, 'mv', 'ws/company-profile/acme/a.md', 'ws/company-profile/acme/b.md');
    const { files } = changedFiles(before, workspaceSnapshot(root));
    assert.deepEqual(files, ['company-profile/acme/a.md', 'company-profile/acme/b.md']);
  } finally { rmSync(top, { recursive: true, force: true }); }
});
