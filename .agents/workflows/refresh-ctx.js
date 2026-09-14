// refresh-ctx: keep company-profile/<companyId>/details.json truthful against the regulators' own registers.
// Modelled on the regulatory-comms-manager licence-refresh (see
// .claude/skills/regulatory-catalogs/references/regulatory-comms-manager-offline-copy.md section 2):
// Snapshot -> (Recheck || Discover) -> Verify (3 refuter lenses, destructive drift unanimous) -> Apply -> Version.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
// appIds/envIds narrow the environment and repo files re-checked for hosting/residency drift; they never narrow the
// regulatory registrations, which are always company-wide. An empty appIds/envIds array means no filter. dryRun
// researches and refutes but writes only observations with result 'inconclusive' (evidence requests) for drift that
// survived verification or was escalated, citing an existing control; it never appends controls or risks, never
// patches details.json. NOW is resolved once: args.now when given, otherwise the Snapshot (ctx-researcher, which has
// `date -u`) reads the clock and every later prompt receives that literal, because refuter and report-writer have no clock.
// category_changed is treated as destructive (unanimity, escalated when it fails): the RE category drives
// applicability.reCategories for every other control, so a wrong change silently adds or removes controls.
export const meta = {
  name: 'refresh-ctx',
  description: 'Recheck details.json against regulator registers, discover new registrations and instruments, refute drift, mark-not-delete, version. args: companyId, appIds, envIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Snapshot', detail: 'Skeleton of details.json, applicable instruments and the last refresh-ctx observation' },
    { title: 'Recheck', detail: 'One ctx-researcher per worklist unit re-verifies a named branch of the profile' },
    { title: 'Discover', detail: 'ctx-researcher lenses registers, corporate and regulatory-change look for what the profile lacks' },
    { title: 'Verify', detail: 'Three refuter lenses per drift item; destructive drift needs unanimous non-refutation' },
    { title: 'Apply', detail: 'Ledger observations, control records for new instruments, named-branch patch of details.json, summary section' },
    { title: 'Version', detail: 'soc/version.mjs writes versions/commit_<n>.diff' },
  ],
};

async function main() {
const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required');
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
const INSTRUMENTS = '.claude/skills/regulatory-catalogs/references/instruments.json';
const CATALOG_DIR = '.claude/skills/regulatory-catalogs/references/catalogs';
const REFERENCE = '.claude/skills/regulatory-catalogs/references/regulatory-comms-manager-offline-copy.md';

const DESTRUCTIVE_KINDS = ['registration_surrendered', 'registration_suspended', 'registration_expired', 'category_changed', 'entity_type_removed', 'instrument_superseded'];
// soc-ledger SKILL section 4 cadence table, copied exactly; continuous/event-driven mean "next scheduled run of the
// probing workflow", and because no probing schedule is recorded in this workspace the documented fallback is used.
const CADENCE_RULE = 'the catalog cadence per soc-ledger SKILL section 4 exactly (daily 1 day, weekly 7, monthly 30, quarterly 91, half-yearly 182, annual 365, biennial 730; continuous and event-driven = the next scheduled run of the probing workflow, and since no probing schedule is recorded in this workspace use the documented Maxwell fallback of 30 days for continuous and 91 days for event-driven)';
const DRIFT_KINDS = ['registration_added', 'registration_surrendered', 'registration_suspended', 'registration_expired', 'registration_changed', 'category_changed', 'entity_type_added', 'entity_type_removed', 'instrument_became_applicable', 'instrument_superseded', 'listing_changed', 'hosting_changed', 'regime_overhaul', 'none'];
const REFUTE_LENSES = ['source-authenticity', 'entity-identity', 'temporal-validity'];

const skipped = [];
const sessionIds = new Set();
if (sessionId) sessionIds.add(sessionId);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };

const common = (agentName) => `Company: ${companyId}. Workflow: refresh-ctx. You are the '${agentName}' specialist.
Read .claude/skills/maxwell-conventions/SKILL.md first.
${now ? `TIME: NOW = '${now}' (resolved once by the workflow; never read a clock or guess a date). Use it for every recordedAt, collectedAt and provenance.generatedAt, and as "today" when judging whether a change is effective.` : 'TIME: NOW is not resolved yet and this stage writes nothing: run `date -u +%Y-%m-%dT%H:%M:%SZ` exactly once and return its output verbatim as "now".'}
PROVENANCE on every record or file you write: harness = the harness you run on ('claude-code' or 'opencode'), generatedAt = NOW, sessionId = ${sessionId || 'your own harness session id (Claude Code UUID or OpenCode ses_ id)'}, ${runId ? `runId = '${runId}'` : 'runId = MAXWELL_RUN_ID when set, otherwise omit runId'}, workflow = 'refresh-ctx', agent = '${agentName}'.
Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} <record.json|->\` (never edit ${LEDGER} directly); every other file write must pass \`node .claude/scripts/validate-data.mjs <path>\` before you report success. Never write secret values anywhere.
${dryRun ? 'DRY RUN: do not patch details.json or any application file; the only permitted writes are ledger observations with result "inconclusive" that cite existing control records.' : ''}`;

