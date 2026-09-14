// refresh-vendor-ctx: keep company-profile/<companyId>/vendors/<vendorId>.json truthful and complete.
// Per vendor file: vendor-analyst refresh (assurance expiry, subcontractors, materiality, public incidents) under the
// grounding contract -> refuter (3 lenses, majority; status downgrades and high/critical flags need unanimity) -> write
// (vendor-analyst patches the file, soc-ledger-keeper appends observations and findings) -> report-writer rewrites the
// vendors section -> soc-ledger-keeper appends the report-writer's proposedObservation and runs soc/version.mjs once.
// Verification is batched per vendor (3 lenses, one verdict per item); for an onboarded vendor every grounded
// top-level field and service of the proposed document is a candidate too. New vendors are discovered from IaC,
// environment and metastore references (hosting.provider, secretsBackend, observability, catalogs, CI hosts) and
// created with status 'onboarding'.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
// NOW is resolved once: args.now when given, otherwise the Scout (vendor-analyst, which has `date -u`) reads the clock
// and every later prompt receives that literal, because refuter and report-writer have no clock.
// appIds/envIds narrow the application files scanned for vendor discovery and the assets a flag may cite; existing
// vendor files are always company-wide and are all refreshed. dryRun researches and refutes but writes no vendor
// file; the only ledger writes are observations with result 'inconclusive' that request the missing evidence, and
// only against control records that already exist (a dry run never appends a control).
export const meta = {
  name: 'refresh-vendor-ctx',
  description: 'Refresh vendor files (assurance, subcontractors, materiality, incidents), discover vendors from IaC/env/metastore, refute, write. args: companyId, appIds, envIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Scout', detail: 'Existing vendor files plus vendor references found in env, repo, IaC and metastore files' },
    { title: 'Refresh', detail: 'vendor-analyst re-grounds one vendor per unit and returns the changed fields, flags and ungrounded fields' },
    { title: 'Verify', detail: 'Per vendor, refuter lenses evidence, regulatory-mapping, temporal-validity; majority rule, unanimity for downgrades and high/critical flags' },
    { title: 'Dedup', detail: 'Barrier: one finding per flag fingerprint, concentration flags computed across vendors' },
    { title: 'Write', detail: 'vendor-analyst patches vendor files; soc-ledger-keeper appends observations and findings via soc/append.mjs' },
    { title: 'Summary', detail: 'report-writer rewrites the vendors section of summary.md and proposes its report observation' },
    { title: 'Version', detail: 'soc-ledger-keeper appends the report observation, then soc/version.mjs writes versions/commit_<n>.diff' },
  ],
};

async function main() {
const WORKFLOW = 'refresh-vendor-ctx';
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
const VENDOR_DIR = `company-profile/${companyId}/vendors`;
const METASTORE = `company-profile/${companyId}/sdlc/metastore.json`;
const REFERENCE = '.claude/skills/regulatory-catalogs/references/regulatory-comms-manager-offline-copy.md';
const SLA_TABLE = '.claude/skills/regulatory-catalogs/references/sla-table.json';
const FLAG_KINDS = ['assurance-expiring', 'contract-expiring', 'residency-conflict', 'material-without-evidence', 'critical-without-function', 'fourth-party-unknown', 'concentration', 'public-incident'];
const DOWNGRADE_STATUSES = ['exiting', 'terminated'];

const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };

const common = (agentName) => `Company: ${companyId}. Workflow: ${WORKFLOW}. You are the '${agentName}' specialist.
Read .claude/skills/maxwell-conventions/SKILL.md first.
${now ? `TIME: NOW = '${now}' (resolved once by the workflow; never read a clock or guess a date). Use it for every recordedAt, collectedAt, firstSeenAt, lastSeenAt and provenance.generatedAt, and as "today" for expiry arithmetic.` : 'TIME: NOW is not resolved yet and this stage writes nothing: run `date -u +%Y-%m-%dT%H:%M:%SZ` exactly once and return its output verbatim as "now".'}
PROVENANCE on every record or file you write: harness = the harness you run on ('claude-code' or 'opencode'), generatedAt = NOW, sessionId = ${sessionId || 'your own harness session id'}, ${runId ? `runId = '${runId}'` : 'runId = MAXWELL_RUN_ID when set, otherwise omit runId'}, workflow = '${WORKFLOW}', agent = '${agentName}'.
Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (never open ${LEDGER} for writing); every other file write must pass \`node .claude/scripts/validate-data.mjs <path>\` before you report success. Never write secret values anywhere. Never contact a vendor, log in to a portal or touch a live system; public pages and workspace files only.
${dryRun ? 'DRY RUN: do not write or edit any vendor file; research and report only.' : ''}`;

const APP_LINK_RULE = `APPLICATION-TO-COMPANY RULE (deterministic; no application schema carries companyId, so never infer the link from README prose or hosting.accountRef): when company-profile/ contains exactly one company directory, every applications/<app_id>/ belongs to it; otherwise the company's applications are the union of ${PROFILE} criticalFunctions[].appIds${appIds ? ` and ${JSON.stringify(appIds)} (args.appIds)` : ''}. List every other applications/<app_id>/ under skipped with reason 'no company link'.`;

const GROUNDING = `GROUNDING CONTRACT — non-negotiable:
- Ground every claim in a page you actually fetched or a workspace file you read, and record the URL or path. Vendor's own trust portal, GLEIF and MCA first.
- Never invent an LEI, certificate, contract term, subcontractor or date.
- If you cannot ground it, say so and leave it empty. An empty field with a note is CORRECT.
- Distinguish the GROUP from the ENTITY: the parent's certification is not the contracting entity's unless its scope says so.

BIAS TOWARD NO-OP: the register entry is presumed CORRECT. You are looking for evidence it is WRONG or STALE.
"I could not confirm it" is NOT a change — it is silence, and silence changes nothing (report it under ungrounded).
Report a change only when a source positively contradicts or extends the file.`;

