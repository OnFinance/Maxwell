import test from 'node:test';
import assert from 'node:assert/strict';
import { MicrosoftCollector } from '../threat-detection/microsoft-collector.mjs';
import { MicrosoftPoller } from '../threat-detection/microsoft-poller.mjs';
import { MicrosoftStateStore, connectorHealth, connectorKey } from '../threat-detection/microsoft-state.mjs';
import { DurableDetectionEngine } from '../threat-detection/durable-engine.mjs';
import { InvestigationService } from '../incident-investigation/service.mjs';

const config = { companyId: 'example-co', tenantId: '11111111-2222-3333-4444-555555555555', source: 'entra' };
const initialFrom = '2026-11-04T00:00:00.000Z';
const now = Date.parse('2026-11-04T00:07:00.000Z');
const events = Array.from({ length: 6 }, (_, i) => ({ id: `event-${i}`, userId: 'user', ipAddress: '192.0.2.1',
  createdDateTime: `2026-11-04T00:00:0${i}.000Z`, status: { errorCode: i === 5 ? 0 : 50126 } })).reverse();

class MemoryState {
  state = null;
  async acquire(_config, { owner, now, leaseMs, initialFrom }) {
    if (this.state?.leaseUntil > now) return null;
    this.state = { checkpoint: initialFrom, initialFrom, ...this.state, leaseOwner: owner, leaseUntil: now + leaseMs, status: 'running', lastAttemptAt: now };
    return structuredClone(this.state);
  }
  check({ owner, now }) {
    if (this.state.leaseOwner !== owner || this.state.leaseUntil <= now) throw new Error('conditional check failed');
  }
  async renew(_config, args) { this.check(args); this.state.leaseUntil = args.now + args.leaseMs; }
  async complete(_config, args) {
    this.check(args);
    assert.ok(args.checkpoint >= this.state.checkpoint);
    Object.assign(this.state, { checkpoint: args.checkpoint, status: 'healthy', lastSuccessAt: args.now, consecutiveFailures: 0 });
    delete this.state.leaseOwner; delete this.state.leaseUntil;
  }
  async fail(_config, args) {
    this.check(args);
    Object.assign(this.state, { status: 'failed', failureCode: args.failureCode, consecutiveFailures: (this.state.consecutiveFailures || 0) + 1 });
    delete this.state.leaseOwner; delete this.state.leaseUntil;
  }
}
class MemoryDetection {
  events = new Map(); alerts = new Map(); failAlert = false;
  async saveEvent(item) {
    const key = `${item.scopeKey}:${item.event.eventId}`;
    const old = this.events.get(key);
    if (old && old.signature !== item.signature) throw new Error('signature conflict');
    this.events.set(key, structuredClone(item));
    return { created: !old };
  }
  async queryEvents({ scopeKey, from, to }) { return [...this.events.values()].filter((e) => e.scopeKey === scopeKey && e.time >= from && e.time <= to); }
  async saveAlert({ alert }) {
    if (this.failAlert) throw new Error('outbox unavailable');
    if (this.alerts.has(alert.alertId)) return false;
    this.alerts.set(alert.alertId, structuredClone(alert)); return true;
  }
}
function setup(overrides = {}) {
  const stateStore = new MemoryState();
  const detectionStore = new MemoryDetection();
  const ranges = [];
  const collector = new MicrosoftCollector({ ...config, getToken: async () => ({ tenantId: config.tenantId, accessToken: 'test' }),
    fetchImpl: async (url) => { ranges.push(new URL(url).searchParams.get('$filter')); return new Response(JSON.stringify({ value: events })); } });
  const detector = new DurableDetectionEngine({ companyId: config.companyId, store: detectionStore });
  const options = { ...config, initialFrom, collector, detector, stateStore, detectionStore, clock: () => now, ...overrides };
  return { stateStore, detectionStore, ranges, options, poller: new MicrosoftPoller(options) };
}

