import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetPlan, buildCoverageLedger, coverageUnitId, seedCoverageUnits, transitionCoverageUnit } from '../security-audit/coverage.mjs';

const repos = [{ appId: 'payments', repoId: 'api', surfaces: [
  { subsystem: 'routes', boundary: 'internet-http', attackClasses: ['authorization-object-access', 'injection-interpreter'], priority: 8 },
  { subsystem: 'worker', boundary: 'queue', attackClasses: ['protocol-messaging'], priority: 4 },
] }];

test('coverage ids are stable and include a collision-resistant suffix', () => {
  const input = { repo: 'payments/api', subsystem: 'routes', boundary: 'internet-http', attackClass: 'authorization-object-access' };
  assert.equal(coverageUnitId(input), coverageUnitId({ ...input }));
  assert.match(coverageUnitId(input), /^cov_.*_[a-f0-9]{12}$/);
});

test('quick profile coarsens subsystem while retaining boundary and attack class', () => {
  const units = seedCoverageUnits(repos, { profile: 'quick' });
  assert.equal(units.length, 3);
  assert(units.every((x) => x.subsystem === 'profile/quick/all-in-scope-subsystems'));
});

test('scoped planning marks excluded repos out of scope', () => {
  const ledger = buildCoverageLedger({ runId: 'run_1', repositories: repos, profile: 'standard', scopePaths: ['other/repo'] });
  assert(ledger.units.every((x) => x.state === 'out_of_scope'));
});

test('coverage transitions enforce ownership, evidence, and reasons', () => {
  const unit = seedCoverageUnits(repos)[0];
  assert.throws(() => transitionCoverageUnit(unit, 'assigned'), /owner/);
  const assigned = transitionCoverageUnit(unit, 'assigned', { owner: 'hunter-1' });
  assert.throws(() => transitionCoverageUnit(assigned, 'covered'), /evidence/);
  assert.equal(transitionCoverageUnit(assigned, 'covered', { evidence: ['src/routes.js:10'] }).state, 'covered');
});

test('budget reserves reconnaissance, critics, and validation before hunters', () => {
  assert.deepEqual(budgetPlan({ profile: 'standard', budget: 9, unitCount: 10, expectedCandidates: 1 }), {
    profile: 'standard', budget: 9, reconnaissance: 4, critics: 2, validation: 2, mandatory: 8, hunterAllowance: 1, canStart: true,
  });
  assert.equal(budgetPlan({ profile: 'deep', budget: 7, unitCount: 4 }).canStart, true);
  assert.equal(budgetPlan({ profile: 'standard', budget: 6, unitCount: 4 }).canStart, false);
});
