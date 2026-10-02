import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableDetectionEngine } from '../threat-detection/durable-engine.mjs';
import { processMessages, pollOnce } from '../threat-detection/cloudtrail-sqs-run.mjs';
import { DynamoDbDetectionStore } from '../threat-detection/dynamodb-store.mjs';

const base = Date.parse('2026-10-03T10:00:00.000Z');
const event = (n, overrides = {}) => ({
  schemaVersion: '1', eventId: `evt-${n}`, companyId: 'example-co', scopeId: 'aws-prod', source: 'aws-cloudtrail',
  eventTime: new Date(base + n * 1000).toISOString(), type: 'authentication', outcome: 'failure',
  actorKey: 'actor-01', sourceKey: 'source-01', ...overrides,
});

class MemoryStore {
  constructor() { this.events = new Map(); this.alerts = new Map(); }
  async saveEvent({ scopeKey, event: value, time, signature }) {
    const id = `${scopeKey}:${value.eventId}`;
    const previous = this.events.get(id);
    if (previous) {
      if (previous.signature !== signature) throw new Error('eventId was reused with different content');
      return { created: false };
    }
    this.events.set(id, { scopeKey, event: value, time, signature });
    return { created: true };
  }
  async queryEvents({ scopeKey, from, to }) {
    return [...this.events.values()].filter((item) => item.scopeKey === scopeKey && item.time >= from && item.time <= to);
  }
  async saveAlert({ alert }) {
    if (this.alerts.has(alert.alertId)) return false;
    this.alerts.set(alert.alertId, alert);
    return true;
  }
}

test('durable state correlates across worker restarts and persists each alert once', async () => {
  const store = new MemoryStore();
  let detector = new DurableDetectionEngine({ companyId: 'example-co', store });
  for (let n = 1; n <= 4; n++) assert.deepEqual(await detector.push(event(n), base + 30000), []);
  detector = new DurableDetectionEngine({ companyId: 'example-co', store });
  assert.deepEqual((await detector.push(event(5), base + 30000)).map((item) => item.recipeId), ['authentication-failure-burst']);
  assert.deepEqual((await detector.push(event(6, { outcome: 'success' }), base + 30000)).map((item) => item.recipeId), ['failure-then-success']);
  assert.equal(store.alerts.size, 2);
  assert.deepEqual(await detector.push(event(6, { outcome: 'success' }), base + 30000), []);
  assert.equal(detector.stats.duplicates, 1);
});

test('durable state rejects conflicting reuse and correlates a late arrival', async () => {
  const store = new MemoryStore();
  const detector = new DurableDetectionEngine({ companyId: 'example-co', store });
  for (let n = 1; n <= 4; n++) await detector.push(event(n), base + 30000);
  await detector.push(event(6, { outcome: 'success' }), base + 30000);
  const alerts = await detector.push(event(5), base + 30000);
  assert.ok(alerts.some((item) => item.recipeId === 'failure-then-success'));
  await assert.rejects(detector.push(event(5, { actorKey: 'other-actor' }), base + 30000), /reused with different content/);
});

test('message processing acknowledges successful and ignored events but retains failures', async () => {
  const alerts = [];
  const errors = [];
  const relevant = { detail: {
    eventID: 'aws-1', eventTime: new Date(base).toISOString(), eventSource: 'cloudtrail.amazonaws.com', eventName: 'StopLogging',
    awsRegion: 'ap-south-1', recipientAccountId: '123456789012', userIdentity: { principalId: 'admin' }, requestParameters: { name: 'main' },
  } };
  const messages = [
    { MessageId: 'good', ReceiptHandle: 'r1', Body: JSON.stringify(relevant) },
    { MessageId: 'ignored', ReceiptHandle: 'r2', Body: JSON.stringify({ detail: { eventSource: 's3.amazonaws.com', eventName: 'GetObject' } }) },
    { MessageId: 'bad', ReceiptHandle: 'r3', Body: '{bad', Attributes: { ApproximateReceiveCount: '2' } },
  ];
  const detector = { push: async () => [{ alertId: 'alert-1' }] };
  const result = await processMessages({ messages, companyId: 'example-co', detector, onAlert: async (value) => alerts.push(value), onError: async (value) => errors.push(value) });
  assert.deepEqual(result.acknowledged.map((item) => item.Id), ['good', 'ignored']);
  assert.deepEqual(result.stats, { received: 3, ignored: 1, processed: 1, alerts: 1, failed: 1 });
  assert.equal(alerts.length, 1);
  assert.deepEqual({ messageId: errors[0].messageId, receiveCount: errors[0].receiveCount }, { messageId: 'bad', receiveCount: '2' });
  assert.ok(!JSON.stringify(errors).includes('{bad'));
});

