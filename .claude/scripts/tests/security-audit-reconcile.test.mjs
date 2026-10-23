import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCurrentAndPriorUnits, reconcilePriorRun } from '../security-audit/reconcile.mjs';

const base = { repo: 'app/api', subsystem: 'routes', boundary: 'tenant-http', attackClass: 'authorization-object-access', sourceKey: 'src/routes.js', priority: 9, runId: 'run_old' };

test('three revisions carry only unchanged confirmed source and always reverify it', () => {
  const v1 = { ...base, fingerprint: 'a', verdict: 'confirmed', sourceHash: 'v1' };
  const same = reconcilePriorRun({ priorRecords: [v1], currentSources: { 'src/routes.js': { sourceHash: 'v1' } } });
  assert.equal(same.carriedCandidates[0].requiresFinalVerification, true);
  const v2 = reconcilePriorRun({ priorRecords: [v1], currentSources: { 'src/routes.js': { sourceHash: 'v2' } } });
  assert.equal(v2.carriedCandidates.length, 0);
  assert.equal(v2.decisions[0].action, 'reopen');
  const v3 = reconcilePriorRun({ priorRecords: [{ ...v1, sourceHash: 'v2', runId: 'run_2' }], currentSources: { 'src/routes.js': { sourceHash: 'v3' } } });
  assert.equal(v3.decisions[0].reason, 'relevant source changed');
});

test('needs-validation reopens even when source is unchanged', () => {
  const plan = reconcilePriorRun({ priorRecords: [{ ...base, fingerprint: 'b', verdict: 'needs_validation', sourceHash: 'same' }], currentSources: { 'src/routes.js': { sourceHash: 'same' } } });
  assert.equal(plan.decisions[0].action, 'reopen');
  assert.equal(plan.carriedCandidates.length, 0);
});

test('rejected suppresses only the identical claim and retains coverage', () => {
  const plan = reconcilePriorRun({ priorRecords: [{ ...base, fingerprint: 'c', verdict: 'rejected', sourceHash: 'same' }], currentSources: { 'src/routes.js': { sourceHash: 'same' } } });
  assert.deepEqual(plan.suppressedClaims, ['c']);
  assert.equal(plan.plannedUnits.length, 1);
});

test('merges prior work deterministically without duplicate units', () => {
  const plan = reconcilePriorRun({ priorRecords: [{ ...base, fingerprint: 'a', verdict: 'confirmed', sourceHash: 'x' }], currentSources: { 'src/routes.js': { sourceHash: 'x' } } });
  assert.equal(mergeCurrentAndPriorUnits(plan.plannedUnits, plan).length, 1);
});
