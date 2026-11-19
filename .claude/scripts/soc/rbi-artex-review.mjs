// Prepare a reviewer worksheet from one completed report. stdin and stdout are the only data channels.
import { createHash } from 'node:crypto';
import { readArtex } from './artex-csv.mjs';

import { createWorksheet } from './rbi-review-model.mjs';

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error('Report exceeds 512 KiB.');
    chunks.push(chunk);
  }
  const report = Buffer.concat(chunks);
  const rows = readArtex(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(report));
  console.log(JSON.stringify(createWorksheet(createHash('sha256').update(report).digest('hex'), rows), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
