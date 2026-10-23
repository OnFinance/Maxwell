import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateAuditExport } from './contracts.mjs';

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILES = Object.freeze({
  run: 'execute-scr.run.export.json',
  architecture: 'execute-scr.architecture.export.json',
  coverage: 'execute-scr.coverage.export.json',
  candidates: 'execute-scr.candidates.export.json',
  finalRecords: 'execute-scr.final-records.export.json',
});

function safeSegment(value, name) {
  if (!SEGMENT.test(String(value || ''))) throw new Error(`${name} is not a safe path segment`);
  return String(value);
}

export function auditExportPaths(sessionId, root = 'kpis/data/raw/sessions') {
  const safeSession = safeSegment(sessionId, 'sessionId');
  const directory = path.join(root, safeSession);
  return Object.fromEntries(Object.entries(FILES).map(([key, name]) => [key, path.join(directory, name)]));
}

export async function writeAuditBundle({ sessionId, run, architecture, coverage, candidates, finalRecords }, { root } = {}) {
  const paths = auditExportPaths(sessionId, root);
  const documents = { run, architecture, coverage, candidates, finalRecords };
  for (const [key, document] of Object.entries(documents)) {
    const errors = validateAuditExport(document);
    if (errors.length) throw new Error(`${key}: ${errors.join('; ')}`);
  }
  await mkdir(path.dirname(paths.run), { recursive: true });
  const written = [];
  for (const key of Object.keys(documents)) {
    await writeFile(paths[key], `${JSON.stringify(documents[key], null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    written.push(paths[key]);
  }
  return written;
}

export function mapVerdictsToSoc(records, { collectedAt }) {
  const findings = [];
  const observations = [];
  const excluded = [];
  for (const record of records) {
    if (record.verdict === 'confirmed') {
      findings.push(record);
      continue;
    }
    if (record.verdict === 'needs_validation' && Array.isArray(record.regulatoryRefs) && record.regulatoryRefs.length) {
      observations.push({
        title: `Validation required: ${record.title}`,
        description: `${record.blocker}. Validation plan: ${record.validationPlan}`,
        area: record.coverageUnitId,
        result: 'inconclusive',
        regulatoryRefs: record.regulatoryRefs,
        evidence: record.evidence || [],
        collectedAt,
        auditFingerprint: record.fingerprint,
      });
      continue;
    }
    excluded.push({ fingerprint: record.fingerprint, verdict: record.verdict, reason: record.rejectionReason || record.blocker || 'not eligible for SOC ledger' });
  }
  return { findings, observations, excluded };
}
