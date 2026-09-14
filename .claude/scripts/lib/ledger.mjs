// Append-only access to company-profile/<company_id>/soc/main.jsonl, shared by soc/append.mjs and
// soc/migrate-instrument.mjs. Existing lines are never rewritten: a record whose id already exists must set
// "supersedes" to that id (or the caller allows duplicate ids for observations that legitimately repeat).
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildAjv, getValidator, formatErrors } from './schemas.mjs';

export const RECORD_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/soc/record.schema.json';

export const ledgerPathFor = (companyId, root = '.') => join(root, 'company-profile', companyId, 'soc', 'main.jsonl');

export function readLedger(companyId, root = '.') {
  const path = ledgerPathFor(companyId, root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Last line wins: the current state of every record id.
export function latestById(records) {
  const latest = new Map();
  for (const r of records) latest.set(r.id, r);
  return latest;
}

// Checks every record (schema, companyId, duplicate ids, dangling supersedes, earlier records of the same batch
// included) and then appends all of them or none. Returns { appended, problems }.
export function appendRecords(companyId, records, { root = '.', allowDuplicateIds = false, dryRun = false, validate } = {}) {
  const check = validate || getValidator(buildAjv().ajv, RECORD_SCHEMA);
  const path = ledgerPathFor(companyId, root);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const ids = new Set();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { ids.add(JSON.parse(line).id); } catch { /* validated elsewhere */ }
  }
  const problems = [];
  records.forEach((record, i) => {
    const where = records.length > 1 ? `record ${i + 1} (${record && record.id})` : `record ${record && record.id}`;
    if (!record || typeof record !== 'object') { problems.push(`${where} is not a JSON object`); return; }
    if (record.companyId && record.companyId !== companyId) problems.push(`${where}: companyId ${record.companyId} != ${companyId}`);
    if (!check(record)) problems.push(`${where} does not match soc/record.schema.json:\n${formatErrors(check.errors)}`);
    if (ids.has(record.id) && !record.supersedes && !allowDuplicateIds) problems.push(`id ${record.id} already exists in the ledger; set "supersedes" or append a new id`);
    if (record.supersedes && !ids.has(record.supersedes)) problems.push(`supersedes ${record.supersedes} but no such id exists in the ledger`);
    ids.add(record.id);
  });
  if (problems.length || dryRun || !records.length) return { appended: 0, problems };
  mkdirSync(dirname(path), { recursive: true });
  const separator = content.length && !content.endsWith('\n') ? '\n' : '';
  appendFileSync(path, separator + records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { appended: records.length, problems };
}
