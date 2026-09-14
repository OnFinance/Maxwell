// report-audit-findings: regenerates the findings half of company-profile/<companyId>/summary.md (overview/executive
// summary, regulatory posture, applications, data flows, vendors, control summary with coverage, open findings by
// severity with SLA status, risks, incidents) from the soc ledger, the regulatory catalogs and details.json, has every
// number checked against the ledger by adversarial refuters BEFORE anything is written, writes the approved sections,
// validates the frontmatter and records the report on the ledger (observation + soc/version.mjs).
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean, now?: RFC3339 'Z' string,
//         sessionId?: string, runId?: string }
// The report is company-wide by design: appIds/envIds are not used to narrow it (a regulator-facing posture table
// must not silently omit assets); they are logged as ignored. dryRun renders and refutes the sections but writes
// nothing except one inconclusive observation describing the report that would have been written.
// Shape: Scout (inputsHash, per-owner currency checks for the quiet exit, independent fact sheet computed from the
// ledger) -> Render (report-writer returns markdown, writes nothing) -> Refute (two refuters split by section, every
// number vs the ledger, on the rendered markdown; up to two repair rounds, still unwritten) -> Write (report-writer
// splices the approved sections into summary.md, one version bump; skipped when discrepancies remain) -> Validate
// (validator) -> Record (soc-ledger-keeper observation; version.mjs only after a successful write).
export const meta = {
  name: 'report-audit-findings',
  description: 'Rewrites the findings sections of summary.md (executive summary, regulatory posture, SLA-tracked findings, risks, incidents, coverage) after refuting every number, then records it.',
  phases: [
    { title: 'Scout', detail: 'Compute inputsHash, the per-owner currency checks for the quiet exit and an independent fact sheet of controls, findings with SLA status, risks, incidents and coverage from the ledger' },
    { title: 'Render', detail: 'report-writer renders the report-audit-findings sections from the report-templates skill as markdown without writing' },
    { title: 'Refute', detail: 'Two refuters check every number and citation in the rendered markdown against the ledger, catalogs and details.json; report-writer repairs the markdown (max two rounds)' },
    { title: 'Write', detail: 'report-writer writes the approved sections into summary.md with one version bump; nothing is written while discrepancies remain' },
    { title: 'Validate', detail: 'validator checks summary.md frontmatter, that the written sections match the approved text, and the workspace validators' },
    { title: 'Record', detail: 'soc-ledger-keeper appends the report observation and, after a successful write, writes soc/versions/commit_<n>.diff' },
  ],
};

const WORKFLOW = 'report-audit-findings';
const OWNED_SECTIONS = ['overview', 'regulatory-posture', 'applications', 'data-flows', 'vendors', 'control-summary', 'open-findings', 'risks', 'incidents'];
const MAX_REPAIR_ROUNDS = 2;

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const now = (args && args.now) || null;
const sessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;

const PROFILE = 'company-profile/' + companyId;
const LEDGER = PROFILE + '/soc/main.jsonl';
const SUMMARY = PROFILE + '/summary.md';
const TEMPLATES = '.claude/skills/report-templates/SKILL.md';
const SKILL_CONV = '.claude/skills/maxwell-conventions/SKILL.md';
const SKILL_LEDGER = '.claude/skills/soc-ledger/SKILL.md';
const SKILL_REG = '.claude/skills/regulatory-catalogs/SKILL.md';
const CATALOGS = '.claude/skills/regulatory-catalogs/references/catalogs/';
const SLA_TABLE = '.claude/skills/regulatory-catalogs/references/sla-table.json';
const SOURCES = [PROFILE + '/details.json', PROFILE + '/sdlc/policy.json', PROFILE + '/sdlc/metastore.json (when present)', PROFILE + '/vendors/*.json', LEDGER, PROFILE + '/change_management/master.json', 'applications/<app_id>/{env,repos,images}/*.json', CATALOGS + '*.catalog.json', SLA_TABLE];

const skipped = [];
const skip = (id, reason) => { skipped.push(id ? { id, reason } : { reason }); log('skipped ' + (id || '-') + ': ' + reason); };
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
if (args && Array.isArray(args.appIds) && args.appIds.length) skip(null, 'appIds ' + JSON.stringify(args.appIds) + ' ignored: the findings report is company-wide');
if (args && Array.isArray(args.envIds) && args.envIds.length) skip(null, 'envIds ' + JSON.stringify(args.envIds) + ' ignored: the findings report is company-wide');

