import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';

// A session whose only assistant record is Claude Code's synthetic API-error message (credentials the harness could
// not read, a model the provider has not enabled): no inference ran, so no model was used.
const SID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const transcript = [
  { type: 'user', uuid: 'u1', timestamp: '2026-09-13T17:49:00.000Z', version: '2.1.270', message: { role: 'user', content: 'Run /probe-iac' } },
  { type: 'assistant', uuid: 'u2', timestamp: '2026-09-13T17:49:05.000Z', version: '2.1.270', isApiErrorMessage: true, error: 'cloud_credential_error', message: { id: 'syn', model: '<synthetic>', role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: 'API Error: Could not load cloud credentials.' }] } },
].map((r) => JSON.stringify(r)).join('\n');

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-ingest-failed-'));
  mkdirSync(join(dir, 'kpis'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  copyFileSync(join(WORKSPACE, 'kpis/metrics.json'), join(dir, 'kpis/metrics.json'));
  symlinkSync(join(WORKSPACE, '.claude/schemas'), join(dir, '.claude/schemas'));
  symlinkSync(join(WORKSPACE, '.claude/skills'), join(dir, '.claude/skills'));
  writeFileSync(join(dir, 'session.jsonl'), transcript);
  return dir;
}

const ingest = (dir, extra = []) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/sessions/ingest.mjs'), '--harness', 'claude-code', '--session', SID, '--transcript', join(dir, 'session.jsonl'), '--force', ...extra], {
  cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude'), MAXWELL_RUN_ID: 'run_01M2GDZ3Q3S5WYCB3MV02QJXZ1', MAXWELL_MODEL: 'opus', MAXWELL_WORKFLOW: 'probe-iac' },
});

test('a session that failed on an API error gets a valid summary next to its meta', () => {
  const dir = workspace();
  try {
    const r = ingest(dir, ['--outcome', 'error', '--reported', '0']);
    assert.equal(r.status, 0, r.stderr);
    const base = join(dir, 'kpis/data/raw/sessions/claude-code', SID);
    const summary = JSON.parse(readFileSync(`${base}.summary.json`, 'utf8'));
    const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'));
    assert.equal(summary.outcome, 'error');
    assert.equal(summary.models.length, 1);
    assert.notEqual(summary.models[0].model, '<synthetic>');
    assert.equal(summary.inferenceCalls, 0);
    assert.equal(meta.sampled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an ingest whose summary would be invalid writes neither the summary nor a sampled meta', () => {
  const dir = workspace();
  try {
    const r = ingest(dir, ['--outcome', 'not-an-outcome']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /summary invalid/);
    const base = join(dir, 'kpis/data/raw/sessions/claude-code', SID);
    assert.equal(existsSync(`${base}.summary.json`), false);
    assert.equal(existsSync(`${base}.meta.json`), false);
    assert.equal(existsSync(`${base}.jsonl`), false, 'no orphan transcript copy');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without --outcome (the SessionEnd hook), a session that only hit API errors is recorded as an error', () => {
  const dir = workspace();
  try {
    const r = ingest(dir);
    assert.equal(r.status, 0, r.stderr);
    const base = join(dir, 'kpis/data/raw/sessions/claude-code', SID);
    const summary = JSON.parse(readFileSync(`${base}.summary.json`, 'utf8'));
    assert.equal(summary.outcome, 'error');
    assert.equal(summary.turns, 0);
    assert.equal(existsSync(`${base}.jsonl`), true, 'the transcript is copied once the summary is valid');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
