// Moves a company off an instrument that the registry marks repealed or superseded and onto its successor, using
// ledger supersessions only (soc-ledger section 2; regulatory-catalogs skill, repealed instruments). Pure: the
// caller reads the inputs and writes what this returns (soc/migrate-instrument.mjs).
import { latestById } from './ledger.mjs';

// Catalog cadence in days for nextDueAt of a control that has never been assessed (soc-ledger section 4).
// continuous and event-driven use what refresh-soc writes for such controls: 30 and 91 days.
export const CADENCE_DAYS = { daily: 1, weekly: 7, monthly: 30, quarterly: 91, 'half-yearly': 182, annual: 365, biennial: 730, continuous: 30, 'event-driven': 91 };
const REPEALED = ['repealed', 'superseded'];
const TERMINAL = { finding: ['resolved', 'false-positive', 'duplicate'], risk: ['closed'], incident: ['closed', 'false-positive'] };

const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const shortText = (s, max = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const joinText = (a, b) => (a ? `${a}\n${b}` : b);
const dedupeRefs = (refs) => {
  const seen = new Set();
  return refs.filter((r) => { const k = `${r.instrument}|${r.controlId}`; if (seen.has(k)) return false; seen.add(k); return true; });
};
const dedupeEvidence = (items) => {
  const seen = new Set();
  return items.filter((e) => { const k = `${e.type}|${e.ref}`; if (seen.has(k)) return false; seen.add(k); return true; });
};

export function applies(control, details) {
  const a = control.applicability || {};
  const entityTypes = details.entityTypes || [];
  const categories = (details.regulatoryRegistrations || []).map((r) => r.category).filter(Boolean);
  if (a.entityTypes && a.entityTypes.length && !a.entityTypes.some((e) => entityTypes.includes(e))) return false;
  if (a.reCategories && a.reCategories.length && !a.reCategories.some((c) => categories.includes(c))) return false;
  return true;
}

export function planMigration({ companyId, details, registry, catalog, ledger, from, to, now, provenance, catalogPath, registryPath }) {
  const entries = new Map((registry.instruments || []).map((i) => [i.instrumentId, i]));
  const old = entries.get(from);
  const next = entries.get(to);
  if (!old) throw new Error(`${from} is not in the instrument registry`);
  if (!REPEALED.includes(old.status)) throw new Error(`${from} is not repealed or superseded in the registry (status ${old.status || 'in-force'})`);
  if (!(old.supersededBy || []).includes(to)) throw new Error(`${to} is not listed in the supersededBy of ${from} (${(old.supersededBy || []).join(', ') || 'none'})`);
  if (!next) throw new Error(`${to} is not in the instrument registry`);
  if (REPEALED.includes(next.status)) throw new Error(`${to} is itself ${next.status}`);
  if (!catalog || catalog.instrumentId !== to) throw new Error(`the catalog passed is not the ${to} catalog`);

  const latest = latestById(ledger);
  const firstRecordedAt = new Map();
  for (const r of ledger) if (!firstRecordedAt.has(r.id)) firstRecordedAt.set(r.id, r.recordedAt);
  const records = [];
  const warnings = [];

  // Successor controls that apply to the company, and the old paragraphs each one maps from.
  const successors = [];
  const successorsOf = new Map();
  for (const group of catalog.groups || []) {
    for (const control of group.controls || []) {
      if (!applies(control, details)) continue;
      const predecessors = (control.mappings || []).filter((m) => m.instrument === from).map((m) => m.controlId);
      successors.push({ group, control, predecessors });
      for (const p of predecessors) successorsOf.set(p, [...(successorsOf.get(p) || []), control.id]);
    }
  }

  // 1. A control record for every applicable successor control not yet in the ledger.
  const added = [];
  for (const { group, control, predecessors } of successors) {
    const id = `${to}:${control.id}`;
    if (latest.has(id)) continue;
    const days = CADENCE_DAYS[control.cadence];
    if (days === undefined) warnings.push(`${id}: unknown cadence ${control.cadence}; nextDueAt uses 91 days`);
    const rec = {
      schemaVersion: '1', kind: 'control', id, companyId,
      frameworkRefs: dedupeRefs([{ regulator: next.regulator, instrument: to, controlId: control.id }, ...(control.mappings || [])]),
      title: shortText(control.title), category: shortText(control.category || group.title),
      implementationStatus: 'unknown', effectiveness: 'not-tested', nextDueAt: addDays(now, days === undefined ? 91 : days),
      evidence: [{ type: 'workspace-file', ref: catalogPath }], recordedAt: now, provenance,
    };
    const preds = predecessors.map((p) => latest.get(`${from}:${p}`)).filter(Boolean);
    if (preds.length) {
      // An assessment of the repealed paragraph is not evidence for the new one: name it, do not copy it.
      const assessed = preds.filter((p) => p.effectiveness && p.effectiveness !== 'not-tested');
      rec.notes = `Successor of ${preds.map((p) => p.id).join(', ')} (${from} ${old.status} on ${old.repealedOn}).`
        + (assessed.length ? ` Predecessor assessments were not carried over; re-assess against this paragraph: ${assessed.map((p) => `${p.id} ${p.effectiveness}${p.lastAssessedAt ? ` at ${p.lastAssessedAt}` : ''}`).join('; ')}.` : '');
    }
    records.push(rec);
    added.push(id);
  }

  // 2. Controls of the repealed instrument become not-applicable, naming their successors.
  const retired = [];
  for (const r of latest.values()) {
    if (r.kind !== 'control' || !r.frameworkRefs || r.frameworkRefs[0].instrument !== from || r.implementationStatus === 'not-applicable') continue;
    const succ = (successorsOf.get(r.frameworkRefs[0].controlId) || []).map((s) => `${to}:${s}`);
    const { nextDueAt, ...rest } = r;
    const note = `Not applicable from ${old.repealedOn}: ${from} is ${old.status} in the instrument registry and replaced by ${to}. `
      + (succ.length ? `Successor controls: ${succ.join(', ')}.` : `No ${to} control that applies to ${companyId} maps to this paragraph in the catalog; review the successor catalog for equivalent obligations.`);
    records.push({
      ...rest, implementationStatus: 'not-applicable', notes: joinText(r.notes, note),
      evidence: dedupeEvidence([...(r.evidence || []), { type: 'workspace-file', ref: registryPath }]),
      supersedes: r.id, recordedAt: now, provenance,
    });
    retired.push({ id: r.id, successors: succ });
  }

  // 3. Open findings, risks and incidents citing the repealed instrument cite the successor instead. The old ref
  // survives only as a secondary, historical ref on records first seen before the repeal.
  const remapped = [];
  for (const r of latest.values()) {
    if (!TERMINAL[r.kind] || TERMINAL[r.kind].includes(r.status)) continue;
    const refs = r.regulatoryRefs || [];
    const controlIds = r.controlIds || [];
    if (!refs.some((x) => x.instrument === from) && !controlIds.some((c) => c.startsWith(`${from}:`))) continue;
    const firstSeen = r.firstSeenAt || r.detectedAt || firstRecordedAt.get(r.id) || '';
    const historical = firstSeen.slice(0, 10) < old.repealedOn;
    const changes = [];
    const newRefs = [];
    for (const ref of refs) {
      if (ref.instrument !== from) { newRefs.push(ref); continue; }
      const succ = successorsOf.get(ref.controlId) || [];
      for (const s of succ) newRefs.push({ regulator: next.regulator, instrument: to, controlId: s });
      if (historical) newRefs.push(ref);
      changes.push(`${ref.controlId} -> ${succ.length ? succ.join(', ') : 'no applicable successor'}`);
    }
    const newControlIds = [];
    for (const c of controlIds) {
      if (!c.startsWith(`${from}:`)) { newControlIds.push(c); continue; }
      for (const s of successorsOf.get(c.slice(from.length + 1)) || []) newControlIds.push(`${to}:${s}`);
      if (historical) newControlIds.push(c);
    }
    const outRefs = dedupeRefs(newRefs);
    const outControlIds = [...new Set(newControlIds)];
    // A record first seen before the repeal keeps its historical ref, so it matches again on every run: skip it
    // once it already cites every successor.
    if (JSON.stringify(outRefs) === JSON.stringify(refs) && JSON.stringify(outControlIds) === JSON.stringify(controlIds)) continue;
    if (!outRefs.length) { warnings.push(`${r.id}: every regulatoryRef was ${from} with no applicable successor; left for a human`); continue; }
    if (r.slaBasis && r.slaBasis.instrument === from) warnings.push(`${r.id}: slaBasis still cites ${from}; recompute slaDueAt from the sla-table`);
    const rec = { ...r, regulatoryRefs: outRefs, supersedes: r.id, recordedAt: now, provenance };
    if (r.controlIds) rec.controlIds = [...new Set(newControlIds)];
    const note = `Re-mapped on ${now.slice(0, 10)} after ${from} was ${old.status} (${old.repealedOn}), ${from} to ${to}: ${changes.join('; ') || 'control ids only'}.`;
    if (typeof r.description === 'string') rec.description = joinText(r.description, note);
    records.push(rec);
    remapped.push({ id: r.id, changes });
  }

  // 4. The company profile lists the successor instead.
  const scope = details.frameworksInScope || [];
  const nextScope = scope.includes(to) ? scope.filter((x) => x !== from) : scope.map((x) => (x === from ? to : x));
  const detailsChanged = JSON.stringify(nextScope) !== JSON.stringify(scope);
  const nextDetails = detailsChanged ? { ...details, frameworksInScope: nextScope, provenance } : details;
  if (JSON.stringify({ ...nextDetails, provenance: undefined }).includes(`"${from}"`)) warnings.push(`details.json still mentions ${from} outside frameworksInScope`);

  return {
    records, details: nextDetails, detailsChanged,
    summary: {
      from, to, repealedOn: old.repealedOn, applicableSuccessorControls: successors.length,
      added: added.length, retired: retired.length, remapped: remapped.length,
      retiredWithoutSuccessor: retired.filter((r) => !r.successors.length).map((r) => r.id),
      remappedRecords: remapped, warnings,
    },
  };
}
