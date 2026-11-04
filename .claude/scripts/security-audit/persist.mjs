#!/usr/bin/env node
import { writeAuditBundle } from './exports.mjs';

// Fixed destination under the workspace; caller cannot redirect output with a root argument.
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('bundle too large');
    chunks.push(chunk);
  }
  const bundle = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const written = await writeAuditBundle(bundle);
  console.log(JSON.stringify({ written, validated: true }));
} catch {
  console.error('Audit persistence failed: invalid bundle, existing export, or filesystem error. No existing export was overwritten.');
  process.exitCode = 1;
}
