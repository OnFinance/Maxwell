import { sha256 } from '../incident-investigation/core.mjs';

const company = /^[a-z0-9][a-z0-9-]{0,63}$/;
const tenant = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const machine = /^[a-f0-9]{40}$/;
const key = (v) => `${v.companyId}/${v.tenantId}/${v.machineId}`;
const actionKey = (v) => `${key(v)}/${v.action}`;
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k))) throw new Error('invalid response policy fields');
}
function target(value, extra = []) {
  fields(value, ['companyId', 'tenantId', 'machineId', ...extra]);
  if (!company.test(value.companyId || '') || !tenant.test(value.tenantId || '') || !machine.test(value.machineId || '')) throw new Error('invalid response policy target');
  if (extra.includes('action') && !['isolate', 'unisolate'].includes(value.action)) throw new Error('invalid response policy action');
}
function timestamp(value) {
  const ms = Date.parse(value);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value) || !Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw new Error('invalid response policy UTC timestamp');
  return ms;
}

// Operator-owned, immutable snapshot. Missing policy/windows deny all actions. UTC intervals
// avoid timezone/DST ambiguity and are start-inclusive/end-exclusive. No emergency bypass.
export function createResponsePolicy({ targets = [], config = { protectedDevices: [], windows: [] }, clock = Date.now } = {}) {
  fields(config, ['protectedDevices', 'windows']);
  if (![targets, config.protectedDevices, config.windows].every((v) => Array.isArray(v) && v.length <= 10000)) throw new Error('invalid response policy lists');
  const allowed = new Set(); const protectedDevices = new Set(); const windows = [];
  for (const entry of targets) { target(entry, ['action']); allowed.add(actionKey(entry)); }
  for (const entry of config.protectedDevices) { target(entry); protectedDevices.add(key(entry)); }
  for (const entry of config.windows) {
    target(entry, ['action', 'startsAt', 'endsAt']);
    const start = timestamp(entry.startsAt); const end = timestamp(entry.endsAt);
    if (start >= end || !allowed.has(actionKey(entry))) throw new Error('invalid response policy window');
    windows.push({ key: actionKey(entry), start, end });
  }
  windows.sort((a, b) => a.key.localeCompare(b.key) || a.start - b.start || a.end - b.end);
  const fingerprint = sha256({ targets: [...allowed].sort(), protectedDevices: [...protectedDevices].sort(), windows });
  return async ({ case: current, action, target: resolved }) => {
    const scope = { companyId: current.companyId, tenantId: resolved.tenantId, machineId: resolved.machineId, action };
    const now = clock();
    if (!Number.isFinite(now) || protectedDevices.has(key(scope)) || !allowed.has(actionKey(scope))) return false;
    // The earliest matching end is conservative when operator windows overlap.
    const active = windows.filter((w) => w.key === actionKey(scope) && w.start <= now && now < w.end);
    if (!active.length) return false;
    return { allowed: true, fingerprint, validUntil: Math.min(...active.map((w) => w.end)) };
  };
}
