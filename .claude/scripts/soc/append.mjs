#!/usr/bin/env node
// Appends one validated record to company-profile/<company_id>/soc/main.jsonl.
// Usage: node .claude/scripts/soc/append.mjs <company_id> <record.json | -> [--allow-duplicate-id]
// The ledger is append-only: existing lines are never rewritten. A record with an id that already exists must
// set "supersedes" to that id (or pass --allow-duplicate-id for observations that legitimately repeat).
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';

const [companyId, source, ...flags] = process.argv.slice(2);
if (!companyId || !source) {
  console.error('usage: append.mjs <company_id> <record.json | -> [--allow-duplicate-id]');
  process.exit(1);
}
const ledgerPath = `company-profile/${companyId}/soc/main.jsonl`;
const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
let record;
try { record = JSON.parse(raw); } catch (e) { console.error(`record is not valid JSON: ${e.message}`); process.exit(1); }
if (record.companyId && record.companyId !== companyId) { console.error(`record.companyId ${record.companyId} != ${companyId}`); process.exit(2); }

const { ajv } = buildAjv();
const validate = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/soc/record.schema.json');
if (!validate(record)) {
  console.error(`record does not match soc/record.schema.json:\n${formatErrors(validate.errors)}`);
  process.exit(2);
}

const existingIds = new Set();
if (existsSync(ledgerPath)) {
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { existingIds.add(JSON.parse(line).id); } catch { /* validated elsewhere */ }
  }
}
if (existingIds.has(record.id) && !record.supersedes && !flags.includes('--allow-duplicate-id')) {
  console.error(`id ${record.id} already exists in the ledger; set "supersedes" or append a new id`);
  process.exit(2);
}
if (record.supersedes && !existingIds.has(record.supersedes)) {
  console.error(`supersedes ${record.supersedes} but no such id exists in the ledger`);
  process.exit(2);
}

mkdirSync(dirname(ledgerPath), { recursive: true });
const needsNewline = existsSync(ledgerPath) && readFileSync(ledgerPath, 'utf8').length > 0 && !readFileSync(ledgerPath, 'utf8').endsWith('\n');
appendFileSync(ledgerPath, (needsNewline ? '\n' : '') + JSON.stringify(record) + '\n');
console.log(`${record.kind} ${record.id} appended to ${ledgerPath}`);
