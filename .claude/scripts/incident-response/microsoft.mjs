import { normalizeDefenderAlert } from '../threat-detection/microsoft-adapter.mjs';
import { readMicrosoftJson } from '../threat-detection/microsoft-http.mjs';
import { sha256 } from '../incident-investigation/core.mjs';

const GRAPH = 'https://graph.microsoft.com';
const DEFENDER = 'https://api.security.microsoft.com';
// Endpoint URL and token audience differ for Defender for Endpoint APIs.
const DEFENDER_RESOURCE = 'https://api.securitycenter.microsoft.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const responseComment = (record) => `Maxwell ${record.responseId} ${record.digest}`;

async function headers(getToken, tenantId, origin) {
  const credential = await getToken({ tenantId, scope: `${origin}/.default` });
  if (credential?.tenantId !== tenantId || typeof credential.accessToken !== 'string' || !credential.accessToken || /[\r\n]/.test(credential.accessToken)) throw new Error('invalid response credential');
  return { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json' };
}

export function microsoftTargetResolver({ getToken, fetchImpl = fetch }) {
  return async (currentCase, providerAlertId, machineId) => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(providerAlertId || '') || !/^[a-f0-9]{40}$/.test(machineId || '')) throw new Error('invalid provider target');
    const alert = currentCase.alert;
    if (alert.source !== 'microsoft-defender') throw new Error('case is not a Defender case');
    const response = await fetchImpl(`${GRAPH}/v1.0/security/alerts_v2/${encodeURIComponent(providerAlertId)}`, {
      method: 'GET', redirect: 'error', headers: await headers(getToken, alert.scopeId, GRAPH), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('could not verify Defender evidence');
    const source = await readMicrosoftJson(response);
    const normalized = normalizeDefenderAlert(source, { companyId: currentCase.companyId, tenantId: alert.scopeId });
    if (sha256(normalized) !== sha256(alert)) throw new Error('provider evidence no longer matches case snapshot');
    const device = source.evidence?.find((item) => item['@odata.type'] === '#microsoft.graph.security.deviceEvidence'
      && item.mdeDeviceId === machineId && item.onboardingStatus === 'onboarded');
    if (!device) throw new Error('onboarded target device is not in case evidence');
    return { tenantId: alert.scopeId, machineId, evidenceHash: sha256({ alert: normalized, device }) };
  };
}

export class MicrosoftResponseProvider {
  constructor({ getToken, fetchImpl = fetch, clock = Date.now } = {}) {
    if (typeof getToken !== 'function') throw new Error('separate Defender response credentials required');
    Object.assign(this, { getToken, fetchImpl, clock });
  }
  outcome(record, action) {
    const expectedType = record.proposal.action === 'isolate' ? 'Isolate' : 'Unisolate';
    if (!action || !UUID.test(action.id || '') || action.machineId !== record.proposal.machineId || action.type !== expectedType
      || action.requestorComment !== responseComment(record) || (expectedType === 'Isolate' && action.scope !== 'Full')) throw new Error('provider action does not match approved request');
    const state = { Pending: 'submitted', InProgress: 'submitted', Succeeded: 'succeeded', Failed: 'failed', TimeOut: 'unknown', Cancelled: 'failed' }[action.status];
    if (!state) throw new Error('unknown provider action status');
    return { providerActionId: action.id, state };
  }
  async submit(record) {
    if (record.state !== 'executing' || record.digest !== sha256(record.proposal) || record.approval?.digest !== record.digest
      || record.approval.actor === record.proposal.requestedBy) throw new Error('approved execution claim required');
    if (!['isolate', 'unisolate'].includes(record.proposal.action) || !/^[a-f0-9]{40}$/.test(record.proposal.machineId)) throw new Error('invalid response action');
    const authHeaders = await headers(this.getToken, record.proposal.tenantId, DEFENDER_RESOURCE);
    if (this.clock() >= record.proposal.expiresAt) throw new Error('response approval expired');
    const response = await this.fetchImpl(`${DEFENDER}/api/machines/${record.proposal.machineId}/${record.proposal.action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: authHeaders,
      body: JSON.stringify({ Comment: responseComment(record), ...(record.proposal.action === 'isolate' ? { IsolationType: 'Full' } : {}) }),
    });
    // Never retry POST, including 429/5xx; provider acceptance may be uncertain.
    if (response.status !== 201) { await response.body?.cancel(); throw new Error('response submission outcome unknown'); }
    return this.outcome(record, await readMicrosoftJson(response));
  }
  async inspect(record, actionId) {
    if (!UUID.test(actionId || '')) throw new Error('provider action ID required for reconciliation');
    const response = await this.fetchImpl(`${DEFENDER}/api/machineactions/${actionId}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: await headers(this.getToken, record.proposal.tenantId, DEFENDER_RESOURCE),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('provider action status unavailable'); }
    const action = await readMicrosoftJson(response);
    if (action.id !== actionId) throw new Error('provider action ID mismatch');
    return this.outcome(record, action);
  }
}
