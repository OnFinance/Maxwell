#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { MicrosoftStateStore } from './microsoft-state.mjs';
import { checkMicrosoftReadiness } from './microsoft-readiness.mjs';

try {
  const { values } = parseArgs({ options: Object.fromEntries(['company', 'tenant', 'source', 'table', 'region', 'investigation-table', 'alert-id', 'stale-seconds'].map((k) => [k, { type: 'string' }]).concat([['help', { type: 'boolean' }]])) });
  if (values.help) console.log('microsoft-readiness-run.mjs --company <id> --tenant <uuid> --source entra|defender --table <detection-table> --region <region> [--investigation-table <table> --alert-id <recent-alert-id>] [--stale-seconds 900]\nRead-only consistent DynamoDB reads; no Microsoft credentials or writes. Exit 0: collection and sample pass; 2: failed/unverified; 3: invalid input or read failure. A missing sample is unverified, never full readiness.');
  else {
    const staleMs = Number(values['stale-seconds'] || 900) * 1000;
    if (!Number.isSafeInteger(staleMs) || staleMs < 1000 || staleMs > 86400000) throw new Error('invalid threshold');
    const store = new MicrosoftStateStore({ tableName: values.table, region: values.region });
    try {
      const report = await checkMicrosoftReadiness({ config: { companyId: values.company, tenantId: values.tenant, source: values.source }, detectionTable: values.table,
        investigationTable: values['investigation-table'], alertId: values['alert-id'], client: store.client, staleMs });
      console.log(JSON.stringify(report)); process.exitCode = report.ready ? 0 : 2;
    } finally { store.destroy(); }
  }
} catch { console.error('readiness: invalid configuration or read failed; verify host credentials, scoped read permissions, table names and stored data'); process.exitCode = 3; }
