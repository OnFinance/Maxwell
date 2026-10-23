#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { writeAuditBundle } from './exports.mjs';

const [bundlePath] = process.argv.slice(2);
if (!bundlePath) {
  console.error('usage: write-exports.mjs <bundle.json>');
  process.exit(2);
}
const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
const written = await writeAuditBundle(bundle);
console.log(JSON.stringify({ written }));
