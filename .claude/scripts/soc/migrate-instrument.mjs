#!/usr/bin/env node
// Moves a company off an instrument the registry marks repealed or superseded and onto its successor:
// - details.json frameworksInScope lists the successor instead;
// - control records of the old instrument are superseded as not-applicable, naming their successor controls;
// - successor catalog controls that apply to the company are appended as new control records;
// - open findings, risks and incidents citing the old instrument are superseded with successor refs;
// - a soc version diff is written.
// Everything is validated before anything is written, and ledger records are appended all-or-nothing.
// Usage: node .claude/scripts/soc/migrate-instrument.mjs <company_id> --from <instrumentId> [--to <instrumentId>]
//        [--now <RFC3339 Z>] [--session <id>] [--run <run_id>] [--dry-run]
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';
import { RECORD_SCHEMA, appendRecords, readLedger } from '../lib/ledger.mjs';
import { planMigration } from '../lib/instrument-migration.mjs';

const DETAILS_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/company/details.schema.json';
const REGISTRY = '.claude/skills/regulatory-catalogs/references/instruments.json';

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { from: { type: 'string' }, to: { type: 'string' }, now: { type: 'string' }, session: { type: 'string' }, run: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
} catch (err) { console.error(err.message); process.exit(1); }
const { values: flags, positionals: [companyId] } = parsed;
if (!companyId || !flags.from) {
  console.error('usage: migrate-instrument.mjs <company_id> --from <instrumentId> [--to <instrumentId>] [--now <ts>] [--session <id>] [--run <run_id>] [--dry-run]');
  process.exit(1);
}
const now = flags.now || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now)) { console.error('--now must be RFC 3339 UTC with a trailing Z'); process.exit(1); }

const detailsPath = `company-profile/${companyId}/details.json`;
if (!existsSync(detailsPath)) { console.error(`${detailsPath} does not exist`); process.exit(1); }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const details = readJson(detailsPath);
const registry = readJson(REGISTRY);
const oldEntry = (registry.instruments || []).find((i) => i.instrumentId === flags.from);
const to = flags.to || (oldEntry && oldEntry.supersededBy && oldEntry.supersededBy.length === 1 ? oldEntry.supersededBy[0] : undefined);
if (!to) { console.error(`--to is required: ${flags.from} has ${oldEntry ? (oldEntry.supersededBy || []).length : 0} successors in the registry`); process.exit(1); }
const catalogPath = `.claude/skills/regulatory-catalogs/references/catalogs/${to}.catalog.json`;
if (!existsSync(catalogPath)) { console.error(`no catalog for ${to} at ${catalogPath}`); process.exit(1); }

const provenance = {
  harness: 'script', generatedAt: now, workflow: 'manual', agent: 'soc/migrate-instrument',
  ...(flags.session ? { sessionId: flags.session } : {}), ...(flags.run ? { runId: flags.run } : {}),
};

let plan;
try {
  plan = planMigration({ companyId, details, registry, catalog: readJson(catalogPath), ledger: readLedger(companyId), from: flags.from, to, now, provenance, catalogPath, registryPath: REGISTRY });
} catch (err) { console.error(err.message); process.exit(2); }

const { ajv } = buildAjv();
const problems = [];
if (plan.detailsChanged) {
  const checkDetails = getValidator(ajv, DETAILS_SCHEMA);
  if (!checkDetails(plan.details)) problems.push(`${detailsPath} would not match its schema:\n${formatErrors(checkDetails.errors)}`);
}
problems.push(...appendRecords(companyId, plan.records, { dryRun: true, validate: getValidator(ajv, RECORD_SCHEMA) }).problems);
if (problems.length) {
  console.error(`migration not applied (${problems.length} problem(s)):\n- ${problems.join('\n- ')}`);
  process.exit(2);
}

const report = { companyId, now, dryRun: Boolean(flags['dry-run']), detailsChanged: plan.detailsChanged, records: plan.records.length, ...plan.summary };
if (flags['dry-run']) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

if (plan.detailsChanged) writeFileSync(detailsPath, JSON.stringify(plan.details, null, 2) + '\n');
const { appended, problems: late } = appendRecords(companyId, plan.records, { validate: getValidator(ajv, RECORD_SCHEMA) });
if (late.length) { console.error(`ledger append failed after details.json was written:\n- ${late.join('\n- ')}`); process.exit(2); }
report.appended = appended;
if (appended) {
  const v = spawnSync(process.execPath, ['.claude/scripts/soc/version.mjs', companyId, '--workflow', 'manual', ...(flags.session ? ['--session', flags.session] : [])], { encoding: 'utf8' });
  report.version = (v.stdout || v.stderr || '').trim();
  if (v.status !== 0) { console.log(JSON.stringify(report, null, 2)); console.error('version.mjs failed'); process.exit(v.status || 1); }
}
console.log(JSON.stringify(report, null, 2));
