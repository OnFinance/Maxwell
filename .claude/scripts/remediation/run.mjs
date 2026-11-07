#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { RemediationService } from './service.mjs';
import { workspaceAdapters } from './workspace.mjs';
try {
  const { values } = parseArgs({ options: { operation: { type: 'string' }, 'state-session': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('remediation/run.mjs --operation open|verify|close|read --state-session <session> < request.json\nTrusted local CLI: OS uid is the actor. Use distinct OS accounts for independent closure. JSON input supplies companyId and operation fields; no shell commands are accepted. Existing task/finding records are reused; task completion stays in change-management workflows.');
  else {
    const input = JSON.parse(await readFile('/dev/stdin', 'utf8')); delete input.session;
    const principal = `host:${process.getuid()}`;
    const service = new RemediationService({ store: new ExportStateStore({ sessionId: values['state-session'] }),
      ...workspaceAdapters(), authorize: async (_session, companyId) => ({ id: principal, companyId }) });
    if (values.operation === 'read') console.log(JSON.stringify(await service.store.get(input.companyId, input.id)));
    else if (['open', 'verify', 'close'].includes(values.operation)) console.log(JSON.stringify(await service[values.operation](input)));
    else throw new Error('unknown operation');
  }
} catch { console.error('remediation: operation rejected; verify scope, revision, permissions, evidence and host configuration'); process.exitCode = 2; }
