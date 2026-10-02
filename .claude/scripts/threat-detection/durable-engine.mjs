import { TOKEN, WINDOW_MS, evaluateEvent, eventSignature, scopeKeyFor, validateEvent } from './core.mjs';

export class DurableDetectionEngine {
  constructor({ companyId, store, maxEventAgeMs = 1209600000 } = {}) {
    if (!TOKEN.test(companyId || '')) throw new Error('companyId is required');
    if (!store || typeof store.saveEvent !== 'function' || typeof store.queryEvents !== 'function' || typeof store.saveAlert !== 'function') {
      throw new Error('durable detection store is required');
    }
    if (!Number.isSafeInteger(maxEventAgeMs) || maxEventAgeMs < WINDOW_MS) throw new Error('invalid maxEventAgeMs');
    this.companyId = companyId;
    this.store = store;
    this.maxEventAgeMs = maxEventAgeMs;
    this.stats = { accepted: 0, duplicates: 0, alerts: 0 };
  }

  async push(input, now = Date.now()) {
    const event = validateEvent(input);
    if (event.companyId !== this.companyId) throw new Error('companyId does not match configured company');
    if (!Number.isSafeInteger(now)) throw new Error('processing clock must be an integer');
    const time = Date.parse(event.eventTime);
    if (time > now + 30000) throw new Error('future event exceeds 30 second clock skew');
    if (time < now - this.maxEventAgeMs) throw new Error('stale event exceeds durable replay horizon');

    const saved = await this.store.saveEvent({
      scopeKey: scopeKeyFor(event), event, time, signature: eventSignature(event), now,
    });
    this.stats[saved.created ? 'accepted' : 'duplicates']++;

    const records = await this.store.queryEvents({
      scopeKey: scopeKeyFor(event), from: time - WINDOW_MS, to: time + WINDOW_MS,
    });
    const alerts = [];
    for (const alert of evaluateEvent(event, records, now)) {
      if (await this.store.saveAlert({ alert, now })) alerts.push(alert);
    }
    this.stats.alerts += alerts.length;
    return alerts;
  }
}