const GROUNDING = `GROUNDING CONTRACT — non-negotiable:
- Ground every claim in a page you actually fetched, and record the URL. Regulator's own register first.
- Never invent a registration number, licence, scheme, or date.
- If you cannot ground it, say so and leave it empty. An empty field with a note is CORRECT.
- Distinguish the GROUP from the ENTITY: a parent's or sister company's licence is not this entity's.

BIAS TOWARD NO-OP: the profile is presumed CORRECT. You are looking for evidence it is WRONG.
"I could not confirm the profile's claim" is NOT drift — it is silence, and silence changes nothing.
Report drift only when a public source positively contradicts what the profile says.`;

const DRIFT_ITEM = {
  type: 'object',
  required: ['kind', 'branch', 'detail', 'evidence', 'evidenceUrl'],
  properties: {
    kind: { type: 'string', enum: DRIFT_KINDS },
    branch: { type: 'string', description: 'JSON pointer into details.json that the drift touches, e.g. /regulatoryRegistrations/1/status, /frameworksInScope, /entityTypes; applications/<app>/env/<env>.json#/hosting for hosting provider/region drift, applications/<app>/env/<env>.json#/residency for residency drift' },
    detail: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    evidence: { type: 'string', description: 'Verbatim excerpt (<=300 chars) from the fetched page that contradicts or extends the profile' },
    evidenceUrl: { type: 'string' },
    effectiveDate: { type: 'string', description: 'YYYY-MM-DD when known, else empty' },
    instrumentId: { type: 'string', description: 'vocab instrument id for instrument_* kinds, else empty' },
    regulator: { type: 'string' },
  },
};
const DRIFT_SCHEMA = {
  type: 'object',
  required: ['unit', 'drifts', 'silences', 'sourcesFetched'],
  properties: {
    sessionId: { type: 'string' },
    unit: { type: 'string' },
    drifts: { type: 'array', items: DRIFT_ITEM },
    silences: { type: 'array', items: { type: 'string' }, description: 'Claims you could not confirm (not drift)' },
    truncated: { type: 'integer', description: 'Drift items you found but did not return because of the per-unit cap (0 when none)' },
    sourcesFetched: { type: 'array', items: { type: 'string' } },
  },
};

// ---------------------------------------------------------------- Snapshot
phase('Snapshot');
const snapshot = await agent(`${common('ctx-researcher')}
Build the SNAPSHOT for refresh-ctx: a skeleton of the profile, never the whole file.
Read ${PROFILE}, ${INSTRUMENTS}, and ${LEDGER} (if it exists).
APPLICATION-TO-COMPANY RULE (deterministic; no application schema carries companyId, so never infer the link from README prose or hosting.accountRef): when company-profile/ contains exactly one company directory every applications/<app_id>/ belongs to it; otherwise the company's applications are the union of ${PROFILE} criticalFunctions[].appIds${appIds ? ` and ${JSON.stringify(appIds)} (args.appIds)` : ''}. List every other applications/<app_id>/ under skipped with reason 'no company link'.
${appIds ? `Of the linked applications only list environments and repos of ${JSON.stringify(appIds)}; list the others under skipped with reason 'filtered by args.appIds'.` : 'List every applications/<app_id>/env/*.json and repos/*.json of the linked applications.'}
${envIds ? `Only list environments whose envId is one of ${JSON.stringify(envIds)}; list the others under skipped with reason 'filtered by args.envIds'.` : ''}
Return: legalName, identifiers (cin, pan, lei, sebiRegistrationNos, rbiCorNo, irdaiRegistrationNo as present), headquarters country, jurisdictions, entityTypes, regulatoryRegistrations (regulator, registrationNo, category, status, validUntil, index in the array), frameworksInScope, applicableInstruments = every instruments.json entry whose applicability.entityTypes intersects entityTypes (or is empty) AND whose applicability.jurisdictions contains a company jurisdiction (or is empty), each flagged inScope = present in frameworksInScope; lastRefreshedAt = recordedAt of the newest ledger observation with methods containing 'refresh-ctx' (empty if none); envFiles and repoFiles as workspace paths; ledgerControlIds = ids of the latest control records in the ledger (deduplicated); skipped = every application or file you excluded with its reason${now ? '' : '; now = the output of the single `date -u +%Y-%m-%dT%H:%M:%SZ` call'}.`, {
  label: 'snapshot', phase: 'Snapshot', agentType: 'ctx-researcher', effort: 'low',
  schema: {
    type: 'object',
    required: ['legalName', 'entityTypes', 'regulatoryRegistrations', 'frameworksInScope', 'applicableInstruments', 'lastRefreshedAt', 'envFiles', 'repoFiles', 'ledgerControlIds', ...(now ? [] : ['now'])],
    properties: {
      sessionId: { type: 'string' },
      now: { type: 'string', description: 'RFC 3339 UTC timestamp with trailing Z from date -u' },
      skipped: { type: 'array', items: { type: 'string' } },
      legalName: { type: 'string' },
      identifiers: { type: 'object', properties: { cin: { type: 'string' }, pan: { type: 'string' }, lei: { type: 'string' }, sebiRegistrationNos: { type: 'array', items: { type: 'string' } }, rbiCorNo: { type: 'string' }, irdaiRegistrationNo: { type: 'string' } } },
      headquartersCountry: { type: 'string' },
      jurisdictions: { type: 'array', items: { type: 'string' } },
      entityTypes: { type: 'array', items: { type: 'string' } },
      regulatoryRegistrations: { type: 'array', items: { type: 'object', required: ['index', 'regulator', 'registrationNo', 'category'], properties: { index: { type: 'integer' }, regulator: { type: 'string' }, registrationNo: { type: 'string' }, category: { type: 'string' }, status: { type: 'string' }, validUntil: { type: 'string' } } } },
      frameworksInScope: { type: 'array', items: { type: 'string' } },
      applicableInstruments: { type: 'array', items: { type: 'object', required: ['instrumentId', 'regulator', 'inScope'], properties: { instrumentId: { type: 'string' }, regulator: { type: 'string' }, inScope: { type: 'boolean' }, catalogFile: { type: 'string' }, effectiveFrom: { type: 'string' } } } },
      lastRefreshedAt: { type: 'string' },
      envFiles: { type: 'array', items: { type: 'string' } },
      repoFiles: { type: 'array', items: { type: 'string' } },
      ledgerControlIds: { type: 'array', items: { type: 'string' } },
    },
  },
});
if (!snapshot) throw new Error('Snapshot failed: no skeleton returned');
noteSession(snapshot);
if (!now) {
  if (typeof snapshot.now !== 'string' || !NOW_RE.test(snapshot.now.trim())) throw new Error(`Snapshot did not return a valid NOW (got ${JSON.stringify(snapshot.now)}); pass args.now and re-run`);
  now = snapshot.now.trim();
}
log(`NOW = ${now} (${args && args.now ? 'args.now' : 'read once by the Snapshot'}); every later prompt uses this literal`);
for (const x of snapshot.skipped || []) skipped.push(`snapshot: ${x}`);
log(`Snapshot: ${snapshot.legalName}; ${snapshot.regulatoryRegistrations.length} registrations, ${snapshot.entityTypes.length} entity types, ${snapshot.applicableInstruments.length} applicable instruments (${snapshot.applicableInstruments.filter((i) => !i.inScope).length} not yet in scope); last refresh ${snapshot.lastRefreshedAt || 'never'}`);

