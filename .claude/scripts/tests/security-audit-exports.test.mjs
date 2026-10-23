import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditExportPaths, mapVerdictsToSoc, writeAuditBundle } from '../security-audit/exports.mjs';

const run = { schemaVersion: '1', kind: 'maxwell.security-audit.run', runId: 'run_1', sessionId: 'session-1', companyId: 'co', workflow: 'execute-scr', sourceRef: 'abc', profile: 'standard', executionPolicy: 'sandboxed-source-and-local-only', scopePaths: [], budget: null };
const architecture = { schemaVersion: '1', kind: 'maxwell.security-audit.architecture', runId: 'run_1', repositories: [] };
const coverage = { schemaVersion: '1', kind: 'maxwell.security-audit.coverage', runId: 'run_1', units: [] };
const candidates = { schemaVersion: '1', kind: 'maxwell.security-audit.candidates', runId: 'run_1', records: [] };
const finalRecords = { schemaVersion: '1', kind: 'maxwell.security-audit.final-records', runId: 'run_1', records: [] };

test('export paths reject traversal', () => {
  assert.throws(() => auditExportPaths('../escape'), /safe path segment/);
});

test('writes a complete immutable bundle', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'maxwell-audit-'));
  const files = await writeAuditBundle({ sessionId: 'session-1', run, architecture, coverage, candidates, finalRecords }, { root });
  assert.equal(files.length, 5);
  assert.equal(JSON.parse(await readFile(files[2], 'utf8')).kind, 'maxwell.security-audit.coverage');
  await assert.rejects(() => writeAuditBundle({ sessionId: 'session-1', run, architecture, coverage, candidates, finalRecords }, { root }), /EEXIST/);
});

test('only confirmed records become findings and rejected records never enter SOC', () => {
  const confirmed = { fingerprint: 'a', verdict: 'confirmed', title: 'A' };
  const needs = { fingerprint: 'b', verdict: 'needs_validation', title: 'B', coverageUnitId: 'u', blocker: 'sandbox missing', validationPlan: 'configure sandbox', regulatoryRefs: [{ instrument: 'x', controlId: 'y' }], evidence: ['a.js:1'] };
  const rejected = { fingerprint: 'c', verdict: 'rejected', title: 'C', rejectionReason: 'false trace' };
  const mapped = mapVerdictsToSoc([confirmed, needs, rejected], { collectedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(mapped.findings, [confirmed]);
  assert.equal(mapped.observations[0].result, 'inconclusive');
  assert.deepEqual(mapped.excluded, [{ fingerprint: 'c', verdict: 'rejected', reason: 'false trace' }]);
});
