import { createHash } from 'node:crypto';
import { RECIPES } from './recipes.mjs';

export const WINDOW_MS = 300000;
export const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const EVENT_FIELDS = ['schemaVersion', 'eventId', 'companyId', 'scopeId', 'source', 'eventTime', 'type', 'outcome', 'actorKey', 'sourceKey', 'targetKey', 'privileged'];
export const hashParts = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const keyParts = (parts) => JSON.stringify(parts);
export const scopeKeyFor = (event) => keyParts([event.companyId, event.source, event.scopeId]);
export const eventSignature = (event) => hashParts(EVENT_FIELDS.map((field) => event[field] ?? null));

// Keys must be opaque, source-normalized identifiers. Raw log messages and credentials are not accepted.
export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event must be an object');
  if (Object.keys(event).some((field) => !EVENT_FIELDS.includes(field))) throw new Error('event contains unsupported fields');
  if (event.schemaVersion !== '1') throw new Error('schemaVersion must be 1');
  for (const field of ['eventId', 'companyId', 'scopeId', 'source', 'actorKey']) {
    if (typeof event[field] !== 'string' || !TOKEN.test(event[field])) throw new Error(`invalid ${field}`);
  }
  for (const field of ['sourceKey', 'targetKey']) {
    if (event[field] !== undefined && (typeof event[field] !== 'string' || !TOKEN.test(event[field]))) throw new Error(`invalid ${field}`);
  }
  if (typeof event.eventTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.eventTime)
      || !Number.isFinite(Date.parse(event.eventTime)) || new Date(Date.parse(event.eventTime)).toISOString() !== event.eventTime) {
    throw new Error('eventTime must be a valid UTC timestamp with milliseconds');
  }
  if (!['authentication', 'privilege-grant', 'audit-disable'].includes(event.type)) throw new Error('unsupported event type');
  if (!['success', 'failure'].includes(event.outcome)) throw new Error('unsupported outcome');
  if (event.type === 'authentication' && !event.sourceKey) throw new Error('authentication requires sourceKey');
  if (event.type !== 'authentication' && !event.targetKey) throw new Error('control changes require targetKey');
  if (event.type === 'privilege-grant' && typeof event.privileged !== 'boolean') throw new Error('privilege-grant requires privileged');
  if (event.type !== 'privilege-grant' && event.privileged !== undefined) throw new Error('privileged is only valid for privilege-grant');
  return { ...event };
}

function alertFor({ event, recipe, group, end, evidence, now }) {
  const scopeKey = scopeKeyFor(event);
  const bucket = recipe.windowMs ? Math.floor(end / WINDOW_MS) : event.eventId;
  const ordered = [...evidence].sort((a, b) => a.time - b.time || a.event.eventId.localeCompare(b.event.eventId));
  return {
    schemaVersion: '1', kind: 'maxwell.detection.alert',
    alertId: hashParts([scopeKey, recipe.id, recipe.version, group, bucket]),
    companyId: event.companyId, scopeId: event.scopeId, source: event.source,
    recipeId: recipe.id, recipeVersion: recipe.version, title: recipe.title,
    priority: recipe.severity, status: 'candidate', group,
    detectedAt: new Date(now).toISOString(),
    windowStart: new Date(end - recipe.windowMs).toISOString(), windowEnd: new Date(end).toISOString(),
    evidenceCount: ordered.length,
    evidenceEventIds: ordered.slice(0, 100).map((item) => item.event.eventId),
    evidenceTruncated: ordered.length > 100,
  };
}

// Re-evaluate anchors around the incoming event so late arrivals can complete correlations.
export function evaluateEvent(event, records, now = Date.now()) {
  const time = Date.parse(event.eventTime);
  const alerts = new Map();
  const emit = (recipe, group, end, evidence) => {
    const alert = alertFor({ event, recipe, group, end, evidence, now });
    alerts.set(alert.alertId, alert);
  };
  for (const recipe of RECIPES) {
    if (recipe.type !== event.type) continue;
    if (!recipe.windowMs) {
      if (event.outcome === 'success' && (event.type !== 'privilege-grant' || event.privileged)) {
        emit(recipe, [event.actorKey, event.targetKey], time, [{ event, time }]);
      }
      continue;
    }
    const groupOf = (item) => recipe.groupBy === 'actorSource' ? [item.actorKey, item.sourceKey] : [item[recipe.groupBy]];
    const group = groupOf(event);
    const candidates = records.filter((item) => item.event.type === 'authentication' && keyParts(groupOf(item.event)) === keyParts(group));
    const anchors = candidates.filter((item) => item.time >= time && item.time <= time + WINDOW_MS)
      .filter((item) => recipe.id === 'failure-then-success' ? item.event.outcome === 'success' : item.event.outcome === 'failure')
      .sort((a, b) => a.time - b.time || a.event.eventId.localeCompare(b.event.eventId));
    for (const anchor of anchors) {
      const failures = candidates.filter((item) => item.event.outcome === 'failure' && item.time >= anchor.time - WINDOW_MS && item.time <= anchor.time);
      if (recipe.id === 'password-spray') {
        if (new Set(failures.map((item) => item.event.actorKey)).size >= recipe.threshold) emit(recipe, group, anchor.time, failures);
      } else if (recipe.id === 'failure-then-success') {
        const preceding = failures.filter((item) => item.time < anchor.time);
        if (preceding.length >= recipe.threshold) emit(recipe, group, anchor.time, [...preceding, anchor]);
      } else if (failures.length >= recipe.threshold) emit(recipe, group, anchor.time, failures);
    }
  }
  return [...alerts.values()];
}
