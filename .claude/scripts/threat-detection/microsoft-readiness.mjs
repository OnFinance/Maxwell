import { microsoftScope } from './microsoft-adapter.mjs';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { connectorHealth, connectorKey } from './microsoft-state.mjs';
import { caseIdFor, validateAlert, alertSignature } from '../incident-investigation/core.mjs';

const guidance = {
  'never-started': 'Start the configured collector under an approved process supervisor.',
  invalid: 'Investigate corrupt state or host clock skew; do not reset the checkpoint.',
  starting: 'Wait for the first successful bounded poll, then repeat the check.',
  stale: 'Check worker scheduling and backlog; preserve the checkpoint during recovery.',
  stalled: 'Check the worker process and restart through its supervisor after lease expiry.',
  failed: 'Inspect the sanitized failure code and retry after correcting the cause.',
  'authentication-failed': 'Renew host Microsoft credentials and verify the configured tenant.',
  'permission-denied': 'Have the tenant administrator verify required read permissions and consent.',
  throttled: 'Allow the existing bounded backoff to complete; do not reset progress.',
  'provider-unavailable': 'Check provider availability and worker network access; retain the checkpoint.',
  'replay-horizon-exceeded': 'Escalate the coverage gap for operator-reviewed recovery; do not skip it.',
  interrupted: 'Confirm shutdown was intentional and restart through the configured supervisor.',
};

// Only targeted, consistent GetItem reads. No scans, provider calls, synthetic alerts or writes.
export async function checkMicrosoftReadiness({ config, detectionTable, investigationTable, alertId, client, now = Date.now(), staleMs = 900000 }) {
  config = { ...config, ...microsoftScope(config) };
  const stateKey = connectorKey(config);
  if (!client || typeof detectionTable !== 'string' || !detectionTable) throw new Error('readiness client and table required');
  if (alertId !== undefined && (!/^[a-f0-9]{64}$/.test(alertId) || !investigationTable)) throw new Error('sample alert and investigation table required');
  const read = async (TableName, Key) => (await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(10000) })).Item;
  const health = connectorHealth(await read(detectionTable, stateKey), now, staleMs);
  const checks = [{ name: 'collection', status: health.ready ? 'pass' : 'fail', health,
    nextStep: health.ready ? null : guidance[health.failureCode] || guidance[health.status] }];
  const expired = (row) => row.expiresAt !== undefined && (!Number.isSafeInteger(row.expiresAt) || row.expiresAt * 1000 <= now);
  let delivery = { name: 'sample-delivery', status: 'unverified', reason: 'No recent alert sample supplied; quiet collection does not prove downstream delivery.' };
  if (alertId) {
    const item = await read(detectionTable, { pk: `ALERTS#${config.companyId}`, sk: `ALERT#${alertId}` });
    if (!item || expired(item)) delivery = { name: 'sample-delivery', status: 'fail', reason: 'Sample alert missing or expired.' };
    else {
      const alert = validateAlert(item.alert);
      if (alert.alertId !== alertId || alert.companyId !== config.companyId || alert.scopeId !== config.tenantId
        || alert.source !== `microsoft-${config.source}`) throw new Error('sample scope mismatch');
      const age = now - Date.parse(alert.detectedAt);
      if (age < 0 || age > staleMs) delivery = { name: 'sample-delivery', status: 'fail', reason: 'Sample is not recent enough to establish current delivery.' };
      else {
        const id = caseIdFor(alert);
        const row = await read(investigationTable, { pk: `INVESTIGATIONS#${config.companyId}`, sk: `CASE#${id}` });
        const current = row?.case;
        const matches = current?.kind === 'maxwell.investigation.case' && current.companyId === config.companyId && current.caseId === id
          && current.alertSignature === alertSignature(alert) && alertSignature(current.alert) === alertSignature(alert);
        const available = matches && !expired(row);
        delivery = { name: 'sample-delivery', status: available ? 'pass' : 'fail',
          reason: available ? 'The sampled alert is present in its investigation case.' : 'Matching case snapshot not found; inspect intake, stream/queue routing, or choose the latest provider revision.' };
      }
    }
  }
  checks.push(delivery);
  return { schemaVersion: '1', kind: 'maxwell.connector.readiness', checkedAt: new Date(now).toISOString(),
    companyId: config.companyId, tenantId: config.tenantId, source: config.source,
    ready: checks.every((check) => check.status === 'pass'), checks,
    scope: 'Point-in-time persisted-state and optional sample check; does not verify current Microsoft credentials, supervisor, queue backlog or all alert delivery.' };
}