test('one poll long-polls and deletes only acknowledged messages', async () => {
  const calls = [];
  const sqs = { send: async (command) => {
    calls.push(command);
    if (command.constructor.name === 'ReceiveMessageCommand') return { Messages: [{ MessageId: 'ignored', ReceiptHandle: 'receipt', Body: JSON.stringify({ detail: { eventSource: 's3.amazonaws.com', eventName: 'GetObject' } }) }] };
    return { Successful: [{ Id: 'ignored' }] };
  } };
  const stats = await pollOnce({ sqs, queueUrl: 'https://sqs.example/queue', companyId: 'example-co', detector: { push: async () => [] }, onError: async () => {} });
  assert.equal(calls[0].input.WaitTimeSeconds, 20);
  assert.equal(calls[0].input.VisibilityTimeout, 120);
  assert.deepEqual(calls[1].input.Entries.map((item) => item.Id), ['ignored']);
  assert.equal(stats.ignored, 1);
});

test('DynamoDB store writes event and dedupe marker atomically and pages strongly consistent queries', async () => {
  const calls = [];
  let page = 0;
  const documentClient = { send: async (command) => {
    calls.push(command);
    if (command.constructor.name === 'QueryCommand') {
      page++;
      return page === 1
        ? { Items: [{ event: event(1), time: base + 1000 }], LastEvaluatedKey: { pk: 'next', sk: 'next' } }
        : { Items: [{ event: event(2), time: base + 2000 }] };
    }
    return {};
  } };
  const store = new DynamoDbDetectionStore({ tableName: 'detections', documentClient });
  assert.deepEqual(await store.saveEvent({ scopeKey: 'scope', event: event(1), time: base + 1000, signature: 'sig', now: base + 30000 }), { created: true });
  const transaction = calls[0].input.TransactItems;
  assert.equal(transaction.length, 2);
  assert.equal(transaction[0].Put.Item.sk, 'DEDUPE#evt-1');
  assert.match(transaction[1].Put.Item.sk, /^EVENT#\d{13}#evt-1$/);
  const records = await store.queryEvents({ scopeKey: 'scope', from: base, to: base + 3000 });
  assert.equal(records.length, 2);
  const queries = calls.filter((command) => command.constructor.name === 'QueryCommand');
  assert.ok(queries.every((command) => command.input.ConsistentRead));
  assert.deepEqual(queries[1].input.ExclusiveStartKey, { pk: 'next', sk: 'next' });
});

test('DynamoDB store distinguishes an idempotent replay from conflicting event content', async () => {
  const transactionError = Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' });
  const documentClient = { send: async (command) => {
    if (command.constructor.name === 'TransactWriteCommand') throw transactionError;
    return { Item: { signature: 'original' } };
  } };
  const store = new DynamoDbDetectionStore({ tableName: 'detections', documentClient });
  assert.deepEqual(await store.saveEvent({ scopeKey: 'scope', event: event(1), time: base, signature: 'original', now: base }), { created: false });
  await assert.rejects(store.saveEvent({ scopeKey: 'scope', event: event(1), time: base, signature: 'changed', now: base }), /reused with different content/);
});
