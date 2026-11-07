import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContinuousControlService } from '../continuous-controls/service.mjs';
import { controlWorkspace } from '../continuous-controls/workspace.mjs';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { appendRecords, readLedger } from '../lib/ledger.mjs';
import { sha256 } from '../incident-investigation/core.mjs';
const sample = JSON.parse(await readFile('.claude/schemas/v1/soc/record.schema.json', 'utf8')).examples.find((x) => x.kind === 'control');
async function setup() {
  const f = { root: await mkdtemp(join(tmpdir(), 'maxwell-controls-')), now: Date.parse('2026-11-07T00:00:00Z'), outcome: 'passed', calls: 0 };
  f.companyId = sample.companyId; f.control = structuredClone(sample); f.control.applicableAssets = [{ type: 'repo', appId: 'test-app', repoId: 'test-repo' }];
  assert.deepEqual(appendRecords(f.companyId, [f.control], { root: f.root }).problems, []);
  f.store = new ExportStateStore({ root: f.root, sessionId: 'ses_controls123' });
  f.options = { store: f.store, clock: () => f.now, leaseMs: 1000, loadControl: async () => f.control, resolveCheckout: async () => '/unused',
    authorize: async (s, companyId) => { if (s !== 'operator' || companyId !== f.companyId) throw Error('not authorized'); return { id: s, companyId }; },
    publish: controlWorkspace(f.root).publish,
    checker: async ({ revision, check }) => { f.calls++; if (f.outcome === 'unavailable') throw Error('source unavailable'); return { outcome: f.outcome, revision, checkHash: sha256(check), artifactHash: 'a'.repeat(64) }; } };
  f.service = new ContinuousControlService(f.options);
  f.register = () => f.service.register({ session: 'operator', companyId: f.companyId, controlId: f.control.id, target: f.control.applicableAssets[0], revision: 'a'.repeat(40),
    check: { type: 'json-field-equals', version: 1, path: 'settings.json', field: ['tls'], expected: true }, intervalMs: 60000, evidenceTtlMs: 120000 });
  return f;
}
test('scheduled check → validated observation → drift and evidence expiry', async () => {
  const f = await setup(); try {
    const s = await f.register(); const input = { session: 'operator', companyId: f.companyId, id: s.value.id };
    assert.equal((await f.service.health(input)).status, 'never-tested');
    assert.equal((await f.service.tick(input)).outcome, 'passed');
    assert.equal((await f.service.health(input)).status, 'healthy');
    assert.equal((await f.service.tick(input)).status, 'not-due');
    f.now += 60000; f.outcome = 'failed';
    assert.equal((await f.service.tick(input)).drift, true);
    assert.equal((await f.service.health(input)).status, 'control-failed');
    assert.equal(readLedger(f.companyId, f.root).at(-1).result, 'not-satisfied');
    f.now += 120000; assert.equal((await f.service.health(input)).status, 'evidence-expired');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('unavailable checks are inconclusive and changed controls invalidate health', async () => {
  const f = await setup(); try {
    const s = await f.register(); const input = { session: 'operator', companyId: f.companyId, id: s.value.id };
    f.outcome = 'unavailable'; assert.equal((await f.service.tick(input)).outcome, 'inconclusive');
    assert.equal(readLedger(f.companyId, f.root).at(-1).result, 'inconclusive');
    assert.equal((await f.service.health(input)).status, 'check-failed');
    f.control.title += ' changed'; assert.equal((await f.service.health(input)).status, 'scope-changed');
    await assert.rejects(f.service.tick({ ...input, session: 'other' }), /authorized/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('lease contention admits one check and lost publication acknowledgement recovers idempotently', async () => {
  const f = await setup(); try {
    let lose = true; const publish = f.service.publish;
    f.service.publish = async (...args) => { await publish(...args); if (lose) { lose = false; throw Error('ack lost'); } };
    const s = await f.register(); const input = { session: 'operator', companyId: f.companyId, id: s.value.id };
    const outcomes = await Promise.allSettled([f.service.tick(input), f.service.tick(input)]);
    assert.equal(f.calls, 1); assert.equal(outcomes.filter((x) => x.status === 'rejected').length, 1);
    assert.equal((await f.service.tick(input)).status, 'busy');
    f.now += 1001;
    const restarted = new ContinuousControlService({ ...f.options });
    assert.equal((await restarted.tick(input)).status, 'completed');
    assert.equal(f.calls, 1); assert.equal(readLedger(f.companyId, f.root).filter((x) => x.kind === 'observation').length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('expired workers cannot publish and a paused schedule cannot run', async () => {
  const f = await setup(); try {
    const s = await f.register(); const input = { session: 'operator', companyId: f.companyId, id: s.value.id };
    f.service.checker = async (...args) => { const result = await f.options.checker(...args); f.now += 1001; return result; };
    await assert.rejects(f.service.tick(input), /lease lost/);
    assert.equal(readLedger(f.companyId, f.root).length, 1);
    assert.equal((await f.service.health(input)).status, 'stalled');
    f.service.checker = f.options.checker; await f.service.tick(input);
    const current = await f.store.get(f.companyId, s.value.id);
    await f.service.pause({ ...input, expectedRevision: current.revision, paused: true });
    assert.equal((await f.service.tick(input)).status, 'paused');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
