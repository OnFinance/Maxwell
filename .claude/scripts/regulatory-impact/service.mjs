import { randomUUID } from 'node:crypto';
import { ulid } from '../../hooks/lib.mjs';
import { sha256 } from '../incident-investigation/core.mjs';
import { actor, requireValue, token, provenance, timestamp } from '../feature-runtime/store.mjs';

function sourceDocument(document, hosts) {
  requireValue(document && token(document.instrument) && token(document.version) && Array.isArray(document.clauses) && document.clauses.length <= 1000, 'invalid regulatory snapshot');
  const url = new URL(document.url);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && hosts.includes(url.hostname), 'source URL is not approved');
  requireValue(typeof document.effectiveAt === 'string' && Number.isFinite(Date.parse(document.effectiveAt)) && timestamp(Date.parse(document.effectiveAt)) === document.effectiveAt, 'invalid effective date');
  const clauses = structuredClone(document.clauses).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ids = new Set();
  for (const clause of clauses) {
    requireValue(token(clause.id) && !ids.has(clause.id) && typeof clause.text === 'string' && clause.text.trim() && clause.text.length <= 10000, 'invalid or duplicate source clause'); ids.add(clause.id);
  }
  const normalized = { instrument: document.instrument, version: document.version, url: url.href, effectiveAt: document.effectiveAt,
    clauses: clauses.map(({ id, text }) => ({ id, text })) };
  requireValue(Buffer.byteLength(JSON.stringify(normalized)) <= 2 * 1024 * 1024, 'regulatory snapshot too large');
  return normalized;
}

