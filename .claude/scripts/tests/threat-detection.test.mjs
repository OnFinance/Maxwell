import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DetectionEngine, validateEvent } from '../threat-detection/engine.mjs';

const base = Date.parse('2026-10-03T10:00:00.000Z');
const event = (n, overrides = {}) => ({
  schemaVersion: '1',
  eventId: `evt-${n}`,
  companyId: 'example-co',
  scopeId: 'workforce-idp',
  source: 'normalized-test',
  eventTime: new Date(base + n * 1000).toISOString(),
  type: 'authentication',
  outcome: 'failure',
  actorKey: 'usr-01',
  sourceKey: 'src-01',
  ...overrides,
});
const pushAll = (engine, events, now = base + 30000) => events.flatMap((item) => engine.push(item, now));

test('five failures for one actor emit one bounded candidate', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  const alerts = pushAll(engine, [1, 2, 3, 4, 5, 6].map((n) => event(n)));
  assert.deepEqual(alerts.map((alert) => alert.recipeId), ['authentication-failure-burst']);
  assert.equal(alerts[0].evidenceCount, 5);
  assert.equal(alerts[0].status, 'candidate');
  assert.equal(engine.stats.alerts, 1);
});

test('one source failing against five identities emits password-spray', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  const alerts = pushAll(engine, [1, 2, 3, 4, 5].map((n) => event(n, { actorKey: `usr-${n}` })));
  assert.deepEqual(alerts.map((alert) => alert.recipeId), ['password-spray']);
  assert.equal(alerts[0].priority, 'high');
});

test('success after five failures emits the correlated candidate', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  pushAll(engine, [1, 2, 3, 4, 5].map((n) => event(n)));
  const alerts = engine.push(event(6, { outcome: 'success' }), base + 30000);
  assert.deepEqual(alerts.map((alert) => alert.recipeId), ['failure-then-success']);
  assert.equal(alerts[0].evidenceCount, 6);
});

test('a success crossing a UTC bucket does not repeat failure-only alerts', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  pushAll(engine, [-5, -4, -3, -2, -1].map((n) => event(n)), base + 30000);
  const alerts = engine.push(event(1, { outcome: 'success' }), base + 30000);
  assert.deepEqual(alerts.map((alert) => alert.recipeId), ['failure-then-success']);
});

test('late failure can complete a correlation before an already-seen success', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  pushAll(engine, [1, 2, 3, 4].map((n) => event(n)));
  assert.deepEqual(engine.push(event(6, { outcome: 'success' }), base + 30000), []);
  const alerts = engine.push(event(5), base + 30000);
  assert.ok(alerts.some((alert) => alert.recipeId === 'failure-then-success'));
});

test('successful privileged grants and audit disable actions alert immediately', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  const grant = event(1, { type: 'privilege-grant', outcome: 'success', targetKey: 'role-admin', privileged: true, sourceKey: undefined });
  const audit = event(2, { type: 'audit-disable', outcome: 'success', targetKey: 'trail-primary', sourceKey: undefined });
  assert.equal(engine.push(grant, base + 30000)[0].recipeId, 'privileged-access-granted');
  assert.equal(engine.push(audit, base + 30000)[0].recipeId, 'audit-logging-disabled');
  assert.deepEqual(engine.push(event(3, { type: 'privilege-grant', outcome: 'success', targetKey: 'role-reader', privileged: false, sourceKey: undefined }), base + 30000), []);
});

test('duplicates are idempotent and conflicting reuse is rejected', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  const first = event(1);
  assert.deepEqual(engine.push(first, base + 30000), []);
  assert.deepEqual(engine.push(first, base + 30000), []);
  assert.equal(engine.stats.duplicates, 1);
  assert.throws(() => engine.push({ ...first, actorKey: 'usr-02' }, base + 30000), /reused with different content/);
});

test('company and scope boundaries prevent correlation', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  assert.throws(() => engine.push(event(1, { companyId: 'other-co' }), base + 30000), /does not match/);
  const mixed = [1, 2, 3].map((n) => event(n, { scopeId: 'idp-a' }))
    .concat([4, 5, 6].map((n) => event(n, { scopeId: 'idp-b' })));
  assert.deepEqual(pushAll(engine, mixed), []);
});

test('input contract rejects raw, stale, future and over-capacity input', () => {
  assert.throws(() => validateEvent({ ...event(1), rawMessage: 'password=secret' }), /unsupported fields/);
  const engine = new DetectionEngine({ companyId: 'example-co', maxEvents: 1 });
  assert.throws(() => engine.push(event(1), base - 60000), /future event/);
  assert.throws(() => engine.push(event(1), base + 600000), /stale event/);
  engine.push(event(1), base + 30000);
  assert.throws(() => engine.push(event(2), base + 30000), /capacity exceeded/);
});

test('the CLI demo emits ready-to-inspect candidates without an input file', () => {
  const result = spawnSync(process.execPath, ['.claude/scripts/threat-detection/run.mjs', '--company', 'example-co', '--demo', '--replay-now', '2026-10-03T10:00:00.000Z'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const alerts = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(alerts.map((alert) => alert.recipeId), ['authentication-failure-burst', 'failure-then-success']);
  assert.match(result.stderr, /"accepted":6/);
});
