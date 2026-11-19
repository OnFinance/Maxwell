#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { appendRecords, ledgerPathFor } from '../lib/ledger.mjs';
import { ledgerValidator, planArtexImport, readArtexAssessment } from './artex.mjs';

try {
  const { values } = parseArgs({ options: {
    company: { type: 'string' }, app: { type: 'string' }, source: { type: 'string' },
    file: { type: 'string' }, control: { type: 'string' }, confirm: { type: 'boolean' }
  } });
  if (!values.file || !statSync(values.file).isFile() || statSync(values.file).size > 512 * 1024) throw new Error('Supply --file with a CSV of at most 512 KiB.');
  const csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(values.file));
  const assessment = readArtexAssessment({ csv, companyId: values.company, application: values.app, source: values.source, control: values.control });
  if (!existsSync(join('company-profile', values.company, 'details.json')) || !existsSync(join('applications', values.app, 'README.md'))) throw new Error('Select an existing company and application in the current Maxwell workspace.');
  const path = ledgerPathFor(values.company);
  const plan = planArtexImport(assessment, existsSync(path) ? readFileSync(path, 'utf8') : '');
  let written = 0;
  if (values.confirm && plan.records.length) {
    const result = appendRecords(values.company, plan.records, { validate: ledgerValidator() });
    if (result.problems.length) throw new Error(result.problems.join('\n'));
    written = result.appended;
  }
  console.log(JSON.stringify({ mode: values.confirm ? 'commit' : 'preview', company: values.company, application: values.app, source: values.source, control: values.control, digest: assessment.digest, rows: plan.rows, written }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
