import { createHash } from 'node:crypto';

export const AUDIT_PROFILES = Object.freeze(['quick', 'standard', 'deep']);
export const COVERAGE_STATES = Object.freeze(['planned', 'assigned', 'covered', 'candidate', 'deferred', 'blocked', 'out_of_scope']);
export const VERDICTS = Object.freeze(['confirmed', 'needs_validation', 'rejected']);
export const ATTACK_CLASSES = Object.freeze([
  'authentication-session', 'authorization-object-access', 'injection-interpreter', 'file-path-parser',
  'ssrf-egress', 'secrets-cryptography', 'data-isolation-lifecycle', 'logging-error-disclosure',
  'business-logic-race', 'supply-chain-release', 'cloud-deployment-identity', 'client-side-browser',
  'protocol-messaging', 'resource-exhaustion', 'ai-agent-tool-boundary', 'memory-safety-binary',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonicalJson = (value) => JSON.stringify(value, Object.keys(value || {}).sort());
export const contentHash = (value) => sha256(typeof value === 'string' ? value : canonicalJson(value));

function requireField(errors, object, key, test = nonEmpty) {
  if (!test(object[key])) errors.push(`${key} is required`);
}

export function validateRunMetadata(value) {
  const errors = [];
  if (!isObject(value)) return ['run metadata must be an object'];
  requireField(errors, value, 'kind', (x) => x === 'maxwell.security-audit.run');
  requireField(errors, value, 'schemaVersion', (x) => x === '1');
  for (const key of ['runId', 'sessionId', 'companyId', 'workflow', 'sourceRef']) requireField(errors, value, key);
  requireField(errors, value, 'profile', (x) => AUDIT_PROFILES.includes(x));
  requireField(errors, value, 'executionPolicy', (x) => x === 'sandboxed-source-and-local-only');
  if (!Array.isArray(value.scopePaths)) errors.push('scopePaths must be an array');
  if (!(value.budget === null || Number.isInteger(value.budget) && value.budget > 0)) errors.push('budget must be null or a positive integer');
  return errors;
}

export function validateCoverageLedger(value) {
  const errors = [];
  if (!isObject(value)) return ['coverage ledger must be an object'];
  requireField(errors, value, 'kind', (x) => x === 'maxwell.security-audit.coverage');
  requireField(errors, value, 'schemaVersion', (x) => x === '1');
  requireField(errors, value, 'runId');
  if (!Array.isArray(value.units)) return [...errors, 'units must be an array'];
  const ids = new Set();
  value.units.forEach((unit, index) => {
    const at = `units[${index}]`;
    if (!isObject(unit)) { errors.push(`${at} must be an object`); return; }
    for (const key of ['id', 'repo', 'subsystem', 'boundary']) if (!nonEmpty(unit[key])) errors.push(`${at}.${key} is required`);
    if (!ATTACK_CLASSES.includes(unit.attackClass)) errors.push(`${at}.attackClass is invalid`);
    if (!COVERAGE_STATES.includes(unit.state)) errors.push(`${at}.state is invalid`);
    if (ids.has(unit.id)) errors.push(`${at}.id is duplicated`); else ids.add(unit.id);
    if (unit.state === 'assigned' && !nonEmpty(unit.owner)) errors.push(`${at}.owner is required while assigned`);
    if (['covered', 'candidate'].includes(unit.state) && (!Array.isArray(unit.evidence) || !unit.evidence.length)) errors.push(`${at}.evidence is required for ${unit.state}`);
    if (['deferred', 'blocked', 'out_of_scope'].includes(unit.state) && !nonEmpty(unit.reason)) errors.push(`${at}.reason is required for ${unit.state}`);
  });
  return errors;
}

export function validateCandidateRecords(value) {
  const errors = [];
  if (!isObject(value)) return ['candidate export must be an object'];
  requireField(errors, value, 'kind', (x) => x === 'maxwell.security-audit.candidates');
  requireField(errors, value, 'schemaVersion', (x) => x === '1');
  requireField(errors, value, 'runId');
  if (!Array.isArray(value.records)) return [...errors, 'records must be an array'];
  const fingerprints = new Set();
  value.records.forEach((record, index) => {
    const at = `records[${index}]`;
    if (!isObject(record)) { errors.push(`${at} must be an object`); return; }
    for (const key of ['fingerprint', 'coverageUnitId', 'title', 'sourceTrace']) if (!nonEmpty(record[key])) errors.push(`${at}.${key} is required`);
    if (!VERDICTS.includes(record.verdict)) errors.push(`${at}.verdict is invalid`);
    if (fingerprints.has(record.fingerprint)) errors.push(`${at}.fingerprint is duplicated`); else fingerprints.add(record.fingerprint);
    if (record.verdict === 'confirmed') {
      if (!nonEmpty(record.severity)) errors.push(`${at}.severity is required for confirmed`);
      if (!Array.isArray(record.evidence) || !record.evidence.length) errors.push(`${at}.evidence is required for confirmed`);
      if (!isObject(record.verification) || record.verification.passed !== true) errors.push(`${at}.verification.passed must be true for confirmed`);
    }
    if (record.verdict === 'needs_validation') {
      if ('severity' in record) errors.push(`${at}.severity must be omitted for needs_validation`);
      if (!nonEmpty(record.blocker)) errors.push(`${at}.blocker is required for needs_validation`);
      if (!nonEmpty(record.validationPlan)) errors.push(`${at}.validationPlan is required for needs_validation`);
    }
    if (record.verdict === 'rejected' && !nonEmpty(record.rejectionReason)) errors.push(`${at}.rejectionReason is required for rejected`);
  });
  return errors;
}

export function validateAuditExport(value) {
  if (!isObject(value)) return ['audit export must be an object'];
  if (value.kind === 'maxwell.security-audit.run') return validateRunMetadata(value);
  if (value.kind === 'maxwell.security-audit.coverage') return validateCoverageLedger(value);
  if (value.kind === 'maxwell.security-audit.candidates') return validateCandidateRecords(value);
  if (value.kind === 'maxwell.security-audit.architecture') {
    const errors = [];
    requireField(errors, value, 'schemaVersion', (x) => x === '1');
    requireField(errors, value, 'runId');
    if (!Array.isArray(value.repositories)) errors.push('repositories must be an array');
    return errors;
  }
  if (value.kind === 'maxwell.security-audit.final-records') {
    return validateCandidateRecords({ ...value, kind: 'maxwell.security-audit.candidates' });
  }
  return [`unsupported security-audit kind: ${String(value.kind)}`];
}
