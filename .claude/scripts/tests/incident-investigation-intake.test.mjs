import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAlertMessage, pollOnce, processMessages } from '../incident-investigation/alert-sqs-run.mjs';

const attribute = (value) => {
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  return { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, attribute(item)])) };
};
const alert = {
  schemaVersion: '1', kind: 'maxwell.detection.alert', alertId: 'alert-01', companyId: 'example-co', scopeId: 'aws-prod',
  source: 'aws-cloudtrail', recipeId: 'authentication-failure-burst', recipeVersion: 1, title: 'Repeated failures',
  priority: 'high', status: 'candidate', group: ['user-01'], detectedAt: '2026-10-03T09:59:59.000Z',
  windowStart: '2026-10-03T09:54:59.000Z', windowEnd: '2026-10-03T09:59:59.000Z', evidenceCount: 5,
  evidenceEventIds: ['evt-1'], evidenceTruncated: true,
};
const body = (value = alert) => JSON.stringify({ eventName: 'INSERT', dynamodb: { NewImage: { entityType: { S: 'alert' }, alert: attribute(value) } } });

test('DynamoDB stream alert is decoded without accepting another company', () => {
  assert.deepEqual(parseAlertMessage(body(), 'example-co'), alert);
  assert.throws(() => parseAlertMessage(body({ ...alert, companyId: 'other-co' }), 'example-co'), /does not match/);
  assert.equal(parseAlertMessage(JSON.stringify({ eventName: 'MODIFY', dynamodb: { NewImage: {} } }), 'example-co'), null);
});

test('intake acknowledges successful, duplicate, and irrelevant records while retaining poison messages', async () => {
  const seen = [];
  const errors = [];
  let count = 0;
  const service = { intake: async () => ({ created: count++ === 0, case: { caseId: 'case-01', companyId: 'example-co', status: 'open' } }) };
  const messages = [
    { MessageId: 'created', ReceiptHandle: 'r1', Body: body() },
    { MessageId: 'duplicate', ReceiptHandle: 'r2', Body: body() },
    { MessageId: 'ignored', ReceiptHandle: 'r3', Body: JSON.stringify({ eventName: 'MODIFY' }) },
    { MessageId: 'poison', ReceiptHandle: 'r4', Body: '{bad', Attributes: { ApproximateReceiveCount: '3' } },
  ];
  const result = await processMessages({ messages, companyId: 'example-co', service, onCase: async (value) => seen.push(value), onError: async (value) => errors.push(value) });
  assert.deepEqual(result.acknowledged.map((item) => item.Id), ['created', 'duplicate', 'ignored']);
  assert.deepEqual(result.stats, { received: 4, ignored: 1, created: 1, duplicates: 1, failed: 1 });
  assert.equal(seen.length, 2);
  assert.deepEqual({ messageId: errors[0].messageId, receiveCount: errors[0].receiveCount }, { messageId: 'poison', receiveCount: '3' });
  assert.ok(!JSON.stringify(errors).includes('{bad'));
});

test('poll deletes only acknowledged alert records', async () => {
  const calls = [];
  const sqs = { send: async (command) => {
    calls.push(command);
    if (command.constructor.name === 'ReceiveMessageCommand') return { Messages: [
      { MessageId: 'good', ReceiptHandle: 'r1', Body: body() },
      { MessageId: 'bad', ReceiptHandle: 'r2', Body: '{bad' },
    ] };
    return { Successful: [{ Id: 'good' }] };
  } };
  const stats = await pollOnce({ sqs, queueUrl: 'https://sqs.example/alerts', companyId: 'example-co', service: { intake: async () => ({ created: true, case: { caseId: 'case-01', companyId: 'example-co', status: 'open' } }) }, onCase: async () => {}, onError: async () => {} });
  assert.equal(calls[0].input.WaitTimeSeconds, 20);
  assert.deepEqual(calls[1].input.Entries, [{ Id: 'good', ReceiptHandle: 'r1' }]);
  assert.equal(stats.failed, 1);
});
