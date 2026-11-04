#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { watchMicrosoft } from './microsoft-watch.mjs';
import { MicrosoftCollector } from './microsoft-collector.mjs';
import { microsoftClientCredentials } from './microsoft-auth.mjs';
import { MicrosoftStateStore, connectorHealth, connectorKey } from './microsoft-state.mjs';
import { MicrosoftPoller } from './microsoft-poller.mjs';
import { DurableDetectionEngine } from './durable-engine.mjs';
import { DynamoDbDetectionStore } from './dynamodb-store.mjs';

async function main() {
  const { values } = parseArgs({ options: { company: { type: 'string' }, tenant: { type: 'string' }, source: { type: 'string' },
    from: { type: 'string' }, table: { type: 'string' }, region: { type: 'string' }, watch: { type: 'boolean' },
    health: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('microsoft-poll-run.mjs --company <id> --tenant <UUID> --source entra|defender --table <existing detection table> --region <region> --from <initial UTC milliseconds> [--watch | --health]\nDefault: one bounded poll. --watch polls every 60s, backing off on failures. --health only reads connector state; needs no Microsoft credentials. Writes detection events, candidate alert outbox, checkpoint and health to the existing table. Never provisions infrastructure or performs containment.');
    return;
  }
  const config = { companyId: values.company, tenantId: values.tenant, source: values.source };
  connectorKey(config);
  if (values.watch && values.health) throw new Error('choose watch or health');
  const stateStore = new MicrosoftStateStore({ tableName: values.table, region: values.region });
  try {
    if (values.health) {
      const health = connectorHealth(await stateStore.read(config));
      console.log(JSON.stringify(health));
      if (!['healthy', 'running'].includes(health.status)) process.exitCode = 2;
      return;
    }
    const getToken = microsoftClientCredentials({ tenantId: values.tenant,
      clientId: process.env.MAXWELL_MICROSOFT_CLIENT_ID, clientSecret: process.env.MAXWELL_MICROSOFT_CLIENT_SECRET });
    const collector = new MicrosoftCollector({ ...config, getToken });
    // Retain correlation events longer than the supported replay horizon, not the
    // 30-minute default used by the streaming CloudTrail consumer.
    const detectionStore = new DynamoDbDetectionStore({ tableName: values.table, region: values.region,
      documentClient: stateStore.client, eventTtlSeconds: 15 * 86400 });
    const detector = new DurableDetectionEngine({ companyId: values.company, store: detectionStore });
    const poller = new MicrosoftPoller({ ...config, initialFrom: values.from, collector, stateStore, detectionStore, detector });
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      if (values.watch) await watchMicrosoft({ poller, signal: controller.signal,
        onResult: (result) => console.log(JSON.stringify({ ...config, ...result })),
        onFailure: (result) => console.error(JSON.stringify({ ...config, ...result })),
      });
      else console.log(JSON.stringify({ ...config, ...await poller.poll({ signal: controller.signal }) }));
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally { stateStore.destroy(); }
}
main().catch(() => { console.error('microsoft-poll: failed; inspect connector health and host configuration'); process.exitCode = 2; });
