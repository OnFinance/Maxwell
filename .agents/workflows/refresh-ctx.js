// refresh-ctx: keep company-profile/<companyId>/details.json truthful against the regulators' own registers, and
// build company-profile/<companyId>/context.json, the organization context tree: the company note, its business
// units and listing, the licences each unit holds, the obligations every regulator (MCA, SEBI, RBI, IRDAI ...) places
// on them, the questionnaire each obligation raises, and the processes, offerings, customer segments and platforms
// the answers reveal. Modelled on the regulatory-comms-manager licence-refresh and entity context document (see
// .claude/skills/regulatory-catalogs/references/regulatory-comms-manager-offline-copy.md sections 2 and 5):
// Snapshot -> (Recheck || Discover || Structure) -> Obligations (per regulator) -> Answer (per questionnaire)
//   -> Verify (drift: 3 refuter lenses, destructive unanimous; answers: 2 lenses per questionnaire) -> Apply -> Version.
// Every agent runs on Opus (model 'opus'; on OpenCode the configured model stands in for it).
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
// appIds/envIds narrow the environment and repo files re-checked for hosting/residency drift; they never narrow the
// regulatory registrations, which are always company-wide. An empty appIds/envIds array means no filter. dryRun
// researches and refutes but writes only observations with result 'inconclusive' (evidence requests) for drift that
// survived verification or was escalated, citing an existing control; it never appends controls or risks, never
// patches details.json and never writes context.json. NOW is resolved once: args.now when given, otherwise the
// Snapshot (ctx-researcher, which has `date -u`) reads the clock and every later prompt receives that literal, because
// refuter, validator and report-writer have no clock.
// Questions no source answers stay open in context.json; a human answers them in chat and the assistant records each
// with node .claude/scripts/ctx/answer.mjs. Human answers are authoritative and survive every later run.
export const meta = {
  name: 'refresh-ctx',
  description: 'Recheck details.json against regulator registers, build the organization context tree (units, licences, obligations, questionnaires, processes, offerings, segments, platforms), refute, version',
  phases: [
    { title: 'Snapshot', detail: 'Skeleton of details.json, existing context.json, applicable instruments and the last refresh-ctx observation' },
    { title: 'Recheck', detail: 'One ctx-researcher per worklist unit re-verifies a named branch of the profile' },
    { title: 'Discover', detail: 'ctx-researcher lenses registers, corporate and regulatory-change look for what the profile lacks' },
    { title: 'Structure', detail: 'ctx-researcher builds the company note, business units, listing, licences, platforms and the regulators to question' },
    { title: 'Obligations', detail: 'One ctx-researcher per regulator lists its obligation sets and the questionnaire each raises' },
    { title: 'Answer', detail: 'One ctx-researcher per questionnaire answers from fetched sources or leaves the question open' },
    { title: 'Verify', detail: 'Three refuter lenses per drift item (destructive drift unanimous); two lenses per questionnaire on researched answers' },
    { title: 'Apply', detail: 'Ledger observations, control records for new instruments, named-branch patch of details.json, context.json, summary sections' },
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
const CONTEXT = `company-profile/${companyId}/context.json`;
const LEDGER = `company-profile/${companyId}/soc/main.jsonl`;
const SUMMARY = `company-profile/${companyId}/summary.md`;
const INSTRUMENTS = '.claude/skills/regulatory-catalogs/references/instruments.json';
const CATALOG_DIR = '.claude/skills/regulatory-catalogs/references/catalogs';
const REFERENCE = '.claude/skills/regulatory-catalogs/references/regulatory-comms-manager-offline-copy.md';
const CONTEXT_SCHEMA = '.claude/schemas/v1/company/context.schema.json';
const MODEL = 'opus';

const DESTRUCTIVE_KINDS = ['registration_surrendered', 'registration_suspended', 'registration_expired', 'category_changed', 'entity_type_removed', 'instrument_superseded'];
// soc-ledger SKILL section 4 cadence table, copied exactly; continuous/event-driven mean "next scheduled run of the
// probing workflow", and because no probing schedule is recorded in this workspace the documented fallback is used.
const CADENCE_RULE = 'the catalog cadence per soc-ledger SKILL section 4 exactly (daily 1 day, weekly 7, monthly 30, quarterly 91, half-yearly 182, annual 365, biennial 730; continuous and event-driven = the next scheduled run of the probing workflow, and since no probing schedule is recorded in this workspace use the documented Maxwell fallback of 30 days for continuous and 91 days for event-driven)';
const DRIFT_KINDS = ['registration_added', 'registration_surrendered', 'registration_suspended', 'registration_expired', 'registration_changed', 'category_changed', 'entity_type_added', 'entity_type_removed', 'instrument_became_applicable', 'instrument_superseded', 'listing_changed', 'hosting_changed', 'regime_overhaul', 'none'];
const REFUTE_LENSES = ['source-authenticity', 'entity-identity', 'temporal-validity'];
const ANSWER_LENSES = ['source-authenticity', 'entity-identity'];
// Closed lists copied from the context schema; anything else becomes 'other' and is logged.
const PROCESS_KINDS = ['secretarial-compliance', 'client-services', 'market-transactions', 'kyc', 'onboarding', 'grievance-redressal', 'surveillance', 'regulatory-reporting', 'risk-management', 'incident-response', 'vendor-management', 'fund-management', 'lending', 'claims', 'other'];
const OFFERING_CATEGORIES = ['broking', 'depository', 'mutual-fund-scheme', 'pms-strategy', 'aif-scheme', 'advisory', 'research', 'margin-funding', 'lending', 'deposits', 'payments', 'insurance-product', 'pension-product', 'custody', 'other'];
const SEGMENT_KINDS = ['retail-investor', 'nri-investor', 'hni', 'family-office', 'institutional', 'corporate', 'msme', 'pension-scheme', 'insurance-scheme', 'fpi', 'borrower', 'policyholder', 'other'];
const PLATFORM_KINDS = ['customer-platform', 'supporting-function', 'infrastructure', 'data-platform', 'vendor-platform'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_OBLIGATIONS_PER_REGULATOR = 5;
const MAX_QUESTIONS = 6;
const SHORT = (s, n = 200) => { const t = String(s || '').trim(); return t.length <= n ? t : `${t.slice(0, n - 3).replace(/\s+\S*$/, '')}...`; };

const skipped = [];
const sessionIds = new Set();
if (sessionId) sessionIds.add(sessionId);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
const okSlug = (s) => SLUG_RE.test(s) ? s : slug(`x-${s}`);
const uniq = (list) => [...new Set((list || []).filter(Boolean))];

const common = (agentName) => `Company: ${companyId}. Workflow: refresh-ctx. You are the '${agentName}' specialist.
Read .claude/skills/maxwell-conventions/SKILL.md first.
${now ? `TIME: NOW = '${now}' (resolved once by the workflow; never read a clock or guess a date). Use it for every recordedAt, collectedAt and provenance.generatedAt, and as "today" when judging whether a change is effective.` : 'TIME: NOW is not resolved yet and this stage writes nothing: run `date -u +%Y-%m-%dT%H:%M:%SZ` exactly once and return its output verbatim as "now".'}
PROVENANCE on every record or file you write: harness = the harness you run on ('claude-code' or 'opencode'), generatedAt = NOW, sessionId = ${sessionId || 'your own harness session id (Claude Code UUID or OpenCode ses_ id)'}, ${runId ? `runId = '${runId}'` : 'runId = MAXWELL_RUN_ID when set, otherwise omit runId'}, workflow = 'refresh-ctx', agent = '${agentName}'.
Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} <record.json|->\` (never edit ${LEDGER} directly); every other file write must pass \`node .claude/scripts/validate-data.mjs <path>\` before you report success. Never write secret values anywhere.
${dryRun ? 'DRY RUN: do not patch details.json, context.json or any application file; the only permitted writes are ledger observations with result "inconclusive" that cite existing control records.' : ''}`;

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
const STR = { type: 'string' };
const STR_LIST = { type: 'array', items: STR };

// ---------------------------------------------------------------- Snapshot
phase('Snapshot');
const snapshot = await agent(`${common('ctx-researcher')}
Build the SNAPSHOT for refresh-ctx: a skeleton of the profile, never the whole file.
Read ${PROFILE}, ${INSTRUMENTS}, ${LEDGER} (if it exists) and ${CONTEXT} (if it exists).
APPLICATION-TO-COMPANY RULE (deterministic; no application schema carries companyId, so never infer the link from README prose or hosting.accountRef): when company-profile/ contains exactly one company directory every applications/<app_id>/ belongs to it; otherwise the company's applications are the union of ${PROFILE} criticalFunctions[].appIds${appIds ? ` and ${JSON.stringify(appIds)} (args.appIds)` : ''}. List every other applications/<app_id>/ under skipped with reason 'no company link'.
${appIds ? `Of the linked applications only list environments and repos of ${JSON.stringify(appIds)}; list the others under skipped with reason 'filtered by args.appIds'.` : 'List every applications/<app_id>/env/*.json and repos/*.json of the linked applications.'}
${envIds ? `Only list environments whose envId is one of ${JSON.stringify(envIds)}; list the others under skipped with reason 'filtered by args.envIds'.` : ''}
Return: legalName, description (the profile's description field, empty if absent), identifiers (cin, pan, lei, sebiRegistrationNos, rbiCorNo, irdaiRegistrationNo as present), headquarters country, jurisdictions, entityTypes, regulatoryRegistrations (regulator, registrationNo, category, status, validUntil, index in the array), frameworksInScope, applicableInstruments = every instruments.json entry whose applicability.entityTypes intersects entityTypes (or is empty) AND whose applicability.jurisdictions contains a company jurisdiction (or is empty), each flagged inScope = present in frameworksInScope, excluding every entry whose registry status is repealed or superseded (list each such instrument under skipped with its supersededBy successor named; it may be cited only as a secondary, historical mapping); lastRefreshedAt = recordedAt of the newest ledger observation with methods containing 'refresh-ctx' (empty if none); envFiles and repoFiles as workspace paths; linkedAppIds = the linked application ids; ledgerControlIds = ids of the latest control records in the ledger (deduplicated); contextExists = whether ${CONTEXT} exists; humanAnswers = from the existing context.json every question with answeredBy 'human' as {questionnaireId, obligationId, questionId, question, answer} (empty when none); openQuestions = the number of questions with status 'open' in the existing context.json (0 when none); skipped = every application or file you excluded with its reason${now ? '' : '; now = the output of the single `date -u +%Y-%m-%dT%H:%M:%SZ` call'}.`, {
  label: 'snapshot', phase: 'Snapshot', agentType: 'ctx-researcher', effort: 'low', model: MODEL,
  schema: {
    type: 'object',
    required: ['legalName', 'entityTypes', 'regulatoryRegistrations', 'frameworksInScope', 'applicableInstruments', 'lastRefreshedAt', 'envFiles', 'repoFiles', 'linkedAppIds', 'ledgerControlIds', 'contextExists', 'humanAnswers', 'openQuestions', ...(now ? [] : ['now'])],
    properties: {
      sessionId: STR,
      now: { type: 'string', description: 'RFC 3339 UTC timestamp with trailing Z from date -u' },
      skipped: STR_LIST,
      legalName: STR,
      description: STR,
      identifiers: { type: 'object', properties: { cin: STR, pan: STR, lei: STR, sebiRegistrationNos: STR_LIST, rbiCorNo: STR, irdaiRegistrationNo: STR } },
      headquartersCountry: STR,
      jurisdictions: STR_LIST,
      entityTypes: STR_LIST,
      regulatoryRegistrations: { type: 'array', items: { type: 'object', required: ['index', 'regulator', 'registrationNo', 'category'], properties: { index: { type: 'integer' }, regulator: STR, registrationNo: STR, category: STR, status: STR, validUntil: STR } } },
      frameworksInScope: STR_LIST,
      applicableInstruments: { type: 'array', items: { type: 'object', required: ['instrumentId', 'regulator', 'inScope'], properties: { instrumentId: STR, regulator: STR, inScope: { type: 'boolean' }, catalogFile: STR, effectiveFrom: STR } } },
      lastRefreshedAt: STR,
      envFiles: STR_LIST,
      repoFiles: STR_LIST,
      linkedAppIds: STR_LIST,
      ledgerControlIds: STR_LIST,
      contextExists: { type: 'boolean' },
      humanAnswers: { type: 'array', items: { type: 'object', required: ['questionnaireId', 'obligationId', 'questionId', 'question', 'answer'], properties: { questionnaireId: STR, obligationId: STR, questionId: STR, question: STR, answer: STR } } },
      openQuestions: { type: 'integer' },
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
log(`Snapshot: ${snapshot.legalName}; ${snapshot.regulatoryRegistrations.length} registrations, ${snapshot.entityTypes.length} entity types, ${snapshot.applicableInstruments.length} applicable instruments (${snapshot.applicableInstruments.filter((i) => !i.inScope).length} not yet in scope); last refresh ${snapshot.lastRefreshedAt || 'never'}; context ${snapshot.contextExists ? `exists (${snapshot.humanAnswers.length} human answers, ${snapshot.openQuestions} open questions)` : 'not built yet'}`);
const skeleton = { legalName: snapshot.legalName, description: snapshot.description || '', identifiers: snapshot.identifiers || {}, headquartersCountry: snapshot.headquartersCountry || '', entityTypes: snapshot.entityTypes, registrations: snapshot.regulatoryRegistrations, frameworksInScope: snapshot.frameworksInScope, linkedAppIds: snapshot.linkedAppIds || [] };

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

// ---------------------------------------------------------------- Structure prompt (runs alongside Recheck and Discover)
const STRUCTURE_SCHEMA = {
  type: 'object',
  required: ['summary', 'businessUnits', 'licenses', 'platforms', 'regulators', 'sourcesFetched'],
  properties: {
    sessionId: STR,
    summary: { type: 'string', description: 'One paragraph: what the company is, where it is based, what it offers and to whom' },
    businessUnits: { type: 'array', items: { type: 'object', required: ['unitId', 'name', 'publiclyListed'], properties: { unitId: STR, name: STR, description: STR, publiclyListed: { type: 'boolean' }, exchanges: STR_LIST, symbol: STR, isin: STR, evidenceUrl: STR } } },
    licenses: { type: 'array', items: { type: 'object', required: ['licenseId', 'name', 'regulator', 'registrationNo', 'entityType', 'status', 'unitId'], properties: { licenseId: STR, name: STR, regulator: STR, registrationNo: STR, entityType: STR, status: STR, unitId: STR } } },
    platforms: { type: 'array', items: { type: 'object', required: ['platformId', 'name', 'kind'], properties: { platformId: STR, name: STR, kind: { type: 'string', enum: PLATFORM_KINDS }, description: STR, appIds: STR_LIST, licenseIds: STR_LIST, cybersecurityInstruments: STR_LIST } } },
    regulators: { type: 'array', items: { type: 'object', required: ['regulator', 'reason'], properties: { regulator: STR, reason: STR, licenseIds: STR_LIST } } },
    sourcesFetched: STR_LIST,
    notes: STR,
  },
};
const structurePrompt = () => `${common('ctx-researcher')}
${GROUNDING}
STRUCTURE stage: build the top of the organization context tree for ${snapshot.legalName} (${companyId}). Read ${REFERENCE} section 5 (entity context document shape), ${PROFILE}, ${CONTEXT} if it exists (keep its unitId, licenseId and platformId slugs so ids stay stable across runs), every applications/<app_id>/README.md and env/*.json of the linked applications ${JSON.stringify(skeleton.linkedAppIds)}, and ${INSTRUMENTS}.
Skeleton: ${JSON.stringify(skeleton)}
Return:
- summary: one paragraph in plain words (what the company is, whether it is listed, where it is based, what it offers and to whom), from the profile description and the company's own website when it has one.
- businessUnits: the lines of business (a single unit when the company is one business). publiclyListed from the exchange lists (NSE EQUITY_L.csv, BSE scrip list) or MCA master data (a CIN starting with L is a listed company, U unlisted); when listed give exchanges, symbol, isin and the evidenceUrl. Ids are slugs (^[a-z0-9][a-z0-9-]{1,62}$).
- licenses: exactly one entry per regulatoryRegistrations item in the skeleton (never invent one, never drop one): registrationNo verbatim, regulator from the vocabulary, entityType from the entity-types vocabulary matching the registration, status from the profile, unitId of the unit that operates under it, a short name such as 'SEBI stock broker' or 'RBI NBFC (middle layer)'.
- platforms: one per linked application (appIds = [that app id], kind customer-platform when it faces clients, data-platform or infrastructure otherwise, licenseIds = the licences whose offerings it carries) plus one 'supporting-function' entry per shared function the READMEs name (SOC, data pipeline, identity); cybersecurityInstruments = the in-scope instruments in frameworksInScope whose requirements bind that platform.
- regulators: every regulator whose obligations the workflow must question: 'MCA' (Companies Act) whenever the entity has a CIN, and each registration's regulator once, with licenseIds and a one-line reason. Only regulators from .claude/schemas/vocab/regulators.schema.json.
Record every page you relied on in sourcesFetched.`;

// ---------------------------------------------------------------- Recheck || Discover || Structure
phase('Recheck');
phase('Discover');
phase('Structure');
const [recheckResults, discoverResults, structureResult] = await parallel([
  () => pipeline(worklist, (u) => agent(recheckPrompt(u), { label: `recheck ${u.unit}`, phase: 'Recheck', agentType: 'ctx-researcher', schema: DRIFT_SCHEMA, model: MODEL })),
  () => pipeline(['registers', 'corporate', 'regulatory-change'], (lens) => agent(discoverPrompt(lens), { label: `discover ${lens}`, phase: 'Discover', agentType: 'ctx-researcher', schema: DRIFT_SCHEMA, model: MODEL })),
  () => agent(structurePrompt(), { label: 'structure', phase: 'Structure', agentType: 'ctx-researcher', schema: STRUCTURE_SCHEMA, model: MODEL, effort: 'high' }),
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

// ---------------------------------------------------------------- Structure result (plain code)
const structure = structureResult;
if (!structure) throw new Error('Structure failed: ctx-researcher returned nothing; the context tree cannot be built');
noteSession(structure);
if (structure.notes) log(`structure: ${structure.notes}`);
const registrationNos = new Set(snapshot.regulatoryRegistrations.map((r) => r.registrationNo));
const units = (structure.businessUnits || []).map((u) => ({ ...u, unitId: okSlug(u.unitId) }));
if (!units.length) units.push({ unitId: slug(snapshot.legalName) || 'company', name: snapshot.legalName, publiclyListed: false });
const unitIds = new Set(units.map((u) => u.unitId));
const licenses = [];
for (const l of structure.licenses || []) {
  if (!registrationNos.has(l.registrationNo)) { skipped.push(`structure: licence ${l.licenseId} (${l.registrationNo}) is not a details.json registration; dropped`); continue; }
  licenses.push({ ...l, licenseId: okSlug(l.licenseId), unitId: unitIds.has(l.unitId) ? l.unitId : units[0].unitId });
}
for (const r of snapshot.regulatoryRegistrations) {
  if (licenses.some((l) => l.registrationNo === r.registrationNo)) continue;
  skipped.push(`structure: registration ${r.regulator}:${r.registrationNo} was not placed by the researcher; placed under ${units[0].unitId} with the profile's entity type`);
  licenses.push({ licenseId: okSlug(`${r.regulator}-${r.registrationNo}`), name: `${r.regulator} registration ${r.registrationNo}`, regulator: r.regulator, registrationNo: r.registrationNo, entityType: snapshot.entityTypes[0], status: r.status || 'active', unitId: units[0].unitId });
}
const licenseIds = new Set(licenses.map((l) => l.licenseId));
const platforms = (structure.platforms || []).map((p) => ({ ...p, platformId: okSlug(p.platformId), kind: PLATFORM_KINDS.includes(p.kind) ? p.kind : 'supporting-function', appIds: uniq(p.appIds).filter((a) => skeleton.linkedAppIds.includes(a)), licenseIds: uniq(p.licenseIds).filter((id) => licenseIds.has(id)), cybersecurityInstruments: uniq(p.cybersecurityInstruments).filter((i) => snapshot.frameworksInScope.includes(i)) }));
const regulatorPlan = [];
for (const r of structure.regulators || []) {
  if (!r.regulator || regulatorPlan.some((x) => x.regulator === r.regulator)) continue;
  regulatorPlan.push({ regulator: r.regulator, reason: r.reason, licenseIds: uniq(r.licenseIds).filter((id) => licenseIds.has(id)) });
}
if ((skeleton.identifiers || {}).cin && !regulatorPlan.some((x) => x.regulator === 'MCA')) regulatorPlan.push({ regulator: 'MCA', reason: 'the entity has a CIN, so the Companies Act 2013 applies', licenseIds: [] });
for (const l of licenses) if (!regulatorPlan.some((x) => x.regulator === l.regulator)) regulatorPlan.push({ regulator: l.regulator, reason: `issued ${l.name}`, licenseIds: [l.licenseId] });
log(`Structure: ${units.length} business unit(s) (${units.filter((u) => u.publiclyListed).length} listed), ${licenses.length} licence(s), ${platforms.length} platform(s); obligations to question for ${regulatorPlan.map((r) => r.regulator).join(', ')}`);

// ---------------------------------------------------------------- Obligations (one researcher per regulator)
phase('Obligations');
const OBLIGATIONS_SCHEMA = {
  type: 'object',
  required: ['regulator', 'obligations', 'sourcesFetched'],
  properties: {
    sessionId: STR,
    regulator: STR,
    obligations: { type: 'array', items: { type: 'object', required: ['obligationId', 'title', 'source', 'questions'], properties: {
      obligationId: STR, title: STR, summary: STR,
      source: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string', enum: ['instrument', 'statute', 'circular', 'register'] }, ref: STR, url: STR } },
      scope: { type: 'string', enum: ['company', 'license'] },
      licenseIds: STR_LIST,
      questions: { type: 'array', items: { type: 'object', required: ['questionId', 'question', 'answerableFrom'], properties: { questionId: STR, question: STR, rationale: STR, answerableFrom: { type: 'string', enum: ['public', 'internal'], description: 'public: a register, filing, annual report, scheme list, website or exchange page can answer it; internal: only the company\'s own staff can' } } } },
    } } },
    sourcesFetched: STR_LIST,
    notes: STR,
  },
};
const obligationsPrompt = (r) => `${common('ctx-researcher')}
${GROUNDING}
OBLIGATIONS stage for regulator '${r.regulator}' (${r.reason}) and ${snapshot.legalName} (${companyId}). Read ${REFERENCE} section 5, ${INSTRUMENTS} and the catalogs under ${CATALOG_DIR}/ for this regulator's in-scope instruments, and ${CONTEXT} if it exists (reuse its obligationId and questionId slugs for the same obligations and questions so ids stay stable).
Skeleton: ${JSON.stringify({ legalName: snapshot.legalName, entityTypes: snapshot.entityTypes, frameworksInScope: snapshot.frameworksInScope, licenses: licenses.filter((l) => r.licenseIds.includes(l.licenseId) || l.regulator === r.regulator).map((l) => ({ licenseId: l.licenseId, name: l.name, registrationNo: l.registrationNo, entityType: l.entityType })) })}
${r.regulator === 'MCA' ? 'MCA: the Companies Act 2013 and its rules as they apply to this company form (private, public, listed): secretarial compliance (board and general meetings, annual return, financial statements, statutory registers, company secretary and auditors), related-party and disclosure duties, plus SEBI LODR only when a unit is listed. source.type statute or circular with the MCA URL.' : `${r.regulator}: for each licence above, the regulations, master circulars and in-scope instruments that bind it (source.type instrument with the vocab id when the obligation is an instrument in ${INSTRUMENTS}; circular or statute otherwise, with the URL). Use \`node .claude/scripts/cos/search.mjs search --query "<text>" --regulator ${r.regulator}\` for clause and circular text before any public search.`}
For every obligation set, write the questionnaire whose answers describe how this company operates under it: which processes it runs (secretarial compliance, client services, market transactions, KYC and onboarding, grievance redressal, surveillance, regulatory reporting, risk management ...), which offerings it sells under the licence (schemes, strategies, products, with counts when the regulator lists them), which customer segments it serves, which platforms carry them. Every question is answerable in one sentence from a public source or by the company's compliance officer, and each should reveal a process, offering, segment or platform rather than a filing date or a form number: prefer few broad questions ('Which client segments does the broker onboard and through which channels?') over many narrow ones. Mark each question answerableFrom 'public' when MCA master data, a filing, an annual report, a scheme list, the company website, an exchange or a regulator page can answer it, and 'internal' when only the company's own staff can (which system, who tracks, how often the board reviews). Cap: ${MAX_OBLIGATIONS_PER_REGULATOR} obligation sets per regulator (merge related duties into one set), ${MAX_QUESTIONS} questions each, at most 2 internal questions per set. Ids are slugs (^[a-z0-9][a-z0-9-]{1,62}$); prefix question ids with the obligation id.`;
const obligationResults = await parallel(regulatorPlan.map((r) => () => agent(obligationsPrompt(r), { label: `obligations ${r.regulator}`, phase: 'Obligations', agentType: 'ctx-researcher', schema: OBLIGATIONS_SCHEMA, model: MODEL, effort: 'high' })));
const obligations = [];
const questionnaires = [];
const obligationIds = new Set();
regulatorPlan.forEach((r, i) => {
  const res = obligationResults[i];
  if (!res) { skipped.push(`obligations: researcher for ${r.regulator} returned nothing; its obligations are missing from the context tree this run`); return; }
  noteSession(res);
  if (res.notes) log(`obligations ${r.regulator}: ${res.notes}`);
  for (const o of (res.obligations || []).slice(0, MAX_OBLIGATIONS_PER_REGULATOR)) {
    const obligationId = okSlug(o.obligationId);
    if (obligationIds.has(obligationId)) { skipped.push(`obligations: duplicate obligation id ${obligationId} from ${r.regulator} dropped`); continue; }
    if (!(o.questions || []).length) { skipped.push(`obligations: ${obligationId} raised no question; dropped`); continue; }
    obligationIds.add(obligationId);
    const questionnaireId = okSlug(`q-${obligationId}`);
    const scopedLicenses = uniq(o.licenseIds).filter((id) => licenseIds.has(id));
    obligations.push({ obligationId, title: o.title, regulator: r.regulator, source: { type: o.source.type, ref: o.source.ref, ...(o.source.url && /^https?:\/\//.test(o.source.url) ? { url: o.source.url } : {}) }, ...(o.summary ? { summary: o.summary } : {}), questionnaireId, scope: o.scope === 'license' || scopedLicenses.length ? 'license' : 'company', licenseIds: scopedLicenses.length ? scopedLicenses : r.licenseIds });
    const qseen = new Set();
    const questions = [];
    for (const q of (o.questions || []).slice(0, MAX_QUESTIONS)) {
      const questionId = okSlug(q.questionId);
      if (qseen.has(questionId)) continue;
      qseen.add(questionId);
      questions.push({ questionId, question: q.question, rationale: q.rationale || '', answerableFrom: q.answerableFrom === 'internal' ? 'internal' : 'public' });
    }
    questionnaires.push({ questionnaireId, obligationId, regulator: r.regulator, questions });
  }
});
log(`Obligations: ${obligations.length} obligation set(s) and ${questionnaires.reduce((n, q) => n + q.questions.length, 0)} question(s) across ${regulatorPlan.length} regulator(s)`);

// ---------------------------------------------------------------- Answer (one researcher per questionnaire)
phase('Answer');
const YIELD = { type: 'object', required: ['type', 'id', 'name'], properties: { type: { type: 'string', enum: ['process', 'offering', 'segment', 'platform'] }, id: STR, name: STR, kind: { type: 'string', description: 'process kind, offering category, segment kind or platform kind from the closed lists' }, count: { type: 'integer' }, description: STR, licenseId: STR, ownerRole: STR, appIds: STR_LIST } };
const ANSWER_SCHEMA = {
  type: 'object',
  required: ['questionnaireId', 'answers', 'sourcesFetched'],
  properties: {
    sessionId: STR,
    questionnaireId: STR,
    answers: { type: 'array', items: { type: 'object', required: ['questionId', 'status', 'yields'], properties: {
      questionId: STR, status: { type: 'string', enum: ['answered', 'open', 'not-applicable'] }, answer: STR, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, queriesTried: STR_LIST,
      evidence: { type: 'array', items: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string', enum: ['url', 'workspace-file'] }, ref: STR, description: STR } } },
      reason: STR, yields: { type: 'array', items: YIELD },
    } } },
    sourcesFetched: STR_LIST,
    notes: STR,
  },
};
const humanByQuestion = new Map((snapshot.humanAnswers || []).map((h) => [h.questionId, h]));
const answerPrompt = (q) => {
  const ob = obligations.find((o) => o.obligationId === q.obligationId);
  const humans = q.questions.filter((x) => humanByQuestion.has(x.questionId)).map((x) => ({ questionId: x.questionId, answer: humanByQuestion.get(x.questionId).answer }));
  return `${common('ctx-researcher')}
${GROUNDING}
ANSWER stage for questionnaire '${q.questionnaireId}' of obligation '${ob.title}' (${q.regulator}, source ${ob.source.type} ${ob.source.ref}${ob.source.url ? ` ${ob.source.url}` : ''}) about ${snapshot.legalName} (${companyId}).
Skeleton: ${JSON.stringify({ ...skeleton, licenses: licenses.map((l) => ({ licenseId: l.licenseId, name: l.name, registrationNo: l.registrationNo })), platforms: platforms.map((p) => ({ platformId: p.platformId, name: p.name, appIds: p.appIds })) })}
Questions: ${JSON.stringify(q.questions.map((x) => ({ questionId: x.questionId, question: x.question, rationale: x.rationale, answerableFrom: x.answerableFrom })))}
${humans.length ? `HUMAN ANSWERS (authoritative, keep verbatim as the answer with status 'answered' and evidence [], but still derive yields): ${JSON.stringify(humans)}` : ''}
RESEARCH BUDGET: before you mark a 'public' question open, run at least 3 targeted WebSearch queries for it (the legal name or brand plus the topic; site:mca.gov.in master data and filings; the annual report or board's report PDF; AMFI or SEBI scheme and intermediary pages; NSE and BSE member directories and announcements; SEBI SCORES and the company's grievance page; the company's fair practices code, KFS, policies and 'about' pages) and fetch the best hits; list every query in queriesTried. 'internal' questions get one quick check of the company's website and the workspace, then status open with reason 'internal: ask the compliance officer'. Answer each question from pages you fetch this session: the company's own website${skeleton.identifiers && skeleton.identifiers.cin ? ', MCA master data' : ''}, annual report and filings, AMFI or SEBI scheme lists, exchange member pages, regulator registers, and the workspace files applications/*/README.md and env/*.json (evidence type workspace-file). A question no source answers is status 'open' with a reason; a question the obligation does not reach for this company is 'not-applicable' with a reason. Never guess.
For every answered question list what it yields as context items: type process (kind from ${JSON.stringify(PROCESS_KINDS)}), offering (kind = category from ${JSON.stringify(OFFERING_CATEGORIES)}, licenseId from the skeleton, count when the source lists a number), segment (kind from ${JSON.stringify(SEGMENT_KINDS)}) or platform (kind from ${JSON.stringify(PLATFORM_KINDS)}, appIds from the skeleton; reuse an existing platformId when it is the same platform). Ids are slugs; reuse the same id for the same thing across questions. Record every page you relied on in sourcesFetched.`;
};
const answerResults = await parallel(questionnaires.map((q) => () => agent(answerPrompt(q), { label: `answer ${q.questionnaireId}`, phase: 'Answer', agentType: 'ctx-researcher', schema: ANSWER_SCHEMA, model: MODEL, effort: 'high' })));
questionnaires.forEach((q, i) => {
  const res = answerResults[i];
  const byId = new Map(((res && res.answers) || []).map((a) => [a.questionId, a]));
  if (!res) skipped.push(`answer: researcher for ${q.questionnaireId} returned nothing; its questions stay open`);
  else { noteSession(res); if (res.notes) log(`answer ${q.questionnaireId}: ${res.notes}`); }
  for (const x of q.questions) {
    const a = byId.get(x.questionId);
    const human = humanByQuestion.get(x.questionId);
    if (human) { x.status = 'answered'; x.answer = human.answer; x.answeredBy = 'human'; x.confidence = 'high'; x.evidence = []; x.yields = (a && a.yields) || []; continue; }
    if (!a || a.status === 'open' || (a.status === 'answered' && (!a.answer || !(a.evidence || []).length))) {
      x.status = 'open'; x.reason = SHORT((a && a.reason) || (a && a.status === 'answered' ? 'answer returned without evidence' : 'no source answered this question')); x.queriesTried = uniq((a && a.queriesTried) || []); x.yields = []; continue;
    }
    if (a.status === 'not-applicable') { x.status = 'not-applicable'; x.reason = SHORT(a.reason || 'not applicable'); x.yields = []; continue; }
    x.status = 'answered'; x.answer = a.answer; x.answeredBy = 'research'; x.confidence = a.confidence || 'medium'; x.evidence = (a.evidence || []).map((e) => ({ type: e.type, ref: e.ref, ...(e.description ? { description: e.description } : {}) })); x.yields = a.yields || [];
  }
});
// Second pass: one deep-search agent per questionnaire that still has open public questions, told what was already tried.
const secondPass = questionnaires.map((q) => ({ q, open: q.questions.filter((x) => x.status === 'open' && x.answerableFrom === 'public' && !humanByQuestion.has(x.questionId)) })).filter((e) => e.open.length);
const secondResults = await parallel(secondPass.map((e) => () => agent(`${answerPrompt({ ...e.q, questions: e.open })}
SECOND PASS: a first researcher left these ${e.open.length} public question(s) open after these queries: ${JSON.stringify(e.open.map((x) => ({ questionId: x.questionId, reason: x.reason, queriesTried: x.queriesTried || [] })))}. Try different sources and phrasings (regulator registers by registration number, the exchange member pages, annual report PDFs, news of the company's own announcements) with at least 4 new queries per question before leaving it open.`, { label: `answer again ${e.q.questionnaireId}`, phase: 'Answer', agentType: 'ctx-researcher', schema: ANSWER_SCHEMA, model: MODEL, effort: 'high' })));
secondPass.forEach((e, i) => {
  const res = secondResults[i];
  if (!res) return;
  noteSession(res);
  const byId = new Map((res.answers || []).map((a) => [a.questionId, a]));
  for (const x of e.open) {
    const a = byId.get(x.questionId);
    if (!a || a.status !== 'answered' || !a.answer || !(a.evidence || []).length) { if (a && a.queriesTried) x.queriesTried = uniq([...(x.queriesTried || []), ...a.queriesTried]); continue; }
    x.status = 'answered'; x.answer = a.answer; x.answeredBy = 'research'; x.confidence = a.confidence || 'medium'; x.evidence = (a.evidence || []).map((ev) => ({ type: ev.type, ref: ev.ref, ...(ev.description ? { description: ev.description } : {}) })); x.yields = a.yields || []; delete x.reason;
  }
});
const allQuestions = questionnaires.flatMap((q) => q.questions);
log(`Answer: ${allQuestions.filter((x) => x.status === 'answered').length} answered (${allQuestions.filter((x) => x.answerableFrom === 'internal').length} internal questions go to the compliance officer) (${allQuestions.filter((x) => x.answeredBy === 'human').length} by a human), ${allQuestions.filter((x) => x.status === 'open').length} open, ${allQuestions.filter((x) => x.status === 'not-applicable').length} not applicable`);

// ---------------------------------------------------------------- Verify
phase('Verify');
const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { sessionId: STR, refuted: { type: 'boolean' }, reason: STR, checkedUrl: STR },
};
const refutePrompt = (d, lens) => `${common('refuter')}
Read .claude/skills/maxwell-conventions/SKILL.md and ${REFERENCE} section 2 (adversarial verification).
${GROUNDING}
Try to REFUTE this drift claim about ${snapshot.legalName} (${companyId}); default to refuted=true when uncertain${d.destructive ? ' — this is a DESTRUCTIVE kind, so any doubt refutes it' : ''}.
Claim: ${JSON.stringify(d)}
Lens '${lens}': ${lens === 'source-authenticity' ? 'fetch evidenceUrl yourself; refute unless it is the regulator\'s own register or an official primary source AND it actually states what the claim\'s "evidence" excerpt quotes.' : ''}${lens === 'entity-identity' ? `refute unless the source names this exact legal entity (legalName '${snapshot.legalName}', CIN/PAN/registration numbers from ${PROFILE}) rather than a parent, subsidiary, sister company or namesake.` : ''}${lens === 'temporal-validity' ? `refute if the change is not yet effective as of NOW '${now}' (effectiveDate after NOW), is stale (already reflected in ${PROFILE} or in a ledger observation with methods refresh-ctx in ${LEDGER}), or the claim's from/to is the same as the current profile value.` : ''}
Read only what you need; never write any file.`;

const BATCH_VERDICT = { type: 'object', required: ['verdicts'], properties: { sessionId: STR, verdicts: { type: 'array', items: { type: 'object', required: ['questionId', 'refuted', 'reason'], properties: { questionId: STR, refuted: { type: 'boolean' }, reason: STR, checkedUrl: STR } } } } };
const answerRefutePrompt = (q, lens) => {
  const researched = q.questions.filter((x) => x.status === 'answered' && x.answeredBy === 'research').map((x) => ({ questionId: x.questionId, question: x.question, answer: x.answer, evidence: x.evidence, yields: x.yields.map((y) => `${y.type}:${y.id}`) }));
  return `${common('refuter')}
Read .claude/skills/maxwell-conventions/SKILL.md and ${REFERENCE} section 2 (adversarial verification).
${GROUNDING}
Keyed batch: try to REFUTE each researched answer below about ${snapshot.legalName} (${companyId}); default to refuted=true when uncertain. One verdict per questionId.
Lens '${lens}': ${lens === 'source-authenticity' ? 'fetch each answer\'s evidence refs yourself (WebFetch for URLs, Read for workspace-file refs); refute unless the source is the company\'s own publication, a regulator register, an exchange or AMFI page, or a workspace file, AND it actually supports the answer and every yield it names.' : `refute unless the source names this exact legal entity (legalName '${snapshot.legalName}', CIN/PAN/registration numbers from ${PROFILE}) rather than a parent, subsidiary, sister company, namesake or a peer used as an illustration.`}
Answers: ${JSON.stringify(researched)}
Read only what you need; never write any file.`;
};

const [verified, answerVerdicts] = await parallel([
  () => pipeline(candidates, async (d) => {
    const votes = await parallel(REFUTE_LENSES.map((lens) => () => agent(refutePrompt(d, lens), { label: `refute ${d.kind}@${d.branch} [${lens}]`, phase: 'Verify', agentType: 'refuter', schema: VERDICT, model: MODEL, effort: d.destructive ? 'high' : 'medium' })));
    votes.forEach(noteSession);
    const labelled = votes.map((v, i) => (v ? { lens: REFUTE_LENSES[i], refuted: v.refuted, reason: v.reason } : null));
    const valid = labelled.filter(Boolean);
    const refutations = valid.filter((v) => v.refuted).length;
    // Section 2 of the offline copy: destructive kinds need unanimous non-refutation (a missing verdict counts as
    // doubt); other kinds survive when fewer than 2 lenses refute, provided at least 2 lenses actually answered.
    const confirmed = d.destructive ? (valid.length === REFUTE_LENSES.length && refutations === 0) : (valid.length >= 2 && refutations < 2);
    if (valid.length < REFUTE_LENSES.length) skipped.push(`verify: ${REFUTE_LENSES.length - valid.length} refuter lens(es) returned nothing for ${d.kind}@${d.branch}`);
    return { drift: d, confirmed, escalate: d.destructive && !confirmed, votes: valid };
  }),
  () => pipeline(questionnaires.filter((q) => q.questions.some((x) => x.status === 'answered' && x.answeredBy === 'research')), async (q) => {
    const votes = await parallel(ANSWER_LENSES.map((lens) => () => agent(answerRefutePrompt(q, lens), { label: `refute answers ${q.questionnaireId} [${lens}]`, phase: 'Verify', agentType: 'refuter', schema: BATCH_VERDICT, model: MODEL, effort: 'medium' })));
    votes.forEach(noteSession);
    return { questionnaireId: q.questionnaireId, votes: votes.map((v, i) => ({ lens: ANSWER_LENSES[i], verdicts: (v && v.verdicts) || null })) };
  }),
]);
const confirmed = (verified || []).filter(Boolean).filter((v) => v.confirmed).map((v) => v.drift);
const escalated = (verified || []).filter(Boolean).filter((v) => v.escalate);
const dropped = (verified || []).filter(Boolean).filter((v) => !v.confirmed && !v.escalate);
log(`Verify drift: ${confirmed.length} confirmed, ${escalated.length} destructive claims escalated to a risk record (never dropped), ${dropped.length} refuted and dropped`);
for (const v of dropped) skipped.push(`drift ${v.drift.kind}@${v.drift.branch} refuted: ${v.votes.filter((x) => x.refuted).map((x) => `${x.lens}: ${x.reason}`).join(' | ')}`);
// An answer survives when no lens that answered refuted it; a refuted answer reopens the question with the reason.
let refutedAnswers = 0;
for (const av of (answerVerdicts || []).filter(Boolean)) {
  const q = questionnaires.find((x) => x.questionnaireId === av.questionnaireId);
  const missing = av.votes.filter((v) => !v.verdicts);
  if (missing.length) skipped.push(`verify answers ${av.questionnaireId}: ${missing.map((v) => v.lens).join(', ')} returned nothing (answers kept on the remaining lens)`);
  for (const x of q.questions) {
    if (x.status !== 'answered' || x.answeredBy !== 'research') continue;
    const against = av.votes.flatMap((v) => (v.verdicts || []).filter((r) => r.questionId === x.questionId && r.refuted).map((r) => `${v.lens}: ${r.reason}`));
    if (!against.length) continue;
    refutedAnswers += 1;
    skipped.push(`answer ${x.questionId} refuted: ${against.join(' | ')}`);
    x.status = 'open'; x.reason = SHORT(`refuted: ${against[0]}`); delete x.answer; delete x.answeredBy; delete x.confidence; delete x.evidence; x.yields = [];
  }
}
log(`Verify answers: ${refutedAnswers} researched answer(s) refuted and reopened`);

// ---------------------------------------------------------------- Compose context.json (plain code)
const processes = new Map(); const offerings = new Map(); const segments = new Map(); const platformMap = new Map(platforms.map((p) => [p.platformId, { platformId: p.platformId, name: p.name, kind: p.kind, ...(p.description ? { description: p.description } : {}), appIds: p.appIds, licenseIds: p.licenseIds, cybersecurityInstruments: p.cybersecurityInstruments }]));
const link = (obj, field, id) => { obj[field] = uniq([...(obj[field] || []), id]); };
for (const q of questionnaires) {
  const ob = obligations.find((o) => o.obligationId === q.obligationId);
  for (const x of q.questions) {
    const yields = [];
    for (const y of x.yields || []) {
      const id = okSlug(y.id);
      const kindOf = (list, value) => (list.includes(value) ? value : 'other');
      if (y.type === 'process') {
        const p = processes.get(id) || { processId: id, name: y.name, kind: kindOf(PROCESS_KINDS, y.kind), ...(y.description ? { description: y.description } : {}), ...(y.ownerRole ? { ownerRole: y.ownerRole } : {}) };
        if (!PROCESS_KINDS.includes(y.kind)) skipped.push(`context: process ${id} kind '${y.kind}' is outside the closed list; recorded as other`);
        link(p, 'obligationIds', ob.obligationId);
        if (ob.scope === 'company') for (const u of units) link(p, 'unitIds', u.unitId); else for (const lid of ob.licenseIds) link(p, 'licenseIds', lid);
        processes.set(id, p);
      } else if (y.type === 'offering') {
        const licenseId = licenseIds.has(y.licenseId) ? y.licenseId : (ob.licenseIds[0] || licenses[0].licenseId);
        const f = offerings.get(id) || { offeringId: id, name: y.name, category: kindOf(OFFERING_CATEGORIES, y.kind), licenseId, ...(y.count ? { count: y.count } : {}), ...(y.description ? { description: y.description } : {}) };
        if (!OFFERING_CATEGORIES.includes(y.kind)) skipped.push(`context: offering ${id} category '${y.kind}' is outside the closed list; recorded as other`);
        offerings.set(id, f);
      } else if (y.type === 'segment') {
        const s = segments.get(id) || { segmentId: id, name: y.name, kind: kindOf(SEGMENT_KINDS, y.kind), ...(y.description ? { description: y.description } : {}) };
        if (!SEGMENT_KINDS.includes(y.kind)) skipped.push(`context: segment ${id} kind '${y.kind}' is outside the closed list; recorded as other`);
        segments.set(id, s);
      } else if (y.type === 'platform') {
        const p = platformMap.get(id) || { platformId: id, name: y.name, kind: PLATFORM_KINDS.includes(y.kind) ? y.kind : 'supporting-function', ...(y.description ? { description: y.description } : {}), appIds: uniq(y.appIds).filter((a) => skeleton.linkedAppIds.includes(a)), licenseIds: [], cybersecurityInstruments: [] };
        for (const lid of ob.licenseIds) link(p, 'licenseIds', lid);
        platformMap.set(id, p);
      }
      yields.push({ type: y.type, id });
    }
    x.yields = uniq(yields.map((y) => `${y.type}:${y.id}`)).map((s) => ({ type: s.split(':')[0], id: s.split(':')[1] }));
    // Offerings, segments and processes named together in one answer belong together.
    const ids = (t) => x.yields.filter((y) => y.type === t).map((y) => y.id);
    for (const pid of ids('process')) { const p = processes.get(pid); for (const oid of ids('offering')) link(p, 'offeringIds', oid); for (const sid of ids('segment')) link(p, 'segmentIds', sid); }
    for (const oid of ids('offering')) { const f = offerings.get(oid); for (const sid of ids('segment')) link(f, 'segmentIds', sid); for (const pid of ids('process')) link(f, 'processIds', pid); }
    for (const sid of ids('segment')) { const s = segments.get(sid); for (const pid of ids('process')) link(s, 'processIds', pid); }
  }
}
for (const ob of obligations) for (const lid of ob.licenseIds) link(licenses.find((l) => l.licenseId === lid), 'obligationIds', ob.obligationId);
for (const ob of obligations) if (ob.scope === 'company') for (const u of units) link(u, 'obligationIds', ob.obligationId);
for (const p of processes.values()) { for (const lid of p.licenseIds || []) link(licenses.find((l) => l.licenseId === lid), 'processIds', p.processId); for (const uid of p.unitIds || []) link(units.find((u) => u.unitId === uid), 'processIds', p.processId); }
for (const f of offerings.values()) link(licenses.find((l) => l.licenseId === f.licenseId), 'offeringIds', f.offeringId);
for (const p of platformMap.values()) for (const lid of p.licenseIds || []) link(licenses.find((l) => l.licenseId === lid), 'platformIds', p.platformId);
for (const u of units) u.licenseIds = licenses.filter((l) => l.unitId === u.unitId).map((l) => l.licenseId);
const openCount = allQuestions.filter((x) => x.status === 'open').length;
const contextDoc = {
  schemaVersion: '1', kind: 'maxwell.company.context', companyId,
  status: openCount ? 'in_progress' : 'complete',
  summary: structure.summary || skeleton.description || snapshot.legalName,
  businessUnits: units.map((u) => ({ unitId: u.unitId, name: u.name, ...(u.description ? { description: u.description } : {}), publiclyListed: Boolean(u.publiclyListed), ...(u.publiclyListed && (u.exchanges || []).length ? { listing: { exchanges: uniq(u.exchanges), ...(u.symbol ? { symbol: u.symbol } : {}), ...(u.isin && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(u.isin) ? { isin: u.isin } : {}) } } : {}), licenseIds: u.licenseIds, obligationIds: u.obligationIds || [], processIds: u.processIds || [] })),
  licenses: licenses.map((l) => ({ licenseId: l.licenseId, name: l.name, regulator: l.regulator, registrationNo: l.registrationNo, entityType: l.entityType, status: l.status, unitId: l.unitId, obligationIds: l.obligationIds || [], processIds: l.processIds || [], offeringIds: l.offeringIds || [], platformIds: l.platformIds || [] })),
  obligations: obligations.map((o) => ({ obligationId: o.obligationId, title: o.title, regulator: o.regulator, source: o.source, ...(o.summary ? { summary: o.summary } : {}), questionnaireId: o.questionnaireId })),
  questionnaires: questionnaires.map((q) => ({ questionnaireId: q.questionnaireId, obligationId: q.obligationId, questions: q.questions.map((x) => ({ questionId: x.questionId, question: x.question, answerableFrom: x.answerableFrom, status: x.status, ...(x.status === 'answered' ? { answer: x.answer, answeredBy: x.answeredBy, confidence: x.confidence, evidence: (x.evidence || []).map((e) => ({ ...e, ...(e.description ? { description: SHORT(e.description) } : {}) })), answeredAt: now } : { reason: SHORT(x.reason || 'open') }), yields: x.yields })) })),
  processes: [...processes.values()],
  offerings: [...offerings.values()],
  customerSegments: [...segments.values()],
  platforms: [...platformMap.values()],
  provenance: { harness: 'claude-code', generatedAt: now, ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}), workflow: 'refresh-ctx', agent: 'validator' },
};
for (const u of contextDoc.businessUnits) if (u.publiclyListed && !u.listing) { u.publiclyListed = false; skipped.push(`context: unit ${u.unitId} was reported listed without an exchange; recorded as unlisted`); }
log(`Context tree: ${contextDoc.businessUnits.length} unit(s), ${contextDoc.licenses.length} licence(s), ${contextDoc.obligations.length} obligation(s), ${allQuestions.length} question(s) (${openCount} open), ${contextDoc.processes.length} process(es), ${contextDoc.offerings.length} offering(s), ${contextDoc.customerSegments.length} segment(s), ${contextDoc.platforms.length} platform(s); status ${contextDoc.status}`);

// ---------------------------------------------------------------- Apply
const result = { companyId, workflow: 'refresh-ctx', dryRun, targets: worklist.map((u) => u.unit), candidates: candidates.length, confirmedDrift: confirmed.map((d) => `${d.kind}@${d.branch}`), escalatedDrift: escalated.map((v) => `${v.drift.kind}@${v.drift.branch}`), context: { status: contextDoc.status, businessUnits: contextDoc.businessUnits.length, licenses: contextDoc.licenses.length, obligations: contextDoc.obligations.length, questions: allQuestions.length, openQuestions: allQuestions.filter((x) => x.status === 'open').map((x) => x.questionId), processes: contextDoc.processes.length, offerings: contextDoc.offerings.length, customerSegments: contextDoc.customerSegments.length, platforms: contextDoc.platforms.length, written: false }, observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, controls: 0, profilePatched: false, summaryUpdated: false, versionFile: '', skipped, sessionIds: [] };

phase('Apply');
const newInstruments = dryRun ? [] : [...new Set(confirmed.filter((d) => d.kind === 'instrument_became_applicable' && d.instrumentId).map((d) => d.instrumentId))];
// One keeper session per newly applicable instrument: a catalog can hold 100+ controls and append.mjs takes one
// record per call, so a single session for every instrument would exhaust its turn budget.
const CONTROL_SCHEMA = { type: 'object', required: ['controlIds', 'skippedControlIds'], properties: { sessionId: STR, controlIds: STR_LIST, skippedControlIds: STR_LIST, notes: STR } };
let controlsAppended = 0;
for (const instrumentId of newInstruments) {
  const c = await agent(`${common('soc-ledger-keeper')}
Read .claude/skills/soc-ledger/SKILL.md section 4 and .claude/skills/regulatory-catalogs/SKILL.md. Instrument '${instrumentId}' became applicable to ${companyId} (confirmed drift). Load its catalogFile from ${INSTRUMENTS}; if the catalog file does not exist, append nothing and say so in notes.
For every catalog control whose applicability is absent or matches the company's entityTypes and regulatoryRegistrations[].category values (read ${PROFILE}), append a control record via append.mjs (JSON on stdin): id '${instrumentId}:<controlId>', kind 'control', schemaVersion '1', companyId '${companyId}', frameworkRefs[0] = {regulator, instrument:'${instrumentId}', controlId} followed by the catalog mappings, title and category from the catalog, implementationStatus 'unknown', effectiveness 'not-tested', nextDueAt = NOW plus ${CADENCE_RULE}, evidence [{type:'workspace-file', ref:'<catalogFile>'}], recordedAt NOW, provenance. Ids already in ${LEDGER} are not re-appended: list them under skippedControlIds. You may loop with node -e over the catalog to call append.mjs once per record, but never write a scratch file.
Return {controlIds, skippedControlIds, notes}.`, { label: `controls ${instrumentId}`, phase: 'Apply', agentType: 'soc-ledger-keeper', schema: CONTROL_SCHEMA, model: MODEL, effort: 'medium' });
  if (!c) { skipped.push(`apply: control inventory for ${instrumentId} returned nothing; run refresh-soc to rebuild it`); continue; }
  noteSession(c);
  controlsAppended += c.controlIds.length;
  if (c.skippedControlIds.length) skipped.push(`apply: ${c.skippedControlIds.length} ${instrumentId} control ids already in the ledger were not re-appended`);
  if (c.notes) log(`controls ${instrumentId}: ${c.notes}`);
}
const haveDrift = confirmed.length || escalated.length;
const dryRunNoControl = dryRun && !(snapshot.ledgerControlIds || []).length;
if (dryRunNoControl && haveDrift) skipped.push(`apply: dry run and the ledger has no control record to cite; ${confirmed.length + escalated.length} evidence-request observation(s) not recorded (a dry run never appends controls)`);
const ledgerWrite = !haveDrift || dryRunNoControl ? null : await agent(`${common('soc-ledger-keeper')}
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
  label: 'ledger write', phase: 'Apply', agentType: 'soc-ledger-keeper', model: MODEL,
  schema: { type: 'object', required: ['observationIds', 'controlIds', 'riskIds', 'sessionId'], properties: { observationIds: STR_LIST, controlIds: STR_LIST, riskIds: STR_LIST, skippedControlIds: STR_LIST, skipped: STR_LIST, sessionId: STR, notes: STR } },
});
if (ledgerWrite) {
  result.observations = ledgerWrite.observationIds.length;
  result.controls = controlsAppended + ledgerWrite.controlIds.length;
  result.risks = ledgerWrite.riskIds.length;
  noteSession(ledgerWrite);
  for (const x of ledgerWrite.skipped || []) skipped.push(`apply ledger: ${x}`);
  if (dryRun && (ledgerWrite.controlIds.length || ledgerWrite.riskIds.length)) log(`WARNING dry run: soc-ledger-keeper reported ${ledgerWrite.controlIds.length} control(s) and ${ledgerWrite.riskIds.length} risk(s) appended despite the read-only dry-run instruction; inspect the ledger tail`);
  if (ledgerWrite.skippedControlIds && ledgerWrite.skippedControlIds.length) skipped.push(`apply: ${ledgerWrite.skippedControlIds.length} control ids already in the ledger were not re-appended`);
} else if (haveDrift && !dryRunNoControl) { result.controls = controlsAppended; skipped.push('apply: soc-ledger-keeper returned nothing; ledger may be partially written — inspect the ledger tail'); }
else if (!haveDrift) log('No confirmed or escalated drift: profile unchanged, no drift observation.');

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
    label: 'patch details.json', phase: 'Apply', agentType: 'validator', model: MODEL,
    schema: { type: 'object', required: ['patchedBranches', 'unpatched', 'validated'], properties: { sessionId: STR, patchedBranches: STR_LIST, unpatched: STR_LIST, validated: { type: 'boolean' }, filesTouched: STR_LIST } },
  });
  if (patch) {
    noteSession(patch);
    result.profilePatched = patch.validated && patch.patchedBranches.length > 0;
    for (const u of patch.unpatched) skipped.push(`patch: ${u}`);
    if (!patch.validated) skipped.push('patch: validator reported validation failure; details.json needs manual review');
  } else skipped.push('patch: validator returned nothing; details.json unchanged');
}

if (dryRun) {
  skipped.push(`dry run: ${CONTEXT} not written by design (${allQuestions.length} question(s), ${openCount} open); details.json patch and summary.md update skipped`);
} else {
  const write = await agent(`${common('validator')}
MATERIALISE mode. Write the organization context document below to ${CONTEXT} EXACTLY as given (JSON, two-space indent, trailing newline), replacing the file if it exists. The workflow composed it from refuted research and it must not be reworded. Set provenance.harness to the harness you run on and provenance.sessionId to ${sessionId ? `'${sessionId}'` : 'your own session id'}; change nothing else. Then run \`node .claude/scripts/validate-data.mjs ${CONTEXT}\` (schema ${CONTEXT_SCHEMA} plus cross-reference checks). If it reports a problem, fix ONLY the minimal offending value (a slug, an enum, an id that must be dropped from a list) and report every fix; never invent a question, an answer or an evidence ref.
Document: ${JSON.stringify(contextDoc)}
Return {written, validated, fixes, sessionId}.`, {
    label: 'write context.json', phase: 'Apply', agentType: 'validator', model: MODEL, effort: 'medium',
    schema: { type: 'object', required: ['written', 'validated', 'fixes'], properties: { sessionId: STR, written: { type: 'boolean' }, validated: { type: 'boolean' }, fixes: STR_LIST, error: STR } },
  });
  if (write) {
    noteSession(write);
    result.context.written = Boolean(write.written && write.validated);
    for (const f of write.fixes || []) skipped.push(`context write: validator fixed ${f}`);
    if (!write.validated) skipped.push(`context write: ${CONTEXT} did not validate${write.error ? `: ${write.error}` : ''}; needs manual review`);
  } else skipped.push(`context write: validator returned nothing; ${CONTEXT} unchanged`);

  const summary = await agent(`${common('report-writer')}
Read .claude/skills/report-templates/SKILL.md. Update ONLY the 'regulatory-posture' and 'organization-context' sections of ${SUMMARY} (create the file from the template if absent) from ${PROFILE}, ${CONTEXT} and the ledger ${LEDGER}: registrations with status and category, frameworks in scope, the drift applied in this run (${confirmed.map((d) => `${d.kind}@${d.branch}`).join(', ') || 'none'}), the ${escalated.length} escalated claim(s) awaiting human resolution, the date of this refresh; and the organization context per the template (business units, licences, obligations, questionnaires with every open question verbatim and its questionId, processes, offerings, segments, platforms). Keep other sections byte-identical. Bump the frontmatter version (major when sections[] gains organization-context, else minor), set provenance as instructed, and recompute provenance.inputsHash exactly as the company-summary frontmatter schema describes. Validate with \`node .claude/scripts/validate-data.mjs ${SUMMARY}\`. Do not append to the ledger: follow report-templates section 5 step 6 and return the report observation as proposedObservation (omit the field when the report was already current).
Return counts.`, {
    label: 'summary regulatory-posture and organization-context', phase: 'Apply', agentType: 'report-writer', model: MODEL, effort: 'low',
    schema: { type: 'object', required: ['updated', 'registrations', 'frameworksInScope'], properties: { sessionId: STR, updated: { type: 'boolean' }, registrations: { type: 'integer' }, frameworksInScope: { type: 'integer' }, version: STR, proposedObservation: { type: 'object', description: 'report-templates section 5 step 6 observation record without id and recordedAt' }, notes: STR } },
  });
  noteSession(summary);
  result.summaryUpdated = Boolean(summary && summary.updated);
  proposedObservation = (summary && summary.proposedObservation) || null;
  if (!summary) skipped.push('summary: report-writer returned nothing; regulatory-posture and organization-context sections not updated');
}

// ---------------------------------------------------------------- Version
phase('Version');
if (dryRun) {
  skipped.push('dry run: soc/version.mjs not run by design (the inconclusive evidence-request observations are versioned by the next live refresh)');
  result.skipped = skipped;
  result.sessionIds = [...sessionIds];
  log(`refresh-ctx dry run done: ${result.observations} evidence-request observations for ${confirmed.length} confirmed and ${escalated.length} escalated drift item(s) (${dropped.length} refuted and dropped); context tree ${allQuestions.length} question(s), ${openCount} open; nothing patched, nothing versioned`);
  return result;
}
const version = await agent(`${common('soc-ledger-keeper')}
${proposedObservation ? `First append the report-writer's proposed observation (report-templates section 5 step 6) via append.mjs: mint id obs_<ULID>, set recordedAt NOW, keep every other field; if its controlIds is empty or names a control that is not in the ledger, use the governance control this run's Apply stage cited or, when none was cited, the most specific in-scope governance control already in the ledger (existing ids: ${JSON.stringify((snapshot.ledgerControlIds || []).slice(0, 40))}). Record: ${JSON.stringify(proposedObservation)}
Then r` : 'R'}un \`node .claude/scripts/soc/version.mjs ${companyId} --session ${sessionId || '<your harness session id>'} --workflow refresh-ctx\` from the workspace root, once. Do not pass --force. Report the observation id you appended (if any), the file version.mjs wrote (empty if it printed that nothing was written) and any error verbatim.`, {
  label: 'version ledger', phase: 'Version', agentType: 'soc-ledger-keeper', model: MODEL, effort: 'low',
  schema: { type: 'object', required: ['versionFile'], properties: { sessionId: STR, reportObservationId: STR, versionFile: STR, error: STR } },
});
noteSession(version);
if (version && version.reportObservationId) result.observations += 1;
else if (proposedObservation) skipped.push('version: report observation not appended (keeper returned no id)');
if (version && version.versionFile) result.versionFile = version.versionFile;
else skipped.push(`version: ${version && version.error ? version.error : 'no version file written (nothing new in the ledger is normal when only context.json changed)'}`);

result.skipped = skipped;
result.sessionIds = [...sessionIds];
log(`refresh-ctx done: ${result.observations} observations, ${result.controls} control records, ${result.risks} risks; profile ${result.profilePatched ? 'patched' : 'unchanged'}; context ${result.context.written ? `written (${result.context.status}, ${openCount} open question(s))` : 'not written'}; ${skipped.length} skipped items`);
return result;
}

const finalResult = await main();
log(`refresh-ctx result: ${finalResult.observations} observations, ${finalResult.controls} controls, ${finalResult.risks} risks, context ${finalResult.context.status} with ${finalResult.context.openQuestions.length} open question(s), ${finalResult.skipped.length} skipped`);
return finalResult;
