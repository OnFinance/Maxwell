import { randomUUID } from 'node:crypto';
import { microsoftScope } from './microsoft-adapter.mjs';

const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const HORIZON = 14 * 86400000;

export class MicrosoftPoller {
  constructor({ companyId, tenantId, source, initialFrom, collector, stateStore, detectionStore, detector,
    clock = Date.now, overlapMs = 300000, chunkMs = 300000, lagMs = 120000, leaseMs = 600000 } = {}) {
    Object.assign(this, microsoftScope({ companyId, tenantId }));
    if (!['entra', 'defender'].includes(source) || !iso(initialFrom)) throw new Error('source and initial UTC timestamp are required');
    if (!collector || !stateStore || !detectionStore || (source === 'entra' && !detector)) throw new Error('collector and durable stores/detector are required');
    for (const v of [overlapMs, chunkMs, lagMs, leaseMs]) if (!Number.isSafeInteger(v) || v < 1) throw new Error('invalid poll timing');
    if (overlapMs > 86400000 || chunkMs > 3600000 || leaseMs < 600000 || leaseMs > 3600000) throw new Error('poll timing outside supported bounds');
    Object.assign(this, { source, initialFrom, collector, stateStore, detectionStore, detector, clock, overlapMs, chunkMs, lagMs, leaseMs });
  }
  async poll({ signal } = {}) {
    signal?.throwIfAborted();
    const owner = randomUUID();
    const state = await this.stateStore.acquire(this, { owner, now: this.clock(), leaseMs: this.leaseMs, initialFrom: this.initialFrom });
    if (!state) return { status: 'busy' };
    let lastRenewed = this.clock();
    const renew = async () => {
      signal?.throwIfAborted();
      await this.stateStore.renew(this, { owner, now: this.clock(), leaseMs: this.leaseMs });
      lastRenewed = this.clock();
    };
    try {
      if (!iso(state.checkpoint) || !iso(state.initialFrom)) throw new Error('invalid stored checkpoint');
      const now = this.clock();
      const start = Math.max(Date.parse(state.initialFrom), Date.parse(state.checkpoint) - this.overlapMs);
      const end = Math.min(now - this.lagMs, Date.parse(state.checkpoint) + this.chunkMs);
      // Retention loss is explicit; never jump a cursor past an unprocessed outage.
      if (start < now - HORIZON + 300000) throw new Error('replay horizon exceeded');
      if (end < Date.parse(state.checkpoint)) throw new Error('checkpoint is ahead of collection clock');
      if (end <= start) throw new Error('initial checkpoint is not yet collectable');
      const result = await this.collector.collect({ source: this.source, from: new Date(start).toISOString(), to: new Date(end).toISOString(), signal, beforePage: renew,
        deliver: async (record) => {
          signal?.throwIfAborted();
          if (this.clock() - lastRenewed >= 60000) await renew();
          if (record.companyId !== this.companyId || record.scopeId !== this.tenantId
            || record.source !== (this.source === 'entra' ? 'microsoft-entra' : 'microsoft-defender')) throw new Error('record scope mismatch');
          // DurableDetectionEngine re-evaluates even duplicate events, repairing a
          // crash between event persistence and alert persistence on the next poll.
          if (this.source === 'entra') await this.detector.push(record, this.clock());
          else await this.detectionStore.saveAlert({ alert: record, now: this.clock() });
        } });
      if (result.checkpoint !== new Date(end).toISOString()) throw new Error('collector checkpoint mismatch');
      await renew();
      const stats = { received: result.received, delivered: result.delivered, pages: result.pages };
      await this.stateStore.complete(this, { owner, now: this.clock(), checkpoint: result.checkpoint, stats });
      return { status: 'completed', checkpoint: result.checkpoint, ...stats };
    } catch (error) {
      const failureCode = signal?.aborted ? 'interrupted' : /replay horizon/.test(error.message) ? 'replay-horizon-exceeded'
        : /Microsoft (authentication|collection) HTTP 401/.test(error.message) || /Microsoft authentication HTTP 400/.test(error.message) ? 'authentication-failed'
          : /Microsoft (authentication|collection) HTTP 403/.test(error.message) ? 'permission-denied'
            : /HTTP 429|Microsoft retry deferred/.test(error.message) ? 'throttled'
              : /Microsoft collection HTTP 5[0-9]{2}|Microsoft collection transport failed/.test(error.message) ? 'provider-unavailable' : 'poll-failed';
      try { await this.stateStore.fail(this, { owner, now: this.clock(), failureCode }); } catch { /* Lost owners cannot overwrite successor health. Expired leases read as stalled. */ }
      // A lost response to the final database update is ambiguous. The stored
      // cursor is authoritative and replay is safe; never claim it did not commit.
      throw new Error(`Microsoft poll ${failureCode}; read persisted checkpoint before retry`);
    }
  }
}
