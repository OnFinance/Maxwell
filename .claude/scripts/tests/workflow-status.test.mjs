import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_LIMIT, agentFailures, parseLimitReset, workflowStatusFromTranscript } from '../lib/workflow-status.mjs';

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
