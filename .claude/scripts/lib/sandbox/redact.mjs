// Redaction applied to scanner results and runtime command output before anything is written or printed. Uses the
// same secret patterns as the write-guard hook, so text that would be blocked on write is never produced.
import { SECRET_PATTERNS } from '../../../hooks/lib.mjs';

export function redactSecrets(text) {
  let count = 0;
  let out = String(text ?? '');
  for (const [re] of SECRET_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    out = out.replace(global, (m) => {
      count += 1;
      const kv = /^("[^"]+"\s*:\s*")/.exec(m);
      return kv ? `${kv[1]}[REDACTED]"` : '[REDACTED]';
    });
  }
  return { text: out, count };
}
