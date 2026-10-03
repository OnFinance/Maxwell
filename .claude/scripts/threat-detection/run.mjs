#!/usr/bin/env node
// JSONL stdin -> detection candidate JSONL stdout. No target access or ledger writes.
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { DetectionEngine } from './engine.mjs';
import { RECIPES } from './recipes.mjs';

const MAX_LINE_BYTES = 8192;

async function main() {
  const { values } = parseArgs({ options: { company: { type: 'string' }, 'replay-now': { type: 'string' }, demo: { type: 'boolean' }, 'list-recipes': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('node .claude/scripts/threat-detection/run.mjs --company <id> [--replay-now <UTC timestamp>] < normalized-events.jsonl\nnode .claude/scripts/threat-detection/run.mjs --company <id> --demo\n--list-recipes lists the built-in recipes. Live mode uses the current processing clock.');
    return;
  }
  if (values['list-recipes']) { console.log(JSON.stringify(RECIPES, null, 2)); return; }
  const engine = new DetectionEngine({ companyId: values.company });
  const replayNow = values['replay-now'] === undefined ? null : Date.parse(values['replay-now']);
  if (replayNow !== null && (!Number.isFinite(replayNow) || new Date(replayNow).toISOString() !== values['replay-now'])) throw new Error('invalid --replay-now (use UTC milliseconds)');
  const processingNow = replayNow ?? Date.now();
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  const handle = async (line) => {
    lineNumber++;
    if (line.length > MAX_LINE_BYTES) throw new Error(`line ${lineNumber}: event exceeds 8192 bytes`);
    if (!line.toString('utf8').trim()) return;
    let event;
    try { event = JSON.parse(line.toString('utf8')); } catch { throw new Error(`line ${lineNumber}: invalid JSON`); }
    let alerts;
    try { alerts = engine.push(event, replayNow ?? Date.now()); } catch (error) { throw new Error(`line ${lineNumber}: ${error.message}`); }
    for (const alert of alerts) {
      if (!process.stdout.write(JSON.stringify(alert) + '\n')) await once(process.stdout, 'drain');
    }
  };
  if (values.demo) {
    const common = { schemaVersion: '1', companyId: values.company, scopeId: 'demo-idp', source: 'maxwell-demo', type: 'authentication', actorKey: 'demo-user', sourceKey: 'demo-source' };
    const events = [1, 2, 3, 4, 5].map((n) => ({ ...common, eventId: `demo-failure-${n}`, eventTime: new Date(processingNow - (7 - n) * 1000).toISOString(), outcome: 'failure' }));
    events.push({ ...common, eventId: 'demo-success-1', eventTime: new Date(processingNow - 1000).toISOString(), outcome: 'success' });
    for (const item of events) await handle(Buffer.from(JSON.stringify(item)));
    console.error(JSON.stringify({ mode: replayNow === null ? 'demo' : 'demo-replay', ...engine.stats }));
    return;
  }
  for await (const chunk of process.stdin) {
    let offset = 0;
    let newline;
    while ((newline = chunk.indexOf(10, offset)) !== -1) {
      await handle(Buffer.concat([pending, chunk.subarray(offset, newline)]));
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
    pending = Buffer.concat([pending, chunk.subarray(offset)]);
    if (pending.length > MAX_LINE_BYTES) throw new Error(`line ${lineNumber + 1}: event exceeds 8192 bytes`);
  }
  if (pending.length) await handle(pending);
  console.error(JSON.stringify({ mode: replayNow === null ? 'live' : 'replay', ...engine.stats }));
}

main().catch((error) => { console.error(`threat-detection: ${error.message}`); process.exitCode = 2; process.stdin.destroy(); });
