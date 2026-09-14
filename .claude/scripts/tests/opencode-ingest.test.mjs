import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { loadPricing, providerOf } from '../lib/pricing.mjs';
import { opencodeSessionLog } from '../lib/workflow-status.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

test('session summaries name a gen_ai provider the schema accepts', () => {
  const pricing = loadPricing();
  assert.equal(providerOf(pricing, 'claude-opus-5[1m]'), 'anthropic');
  assert.equal(providerOf(pricing, 'anthropic/claude-sonnet-5'), 'anthropic');
  assert.equal(providerOf(pricing, 'cloudflare-workers-ai/@cf/zai-org/glm-5.3'), 'other', 'priced GLM keeps its pricing provider');
  assert.equal(providerOf(pricing, 'openai/gpt-unpriced-test'), 'openai', 'a well-known OpenCode provider prefix is kept');
  assert.equal(providerOf(pricing, 'some-new-host/model-x'), 'other', 'an unknown provider prefix becomes other');
});

test('headless OpenCode sessions record the workflow and company that run-workflow.mjs names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-meta-'));
  try {
    const start = (sessionId, extra) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/hooks/session-start.mjs')], {
      cwd: dir, input: JSON.stringify({ session_id: sessionId, cwd: dir }), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: dir, MAXWELL_HARNESS: 'opencode', MAXWELL_RUN_ID: 'run_01M2GDZ3Q3S5WYCB3MV02QJXZ1', ...extra },
    });
    const meta = (sessionId) => JSON.parse(readFileSync(join(dir, 'kpis/data/raw/sessions/opencode', `${sessionId}.meta.json`), 'utf8'));
    assert.equal(start('ses_labelled', { MAXWELL_WORKFLOW: 'refresh-soc', MAXWELL_COMPANY_ID: 'example-co' }).status, 0);
    assert.equal(meta('ses_labelled').workflow, 'refresh-soc', 'refresh sessions stay out of the audit KPIs');
    assert.equal(meta('ses_labelled').companyId, 'example-co');
    assert.equal(start('ses_forged', { MAXWELL_WORKFLOW: 'not-a-workflow', MAXWELL_COMPANY_ID: '../other' }).status, 0);
    assert.equal(meta('ses_forged').workflow, 'manual');
    assert.equal(meta('ses_forged').companyId, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the OpenCode session log lives outside the workspace', () => {
  const rel = relative(WORKSPACE, opencodeSessionLog({ HOME: '/home/someone' }));
  assert.ok(rel.startsWith('..') || isAbsolute(rel));
  assert.equal(opencodeSessionLog({ MAXWELL_OPENCODE_SESSION_LOG: '/var/tmp/sessions.log' }), '/var/tmp/sessions.log');
});