const CLOCK_CMD = 'node -e "console.log(new Date(performance.timeOrigin).toISOString().slice(0, 19) + \'Z\')"';
let runNow = now;
const timeRule = () => (runNow
  ? 'generatedAt = ' + runNow + ' (use it for provenance.generatedAt, collectedAt, recordedAt and every "SLA status"/"due in"/"overdue" computation).'
  : 'generatedAt is unknown: take it once from ' + CLOCK_CMD + ' and reuse that single RFC 3339 UTC value with trailing Z.');
const provenanceRule = (agentName) => 'Provenance: harness (claude-code or opencode, whichever you run under), generatedAt, sessionId = '
  + (sessionId || 'your own harness session id') + ', ' + (runId ? 'runId = ' + runId : 'runId = MAXWELL_RUN_ID when set, otherwise omit it')
  + ', workflow = ' + WORKFLOW + ', agent = ' + agentName + ', model = the model id you run as.';

// ---- Output schemas ---------------------------------------------------------------------------------------
const STR = { type: 'string' };
const STRS = { type: 'array', items: STR };
const INT = { type: 'integer' };
const COUNT_MAP = { type: 'object', additionalProperties: { type: 'integer' } };

const FACTS_SCHEMA = {
  type: 'object',
  required: ['now', 'inputsHash', 'adjustedInputsHash', 'currentInputsHash', 'currentWorkflow', 'currentGeneratedAt', 'currentSections', 'applicableSections', 'newerLedgerLines', 'newerApplicationRecords', 'lastOwnReportResult', 'facts', 'skipped'],
  properties: {
    sessionId: STR,
    now: STR,
    inputsHash: STR,
    adjustedInputsHash: STR,
    ownReportLinesExcluded: INT,
    currentInputsHash: STR,
    currentVersion: STR,
    currentWorkflow: STR,
    currentGeneratedAt: STR,
    currentSections: STRS,
    applicableSections: STRS,
    newerLedgerLines: INT,
    newerApplicationRecords: INT,
    lastOwnReportResult: STR,
    facts: {
      type: 'object',
      required: ['instruments', 'findingsBySeverity', 'findingsPastSla', 'openRisks', 'incidentsInPeriod', 'coverage'],
      properties: {
        entityTypes: STRS,
        regulators: STRS,
        periodStart: STR,
        applications: STRS,
        vendorsPresent: { type: 'boolean' },
        metastorePresent: { type: 'boolean' },
        instruments: {
          type: 'array',
          items: {
            type: 'object',
            required: ['instrument', 'controls'],
            properties: { instrument: STR, regulator: STR, applicability: STR, controls: INT, implemented: INT, partial: INT, notImplemented: INT, notTested: INT, openFindings: INT, pastSla: INT, weakestFamily: STR },
          },
        },
        controlsByImplementation: COUNT_MAP,
        controlsByEffectiveness: COUNT_MAP,
        findingsBySeverity: COUNT_MAP,
        findingsPastSla: INT,
        openFindingIds: STRS,
        closedThisPeriodIds: STRS,
        openRisks: INT,
        riskIds: STRS,
        incidentsInPeriod: INT,
        incidentIds: STRS,
        missedRegulatorClocks: { type: 'array', items: { type: 'object', required: ['incidentId', 'regulator'], properties: { incidentId: STR, regulator: STR, deadlineHours: { type: 'number' } } } },
        reportsOnTime: INT,
        coverage: {
          type: 'object',
          required: ['observed', 'applicable'],
          properties: { observed: INT, applicable: INT, percent: { type: 'number' }, inconclusiveControls: INT, inconclusiveObservationIds: STRS, skippedEnvironments: INT },
        },
        controlIdsCovered: STRS,
      },
    },
    skipped: { type: 'array', items: { type: 'object', required: ['reason'], properties: { id: STR, reason: STR } } },
  },
};

