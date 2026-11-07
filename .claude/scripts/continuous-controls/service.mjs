import { randomUUID } from 'node:crypto';
import { ulid } from '../../hooks/lib.mjs';
import { sha256 } from '../incident-investigation/core.mjs';
import { actor, requireValue, provenance, timestamp } from '../feature-runtime/store.mjs';
import { checkArtifact, validateCheck } from '../remediation/checks.mjs';

export class ContinuousControlService {
  constructor({ store, authorize, loadControl, resolveCheckout, publish, checker = checkArtifact, clock = Date.now, leaseMs = 120000 }) {
    requireValue(store && [authorize, loadControl, resolveCheckout, publish, checker].every((x) => typeof x === 'function') && Number.isSafeInteger(leaseMs) && leaseMs >= 1000, 'control testing adapters required');
    Object.assign(this, { store, authorize, loadControl, resolveCheckout, publish, checker, clock, leaseMs });
  }
  async register({ session, companyId, controlId, target, check, revision, intervalMs = 3600000, evidenceTtlMs = 7200000 }) {
    const by = await actor(this.authorize, session, companyId, 'controls.configure'); validateCheck(check);
    requireValue(Number.isSafeInteger(intervalMs) && intervalMs >= 60000 && intervalMs <= 30 * 86400000
      && Number.isSafeInteger(evidenceTtlMs) && evidenceTtlMs >= intervalMs && evidenceTtlMs <= 90 * 86400000 && /^[a-f0-9]{40}$/.test(revision), 'invalid schedule timing/revision');
    const control = await this.loadControl(companyId, controlId);
    requireValue(control?.kind === 'control' && control.companyId === companyId && control.id === controlId
      && control.applicableAssets?.some((a) => sha256(a) === sha256(target)), 'control/target not in scope');
    await this.resolveCheckout(companyId, target);
    const value = { kind: 'maxwell.control.schedule', id: `schedule_${randomUUID()}`, companyId, controlId, controlHash: sha256(control),
      target: structuredClone(target), check: structuredClone(check), revision, intervalMs, evidenceTtlMs, nextDueAt: this.clock(), status: 'idle', configuredBy: by };
    return this.store.change(companyId, value.id, null, value, this.clock());
  }
  async tick({ session, companyId, id }) {
    await actor(this.authorize, session, companyId, 'controls.run');
    let current = await this.store.get(companyId, id); requireValue(current?.value.kind === 'maxwell.control.schedule', 'schedule not found');
    let v = current.value; const now = this.clock();
    if (v.paused) return { status: 'paused' };
    if (v.status === 'idle' && now < v.nextDueAt) return { status: 'not-due' };
    if (v.leaseUntil > now) return { status: 'busy' };
    const owner = randomUUID();
    try { current = await this.store.change(companyId, id, current, { ...v, status: v.status === 'publishing' ? 'publishing' : 'running', owner,
      leaseUntil: now + this.leaseMs, runId: v.status === 'idle' ? `obs_${ulid()}` : v.runId, attemptAt: now }, now); }
    catch (e) { if (/conflict/.test(e.message)) return { status: 'busy' }; throw e; }
    v = current.value;
    if (v.status !== 'publishing') {
      let result; const control = await this.loadControl(companyId, v.controlId);
      try {
        requireValue(sha256(control) === v.controlHash, 'control changed');
        result = await this.checker({ checkout: await this.resolveCheckout(companyId, v.target), revision: v.revision, check: v.check });
        requireValue(sha256(await this.loadControl(companyId, v.controlId)) === v.controlHash, 'control changed during check');
        requireValue(['passed', 'failed'].includes(result?.outcome) && result.revision === v.revision && result.checkHash === sha256(v.check) && /^[a-f0-9]{64}$/.test(result.artifactHash), 'invalid control evidence');
      } catch { result = { outcome: 'inconclusive' }; }
      requireValue(this.clock() < v.leaseUntil, 'control lease lost; retry after expiry');
      const at = timestamp(this.clock());
      const observation = { schemaVersion: '1', kind: 'observation', id: v.runId, companyId, recordedAt: at,
        title: `Scheduled control check: ${v.controlId}`, description: result.outcome === 'inconclusive' ? 'Control could not be tested; inspect source revision, scope and check availability.' : `Deterministic ${v.check.type} assertion ${result.outcome} for commit ${v.revision}.`,
        controlIds: [v.controlId], subjects: [v.target], methods: ['manual'], collectedAt: at,
        expiresAt: timestamp(this.clock() + v.evidenceTtlMs), result: { passed: 'satisfied', failed: 'not-satisfied', inconclusive: 'inconclusive' }[result.outcome],
        evidence: result.artifactHash ? [{ type: 'commit', ref: v.revision, sha256: result.artifactHash, collectedAt: at, description: `Check ${sha256(v.check)}` }] : [],
        provenance: provenance(this.store.sessionId, this.clock(), 'continuous-control-testing') };
      current = await this.store.change(companyId, id, current, { ...v, status: 'publishing', pending: { result, observation, collectedAt: this.clock() } }, this.clock());
      v = current.value;
    }
    requireValue(this.clock() < v.leaseUntil, 'control lease lost before publication');
    await this.publish(companyId, v.pending.observation);
    // A successor claim changes the CAS revision. An old owner can never commit its result.
    requireValue(this.clock() < v.leaseUntil, 'control lease lost after publication');
    const outcome = v.pending.result.outcome;
    const next = { ...v, status: 'idle', lastOutcome: outcome, lastSuccessAt: outcome === 'inconclusive' ? v.lastSuccessAt || null : v.pending.collectedAt,
      lastAttemptAt: v.pending.collectedAt, evidenceExpiresAt: v.pending.collectedAt + v.evidenceTtlMs,
      drift: v.lastOutcome === 'passed' && outcome === 'failed', consecutiveFailures: outcome === 'inconclusive' ? (v.consecutiveFailures || 0) + 1 : 0,
      nextDueAt: this.clock() + v.intervalMs };
    delete next.owner; delete next.leaseUntil; delete next.pending; delete next.runId;
    await this.store.change(companyId, id, current, next, this.clock());
    return { status: 'completed', outcome, drift: next.drift, observationId: v.pending.observation.id };
  }
  async pause({ session, companyId, id, expectedRevision, paused }) {
    await actor(this.authorize, session, companyId, 'controls.configure');
    const current = await this.store.get(companyId, id);
    requireValue(current?.revision === expectedRevision && current.value.status === 'idle' && typeof paused === 'boolean', 'cannot change active/stale schedule');
    return this.store.change(companyId, id, current, { ...current.value, paused }, this.clock());
  }
  async health({ session, companyId, id }) {
    await actor(this.authorize, session, companyId, 'controls.read');
    const state = await this.store.get(companyId, id); requireValue(state, 'schedule not found'); const v = state.value; const now = this.clock();
    const changed = sha256(await this.loadControl(companyId, v.controlId)) !== v.controlHash;
    const status = changed ? 'scope-changed' : v.paused ? 'paused' : v.status !== 'idle' ? (v.leaseUntil <= now ? 'stalled' : v.status)
      : !v.lastAttemptAt ? 'never-tested' : v.lastOutcome === 'inconclusive' ? 'check-failed'
        : now >= v.evidenceExpiresAt ? 'evidence-expired' : now > v.nextDueAt + v.intervalMs ? 'overdue' : v.lastOutcome === 'failed' ? 'control-failed' : 'healthy';
    return { status, ready: status === 'healthy', nextDueAt: v.nextDueAt, lastOutcome: v.lastOutcome || null, consecutiveFailures: v.consecutiveFailures || 0, drift: v.drift || false };
  }
}
