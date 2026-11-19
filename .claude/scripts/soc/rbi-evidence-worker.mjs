// Fixed program for the permission-limited Node subprocess. No network, filesystem or shell APIs are used here.
import { reviewEvidence } from './rbi-review-model.mjs';
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('Evidence payload exceeds 1 MiB.');
    chunks.push(chunk);
  }
  const { previous, edits, finalize } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify({ worksheet: reviewEvidence(previous, edits, finalize) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