const DRAFT_SCHEMA = {
  type: 'object',
  required: ['written', 'sectionsRewritten', 'markdown', 'counts'],
  properties: {
    sessionId: STR,
    written: { type: 'boolean' },
    sectionsRewritten: STRS,
    sectionsOmitted: STRS,
    markdown: STR,
    counts: {
      type: 'object',
      properties: { openFindings: INT, pastSla: INT, openRisks: INT, incidents: INT, controlsAssessed: INT, coveragePercent: { type: 'number' } },
    },
    missedRegulatorClocks: STRS,
    notes: STR,
  },
};

const CHECK_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason', 'discrepancies'],
  properties: {
    sessionId: STR,
    refuted: { type: 'boolean' },
    confidence: { type: 'number' },
    lens: STR,
    reason: STR,
    checked: STRS,
    unverifiable: STRS,
    discrepancies: {
      type: 'array',
      items: { type: 'object', required: ['section', 'claim', 'expected', 'source'], properties: { section: STR, claim: STR, expected: STR, source: STR } },
    },
  },
};

const WRITE_SCHEMA = {
  type: 'object',
  required: ['written', 'sectionsWritten', 'version'],
  properties: { sessionId: STR, written: { type: 'boolean' }, sectionsWritten: STRS, version: STR, inputsHash: STR, notes: STR },
};

const VALIDATE_SCHEMA = {
  type: 'object',
  required: ['validationGreen', 'failuresInFile', 'failuresElsewhere'],
  properties: { sessionId: STR, validationGreen: { type: 'boolean' }, sectionsMatchApproved: { type: 'boolean' }, failuresInFile: STRS, failuresElsewhere: STRS, fixed: STRS, schemaIssues: STRS },
};

const RECORD_SCHEMA = {
  type: 'object',
  required: ['observationIds', 'skipped'],
  properties: { sessionId: STR, observationIds: STRS, versionFile: STR, skipped: STRS },
};

// ---- Phase 1: Scout ---------------------------------------------------------------------------------------------
phase('Scout');
const scout = await agent(
  [
    'You are scouting for the ' + WORKFLOW + ' workflow, company ' + companyId + '. READ-ONLY: append nothing and write no file. You compute the fact sheet the report and its refuters are checked against, so compute with node -e over the files, never by eyeballing.',
    'Read ' + TEMPLATES + ' (sections 1-3, including the quiet-exit rules), ' + SKILL_LEDGER + ' (latest state per id: last record wins, supersession chains) and ' + SKILL_CONV + '.',
    runNow ? 'now = ' + runNow + '.' : 'Run ' + CLOCK_CMD + ' once and return it as now.',
    'inputsHash: sha256 (node -e with createHash from node:crypto) over the concatenated bytes, in this exact order, of ' + PROFILE + '/details.json, sdlc/policy.json, sdlc/metastore.json (skip when absent), vendors/*.json sorted by file name, soc/main.jsonl, change_management/master.json, change_management/initiatives/*/timeline.json sorted by initiative id, suggestions/master.json (skip any absent file).',
    'From the frontmatter of ' + SUMMARY + ' (empty strings / [] when absent): currentInputsHash (provenance.inputsHash), currentVersion, currentWorkflow (provenance.workflow), currentGeneratedAt (provenance.generatedAt) and currentSections.',
    'Own report observations = ledger lines with kind observation, provenance.workflow "' + WORKFLOW + '", methods containing "' + WORKFLOW + '" and tags containing "report". adjustedInputsHash: the same hash as inputsHash, except that soc/main.jsonl contributes only its lines minus own report observations whose recordedAt >= currentGeneratedAt (this workflow appends its report observation right after writing summary.md, so without the exclusion the hash could never match); ownReportLinesExcluded = how many lines were excluded. When currentGeneratedAt is empty, adjustedInputsHash = inputsHash.',
    'newerLedgerLines: ledger lines with recordedAt later than currentGeneratedAt, not counting own report observations (all lines when currentGeneratedAt is empty). newerApplicationRecords: applications/*/env/*.json, images/*.json and repos/*.json files whose provenance.generatedAt is later than currentGeneratedAt. lastOwnReportResult: the result of the newest own report observation without the tag "dry-run" ("" when none). applicableSections: ' + JSON.stringify(OWNED_SECTIONS) + ' minus data-flows when sdlc/metastore.json is absent and minus vendors when vendors/ is empty.',
    'facts (latest state of every record in ' + LEDGER + ', counted as of now): entityTypes and regulators (details.json), periodStart (min firstSeenAt/collectedAt), applications (applications/* dirs referenced by details.json or ledger targets), vendorsPresent, metastorePresent; instruments: one row per instrument in details.json registrations/frameworksInScope plus every instrument prefix of a ledger control id, with applicability, controls, implemented, partial, notImplemented (not-implemented), notTested (effectiveness not-tested or no effectiveness), openFindings (status open|triaged|remediating citing that instrument), pastSla (open with slaDueAt < now), weakestFamily; controlsByImplementation, controlsByEffectiveness; findingsBySeverity (open statuses), findingsPastSla, openFindingIds, closedThisPeriodIds (risk-accepted|false-positive|duplicate); openRisks (open|investigating|mitigating), riskIds; incidentsInPeriod, incidentIds, missedRegulatorClocks (regulatorReportRefs whose deadlineHours elapsed since detectedAt with no submittedAt), reportsOnTime; coverage {observed = applicable controls with at least one observation whose result is not inconclusive, applicable = control records not not-applicable, percent (one decimal), inconclusiveControls, inconclusiveObservationIds, skippedEnvironments (inconclusive observations tagged freeze/window/no-credentials or describing a skipped environment)}; controlIdsCovered = every ledger control id the report will cite (instrument-qualified).',
    'List anything you could not compute (missing file, malformed line) in skipped with a reason.',
  ].join('\n'),
  { label: 'scout facts', phase: 'Scout', agentType: 'soc-ledger-keeper', schema: FACTS_SCHEMA, effort: 'high' },
);
if (!scout) {
  // run-workflow.mjs --dry-run returns null for every schema agent(): report a planned-only result instead of failing.
  if (dryRun) {
    skip(null, 'dry-run: scout returned no result (runtime dry-run executes no agent); nothing rendered or written');
    return { companyId, workflow: WORKFLOW, dryRun, plannedOnly: true, phases: ['Scout', 'Render', 'Refute', 'Write', 'Validate', 'Record'], reportCurrent: false, targets: OWNED_SECTIONS, observations: 0, findings: 0, risks: 0, incidents: 0, initiatives: 0, suggestions: 0, skipped, sessionIds: [...sessionIds] };
  }
  throw new Error('Scout returned nothing; cannot build the report');
}
noteSession(scout);
if (!runNow && typeof scout.now === 'string' && /Z$/.test(scout.now)) runNow = scout.now;
for (const s of scout.skipped || []) skip(s.id, 'scout: ' + s.reason);
const facts = scout.facts || {};