// ---------------------------------------------------------------- Scout
phase('Scout');
const scout = await agent(`${common('vendor-analyst')}
SCOUT (read-only, write nothing). Read ${PROFILE} (criticalFunctions[].functionId, dataResidency, entityTypes, frameworksInScope), every ${VENDOR_DIR}/*.json (the directory may not exist yet: then vendors is empty), ${METASTORE} if present, ${LEDGER} if present, and the application files of this company: applications/<app_id>/README.md, env/*.json, repos/*.json, images/*.json.
${APP_LINK_RULE}${appIds ? ` Of the linked applications keep only ${JSON.stringify(appIds)}; list every other linked application under skipped with reason 'filtered by args.appIds'.` : ''}${envIds ? `; only environment files whose envId is in ${JSON.stringify(envIds)} count, list the others under skipped` : ''}.
Return:
- vendors: one entry per existing vendor file: vendorId, legalName, status, materiality, lastRefreshedAt (provenance.generatedAt), assuranceExpiries (assurance[].type + expiresAt), contractEndDate, hostingCountries (union over services), ultimateParentName, referencedBy (appIds whose env/repo/metastore files name this vendor by hosting.provider, secretsBackend, observability.siem/apm, ciSystem/host, catalog type or README).
- discovered: vendor references with NO file in ${VENDOR_DIR}/: proposedVendorId (slug, e.g. aws, gcp, azure, github, datadog, splunk, hashicorp-vault, databricks, snowflake, openai, anthropic), evidenceRefs (workspace paths where the reference appears), serviceTypeHint (cloud-iaas|cloud-paas|cloud-saas|security-operations|software-development|ai-model-provider|data-analytics|managed-service|other), appIds. A discovered vendor must be named by at least one workspace file; never infer one from a brand guess.
- criticalFunctionIds from details.json, dataResidency, frameworksInScope, existingControlIds (latest kind 'control' ids in the ledger), existingVendorFindingFingerprints ([{fingerprint, findingId, vendorId, ruleId, status}] from the latest record per id of findings whose target.type is 'vendor').${now ? '' : '\n- now: the output of the single `date -u +%Y-%m-%dT%H:%M:%SZ` call.'}
List everything you excluded under skipped so nothing is dropped silently.`, {
  label: 'scout', phase: 'Scout', agentType: 'vendor-analyst', effort: 'low',
  schema: {
    type: 'object',
    required: ['vendors', 'discovered', 'criticalFunctionIds', 'dataResidency', 'frameworksInScope', 'existingControlIds', 'skipped', ...(now ? [] : ['now'])],
    properties: {
      sessionId: { type: 'string' },
      now: { type: 'string', description: 'RFC 3339 UTC timestamp with trailing Z from date -u' },
      vendors: { type: 'array', items: { type: 'object', required: ['vendorId', 'legalName', 'status', 'materiality'], properties: { vendorId: { type: 'string' }, legalName: { type: 'string' }, status: { type: 'string' }, materiality: { type: 'string' }, lastRefreshedAt: { type: 'string' }, assuranceExpiries: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string' }, expiresAt: { type: 'string' } } } }, contractEndDate: { type: 'string' }, hostingCountries: { type: 'array', items: { type: 'string' } }, ultimateParentName: { type: 'string' }, referencedBy: { type: 'array', items: { type: 'string' } } } } },
      discovered: { type: 'array', items: { type: 'object', required: ['proposedVendorId', 'evidenceRefs', 'serviceTypeHint'], properties: { proposedVendorId: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } }, serviceTypeHint: { type: 'string' }, appIds: { type: 'array', items: { type: 'string' } } } } },
      criticalFunctionIds: { type: 'array', items: { type: 'string' } },
      dataResidency: { type: 'array', items: { type: 'string' } },
      frameworksInScope: { type: 'array', items: { type: 'string' } },
      existingControlIds: { type: 'array', items: { type: 'string' } },
      existingVendorFindingFingerprints: { type: 'array', items: { type: 'object', required: ['fingerprint', 'findingId', 'vendorId'], properties: { fingerprint: { type: 'string' }, findingId: { type: 'string' }, vendorId: { type: 'string' }, ruleId: { type: 'string' }, status: { type: 'string' } } } },
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
const existingVendorIds = new Set((scout.vendors || []).map((v) => v.vendorId));
const discovered = (scout.discovered || []).filter((d) => d.proposedVendorId && !existingVendorIds.has(d.proposedVendorId) && (d.evidenceRefs || []).length);
for (const d of (scout.discovered || []).filter((x) => !(x.evidenceRefs || []).length)) skipped.push(`discover: ${d.proposedVendorId} had no workspace evidence and was dropped`);
for (const d of (scout.discovered || []).filter((x) => existingVendorIds.has(x.proposedVendorId))) skipped.push(`discover: ${d.proposedVendorId} already has a vendor file; refreshed as existing instead`);
const units = [
  ...(scout.vendors || []).map((v) => ({ kind: 'existing', vendorId: v.vendorId, subject: v })),
  ...discovered.map((d) => ({ kind: 'discovered', vendorId: d.proposedVendorId, subject: d })),
];
log(`Scout: ${scout.vendors.length} vendor file(s), ${discovered.length} newly referenced vendor(s) to onboard, ${units.length} units`);
if (!units.length) {
  log('Quiet exit: no vendor files and no vendor references found; nothing to refresh.');
  return { companyId, workflow: WORKFLOW, dryRun, targets: [], vendorsCreated: 0, vendorsUpdated: 0, observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, versionFile: '', summaryUpdated: false, skipped, sessionIds: [...sessionIds] };
}

// ---------------------------------------------------------------- Refresh (per unit)
const REG_REF = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const EVIDENCE = { type: 'array', items: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string' }, ref: { type: 'string' }, description: { type: 'string' } } } };
const REFRESH_SCHEMA = {
  type: 'object',
  required: ['vendorId', 'action', 'changes', 'flags', 'ungrounded', 'sources'],
  properties: {
    sessionId: { type: 'string' },
    vendorId: { type: 'string' },
    action: { type: 'string', enum: ['create', 'update', 'unchanged'] },
    status: { type: 'string' },
    materiality: { type: 'string' },
    proposedDocument: { type: 'object', description: 'For create: the full vendor document to write (schema v1/company/vendor.schema.json); for update: omitted' },
    changes: { type: 'array', items: { type: 'object', required: ['path', 'to', 'evidence'], properties: { path: { type: 'string', description: 'JSON pointer into the vendor file, e.g. /assurance/0/expiresAt, /services/0/subcontractors, /materiality, /status' }, from: { type: 'string' }, to: { type: 'string', description: 'JSON-encoded new value' }, evidence: { type: 'string' }, evidenceRef: { type: 'string' } } } },
    flags: { type: 'array', items: { type: 'object', required: ['flag', 'detail', 'severity', 'regulatoryRefs', 'evidence'], properties: { flag: { type: 'string', enum: FLAG_KINDS }, detail: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, regulatoryRefs: { type: 'array', items: REG_REF }, controlIds: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE, serviceId: { type: 'string' } } } },
    documentEvidence: { type: 'array', description: 'For create: one entry per grounded top-level field (legalName, lei, country, website, intraGroup, ultimateParent, materiality) and per service (field services/<index>)', items: { type: 'object', required: ['field', 'evidence'], properties: { field: { type: 'string' }, evidence: { type: 'string' }, evidenceRef: { type: 'string' } } } },
    truncatedFlags: { type: 'integer', description: 'Flags you found but did not return because of the 12-flag cap (0 when none)' },
    ungrounded: { type: 'array', items: { type: 'object', required: ['field', 'note'], properties: { field: { type: 'string' }, note: { type: 'string' } } } },
    sources: { type: 'array', items: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' }, fetchedAt: { type: 'string' } } } },
    notes: { type: 'string' },
  },
};

const refreshPrompt = (u) => `${common('vendor-analyst')}
${GROUNDING}
Read ${REFERENCE} sections 1 and 2 (the same mechanics apply to vendor facts), .claude/skills/reference-architectures/SKILL.md, .claude/schemas/v1/company/vendor.schema.json (the example is the reference shape), ${PROFILE} and the application files that reference this vendor${appIds ? ` (only applications ${JSON.stringify(appIds)})` : ''}.
${u.kind === 'existing' ? `REFRESH existing vendor '${u.vendorId}' (${VENDOR_DIR}/${u.vendorId}.json is your baseline; last refreshed ${u.subject.lastRefreshedAt || 'unknown'}). Re-ground, in this order, and report only positive changes as JSON-pointer changes (do NOT write the file in this stage):
1. Assurance: for each assurance[] entry check the vendor's trust portal / certificate register for a newer report or certificate (SOC 2 Type II: AICPA defines no expiry, so Maxwell's bridge-letter convention sets expiresAt = periodEnd + 12 months; ISO = certificate expiry). Flag 'assurance-expiring' when any expiresAt is within 90 days of NOW or already past.
2. Subcontractors: the vendor's published sub-processor / subcontractor list; add entries (name, country, role) to the affected service; flag 'fourth-party-unknown' when contract.subcontractingAllowed is true and a material service has none.
3. Materiality and criticality: compare services[].criticalFunctionRefs with details.json criticalFunctions and the environments that actually run on this vendor; flag 'critical-without-function' or 'material-without-evidence' (material vendor missing contract, lastAssessment, rightToAudit, exitPlanDocumented or dataReturnAndDeletion).
4. Residency: hostingCountries versus details.json dataResidency ${JSON.stringify(scout.dataResidency)} for services touching pii|spdi|cardholder|financial data -> flag 'residency-conflict'.
5. Contract: flag 'contract-expiring' when contract.endDate is within noticePeriodDays + 90 days of NOW.
6. Public incidents since the last refresh: vendor status pages, CERT-In advisories, regulator orders naming the vendor, public breach disclosures affecting the services the company uses -> flag 'public-incident' (severity from impact on the company's data classes; evidence = the disclosure URL). Never write an incident record yourself.
7. Status: a vendor that no application file references any more is a candidate for 'exiting' (a change on /status) — never terminated by you, never deleted.
Snapshot: ${JSON.stringify(u.subject)}` : `ONBOARD discovered vendor '${u.vendorId}' referenced by ${JSON.stringify(u.subject.evidenceRefs)} (service type hint ${u.subject.serviceTypeHint}, applications ${JSON.stringify(u.subject.appIds || [])}). Build proposedDocument: a complete vendor document with vendorId '${u.vendorId}', legalName = the contracting entity you can ground (the Indian entity when the contract is with an Indian subsidiary, e.g. 'Amazon Web Services India Private Limited' only if a source says so; otherwise the global contracting entity), country, lei from GLEIF when found, intraGroup false unless details.json says otherwise, services[] one per referenced service with type, description naming the applications/environments, criticality and supportsCriticalFunction derived from the environments' tier and details.json criticalFunctions[].appIds (critical => criticalFunctionRefs must be functionIds from ${JSON.stringify(scout.criticalFunctionIds)}), dataAccessed from the environments' dataClassification, hostingCountries from the environments' residency/hosting.region, materiality ('material' when it hosts a critical function or pii/spdi/cardholder/financial data), status 'onboarding' (contract and assessment evidence are not yet on file; the schema requires them only for active/exiting material vendors), regulatoryRefs (Indian outsourcing clause first: rbi-it-outsourcing-md-2023 for RBI entities, sebi-cscrf-2024 GV.SC for SEBI entities, irdai-info-cyber-security-2023 for insurers), tags, provenance. Flag 'material-without-evidence' for every material discovered vendor. Return documentEvidence with one entry per grounded top-level field (legalName, lei, country, website, intraGroup, ultimateParent, materiality) and one per service (field 'services/<index>': the workspace files that show the service, its hostingCountries and its criticalFunctionRefs): refuters verify each of them and any field they refute is stripped (a refuted required field or a service whose critical-function link is not unanimously confirmed blocks or shrinks the create). Omit a field rather than guess it. Do NOT write the file in this stage.`}
Every flag carries severity, regulatoryRefs (most specific Indian instrument first), evidence (workspace-file paths or fetched URLs) and, when the ledger already has the control, controlIds from ${JSON.stringify(scout.existingControlIds)}.
Return at most 12 flags for one vendor (the most severe first) and set truncatedFlags to the number you left out; everything you could not ground goes to ungrounded.`;

// Batched verification per vendor: each lens judges every change, flag and (for an onboarded vendor) every grounded
// field of the proposed document, and answers per key. Majority rule (>= 2 of 3 lenses answered, fewer than 2
// refute) for additive items; unanimity (all 3 answered, none refutes) for status downgrades, materiality changes,
// high/critical flags, an onboarded vendor's 'material' materiality and any service claiming a critical function.
const BATCH_VERDICT = { type: 'object', required: ['verdicts'], properties: { sessionId: { type: 'string' }, verdicts: { type: 'array', items: { type: 'object', required: ['key', 'refuted', 'reason'], properties: { key: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' }, correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, correctedRegulatoryRefs: { type: 'array', items: REG_REF } } } } } };
const LENSES = ['evidence', 'regulatory-mapping', 'temporal-validity'];
const refutePrompt = (u, items, lens, sources) => `${common('refuter')}
${GROUNDING}
Lens '${lens}'. Try to REFUTE each candidate below (proposed vendor-file changes, vendor flags and, for an onboarded vendor, document-field / document-service candidates of the proposed vendor file) for vendor '${u.vendorId}' of ${companyId}; default to refuted=true for any candidate the sources do not show. Read only; never write. NOW = '${now}'.
${lens === 'evidence' ? `evidence: open every workspace-file evidence path and, for a change, the baseline ${VENDOR_DIR}/${u.vendorId}.json (absent for a discovered vendor); the cited file or fetched page must contain the fact (date, country, subcontractor, certificate, disclosure). For a document-field candidate the source must name this exact contracting entity (legal name, LEI as shown on GLEIF, country of the entity, group versus entity); for a document-service candidate the workspace files must show the service, its hostingCountries and, when supportsCriticalFunction is true, that an application in details.json criticalFunctions[].appIds runs on it. Refute when an unfetchable URL is the ONLY evidence for a status downgrade, a materiality change, a 'material' materiality, a critical-function claim or a high/critical flag; for other items an official vendor trust-portal, GLEIF, MCA or regulator page is acceptable.` : ''}${lens === 'regulatory-mapping' ? `regulatory-mapping: every regulatoryRef instrument is in ${JSON.stringify(scout.frameworksInScope)} or applies per .claude/skills/regulatory-catalogs/references/instruments.json, the controlId exists in that instrument's catalog and covers third-party / outsourcing risk, and the Indian instrument comes first; a flag's severity must equal the cited control's catalog defaultSeverity (maxwell-conventions section 4) — when it does not, set correctedSeverity to that defaultSeverity (never to a value of your own choosing) and return correctedRegulatoryRefs when the mapping is repairable instead of refuting. For a document-field 'materiality' candidate check RBI IT Outsourcing MD 2023 materiality (material when it supports a critical function or processes pii/spdi/cardholder/financial data); for document-service candidates, criticalFunctionRefs must be functionIds in details.json.` : ''}${lens === 'temporal-validity' ? `temporal-validity (NOW = '${now}' is the reference date): an expiry flag really falls within 90 days of NOW or is past; a contract flag really falls within noticePeriodDays + 90 days; a public incident happened after the vendor's last refresh (${u.subject.lastRefreshedAt || 'never refreshed'}) and is not already recorded in ${LEDGER}; a change's "from" is the current file value and "to" differs from it; a document-field or document-service fact (legal name, LEI status, hosting countries) is current as of NOW, not a lapsed or renamed entity.` : ''}
Sources the analyst cited: ${JSON.stringify((sources || []).slice(0, 20))}
Return exactly one verdict per candidate keyed by its "key".
Candidates: ${JSON.stringify(items)}`;

const DOC_FIELDS = ['legalName', 'lei', 'country', 'website', 'intraGroup', 'ultimateParent', 'materiality'];
const REQUIRED_DOC_FIELDS = ['legalName', 'country', 'intraGroup', 'materiality'];
const present = (v) => v !== undefined && v !== null && v !== '';

phase('Refresh');
const refreshed = await pipeline(
  units,
  async (u, _item, index) => {
    const r = await agent(refreshPrompt(u), { label: `refresh ${u.vendorId} #${index + 1}`, phase: 'Refresh', agentType: 'vendor-analyst', schema: REFRESH_SCHEMA, effort: 'high' });
    if (!r) { skipped.push(`refresh: vendor ${u.vendorId} returned nothing (agent failed or was skipped)`); return null; }
    noteSession(r);
    for (const g of r.ungrounded || []) skipped.push(`refresh ${u.vendorId}: ungrounded ${g.field} — ${g.note}`);
    log(`${u.vendorId}: ${r.action}, ${(r.changes || []).length} change(s), ${(r.flags || []).length} flag(s), ${(r.ungrounded || []).length} ungrounded`);
    if (r.truncatedFlags > 0) { log(`${u.vendorId}: ${r.truncatedFlags} flag(s) truncated by the 12-flag cap; re-run for this vendor to record them`); skipped.push(`refresh ${u.vendorId}: ${r.truncatedFlags} flag(s) truncated by the 12-flag cap`); }
    return { unit: u, refresh: r };
  },
  async (prev, u, index) => {
    if (!prev) return null;
    const r = prev.refresh;
    const doc = r.action === 'create' && r.proposedDocument && typeof r.proposedDocument === 'object' ? r.proposedDocument : null;
    const docEvidence = (field) => (r.documentEvidence || []).filter((e) => e.field === field).map((e) => ({ evidence: e.evidence, evidenceRef: e.evidenceRef }));
    const docServices = doc && Array.isArray(doc.services) ? doc.services : [];
    const items = [
      ...(r.changes || []).map((c, i) => ({ key: `chg-${i + 1}`, type: 'change', destructive: (c.path === '/status' && DOWNGRADE_STATUSES.some((st) => (c.to || '').includes(st))) || c.path === '/materiality', item: c })),
      ...(r.flags || []).map((f, i) => ({ key: `flg-${i + 1}`, type: 'flag', destructive: f.severity === 'high' || f.severity === 'critical', item: f })),
      ...(doc ? DOC_FIELDS.filter((f) => present(doc[f])).map((f) => ({ key: `doc-${f}`, type: 'document-field', field: f, destructive: f === 'materiality' && doc[f] === 'material', item: { path: `/${f}`, to: JSON.stringify(doc[f]), evidence: docEvidence(f) } })) : []),
      ...docServices.map((svc, i) => ({ key: `doc-services-${i}`, type: 'document-service', index: i, destructive: false, item: { path: `/services/${i}`, to: JSON.stringify({ ...svc, supportsCriticalFunction: undefined, criticalFunctionRefs: undefined }), evidence: docEvidence(`services/${i}`) } })),
      ...docServices.map((svc, i) => (svc && svc.supportsCriticalFunction === true ? { key: `doc-services-${i}-critical`, type: 'document-service', index: i, destructive: true, item: { path: `/services/${i}/criticalFunctionRefs`, to: JSON.stringify({ serviceId: svc.serviceId, criticality: svc.criticality, supportsCriticalFunction: true, criticalFunctionRefs: svc.criticalFunctionRefs || [] }), evidence: docEvidence(`services/${i}`) } } : null)).filter(Boolean),
    ];
    if (!items.length) return { unit: u, refresh: r, action: 'unchanged', changes: [], flags: [], document: null };
    const effort = items.some((x) => x.destructive) ? 'high' : 'medium';
    const votes = await parallel(LENSES.map((lens) => () => agent(refutePrompt(u, items.map((x) => ({ key: x.key, type: x.type, ...x.item })), lens, r.sources), { label: `refute ${u.vendorId} (${items.length}) [${lens}] #${index + 1}`, phase: 'Verify', agentType: 'refuter', schema: BATCH_VERDICT, effort })));
    votes.forEach(noteSession);
    LENSES.forEach((lens, i) => { if (!votes[i]) skipped.push(`verify ${u.vendorId}: lens ${lens} returned nothing; counted as abstention (destructive items cannot pass)`); });
    if (votes.filter((v) => !v).length >= 2) log(`verify ${u.vendorId}: ${votes.filter((v) => !v).length} of ${LENSES.length} lenses returned nothing; no candidate of this vendor can pass — re-run refresh-vendor-ctx`);
    const changes = [];
    const flags = [];
    const passed = new Set();
    for (const x of items) {
      const answers = votes.map((v, i) => { const a = v ? (v.verdicts || []).find((y) => y.key === x.key) : null; return a ? { ...a, lens: LENSES[i] } : null; }).filter(Boolean);
      const refutations = answers.filter((a) => a.refuted);
      const ok = x.destructive ? (answers.length === LENSES.length && refutations.length === 0) : (answers.length >= 2 && refutations.length < 2);
      const what = x.type === 'change' ? `change ${x.item.path}` : x.type === 'flag' ? `flag ${x.item.flag}` : `onboarding field ${x.item.path}`;
      if (!ok) { skipped.push(`verify ${u.vendorId}: ${what} not confirmed (${refutations.length} refuted of ${answers.length} answered): ${refutations.map((a) => `${a.lens}: ${a.reason}`).join(' | ') || 'missing verdicts'}`); continue; }
      passed.add(x.key);
      if (x.type === 'change') { changes.push(x.item); continue; }
      if (x.type !== 'flag') continue;
      const merged = { ...x.item, vendorId: u.vendorId, refuterReasons: answers.map((a) => `${a.lens}: ${a.reason}`) };
      // Severity is never the minimum of the votes: a dispute hands the choice to the ledger keeper, who applies the
      // cited control's catalog defaultSeverity (AGENTS.md section 6, maxwell-conventions section 4).
      const disputed = answers.filter((a) => a.correctedSeverity && a.correctedSeverity !== merged.severity);
      if (disputed.length) merged.severityDisputed = { proposed: merged.severity, corrections: disputed.map((a) => `${a.lens}: ${a.correctedSeverity}`) };
      const corrected = answers.find((a) => a.correctedRegulatoryRefs && a.correctedRegulatoryRefs.length);
      if (corrected) merged.regulatoryRefs = corrected.correctedRegulatoryRefs;
      flags.push(merged);
    }
    // A create survives only with every required field and at least one service confirmed; refuted optional fields
    // are stripped and a service whose critical-function link is not unanimously confirmed is dropped.
    let document = null;
    if (r.action === 'create') {
      if (!doc) skipped.push(`refresh ${u.vendorId}: create proposed without a document; not written`);
      else {
        const failedRequired = REQUIRED_DOC_FIELDS.filter((f) => !passed.has(`doc-${f}`));
        const services = docServices.filter((svc, i) => passed.has(`doc-services-${i}`) && (!(svc && svc.supportsCriticalFunction === true) || passed.has(`doc-services-${i}-critical`)));
        docServices.forEach((svc, i) => { if (!services.includes(svc)) skipped.push(`verify ${u.vendorId}: onboarding service ${(svc && svc.serviceId) || i} dropped from the proposed document (not confirmed${svc && svc.supportsCriticalFunction === true ? '; critical-function link needs unanimity' : ''})`); });
        if (failedRequired.length || !services.length) skipped.push(`refresh ${u.vendorId}: onboarding file not written — ${failedRequired.length ? `required field(s) ${failedRequired.join(', ')} not confirmed` : 'no service confirmed'}; flags are still recorded`);
        else {
          document = { ...doc, vendorId: u.vendorId, status: 'onboarding', services };
          for (const f of DOC_FIELDS) if (!REQUIRED_DOC_FIELDS.includes(f) && present(doc[f]) && !passed.has(`doc-${f}`)) { delete document[f]; skipped.push(`verify ${u.vendorId}: onboarding field ${f} stripped (not confirmed)`); }
        }
      }
    }
    const action = r.action === 'create' ? (document ? 'create' : 'skip') : (changes.length ? 'update' : 'unchanged');
    return { unit: u, refresh: r, action, changes, flags, document };
  },
);

// ---------------------------------------------------------------- Dedup (barrier: cross-vendor concentration + one finding per fingerprint)
phase('Dedup');
const perVendor = refreshed.filter(Boolean);
const parents = new Map();
for (const p of perVendor) {
  const parent = p.unit.kind === 'existing' ? (p.unit.subject.ultimateParentName || '') : '';
  const material = (p.refresh.materiality || p.unit.subject.materiality) === 'material';
  if (parent && material) parents.set(parent, [...(parents.get(parent) || []), p.unit.vendorId]);
}
for (const [parent, ids] of parents) {
  if (ids.length < 2) continue;
  const first = perVendor.find((p) => p.unit.vendorId === ids[0]);
  if (first && !first.flags.some((f) => f.flag === 'concentration')) {
    first.flags.push({ flag: 'concentration', vendorId: ids[0], detail: `Ultimate parent '${parent}' stands behind ${ids.length} material vendors: ${ids.join(', ')}`, severity: 'medium', regulatoryRefs: [], evidence: ids.map((id) => ({ type: 'workspace-file', ref: `${VENDOR_DIR}/${id}.json` })), computed: true });
    log(`concentration: ${parent} behind ${ids.join(', ')} (flag attached to ${ids[0]}; ledger keeper maps the regulatory clause)`);
  }
}
const seenFlagKeys = new Set();
let flagTotal = 0;
for (const p of perVendor) {
  p.flags = p.flags.filter((f) => {
    const key = `vendor-${f.flag}|vendor:${p.unit.vendorId}|${f.serviceId || ''}`; // same shape as the ledger fingerprint input
    if (seenFlagKeys.has(key)) { skipped.push(`dedup: duplicate flag ${f.flag} for ${p.unit.vendorId}${f.serviceId ? `/${f.serviceId}` : ''} merged`); return false; }
    seenFlagKeys.add(key); return true;
  });
  flagTotal += p.flags.length;
}
const toWrite = perVendor.filter((p) => p.action === 'create' || p.action === 'update');
log(`Dedup: ${toWrite.length} vendor file(s) to write, ${flagTotal} flag(s) across ${perVendor.length} vendor(s)`);

const result = { companyId, workflow: WORKFLOW, dryRun, targets: units.map((u) => u.vendorId), vendorsCreated: 0, vendorsUpdated: 0, observations: 0, findings: 0, reseenFindings: 0, risks: 0, initiatives: 0, suggestions: 0, versionFile: '', summaryUpdated: false, skipped, sessionIds: [] };
if (!toWrite.length && !flagTotal) {
  log('Quiet exit: every vendor entry is current and no flag survived; nothing written, no version.');
  result.sessionIds = [...sessionIds];
  return result;
}

// ---------------------------------------------------------------- Write
phase('Write');
if (dryRun) {
  skipped.push(`dry run: ${toWrite.length} vendor file write(s) skipped by design (${toWrite.map((p) => `${p.action} ${p.unit.vendorId}`).join(', ') || 'none'})`);
} else {
  for (const p of toWrite) {
    const w = await agent(`${common('vendor-analyst')}
APPLY verified changes to ${VENDOR_DIR}/${p.unit.vendorId}.json. Read .claude/schemas/v1/company/vendor.schema.json first.
${p.action === 'create' ? `Create the file from this refuter-verified document (2-space JSON, keys in schema order; set provenance as instructed, companyId '${companyId}'). Fields and services absent from it were refuted or ungrounded: do not re-add them:\n${JSON.stringify(p.document)}` : `Edit ONLY these JSON-pointer branches (never delete a vendor, service or assurance entry; a stale assurance stays with its expiresAt; a status change is a mark, not a removal):\n${JSON.stringify(p.changes)}\nThen update provenance (generatedAt NOW, sessionId, runId, workflow, agent).`}
Run \`node .claude/scripts/validate-data.mjs ${VENDOR_DIR}/${p.unit.vendorId}.json\` and fix the content until it passes; if a branch cannot be expressed within the schema, leave it unchanged and list it under unapplied with the reason.`, {
      label: `write ${p.unit.vendorId}`, phase: 'Write', agentType: 'vendor-analyst', effort: 'low',
      schema: { type: 'object', required: ['written', 'validated', 'unapplied'], properties: { sessionId: { type: 'string' }, written: { type: 'boolean' }, validated: { type: 'boolean' }, changedPaths: { type: 'array', items: { type: 'string' } }, unapplied: { type: 'array', items: { type: 'string' } } } },
    });
    if (!w) { skipped.push(`write: vendor-analyst returned nothing for ${p.unit.vendorId}; file may be unchanged`); continue; }
    noteSession(w);
    for (const s of w.unapplied || []) skipped.push(`write ${p.unit.vendorId}: ${s}`);
    if (w.written && w.validated) { p.fileWritten = true; if (p.action === 'create') result.vendorsCreated += 1; else result.vendorsUpdated += 1; }
    else skipped.push(`write ${p.unit.vendorId}: ${w.written ? 'written but validation failed — needs manual review' : 'not written'}`);
  }
}

const ledgerUnits = perVendor.filter((p) => p.flags.length || p.action === 'create' || p.action === 'update');
const existingControlIds = scout.existingControlIds || [];
const WRITE_SCHEMA = { type: 'object', required: ['observationIds', 'findingIds', 'skipped'], properties: { sessionId: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } }, observationIds: { type: 'array', items: { type: 'string' } }, findingIds: { type: 'array', items: { type: 'string' } }, supersededFindingIds: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } } } };
for (const p of ledgerUnits) {
  if (dryRun && !existingControlIds.length) { skipped.push(`ledger ${p.unit.vendorId}: dry run and the ledger has no control record to cite; evidence-request observation not recorded (a dry run never appends controls)`); continue; }
  // Cite the vendor file only when it exists on disk: an existing vendor always has one; an onboarded vendor only
  // when this run's write validated. An update that was not applied is stated in the description.
  const fileEvidence = p.unit.kind === 'existing' || p.fileWritten
    ? `the vendor file ${VENDOR_DIR}/${p.unit.vendorId}.json${p.action === 'update' && !p.fileWritten ? ` (its verified changes were NOT applied this run${dryRun ? ': dry run' : ': write failed'}; say so in the description)` : ''} plus the sources`
    : `the sources only (the onboarding vendor file was not written${dryRun ? ': dry run' : ' or failed validation; say so in the description'})`;
  const knownFindings = (scout.existingVendorFindingFingerprints || []).filter((f) => f.vendorId === p.unit.vendorId);
  const w = await agent(`${common('soc-ledger-keeper')}
Read .claude/skills/soc-ledger/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md, ${SLA_TABLE}, ${PROFILE} and ${LEDGER}. Vendor '${p.unit.vendorId}' (${VENDOR_DIR}/${p.unit.vendorId}.json${p.action === 'create' && !p.fileWritten ? ' — not created in this run' : ''}).
${dryRun
    ? `Step 1 - control (READ-ONLY, dry run): choose the third-party / outsourcing governance control of the most specific Indian instrument in frameworksInScope ${JSON.stringify(scout.frameworksInScope)} ONLY from these control ids that already exist in the ledger: ${JSON.stringify(existingControlIds)}. Append NO control record. If none of them covers third-party / outsourcing risk, append nothing at all for this vendor and return skipped ['no existing third-party governance control in the ledger; dry-run evidence request not recorded'].`
    : `Step 1 - control: the third-party / outsourcing governance control of the most specific Indian instrument in frameworksInScope ${JSON.stringify(scout.frameworksInScope)} (sebi-cscrf-2024 GV.SC.* for SEBI entities, rbi-it-outsourcing-md-2023 for RBI entities, irdai-info-cyber-security-2023 for insurers; add eu-dora-roi-its-2024-2956 mappings only when an EU jurisdiction exists). Existing control ids: ${JSON.stringify(existingControlIds)}. If the ledger lacks that control record, append it first (id '<instrumentId>:<controlId>', frameworkRefs from the catalog, title from the catalog, implementationStatus 'unknown', applicableAssets [{type:'vendor', vendorId:'${p.unit.vendorId}'}]); an instrument without a catalog file cannot be used.`}
Step 2 - observation (exactly one): kind observation, methods ['${WORKFLOW}'], subjects [{type:'vendor', vendorId:'${p.unit.vendorId}'}], controlIds [that control], collectedAt NOW, title '${dryRun ? 'Evidence requested: ' : ''}vendor refresh ${p.unit.vendorId}: ${p.action}', description summarising the ${p.changes.length} applied change(s) and ${p.flags.length} flag(s), evidence = ${fileEvidence} ${JSON.stringify((p.refresh.sources || []).slice(0, 10))}, result ${dryRun ? "'inconclusive' (dry run: state which evidence a human must supply — contract, assurance report, subcontractor list)" : `'not-satisfied' when any flag survived, 'satisfied' otherwise`}.
${dryRun ? 'DRY RUN: write no findings.' : `Step 3 - findings, one per flag below. Fingerprint per soc-ledger SKILL section 6 with ruleId = source.ruleId = 'vendor-<flag>', targetKey 'vendor:${p.unit.vendorId}' and normalisedLocation = the flag's serviceId or empty: fingerprint = sha256('vendor-<flag>|vendor:${p.unit.vendorId}|<serviceId or empty>'), computed with the node -e command shown in that section. Match it ONLY against this list of existing findings for the vendor (latest record per id, from the scout): ${JSON.stringify(knownFindings)}. On a match apply soc-ledger SKILL section 8 rules 1-2: append a supersession (same id, supersedes = id, keep firstSeenAt, lastSeenAt NOW, refreshed evidence and relatedObservationIds; a 'resolved' match reopens to 'open' with statusReason 'regressed in run ${runId || '<runId or sessionId>'}' and resolvedAt removed; false-positive, duplicate and unexpired risk-accepted keep their status) and list it under supersededFindingIds. Otherwise append kind finding, id fnd_<ULID>, title '<flag>: <detail, <=120 chars>', description = detail plus the refuter reasons, severity as given — except when the flag carries severityDisputed, then severity = the catalog defaultSeverity of the most specific control cited (maxwell-conventions section 4; keep the proposed severity only when no catalog control resolves and say so) —, confidence 'likely' (or 'confirmed' when every evidence entry is a workspace file), controlIds [the control from step 1], regulatoryRefs as given (for a 'concentration' flag with empty regulatoryRefs use the step-1 control's frameworkRefs), target {type:'vendor', vendorId:'${p.unit.vendorId}'}, fingerprint, source {kind:'agent-analysis', ruleId:'vendor-<flag>', tool:'vendor-analyst'}, status 'open', slaDueAt and slaBasis from the sla-table (topic from the hardRequirements[].topic of the cited instrument in instruments.json when present, else defaults), relatedObservationIds [the step-2 observation], firstSeenAt = lastSeenAt = NOW, evidence as given. Ignore the helper fields refuterReasons, severityDisputed and computed when building the record.
Flags: ${JSON.stringify(p.flags)}`}
Order: control, observation, findings. Never pass --allow-duplicate-id. After the batch run \`node .claude/scripts/validate-data.mjs ${LEDGER}\`. Return {controlIds, observationIds, findingIds, supersededFindingIds, skipped}.`, {
    label: `ledger ${p.unit.vendorId}`, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'medium',
  });
  if (!w) { skipped.push(`ledger: soc-ledger-keeper returned nothing for ${p.unit.vendorId}; ${p.flags.length} flag(s) not recorded`); continue; }
  noteSession(w);
  result.observations += (w.observationIds || []).length;
  result.findings += (w.findingIds || []).length;
  result.reseenFindings += (w.supersededFindingIds || []).length;
  for (const s of w.skipped || []) skipped.push(`ledger ${p.unit.vendorId}: ${s}`);
}
log(`Write: ${result.vendorsCreated} vendor file(s) created, ${result.vendorsUpdated} updated, ${result.observations} observation(s), ${result.findings} finding(s), ${result.reseenFindings} re-seen`);

