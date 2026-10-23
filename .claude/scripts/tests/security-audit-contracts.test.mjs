import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuditExport, validateCandidateRecords, validateCoverageLedger } from '../security-audit/contracts.mjs';

test('accepts a complete coverage ledger', () => {
  const errors = validateCoverageLedger({
    schemaVersion: '1', kind: 'maxwell.security-audit.coverage', runId: 'run_1',
    units: [{ id: 'cov_a', repo: 'app/repo', subsystem: 'api', boundary: 'http', attackClass: 'authorization-object-access', state: 'covered', evidence: ['src/api.js:12'] }],
  });
  assert.deepEqual(errors, []);
});

test('requires evidence for covered units and owners for assignments', () => {
  const errors = validateCoverageLedger({
    schemaVersion: '1', kind: 'maxwell.security-audit.coverage', runId: 'run_1',
    units: [
      { id: 'a', repo: 'app/repo', subsystem: 'api', boundary: 'http', attackClass: 'injection-interpreter', state: 'covered' },
      { id: 'b', repo: 'app/repo', subsystem: 'jobs', boundary: 'queue', attackClass: 'protocol-messaging', state: 'assigned' },
    ],
  });
  assert(errors.some((x) => x.includes('evidence')));
  assert(errors.some((x) => x.includes('owner')));
});

test('enforces all three candidate verdict contracts', () => {
  const base = { schemaVersion: '1', kind: 'maxwell.security-audit.candidates', runId: 'run_1' };
  const records = [
    { fingerprint: 'a', coverageUnitId: 'u1', title: 'Confirmed', sourceTrace: 'input -> sink', verdict: 'confirmed', severity: 'high', evidence: ['a.js:1'], verification: { passed: true } },
    { fingerprint: 'b', coverageUnitId: 'u2', title: 'Blocked', sourceTrace: 'request -> service', verdict: 'needs_validation', blocker: 'sandbox unavailable', validationPlan: 'repeat with configured sandbox' },
    { fingerprint: 'c', coverageUnitId: 'u3', title: 'Rejected', sourceTrace: 'body -> parser', verdict: 'rejected', rejectionReason: 'parser validates the input' },
  ];
  assert.deepEqual(validateCandidateRecords({ ...base, records }), []);
  assert(validateCandidateRecords({ ...base, records: [{ ...records[1], severity: 'medium' }] }).some((x) => x.includes('must be omitted')));
});

test('rejects unknown export kinds', () => {
  assert.deepEqual(validateAuditExport({ kind: 'unknown' }), ['unsupported security-audit kind: unknown']);
});
