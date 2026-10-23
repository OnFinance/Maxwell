import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageUnit } from '../security-audit/coverage.mjs';
import { applyCriticResult, applyHunterResult, coverageSummary, planHunterAssignments } from '../security-audit/hunting.mjs';

const units = () => [
  createCoverageUnit({ repo: 'app/api', subsystem: 'routes', boundary: 'http', attackClass: 'authorization-object-access', priority: 9 }),
  createCoverageUnit({ repo: 'app/api', subsystem: 'db', boundary: 'query', attackClass: 'injection-interpreter', priority: 5 }),
];

test('plans highest-priority units without double ownership', () => {
  const plan = planHunterAssignments(units(), { allowance: 1, wave: 2 });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].assignmentId, 'hunt-2-001');
  assert.equal(plan.units.filter((x) => x.state === 'assigned').length, 1);
});

test('hunter result moves owned units to covered or candidate', () => {
  const plan = planHunterAssignments(units(), { allowance: 2 });
  const first = plan.assignments[0];
  const next = applyHunterResult(plan.units, { assignmentId: first.assignmentId, coverageUnitIds: first.coverageUnitIds, evidence: ['src/routes.js:4'], candidates: [] });
  assert.equal(next.find((x) => x.id === first.coverageUnitIds[0]).state, 'covered');
  assert.throws(() => applyHunterResult(next, { assignmentId: 'wrong', coverageUnitIds: first.coverageUnitIds, evidence: ['x'], candidates: [] }), /does not own/);
});

test('critic reopens standard gaps and defers quick gaps', () => {
  const plan = planHunterAssignments(units(), { allowance: 1 });
  const assignment = plan.assignments[0];
  const covered = applyHunterResult(plan.units, { assignmentId: assignment.assignmentId, coverageUnitIds: assignment.coverageUnitIds, evidence: ['a.js:1'], candidates: [] });
  const gap = { gaps: [{ coverageUnitId: assignment.coverageUnitIds[0], reason: 'source-to-sink trace skipped middleware' }] };
  assert.equal(applyCriticResult(covered, gap, { profile: 'standard' }).find((x) => x.id === assignment.coverageUnitIds[0]).state, 'planned');
  assert.equal(applyCriticResult(covered, gap, { profile: 'quick' }).find((x) => x.id === assignment.coverageUnitIds[0]).state, 'deferred');
  assert.equal(coverageSummary(covered).covered, 1);
});
