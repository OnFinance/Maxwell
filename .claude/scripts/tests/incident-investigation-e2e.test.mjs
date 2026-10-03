import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecords } from '../lib/ledger.mjs';
import { processMessages } from '../incident-investigation/alert-sqs-run.mjs';
import { ConfirmationCoordinator } from '../incident-investigation/confirmation.mjs';
import { InvestigationService } from '../incident-investigation/service.mjs';

const now = Date.parse('2026-10-03T10:00:00.000Z');
const attribute = (value) => {
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  return { M: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, attribute(item)])) };
};
const alert = {
  schemaVersion: '1', kind: 'maxwell.detection.alert', alertId: 'alert-e2e', companyId: 'example-co', scopeId: 'aws-prod',
  source: 'aws-cloudtrail', recipeId: 'failure-then-success', recipeVersion: 1, title: 'Successful authentication after repeated failures',
  priority: 'high', status: 'candidate', group: ['user-01', 'source-01'], detectedAt: '2026-10-03T09:59:59.000Z',
  windowStart: '2026-10-03T09:54:59.000Z', windowEnd: '2026-10-03T09:59:58.000Z', evidenceCount: 6,
  evidenceEventIds: ['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6'], evidenceTruncated: false,
};

class MemoryStore {
  constructor() { this.cases = new Map(); }
  async createCase(record) {
    if (this.cases.has(record.caseId)) return { created: false, case: this.cases.get(record.caseId) };
    this.cases.set(record.caseId, structuredClone(record));
    return { created: true, case: record };
  }
  async getCase(_company, id) { return structuredClone(this.cases.get(id) || null); }
  async saveChange(previous, next) {
    if (this.cases.get(next.caseId).revision !== previous.revision) throw new Error('case revision conflict');
    this.cases.set(next.caseId, structuredClone(next));
    return next;
  }
}

test('alert queue to analyst confirmation produces one valid ledger incident and OCSF 2005 event', async () => {
  const store = new MemoryStore();
  let tick = now;
  const service = new InvestigationService({ store, clock: () => tick++ });
  const body = JSON.stringify({ eventName: 'INSERT', dynamodb: { NewImage: { entityType: { S: 'alert' }, alert: attribute(alert) } } });
  const intake = await processMessages({ messages: [{ MessageId: 'm1', ReceiptHandle: 'r1', Body: body }], companyId: 'example-co', service, onCase: async () => {}, onError: async () => {} });
  assert.equal(intake.stats.created, 1);
  const [record] = [...store.cases.values()];
  await service.act('example-co', record.caseId, { type: 'assign', actor: 'lead@example.com', owner: 'analyst@example.com', expectedRevision: 1 });
  await service.act('example-co', record.caseId, { type: 'add-evidence', actor: 'analyst@example.com', expectedRevision: 2, ref: 'cloudtrail:event/evt-6', sha256: 'b'.repeat(64), description: 'Redacted successful login following failures' });

  const root = mkdtempSync(join(tmpdir(), 'maxwell-investigation-'));
  const writer = { append: (incident) => {
    const result = appendRecords(incident.companyId, [incident], { root });
    if (result.problems.length) throw new Error(result.problems.join('\n'));
    return { appended: result.appended === 1 };
  } };
  const coordinator = new ConfirmationCoordinator({
    store, writer, clock: () => tick++,
    companyDetails: { frameworksInScope: ['cert-in-directions-2022', 'sebi-cscrf-2024', 'rbi-cyber-tech-directions-2026', 'dpdp-rules-2025'] },
    slaTable: { entries: [
      { instrument: 'cert-in-directions-2022', topic: 'incident-reporting', severity: 'any', hours: 6 },
      { instrument: 'sebi-cscrf-2024', topic: 'incident-reporting', severity: 'any', hours: 6 },
      { instrument: 'rbi-cyber-tech-directions-2026', topic: 'incident-reporting', severity: 'any', hours: 6 },
      { instrument: 'dpdp-rules-2025', topic: 'breach-notification', severity: 'any', hours: 72 },
    ] },
  });
  const result = await coordinator.confirm('example-co', record.caseId, { actor: 'analyst@example.com', expectedRevision: 3, category: 'unauthorised-access', affectedDataClassifications: ['pii'] });
  assert.equal(result.case.status, 'confirmed');
  assert.match(result.incident.id, /^inc_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.deepEqual(result.incident.regulatorReportRefs.map((item) => [item.regulator, item.deadlineHours]), [['CERT-In', 6], ['SEBI', 6], ['RBI', 6], ['MeitY', 72]]);
  assert.equal(result.ocsf.class_uid, 2005);
  assert.equal(result.ocsf.verdict_id, 2);
  const lines = readFileSync(join(root, 'company-profile/example-co/soc/main.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, result.incident.id);
  const replay = await coordinator.confirm('example-co', record.caseId, { actor: 'analyst@example.com', expectedRevision: 3, category: 'unauthorised-access', affectedDataClassifications: ['pii'] });
  assert.equal(replay.appended, false);
  assert.equal(readFileSync(join(root, 'company-profile/example-co/soc/main.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('failed ledger publication leaves a recoverable pending confirmation', async () => {
  const store = new MemoryStore();
  const service = new InvestigationService({ store, clock: () => now });
  const created = await service.intake(alert);
  await service.act('example-co', created.case.caseId, { type: 'assign', actor: 'lead@example.com', owner: 'analyst@example.com', expectedRevision: 1 });
  await service.act('example-co', created.case.caseId, { type: 'add-evidence', actor: 'analyst@example.com', expectedRevision: 2, ref: 'cloudtrail:event/evt-6', sha256: 'c'.repeat(64), description: 'Redacted evidence' });
  const coordinator = new ConfirmationCoordinator({ store, writer: { append: () => { throw new Error('ledger unavailable'); } }, clock: () => now + 1000, companyDetails: { frameworksInScope: [] }, slaTable: { entries: [] } });
  await assert.rejects(coordinator.confirm('example-co', created.case.caseId, { actor: 'analyst@example.com', expectedRevision: 3, category: 'unauthorised-access' }), /ledger unavailable/);
  assert.equal((await store.getCase('example-co', created.case.caseId)).status, 'confirmation-pending');
});
