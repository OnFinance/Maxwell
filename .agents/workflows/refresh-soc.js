// refresh-soc: rebuild and reconcile the state-of-controls inventory of one company.
// For each applicable instrument in company-profile/<companyId>/details.json load the regulator catalog, diff it
// against the ledger's latest control records, append new/updated control records, re-evaluate every finding's
// status by fingerprint (resolved when absent in the last two probe runs of its originating workflow), recompute
// SLA due dates from the sla-table, reopen expired risk acceptances (both the risk and the finding, soc-ledger SKILL
// 8.2), refresh the control-summary section, then version the ledger (soc/version.mjs) once.
// Shape: Scout -> Inventory (one soc-ledger-keeper in propose-only mode per instrument) || Reconcile (one per
// originating workflow) -> Verify (refuter: 3 lenses over batches of 12, majority for additions, unanimity for
// resolved/reopen finding transitions, risk reopenings and not-applicable marks) -> Dedup barrier -> Write
// (soc-ledger-keeper appends via soc/append.mjs: controls, finding supersessions, then risk supersessions) -> Summary
// (report-writer; its proposedObservation is appended by the keeper) -> Version.
// NOW is resolved once: args.now when given, otherwise the Scout (soc-ledger-keeper, which may run `node -e`) reads
// the clock and every later prompt receives that literal, because refuter and report-writer have no clock.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
// appIds/envIds narrow the finding reconciliation and the control applicableAssets to those assets; the instrument
// inventory is always company-wide. dryRun proposes and verifies but writes only one observation with result
// 'inconclusive' describing what would change; it never appends controls or finding transitions and never versions.
export const meta = {
  name: 'refresh-soc',
  description: 'Rebuild controls from applicable catalogs, resolve findings absent twice by fingerprint, recompute SLAs, version the ledger. args: companyId, appIds, envIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Scout', detail: 'Applicable instruments, latest control records, open findings grouped by originating workflow, ledger statistics' },
    { title: 'Inventory', detail: 'Per instrument: diff the catalog against the ledger and propose new or superseding control records' },
    { title: 'Reconcile', detail: 'Per originating workflow: match findings by fingerprint, apply the absent-twice rule, reopen expired acceptances, recompute SLA' },
    { title: 'Verify', detail: 'Batched refuter lenses correctness, regulatory-mapping, dates-and-cadence; majority for additions, unanimity for transitions and not-applicable marks' },
    { title: 'Dedup', detail: 'Barrier: one record per control id and per finding id across instruments and workflows' },
    { title: 'Write', detail: 'soc-ledger-keeper appends controls, finding supersessions and risk supersessions via soc/append.mjs' },
    { title: 'Summary', detail: 'report-writer rewrites the control-summary section of summary.md and proposes its report observation' },
    { title: 'Version', detail: 'soc-ledger-keeper appends the report observation, then soc/version.mjs writes versions/commit_<n>.diff' },
  ],
};

