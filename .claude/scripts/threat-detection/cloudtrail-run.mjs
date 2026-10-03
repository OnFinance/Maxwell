#!/usr/bin/env node
// CloudTrail/EventBridge/SNS JSONL stdin -> normalized events or detection candidate JSONL stdout.
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { normalizeCloudTrail } from './cloudtrail-adapter.mjs';
import { DetectionEngine } from './engine.mjs';

const MAX_LINE_BYTES = 262144;

async function main() {
  const { values } = parseArgs({ options: {
    company: { type: 'string' }, scope: { type: 'string' }, mode: { type: 'string', default: 'detect' },
    'replay-now': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node .claude/scripts/threat-detection/cloudtrail-run.mjs --company <id> [--scope <id>] [--mode detect|normalize] [--replay-now <UTC timestamp>] < cloudtrail-events.jsonl');
    return;
  }
  if (!['detect', 'normalize'].includes(values.mode)) throw new Error('--mode must be detect or normalize');
  const replayNow = values['replay-now'] === undefined ? null : Date.parse(values['replay-now']);
  if (replayNow !== null && (!Number.isFinite(replayNow) || new Date(replayNow).toISOString() !== values['replay-now'])) throw new Error('invalid --replay-now (use UTC milliseconds)');
  const engine = values.mode === 'detect' ? new DetectionEngine({ companyId: values.company }) : null;
  const stats = { received: 0, ignored: 0, normalized: 0, alerts: 0 };
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  const write = async (value) => { if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain'); };
  const handle = async (line) => {
    lineNumber++;
    if (line.length > MAX_LINE_BYTES) throw new Error(`line ${lineNumber}: event exceeds ${MAX_LINE_BYTES} bytes`);
    if (!line.toString('utf8').trim()) return;
    stats.received++;
    let normalized;
    try { normalized = normalizeCloudTrail(line.toString('utf8'), { companyId: values.company, scopeId: values.scope }); }
    catch (error) { throw new Error(`line ${lineNumber}: ${error.message}`); }
    if (!normalized) { stats.ignored++; return; }
    stats.normalized++;
    if (!engine) { await write(normalized); return; }
    let alerts;
    try { alerts = engine.push(normalized, replayNow ?? Date.now()); }
    catch (error) { throw new Error(`line ${lineNumber}: ${error.message}`); }
    for (const alert of alerts) await write(alert);
    stats.alerts += alerts.length;
  };
  for await (const chunk of process.stdin) {
    let offset = 0;
    let newline;
    while ((newline = chunk.indexOf(10, offset)) !== -1) {
      await handle(Buffer.concat([pending, chunk.subarray(offset, newline)]));
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    pending = Buffer.concat([pending, chunk.subarray(offset)]);
    if (pending.length > MAX_LINE_BYTES) throw new Error(`line ${lineNumber + 1}: event exceeds ${MAX_LINE_BYTES} bytes`);
  }
  if (pending.length) await handle(pending);
  console.error(JSON.stringify({ mode: values.mode, ...stats }));
}

main().catch((error) => { console.error(`cloudtrail-detection: ${error.message}`); process.exitCode = 2; process.stdin.destroy(); });
