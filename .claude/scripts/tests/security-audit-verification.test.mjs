import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateFingerprint, decideCandidate, normalizeCandidate, partitionVerdicts, verifyFinalRecord } from '../security-audit/verification.mjs';

const candidate = { coverageUnitId: 'cov_1', title: 'Cross-tenant read', ruleId: 'asvs-v8-idor-account-id', targetKey: 'repo:app/api', location: { path: './src//account.js', startLine: 9 }, sourceTrace: 'request.accountId -> lookup', boundary: 'tenant', evidence: ['src/account.js:9'], regulatoryRefs: [{ instrument: 'owasp-asvs-5.0', controlId: 'V8.2.2' }], severity: 'high' };

test('normalizes paths and derives stable fingerprints', () => {
  const normalized = normalizeCandidate(candidate);
  assert.equal(normalized.location.path, 'src/account.js');
  assert.equal(normalized.fingerprint, candidateFingerprint(candidate));
});

test('candidate verification produces confirmed, needs_validation, and rejected records', () => {
  const confirmed = decideCandidate(candidate, { passed: true, verifier: 'v1', checked: ['src/account.js'], reason: 'trace confirmed' });
  const blocked = decideCandidate(candidate, { passed: false, verifier: 'v2', blocker: 'sandbox missing', validationPlan: 'run isolated fixture' });
  const rejected = decideCandidate(candidate, { passed: false, verifier: 'v3', reason: 'authorization middleware rejects mismatch' });
  assert.deepEqual(partitionVerdicts([confirmed, blocked, rejected]), { confirmed: [confirmed], needs_validation: [blocked], rejected: [rejected] });
  assert.equal('severity' in blocked, false);
});

test('final verification can downgrade but never silently keep a failed confirmation', () => {
  const confirmed = decideCandidate(candidate, { passed: true, verifier: 'v1' });
  assert.equal(verifyFinalRecord(confirmed, { passed: false, verifier: 'v2', blocker: 'generated route table unavailable' }).verdict, 'needs_validation');
  assert.equal(verifyFinalRecord(confirmed, { passed: false, verifier: 'v2', reason: 'wrong sink' }).verdict, 'rejected');
  assert.equal(verifyFinalRecord(confirmed, { passed: true, verifier: 'v2', checked: ['src/account.js:9'] }).verification.stage, 'final-record');
});
