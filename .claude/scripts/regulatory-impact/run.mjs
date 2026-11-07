#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { RegulatoryImpactService } from './service.mjs';
import { regulatoryWorkspace } from './workspace.mjs';
try {
  const { values } = parseArgs({ options: { operation: { type: 'string' }, 'state-session': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log('regulatory-impact/run.mjs --operation importSource|compare|review|read --state-session <session> < input.json\nMAXWELL_REGULATORY_SOURCE_HOSTS is a protected JSON array of approved source hostnames. Imports are operator-supplied versioned clauses; no URL fetching or legal interpretation is performed. Independent review uses distinct OS uids. Task proposals require existing change-management approval.');
  else {
    const input = JSON.parse(await readFile('/dev/stdin', 'utf8')); delete input.session;
    const store = new ExportStateStore({ sessionId: values['state-session'] });
    const service = new RegulatoryImpactService({ store, ...regulatoryWorkspace(), sourceHosts: JSON.parse(process.env.MAXWELL_REGULATORY_SOURCE_HOSTS || '[]'), authorize: async (_s, companyId) => ({ id: `host:${process.getuid()}`, companyId }) });
    if (values.operation === 'read') console.log(JSON.stringify(await store.get(input.companyId, input.id)));
    else if (['importSource', 'compare', 'review'].includes(values.operation)) console.log(JSON.stringify(await service[values.operation](input)));
    else throw Error('unknown operation');
  }
} catch { console.error('regulatory-impact: rejected; verify company scope, source version, approved hosts, review digest and permissions'); process.exitCode = 2; }