// Quiet exit per report-templates section 1, decided here from the scout's measurements (currency is per owner: a hash
// written by impl-change-management, impl-auto-improvement or report-audit-improvements never makes these sections current).
const today = (runNow || scout.now || '').slice(0, 10);
const currency = {
  hashMatches: Boolean(scout.adjustedInputsHash) && scout.adjustedInputsHash === scout.currentInputsHash,
  lastWriterIsThisWorkflow: scout.currentWorkflow === WORKFLOW,
  sectionsPresent: (scout.applicableSections || OWNED_SECTIONS).every((x) => (scout.currentSections || []).includes(x)),
  sameUtcDate: Boolean(today) && (scout.currentGeneratedAt || '').slice(0, 10) === today,
  noNewerLedgerLines: scout.newerLedgerLines === 0,
  noNewerApplicationRecords: scout.newerApplicationRecords === 0,
  lastRecordSucceeded: scout.lastOwnReportResult === 'not-applicable',
};
const reportCurrent = Object.keys(currency).every((k) => currency[k]);
log('inputsHash ' + scout.inputsHash + ' (adjusted ' + scout.adjustedInputsHash + ', report has ' + (scout.currentInputsHash || 'none') + ' by ' + (scout.currentWorkflow || 'nobody') + '); currency ' + JSON.stringify(currency) + '; ' + JSON.stringify(facts.findingsBySeverity || {}) + ' open findings, ' + (facts.findingsPastSla || 0) + ' past SLA, ' + (facts.openRisks || 0) + ' open risks, ' + (facts.incidentsInPeriod || 0) + ' incidents');
if (reportCurrent && !dryRun) {
  log('report current: every quiet-exit condition holds, summary.md not rewritten');
  return { companyId, workflow: WORKFLOW, dryRun, reportCurrent: true, currency, targets: OWNED_SECTIONS, observations: 0, findings: 0, risks: 0, incidents: 0, initiatives: 0, suggestions: 0, skipped, sessionIds: [...sessionIds] };
}