test('newest-first Graph to durable detection to cases, restart and overlap are idempotent', async () => {
  const f = setup();
  const first = await f.poller.poll();
  assert.equal(first.status, 'completed');
  assert.equal(first.checkpoint, '2026-11-04T00:05:00.000Z');
  assert.equal(f.detectionStore.alerts.size, 2);
  // New process objects retain the durable stores, without in-memory detector state.
  const restarted = new MicrosoftPoller({ ...f.options, detector: new DurableDetectionEngine({ companyId: config.companyId, store: f.detectionStore }) });
  await restarted.poll();
  assert.equal(f.detectionStore.events.size, 6);
  assert.equal(f.detectionStore.alerts.size, 2);
  assert.ok(f.ranges[1].includes(initialFrom));
  const cases = new Map();
  const service = new InvestigationService({ store: { createCase: async (c) => { if (!cases.has(c.caseId)) cases.set(c.caseId, c); } }, clock: () => now });
  for (const alert of f.detectionStore.alerts.values()) await service.intake(alert);
  for (const alert of f.detectionStore.alerts.values()) await service.intake(alert);
  assert.equal(cases.size, 2);
  assert.ok([...cases.values()].every((c) => c.status === 'open'));
  assert.equal(connectorHealth(f.stateStore.state, now).status, 'healthy');
});

test('crash after persisting an event but before alert repairs on replay without advancing checkpoint', async () => {
  const f = setup();
  f.detectionStore.failAlert = true;
  await assert.rejects(f.poller.poll(), /poll-failed/);
  assert.equal(f.stateStore.state.checkpoint, initialFrom);
  assert.equal(f.stateStore.state.status, 'failed');
  assert.ok(f.detectionStore.events.size > 0);
  f.detectionStore.failAlert = false;
  await new MicrosoftPoller(f.options).poll();
  assert.equal(f.detectionStore.alerts.size, 2);
  assert.equal(f.stateStore.state.consecutiveFailures, 0);
});

test('partial page failure preserves cursor and a later retry completes', async () => {
  const f = setup();
  let fail = true;
  const collector = { collect: async (args) => {
    const result = await f.options.collector.collect(args);
    if (fail) throw new Error('page two failed');
    return result;
  } };
  const poller = new MicrosoftPoller({ ...f.options, collector });
  await assert.rejects(poller.poll());
  assert.equal(f.stateStore.state.checkpoint, initialFrom);
  fail = false;
  await poller.poll();
  assert.equal(f.detectionStore.alerts.size, 2);
});

test('Defender polling writes immutable candidate revisions idempotently to the alert outbox', async () => {
  const f = setup();
  const source = 'defender';
  const collector = new MicrosoftCollector({ ...config, getToken: async () => ({ tenantId: config.tenantId, accessToken: 'test' }),
    fetchImpl: async () => new Response(JSON.stringify({ value: [{ id: 'defender-alert', tenantId: config.tenantId,
      serviceSource: 'microsoftDefenderForEndpoint', createdDateTime: initialFrom, lastUpdateDateTime: initialFrom,
      severity: 'high', title: 'Suspicious process' }] })) });
  const poller = new MicrosoftPoller({ ...f.options, source, collector, detector: undefined });
  await poller.poll();
  await poller.poll();
  assert.equal(f.detectionStore.alerts.size, 1);
  assert.equal([...f.detectionStore.alerts.values()][0].status, 'candidate');
  assert.equal(f.detectionStore.events.size, 0);
});

test('lost checkpoint write response preserves committed state and retries safely', async () => {
  const f = setup();
  const complete = f.stateStore.complete.bind(f.stateStore);
  f.stateStore.complete = async (...args) => { await complete(...args); throw new Error('response lost'); };
  await assert.rejects(f.poller.poll(), /read persisted checkpoint/);
  assert.equal(f.stateStore.state.checkpoint, '2026-11-04T00:05:00.000Z');
  assert.equal(f.stateStore.state.status, 'healthy');
  f.stateStore.complete = complete;
  await f.poller.poll();
  assert.equal(f.detectionStore.alerts.size, 2);
});

