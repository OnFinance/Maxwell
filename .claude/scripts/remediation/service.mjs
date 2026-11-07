import { randomUUID } from 'node:crypto';
import { sha256 } from '../incident-investigation/core.mjs';
import { actor, requireValue, timestamp } from '../feature-runtime/store.mjs';
import { checkArtifact, validateCheck } from './checks.mjs';

// load and publish are trusted workspace adapters. publish must atomically compare the
// current finding signature and append a schema-validated superseding finding, idempotently.
export class RemediationService {
  constructor({ store, authorize, load, publish, checker = checkArtifact, clock = Date.now, ttlMs = 3600000 }) {
    requireValue(store && [authorize, load, publish, checker].every((v) => typeof v === 'function') && Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 86400000, 'remediation adapters required');
    Object.assign(this, { store, authorize, load, publish, checker, clock, ttlMs });
  }
  async context(companyId, findingId, initiativeId, taskId) {
    requireValue(/^fnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(findingId) && /^init_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(initiativeId) && /^task_[1-9][0-9]{0,5}$/.test(taskId), 'invalid remediation identity');
    const data = await this.load({ companyId, findingId, initiativeId, taskId });
    requireValue(data?.finding?.companyId === companyId && data.task?.companyId === companyId && data.finding.id === findingId
      && data.task.initiativeId === initiativeId && data.task.taskId === taskId && data.task.acceptanceCriteria?.length, 'remediation scope mismatch');
    requireValue(data.task.targets?.some((t) => ['type', 'appId', 'repoId', 'envId', 'imageId'].every((k) => t[k] === data.finding.target?.[k])), 'task target does not match finding');
    return data;
  }
  async open({ session, companyId, findingId, initiativeId, taskId, check, revision }) {
    const requestedBy = await actor(this.authorize, session, companyId, 'remediation.request'); validateCheck(check);
    requireValue(/^[a-f0-9]{40}$/.test(revision), 'full target commit required');
    const { finding, task } = await this.context(companyId, findingId, initiativeId, taskId);
    requireValue(['open', 'triaged', 'remediating'].includes(finding.status), 'finding not open');
    const value = { kind: 'maxwell.remediation', id: `verify_${randomUUID()}`, companyId, findingId, initiativeId, taskId,
      findingHash: sha256(finding), taskHash: sha256(task), criteriaHash: sha256(task.acceptanceCriteria), check: structuredClone(check), targetRevision: revision,
      requestedBy, state: 'requested', createdAt: this.clock() };
    return this.store.change(companyId, value.id, null, value, this.clock());
  }
  async verify({ session, companyId, id, expectedRevision }) {
    const by = await actor(this.authorize, session, companyId, 'remediation.verify');
    const current = await this.store.get(companyId, id); requireValue(current?.revision === expectedRevision && ['requested', 'failed', 'inconclusive'].includes(current.value.state), 'verification revision conflict');
    const v = current.value; const data = await this.context(companyId, v.findingId, v.initiativeId, v.taskId);
    requireValue(sha256(data.finding) === v.findingHash && sha256(data.task) === v.taskHash, 'remediation inputs changed; request again');
    let result;
    try { result = await this.checker({ checkout: data.checkout, revision: v.targetRevision, check: v.check }); }
    catch { result = { outcome: 'inconclusive', reason: 'target unavailable, changed, unsafe, or check could not complete' }; }
    requireValue(['passed', 'failed', 'inconclusive'].includes(result?.outcome), 'invalid verification result');
    if (result.outcome === 'passed') requireValue(result.revision === v.targetRevision && result.checkHash === sha256(v.check) && /^[a-f0-9]{64}$/.test(result.artifactHash), 'invalid verification evidence');
    return this.store.change(companyId, id, current, { ...v, state: result.outcome === 'passed' ? 'verified' : result.outcome,
      result, verifiedBy: by, verifiedAt: this.clock(), expiresAt: this.clock() + this.ttlMs }, this.clock());
  }
  async close({ session, companyId, id, expectedRevision, criteriaHash, note }) {
    const by = await actor(this.authorize, session, companyId, 'remediation.close');
    let current = await this.store.get(companyId, id);
    requireValue(current?.revision === expectedRevision && ['verified', 'closing'].includes(current.value.state), 'closure revision conflict');
    const v = current.value;
    requireValue(by !== v.requestedBy && criteriaHash === v.criteriaHash && typeof note === 'string' && note.trim() && note.length <= 500, 'independent criteria review required');
    const data = await this.context(companyId, v.findingId, v.initiativeId, v.taskId);
    if (v.state === 'closing' && sha256(data.finding) === sha256(v.closureRecord)) {
      requireValue(v.closedBy === by, 'closure owned by another reviewer');
      return this.store.change(companyId, id, current, { ...v, state: 'closed' }, this.clock());
    }
    requireValue(this.clock() < v.expiresAt && sha256(data.finding) === v.findingHash && sha256(data.task) === v.taskHash && data.task.status === 'done', 'stale verification or task not done');
    const recheck = await this.checker({ checkout: data.checkout, revision: v.targetRevision, check: v.check });
    requireValue(sha256(recheck) === sha256(v.result), 'target changed since verification');
    requireValue(this.clock() < v.expiresAt, 'verification expired during recheck');
    const output = { ...data.finding, provenance: { ...data.finding.provenance, harness: 'script', workflow: 'manual', agent: 'remediation-verification', sessionId: this.store.sessionId, generatedAt: timestamp(v.verifiedAt) }, status: 'resolved', supersedes: data.finding.id,
      resolvedAt: timestamp(v.verifiedAt), recordedAt: timestamp(v.verifiedAt),
      evidence: [...(data.finding.evidence || []), { type: 'command-output', ref: `verification:${id}`, sha256: sha256(v.result), collectedAt: timestamp(v.verifiedAt), description: 'Revision-bound deterministic check; acceptance criteria reviewed independently' }] };
    if (v.state !== 'closing') current = await this.store.change(companyId, id, current, { ...v, state: 'closing', closedBy: by, reviewNote: note.trim(), closureRecord: output }, this.clock());
    else requireValue(current.value.closedBy === by, 'closure owned by another reviewer');
    await this.publish({ companyId, record: current.value.closureRecord, expectedSignature: v.findingHash });
    return this.store.change(companyId, id, current, { ...current.value, state: 'closed' }, this.clock());
  }
}