// ---------------------------------------------------------------- Worklist (plain code, not an agent)
const worklist = [];
for (const r of snapshot.regulatoryRegistrations) worklist.push({ unit: `registration:${r.regulator}:${r.registrationNo}`, branch: `/regulatoryRegistrations/${r.index}`, subject: r });
for (const t of snapshot.entityTypes) worklist.push({ unit: `entity-type:${t}`, branch: '/entityTypes', subject: { entityType: t } });
worklist.push({ unit: 'company:listing', branch: '/identifiers', subject: { legalName: snapshot.legalName, identifiers: snapshot.identifiers || {} } });
worklist.push({ unit: 'company:frameworks', branch: '/frameworksInScope', subject: { frameworksInScope: snapshot.frameworksInScope, applicableInstruments: snapshot.applicableInstruments } });
const MAX_ENV_UNITS = 12;
const envUnits = snapshot.envFiles.slice(0, MAX_ENV_UNITS);
if (snapshot.envFiles.length > MAX_ENV_UNITS) {
  const msg = `recheck: ${snapshot.envFiles.length - MAX_ENV_UNITS} environment files beyond the first ${MAX_ENV_UNITS} not rechecked this run (pass appIds/envIds to target them): ${JSON.stringify(snapshot.envFiles.slice(MAX_ENV_UNITS))}`;
  log(msg);
  skipped.push(msg);
}
for (const f of envUnits) worklist.push({ unit: `environment:${f}`, branch: `${f}#/hosting`, subject: { file: f } });
log(`Worklist: ${worklist.length} units (${snapshot.regulatoryRegistrations.length} registrations, ${snapshot.entityTypes.length} entity types, listing, frameworks, ${envUnits.length} environments)`);

