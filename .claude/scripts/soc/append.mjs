#!/usr/bin/env node
// Appends validated records to company-profile/<company_id>/soc/main.jsonl.
// Usage: node .claude/scripts/soc/append.mjs <company_id> <record.json | records.jsonl | -> [--allow-duplicate-id]
// A JSON document is one record; JSONL (one record per line) is a batch that is checked in full and appended
// all-or-nothing. The ledger is append-only: existing lines are never rewritten. A record with an id that already
// exists must set "supersedes" to that id (or pass --allow-duplicate-id for observations that legitimately repeat).
import { readFileSync } from 'node:fs';
import { appendRecords, ledgerPathFor } from '../lib/ledger.mjs';

const [companyId, source, ...flags] = process.argv.slice(2);
if (!companyId || !source) {
  console.error('usage: append.mjs <company_id> <record.json | records.jsonl | -> [--allow-duplicate-id]');
  process.exit(1);
}
const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
let records;
try {
  records = [JSON.parse(raw)];
} catch {
  try {
    records = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch (e) { console.error(`record is not valid JSON or JSONL: ${e.message}`); process.exit(1); }
}
if (!records.length) { console.error('no records to append'); process.exit(1); }

const { appended, problems } = appendRecords(companyId, records, { allowDuplicateIds: flags.includes('--allow-duplicate-id') });
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
const ledgerPath = ledgerPathFor(companyId);
console.log(appended === 1 ? `${records[0].kind} ${records[0].id} appended to ${ledgerPath}` : `${appended} records appended to ${ledgerPath}`);
