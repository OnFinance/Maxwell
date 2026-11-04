#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
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
    let failures = 0;
    try {
      do {
        try {
          const result = await poller.poll({ signal: controller.signal });
          console.log(JSON.stringify({ ...config, ...result }));
          failures = 0;
        } catch (error) {
          if (controller.signal.aborted) break;
          if (!values.watch) throw error;
          failures++;
          console.error(JSON.stringify({ ...config, status: 'failed', consecutiveWorkerFailures: failures }));
        }
        if (!values.watch || controller.signal.aborted) break;
        try { await sleep(Math.min(300000, 60000 * 2 ** Math.min(failures, 3)), undefined, { signal: controller.signal }); }
        catch { if (!controller.signal.aborted) throw new Error('scheduler wait failed'); }
      } while (!controller.signal.aborted);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally { stateStore.destroy(); }
}
main().catch(() => { console.error('microsoft-poll: failed; inspect connector health and host configuration'); process.exitCode = 2; });