const recheckPrompt = (u) => `${common('ctx-researcher')}
${GROUNDING}
RECHECK unit '${u.unit}' (branch ${u.branch}) of ${PROFILE}. Read ${REFERENCE} section 1 for the regulator register URLs to use, then read only the branch named above plus legalName and identifiers.
Subject: ${JSON.stringify(u.subject)}
${u.unit.startsWith('registration:') ? 'Verify on the regulator\'s own register (SEBI intermediary database, RBI NBFC/PSO lists, IRDAI registers, PFRDA, IFSCA) that this registration number belongs to this legal entity, its current standing (active/suspended/surrendered/expired), validity, and its category (SEBI CSCRF RE category, RBI tier/layer). Category and standing changes are drift kinds category_changed / registration_changed / registration_suspended / registration_surrendered / registration_expired.' : ''}
${u.unit.startsWith('entity-type:') ? 'Verify a public register still evidences this licence category for this entity; an entity type with no supporting registration on any register is entity_type_removed (destructive: quote the register).' : ''}
${u.unit === 'company:listing' ? 'Verify the MCA master data (CIN, company status, name) and exchange listing status (NSE EQUITY_L.csv, BSE scrip list). A changed legal name, CIN status or listing is listing_changed.' : ''}
${u.unit === 'company:frameworks' ? `Compare frameworksInScope with the applicable instruments in ${INSTRUMENTS}: an applicable Indian instrument missing from frameworksInScope is instrument_became_applicable (instrumentId set); an in-scope instrument listed in another instrument's supersedes[] is instrument_superseded. Do not use the web for this unit; the registry and ${PROFILE} are the sources, cite them as evidenceUrl 'workspace:${INSTRUMENTS}'.` : ''}
${u.unit.startsWith('environment:') ? `Read ${u.subject.file}. Drift kind hosting_changed only when a workspace file (the IaC roots this environment file lists in iac[] inside the repo checkout, the application README) positively contradicts hosting.provider or hosting.region (branch ${u.subject.file}#/hosting) or the top-level residency field (branch ${u.subject.file}#/residency); do not probe live systems. Evidence URLs are workspace paths prefixed 'workspace:'.` : ''}
Return the drift items for this unit only, with kind 'none' omitted (an empty drifts array is the normal, correct answer). Never return more than 5 drifts for one unit (most consequential first) and set truncated to the number you left out.`;

const discoverPrompt = (lens) => `${common('ctx-researcher')}
${GROUNDING}
DISCOVER lens '${lens}' for ${snapshot.legalName} (${companyId}). Read ${REFERENCE} sections 1 and 2, the skeleton below, and ${INSTRUMENTS}. Last refresh: ${snapshot.lastRefreshedAt || 'never (use the last 24 months)'}.
Skeleton: ${JSON.stringify({ legalName: snapshot.legalName, identifiers: snapshot.identifiers || {}, entityTypes: snapshot.entityTypes, registrations: snapshot.regulatoryRegistrations.map((r) => `${r.regulator}:${r.registrationNo}`), frameworksInScope: snapshot.frameworksInScope })}
${lens === 'registers' ? 'Sweep the regulators\' OWN registers (SEBI intermediary database by name, RBI NBFC/PSO/PPI lists, IRDAI intermediary registers, PFRDA POP list, CDSL/NSDL DP lists, exchange member directories, IFSCA) for ANY registration held by this exact legal entity that is not in the profile: kind registration_added with the registration number, regulator and category in `to`. Also report entity_type_added when a found registration implies an entity type missing from the profile.' : ''}
${lens === 'corporate' ? 'Search corporate actions and regulatory news since the last refresh: name change, merger/demerger, change of control, listing/delisting, SEBI/RBI/IRDAI enforcement orders (monetary penalty, adjudication, settlement, cancellation of licence), CERT-In advisories naming the entity. Map to kinds listing_changed, registration_suspended, registration_surrendered, registration_changed; anything else is context, not drift.' : ''}
${lens === 'regulatory-change' ? `Check for regulatory change: (a) every instrument in ${INSTRUMENTS} whose applicability matches the entity types/jurisdictions but is absent from frameworksInScope -> instrument_became_applicable (branch /frameworksInScope, instrumentId set); (b) every in-scope instrument named in another entry's supersedes[] -> instrument_superseded (destructive); (c) read the catalogs present under ${CATALOG_DIR}/ for the in-scope Indian instruments (an in-scope instrument without a catalog file is checked from its instruments.json entry and the regulator's circular page only) and the regulators' circular pages for amendments issued after the catalog retrievedAt that rewrite the regime for this entity type -> regime_overhaul (branch /frameworksInScope, evidence the circular URL). A newer circular that merely clarifies is not drift.` : ''}
Return drift items only; an empty drifts array is the normal answer. Never return more than 8 drifts (most consequential first) and set truncated to the number you left out.`;

// ---------------------------------------------------------------- Recheck || Discover
phase('Recheck');
phase('Discover');
const [recheckResults, discoverResults] = await parallel([
  () => pipeline(worklist, (u) => agent(recheckPrompt(u), { label: `recheck ${u.unit}`, phase: 'Recheck', agentType: 'ctx-researcher', schema: DRIFT_SCHEMA })),
  () => pipeline(['registers', 'corporate', 'regulatory-change'], (lens) => agent(discoverPrompt(lens), { label: `discover ${lens}`, phase: 'Discover', agentType: 'ctx-researcher', schema: DRIFT_SCHEMA })),
]);
const recheckList = recheckResults || [];
const discoverList = discoverResults || [];
for (const r of [...recheckList, ...discoverList].filter(Boolean)) if (r.truncated > 0) { const msg = `unit ${r.unit}: ${r.truncated} drift item(s) truncated by the per-unit cap; re-run to record them`; log(msg); skipped.push(msg); }
for (let i = 0; i < worklist.length; i += 1) if (!recheckList[i]) skipped.push(`recheck unit ${worklist[i].unit} returned nothing (agent failed or was skipped)`);
['registers', 'corporate', 'regulatory-change'].forEach((lens, i) => { if (!discoverList[i]) skipped.push(`discover lens ${lens} returned nothing`); });

// Barrier is genuine here: dedup across every unit and lens before paying for verification.
const seen = new Set();
const candidates = [];
for (const r of [...recheckList, ...discoverList].filter(Boolean)) {
  for (const d of r.drifts || []) {
    if (!d || d.kind === 'none') continue;
    const key = `${d.kind}|${d.branch}|${(d.to || '').trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...d, unit: r.unit, destructive: DESTRUCTIVE_KINDS.includes(d.kind) });
  }
}
[...recheckList, ...discoverList].filter(Boolean).forEach(noteSession);
const silences = [...recheckList, ...discoverList].filter(Boolean).flatMap((r) => r.silences || []);
log(`Candidates: ${candidates.length} drift items after dedup (${candidates.filter((c) => c.destructive).length} destructive); ${silences.length} silences ignored (silence is not drift)`);

