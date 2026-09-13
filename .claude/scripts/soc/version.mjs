#!/usr/bin/env node
// Writes company-profile/<company_id>/soc/versions/commit_<n>.diff capturing everything appended to the
// ledger since the previous version. Because the ledger is append-only, the previous state is a prefix of
// the current file; the prefix hash is verified against the last diff's header so tampering is detected.
// Usage: node .claude/scripts/soc/version.mjs <company_id> [--session <session_id>] [--workflow <name>] [--force]
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const companyId = args[0];
if (!companyId) { console.error('usage: version.mjs <company_id> [--session id] [--workflow name] [--force]'); process.exit(1); }
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const force = args.includes('--force');

const ledgerPath = `company-profile/${companyId}/soc/main.jsonl`;
const versionsDir = `company-profile/${companyId}/soc/versions`;
if (!existsSync(ledgerPath)) { console.error(`${ledgerPath} does not exist`); process.exit(1); }
const content = readFileSync(ledgerPath, 'utf8');
const lines = content.split('\n').filter((l, i, a) => !(l === '' && i === a.length - 1));
const sha = (text) => createHash('sha256').update(text).digest('hex');

mkdirSync(versionsDir, { recursive: true });
const existing = readdirSync(versionsDir).map((f) => /^commit_(\d+)\.diff$/.exec(f)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
const last = existing.length ? existing[existing.length - 1] : 0;
let prevLines = 0; let prevHash = sha('');
if (last > 0) {
  const header = readFileSync(`${versionsDir}/commit_${last}.diff`, 'utf8');
  prevLines = Number((/^# maxwell-soc-lines: (\d+)$/m.exec(header) || [])[1] || 0);
  prevHash = (/^# maxwell-soc-to: ([a-f0-9]{64})$/m.exec(header) || [])[1] || prevHash;
  const prefix = lines.slice(0, prevLines).map((l) => l + '\n').join('');
  if (sha(prefix) !== prevHash && !force) {
    console.error(`ledger prefix (${prevLines} lines) no longer matches commit_${last}.diff; the append-only ledger was modified. Investigate or re-run with --force to record a full rewrite.`);
    process.exit(2);
  }
}
const added = lines.slice(prevLines);
if (added.length === 0 && !force) { console.log('no new ledger lines since last version; nothing written'); process.exit(0); }

const n = last + 1;
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const header = [
  `# maxwell-soc-version: ${n}`,
  `# maxwell-soc-company: ${companyId}`,
  `# maxwell-soc-generated-at: ${now}`,
  `# maxwell-soc-session: ${opt('--session') || 'unknown'}`,
  `# maxwell-soc-workflow: ${opt('--workflow') || 'manual'}`,
  `# maxwell-soc-from: ${prevHash}`,
  `# maxwell-soc-to: ${sha(lines.map((l) => l + '\n').join(''))}`,
  `# maxwell-soc-lines: ${lines.length}`,
  `# maxwell-soc-added: ${added.length}`,
];
const hunk = `@@ -${prevLines},0 +${prevLines + 1},${added.length} @@`;
const diff = [...header, `--- a/soc/main.jsonl`, `+++ b/soc/main.jsonl`, hunk, ...added.map((l) => '+' + l)].join('\n') + '\n';
writeFileSync(`${versionsDir}/commit_${n}.diff`, diff);
console.log(`${versionsDir}/commit_${n}.diff written (+${added.length} lines)`);
