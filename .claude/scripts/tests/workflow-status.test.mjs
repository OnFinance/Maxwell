import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_LIMIT, agentFailures, classifyWorkflowRun, parseLimitReset, workflowStatusFromTranscript } from '../lib/workflow-status.mjs';

const launch = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow', input: { name: 'probe-iac', args: '{}' } }] } });
const notif = (status, summary) => JSON.stringify({ type: 'user', message: { content: `<task-notification>\n<task-id>w1</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } });

test('a workflow that returned is completed', () => {
  const r = workflowStatusFromTranscript([launch, notif('completed', 'Dynamic workflow "Probe IaC" completed')]);
  assert.deepEqual(r, { launched: true, workflowName: 'probe-iac', status: 'completed', outputFile: null });
});

test('a workflow cut off by the -p idle ceiling has no completion', () => {
  const r = workflowStatusFromTranscript([launch, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'It is running in the background' }] } })]);
  assert.equal(r.launched, true);
  assert.equal(r.status, null);
});

test('non-workflow task notifications are ignored', () => {
  const r = workflowStatusFromTranscript([launch, notif('completed', 'Background command "npm test" completed')]);
  assert.equal(r.status, null);
});

test('no Workflow call means not launched', () => {
  assert.equal(workflowStatusFromTranscript([notif('completed', 'Dynamic workflow "x" completed')]).launched, false);
});

test('the workflow output file is taken from its notification', () => {
  const withOutput = JSON.stringify({ type: 'user', message: { content: '<task-notification>\n<task-id>w1</task-id>\n<output-file>/tmp/p/s/tasks/w1.output</output-file>\n<status>completed</status>\n<summary>Dynamic workflow "Probe schemas" completed</summary>\n</task-notification>' } });
  assert.equal(workflowStatusFromTranscript([launch, withOutput]).outputFile, '/tmp/p/s/tasks/w1.output');
});

test('agents that failed on an account limit are counted from the workflow output', () => {
  const limit = "You've hit your session limit · resets 1:10pm (UTC)";
  const output = JSON.stringify({ result: { findings: 0 }, agents: [{ type: 'workflow_agent', label: 'probe db-models', state: 'done' }, { type: 'workflow_agent', label: 'write db-models', state: 'error', error: limit }] });
  const f = agentFailures(output);
  assert.equal(f.failedAgents, 1);
  assert.equal(f.errors[0].label, 'write db-models');
  assert.match(f.errors[0].error, ACCOUNT_LIMIT);
  assert.equal(agentFailures('{"agents": [{"state": "error", "label": "x", "error": "boom"}').failedAgents, 1);
  assert.equal(agentFailures(JSON.stringify({ agents: [{ type: 'workflow_agent', state: 'done' }] })).failedAgents, 0);
});

test('limit reset times resolve to the next occurrence; model limits are not account limits', () => {
  const now = new Date('2026-09-14T12:13:00Z');
  assert.equal(parseLimitReset("You've hit your session limit · resets 1:10pm (UTC)", now).toISOString(), '2026-09-14T13:10:00.000Z');
  assert.equal(parseLimitReset('resets 9am (UTC)', now).toISOString(), '2026-09-15T09:00:00.000Z');
  assert.equal(parseLimitReset('resets 12:30am (UTC)', now).toISOString(), '2026-09-15T00:30:00.000Z');
  assert.equal(parseLimitReset('resets Sep 20, 12:30pm (UTC)', now).toISOString(), '2026-09-20T12:30:00.000Z');
  assert.equal(parseLimitReset('no reset time', now), null);
  assert.equal(ACCOUNT_LIMIT.test("You've reached your Fable limit"), false);
  assert.equal(ACCOUNT_LIMIT.test("You've hit your weekly limit · resets Sep 20, 12:30pm (UTC)"), true);
});

const ok = (cost, text = 'done') => ({ is_error: false, subtype: 'success', total_cost_usd: cost, result: text });
const wfOf = (launched, status, failedAgents = 0, errors = []) => ({ launched, status, failedAgents, errors });

test('a completed workflow with no failed agents is a success with no reason', () => {
  assert.deepEqual(classifyWorkflowRun({ result: ok(3), wf: wfOf(true, 'completed'), budgetUsd: '25' }), { outcome: 'success', finished: true, reason: null });
});

test('a session that spent its budget while the workflow ran in the background is max-budget, not success', () => {
  const r = classifyWorkflowRun({ result: ok(7.07, 'The workflow is now running in the background.'), wf: wfOf(true, null), budgetUsd: '7' });
  assert.equal(r.outcome, 'max-budget');
  assert.equal(r.finished, false);
  assert.match(r.reason, /budget of 7 USD was reached \(reported 7.07 USD\) while the workflow was still running in the background/);
  assert.doesNotMatch(r.reason, /now running/);
});

test('a dropped background workflow under budget is an error that says so', () => {
  const r = classifyWorkflowRun({ result: ok(2), wf: wfOf(true, null), budgetUsd: '25' });
  assert.equal(r.outcome, 'error');
  assert.match(r.reason, /still running in the background, so its result was dropped/);
  assert.equal(classifyWorkflowRun({ result: ok(2), wf: wfOf(true, null) }).outcome, 'error');
});

test('failed agents, other statuses and an unlaunched workflow are errors with their reason', () => {
  const failed = classifyWorkflowRun({ result: ok(1), wf: wfOf(true, 'completed', 1, [{ label: 'probe app-a', error: 'model not available' }]) });
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.reason, '1 agent failed (probe app-a)');
  assert.doesNotMatch(failed.reason, /model not available/);
  assert.equal(classifyWorkflowRun({ result: ok(1), wf: wfOf(true, 'killed') }).reason, 'the workflow ended with status killed');
  const apiError = { is_error: true, subtype: 'success', total_cost_usd: 0, result: 'API Error: could not load credentials' };
  const notLaunched = classifyWorkflowRun({ result: apiError, wf: wfOf(false, null), budgetUsd: '10' });
  assert.deepEqual([notLaunched.outcome, notLaunched.reason], ['error', 'the session failed before the workflow was launched (see result)']);
  assert.equal(classifyWorkflowRun({ result: ok(0.5), wf: null }).reason, 'the session ended without launching the workflow');
});

test('harness-reported limits keep their outcome; an account limit after completion still counts as success', () => {
  assert.equal(classifyWorkflowRun({ result: { is_error: true, subtype: 'error_max_turns', total_cost_usd: 1 }, wf: wfOf(true, null) }).outcome, 'max-turns');
  assert.equal(classifyWorkflowRun({ result: { is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 1 }, wf: wfOf(true, null) }).outcome, 'max-budget');
  const limitAfter = { is_error: true, subtype: 'success', total_cost_usd: 4, result: "You've hit your session limit · resets 1:10pm (UTC)" };
  assert.equal(classifyWorkflowRun({ result: limitAfter, wf: wfOf(true, 'completed') }).outcome, 'success');
  assert.equal(classifyWorkflowRun({ result: { is_error: true, subtype: 'error_max_turns' }, wf: wfOf(true, 'completed') }).outcome, 'max-turns');
});