// ---------------------------------------------------------------- Verify
phase('Verify');
const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { sessionId: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' }, checkedUrl: { type: 'string' } },
};
const refutePrompt = (d, lens) => `${common('refuter')}
Read .claude/skills/maxwell-conventions/SKILL.md and ${REFERENCE} section 2 (adversarial verification).
${GROUNDING}
Try to REFUTE this drift claim about ${snapshot.legalName} (${companyId}); default to refuted=true when uncertain${d.destructive ? ' — this is a DESTRUCTIVE kind, so any doubt refutes it' : ''}.
Claim: ${JSON.stringify(d)}
Lens '${lens}': ${lens === 'source-authenticity' ? 'fetch evidenceUrl yourself; refute unless it is the regulator\'s own register or an official primary source AND it actually states what the claim\'s "evidence" excerpt quotes.' : ''}${lens === 'entity-identity' ? `refute unless the source names this exact legal entity (legalName '${snapshot.legalName}', CIN/PAN/registration numbers from ${PROFILE}) rather than a parent, subsidiary, sister company or namesake.` : ''}${lens === 'temporal-validity' ? `refute if the change is not yet effective as of NOW '${now}' (effectiveDate after NOW), is stale (already reflected in ${PROFILE} or in a ledger observation with methods refresh-ctx in ${LEDGER}), or the claim's from/to is the same as the current profile value.` : ''}
Read only what you need; never write any file.`;

const verified = await pipeline(candidates, async (d) => {
  const votes = await parallel(REFUTE_LENSES.map((lens) => () => agent(refutePrompt(d, lens), { label: `refute ${d.kind}@${d.branch} [${lens}]`, phase: 'Verify', agentType: 'refuter', schema: VERDICT, effort: d.destructive ? 'high' : 'medium' })));
  votes.forEach(noteSession);
  const labelled = votes.map((v, i) => (v ? { lens: REFUTE_LENSES[i], refuted: v.refuted, reason: v.reason } : null));
  const valid = labelled.filter(Boolean);
  const refutations = valid.filter((v) => v.refuted).length;
  // Section 2 of the offline copy: destructive kinds need unanimous non-refutation (a missing verdict counts as
  // doubt); other kinds survive when fewer than 2 lenses refute, provided at least 2 lenses actually answered.
  const confirmed = d.destructive ? (valid.length === REFUTE_LENSES.length && refutations === 0) : (valid.length >= 2 && refutations < 2);
  if (valid.length < REFUTE_LENSES.length) skipped.push(`verify: ${REFUTE_LENSES.length - valid.length} refuter lens(es) returned nothing for ${d.kind}@${d.branch}`);
  return { drift: d, confirmed, escalate: d.destructive && !confirmed, votes: valid };
});
const confirmed = verified.filter(Boolean).filter((v) => v.confirmed).map((v) => v.drift);
const escalated = verified.filter(Boolean).filter((v) => v.escalate);
const dropped = verified.filter(Boolean).filter((v) => !v.confirmed && !v.escalate);
log(`Verify: ${confirmed.length} confirmed, ${escalated.length} destructive claims escalated to a risk record (never dropped), ${dropped.length} refuted and dropped`);
for (const v of dropped) skipped.push(`drift ${v.drift.kind}@${v.drift.branch} refuted: ${v.votes.filter((x) => x.refuted).map((x) => `${x.lens}: ${x.reason}`).join(' | ')}`);

// ---------------------------------------------------------------- Apply
const result = { companyId, workflow: 'refresh-ctx', dryRun, targets: worklist.map((u) => u.unit), candidates: candidates.length, confirmedDrift: confirmed.map((d) => `${d.kind}@${d.branch}`), escalatedDrift: escalated.map((v) => `${v.drift.kind}@${v.drift.branch}`), observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, controls: 0, profilePatched: false, summaryUpdated: false, versionFile: '', skipped, sessionIds: [] };

if (!confirmed.length && !escalated.length) {
  log('Quiet exit: no confirmed drift, nothing written (no observation, no patch, no version).');
  result.sessionIds = [...sessionIds];
  return result;
}

phase('Apply');
const newInstruments = dryRun ? [] : [...new Set(confirmed.filter((d) => d.kind === 'instrument_became_applicable' && d.instrumentId).map((d) => d.instrumentId))];
// One keeper session per newly applicable instrument: a catalog can hold 100+ controls and append.mjs takes one
// record per call, so a single session for every instrument would exhaust its turn budget.
const CONTROL_SCHEMA = { type: 'object', required: ['controlIds', 'skippedControlIds'], properties: { sessionId: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } }, skippedControlIds: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } };
let controlsAppended = 0;
for (const instrumentId of newInstruments) {
  const c = await agent(`${common('soc-ledger-keeper')}