test('shutdown during delivery preserves checkpoint and releases owned lease as interrupted', async () => {
  const f = setup();
  const controller = new AbortController();
  const collector = { collect: async (args) => { controller.abort(); return f.options.collector.collect(args); } };
  await assert.rejects(new MicrosoftPoller({ ...f.options, collector }).poll({ signal: controller.signal }), /interrupted/);
  assert.equal(f.stateStore.state.checkpoint, initialFrom);
  assert.equal(f.stateStore.state.failureCode, 'interrupted');
  assert.equal(f.stateStore.state.leaseOwner, undefined);
});

test('concurrent worker cannot poll an actively leased connector', async () => {
  const f = setup();
  await f.stateStore.acquire(config, { owner: 'other-worker', now, leaseMs: 600000, initialFrom });
  assert.deepEqual(await f.poller.poll(), { status: 'busy' });
  assert.equal(f.ranges.length, 0);
});

test('lost lease cannot commit checkpoint or overwrite successor health', async () => {
  const f = setup();
  const collector = { collect: async (args) => {
    const result = await f.options.collector.collect(args);
    f.stateStore.state.leaseOwner = 'successor';
    return result;
  } };
  await assert.rejects(new MicrosoftPoller({ ...f.options, collector }).poll());
  assert.equal(f.stateStore.state.checkpoint, initialFrom);
  assert.equal(f.stateStore.state.leaseOwner, 'successor');
  assert.equal(f.stateStore.state.status, 'running');
});

test('retention gap and cross-tenant data fail closed', async () => {
  const old = setup({ initialFrom: '2026-10-01T00:00:00.000Z' });
  await assert.rejects(old.poller.poll(), /replay-horizon-exceeded/);
  assert.equal(old.ranges.length, 0);
  const f = setup();
  const collector = { collect: async ({ deliver }) => { await deliver({ companyId: 'other', scopeId: config.tenantId }); } };
  await assert.rejects(new MicrosoftPoller({ ...f.options, collector }).poll());
  assert.equal(f.detectionStore.events.size, 0);
});

test('health distinguishes no run, failure, dead worker and lagging cursor', () => {
  assert.equal(connectorHealth(null, now).status, 'never-started');
  assert.equal(connectorHealth({ status: 'running', leaseUntil: now - 1, checkpoint: initialFrom }, now).status, 'stalled');
  assert.equal(connectorHealth({ status: 'failed', checkpoint: initialFrom }, now).status, 'failed');
  assert.equal(connectorHealth({ status: 'healthy', lastSuccessAt: now, checkpoint: initialFrom }, now + 1000000).status, 'stale');
  assert.notDeepEqual(connectorKey(config), connectorKey({ ...config, companyId: 'other' }));
  assert.notDeepEqual(connectorKey(config), connectorKey({ ...config, source: 'defender' }));
});

test('DynamoDB cursor writes are conditional, strongly read and never use TTL', async () => {
  const commands = [];
  const store = new MicrosoftStateStore({ tableName: 'test', documentClient: { send: async (cmd) => { commands.push(cmd.input); return { Attributes: { checkpoint: initialFrom } }; } } });
  await store.read(config);
  await store.acquire(config, { owner: 'worker', now, leaseMs: 600000, initialFrom });
  await store.renew(config, { owner: 'worker', now, leaseMs: 600000 });
  await store.complete(config, { owner: 'worker', now, checkpoint: initialFrom, stats: {} });
  await store.fail(config, { owner: 'worker', now, failureCode: 'poll-failed' });
  assert.equal(commands[0].ConsistentRead, true);
  assert.match(commands[1].UpdateExpression, /checkpoint = if_not_exists/);
  for (const cmd of commands.slice(2)) {
    assert.match(cmd.ConditionExpression, /leaseOwner = :owner AND leaseUntil > :now/);
    assert.equal(cmd.ExpressionAttributeValues[':owner'], 'worker');
  }
  assert.match(commands[3].ConditionExpression, /checkpoint <= :checkpoint/);
  assert.ok(!JSON.stringify(commands).includes('expiresAt'));
  const conflictStore = new MicrosoftStateStore({ tableName: 'test', documentClient: { send: async () => { throw Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }); } } });
  assert.equal(await conflictStore.acquire(config, { owner: 'other', now, leaseMs: 600000, initialFrom }), null);
  await assert.rejects(conflictStore.renew(config, { owner: 'other', now, leaseMs: 600000 }));
});
