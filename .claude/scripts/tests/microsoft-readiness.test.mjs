import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorHealth } from '../threat-detection/microsoft-state.mjs';
import { checkMicrosoftReadiness } from '../threat-detection/microsoft-readiness.mjs';
import { watchMicrosoft } from '../threat-detection/microsoft-watch.mjs';
import { normalizeDefenderAlert } from '../threat-detection/microsoft-adapter.mjs';
import { createCase } from '../incident-investigation/core.mjs';
const now = Date.parse('2026-11-04T00:10:00.000Z');
const config = { companyId: 'example-co', tenantId: '11111111-2222-3333-4444-555555555555', source: 'defender' };
const healthy = { status: 'healthy', checkpoint: new Date(now - 120000).toISOString(), lastSuccessAt: now - 60000, lastStats: { received: 0, delivered: 0, pages: 1 } };
const alert = normalizeDefenderAlert({ id: 'sample', tenantId: config.tenantId, serviceSource: 'microsoftDefenderForEndpoint', title: 'Sample', severity: 'high', createdDateTime: new Date(now - 300000).toISOString(), lastUpdateDateTime: new Date(now - 120000).toISOString() }, config);
function setup({ state = healthy, sample = { alert }, row = { case: createCase(alert) } } = {}) {
  const calls = [];
  const client = { send: async (command) => { assert.equal(command.constructor.name, 'GetCommand'); assert.equal(command.input.ConsistentRead, true); calls.push(command.input); return { Item: calls.length === 1 ? state : calls.length === 2 ? sample : row }; } };
  return { calls, check: (overrides = {}) => checkMicrosoftReadiness({ config, detectionTable: 'detection', investigationTable: 'cases', alertId: alert.alertId, client, now, ...overrides }) };
}
test('health fails closed on malformed/future checkpoints and running-but-stale collection', () => {
  for (const checkpoint of ['broken', new Date(now + 1).toISOString(), null]) assert.equal(connectorHealth({ ...healthy, checkpoint }, now).status, 'invalid');
  assert.equal(connectorHealth({ ...healthy, status: 'running', leaseUntil: now + 600000, checkpoint: new Date(now - 1000000).toISOString() }, now).status, 'stale');
  assert.equal(connectorHealth({ ...healthy, status: 'running', leaseUntil: now - 1 }, now).status, 'stalled');
  assert.equal(connectorHealth({ ...healthy, status: 'running', leaseUntil: now + 1, lastSuccessAt: undefined }, now).status, 'starting');
  assert.equal(connectorHealth({ ...healthy, lastSuccessAt: now + 1 }, now).ready, false);
  assert.equal(connectorHealth(healthy, now).ready, true);
});
test('readiness proves a recent sample with only three scoped consistent reads', async () => {
  const f = setup(); const report = await f.check();
  assert.equal(report.ready, true); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].Key.pk, `CONNECTOR#${config.companyId}#${config.tenantId}`);
  assert.equal(f.calls[1].Key.pk, 'ALERTS#example-co');
  assert.equal(f.calls[2].TableName, 'cases');
  assert.ok(!JSON.stringify(report).includes('Sample'));
});
test('quiet collection without a delivery sample is explicitly unverified', async () => {
  const f = setup(); const result = await f.check({ alertId: undefined });
  assert.equal(result.ready, false); assert.equal(result.checks[0].status, 'pass');
  assert.equal(result.checks[1].status, 'unverified'); assert.equal(f.calls.length, 1);
});
test('missing/expired sample, mismatched case and stale connector cannot pass', async () => {
  for (const options of [{ sample: null }, { sample: { alert, expiresAt: now / 1000 } }, { row: null }, { row: { case: { ...createCase(alert), companyId: 'other' } } }, { state: { ...healthy, lastSuccessAt: now - 1000000 } }]) assert.equal((await setup(options).check()).ready, false);
  const wrong = { ...alert, scopeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  await assert.rejects(setup({ sample: { alert: wrong } }).check(), /scope mismatch/);
});
test('health exposes only bounded counters and safe failure codes', () => {
  const report = connectorHealth({ ...healthy, status: 'failed', failureCode: 'secret value', lastStats: { ...healthy.lastStats, token: 'secret value' } }, now);
  assert.ok(!JSON.stringify(report).includes('secret value'));
  assert.equal(report.failureCode, 'poll-failed');
});
test('watch backs off, caps retries, recovers and stops without overlapping polls', async () => {
  const controller = new AbortController(); const waits = []; const failures = []; let calls = 0; let active = false;
  await watchMicrosoft({ signal: controller.signal,
    poller: { poll: async () => { assert.equal(active, false); active = true; await Promise.resolve(); active = false; if (++calls <= 4) throw Error('private provider payload'); return { status: 'completed' }; } },
    onFailure: (result) => failures.push(result), onResult: () => {}, wait: async (ms) => { waits.push(ms); if (waits.length === 5) controller.abort(); } });
  assert.deepEqual(waits, [120000, 240000, 300000, 300000, 60000]);
  assert.equal(calls, 5); assert.ok(!JSON.stringify(failures).includes('private'));
});
test('watch interruption and broken scheduler exit without another poll', async () => {
  const controller = new AbortController(); let calls = 0;
  await watchMicrosoft({ signal: controller.signal, poller: { poll: async () => { calls++; controller.abort(); throw Error('interrupted'); } }, onResult: () => {}, onFailure: () => assert.fail('shutdown is not failure'), wait: () => assert.fail('must not wait') });
  assert.equal(calls, 1);
  await assert.rejects(watchMicrosoft({ signal: new AbortController().signal, poller: { poll: async () => ({ status: 'busy' }) }, onResult: () => {}, onFailure: () => {}, wait: async () => { throw Error('broken timer'); } }), /scheduler wait failed/);
});