Read .claude/skills/soc-ledger/SKILL.md section 4 and .claude/skills/regulatory-catalogs/SKILL.md. Instrument '${instrumentId}' became applicable to ${companyId} (confirmed drift). Load its catalogFile from ${INSTRUMENTS}; if the catalog file does not exist, append nothing and say so in notes.
For every catalog control whose applicability is absent or matches the company's entityTypes and regulatoryRegistrations[].category values (read ${PROFILE}), append a control record via append.mjs (JSON on stdin): id '${instrumentId}:<controlId>', kind 'control', schemaVersion '1', companyId '${companyId}', frameworkRefs[0] = {regulator, instrument:'${instrumentId}', controlId} followed by the catalog mappings, title and category from the catalog, implementationStatus 'unknown', effectiveness 'not-tested', nextDueAt = NOW plus ${CADENCE_RULE}, evidence [{type:'workspace-file', ref:'<catalogFile>'}], recordedAt NOW, provenance. Ids already in ${LEDGER} are not re-appended: list them under skippedControlIds. You may loop with node -e over the catalog to call append.mjs once per record, but never write a scratch file.
Return {controlIds, skippedControlIds, notes}.`, { label: `controls ${instrumentId}`, phase: 'Apply', agentType: 'soc-ledger-keeper', schema: CONTROL_SCHEMA, effort: 'medium' });
  if (!c) { skipped.push(`apply: control inventory for ${instrumentId} returned nothing; run refresh-soc to rebuild it`); continue; }
  noteSession(c);
  controlsAppended += c.controlIds.length;
  if (c.skippedControlIds.length) skipped.push(`apply: ${c.skippedControlIds.length} ${instrumentId} control ids already in the ledger were not re-appended`);
  if (c.notes) log(`controls ${instrumentId}: ${c.notes}`);
}
const dryRunNoControl = dryRun && !(snapshot.ledgerControlIds || []).length;
if (dryRunNoControl) skipped.push(`apply: dry run and the ledger has no control record to cite; ${confirmed.length + escalated.length} evidence-request observation(s) not recorded (a dry run never appends controls)`);
const ledgerWrite = dryRunNoControl ? null : await agent(`${common('soc-ledger-keeper')}
Read .claude/skills/soc-ledger/SKILL.md and .claude/skills/regulatory-catalogs/SKILL.md. Read ${PROFILE} and ${LEDGER}.
${dryRun ? `DRY RUN. Only drift that survived verification (confirmed) or was escalated (destructive, not unanimously confirmed) is recorded; refuted drift is dropped (offline copy section 2). For each item below append ONE observation and nothing else: methods ['refresh-ctx'], subjects [{type:'company'}] (for hosting_changed the environment assetRef {type:'environment', appId, envId} taken from the branch path), controlIds = ONE existing governance / applicability control chosen ONLY from these ledger control ids: ${JSON.stringify(snapshot.ledgerControlIds || [])} (prefer the most specific in-scope Indian instrument's governance clause, e.g. sebi-cscrf-2024 GV.*), result 'inconclusive', title prefixed 'Evidence requested: ', description starting 'dry-run: evidence requested — ' stating the drift, whether it was confirmed or escalated, and what evidence a human must supply (register URL, letter, circular) and why, evidence = the item's evidenceUrl as {type:'url'} when it is an http(s) URL or {type:'workspace-file'} for a 'workspace:' ref (prefix stripped). Append NO control, risk or finding; if no listed control id fits, append nothing for that item and list it under skipped.
Confirmed: ${JSON.stringify(confirmed)}
Escalated: ${JSON.stringify(escalated.map((v) => v.drift))}` : `Apply the CONFIRMED drift and ESCALATED claims to the ledger:
1. Control records for the newly applicable instruments ${JSON.stringify(newInstruments)} were appended by the previous stage; append no further catalog controls here except the single governance control step 2 may need.
2. For each confirmed drift append an observation: methods ['refresh-ctx'], subjects [{type:'company'}] (or the environment assetRef for hosting_changed), controlIds = the governance/applicability control(s) of the most specific in-scope Indian instrument that already exist in the ledger (existing ids: ${JSON.stringify(snapshot.ledgerControlIds || [])}; e.g. sebi-cscrf-2024 GV.* or the RBI/IRDAI governance clause; if none exists yet, append that control record first from its catalog with implementationStatus 'unknown', effectiveness 'not-tested', nextDueAt = NOW plus ${CADENCE_RULE}), title = '<kind>: <branch>', description = detail + from/to + effectiveDate, evidence = [{type:'url', ref: evidenceUrl, description: evidence excerpt}] (type 'workspace-file' for 'workspace:' refs, strip the prefix), result = 'not-satisfied' when the profile was wrong about a compliance-relevant fact (a surrendered/suspended registration still active, a missing applicable instrument, a hosting/residency contradiction) and 'satisfied' when the drift merely extends the profile (registration_added, category_changed with a valid category, listing_changed).
3. For each ESCALATED destructive claim append a risk: title 'Unverified <kind> on <branch> needs human resolution', statement in the form 'Because <claim>, <consequence> may occur, causing <impact>', severity 'high', likelihood 'possible', impact 'major', status 'investigating', regulatoryRefs citing the governance clause used above, description listing the three refuter verdicts verbatim, evidence with the claim's evidenceUrl. For regime_overhaul drift also append a risk (severity 'medium', status 'open') and append superseding control records (same id, supersedes = id) for the affected instrument's controls with nextDueAt = NOW plus 30 days.
Confirmed: ${JSON.stringify(confirmed)}
Escalated: ${JSON.stringify(escalated)}`}
Return the ids you appended and the sessionId you put in provenance.`, {
  label: 'ledger write', phase: 'Apply', agentType: 'soc-ledger-keeper',
  schema: { type: 'object', required: ['observationIds', 'controlIds', 'riskIds', 'sessionId'], properties: { observationIds: { type: 'array', items: { type: 'string' } }, controlIds: { type: 'array', items: { type: 'string' } }, riskIds: { type: 'array', items: { type: 'string' } }, skippedControlIds: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' }, notes: { type: 'string' } } },
});
if (ledgerWrite) {
  result.observations = ledgerWrite.observationIds.length;
  result.controls = controlsAppended + ledgerWrite.controlIds.length;
  result.risks = ledgerWrite.riskIds.length;
  noteSession(ledgerWrite);
  for (const x of ledgerWrite.skipped || []) skipped.push(`apply ledger: ${x}`);
  if (dryRun && (ledgerWrite.controlIds.length || ledgerWrite.riskIds.length)) log(`WARNING dry run: soc-ledger-keeper reported ${ledgerWrite.controlIds.length} control(s) and ${ledgerWrite.riskIds.length} risk(s) appended despite the read-only dry-run instruction; inspect the ledger tail`);
  if (ledgerWrite.skippedControlIds && ledgerWrite.skippedControlIds.length) skipped.push(`apply: ${ledgerWrite.skippedControlIds.length} control ids already in the ledger were not re-appended`);
} else if (!dryRunNoControl) { result.controls = controlsAppended; skipped.push('apply: soc-ledger-keeper returned nothing; ledger may be partially written — inspect the ledger tail'); }

let proposedObservation = null;
if (!dryRun && confirmed.length) {
  const patch = await agent(`${common('validator')}