// ---- Phase 2: Render (nothing is written until the refuters pass) -------------------------------------------------
phase('Render');
const renderPrompt = (repairs, previousMarkdown) => [
  'You are the report-writer for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + TEMPLATES + ' in full, ' + SKILL_CONV + ' and ' + SKILL_REG + ' (catalog titles for first-use citations; if the skill file is absent use ' + CATALOGS + ').',
  'RENDER ONLY: do NOT write ' + SUMMARY + ' or any other file in this step. The workflow writes the sections only after adversarial refuters have checked every number in your markdown.',
  'Sections you own (render these and nothing else): ' + JSON.stringify(OWNED_SECTIONS) + ' - Overview is the executive summary (<= 200 words, three paragraphs per template), Regulatory posture table, Applications, Data flows (omit when sdlc/metastore.json is absent), Vendors (omit when vendors/ is empty), Control summary ending with the Coverage paragraph, Open findings grouped by severity with SLA status plus "### Closed this period", Risks, Incidents (a missed regulator clock is written **MISSED** and repeated in the Overview).',
  'Sources: ' + SOURCES.join(', ') + '.',
  'Independent fact sheet computed from the ledger (your numbers must agree with it; if you believe it is wrong, cite the record ids in notes rather than silently differing):\n' + JSON.stringify(facts, null, 1),
  repairs
    ? 'REPAIR ROUND: refuters found these discrepancies in your previous markdown (below). Fix each one in the section named by re-deriving the number from the source, change nothing else, and return the full corrected markdown:\n' + JSON.stringify(repairs, null, 1) + '\nPrevious markdown:\n' + (previousMarkdown || '(empty)')
    : '',
  'Citation rules (template section 2): [fnd_...]/[obs_...]/[rsk_...]/[inc_...]/[init_...] for records, `<instrumentId>:<controlId>` for controls, "regulator instrument controlId" for regulatory refs; every table number reproducible, with a trailing <!-- source: ... --> comment when not obvious; dates YYYY-MM-DD in prose, RFC 3339 in SLA columns.',
  'markdown = the complete text of your sections only, in canonical order, each starting with its canonical "## " heading (no frontmatter, no title line, no foreign sections).',
  timeRule(),
  'Return {written: false, sectionsRewritten (section ids rendered), sectionsOmitted, markdown, counts {openFindings, pastSla, openRisks, incidents, controlsAssessed, coveragePercent}, missedRegulatorClocks, notes}.',
].filter(Boolean).join('\n');

let draft = await agent(renderPrompt(null, null), { label: 'render sections', phase: 'Render', agentType: 'report-writer', schema: DRAFT_SCHEMA, effort: 'high' });
if (!draft) throw new Error('report-writer returned nothing; summary.md sections not rendered');
noteSession(draft);
if (draft.written) skip(SUMMARY, 'report-writer reported written=true in the render step, which must not write; the Write step will overwrite the owned sections with the refuted text');
log('rendered ' + (draft.sectionsRewritten || []).length + ' section(s)');
for (const s of draft.sectionsOmitted || []) skip(s, 'section omitted by template rule');

