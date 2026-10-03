import { TOKEN, WINDOW_MS, evaluateEvent, eventSignature, scopeKeyFor, validateEvent } from './core.mjs';

export { validateEvent } from './core.mjs';

export class DetectionEngine {
  constructor({ companyId, latenessMs = 120000, maxEvents = 10000, maxScopes = 1000 } = {}) {
    if (!TOKEN.test(companyId || '')) throw new Error('companyId is required');
    if (!Number.isSafeInteger(latenessMs) || latenessMs < 0 || latenessMs > WINDOW_MS) throw new Error('invalid latenessMs');
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
    if (time < now - WINDOW_MS - this.latenessMs) throw new Error('stale event exceeds retention horizon');
    const scopeKey = scopeKeyFor(event);
    const existing = this.scopes.get(scopeKey);
    if (existing && time < existing.watermark - this.latenessMs) throw new Error('late event exceeds source watermark allowance');
    this.lastNow = now;
    // Wall-clock expiration also bounds inactive source state. No silent eviction at capacity.
    for (const [id, scope] of this.scopes) {
      const cutoff = now - WINDOW_MS - this.latenessMs;
      for (const [eventId, item] of scope.events) {
        if (item.time < cutoff) { scope.events.delete(eventId); this.count--; }
      }
      for (const [alertId, end] of scope.emitted) if (end + WINDOW_MS < cutoff) scope.emitted.delete(alertId);
      if (!scope.events.size && scope.watermark < cutoff) this.scopes.delete(id);
    }
    let scope = this.scopes.get(scopeKey);
    const signature = eventSignature(event);
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
    const candidates = evaluateEvent(event, [...scope.events.values()], now);
    const alerts = candidates.filter((alert) => {
      if (scope.emitted.has(alert.alertId)) return false;
      scope.emitted.set(alert.alertId, Date.parse(alert.windowEnd));
      return true;
    });
    this.stats.alerts += alerts.length;
    return alerts;
  }
}