Read .claude/skills/maxwell-conventions/SKILL.md. Patch ${PROFILE} for the confirmed drift below, touching ONLY the named branches:
- DO NOT DELETE, MARK: registration_surrendered/registration_suspended/registration_expired set regulatoryRegistrations[i].status to surrendered/suspended/expired; entity_type_removed is NOT applied to entityTypes (the ledger risk/observation records it; a human removes the type) — instead add tag 'entity-type-review'.
- registration_added appends a regulatoryRegistrations entry (regulator, registrationNo, category from the drift "to" value, status 'active', registeredAt = effectiveDate when given) and the number to identifiers.sebiRegistrationNos/rbiCorNo/irdaiRegistrationNo as appropriate; entity_type_added appends to entityTypes; category_changed sets category and categorisedAt; registration_changed/listing_changed update only the field named in the branch.
- instrument_became_applicable appends instrumentId to frameworksInScope; instrument_superseded appends the superseding instrument and keeps the old one (never remove); regime_overhaul changes nothing in the profile.
- hosting_changed patches the named applications/<app>/env/<env>.json branch only.
Update provenance (workflow 'refresh-ctx', agent 'validator', generatedAt NOW${sessionId ? `, sessionId '${sessionId}'` : ''}${runId ? `, runId '${runId}'` : ''}). Run \`node .claude/scripts/validate-data.mjs ${PROFILE}\` (and any env file you touched) and fix until it passes. If a patch cannot be expressed within the schema, leave the branch unchanged and list it in unpatched with the reason.
Confirmed drift: ${JSON.stringify(confirmed)}`, {
    label: 'patch details.json', phase: 'Apply', agentType: 'validator',
    schema: { type: 'object', required: ['patchedBranches', 'unpatched', 'validated'], properties: { sessionId: { type: 'string' }, patchedBranches: { type: 'array', items: { type: 'string' } }, unpatched: { type: 'array', items: { type: 'string' } }, validated: { type: 'boolean' }, filesTouched: { type: 'array', items: { type: 'string' } } } },
  });
  if (patch) {
    noteSession(patch);
    result.profilePatched = patch.validated && patch.patchedBranches.length > 0;
    for (const u of patch.unpatched) skipped.push(`patch: ${u}`);
    if (!patch.validated) skipped.push('patch: validator reported validation failure; details.json needs manual review');
  } else skipped.push('patch: validator returned nothing; details.json unchanged');

  const summary = await agent(`${common('report-writer')}
Read .claude/skills/report-templates/SKILL.md. Update ONLY the 'regulatory-posture' section of ${SUMMARY} (create the file from the template if absent) from ${PROFILE} and the ledger ${LEDGER}: registrations with status and category, frameworks in scope, the drift applied in this run (${confirmed.map((d) => `${d.kind}@${d.branch}`).join(', ') || 'none'}), the ${escalated.length} escalated claim(s) awaiting human resolution, and the date of this refresh. Keep other sections byte-identical. Bump the frontmatter version (minor), set provenance as instructed, and recompute provenance.inputsHash exactly as the company-summary frontmatter schema describes. Validate with \`node .claude/scripts/validate-data.mjs ${SUMMARY}\`. Do not append to the ledger: follow report-templates section 5 step 6 and return the report observation as proposedObservation (omit the field when the report was already current).
Return counts.`, {
    label: 'summary regulatory-posture', phase: 'Apply', agentType: 'report-writer', effort: 'low',
    schema: { type: 'object', required: ['updated', 'registrations', 'frameworksInScope'], properties: { sessionId: { type: 'string' }, updated: { type: 'boolean' }, registrations: { type: 'integer' }, frameworksInScope: { type: 'integer' }, version: { type: 'string' }, proposedObservation: { type: 'object', description: 'report-templates section 5 step 6 observation record without id and recordedAt' }, notes: { type: 'string' } } },
  });
  noteSession(summary);
  result.summaryUpdated = Boolean(summary && summary.updated);
  proposedObservation = (summary && summary.proposedObservation) || null;
  if (!summary) skipped.push('summary: report-writer returned nothing; regulatory-posture section not updated');
} else if (dryRun) {
  skipped.push('dry run: details.json patch and summary.md update skipped by design');
}

