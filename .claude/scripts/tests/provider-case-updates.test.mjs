import test from 'node:test';
import assert from 'node:assert/strict';
import { InvestigationService } from '../incident-investigation/service.mjs';
import { createCase, applyProviderUpdate, applyCaseAction } from '../incident-investigation/core.mjs';
import { normalizeDefenderAlert } from '../threat-detection/microsoft-adapter.mjs';
import { DynamoDbInvestigationStore } from '../incident-investigation/dynamodb-store.mjs';
const tenantId = '11111111-2222-3333-4444-555555555555';
const time = Date.parse('2026-11-04T00:00:00.000Z');
function alert(version = 0, overrides = {}, companyId = 'example-co', tenant = tenantId) {
  return normalizeDefenderAlert({ id: 'provider-alert', tenantId: tenant, serviceSource: 'microsoftDefenderForEndpoint', title: `Version ${version}`, severity: 'high', createdDateTime: new Date(time).toISOString(), lastUpdateDateTime: new Date(time + version * 1000).toISOString(), ...overrides }, { companyId, tenantId: tenant });
}
function fixture() {
  const records = new Map(); const actions = [];
  const store = {
    getCase: async (company, id) => structuredClone(records.get(`${company}/${id}`) || null),
    createCase: async (record) => {
      const key = `${record.companyId}/${record.caseId}`; const old = records.get(key);
      if (old && old.alertSignature !== record.alertSignature) throw Error('alertId was reused with different content');
      if (!old) records.set(key, structuredClone(record));
      return { created: !old, case: structuredClone(old || record) };
    },
    saveChange: async (old, next, action) => {
      const key = `${old.companyId}/${old.caseId}`;
      if (records.get(key).revision !== old.revision) throw Error('case revision conflict');
      records.set(key, structuredClone(next)); actions.push(action); return next;
    },
  };
  return { store, records, actions, service: new InvestigationService({ store, clock: () => time + 10000 }) };
}

test('provider updates consolidate and replay/out-of-order deliveries cannot regress the case', async () => {
  const f = fixture(); const first = await f.service.intake(alert());
  await f.service.act('example-co', first.case.caseId, { type: 'note', actor: 'analyst', expectedRevision: 1, text: 'Keep my analysis' });
  const updated = await f.service.intake(alert(2));
  assert.equal(updated.case.caseId, first.case.caseId); assert.equal(f.records.size, 1);
  assert.equal(updated.case.revision, 3); assert.equal(updated.case.notes[0].text, 'Keep my analysis');
  assert.equal(updated.case.providerReviewRequired, true);
  assert.deepEqual(f.actions[1].previousAlert, alert());
  assert.deepEqual(f.actions[1].alert, alert(2));
  const restarted = new InvestigationService({ store: f.store });
  for (const input of [alert(2), alert(1)]) assert.equal((await restarted.intake(input)).case.revision, 3);
  await assert.rejects(restarted.intake(alert(2, { title: 'Conflicting same revision' })), /reused with different content/);
});

test('concurrent first deliveries and updates converge without losing analyst changes', async () => {
  const f = fixture();
  await Promise.all([f.service.intake(alert()), f.service.intake(alert(1)), f.service.intake(alert(2))]);
  const current = [...f.records.values()][0];
  assert.equal(f.records.size, 1); assert.equal(current.alert.title, 'Version 2');
  await Promise.all([f.service.intake(alert(3)), f.service.intake(alert(4))]);
  assert.equal([...f.records.values()][0].alert.title, 'Version 4');
});

test('tenant and company identity are part of provider case identity', () => {
  assert.notEqual(createCase(alert()).caseId, createCase(alert(0, {}, 'other-co')).caseId);
  assert.notEqual(createCase(alert()).caseId, createCase(alert(0, {}, 'example-co', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).caseId);
});

test('provider updates preserve terminal dispositions and require an explicit revision-bound review', () => {
  for (const status of ['open', 'investigating', 'confirmed', 'false-positive', 'closed']) {
    const original = { ...createCase(alert()), status, confirmedIncidentId: 'inc_existing' };
    const next = applyProviderUpdate(original, alert(1));
    assert.equal(next.status, status); assert.equal(next.confirmedIncidentId, 'inc_existing');
    assert.throws(() => applyCaseAction(next, { type: 'review-provider-update', actor: 'analyst', expectedRevision: next.revision, alertSignature: original.alertSignature, text: 'Reviewed' }), /evidence changed/);
    const reviewed = applyCaseAction(next, { type: 'review-provider-update', actor: 'analyst', expectedRevision: next.revision, alertSignature: next.alertSignature, text: 'Reviewed revised evidence' });
    assert.equal(reviewed.providerReviewRequired, false); assert.equal(reviewed.status, status);
  }
  assert.throws(() => applyProviderUpdate({ ...createCase(alert()), status: 'confirmation-pending' }, alert(1)), /confirmation pending/);
});

test('DynamoDB persists old and new provider snapshots atomically with revision check', async () => {
  const commands = [];
  const store = new DynamoDbInvestigationStore({ tableName: 'cases', documentClient: { send: async (c) => { commands.push(c.input); return {}; } } });
  const old = createCase(alert()); const next = applyProviderUpdate(old, alert(1));
  await store.saveChange(old, next, { type: 'provider-update', previousAlert: old.alert, alert: next.alert });
  const items = commands[0].TransactItems;
  assert.equal(items[0].Put.ConditionExpression, 'revision = :previous');
  assert.deepEqual(items[1].Put.Item.action.previousAlert, old.alert);
  assert.deepEqual(items[1].Put.Item.action.alert, next.alert);
});

test('a lost update acknowledgment replays once without a second activity or revision', async () => {
  const f = fixture(); await f.service.intake(alert());
  const save = f.store.saveChange; let lose = true;
  f.store.saveChange = async (...args) => { const result = await save(...args); if (lose) { lose = false; throw Error('transport lost'); } return result; };
  await assert.rejects(f.service.intake(alert(1)), /transport lost/);
  const replay = await f.service.intake(alert(1));
  assert.equal(replay.case.revision, 2); assert.equal(replay.updated, false); assert.equal(f.actions.length, 1);
});

test('intake retries a conflicting analyst edit without dropping the note', async () => {
  const f = fixture(); const initial = await f.service.intake(alert());
  const save = f.store.saveChange; let edit = true;
  f.store.saveChange = async (old, next, action) => {
    if (edit) {
      edit = false;
      const analyst = applyCaseAction(old, { type: 'note', actor: 'analyst', expectedRevision: old.revision, text: 'Concurrent analysis' });
      await save(old, analyst, { type: 'note' });
    }
    return save(old, next, action);
  };
  const updated = await f.service.intake(alert(1));
  assert.equal(updated.case.caseId, initial.case.caseId);
  assert.equal(updated.case.revision, 3);
  assert.equal(updated.case.notes[0].text, 'Concurrent analysis');
});
