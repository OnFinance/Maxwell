import { createHash } from 'node:crypto';

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const cleanPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');

export function candidateFingerprint(candidate) {
  const identity = [candidate.ruleId, candidate.targetKey, cleanPath(candidate.location?.path), candidate.sourceTrace]
    .map((value) => String(value || '').trim()).join('|');
  return createHash('sha256').update(identity).digest('hex');
}

export function normalizeCandidate(candidate) {
  const normalized = {
    fingerprint: candidate.fingerprint || candidateFingerprint(candidate),
    coverageUnitId: candidate.coverageUnitId,
    title: String(candidate.title || '').trim(),
    ruleId: String(candidate.ruleId || '').trim(),
    targetKey: String(candidate.targetKey || '').trim(),
    location: candidate.location ? { ...candidate.location, path: cleanPath(candidate.location.path) } : undefined,
    sourceTrace: String(candidate.sourceTrace || '').trim(),
    boundary: candidate.boundary,
    evidence: [...new Set(candidate.evidence || [])],
    regulatoryRefs: candidate.regulatoryRefs || [],
    proposedSeverity: candidate.severity,
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

export function decideCandidate(candidate, verdict) {
  const base = normalizeCandidate(candidate);
  const verification = {
    passed: verdict.passed === true,
    verifier: verdict.verifier,
    checked: verdict.checked || [],
    reason: verdict.reason,
    stage: 'candidate',
  };
  if (verdict.passed === true) {
    if (!SEVERITIES.has(base.proposedSeverity)) throw new Error('confirmed candidate requires a valid severity');
    if (!base.evidence.length) throw new Error('confirmed candidate requires evidence');
    return { ...base, severity: base.proposedSeverity, verdict: 'confirmed', verification };
  }
  const blocker = verdict.blocker || (verdict.unverifiable || []).join('; ');
  if (blocker) {
    if (!verdict.validationPlan) throw new Error('needs_validation candidate requires validationPlan');
    const { proposedSeverity: _drop, ...withoutSeverity } = base;
    return { ...withoutSeverity, verdict: 'needs_validation', blocker, validationPlan: verdict.validationPlan, verification };
  }
  const { proposedSeverity: _drop, ...withoutSeverity } = base;
  return { ...withoutSeverity, verdict: 'rejected', rejectionReason: verdict.reason || 'independent verification rejected the claim', verification };
}

export function verifyFinalRecord(record, verdict) {
  if (record.verdict !== 'confirmed') return record;
  if (verdict.passed !== true) {
    const { severity: _drop, ...withoutSeverity } = record;
    if (verdict.blocker) return {
      ...withoutSeverity, verdict: 'needs_validation', blocker: verdict.blocker,
      validationPlan: verdict.validationPlan || 'repeat final-record verification with the missing evidence',
      verification: { ...verdict, stage: 'final-record', passed: false },
    };
    return {
      ...withoutSeverity, verdict: 'rejected', rejectionReason: verdict.reason || 'final record verification failed',
      verification: { ...verdict, stage: 'final-record', passed: false },
    };
  }
  return { ...record, verification: { ...verdict, stage: 'final-record', passed: true } };
}

export function partitionVerdicts(records) {
  return records.reduce((out, record) => { out[record.verdict].push(record); return out; }, { confirmed: [], needs_validation: [], rejected: [] });
}