// ---- Phase 3: Refute (every number against the ledger, on the unwritten markdown; repair loop) ----------------------------
phase('Refute');
const CHECK_SPLIT = [
  { lens: 'correctness', sections: ['overview', 'regulatory-posture', 'control-summary'], focus: 'controls per instrument by implementationStatus/effectiveness (latest record per control id), open findings and past-SLA counts per instrument, the weakest control family bullets, the coverage paragraph (observed/applicable/percent, inconclusive observation ids, skipped environments) and every headline number and "act this week" citation in the Overview' },
  { lens: 'evidence', sections: ['open-findings', 'risks', 'incidents', 'applications', 'data-flows', 'vendors'], focus: 'every finding row (id exists, latest status open|triaged|remediating, severity group, target, regulatoryRef verbatim from the record, firstSeenAt, slaDueAt, SLA status arithmetic against generatedAt, initiativeId), closed-this-period rows with statusReason, risk rows (likelihood, impact, status, owner, deadline, mitigation initiative), incident rows (clock = deadlineHours, on-time arithmetic, MISSED markers), and application/environment/repo/image facts against applications/<app_id>/ records' },
];
const checkPrompt = (split, markdown) => [
  'You are an adversarial refuter for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Lens: ' + split.lens + '. Your job: find every number, id or citation in the report sections ' + JSON.stringify(split.sections) + ' that the workspace does not support. Read-only.',
  'Report text to check (rendered, not yet written to disk; ignore sections outside your lens):\n' + (markdown || '(empty)'),
  'Check against ' + LEDGER + ' (latest state per id), ' + PROFILE + '/details.json, applications/, ' + CATALOGS + ' and ' + SLA_TABLE + '. ' + timeRule() + ' Focus: ' + split.focus + '. Do NOT trust the fact sheet the writer used; recount from the files.',
  'Also refute a citation to an id that does not exist, a regulatoryRef paraphrased instead of copied, and any adjective or claim not backed by a number.',
  'Return {refuted (true when discrepancies is non-empty or you could not verify), confidence, lens: "' + split.lens + '", reason, checked (what you recounted), unverifiable, discrepancies: [{section, claim (as written), expected (the value the files support), source (file + record ids)}]}.',
].join('\n');

let openDiscrepancies = [];
let repairRounds = 0;
for (let round = 0; round <= MAX_REPAIR_ROUNDS; round += 1) {
  const verdicts = await parallel(CHECK_SPLIT.map((split) => () =>
    agent(checkPrompt(split, draft.markdown), { label: 'check ' + split.lens + ' round ' + (round + 1), phase: 'Refute', agentType: 'refuter', schema: CHECK_SCHEMA, effort: 'high' })));
  openDiscrepancies = [];
  verdicts.forEach((v, i) => {
    if (!v) { openDiscrepancies.push({ section: CHECK_SPLIT[i].sections.join(','), claim: 'unchecked', expected: 'a verdict', source: 'refuter returned no result' }); return; }
    noteSession(v);
    for (const d of v.discrepancies || []) openDiscrepancies.push(d);
    if (v.refuted && !(v.discrepancies || []).length) openDiscrepancies.push({ section: CHECK_SPLIT[i].sections.join(','), claim: 'unverified', expected: 'verifiable figures', source: v.reason });
  });
  log('round ' + (round + 1) + ': ' + openDiscrepancies.length + ' discrepancy(ies)');
  if (!openDiscrepancies.length || round === MAX_REPAIR_ROUNDS) break;
  const repaired = await agent(renderPrompt(openDiscrepancies, draft.markdown), { label: 'repair round ' + (round + 1), phase: 'Refute', agentType: 'report-writer', schema: DRAFT_SCHEMA, effort: 'high' });
  if (!repaired) { skip(null, 'report-writer returned nothing in repair round ' + (round + 1)); break; }
  noteSession(repaired);
  repairRounds += 1;
  draft = { ...repaired, written: false };
}
for (const d of openDiscrepancies) skip(d.section, 'unresolved discrepancy after ' + repairRounds + ' repair round(s): "' + d.claim + '" expected "' + d.expected + '" (' + d.source + ')');
const approved = !openDiscrepancies.length;

// ---- Phase 4: Write (only the refuted, approved markdown) --------------------------------------------------------------------
phase('Write');
let writeResult = null;
if (dryRun) {
  log('dry-run: summary.md not written');
} else if (!approved) {
  log('refuters left ' + openDiscrepancies.length + ' discrepancy(ies): summary.md left unchanged');
} else {
  writeResult = await agent(
    [
      'You are the report-writer for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + TEMPLATES + ' sections 1 and 5 first.',
      'Write the APPROVED sections below into ' + SUMMARY + ' (template section 5 steps 2-5): split the existing file on level-2 headings, replace only the sections ' + JSON.stringify(draft.sectionsRewritten || []) + ' with the approved text EXACTLY as given (no re-rendering, no re-counting, no rewording: adversarial refuters already checked these bytes), remove an owned section that the approved text omits by template rule, keep every foreign section and the title line byte-for-byte, keep canonical order.',
      'Frontmatter, updated once: version minor bump from the current file (major when sections[] changes; 1.0.0 for a new file), sections[] exactly the headings present in document order, provenance with workflow ' + WORKFLOW + ', agent report-writer, generatedAt and inputsHash = ' + scout.inputsHash + ' (computed before this write; do not recompute it).',
      'Run node .claude/scripts/validate-data.mjs ' + SUMMARY + '. Do not append to the ledger and write no other file.',
      'Approved sections (between the markers, markers excluded):\n<<<APPROVED-SECTIONS\n' + (draft.markdown || '') + '\nAPPROVED-SECTIONS>>>',
      timeRule(), provenanceRule('report-writer'),
      'Return {written, sectionsWritten, version, inputsHash, notes}.',
    ].join('\n'),
    { label: 'write sections', phase: 'Write', agentType: 'report-writer', schema: WRITE_SCHEMA, effort: 'medium' },
  );
  if (!writeResult) skip(SUMMARY, 'report-writer returned nothing in the write step; summary.md state unknown');
  else { noteSession(writeResult); log('summary.md ' + (writeResult.written ? 'written, version ' + writeResult.version : 'NOT written: ' + (writeResult.notes || 'no reason'))); }
}
const written = Boolean(writeResult && writeResult.written);

