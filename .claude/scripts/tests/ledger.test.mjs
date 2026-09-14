import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecords, ledgerPathFor, readLedger } from '../lib/ledger.mjs';

// A valid control record from the schema's own tests.
const suite = JSON.parse(readFileSync('.claude/schemas/tests/soc/record.test.json', 'utf8'));
const base = suite.tests.find((t) => t.valid && t.data.kind === 'control').data;
const COMPANY = base.companyId;

const withRoot = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'maxwell-ledger-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('a batch is appended in one go, including a supersession of a record earlier in the batch', () => withRoot((root) => {
  const r = appendRecords(COMPANY, [base, { ...base, supersedes: base.id, implementationStatus: 'implemented' }], { root });
  assert.deepEqual(r, { appended: 2, problems: [] });
  assert.deepEqual(readLedger(COMPANY, root).map((x) => x.implementationStatus), [base.implementationStatus, 'implemented']);
}));

test('one bad record rejects the whole batch and writes nothing', () => withRoot((root) => {
  const r = appendRecords(COMPANY, [base, { ...base }], { root });
  assert.equal(r.appended, 0);
  assert.match(r.problems.join('\n'), /already exists in the ledger/);
  assert.equal(readLedger(COMPANY, root).length, 0);
  const bad = appendRecords(COMPANY, [{ ...base, implementationStatus: 'done' }], { root });
  assert.match(bad.problems[0], /does not match soc\/record.schema.json/);
}));

test('dangling supersedes, foreign companies and dry runs are handled', () => withRoot((root) => {
  assert.match(appendRecords(COMPANY, [{ ...base, supersedes: base.id }], { root }).problems[0], /no such id exists/);
  assert.match(appendRecords('other-company', [base], { root }).problems.join('\n'), /companyId .* != other-company/);
  assert.deepEqual(appendRecords(COMPANY, [base], { root, dryRun: true }), { appended: 0, problems: [] });
  assert.equal(readLedger(COMPANY, root).length, 0);
  assert.match(ledgerPathFor(COMPANY, root), /company-profile\/.+\/soc\/main\.jsonl$/);
}));