// ---------------------------------------------------------------- Summary (before Version, so the report observation is versioned)
phase('Summary');
let proposedObservation = null;
if (dryRun) {
  skipped.push('dry run: summary.md vendors section not updated by design');
} else if (!result.vendorsCreated && !result.vendorsUpdated && !result.findings && !result.reseenFindings) {
  log('No vendor file or finding changed; summary.md left unchanged');
} else {
  const summary = await agent(`${common('report-writer')}
Read .claude/skills/report-templates/SKILL.md. Rewrite ONLY the 'vendors' section of ${SUMMARY} (create the file from the template when absent) from ${VENDOR_DIR}/*.json and the vendor-targeted findings in ${LEDGER}: one row per vendor (legal name, status, materiality, critical functions supported, hosting countries versus data residency, newest assurance and its expiry, open findings by id). Mention this run: ${result.vendorsCreated} onboarded, ${result.vendorsUpdated} updated, ${result.findings} new finding(s), ${result.reseenFindings} re-seen. Keep every other section byte-identical, bump the frontmatter version (minor), set provenance as instructed and recompute provenance.inputsHash exactly as the company-summary schema describes. Validate with \`node .claude/scripts/validate-data.mjs ${SUMMARY}\`. Do not append to the ledger: follow report-templates section 5 step 6 and return the report observation as proposedObservation (omit the field when the report was already current).`, {
    label: 'summary vendors', phase: 'Summary', agentType: 'report-writer', effort: 'low',
    schema: { type: 'object', required: ['updated', 'vendors'], properties: { sessionId: { type: 'string' }, updated: { type: 'boolean' }, vendors: { type: 'integer' }, materialVendors: { type: 'integer' }, version: { type: 'string' }, proposedObservation: { type: 'object', description: 'report-templates section 5 step 6 observation record without id and recordedAt' }, notes: { type: 'string' } } },
  });
  if (summary) { noteSession(summary); result.summaryUpdated = Boolean(summary.updated); proposedObservation = summary.proposedObservation || null; }
  else skipped.push('summary: report-writer returned nothing; vendors section not updated');
}