// ---- Phase 5: Validate -----------------------------------------------------------------------------------------------------
phase('Validate');
let validation = null;
if (!written) {
  log('nothing written: validation of summary.md skipped');
} else {
  validation = await agent(
    [
      'You are the validator for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Run node .claude/scripts/validate-data.mjs ' + SUMMARY + ' (frontmatter against .claude/schemas/v1/frontmatter/company-summary.schema.json and the layout), then npm run validate.',
      'Fix only the CONTENT of ' + SUMMARY + ' frontmatter when it fails (quoting of timestamps, sections[] matching the level-2 headings in canonical order, semver version, provenance keys incl. inputsHash = ' + scout.inputsHash + '); never edit section bodies, schemas or other files.',
      'Also compare the sections ' + JSON.stringify(draft.sectionsRewritten || []) + ' in the file with the approved text below: sectionsMatchApproved = true only when every heading and line is identical; list each differing line under failuresInFile (do not fix it).',
      'Approved sections:\n<<<APPROVED-SECTIONS\n' + (draft.markdown || '') + '\nAPPROVED-SECTIONS>>>',
      'Return {validationGreen (summary.md green), sectionsMatchApproved, failuresInFile, failuresElsewhere (failures in other files, reported not fixed), fixed, schemaIssues}.',
    ].join('\n'),
    { label: 'validate summary', phase: 'Validate', agentType: 'validator', schema: VALIDATE_SCHEMA, effort: 'low' },
  );
  if (!validation) skip(null, 'validator returned no result; summary.md frontmatter unverified');
  else {
    noteSession(validation);
    for (const f of validation.failuresElsewhere || []) skip(null, 'validation failure outside summary.md (not fixed here): ' + f);
    for (const f of validation.schemaIssues || []) skip(null, 'schema issue: ' + f);
    if (!validation.validationGreen || validation.sectionsMatchApproved === false) for (const f of validation.failuresInFile || []) skip(SUMMARY, 'validation failure: ' + f);
    log('validation ' + (validation.validationGreen ? 'green' : 'NOT green') + (validation.sectionsMatchApproved === false ? ', written sections differ from the approved text' : ''));
  }
}
const writtenAndVerified = written && Boolean(validation && validation.validationGreen && validation.sectionsMatchApproved !== false);

