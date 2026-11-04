#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { MicrosoftCollector } from './microsoft-collector.mjs';
import { microsoftClientCredentials } from './microsoft-auth.mjs';

async function main() {
  const { values } = parseArgs({ options: { company: { type: 'string' }, tenant: { type: 'string' }, source: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('microsoft-collect-run.mjs --company <id> --tenant <UUID> --source entra|defender --from <UTC milliseconds> --to <UTC milliseconds>\nUses MAXWELL_MICROSOFT_CLIENT_ID and MAXWELL_MICROSOFT_CLIENT_SECRET from the host environment. Emits normalized JSONL, performs read-only Graph GETs. Does not save a durable checkpoint.');
    return;
  }
  const getToken = microsoftClientCredentials({ tenantId: values.tenant,
    clientId: process.env.MAXWELL_MICROSOFT_CLIENT_ID, clientSecret: process.env.MAXWELL_MICROSOFT_CLIENT_SECRET });
  const collector = new MicrosoftCollector({ companyId: values.company, tenantId: values.tenant, getToken });
  const result = await collector.collect({ source: values.source, from: values.from, to: values.to, deliver: async (record) => {
    if (!process.stdout.write(`${JSON.stringify(record)}\n`)) await once(process.stdout, 'drain');
  } });
  // stdout isn't a durable sink acknowledgment; never advertise its watermark as saved.
  const { checkpoint, ...counts } = result;
  console.error(JSON.stringify({ ...counts, collectedThrough: checkpoint, checkpointSaved: false }));
}
main().catch((error) => { console.error(`microsoft-collect: ${error.message}`); process.exitCode = 2; });
