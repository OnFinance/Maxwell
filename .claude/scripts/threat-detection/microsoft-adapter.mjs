import { isIP } from 'node:net';
import { hashParts, TOKEN, validateEvent } from './core.mjs';
import { validateAlert } from '../incident-investigation/core.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error(`invalid Microsoft ${name}`);
  return value;
};
const timestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('invalid Microsoft timestamp');
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new Error('invalid Microsoft timestamp');
  return normalized;
};

export function microsoftScope({ companyId, tenantId } = {}) {
  if (!TOKEN.test(companyId || '') || !UUID.test(tenantId || '')) throw new Error('companyId and Microsoft tenantId are required');
  return { companyId, tenantId: tenantId.toLowerCase() };
}

// Graph signIns are scoped by the authenticated tenant; resourceTenantId may refer
// to a different tenant for legitimate cross-tenant access and is not the issuer.
export function normalizeEntraSignIn(record, config) {
  const { companyId, tenantId } = microsoftScope(config);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid sign-in record');
  const id = text(record.id, 'sign-in id');
  const user = text(record.userId, 'user id');
  if (!isIP(record.ipAddress || '')) throw new Error('invalid sign-in IP address');
  if (!Number.isSafeInteger(record.status?.errorCode) || record.status.errorCode < 0) throw new Error('missing sign-in outcome');
  // Opaque tenant-bound keys avoid putting email addresses or IPs in alerts.
  return validateEvent({ schemaVersion: '1', companyId, scopeId: tenantId,
    source: 'microsoft-entra', eventId: hashParts([tenantId, id]),
    eventTime: timestamp(record.createdDateTime), type: 'authentication',
    outcome: record.status.errorCode === 0 ? 'success' : 'failure',
    actorKey: hashParts([tenantId, user.toLowerCase()]),
    sourceKey: hashParts([tenantId, new URL(`http://${isIP(record.ipAddress) === 6 ? `[${record.ipAddress}]` : record.ipAddress}`).hostname]),
  });
}

// Provider alerts remain candidates; this does not confirm an incident or act on a device.
// Each provider revision is immutable evidence and has its own candidate identity.
export function normalizeDefenderAlert(record, config) {
  const { companyId, tenantId } = microsoftScope(config);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid Defender record');
  if (typeof record.tenantId !== 'string' || record.tenantId.toLowerCase() !== tenantId) throw new Error('Defender tenant mismatch');
  if (record.serviceSource !== 'microsoftDefenderForEndpoint') return null;
  const id = text(record.id, 'alert id');
  const updated = timestamp(record.lastUpdateDateTime);
  const created = timestamp(record.createdDateTime);
  if (updated < created) throw new Error('invalid Defender alert chronology');
  const priority = { informational: 'info', low: 'low', medium: 'medium', high: 'high' }[record.severity];
  if (!priority) throw new Error('unsupported Defender severity');
  const evidenceId = hashParts([tenantId, id, updated]);
  return validateAlert({ schemaVersion: '1', kind: 'maxwell.detection.alert',
    companyId, scopeId: tenantId, source: 'microsoft-defender',
    alertId: hashParts([companyId, 'microsoft-defender', evidenceId]),
    recipeId: 'defender-provider-alert', recipeVersion: 1,
    title: text(record.title, 'alert title').slice(0, 200), priority, status: 'candidate',
    group: [hashParts([tenantId, id])], detectedAt: updated,
    windowStart: created, windowEnd: updated,
    evidenceCount: 1, evidenceEventIds: [evidenceId], evidenceTruncated: false,
  });
}
