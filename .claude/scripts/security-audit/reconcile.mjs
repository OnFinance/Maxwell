import { createCoverageUnit } from './coverage.mjs';

const sameSource = (previous, current) => Boolean(previous.sourceHash && current.sourceHash && previous.sourceHash === current.sourceHash);
const unitIdentity = (record) => ({ repo: record.repo, subsystem: record.subsystem, boundary: record.boundary, attackClass: record.attackClass });

export function reconcilePriorRun({ priorRecords = [], currentSources = {}, profile = 'standard' }) {
  const carriedCandidates = [];
  const plannedUnits = [];
  const suppressedClaims = [];
  const decisions = [];
  for (const record of [...priorRecords].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))) {
    const current = currentSources[record.sourceKey];
    const unchanged = current && sameSource(record, current);
    const unit = createCoverageUnit({ ...unitIdentity(record), state: 'planned', priority: record.priority || 0 });
    if (record.verdict === 'confirmed' && unchanged) {
      carriedCandidates.push({ ...record, carriedFromRunId: record.runId, requiresFinalVerification: true, coverageUnitId: unit.id });
      plannedUnits.push(unit);
      decisions.push({ fingerprint: record.fingerprint, action: 'carry-for-reverification', reason: 'relevant source hash unchanged' });
      continue;
    }
    if (record.verdict === 'rejected' && unchanged) {
      suppressedClaims.push(record.fingerprint);
      plannedUnits.push(unit);
      decisions.push({ fingerprint: record.fingerprint, action: 'suppress-identical-claim-only', reason: 'same failed claim and source; coverage remains planned' });
      continue;
    }
    plannedUnits.push(unit);
    decisions.push({ fingerprint: record.fingerprint, action: 'reopen', reason: !current ? 'current source trace is unavailable' : unchanged ? `${record.verdict} never suppresses current coverage` : 'relevant source changed' });
  }
  if (profile === 'deep') for (const candidate of carriedCandidates) candidate.requiresSecondPass = true;
  const uniqueUnits = [...new Map(plannedUnits.map((unit) => [unit.id, unit])).values()];
  return { carriedCandidates, plannedUnits: uniqueUnits, suppressedClaims, decisions };
}

export function mergeCurrentAndPriorUnits(currentUnits, priorPlan) {
  const byId = new Map(currentUnits.map((unit) => [unit.id, unit]));
  for (const unit of priorPlan.plannedUnits) if (!byId.has(unit.id)) byId.set(unit.id, unit);
  return [...byId.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id));
}
