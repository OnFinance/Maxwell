import { createHash } from 'node:crypto';
import { RECIPES } from './recipes.mjs';

const WINDOW = 300000;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FIELDS = ['schemaVersion', 'eventId', 'companyId', 'scopeId', 'source', 'eventTime', 'type', 'outcome', 'actorKey', 'sourceKey', 'targetKey', 'privileged'];
const hash = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const key = (parts) => JSON.stringify(parts);

// Keys must be opaque, source-normalized identifiers. Raw log messages and credentials are not accepted.
export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event must be an object');
  if (Object.keys(event).some((field) => !FIELDS.includes(field))) throw new Error('event contains unsupported fields');
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

export class DetectionEngine {
  constructor({ companyId, latenessMs = 120000, maxEvents = 10000, maxScopes = 1000 } = {}) {
    if (!TOKEN.test(companyId || '')) throw new Error('companyId is required');
    if (!Number.isSafeInteger(latenessMs) || latenessMs < 0 || latenessMs > WINDOW) throw new Error('invalid latenessMs');
    for (const value of [maxEvents, maxScopes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid capacity');
    this.companyId = companyId;
    this.latenessMs = latenessMs;
    this.maxEvents = maxEvents;
    this.maxScopes = maxScopes;
    this.scopes = new Map();
    this.count = 0;
    this.lastNow = -Infinity;
    this.stats = { accepted: 0, duplicates: 0, alerts: 0 };
  }

  push(input, now = Date.now()) {
    const event = validateEvent(input);
    if (event.companyId !== this.companyId) throw new Error('companyId does not match configured company');
    if (!Number.isSafeInteger(now) || now < this.lastNow) throw new Error('processing clock must be monotonic');
    const time = Date.parse(event.eventTime);
    if (time > now + 30000) throw new Error('future event exceeds 30 second clock skew');
    if (time < now - WINDOW - this.latenessMs) throw new Error('stale event exceeds retention horizon');
    const scopeKey = key([event.companyId, event.source, event.scopeId]);
    const existing = this.scopes.get(scopeKey);
    if (existing && time < existing.watermark - this.latenessMs) throw new Error('late event exceeds source watermark allowance');
    this.lastNow = now;
    // Wall-clock expiration also bounds inactive source state. No silent eviction at capacity.
    for (const [id, scope] of this.scopes) {
      const cutoff = now - WINDOW - this.latenessMs;
      for (const [eventId, item] of scope.events) {
        if (item.time < cutoff) { scope.events.delete(eventId); this.count--; }
      }
      for (const [alertId, end] of scope.emitted) if (end + WINDOW < cutoff) scope.emitted.delete(alertId);
      if (!scope.events.size && scope.watermark < cutoff) this.scopes.delete(id);
    }
    let scope = this.scopes.get(scopeKey);
    const signature = hash(FIELDS.map((field) => event[field] ?? null));
    const previous = scope?.events.get(event.eventId);
    if (previous) {
      if (previous.signature !== signature) throw new Error('eventId was reused with different content');
      this.stats.duplicates++;
      return [];
    }
    if (this.count >= this.maxEvents || (!scope && this.scopes.size >= this.maxScopes)) throw new Error('detection state capacity exceeded; stop and replay after capacity is restored');
    if (!scope) {
      scope = { watermark: time, events: new Map(), emitted: new Map() };
      this.scopes.set(scopeKey, scope);
    }
    scope.watermark = Math.max(scope.watermark, time);
    scope.events.set(event.eventId, { event, time, signature });
    this.count++;
    this.stats.accepted++;
    const alerts = [];
    const emit = (recipe, group, end, evidence) => {
      // Correlation alerts are coalesced per group and UTC five-minute bucket.
      // Single-event alerts retain the provider event identity.
      const bucket = recipe.windowMs ? Math.floor(end / WINDOW) : event.eventId;
      const alertId = hash([scopeKey, recipe.id, recipe.version, group, bucket]);
      if (scope.emitted.has(alertId)) return;
      scope.emitted.set(alertId, end);
      const ordered = [...evidence].sort((a, b) => a.time - b.time || a.event.eventId.localeCompare(b.event.eventId));
      alerts.push({
        schemaVersion: '1', kind: 'maxwell.detection.alert', alertId,
        companyId: event.companyId, scopeId: event.scopeId, source: event.source,
        recipeId: recipe.id, recipeVersion: recipe.version, title: recipe.title,
        priority: recipe.severity, status: 'candidate', group,
        detectedAt: new Date(now).toISOString(), windowStart: new Date(end - recipe.windowMs).toISOString(), windowEnd: new Date(end).toISOString(),
        evidenceCount: ordered.length, evidenceEventIds: ordered.slice(0, 100).map((item) => item.event.eventId), evidenceTruncated: ordered.length > 100,
      });
    };
    for (const recipe of RECIPES) {
      if (recipe.type !== event.type) continue;
      if (!recipe.windowMs) {
        if (event.outcome === 'success' && (event.type !== 'privilege-grant' || event.privileged)) {
          emit(recipe, [event.actorKey, event.targetKey], time, [scope.events.get(event.eventId)]);
        }
        continue;
      }
      const groupOf = (e) => recipe.groupBy === 'actorSource' ? [e.actorKey, e.sourceKey] : [e[recipe.groupBy]];
      const group = groupOf(event);
      const candidates = [...scope.events.values()].filter((item) => item.event.type === 'authentication' && key(groupOf(item.event)) === key(group));
      // Re-evaluate later anchors when an out-of-order failure arrives, including an already-seen success.
      const anchors = candidates.filter((item) => item.time >= time && item.time <= time + WINDOW)
        .filter((item) => recipe.id === 'failure-then-success' ? item.event.outcome === 'success' : item.event.outcome === 'failure')
        .sort((a, b) => a.time - b.time);
      for (const anchor of anchors) {
        const failures = candidates.filter((item) => item.event.outcome === 'failure' && item.time >= anchor.time - WINDOW && item.time <= anchor.time);
        if (recipe.id === 'password-spray') {
          if (new Set(failures.map((item) => item.event.actorKey)).size >= recipe.threshold) emit(recipe, group, anchor.time, failures);
        } else if (recipe.id === 'failure-then-success') {
          const preceding = failures.filter((item) => item.time < anchor.time);
          if (anchor.event.outcome === 'success' && preceding.length >= recipe.threshold) emit(recipe, group, anchor.time, [...preceding, anchor]);
        } else if (failures.length >= recipe.threshold) emit(recipe, group, anchor.time, failures);
      }
    }
    this.stats.alerts += alerts.length;
    return alerts;
  }
}