// ---------------------------------------------------------------- Version
phase('Version');
if (dryRun) {
  skipped.push('dry run: soc/version.mjs not run by design (the inconclusive evidence-request observations are versioned by the next live refresh)');
  result.skipped = skipped;
  result.sessionIds = [...sessionIds];
  log(`refresh-ctx dry run done: ${result.observations} evidence-request observations for ${confirmed.length} confirmed and ${escalated.length} escalated drift item(s) (${dropped.length} refuted and dropped); nothing patched, nothing versioned`);
  return result;
}
const version = await agent(`${common('soc-ledger-keeper')}
${proposedObservation ? `First append the report-writer's proposed observation (report-templates section 5 step 6) via append.mjs: mint id obs_<ULID>, set recordedAt NOW, keep every other field; if its controlIds is empty or names a control that is not in the ledger, use the governance control this run's Apply stage cited. Record: ${JSON.stringify(proposedObservation)}
Then r` : 'R'}un \`node .claude/scripts/soc/version.mjs ${companyId} --session ${sessionId || '<your harness session id>'} --workflow refresh-ctx\` from the workspace root, once. Do not pass --force. Report the observation id you appended (if any), the file version.mjs wrote (empty if it printed that nothing was written) and any error verbatim.`, {
  label: 'version ledger', phase: 'Version', agentType: 'soc-ledger-keeper', effort: 'low',
  schema: { type: 'object', required: ['versionFile'], properties: { sessionId: { type: 'string' }, reportObservationId: { type: 'string' }, versionFile: { type: 'string' }, error: { type: 'string' } } },
});
noteSession(version);
if (version && version.reportObservationId) result.observations += 1;
else if (proposedObservation) skipped.push('version: report observation not appended (keeper returned no id)');
if (version && version.versionFile) result.versionFile = version.versionFile;
else skipped.push(`version: ${version && version.error ? version.error : 'no version file written'}`);

result.skipped = skipped;
result.sessionIds = [...sessionIds];
log(`refresh-ctx done: ${result.observations} observations, ${result.controls} control records, ${result.risks} risks; profile ${result.profilePatched ? 'patched' : 'unchanged'}; ${skipped.length} skipped items`);
return result;
}

const finalResult = await main();
log(`refresh-ctx result: ${finalResult.observations} observations, ${finalResult.controls} controls, ${finalResult.risks} risks, ${finalResult.skipped.length} skipped`);
return finalResult;
