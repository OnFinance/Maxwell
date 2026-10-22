import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';

// A stand-in `claude` that answers like `claude -p --output-format json` after a session that launched a workflow,
// spent its budget and ended while the workflow still ran in the background. No model is called.
function fakeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-headless-'));
  mkdirSync(join(dir, 'kpis'), { recursive: true });
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  copyFileSync(join(WORKSPACE, 'kpis/metrics.json'), join(dir, 'kpis/metrics.json'));
  for (const d of ['schemas', 'skills']) symlinkSync(join(WORKSPACE, '.claude', d), join(dir, '.claude', d));
  const sid = '2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d';
  const projects = join(dir, 'claude', 'projects', '-work');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: '2026-09-13T17:49:05.000Z', message: { id: 'm1', model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Workflow', input: { name: 'probe-iac' } }], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
  const out = { type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 7.07, num_turns: 2, result: 'The workflow is now running in the background.' };
  writeFileSync(join(dir, 'bin', 'claude'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(out)}'\n`);
  chmodSync(join(dir, 'bin', 'claude'), 0o755);
  return dir;
}

test('a headless run whose budget ran out while the workflow ran in the background reports max-budget and why', () => {
  const dir = fakeWorkspace();
  try {
    const r = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/run-headless.mjs'), '--workflow', 'probe-iac', '--company', 'example-co', '--budget-usd', '7'], {
      cwd: dir, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude') },
    });
    assert.equal(r.status, 1, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.workflow, 'probe-iac', 'the existing workflow field keeps its meaning');
    assert.equal(res.outcome, 'max-budget');
    assert.deepEqual(res.workflowRun, { name: 'probe-iac', launched: true, status: null, failedAgents: 0 });
    assert.match(res.outcomeReason, /budget of 7 USD was reached/);
    assert.equal(res.reportedCostUsd, 7.07);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
