import { randomUUID } from 'node:crypto';
import { sha256 } from '../incident-investigation/core.mjs';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/;
export const proposalDigest = (proposal) => sha256(proposal);

// authorize is a TRUSTED host adapter: authenticate the session and enforce tenant
// membership and permission. Never derive its result from request body actor/role fields.
export class ResponseService {
  constructor({ store, caseStore, authorize, resolveTarget, policy, provider, executionEnabled = false, clock = Date.now } = {}) {
    if (!store || !caseStore || !provider || [authorize, resolveTarget, policy].some((fn) => typeof fn !== 'function')) throw new Error('response requires persistence, trusted authorization, target resolver and policy');
    Object.assign(this, { store, caseStore, authorize, resolveTarget, policy, provider, executionEnabled, clock });
  }
  async actor(session, companyId, permission) {
    if (!TOKEN.test(companyId || '')) throw new Error('invalid company');
    const actor = await this.authorize(session, companyId, permission);
    if (!actor || actor.companyId !== companyId || !TOKEN.test(actor.id || '')) throw new Error('not authorized');
    return actor.id;
  }
  async context(proposal) {
    const current = await this.caseStore.getCase(proposal.companyId, proposal.caseId);
    if (!current || current.companyId !== proposal.companyId || current.caseId !== proposal.caseId || !current.confirmedIncidentId
      || !(proposal.action === 'unisolate' ? ['confirmed', 'closed'] : ['confirmed']).includes(current.status)) throw new Error('response requires a confirmed case');
    if (proposal.caseRevision !== undefined && current.revision !== proposal.caseRevision) throw new Error('case changed; request a new approval');
    const target = await this.resolveTarget(current, proposal.providerAlertId, proposal.machineId);
    if (!target || target.machineId !== proposal.machineId || !/^[a-f0-9]{64}$/.test(target.evidenceHash || '')
      || !/^[0-9a-f-]{36}$/i.test(target.tenantId || '')) throw new Error('invalid target evidence');
    if (proposal.evidenceHash && (proposal.evidenceHash !== target.evidenceHash || proposal.tenantId !== target.tenantId)) throw new Error('target evidence changed');
    if (await this.policy({ case: structuredClone(current), action: proposal.action, target: structuredClone(target) }) !== true) throw new Error('response policy denied');
    return { current, target };
  }
  async request({ session, companyId, caseId, providerAlertId, machineId, action, reason, expiresInMs = 900000 }) {
    const actor = await this.actor(session, companyId, 'response.request');
    if (!TOKEN.test(caseId || '') || typeof providerAlertId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(providerAlertId)
      || !/^[a-f0-9]{40}$/.test(machineId || '') || !['isolate', 'unisolate'].includes(action)) throw new Error('invalid response target/action');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500 || /(?:password|secret|access_token)\s*[:=]/i.test(reason)) throw new Error('invalid response reason');
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 60000 || expiresInMs > 900000) throw new Error('approval lifetime must be 1–15 minutes');
    const { current, target } = await this.context({ companyId, caseId, providerAlertId, machineId, action });
    const now = this.clock();
    const proposal = { companyId, caseId, caseRevision: current.revision, providerAlertId, machineId, action,
      tenantId: target.tenantId, evidenceHash: target.evidenceHash, reason: reason.trim(), requestedBy: actor,
      createdAt: now, expiresAt: now + expiresInMs };
    const record = { schemaVersion: '1', kind: 'maxwell.response', responseId: `rsp_${randomUUID()}`, proposal,
      digest: proposalDigest(proposal), state: 'requested', revision: 1, timeline: [{ at: now, actor, state: 'requested' }] };
    await this.store.create(record, current);
    return record;
  }
  async read({ session, companyId, responseId }) {
    await this.actor(session, companyId, 'response.read');
    return this.load(companyId, responseId);
  }
  async load(companyId, responseId) {
    if (!/^rsp_[0-9a-f-]{36}$/.test(responseId || '')) throw new Error('invalid response id');
    const record = await this.store.get(companyId, responseId);
    if (!record || record.proposal.companyId !== companyId || record.digest !== proposalDigest(record.proposal)) throw new Error('response missing or corrupted');
    return record;
  }
  async transition(previous, state, actor, extra = {}, currentCase) {
    const next = { ...previous, ...extra, state, revision: previous.revision + 1,
      timeline: [...previous.timeline, { at: this.clock(), actor, state }] };
    await this.store.change(previous, next, currentCase);
    return next;
  }
  async decide({ session, companyId, responseId, expectedRevision, digest, decision }) {
    if (!['approve', 'deny', 'cancel'].includes(decision)) throw new Error('invalid decision');
    const actor = await this.actor(session, companyId, decision === 'cancel' ? 'response.cancel' : 'response.approve');
    const record = await this.load(companyId, responseId);
    if (record.revision !== expectedRevision || record.digest !== digest) throw new Error('reviewed proposal changed');
    if (!(decision === 'cancel' ? ['requested', 'approved'] : ['requested']).includes(record.state)) throw new Error('response cannot be decided');
    if (this.clock() >= record.proposal.expiresAt) return this.transition(record, 'expired', actor);
    if (decision === 'cancel') return this.transition(record, 'cancelled', actor);
    if (actor === record.proposal.requestedBy) throw new Error('requester cannot approve or deny own request');
    if (decision === 'deny') return this.transition(record, 'denied', actor);
    const { current } = await this.context(record.proposal);
    if (this.clock() >= record.proposal.expiresAt) return this.transition(record, 'expired', actor);
    return this.transition(record, 'approved', actor, { approval: { actor, digest: record.digest, at: this.clock() } }, current);
  }
  async execute({ session, companyId, responseId, expectedRevision }) {
    const actor = await this.actor(session, companyId, 'response.execute');
    if (this.executionEnabled !== true) throw new Error('live response execution is disabled');
    const record = await this.load(companyId, responseId);
    if (record.revision !== expectedRevision || record.state !== 'approved' || record.approval?.digest !== record.digest
      || record.approval.actor === record.proposal.requestedBy) throw new Error('valid unconsumed approval required');
    if (this.clock() >= record.proposal.expiresAt) return this.transition(record, 'expired', actor);
    const { current } = await this.context(record.proposal);
    if (this.clock() >= record.proposal.expiresAt) return this.transition(record, 'expired', actor);
    // The claim must be durably acknowledged BEFORE any network side effect.
    const claimed = await this.transition(record, 'executing', actor, {}, current);
    if (this.clock() >= record.proposal.expiresAt) return this.transition(claimed, 'expired', actor);
    let outcome;
    try { outcome = await this.provider.submit(claimed); }
    catch { return this.transition(claimed, 'unknown', actor); }
    // A failed/ambiguous persistence acknowledgment leaves executing non-retryable.
    if (!outcome || !['submitted', 'succeeded', 'failed', 'unknown'].includes(outcome.state) || typeof outcome.providerActionId !== 'string') return this.transition(claimed, 'unknown', actor);
    return this.transition(claimed, outcome.state, actor, { providerActionId: outcome.providerActionId });
  }
  async reconcile({ session, companyId, responseId, expectedRevision, providerActionId }) {
    const actor = await this.actor(session, companyId, 'response.reconcile');
    const record = await this.load(companyId, responseId);
    if (record.revision !== expectedRevision || !['executing', 'unknown', 'submitted'].includes(record.state)) throw new Error('response cannot be reconciled');
    if (record.providerActionId && providerActionId && record.providerActionId !== providerActionId) throw new Error('provider action mismatch');
    const outcome = await this.provider.inspect(record, record.providerActionId || providerActionId);
    if (!outcome || !['submitted', 'succeeded', 'failed', 'unknown'].includes(outcome.state) || typeof outcome.providerActionId !== 'string') throw new Error('invalid provider reconciliation');
    // Polling an unchanged pending action does not grow the audit log indefinitely.
    if (outcome.state === record.state && outcome.providerActionId === record.providerActionId) return record;
    return this.transition(record, outcome.state, actor, { providerActionId: outcome.providerActionId });
  }
}
