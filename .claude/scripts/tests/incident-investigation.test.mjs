import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCaseAction, createCase } from '../incident-investigation/core.mjs';
import { DynamoDbInvestigationStore } from '../incident-investigation/dynamodb-store.mjs';
import { InvestigationService } from '../incident-investigation/service.mjs';

const now = Date.parse('2026-10-03T10:00:00.000Z');
const alert = (overrides = {}) => ({
  schemaVersion: '1', kind: 'maxwell.detection.alert', alertId: 'alert-01', companyId: 'example-co', scopeId: 'aws-prod',
  source: 'aws-cloudtrail', recipeId: 'authentication-failure-burst', recipeVersion: 1,
  title: 'Repeated authentication failures', priority: 'high', status: 'candidate', group: ['user-01'],
  detectedAt: '2026-10-03T09:59:59.000Z', windowStart: '2026-10-03T09:54:59.000Z', windowEnd: '2026-10-03T09:59:59.000Z',
  evidenceCount: 5, evidenceEventIds: ['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5'], evidenceTruncated: false, ...overrides,
});

class MemoryStore {
  constructor(state = new Map()) { this.state = state; this.activities = []; }
  async createCase(record) {
    const prior = this.state.get(record.caseId);
    if (prior) {
      if (prior.alertSignature !== record.alertSignature) throw new Error('alertId was reused with different content');
      return { created: false, case: prior };
    }
    this.state.set(record.caseId, structuredClone(record));
    return { created: true, case: record };
  }
  async getCase(_companyId, caseId) { return structuredClone(this.state.get(caseId) || null); }
  async saveChange(previous, next, action) {
    if (this.state.get(next.caseId).revision !== previous.revision) throw new Error('case revision conflict');
    this.state.set(next.caseId, structuredClone(next));
    this.activities.push(action);
    return next;
  }
}

test('candidate intake is idempotent and survives a service restart', async () => {
  const state = new Map();
  let service = new InvestigationService({ store: new MemoryStore(state), clock: () => now });
  const first = await service.intake(alert());
  assert.equal(first.created, true);
  service = new InvestigationService({ store: new MemoryStore(state), clock: () => now + 1000 });
  const replay = await service.intake(alert());
  assert.equal(replay.created, false);
  assert.equal(replay.case.caseId, first.case.caseId);
  assert.equal(replay.case.openedAt, '2026-10-03T10:00:00.000Z');
});

test('candidate intake rejects conflicting reuse of an alert id', async () => {
  const service = new InvestigationService({ store: new MemoryStore(), clock: () => now });
  await service.intake(alert());
  await assert.rejects(service.intake(alert({ title: 'Changed content' })), /reused with different content/);
});

test('confirmation preparation requires assignment and hashed evidence', () => {
  let current = createCase(alert(), now);
  const prepare = (record) => ({ type: 'prepare-confirmation', actor: 'analyst@example.com', expectedRevision: record.revision, incidentId: 'inc_01K6K6J9R0ABCDEFGHJKMNPQRS', category: 'unauthorised-access' });
  assert.throws(() => applyCaseAction(current, prepare(current), now + 1000), /assigned/);
  current = applyCaseAction(current, { type: 'assign', actor: 'lead@example.com', owner: 'analyst@example.com', expectedRevision: 1 }, now + 1000);
  assert.throws(() => applyCaseAction(current, prepare(current), now + 2000), /evidence/);
  current = applyCaseAction(current, { type: 'add-evidence', actor: 'analyst@example.com', expectedRevision: 2, ref: 'cloudtrail:event/evt-1', sha256: 'a'.repeat(64), description: 'Redacted authentication evidence' }, now + 2000);
  current = applyCaseAction(current, prepare(current), now + 3000);
  assert.equal(current.status, 'confirmation-pending');
  assert.equal(current.revision, 4);
});

test('terminal cases reject mutation and optimistic revisions reject stale analysts', () => {
  let current = createCase(alert(), now);
  current = applyCaseAction(current, { type: 'dismiss', actor: 'analyst@example.com', expectedRevision: 1, reason: 'Known authorized penetration test' }, now + 1000);
  assert.throws(() => applyCaseAction(current, { type: 'note', actor: 'analyst@example.com', expectedRevision: 2, text: 'late note' }, now + 2000), /false-positive/);
  assert.throws(() => applyCaseAction(current, { type: 'close', actor: 'analyst@example.com', expectedRevision: 1 }, now + 2000), /revision conflict/);
});

test('DynamoDB writes case/activity atomically and uses consistent reads', async () => {
  const calls = [];
  const record = createCase(alert(), now);
  const client = { send: async (command) => { calls.push(command); return command.constructor.name === 'GetCommand' ? { Item: { case: record } } : {}; } };
  const store = new DynamoDbInvestigationStore({ tableName: 'detections', documentClient: client });
  assert.equal((await store.createCase(record, now)).created, true);
  assert.equal(calls[0].input.ConditionExpression, 'attribute_not_exists(pk)');
  assert.deepEqual(await store.getCase('example-co', record.caseId), record);
  assert.equal(calls[1].input.ConsistentRead, true);
  const next = applyCaseAction(record, { type: 'start', actor: 'analyst@example.com', expectedRevision: 1 }, now + 1000);
  await store.saveChange(record, next, { type: 'start', actor: 'analyst@example.com' }, now + 1000);
  const transaction = calls[2].input.TransactItems;
  assert.equal(transaction.length, 2);
  assert.equal(transaction[0].Put.ConditionExpression, 'revision = :previous');
  assert.equal(transaction[1].Put.Item.entityType, 'investigation-activity');
});