// ---- Phase 6: Record ------------------------------------------------------------------------------------------------------------
phase('Record');
const covered = (facts.controlIdsCovered || []).slice(0, 200);
if ((facts.controlIdsCovered || []).length > covered.length) skip(null, 'observation controlIds truncated to 200 of ' + facts.controlIdsCovered.length + ' covered controls');
const sectionIds = (draft.sectionsRewritten || []).join(', ');
const controlRule = 'controlIds = ' + JSON.stringify(covered) + ' filtered to ids that exist as control records (at least one; if none exists append nothing and say so)';
let recordInstruction;
if (dryRun) {
  recordInstruction = 'Append one observation: id obs_<ULID>, ' + controlRule + ', title "dry-run: ' + WORKFLOW + ' rendered summary.md sections ' + sectionIds + ' without writing", description starting "dry-run:" with the headline counts ' + JSON.stringify(draft.counts || {}) + ' and ' + openDiscrepancies.length + ' unresolved discrepancy(ies), methods ["' + WORKFLOW + '"], subjects [{type: "company"}], collectedAt = generatedAt, result "inconclusive", tags ["report", "dry-run"]. Do not run version.mjs.';
} else if (!writtenAndVerified) {
  const why = !approved
    ? openDiscrepancies.length + ' refuter discrepancy(ies) remained after ' + repairRounds + ' repair round(s), so summary.md was left unchanged: ' + JSON.stringify(openDiscrepancies.slice(0, 25))
    : !written ? 'the write step did not write summary.md (' + ((writeResult && writeResult.notes) || 'no result') + ')'
      : 'summary.md was written but did not pass validation or differs from the approved text: ' + JSON.stringify(validation ? validation.failuresInFile || [] : ['validator returned no result']);
  recordInstruction = 'Append one observation: id obs_<ULID>, ' + controlRule + ', title "' + WORKFLOW + ' did not regenerate summary.md sections ' + sectionIds + '", description stating that ' + why + ', with the rendered headline counts ' + JSON.stringify(draft.counts || {}) + ', methods ["' + WORKFLOW + '"], subjects [{type: "company"}], collectedAt = generatedAt, result "inconclusive", tags ["report", "unverified"]. Do NOT run version.mjs.';
} else {
  recordInstruction = 'Step 1: compute sha256 of ' + SUMMARY + ' (node -e with createHash from node:crypto) and append one observation: id obs_<ULID>, ' + controlRule + ', title "' + WORKFLOW + ' regenerated summary.md sections ' + ((writeResult.sectionsWritten || draft.sectionsRewritten || []).join(', ')) + '", description with the report version ' + (writeResult.version || '') + ', the headline counts ' + JSON.stringify(draft.counts || {}) + ', missed regulator clocks ' + JSON.stringify(draft.missedRegulatorClocks || []) + ' and the ' + repairRounds + ' repair round(s) needed before the refuters passed, methods ["' + WORKFLOW + '"], subjects [{type: "company"}], collectedAt = generatedAt, result "not-applicable", evidence [{type: "workspace-file", ref: "' + SUMMARY + '", sha256}], tags ["report"]. Step 2: run node .claude/scripts/soc/version.mjs ' + companyId + ' --session ' + (sessionId || '<your session id>') + ' --workflow ' + WORKFLOW + ' and return the versions file it wrote.';
}
const record = await agent(
  [
    'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_LEDGER + ' and ' + SKILL_CONV + '. Append via `node .claude/scripts/soc/append.mjs ' + companyId + ' -` only.',
    recordInstruction,
    timeRule(), provenanceRule('soc-ledger-keeper'),
    'Validate with node .claude/scripts/validate-data.mjs ' + LEDGER + '. Return {observationIds, versionFile, skipped}.',
  ].join('\n'),
  { label: 'record report', phase: 'Record', agentType: 'soc-ledger-keeper', schema: RECORD_SCHEMA, effort: 'low' },
);
if (!record) skip(null, 'ledger keeper returned no result; report not recorded on the ledger');
else { noteSession(record); for (const x of record.skipped || []) skip(null, 'record: ' + x); log('recorded ' + (record.observationIds || []).join(', ') + (record.versionFile ? ' and ' + record.versionFile : '')); }

const sev = facts.findingsBySeverity || {};
return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  reportCurrent: false,
  currency,
  targets: draft.sectionsRewritten || [],
  observations: record ? (record.observationIds || []).length : 0,
  findings: Object.keys(sev).reduce((n, k) => n + (sev[k] || 0), 0),
  findingsPastSla: facts.findingsPastSla || 0,
  risks: facts.openRisks || 0,
  incidents: facts.incidentsInPeriod || 0,
  missedRegulatorClocks: draft.missedRegulatorClocks || [],
  coverage: facts.coverage || null,
  initiatives: 0,
  suggestions: 0,
  report: { written, verified: writtenAndVerified, version: writeResult ? writeResult.version || null : null, inputsHash: scout.inputsHash, validationGreen: validation ? validation.validationGreen : null, repairRounds, unresolvedDiscrepancies: openDiscrepancies.length, versionFile: record ? record.versionFile || null : null },
  skipped,
  sessionIds: [...sessionIds],
};
