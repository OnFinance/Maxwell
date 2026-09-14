import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowStatusFromTranscript } from '../lib/workflow-status.mjs';

const launch = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow', input: { name: 'probe-iac', args: '{}' } }] } });
const notif = (status, summary) => JSON.stringify({ type: 'user', message: { content: `<task-notification>\n<task-id>w1</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } });

test('a workflow that returned is completed', () => {
  const r = workflowStatusFromTranscript([launch, notif('completed', 'Dynamic workflow "Probe IaC" completed')]);
  assert.deepEqual(r, { launched: true, workflowName: 'probe-iac', status: 'completed' });
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
