#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateAuditExport } from './contracts.mjs';

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: validate.mjs <security-audit.export.json> [...]');
  process.exit(2);
}

let failed = false;
for (const path of paths) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    const errors = validateAuditExport(value);
    if (errors.length) {
      failed = true;
      console.error(`${path}:\n- ${errors.join('\n- ')}`);
    } else console.log(`${path}: valid`);
  } catch (error) {
    failed = true;
    console.error(`${path}: ${error.message}`);
  }
}
if (failed) process.exit(1);
