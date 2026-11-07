import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RegulatoryImpactService } from '../regulatory-impact/service.mjs';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { controlWorkspace } from '../continuous-controls/workspace.mjs';
import { appendRecords, readLedger } from '../lib/ledger.mjs';
const sample = JSON.parse(await readFile('.claude/schemas/v1/soc/record.schema.json', 'utf8')).examples.find((x) => x.kind === 'control');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'maxwell-regulatory-')); const companyId = sample.companyId;
  const scope = { instruments: ['sebi-cscrf-2024'], controls: [structuredClone(sample)] };
  assert.deepEqual(appendRecords(companyId, [sample], { root }).problems, []);
  const store = new ExportStateStore({ root, sessionId: 'ses_regulatory123' });
  const options = { store, sourceHosts: ['regulator.example.invalid'], loadScope: async () => scope, publish: controlWorkspace(root).publish,
    authorize: async (s, co, permission) => { if (!['analyst', 'reviewer'].includes(s) || co !== companyId || (permission === 'regulation.review' && s !== 'reviewer')) throw Error('not authorized'); return { id: s, companyId: co }; } };
  const service = new RegulatoryImpactService(options);
  const document = { instrument: 'sebi-cscrf-2024', version: 'v1', url: 'https://regulator.example.invalid/document', effectiveAt: '2026-11-07T00:00:00.000Z', clauses: [{ id: 'GV.SC.S5', text: 'Synthetic requirement, not actual regulatory text.' }] };
  const old = await service.importSource({ session: 'analyst', companyId, document });
  const newer = await service.importSource({ session: 'analyst', companyId, document: { ...document, version: 'v2', clauses: [{ id: 'GV.SC.S5', text: 'Changed synthetic requirement.' }, { id: 'NEW-1', text: 'Unmapped synthetic requirement.' }] } });
  const compare = () => service.compare({ session: 'analyst', companyId, previousId: old.value.id, nextId: newer.value.id });
  return { root, companyId, store, service, scope, options, document, old, newer, compare };
}
const mappings = [{ clauseId: 'GV.SC.S5', outcome: 'mapped', controlIds: [sample.id], rationale: 'Reviewed mapping against the supplied source' }, { clauseId: 'NEW-1', outcome: 'not-applicable', rationale: 'Reviewed and explicitly excluded in this synthetic company scope' }];
test('source versions → impact diff → independent mapping review → validated observation and task proposals', async () => {
  const f = await setup(); try {
    const plan = await f.compare(); assert.equal(plan.value.changes.length, 2);
    assert.equal(plan.value.changes.find((c) => c.clauseId === 'NEW-1').unmapped, true);
    assert.deepEqual(plan.value.changes.find((c) => c.clauseId === 'GV.SC.S5').suggestedControlIds, [sample.id]);
    const reviewed = await f.service.review({ session: 'reviewer', companyId: f.companyId, id: plan.value.id, expectedRevision: 1, digest: plan.value.reviewDigest, decision: 'accept', note: 'Source and interpretation independently reviewed', mappings });
    assert.equal(reviewed.value.state, 'accepted'); assert.equal(reviewed.value.proposals.length, 1);
    const records = readLedger(f.companyId, f.root); assert.equal(records.length, 2); assert.equal(records[1].kind, 'observation'); assert.equal(records[1].result, 'inconclusive');
    assert.equal(records.filter((r) => r.kind === 'control').length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('source import is idempotent and rejects changed versions, unapproved URLs and cross-company access', async () => {
  const f = await setup(); try {
    assert.equal((await f.service.importSource({ session: 'analyst', companyId: f.companyId, document: f.document })).digest, f.old.digest);
    await assert.rejects(f.service.importSource({ session: 'analyst', companyId: f.companyId, document: { ...f.document, clauses: [{ id: 'GV.SC.S5', text: 'different' }] } }), /reused/);
    await assert.rejects(f.service.importSource({ session: 'analyst', companyId: f.companyId, document: { ...f.document, url: 'http://127.0.0.1/private' } }), /approved/);
    await assert.rejects(f.service.importSource({ session: 'analyst', companyId: 'other', document: f.document }), /authorized/);
    await assert.rejects(f.service.compare({ session: 'analyst', companyId: f.companyId, previousId: f.newer.value.id, nextId: 'missing' }), /missing/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('stale scope, incomplete review and wrong digest cannot publish impact', async () => {
  const f = await setup(); try {
    const plan = await f.compare(); const input = { session: 'reviewer', companyId: f.companyId, id: plan.value.id, expectedRevision: 1, digest: plan.value.reviewDigest, decision: 'accept', note: 'Reviewed', mappings };
    await assert.rejects(f.service.review({ ...input, digest: 'wrong' }), /conflict/);
    await assert.rejects(f.service.review({ ...input, session: 'analyst' }), /authorized/);
    await assert.rejects(f.service.review({ ...input, mappings: [] }), /every changed clause/);
    f.scope.controls[0].title += ' changed';
    await assert.rejects(f.service.review(input), /controls changed/);
    assert.equal(readLedger(f.companyId, f.root).length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('publication recovery preserves accepted interpretation without duplicate observations', async () => {
  const f = await setup(); try {
    const plan = await f.compare(); const publish = f.service.publish; let lose = true;
    f.service.publish = async (...args) => { await publish(...args); if (lose) { lose = false; throw Error('ack lost'); } };
    const input = { session: 'reviewer', companyId: f.companyId, id: plan.value.id, expectedRevision: 1, digest: plan.value.reviewDigest, decision: 'accept', note: 'Reviewed', mappings };
    await assert.rejects(f.service.review(input), /ack lost/);
    const saved = await f.store.get(f.companyId, plan.value.id);
    const restarted = new RegulatoryImpactService(f.options);
    assert.equal((await restarted.review({ ...input, expectedRevision: saved.revision })).value.state, 'accepted');
    assert.equal(readLedger(f.companyId, f.root).length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
