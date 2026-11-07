#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { ContinuousControlService } from './service.mjs';
import { controlWorkspace } from './workspace.mjs';
try {
  const { values } = parseArgs({ options: { operation: { type: 'string' }, 'state-session': { type: 'string' }, watch: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) console.log('continuous-controls/run.mjs --operation register|tick|health|pause --state-session <session> [--watch] < input.json\nLocal OS identity; read-only repository checks, validated ledger observations. --watch is only for tick and requires a process supervisor. No network probes or automatic finding closure.');
  else {
    const input = JSON.parse(await readFile('/dev/stdin', 'utf8')); delete input.session;
    if (!['register', 'tick', 'health', 'pause'].includes(values.operation) || (values.watch && values.operation !== 'tick')) throw Error('invalid operation');
    const service = new ContinuousControlService({ store: new ExportStateStore({ sessionId: values['state-session'] }), ...controlWorkspace(), authorize: async (_s, companyId) => ({ id: `host:${process.getuid()}`, companyId }) });
    const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGTERM', stop); process.once('SIGINT', stop);
    try { do {
      console.log(JSON.stringify(await service[values.operation](input)));
      if (!values.watch) break;
      try { await setTimeout(60000, undefined, { signal: controller.signal }); } catch { if (!controller.signal.aborted) throw Error('wait failed'); }
    } while (!controller.signal.aborted); }
    finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
  }
} catch { console.error('continuous-controls: rejected or interrupted; inspect schedule health and protected host configuration'); process.exitCode = 2; }