export class RegulatoryImpactService {
  constructor({ store, authorize, loadScope, publish, sourceHosts, clock = Date.now }) {
    requireValue(store && [authorize, loadScope, publish].every((v) => typeof v === 'function') && Array.isArray(sourceHosts) && sourceHosts.length
      && sourceHosts.every((h) => typeof h === 'string' && /^[a-z0-9.-]+$/.test(h)), 'regulatory impact adapters and approved hosts required');
    Object.assign(this, { store, authorize, loadScope, publish, sourceHosts: [...sourceHosts], clock });
  }
  async importSource({ session, companyId, document }) {
    const by = await actor(this.authorize, session, companyId, 'regulation.import');
    const source = sourceDocument(document, this.sourceHosts); const scope = await this.loadScope(companyId);
    requireValue(scope.instruments.includes(source.instrument), 'instrument not in company scope');
    const id = `source_${sha256([source.instrument, source.url, source.version])}`;
    const current = await this.store.get(companyId, id);
    if (current) { requireValue(current.value.contentHash === sha256(source), 'source version reused with different content'); return current; }
    return this.store.change(companyId, id, null, { kind: 'maxwell.regulatory.source', id, companyId, source,
      contentHash: sha256(source), importedBy: by, importedAt: this.clock(), authenticity: 'operator-supplied; requires source review' }, this.clock());
  }
  async compare({ session, companyId, previousId, nextId }) {
    const by = await actor(this.authorize, session, companyId, 'regulation.compare');
    const previous = await this.store.get(companyId, previousId); const next = await this.store.get(companyId, nextId);
    requireValue(previous?.value.kind === 'maxwell.regulatory.source' && next?.value.kind === 'maxwell.regulatory.source', 'source snapshots missing');
    const before = previous.value.source; const after = next.value.source;
    requireValue(before.instrument === after.instrument && before.url === after.url && previousId !== nextId
      && Date.parse(after.effectiveAt) >= Date.parse(before.effectiveAt), 'incompatible or reversed source comparison');
    const scope = await this.loadScope(companyId); requireValue(scope.instruments.includes(after.instrument), 'instrument no longer in scope');
    const old = new Map(before.clauses.map((c) => [c.id, c.text])); const fresh = new Map(after.clauses.map((c) => [c.id, c.text]));
    const changes = [];
    for (const id of [...new Set([...old.keys(), ...fresh.keys()])].sort()) {
      if (old.get(id) === fresh.get(id)) continue;
      const suggested = scope.controls.filter((c) => c.companyId === companyId && c.frameworkRefs?.some((r) => r.instrument === after.instrument && r.controlId === id));
      changes.push({ clauseId: id, type: !old.has(id) ? 'added' : !fresh.has(id) ? 'removed' : 'changed',
        beforeHash: old.has(id) ? sha256(old.get(id)) : null, afterHash: fresh.has(id) ? sha256(fresh.get(id)) : null,
        suggestedControlIds: suggested.map((c) => c.id), unmapped: !suggested.length });
    }
    const scopeHash = sha256(scope); const id = `impact_${sha256([previousId, nextId, scopeHash])}`;
    const existing = await this.store.get(companyId, id); if (existing) return existing;
    const value = { kind: 'maxwell.regulatory.impact', id, companyId, previousId, nextId, instrument: after.instrument, url: after.url,
      sourceHashes: [previous.value.contentHash, next.value.contentHash], scopeHash, changes, state: changes.length ? 'needs-review' : 'unchanged', preparedBy: by, preparedAt: this.clock() };
    value.reviewDigest = sha256(value);
    return this.store.change(companyId, id, null, value, this.clock());
  }
  async review({ session, companyId, id, expectedRevision, digest, decision, note, mappings = [] }) {
    const by = await actor(this.authorize, session, companyId, 'regulation.review');
    let current = await this.store.get(companyId, id); const v = current?.value;
    requireValue(current?.revision === expectedRevision && ['needs-review', 'publishing'].includes(v?.state) && digest === v.reviewDigest, 'impact review revision/digest conflict');
    requireValue(by !== v.preparedBy && ['accept', 'reject'].includes(decision) && typeof note === 'string' && note.trim() && note.length <= 500, 'independent regulatory review required');
    if (v.state === 'publishing') {
      requireValue(by === v.reviewedBy && decision === 'accept', 'publication owned by original reviewer');
      await this.publish(companyId, v.observation);
      return this.store.change(companyId, id, current, { ...v, state: 'accepted' }, this.clock());
    }
    const scope = await this.loadScope(companyId); requireValue(sha256(scope) === v.scopeHash, 'company controls changed; compare again');
    if (decision === 'reject') return this.store.change(companyId, id, current, { ...v, state: 'rejected', reviewedBy: by, reviewNote: note.trim() }, this.clock());
    requireValue(Array.isArray(mappings) && mappings.length === v.changes.length && new Set(mappings.map((m) => m.clauseId)).size === mappings.length, 'review every changed clause');
    const proposals = []; const controlIds = new Set();
    for (const change of v.changes) {
      const mapping = mappings.find((m) => m.clauseId === change.clauseId);
      requireValue(mapping && typeof mapping.rationale === 'string' && mapping.rationale.trim() && mapping.rationale.length <= 500
        && ['mapped', 'not-applicable'].includes(mapping.outcome), 'mapping review required');
      if (mapping.outcome === 'not-applicable') { requireValue(!mapping.controlIds?.length, 'not-applicable cannot map controls'); continue; }
      requireValue(Array.isArray(mapping.controlIds) && mapping.controlIds.length > 0 && new Set(mapping.controlIds).size === mapping.controlIds.length, 'mapped clause requires controls');
      for (const controlId of mapping.controlIds) {
        const control = scope.controls.find((c) => c.id === controlId && c.companyId === companyId && c.frameworkRefs?.some((r) => r.instrument === v.instrument));
        requireValue(control?.applicableAssets?.length, 'control mapping out of scope'); controlIds.add(controlId);
        for (const target of control.applicableAssets) proposals.push({ title: `Review ${change.type} clause ${change.clauseId} against ${controlId}`,
          controlId, target, sourceUrl: v.url, sourceHashes: v.sourceHashes, rationale: mapping.rationale,
          acceptanceCriteria: ['Review the source amendment and its applicability', 'Record implementation evidence or an approved exception'], verificationMethod: { type: 'evidence-review', description: 'Independent review of the accepted regulatory interpretation and supporting evidence' } });
      }
    }
    const observation = { schemaVersion: '1', kind: 'observation', id: `obs_${ulid()}`, companyId, recordedAt: timestamp(this.clock()),
      title: `Reviewed regulatory change: ${v.instrument}`, description: `Independent reviewer ${by} accepted impact review ${id}. ${proposals.length} remediation task proposal(s); no obligations or tasks were changed automatically.`,
      ...(controlIds.size ? { controlIds: [...controlIds] } : {}), methods: ['manual'], collectedAt: timestamp(this.clock()),
      result: 'inconclusive', evidence: [{ type: 'url', ref: v.url, sha256: v.sourceHashes[1], description: 'Operator-supplied normalized source snapshot, independently reviewed' }],
      provenance: provenance(this.store.sessionId, this.clock(), 'regulatory-change-impact') };
    current = await this.store.change(companyId, id, current, { ...v, state: 'publishing', reviewedBy: by, reviewNote: note.trim(), mappings: structuredClone(mappings), proposals, observation }, this.clock());
    await this.publish(companyId, observation);
    return this.store.change(companyId, id, current, { ...current.value, state: 'accepted' }, this.clock());
  }
}
