import { transitionCoverageUnit } from './coverage.mjs';

export function planHunterAssignments(units, { allowance = Infinity, wave = 1 } = {}) {
  if (!Number.isInteger(wave) || wave < 1) throw new Error('wave must be a positive integer');
  const planned = units.filter((unit) => unit.state === 'planned')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id));
  const selected = planned.slice(0, Math.max(0, allowance));
  const assignments = selected.map((unit, index) => ({
    assignmentId: `hunt-${wave}-${String(index + 1).padStart(3, '0')}`,
    wave, coverageUnitIds: [unit.id], repo: unit.repo, subsystem: unit.subsystem,
    boundary: unit.boundary, attackClasses: [unit.attackClass],
  }));
  const ownerByUnit = new Map(assignments.flatMap((assignment) => assignment.coverageUnitIds.map((id) => [id, assignment.assignmentId])));
  const nextUnits = units.map((unit) => ownerByUnit.has(unit.id)
    ? transitionCoverageUnit(unit, 'assigned', { owner: ownerByUnit.get(unit.id) })
    : unit);
  return { assignments, units: nextUnits };
}

export function applyHunterResult(units, result) {
  const assigned = new Set(result.coverageUnitIds || []);
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  return units.map((unit) => {
    if (!assigned.has(unit.id)) return unit;
    if (unit.owner !== result.assignmentId) throw new Error(`assignment ${result.assignmentId} does not own ${unit.id}`);
    const hasCandidate = candidates.some((candidate) => candidate.coverageUnitId === unit.id);
    if (hasCandidate) return transitionCoverageUnit(unit, 'candidate', { evidence });
    if (result.blocker) return transitionCoverageUnit(unit, 'blocked', { reason: result.blocker });
    return transitionCoverageUnit(unit, 'covered', { evidence });
  });
}

export function applyCriticResult(units, result, { profile = 'standard' } = {}) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  for (const gap of result.gaps || []) {
    const unit = byId.get(gap.coverageUnitId);
    if (!unit) throw new Error(`critic referenced unknown coverage unit ${gap.coverageUnitId}`);
    if (unit.state === 'out_of_scope') continue;
    if (profile === 'quick') byId.set(unit.id, { ...unit, state: 'deferred', reason: gap.reason || 'quick profile permits one hunter wave' });
    else if (['covered', 'blocked', 'deferred'].includes(unit.state)) byId.set(unit.id, { ...unit, state: 'planned', reason: gap.reason });
  }
  return [...byId.values()];
}

export function coverageSummary(units) {
  return units.reduce((summary, unit) => {
    summary[unit.state] = (summary[unit.state] || 0) + 1;
    return summary;
  }, {});
}
