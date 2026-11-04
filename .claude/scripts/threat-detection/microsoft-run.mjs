#!/usr/bin/env node
// Offline Microsoft Graph record JSONL replay. This command never contacts Microsoft.
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { microsoftScope, normalizeEntraSignIn, normalizeDefenderAlert } from './microsoft-adapter.mjs';
import { DetectionEngine } from './engine.mjs';

async function main() {
  const { values } = parseArgs({ options: { company: { type: 'string' }, tenant: { type: 'string' },
    source: { type: 'string' }, mode: { type: 'string', default: 'normalize' },
    'replay-now': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('node .claude/scripts/threat-detection/microsoft-run.mjs --company <id> --tenant <UUID> --source entra|defender [--mode normalize|detect] [--replay-now <UTC milliseconds>] < records.jsonl');
    return;
  }
  const config = microsoftScope({ companyId: values.company, tenantId: values.tenant });
  if (!['entra', 'defender'].includes(values.source) || !['normalize', 'detect'].includes(values.mode)) throw new Error('invalid source/mode');
  const now = values['replay-now'] === undefined ? null : Date.parse(values['replay-now']);
  if (now !== null && (!Number.isFinite(now) || new Date(now).toISOString() !== values['replay-now'])) throw new Error('invalid replay time');
  const engine = values.source === 'entra' && values.mode === 'detect' ? new DetectionEngine(config) : null;
  const stats = { received: 0, emitted: 0, ignored: 0 };
  const line = async (bytes) => {
    if (bytes.length > 262144) throw new Error('record exceeds 256 KiB');
    if (!bytes.toString('utf8').trim()) return;
    stats.received++;
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`invalid JSON at record ${stats.received}`); }
    const normalized = values.source === 'entra' ? normalizeEntraSignIn(record, config) : normalizeDefenderAlert(record, config);
    if (!normalized) { stats.ignored++; return; }
    for (const result of engine ? engine.push(normalized, now ?? Date.now()) : [normalized]) {
      if (!process.stdout.write(`${JSON.stringify(result)}\n`)) await once(process.stdout, 'drain');
      stats.emitted++;
    }
  };
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    let offset = 0;
    let newline;
    while ((newline = chunk.indexOf(10, offset)) !== -1) {
      await line(Buffer.concat([pending, chunk.subarray(offset, newline)]));
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    pending = Buffer.concat([pending, chunk.subarray(offset)]);
    if (pending.length > 262144) throw new Error('record exceeds 256 KiB');
  }
  if (pending.length) await line(pending);
  console.error(JSON.stringify(stats));
}
main().catch((error) => { console.error(`microsoft-replay: ${error.message}`); process.exitCode = 2; process.stdin.destroy(); });