async function main() {
const WORKFLOW = 'refresh-soc';
const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
let now = (args && args.now) || null;
if (now && !NOW_RE.test(now)) throw new Error('args.now must be an RFC 3339 UTC timestamp with a trailing Z');
const sessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appIds = Array.isArray(args && args.appIds) && args.appIds.length ? args.appIds : null;
const envIds = Array.isArray(args && args.envIds) && args.envIds.length ? args.envIds : null;

const PROFILE = `company-profile/${companyId}/details.json`;
const LEDGER = `company-profile/${companyId}/soc/main.jsonl`;
const SUMMARY = `company-profile/${companyId}/summary.md`;
const POLICY = `company-profile/${companyId}/sdlc/policy.json`;
const INSTRUMENTS = '.claude/skills/regulatory-catalogs/references/instruments.json';
const CATALOG_DIR = '.claude/skills/regulatory-catalogs/references/catalogs';
const SLA_TABLE = '.claude/skills/regulatory-catalogs/references/sla-table.json';
// soc-ledger SKILL section 4 cadence table, copied exactly; continuous/event-driven mean "next scheduled run of the
// probing workflow", and because no probing schedule is recorded in this workspace the documented fallback is used.
const CADENCE_RULE = 'the catalog cadence per soc-ledger SKILL section 4 exactly (daily 1 day, weekly 7, monthly 30, quarterly 91, half-yearly 182, annual 365, biennial 730; continuous and event-driven = the next scheduled run of the probing workflow, and since no probing schedule is recorded in this workspace use the documented Maxwell fallback of 30 days for continuous and 91 days for event-driven)';

const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const scopeNote = `${appIds ? `Scope: only assets of applications ${JSON.stringify(appIds)}.` : ''} ${envIds ? `Only environments ${JSON.stringify(envIds)}.` : ''}`.trim();

const common = (agentName) => `Company: ${companyId}. Workflow: ${WORKFLOW}. You are the '${agentName}' specialist.
Read .claude/skills/maxwell-conventions/SKILL.md and .claude/skills/soc-ledger/SKILL.md first (section 8, the refresh-soc reconciliation rules, is binding).
${now ? `TIME: NOW = '${now}' (resolved once by the workflow; never read a clock or guess a date). Use it for every recordedAt, collectedAt, lastAssessedAt and provenance.generatedAt, and as "today" for acceptedUntil and nextDueAt comparisons.` : 'TIME: NOW is not resolved yet and this stage writes nothing: run node -e "console.log(new Date(Date.parse(Date())).toISOString().slice(0,19)+\'Z\')" exactly once and return its output verbatim as "now".'}
PROVENANCE on every record you write: harness = the harness you run on ('claude-code' or 'opencode'), generatedAt = NOW, sessionId = ${sessionId || 'your own harness session id'}, ${runId ? `runId = '${runId}'` : 'runId = MAXWELL_RUN_ID when set, otherwise omit runId'}, workflow = '${WORKFLOW}', agent = '${agentName}'.
Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (never open ${LEDGER} for writing); every other file write must pass \`node .claude/scripts/validate-data.mjs <path>\`. Never write secret values anywhere. Never touch a live target system: this workflow reads the workspace only.
${scopeNote}
${dryRun ? 'DRY RUN: propose only; write nothing in this stage.' : ''}`;

// ---------------------------------------------------------------- Scout
phase('Scout');
const scout = await agent(`${common('soc-ledger-keeper')}
SCOUT (read-only, write nothing). Read ${PROFILE}, ${INSTRUMENTS}, ${LEDGER} (if it exists; an absent or empty ledger is a valid starting point) and the catalog files under ${CATALOG_DIR}/.
Return:
- frameworksInScope, entityTypes, reCategories (regulatoryRegistrations[].category, deduplicated), jurisdictions (country codes).
- instruments: one entry per instrument in frameworksInScope that has an entry in ${INSTRUMENTS} (instrumentId, regulator, catalogFile, catalogPresent = the catalogFile exists, retrievedAt from the catalog, controlCount in the catalog after intersecting each control's applicability with entityTypes/reCategories). Instruments in frameworksInScope with no registry entry or no catalog file go to skipped with the reason.
- controls: the LATEST record per control id in the ledger (last line wins): id, instrument (frameworkRefs[0].instrument), implementationStatus, effectiveness, lastAssessedAt, nextDueAt.
- findingGroups: findings the reconcile rules act on (latest record per id with status open|triaged|remediating|risk-accepted; resolved, false-positive and duplicate findings are not listed, only counted in resolvedCount) grouped by provenance.workflow of their first record: [{workflow, findingIds, openCount, riskAcceptedCount, resolvedCount}]. ${appIds ? `Keep only findings whose target.appId is in ${JSON.stringify(appIds)}${envIds ? ` and, for environment targets, whose target.envId is in ${JSON.stringify(envIds)}` : ''}; count the excluded ones in skipped.` : ''}
- observationsByWorkflow: [{workflow, count, latestCollectedAt}] for every methods[] value seen.
- ledgerLines (integer) and lastVersionFile (highest company-profile/${companyId}/soc/versions/commit_<n>.diff, empty if none).
Every instrument or finding you excluded must appear in skipped with a reason; nothing is dropped silently.${now ? '' : '\n- now: the output of the single node -e clock call above.'}`, {
  label: 'scout', phase: 'Scout', agentType: 'soc-ledger-keeper', effort: 'low',
  schema: {
    type: 'object',
    required: ['frameworksInScope', 'entityTypes', 'reCategories', 'instruments', 'controls', 'findingGroups', 'observationsByWorkflow', 'ledgerLines', 'skipped', ...(now ? [] : ['now'])],
    properties: {
      sessionId: { type: 'string' },
      now: { type: 'string', description: 'RFC 3339 UTC timestamp with trailing Z from the node -e clock call' },
      frameworksInScope: { type: 'array', items: { type: 'string' } },
      entityTypes: { type: 'array', items: { type: 'string' } },
      reCategories: { type: 'array', items: { type: 'string' } },
      jurisdictions: { type: 'array', items: { type: 'string' } },
      instruments: { type: 'array', items: { type: 'object', required: ['instrumentId', 'regulator', 'catalogFile', 'catalogPresent', 'controlCount'], properties: { instrumentId: { type: 'string' }, regulator: { type: 'string' }, catalogFile: { type: 'string' }, catalogPresent: { type: 'boolean' }, retrievedAt: { type: 'string' }, controlCount: { type: 'integer' } } } },
      controls: { type: 'array', items: { type: 'object', required: ['id', 'instrument', 'implementationStatus'], properties: { id: { type: 'string' }, instrument: { type: 'string' }, implementationStatus: { type: 'string' }, effectiveness: { type: 'string' }, lastAssessedAt: { type: 'string' }, nextDueAt: { type: 'string' } } } },
      findingGroups: { type: 'array', items: { type: 'object', required: ['workflow', 'findingIds', 'openCount'], properties: { workflow: { type: 'string' }, findingIds: { type: 'array', items: { type: 'string' } }, openCount: { type: 'integer' }, resolvedCount: { type: 'integer' }, riskAcceptedCount: { type: 'integer' } } } },
      observationsByWorkflow: { type: 'array', items: { type: 'object', required: ['workflow', 'count'], properties: { workflow: { type: 'string' }, count: { type: 'integer' }, latestCollectedAt: { type: 'string' } } } },
      ledgerLines: { type: 'integer' },
      lastVersionFile: { type: 'string' },
      skipped: { type: 'array', items: { type: 'string' } },
    },
  },
});
if (!scout) throw new Error('Scout returned nothing; cannot continue');
noteSession(scout);
if (!now) {
  if (typeof scout.now !== 'string' || !NOW_RE.test(scout.now.trim())) throw new Error(`Scout did not return a valid NOW (got ${JSON.stringify(scout.now)}); pass args.now and re-run`);
  now = scout.now.trim();
}
log(`NOW = ${now} (${args && args.now ? 'args.now' : 'read once by the Scout'}); every later prompt uses this literal`);
for (const s of scout.skipped || []) skipped.push(`scout: ${s}`);
const instruments = (scout.instruments || []).filter((i) => i.catalogPresent);
for (const i of (scout.instruments || []).filter((x) => !x.catalogPresent)) skipped.push(`inventory: ${i.instrumentId} has no catalog file at ${i.catalogFile}; controls not rebuilt`);
const existingControlIds = (scout.controls || []).map((c) => c.id);
const findingGroups = (scout.findingGroups || []).filter((g) => g.findingIds && g.findingIds.length);
log(`Scout: ${scout.frameworksInScope.length} frameworks in scope, ${instruments.length} instruments with catalogs, ${existingControlIds.length} control records, ${findingGroups.reduce((n, g) => n + g.findingIds.length, 0)} findings across ${findingGroups.length} originating workflow(s), ${scout.ledgerLines} ledger lines`);

// ---------------------------------------------------------------- Inventory || Reconcile
const CONTROL_PROPOSAL = {
  type: 'object',
  required: ['instrumentId', 'newControls', 'updatedControls', 'unchanged', 'notApplicable', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    instrumentId: { type: 'string' },
    newControls: { type: 'array', items: { type: 'object', required: ['id', 'title', 'category', 'frameworkRefs', 'implementationStatus', 'effectiveness', 'nextDueAt', 'cadence', 'reason'], properties: { id: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, frameworkRefs: { type: 'array', items: { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } } }, implementationStatus: { type: 'string' }, effectiveness: { type: 'string' }, lastAssessedAt: { type: 'string' }, nextDueAt: { type: 'string' }, cadence: { type: 'string' }, applicableAssets: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, appId: { type: 'string' }, envId: { type: 'string' }, repoId: { type: 'string' }, imageId: { type: 'string' }, vendorId: { type: 'string' } } } }, relatedObservationIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } } },
    updatedControls: { type: 'array', items: { type: 'object', required: ['id', 'changes', 'reason'], properties: { id: { type: 'string' }, changes: { type: 'object', properties: { title: { type: 'string' }, category: { type: 'string' }, effectiveness: { type: 'string' }, implementationStatus: { type: 'string' }, lastAssessedAt: { type: 'string' }, nextDueAt: { type: 'string' }, frameworkRefs: { type: 'array', items: { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } } }, notes: { type: 'string' } } }, evidenceObservationId: { type: 'string' }, reason: { type: 'string' } } } },
    unchanged: { type: 'array', items: { type: 'string' } },
    notApplicable: { type: 'array', items: { type: 'object', required: ['id', 'reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};

const inventoryPrompt = (inst) => `${common('soc-ledger-keeper')}
INVENTORY for instrument '${inst.instrumentId}' (${inst.regulator}) — PROPOSE ONLY, append nothing in this stage.
Read the catalog ${inst.catalogFile}, ${PROFILE} (entityTypes ${JSON.stringify(scout.entityTypes)}, RE categories ${JSON.stringify(scout.reCategories)}), ${LEDGER} and ${SLA_TABLE}.
Rules (soc-ledger SKILL section 4): one control record per catalog control that applies — a control applies when its applicability is absent, or its applicability.entityTypes intersects the company's entityTypes and its applicability.reCategories (when present) intersects the company's RE categories.
Latest ledger control records for this instrument: ${JSON.stringify((scout.controls || []).filter((c) => c.instrument === inst.instrumentId))}
For every applicable catalog control decide:
- NEW when no ledger record has id '${inst.instrumentId}:<controlId>': propose {id, title (catalog title), category (catalog category or group id), frameworkRefs [ {regulator:'${inst.regulator}', instrument:'${inst.instrumentId}', controlId} , ...catalog mappings ], implementationStatus 'unknown', effectiveness derived from the latest observation whose controlIds contains the id (satisfied->effective, partial->partially-effective, not-satisfied->ineffective, none/inconclusive->not-tested), lastAssessedAt = that observation's collectedAt (omit when none), nextDueAt = (lastAssessedAt or NOW) + ${CADENCE_RULE}, cadence, applicableAssets (${appIds ? `only assets of ${JSON.stringify(appIds)}${envIds ? ` / environments ${JSON.stringify(envIds)}` : ''}` : 'every applications/<app>/env/*.json of this company, or omit when the control is company-wide'}), reason}.
- UPDATED when the ledger record exists but the catalog title/category/mappings changed, or the latest observation for the id (collectedAt > lastAssessedAt) implies a different effectiveness, or nextDueAt is missing/expired: propose only the changed fields plus the evidence observation id. implementationStatus changes ONLY when the observation shows the implementation itself changed (say which observation).
- UNCHANGED otherwise (list the id).
- NOT APPLICABLE when a ledger record exists for a control whose applicability no longer matches the company (never delete: propose implementationStatus 'not-applicable' with the reason under notApplicable).
Derive, do not guess: every effectiveness or date must come from a ledger observation or the catalog cadence. List every catalog control you could not classify under skipped.`;

const RECONCILE = {
  type: 'object',
  required: ['workflow', 'transitions', 'riskTransitions', 'slaRecomputed', 'unchanged', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    workflow: { type: 'string' },
    transitions: { type: 'array', items: { type: 'object', required: ['findingId', 'fingerprint', 'from', 'to', 'statusReason', 'evidenceObservationIds', 'reason'], properties: { findingId: { type: 'string' }, fingerprint: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, statusReason: { type: 'string' }, resolvedAt: { type: 'string' }, evidenceObservationIds: { type: 'array', items: { type: 'string' } }, riskId: { type: 'string' }, reason: { type: 'string' } } } },
    riskTransitions: { type: 'array', description: 'Risk reopenings required by soc-ledger SKILL 8.2 when an acceptance expired', items: { type: 'object', required: ['riskId', 'from', 'to', 'acceptedUntil', 'statusReason', 'relatedFindingIds', 'reason'], properties: { riskId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, acceptedUntil: { type: 'string' }, statusReason: { type: 'string' }, relatedFindingIds: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } } },
    slaRecomputed: { type: 'array', items: { type: 'object', required: ['findingId', 'from', 'to', 'slaBasis', 'reason'], properties: { findingId: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, slaBasis: { type: 'object', required: ['instrument', 'days'], properties: { instrument: { type: 'string' }, controlId: { type: 'string' }, topic: { type: 'string' }, severity: { type: 'string' }, days: { type: 'integer' } } }, reason: { type: 'string' } } } },
    unchanged: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};

const reconcilePrompt = (g) => `${common('soc-ledger-keeper')}
RECONCILE findings that originated from workflow '${g.workflow}' — PROPOSE ONLY, append nothing in this stage.
Read ${LEDGER}, ${PROFILE} (frameworksInScope), ${POLICY} (dependencyPolicy.vulnerabilitySlaDays when present) and ${SLA_TABLE}.
Findings to reconcile (latest record per id): ${JSON.stringify(g.findingIds)}
Apply soc-ledger SKILL section 8 exactly:
1. ABSENT TWICE: a finding in status open|triaged|remediating is absent when an observation with methods ['${g.workflow}'] whose subjects cover the finding's target (same appId and, where set, envId/repoId/imageId/vendorId; a company subject covers everything) has collectedAt > finding.lastSeenAt and did not produce its fingerprint (no supersession of the finding with lastSeenAt >= that collectedAt). Observations with result 'inconclusive' do not count. On the SECOND consecutive absence propose transition to 'resolved' with resolvedAt = the second observation's collectedAt and statusReason "not observed in two consecutive ${g.workflow} runs"; one absence changes nothing (list under unchanged with the note 'absent once').
2. EXPIRED RISK ACCEPTANCE (soc-ledger SKILL section 8 rule 2: an expired acceptance reopens BOTH the risk and the finding): a 'risk-accepted' finding whose risk record (latest record of a risk whose relatedFindingIds contains it) has status accepted|deviation-approved and acceptedUntil < NOW '${now}' transitions to 'open' with statusReason "risk acceptance expired <acceptedUntil>" and riskId set, AND that risk gets one riskTransitions entry {riskId, from: its current status, to: 'open', acceptedUntil, statusReason "risk acceptance expired <acceptedUntil>", relatedFindingIds}. A 'risk-accepted' finding whose risk is already no longer accepted|deviation-approved transitions to 'open' with riskId set and no risk transition. 'false-positive' and 'duplicate' never change.
3. SLA: for every finding still open|triaged|remediating recompute slaDueAt = firstSeenAt + days using the sla-table (instruments = frameworksInScope + the finding's regulatoryRefs; topic patch-sla for vulnerabilities/misconfigurations with a fix, else the hardRequirements[].topic of the cited instrument in .claude/skills/regulatory-catalogs/references/instruments.json whose requirement the cited control implements, else defaults; most-strict-wins; company-override from ${POLICY} when the table says so). Report only findings whose slaDueAt or slaBasis differs from the ledger value, with the exact new slaBasis row.
Never propose a status the lifecycle forbids (maxwell-conventions lifecycles: risk-accepted -> open only when the linked risk's acceptedUntil passed; resolved -> open only by regression per soc-ledger SKILL section 8 rule 2, which a probe run applies when the fingerprint reappears and this reconciliation never proposes; false-positive/duplicate are terminal; risk accepted -> open only when acceptedUntil passed). Every finding or risk you could not evaluate goes to skipped with the reason.`;

phase('Inventory');
phase('Reconcile');
const [inventoryResults, reconcileResults] = await parallel([
  () => pipeline(instruments, (inst, _item, index) => agent(inventoryPrompt(inst), { label: `inventory ${inst.instrumentId} #${index + 1}`, phase: 'Inventory', agentType: 'soc-ledger-keeper', schema: CONTROL_PROPOSAL, effort: 'medium' })),
  () => pipeline(findingGroups, (g, _item, index) => agent(reconcilePrompt(g), { label: `reconcile ${g.workflow} #${index + 1}`, phase: 'Reconcile', agentType: 'soc-ledger-keeper', schema: RECONCILE, effort: 'high' })),
]);
const inventoryList = (inventoryResults || []);
const reconcileList = (reconcileResults || []);
instruments.forEach((inst, i) => { if (!inventoryList[i]) skipped.push(`inventory: ${inst.instrumentId} returned nothing (agent failed or was skipped)`); else { noteSession(inventoryList[i]); for (const s of inventoryList[i].skipped || []) skipped.push(`inventory ${inst.instrumentId}: ${s}`); } });
findingGroups.forEach((g, i) => { if (!reconcileList[i]) skipped.push(`reconcile: workflow ${g.workflow} returned nothing (${g.findingIds.length} findings not reconciled)`); else { noteSession(reconcileList[i]); for (const s of reconcileList[i].skipped || []) skipped.push(`reconcile ${g.workflow}: ${s}`); } });

// ---------------------------------------------------------------- Verify
// Batched adversarial verification: a first run can propose hundreds of controls, so each lens judges a batch
// (one instrument chunk or one originating workflow) and returns a verdict per candidate key. Majority rule for
// additive changes (>= 2 lenses answered, fewer than 2 refute); unanimity (all 3 answered, none refutes) for
// destructive ones: finding transitions (resolve/reopen) and controls marked not-applicable.
phase('Verify');
const LENSES = ['correctness', 'regulatory-mapping', 'dates-and-cadence'];
const BATCH_VERDICT = { type: 'object', required: ['verdicts'], properties: { sessionId: { type: 'string' }, verdicts: { type: 'array', items: { type: 'object', required: ['key', 'refuted', 'reason'], properties: { key: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' } } } } } };
const LENS_RULES = {
  control: {
    correctness: 'the control id matches a catalog control that applies to this company (entityTypes / applicability.reCategories), the ledger has or lacks the id exactly as op new/update claims, and every effectiveness value is backed by the cited observation (result mapping satisfied->effective, partial->partially-effective, not-satisfied->ineffective).',
    'regulatory-mapping': 'frameworkRefs[0] is the instrument/control itself, the rest are the catalog mappings (never the same instrument twice), and the instrument is in frameworksInScope; a not-applicable proposal really falls outside the catalog applicability for this company.',
    'dates-and-cadence': `lastAssessedAt equals the cited observation collectedAt, and nextDueAt equals (lastAssessedAt or NOW) plus ${CADENCE_RULE}; all timestamps are RFC 3339 UTC with Z.`,
  },
  transition: {
    correctness: 'the two absence observations exist with the stated methods, subjects covering the target, result not inconclusive, collectedAt after lastSeenAt, and no supersession of the finding after them; for reopen, the risk record and acceptedUntil are as stated; the finding lifecycle allows from -> to.',
    'regulatory-mapping': 'the finding still cites an instrument in frameworksInScope and resolving it does not silence an open regulator clock (an incident with reportedToRegulatorAt pending, or a risk in status mitigating that relies on it).',
    'dates-and-cadence': 'resolvedAt equals the second absence observation collectedAt exactly; the two observations are consecutive runs of the originating workflow for that subject (no produced-fingerprint run between them).',
  },
  sla: {
    correctness: 'slaDueAt equals firstSeenAt + slaBasis.days exactly and the finding is still open, triaged or remediating.',
    'regulatory-mapping': 'the slaBasis row exists in the sla-table (instrument, topic, severity) or equals defaults[severity], most-strict-wins was applied over frameworksInScope plus the finding regulatoryRefs, and a company override from sdlc/policy.json was used only where the table allows.',
    'dates-and-cadence': 'the recomputation is a real change (from differs from to), and the topic (patch-sla versus the hardRequirements[].topic of the cited instrument in instruments.json) matches the finding source and target.',
  },
  risk: {
    correctness: 'the risk record exists, its latest record has status equal to from (accepted or deviation-approved), and relatedFindingIds lists the findings named; the lifecycle allows from -> open only because acceptedUntil passed.',
    'regulatory-mapping': 'the risk still cites a regulatoryRef instrument in frameworksInScope, and reopening it does not contradict a newer acceptance (no later risk record with a fresh acceptedUntil).',
    'dates-and-cadence': 'acceptedUntil on the latest risk record is exactly as stated and is strictly earlier than NOW; the statusReason quotes that acceptedUntil.',
  },
};
const refuteBatchPrompt = (kind, batch, lens) => `${common('refuter')}
Lens '${lens}'. Try to REFUTE each proposed ${kind} below for ${companyId} (NOW = '${now}'); default to refuted=true for a candidate you cannot verify from the workspace (${LEDGER}, ${PROFILE}, ${POLICY}, ${CATALOG_DIR}/, ${SLA_TABLE}). Read only; never write.
What to check: ${LENS_RULES[kind][lens]}
Return exactly one verdict per candidate, keyed by its "key" field, with a one-sentence reason.
Candidates (${batch.length}): ${JSON.stringify(batch)}`;

const chunk = (items, size) => { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; };
const isDestructive = (kind, c) => kind === 'transition' || kind === 'risk' || (kind === 'control' && Boolean(c.notApplicable));
const verifyBatches = (kind, batches, labelOf) => pipeline(batches, async (batch, _item, index) => {
  const votes = await parallel(LENSES.map((lens) => () => agent(refuteBatchPrompt(kind, batch, lens), { label: `refute ${kind} ${labelOf(batch)} [${lens}] #${index + 1}`, phase: 'Verify', agentType: 'refuter', schema: BATCH_VERDICT, effort: kind === 'control' ? 'medium' : 'high' })));
  votes.forEach(noteSession);
  LENSES.forEach((lens, i) => { if (!votes[i]) skipped.push(`verify: lens ${lens} returned nothing for ${kind} batch ${labelOf(batch)}; its votes count as abstentions (destructive candidates in the batch cannot pass)`); });
  const lost = votes.filter((v) => !v).length;
  if (lost >= 2) log(`WARNING verify: ${lost} of ${LENSES.length} lenses returned nothing for ${kind} batch ${labelOf(batch)} (${batch.length} candidates); every candidate in it is dropped this run — re-run refresh-soc to recover them`);
  return batch.filter((c) => {
    const answers = votes.map((v, i) => (v ? (v.verdicts || []).find((x) => x.key === c.key) : null)).map((a, i) => (a ? { lens: LENSES[i], refuted: a.refuted, reason: a.reason } : null)).filter(Boolean);
    const refutations = answers.filter((a) => a.refuted);
    const ok = isDestructive(kind, c) ? (answers.length === LENSES.length && refutations.length === 0) : (answers.length >= 2 && refutations.length < 2);
    if (!ok) skipped.push(`verify: ${kind} ${c.key} (${c.id || c.findingId}) not confirmed (${refutations.length} refuted of ${answers.length} answered): ${refutations.map((a) => `${a.lens}: ${a.reason}`).join(' | ') || 'missing verdicts'}`);
    return ok;
  });
});

const controlCandidates = [];
for (const r of inventoryList.filter(Boolean)) {
  for (const c of r.newControls || []) controlCandidates.push({ op: 'new', instrumentId: r.instrumentId, ...c });
  for (const c of r.updatedControls || []) controlCandidates.push({ op: 'update', instrumentId: r.instrumentId, ...c });
  for (const c of r.notApplicable || []) controlCandidates.push({ op: 'update', instrumentId: r.instrumentId, id: c.id, notApplicable: true, changes: { implementationStatus: 'not-applicable', notes: c.reason }, reason: c.reason });
}
controlCandidates.forEach((c, i) => { c.key = `ctl-${i + 1}`; });
const transitionCandidates = reconcileList.filter(Boolean).flatMap((r) => (r.transitions || []).map((t) => ({ workflow: r.workflow, ...t })));
transitionCandidates.forEach((c, i) => { c.key = `trn-${i + 1}`; });
const riskCandidates = reconcileList.filter(Boolean).flatMap((r) => (r.riskTransitions || []).map((t) => ({ workflow: r.workflow, id: t.riskId, ...t })));
riskCandidates.forEach((c, i) => { c.key = `rsk-${i + 1}`; });
const slaCandidates = reconcileList.filter(Boolean).flatMap((r) => (r.slaRecomputed || []).map((x) => ({ workflow: r.workflow, ...x })));
slaCandidates.forEach((c, i) => { c.key = `sla-${i + 1}`; });
log(`Candidates: ${controlCandidates.length} control changes (${controlCandidates.filter((c) => c.op === 'new').length} new, ${controlCandidates.filter((c) => c.notApplicable).length} not-applicable), ${transitionCandidates.length} finding transitions, ${riskCandidates.length} risk reopenings, ${slaCandidates.length} SLA recomputations`);

// Small batches: each lens checks every candidate against catalogs of up to ~340 KB with Read/Grep inside the
// refuter's turn budget; a lens that runs out of turns abstains and two abstentions drop the whole batch.
const CONTROL_BATCH = 12;
const controlBatches = [];
for (const inst of instruments) for (const b of chunk(controlCandidates.filter((c) => c.instrumentId === inst.instrumentId), CONTROL_BATCH)) controlBatches.push(b);
const orphanControls = controlCandidates.filter((c) => !instruments.some((i) => i.instrumentId === c.instrumentId));
if (orphanControls.length) controlBatches.push(...chunk(orphanControls, CONTROL_BATCH));
const byWorkflow = (items) => [...new Set(items.map((c) => c.workflow))].flatMap((w) => chunk(items.filter((c) => c.workflow === w), CONTROL_BATCH));

const [verifiedControlBatches, verifiedTransitionBatches, verifiedRiskBatches, verifiedSlaBatches] = await parallel([
  () => verifyBatches('control', controlBatches, (b) => `${b[0].instrumentId} (${b.length})`),
  () => verifyBatches('transition', byWorkflow(transitionCandidates), (b) => `${b[0].workflow} (${b.length})`),
  () => verifyBatches('risk', byWorkflow(riskCandidates), (b) => `${b[0].workflow} (${b.length})`),
  () => verifyBatches('sla', byWorkflow(slaCandidates), (b) => `${b[0].workflow} (${b.length})`),
]);
const verifiedControls = (verifiedControlBatches || []).filter(Boolean).flat();
const verifiedTransitions = (verifiedTransitionBatches || []).filter(Boolean).flat();
const verifiedRisks = (verifiedRiskBatches || []).filter(Boolean).flat();
const verifiedSla = (verifiedSlaBatches || []).filter(Boolean).flat();
log(`Verify: ${verifiedControls.length}/${controlCandidates.length} control changes, ${verifiedTransitions.length}/${transitionCandidates.length} transitions, ${verifiedRisks.length}/${riskCandidates.length} risk reopenings, ${verifiedSla.length}/${slaCandidates.length} SLA recomputations confirmed`);

// ---------------------------------------------------------------- Dedup (barrier: one record per id)
phase('Dedup');
const controlsById = new Map();
for (const c of verifiedControls) {
  if (controlsById.has(c.id)) { skipped.push(`dedup: control ${c.id} proposed twice; kept the first (${controlsById.get(c.id).op})`); continue; }
  controlsById.set(c.id, c);
}
const transitionsByFinding = new Map();
for (const t of verifiedTransitions) {
  if (transitionsByFinding.has(t.findingId)) { skipped.push(`dedup: finding ${t.findingId} has two transitions; kept ${transitionsByFinding.get(t.findingId).to}, dropped ${t.to}`); continue; }
  transitionsByFinding.set(t.findingId, t);
}
const risksById = new Map();
for (const r of verifiedRisks) {
  if (risksById.has(r.riskId)) { skipped.push(`dedup: risk ${r.riskId} proposed for reopening twice; kept the first`); continue; }
  risksById.set(r.riskId, r);
}
// SKILL 8.2 reopens the risk and the finding together: a finding reopening that depends on a risk reopening which
// was proposed but not confirmed is dropped, so the ledger never shows an open finding under a still-accepted risk.
const proposedRiskIds = new Set(riskCandidates.map((r) => r.riskId));
for (const [findingId, t] of [...transitionsByFinding.entries()]) {
  if (t.to === 'open' && t.riskId && proposedRiskIds.has(t.riskId) && !risksById.has(t.riskId)) {
    transitionsByFinding.delete(findingId);
    skipped.push(`dedup: reopening of finding ${findingId} dropped because the reopening of its risk ${t.riskId} was not confirmed (SKILL 8.2 reopens both together)`);
  }
}
const slaByFinding = new Map();
for (const s of verifiedSla) {
  if (transitionsByFinding.has(s.findingId) && transitionsByFinding.get(s.findingId).to === 'resolved') { skipped.push(`dedup: SLA recomputation for ${s.findingId} dropped because the finding resolves in this run`); continue; }
  if (!slaByFinding.has(s.findingId)) slaByFinding.set(s.findingId, s);
}
const controls = [...controlsById.values()];
const transitions = [...transitionsByFinding.values()];
const slaUpdates = [...slaByFinding.values()];
const riskUpdates = [...risksById.values()];
log(`Dedup: ${controls.length} control records, ${transitions.length} finding transitions, ${riskUpdates.length} risk reopenings, ${slaUpdates.length} SLA updates to write`);

const result = { companyId, workflow: WORKFLOW, dryRun, targets: instruments.map((i) => i.instrumentId), controls: 0, newControls: 0, updatedControls: 0, observations: 0, findings: 0, resolvedFindings: 0, reopenedFindings: 0, reopenedRisks: 0, slaUpdated: 0, risks: 0, initiatives: 0, suggestions: 0, versionFile: '', summaryUpdated: false, skipped, sessionIds: [] };

if (!controls.length && !transitions.length && !riskUpdates.length && !slaUpdates.length) {
  log('Quiet exit: the control inventory, finding statuses and SLA dates are already reconciled; nothing written, no version.');
  result.sessionIds = [...sessionIds];
  return result;
}

// ---------------------------------------------------------------- Write
// append.mjs takes one record per call and a keeper session has a bounded turn budget, so writes go out in
// batches of WRITE_BATCH records, sequentially (controls first so every finding controlIds already resolves,
// then finding supersessions with the transition and SLA change for one finding merged into a single record,
// then risk supersessions for expired acceptances).
phase('Write');
const WRITE_BATCH = 25;
const WRITE_SCHEMA = { type: 'object', required: ['controlIds', 'findingIds', 'observationIds', 'skipped'], properties: { sessionId: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } }, newControlIds: { type: 'array', items: { type: 'string' } }, findingIds: { type: 'array', items: { type: 'string' } }, resolvedFindingIds: { type: 'array', items: { type: 'string' } }, reopenedFindingIds: { type: 'array', items: { type: 'string' } }, slaUpdatedFindingIds: { type: 'array', items: { type: 'string' } }, reopenedRiskIds: { type: 'array', items: { type: 'string' } }, observationIds: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } }, validation: { type: 'string' } } };
const findingUpdates = [];
const updateByFinding = new Map();
for (const t of transitions) { const u = { findingId: t.findingId, transition: t, sla: null }; updateByFinding.set(t.findingId, u); findingUpdates.push(u); }
for (const x of slaUpdates) { if (updateByFinding.has(x.findingId)) updateByFinding.get(x.findingId).sla = x; else { const u = { findingId: x.findingId, transition: null, sla: x }; updateByFinding.set(x.findingId, u); findingUpdates.push(u); } }

const absorb = (w, label) => {
  if (!w) { skipped.push(`write: soc-ledger-keeper returned nothing for ${label}; the ledger may be partially written — inspect the tail before re-running`); return; }
  noteSession(w);
  result.controls += (w.controlIds || []).length;
  result.newControls += (w.newControlIds || []).length;
  result.findings += (w.findingIds || []).length;
  result.resolvedFindings += (w.resolvedFindingIds || []).length;
  result.reopenedFindings += (w.reopenedFindingIds || []).length;
  result.slaUpdated += (w.slaUpdatedFindingIds || []).length;
  result.reopenedRisks += (w.reopenedRiskIds || []).length;
  result.risks += (w.reopenedRiskIds || []).length;
  result.observations += (w.observationIds || []).length;
  for (const x of w.skipped || []) skipped.push(`write ${label}: ${x}`);
  if (w.validation && w.validation !== 'ok') skipped.push(`write ${label}: ledger validation reported '${w.validation}'; run the validator before the next workflow`);
};
const CLOSE = `After the batch run \`node .claude/scripts/validate-data.mjs ${LEDGER}\` and report validation 'ok' or 'failed'. Never pass --allow-duplicate-id or --force. A rejected append is a wrong record: fix the content, never loosen it; if it cannot be fixed, list it under skipped with the validator's message. Return {controlIds, newControlIds, findingIds, resolvedFindingIds, reopenedFindingIds, slaUpdatedFindingIds, reopenedRiskIds, observationIds, skipped, validation}.`;

if (dryRun) {
  if (!existingControlIds.length) {
    skipped.push('dry run: the ledger has no control record to cite, so the reconciliation-plan observation was not appended (a dry run never appends controls)');
  } else {
    const w = await agent(`${common('soc-ledger-keeper')}
WRITE stage, DRY RUN (this stage may append exactly ONE record despite the dry-run note above). Append exactly ONE observation and nothing else: methods ['${WORKFLOW}'], subjects [{type:'company'}], result 'inconclusive', title 'Dry run: refresh-soc reconciliation plan', description starting 'dry-run: evidence requested — ' and listing what a live run would append (${controls.length} control records: ${controls.slice(0, 60).map((c) => `${c.op} ${c.id}`).join(', ') || 'none'}${controls.length > 60 ? ` and ${controls.length - 60} more` : ''}; ${transitions.length} finding transitions: ${transitions.map((t) => `${t.findingId} ${t.from}->${t.to}`).join(', ') || 'none'}; ${riskUpdates.length} risk reopenings: ${riskUpdates.map((r) => `${r.riskId} ${r.from}->open`).join(', ') || 'none'}; ${slaUpdates.length} SLA updates) and which observations a human should confirm first, controlIds = one governance control id chosen ONLY from these existing ledger control ids: ${JSON.stringify(existingControlIds)} (prefer the most specific Indian instrument's governance control, e.g. sebi-cscrf-2024:GV.RR.S1 or the RBI/IRDAI governance clause). Do not append controls, findings, risks or a version.
${CLOSE}`, { label: 'write dry-run plan observation', phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'low' });
    absorb(w, 'dry-run plan');
  }
} else {
  const controlBatches = chunk(controls, WRITE_BATCH);
  for (let i = 0; i < controlBatches.length; i += 1) {
    const batch = controlBatches[i];
    const w = await agent(`${common('soc-ledger-keeper')}
WRITE stage, control batch ${i + 1}/${controlBatches.length}. Append one control record per append.mjs call (pipe the JSON on stdin), validating each:
- op 'new': kind 'control', schemaVersion '1', companyId '${companyId}', id, frameworkRefs, title, category, implementationStatus, effectiveness, lastAssessedAt when given, nextDueAt, applicableAssets when given, evidence [{type:'workspace-file', ref:'<the instrument catalogFile>'}], recordedAt NOW, provenance. If the id already exists in the ledger (a concurrent run), treat it as op 'update' instead.
- op 'update': read the latest record with that id, copy it, apply only the fields in changes, set supersedes = the id, recordedAt NOW, fresh provenance, evidence plus the cited observation as {type:'workspace-file', ref:'${LEDGER}', description:'<observation id>'}.
Ignore the helper field "key". Controls: ${JSON.stringify(batch)}
${CLOSE}`, { label: `write controls ${i + 1}/${controlBatches.length}`, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'low' });
    absorb(w, `controls ${i + 1}/${controlBatches.length}`);
  }
  const findingBatches = chunk(findingUpdates, WRITE_BATCH);
  for (let i = 0; i < findingBatches.length; i += 1) {
    const batch = findingBatches[i];
    const w = await agent(`${common('soc-ledger-keeper')}
WRITE stage, finding batch ${i + 1}/${findingBatches.length}. For each entry append ONE supersession of the finding (read its latest record, copy it in full, supersedes = findingId, recordedAt NOW, fresh provenance, keep firstSeenAt and fingerprint):
- transition present: status = transition.to, statusReason = transition.statusReason, resolvedAt = transition.resolvedAt only for 'resolved' (remove resolvedAt on reopen), refresh lastSeenAt only on reopen, relatedObservationIds += transition.evidenceObservationIds.
- sla present: slaDueAt = sla.to, slaBasis = sla.slaBasis (applied on top of the transition in the same record when both are present).
List resolved ones under resolvedFindingIds, reopened under reopenedFindingIds, SLA changes under slaUpdatedFindingIds, and every appended id under findingIds.
Ignore the helper field "key". Entries: ${JSON.stringify(batch)}
${CLOSE}`, { label: `write findings ${i + 1}/${findingBatches.length}`, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'medium' });
    absorb(w, `findings ${i + 1}/${findingBatches.length}`);
  }
  // Risks after findings (soc-ledger SKILL section 8 rule 6: observations, findings, risks, controls ...).
  const riskBatches = chunk(riskUpdates, WRITE_BATCH);
  for (let i = 0; i < riskBatches.length; i += 1) {
    const batch = riskBatches[i];
    const w = await agent(`${common('soc-ledger-keeper')}
WRITE stage, risk batch ${i + 1}/${riskBatches.length}. Expired risk acceptances reopen per soc-ledger SKILL section 8 rule 2 (the linked findings were reopened in the previous batch). For each entry append ONE supersession of the risk: read its latest record, copy it in full, supersedes = riskId, status 'open', keep acceptedBy and acceptedUntil unchanged as history, and — because the risk record has no statusReason field (never add one) — append ' Reopened <NOW>: <entry.statusReason>.' to description, recordedAt NOW, fresh provenance. List every appended risk id under reopenedRiskIds.
Ignore the helper fields "key", "workflow" and "id". Entries: ${JSON.stringify(batch)}
${CLOSE}`, { label: `write risks ${i + 1}/${riskBatches.length}`, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'low' });
    absorb(w, `risks ${i + 1}/${riskBatches.length}`);
  }
}
result.updatedControls = Math.max(0, result.controls - result.newControls);
log(`Write: ${result.controls} control records (${result.newControls} new), ${result.findings} finding supersessions (${result.resolvedFindings} resolved, ${result.reopenedFindings} reopened, ${result.slaUpdated} SLA), ${result.reopenedRisks} risks reopened, ${result.observations} observations`);

// ---------------------------------------------------------------- Summary (before Version, so the report observation is versioned)
phase('Summary');
let proposedObservation = null;
if (dryRun) {
  skipped.push('dry run: summary.md not touched by design');
} else if (!result.controls && !result.findings && !result.reopenedRisks) {
  log('Nothing was appended; summary and version skipped');
} else {
  const summary = await agent(`${common('report-writer')}
Read .claude/skills/report-templates/SKILL.md. Rewrite ONLY the 'control-summary' section of ${SUMMARY} (create the file from the template when absent) from the latest control record per id in ${LEDGER}: one line per control family with counts of effective / partially-effective / ineffective / not-tested and coverage (controls with at least one observation over applicable controls), then the coverage paragraph citing inconclusive observations. Mention this run: ${result.newControls} new control records, ${result.updatedControls} re-assessed, ${result.resolvedFindings} findings resolved by the absent-twice rule, ${result.reopenedFindings} findings and ${result.reopenedRisks} risks reopened after expired acceptances, ${result.slaUpdated} SLA dates recomputed. Keep every other section byte-identical, bump the frontmatter version (minor), set provenance as instructed and recompute provenance.inputsHash exactly as the company-summary schema describes. Validate with \`node .claude/scripts/validate-data.mjs ${SUMMARY}\`. Do not append to the ledger: follow report-templates section 5 step 6 and return the report observation as proposedObservation (omit the field when the report was already current).`, {
    label: 'summary control-summary', phase: 'Summary', agentType: 'report-writer', effort: 'low',
    schema: { type: 'object', required: ['updated', 'controlsTotal'], properties: { sessionId: { type: 'string' }, updated: { type: 'boolean' }, controlsTotal: { type: 'integer' }, coveragePercent: { type: 'number' }, version: { type: 'string' }, proposedObservation: { type: 'object', description: 'report-templates section 5 step 6 observation record without id and recordedAt' }, notes: { type: 'string' } } },
  });
  if (summary) { noteSession(summary); result.summaryUpdated = Boolean(summary.updated); proposedObservation = summary.proposedObservation || null; log(`Summary: control-summary ${summary.updated ? 'updated' : 'unchanged'} (${summary.controlsTotal} controls${typeof summary.coveragePercent === 'number' ? `, coverage ${summary.coveragePercent}%` : ''})`); }
  else skipped.push('summary: report-writer returned nothing; control-summary section not updated');
}

// ---------------------------------------------------------------- Version (append the report observation, then version once)
phase('Version');
if (dryRun) {
  skipped.push('dry run: soc/version.mjs not run by design');
} else if (!result.controls && !result.findings && !result.reopenedRisks && !proposedObservation) {
  log('Nothing was appended; version skipped');
} else {
  const version = await agent(`${common('soc-ledger-keeper')}
${proposedObservation ? `First append the report-writer's proposed observation (report-templates section 5 step 6) via append.mjs: mint id obs_<ULID>, set recordedAt NOW, keep every other field; if its controlIds is empty or names a control that is not in the ledger, use the most specific Indian governance control record in the ledger. Record: ${JSON.stringify(proposedObservation)}
Then r` : 'R'}un \`node .claude/scripts/soc/version.mjs ${companyId} --session ${sessionId || '<your harness session id>'} --workflow ${WORKFLOW}\` from the workspace root, once. Never pass --force. Return the observation id you appended (if any), the file version.mjs wrote (empty if it printed that nothing was written) and any error verbatim.`, {
    label: 'version ledger', phase: 'Version', agentType: 'soc-ledger-keeper', effort: 'low',
    schema: { type: 'object', required: ['versionFile'], properties: { sessionId: { type: 'string' }, reportObservationId: { type: 'string' }, versionFile: { type: 'string' }, error: { type: 'string' } } },
  });
  if (version) noteSession(version);
  if (version && version.reportObservationId) result.observations += 1;
  else if (proposedObservation) skipped.push('version: report observation not appended (keeper returned no id)');
  if (version && version.versionFile) result.versionFile = version.versionFile;
  else skipped.push(`version: ${version && version.error ? version.error : 'no version file written'}`);
}

result.skipped = skipped;
result.sessionIds = [...sessionIds];
log(`${WORKFLOW} done: ${result.controls} controls, ${result.findings} finding supersessions, ${result.observations} observations, version ${result.versionFile || 'none'}, ${skipped.length} skipped items logged`);
return result;
}

const finalResult = await main();
log(`refresh-soc result: ${finalResult.controls} controls, ${finalResult.findings} finding supersessions, ${finalResult.skipped.length} skipped`);
return finalResult;