// ---------------------------------------------------------------- Version (append the report observation, then version once)
phase('Version');
if (dryRun) {
  skipped.push('dry run: soc/version.mjs not run by design (the evidence-request observations are versioned by the next live refresh)');
} else if (!result.observations && !result.findings && !proposedObservation) {
  log('Nothing appended to the ledger; version skipped');
} else {
  const version = await agent(`${common('soc-ledger-keeper')}
${proposedObservation ? `First append the report-writer's proposed observation (report-templates section 5 step 6) via append.mjs: mint id obs_<ULID>, set recordedAt NOW, keep every other field; if its controlIds is empty or names a control that is not in the ledger, use the existing third-party governance control from ${JSON.stringify(existingControlIds)} or the one this run appended. Record: ${JSON.stringify(proposedObservation)}
Then r` : 'R'}un \`node .claude/scripts/soc/version.mjs ${companyId} --session ${sessionId || '<your harness session id>'} --workflow ${WORKFLOW}\` from the workspace root, once. Never pass --force. Return the observation id you appended (if any), the file version.mjs wrote (empty if nothing was written) and any error verbatim.`, {
    label: 'version ledger', phase: 'Version', agentType: 'soc-ledger-keeper', effort: 'low',
    schema: { type: 'object', required: ['versionFile'], properties: { sessionId: { type: 'string' }, reportObservationId: { type: 'string' }, versionFile: { type: 'string' }, error: { type: 'string' } } },
  });
  if (version) { noteSession(version); if (version.reportObservationId) result.observations += 1; }
  else if (proposedObservation) skipped.push('version: soc-ledger-keeper returned nothing; report observation not appended');
  if (version && version.versionFile) result.versionFile = version.versionFile;
  else skipped.push(`version: ${version && version.error ? version.error : 'no version file written'}`);
}

result.skipped = skipped;
result.sessionIds = [...sessionIds];
log(`${WORKFLOW} done: ${result.vendorsCreated} created, ${result.vendorsUpdated} updated, ${result.observations} observations, ${result.findings} findings, version ${result.versionFile || 'none'}, ${skipped.length} skipped items logged`);
return result;
}

const finalResult = await main();
log(`refresh-vendor-ctx result: ${finalResult.vendorsCreated} created, ${finalResult.vendorsUpdated} updated, ${finalResult.findings} findings, ${finalResult.skipped.length} skipped`);
return finalResult;
