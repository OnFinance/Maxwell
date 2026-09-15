import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-prompt-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  symlinkSync(join(WORKSPACE, '.claude/schemas'), join(dir, '.claude/schemas'));
  mkdirSync(join(dir, 'kpis/data/raw/sessions/claude-code'), { recursive: true });
  return dir;
}
const SID = '0f0e0d0c-0b0a-4908-8706-050403020101';
const metaPath = (dir) => join(dir, 'kpis/data/raw/sessions/claude-code', `${SID}.meta.json`);
const seed = (dir, workflow) => writeFileSync(metaPath(dir), JSON.stringify({ sessionId: SID, workflow, args: { appIds: [], envIds: [], dryRun: false } }));
const prompt = (dir, text, env = {}) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/hooks/user-prompt.mjs')], {
  cwd: dir, input: JSON.stringify({ session_id: SID, cwd: dir, prompt: text }), encoding: 'utf8',
  env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: dir, MAXWELL_HARNESS: 'claude-code', ...env },
});
const workflowOf = (dir) => JSON.parse(readFileSync(metaPath(dir), 'utf8')).workflow;

test('a background workflow notification that quotes other commands does not relabel the session', () => {
  const dir = workspace();
  try {
    seed(dir, 'report-audit-improvements');
    assert.equal(prompt(dir, '<task-notification>\n<task-id>w1</task-id>\n<result>see /kpis and /connect-sandbox for details</result>\n</task-notification>').status, 0);
    assert.equal(workflowOf(dir), 'report-audit-improvements');
    assert.equal(prompt(dir, 'Now also run /kpis example-co').status, 0);
    assert.equal(workflowOf(dir), 'report-audit-improvements', 'a session keeps the first real workflow it was given');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an interactive invocation labels a manual session, and the headless runner name wins', () => {
  const dir = workspace();
  try {
    seed(dir, 'manual');
    assert.equal(prompt(dir, '/probe-iac example-co --app=mcp-gateway').status, 0);
    assert.equal(workflowOf(dir), 'probe-iac');
    seed(dir, 'manual');
    prompt(dir, 'Run /probe-schemas with exactly this args object: {"companyId":"example-co"} (see /connect-sandbox)', { MAXWELL_WORKFLOW: 'probe-schemas' });
    assert.equal(workflowOf(dir), 'probe-schemas');
    seed(dir, 'manual');
    prompt(dir, 'Please look at /connect-sandbox first', { MAXWELL_WORKFLOW: 'probe-schemas' });
    assert.equal(workflowOf(dir), 'manual', 'a mention that is not the runner workflow is ignored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
