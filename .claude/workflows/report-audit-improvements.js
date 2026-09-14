// report-audit-improvements: regenerates the improvements half of company-profile/<companyId>/summary.md: initiative
// status (change_management), suggestion acceptance (suggestions/master.json) and the KPI table built from the
// existing kpis/data/<kpi_id>/series.jsonl with targets from kpis/metrics.json and links to kpis/measurement/<kpi_id>.md.
// Refuters check every number in the rendered markdown against series.jsonl and the masters BEFORE anything is written;
// the approved sections are then written, validated and recorded on the ledger (observation + soc/version.mjs).
// KPIs are NOT recomputed here: no roster agent is allowed to run `npm run kpis` (validator.md forbids it and
// soc-ledger-keeper may only run scripts/soc/*), so /kpis must be run before this report; the run logs that as a skip.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean, now?: RFC3339 'Z' string,
//         sessionId?: string, runId?: string }
// appIds/envIds are logged as ignored: KPIs and indexes are company-wide. dryRun renders and refutes the sections
// without writing summary.md and appends one inconclusive observation.
// Shape: Scout (inputsHash, per-owner currency checks, counters, newest datapoint per (kpiId, series) for the company)
// -> Render (report-writer returns markdown, writes nothing) -> Refute (two refuters: KPI table vs series.jsonl /
// metrics.json; initiatives + suggestions vs masters; up to two repair rounds, still unwritten) -> Write (report-writer
// splices the approved sections, one version bump; skipped when discrepancies remain) -> Validate (validator) ->
// Record (soc-ledger-keeper observation; version.mjs only after a successful write).
export const meta = {
  name: 'report-audit-improvements',
  description: 'Rewrites the initiatives, suggestion-acceptance and KPI sections of summary.md from existing series with methodology links, refutes every number first, then records it.',
  phases: [
    { title: 'Scout', detail: 'inputsHash, per-owner currency checks, initiative and suggestion counters, newest datapoint per KPI series for the company with its trend predecessor' },
    { title: 'Render', detail: 'report-writer renders the initiatives, suggestions and kpis sections from the report-templates skill as markdown without writing' },
    { title: 'Refute', detail: 'Two refuters recount the KPI table against series.jsonl/metrics.json and the initiative and suggestion figures against the masters; report-writer repairs the markdown (max two rounds)' },
    { title: 'Write', detail: 'report-writer writes the approved sections into summary.md with one version bump; nothing is written while discrepancies remain' },
    { title: 'Validate', detail: 'validator checks summary.md frontmatter, that the written sections match the approved text, and the workspace validators' },
    { title: 'Record', detail: 'soc-ledger-keeper appends the report observation and, after a successful write, writes soc/versions/commit_<n>.diff' },
  ],
};

const WORKFLOW = 'report-audit-improvements';
const OWNED_SECTIONS = ['initiatives', 'suggestions', 'kpis'];
const KPI_IDS = ['cost_of_audit', 'cm_actionability', 'cm_coverage', 'cm_time_to_implementation', 'suggestion_acceptance_rate', 'incident_rate'];
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
const CM_MASTER = PROFILE + '/change_management/master.json';
const SUG_MASTER = PROFILE + '/suggestions/master.json';
const TEMPLATES = '.claude/skills/report-templates/SKILL.md';
const SKILL_KPI = '.claude/skills/kpi-extraction/SKILL.md';
const SKILL_CONV = '.claude/skills/maxwell-conventions/SKILL.md';
const SKILL_LEDGER = '.claude/skills/soc-ledger/SKILL.md';

const skipped = [];
const skip = (id, reason) => { skipped.push(id ? { id, reason } : { reason }); log('skipped ' + (id || '-') + ': ' + reason); };
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
if (args && Array.isArray(args.appIds) && args.appIds.length) skip(null, 'appIds ' + JSON.stringify(args.appIds) + ' ignored: KPIs and improvement indexes are company-wide');
if (args && Array.isArray(args.envIds) && args.envIds.length) skip(null, 'envIds ' + JSON.stringify(args.envIds) + ' ignored: KPIs and improvement indexes are company-wide');

const CLOCK_CMD = 'node -e "console.log(new Date(performance.timeOrigin).toISOString().slice(0, 19) + \'Z\')"';
let runNow = now;
const timeRule = () => (runNow
  ? 'generatedAt = ' + runNow + ' (use it for provenance.generatedAt, collectedAt, recordedAt and every overdue/"due in" computation).'
  : 'generatedAt is unknown: take it once from ' + CLOCK_CMD + ' and reuse that single RFC 3339 UTC value with trailing Z.');
const provenanceRule = (agentName) => 'Provenance: harness (claude-code or opencode, whichever you run under), generatedAt, sessionId = '
  + (sessionId || 'your own harness session id') + ', ' + (runId ? 'runId = ' + runId : 'runId = MAXWELL_RUN_ID when set, otherwise omit it')
  + ', workflow = ' + WORKFLOW + ', agent = ' + agentName + ', model = the model id you run as.';

// ---- Output schemas ---------------------------------------------------------------------------------------------
const STR = { type: 'string' };
const STRS = { type: 'array', items: STR };
const INT = { type: 'integer' };
const NUM = { type: 'number' };

const PREVIOUS = { type: 'object', required: ['value', 'computedAt', 'line'], properties: { value: NUM, computedAt: STR, line: INT, methodVersion: STR } };
const DATAPOINT = {
  type: 'object',
  required: ['kpiId', 'series', 'value', 'unit', 'computedAt', 'methodVersion', 'slice', 'line'],
  properties: { kpiId: STR, series: STR, periodStart: STR, periodEnd: STR, value: NUM, unit: STR, sampleSize: INT, numerator: NUM, denominator: NUM, computedAt: STR, methodVersion: STR, dimensions: { type: 'object' }, slice: { type: 'string', enum: ['company', 'all-up'] }, line: INT, tiesAtComputedAt: INT, previous: PREVIOUS },
};

const SCOUT_SCHEMA = {
  type: 'object',
  required: ['now', 'inputsHash', 'adjustedInputsHash', 'currentInputsHash', 'currentWorkflow', 'currentGeneratedAt', 'currentSections', 'newerLedgerLines', 'newerDatapoints', 'lastOwnReportResult', 'initiatives', 'suggestions', 'latestDatapoints', 'skipped'],
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
    newerLedgerLines: INT,
    newerDatapoints: INT,
    lastOwnReportResult: STR,
    initiatives: { type: 'object', required: ['open', 'closed', 'cancelled', 'overdue', 'total'], properties: { open: INT, closed: INT, cancelled: INT, overdue: INT, total: INT, blockedTasks: INT, reprobeRequests: INT } },
    suggestions: { type: 'object', required: ['total', 'byStatus'], properties: { total: INT, byStatus: { type: 'object', additionalProperties: INT } } },
    latestDatapoints: { type: 'array', items: DATAPOINT },
    missingKpis: STRS,
    controlIdsCovered: STRS,
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
    markdown: STR,
    counts: {
      type: 'object',
      properties: { openInitiatives: INT, overdueInitiatives: INT, suggestionsSurfaced: INT, suggestionsAccepted: INT, acceptanceRate: NUM, kpiRows: INT, kpisNotComputed: INT, kpisPastAlert: INT },
    },
    kpisPastAlert: STRS,
    notes: STR,
  },
};

const CHECK_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason', 'discrepancies'],
  properties: {
    sessionId: STR,
    refuted: { type: 'boolean' },
    confidence: NUM,
    lens: STR,
    reason: STR,
    checked: STRS,
    unverifiable: STRS,
    discrepancies: { type: 'array', items: { type: 'object', required: ['section', 'claim', 'expected', 'source'], properties: { section: STR, claim: STR, expected: STR, source: STR } } },
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

// ---- Phase 1: Scout -------------------------------------------------------------------------------------------------
phase('Scout');
const scout = await agent(
  [
    'You are scouting for the ' + WORKFLOW + ' workflow, company ' + companyId + '. READ-ONLY: append nothing and write no file. Compute with node -e over the files, never by eyeballing.',
    'Read ' + TEMPLATES + ' (sections 1, 2, 4, including the quiet-exit rules), ' + SKILL_KPI + ' and ' + SKILL_CONV + '.',
    runNow ? 'now = ' + runNow + '.' : 'Run ' + CLOCK_CMD + ' once and return it as now.',
    'inputsHash: sha256 (node -e with createHash from node:crypto) over the concatenated bytes, in this exact order, of ' + PROFILE + '/details.json, sdlc/policy.json, sdlc/metastore.json (skip when absent), vendors/*.json sorted by file name, soc/main.jsonl, change_management/master.json, change_management/initiatives/*/timeline.json sorted by initiative id, suggestions/master.json (skip absent files).',
    'From the frontmatter of ' + SUMMARY + ' (empty when absent): currentInputsHash (provenance.inputsHash), currentVersion, currentWorkflow (provenance.workflow), currentGeneratedAt (provenance.generatedAt) and currentSections.',
    'Own report observations = ledger lines with kind observation, provenance.workflow "' + WORKFLOW + '", methods containing "' + WORKFLOW + '" and tags containing "report". adjustedInputsHash: the same hash as inputsHash, except that soc/main.jsonl contributes only its lines minus own report observations whose recordedAt >= currentGeneratedAt (this workflow appends its report observation right after writing summary.md); ownReportLinesExcluded = how many were excluded; adjustedInputsHash = inputsHash when currentGeneratedAt is empty. newerLedgerLines: ledger lines with recordedAt later than currentGeneratedAt, not counting own report observations. lastOwnReportResult: result of the newest own report observation without the tag "dry-run" ("" when none).',
    'initiatives: counters from ' + CM_MASTER + ' recomputed from initiatives[] (open, closed, cancelled, overdue = open with dueAt < now, total), blockedTasks (tasks with status blocked under change_management/initiatives/*/tasks/), reprobeRequests (tasks whose verificationMethod.type is re-probe and status is not done). suggestions: total and byStatus from ' + SUG_MASTER + '.',
    'latestDatapoints (report-templates section 4: one row per KPI series): for each kpiId in ' + JSON.stringify(KPI_IDS) + ' read kpis/data/<kpiId>/series.jsonl (when present) and group its lines by series. Per (kpiId, series): the company slice is the lines whose dimensions.companyId equals "' + companyId + '"; only when the company slice is empty, fall back to the all-up lines, i.e. lines with no dimensions.companyId AND no dimensions.runId (never use another company\'s lines or per-run lines of the fallback). From the chosen slice keep the line with the greatest computedAt; when several lines share it (e.g. cost_of_audit raw split per workflow), keep the last of them in file order and return tiesAtComputedAt = how many shared it. Return kpiId, series, periodStart, periodEnd, value, unit, sampleSize, numerator, denominator, computedAt, methodVersion, dimensions, slice ("company" or "all-up"), line (1-based line number) and previous: the newest earlier line (computedAt strictly lower) in the same slice with the same methodVersion and the same dimensions once runId is removed from both {value, computedAt, line, methodVersion}; omit previous when none exists (Trend n/a). missingKpis: kpiIds with no datapoint in either slice for any series.',
    'newerDatapoints: count of lines in the company slice or the all-up slice of any kpis/data/<kpiId>/series.jsonl whose computedAt is later than currentGeneratedAt (all such lines when currentGeneratedAt is empty).',
    'controlIdsCovered: the instrument-qualified ledger control ids (from ' + LEDGER + ') that the initiatives and suggestions cite: for master.json entries map each bare controlId back through its regulatoryRefs instrument to "<instrument>:<controlId>" and keep only ids that exist as control records.',
    'List anything you could not read or compute in skipped with a reason.',
  ].join('\n'),
  { label: 'scout', phase: 'Scout', agentType: 'soc-ledger-keeper', schema: SCOUT_SCHEMA, effort: 'medium' },
);
if (!scout) {
  // run-workflow.mjs --dry-run returns null for every schema agent(): report a planned-only result instead of failing.
  if (dryRun) {
    skip(null, 'dry-run: scout returned no result (runtime dry-run executes no agent); nothing rendered or written');
    return { companyId, workflow: WORKFLOW, dryRun, plannedOnly: true, phases: ['Scout', 'Render', 'Refute', 'Write', 'Validate', 'Record'], reportCurrent: false, targets: OWNED_SECTIONS, observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, kpis: { ran: false, recomputed: false }, skipped, sessionIds: [...sessionIds] };
  }
  throw new Error('Scout returned nothing; cannot build the report');
}
noteSession(scout);
if (!runNow && typeof scout.now === 'string' && /Z$/.test(scout.now)) runNow = scout.now;
for (const s of scout.skipped || []) skip(s.id, 'scout: ' + s.reason);
const latest = scout.latestDatapoints || [];
const missingKpis = scout.missingKpis || [];
skip(null, 'KPI series not recomputed by this workflow: /kpis must be run before this report (no roster agent is granted npm run kpis); rendering from existing kpis/data/<kpi_id>/series.jsonl');
for (const k of missingKpis) skip(k, 'no datapoint for this company or the all-up slice in kpis/data/' + k + '/series.jsonl; row written as "not computed; run /kpis"');
for (const d of latest) if ((d.tiesAtComputedAt || 0) > 1) skip(d.kpiId + '/' + d.series, d.tiesAtComputedAt + ' datapoints share computedAt ' + d.computedAt + '; the last one in file order (line ' + d.line + ') is rendered');
log('inputsHash ' + scout.inputsHash + ' (adjusted ' + scout.adjustedInputsHash + ', report has ' + (scout.currentInputsHash || 'none') + ' by ' + (scout.currentWorkflow || 'nobody') + '); initiatives ' + JSON.stringify(scout.initiatives) + '; suggestions ' + scout.suggestions.total + '; ' + latest.length + ' KPI row(s), missing KPIs: ' + (missingKpis.join(', ') || 'none'));

// Quiet exit per report-templates section 1, decided from the scout's measurements; currency is per owner.
const today = (runNow || scout.now || '').slice(0, 10);
const currency = {
  hashMatches: Boolean(scout.adjustedInputsHash) && scout.adjustedInputsHash === scout.currentInputsHash,
  lastWriterIsThisWorkflow: scout.currentWorkflow === WORKFLOW,
  sectionsPresent: OWNED_SECTIONS.every((x) => (scout.currentSections || []).includes(x)),
  sameUtcDate: Boolean(today) && (scout.currentGeneratedAt || '').slice(0, 10) === today,
  noNewerLedgerLines: scout.newerLedgerLines === 0,
  noNewerDatapoints: scout.newerDatapoints === 0,
  lastRecordSucceeded: scout.lastOwnReportResult === 'not-applicable',
};
const reportCurrent = Object.keys(currency).every((k) => currency[k]);
log('currency ' + JSON.stringify(currency));
if (!dryRun && reportCurrent) {
  log('report current: every quiet-exit condition holds; summary.md not rewritten');
  return { companyId, workflow: WORKFLOW, dryRun, reportCurrent: true, currency, targets: OWNED_SECTIONS, observations: 0, findings: 0, risks: 0, initiatives: scout.initiatives.total, suggestions: scout.suggestions.total, kpis: { ran: false, recomputed: false, rows: latest.length, missing: missingKpis }, skipped, sessionIds: [...sessionIds] };
}

// ---- Phase 2: Render (nothing is written until the refuters pass) -------------------------------------------------------------
phase('Render');
const renderPrompt = (repairs, previousMarkdown) => [
  'You are the report-writer for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + TEMPLATES + ' in full (section 4 is binding), ' + SKILL_KPI + ' and ' + SKILL_CONV + '.',
  'RENDER ONLY: do NOT write ' + SUMMARY + ' or any other file in this step. The workflow writes the sections only after adversarial refuters have checked every number in your markdown.',
  'Sections you own (render these and nothing else): ## Initiatives (counters line, table with overdue rows first, ### Blocked, ### Evidence requests), ## Suggestions (table, acceptance/merge/revert/30-day retention figures computed exactly like kpis/measurement/suggestion_acceptance_rate.md, ### Rejections quoting decisionNote verbatim), ## KPIs (exactly one row per datapoint below, i.e. per KPI series; Sample; Target warn / alert from kpis/metrics.json with values past alert in bold; Trend against the given previous datapoint, or n/a when previous is absent; Method link [<kpiId> v<methodVersion>](../../kpis/measurement/<kpiId>.md); an all-up slice row says so in the Series cell).',
  'Sources: ' + CM_MASTER + ', ' + PROFILE + '/change_management/initiatives/*/{timeline.json,tasks/task_<n>.json}, ' + SUG_MASTER + ', kpis/data/<kpi_id>/series.jsonl, kpis/metrics.json, kpis/measurement/<kpi_id>.md.',
  'Scout figures (your numbers must agree; if you believe one is wrong cite the file and line in notes): initiatives ' + JSON.stringify(scout.initiatives) + ', suggestions ' + JSON.stringify(scout.suggestions) + '.',
  'Newest datapoint per (kpiId, series) to render (never compute, aggregate or estimate a KPI; a KPI listed as missing gets the row "not computed; run /kpis"):\n' + JSON.stringify(latest, null, 1) + '\nMissing: ' + JSON.stringify(missingKpis),
  repairs
    ? 'REPAIR ROUND: refuters found these discrepancies in your previous markdown (below). Fix each in the section named by re-reading the source line, change nothing else, and return the full corrected markdown:\n' + JSON.stringify(repairs, null, 1) + '\nPrevious markdown:\n' + (previousMarkdown || '(empty)')
    : '',
  'Citations per template section 2: [init_...], [sug_...], [fnd_...]; every number reproducible, with a <!-- source: kpis/data/<kpi_id>/series.jsonl line <n> --> comment on each KPI row.',
  'markdown = the complete text of your three sections only, in canonical order, each starting with its canonical "## " heading (no frontmatter, no foreign sections).',
  timeRule(),
  'Return {written: false, sectionsRewritten, markdown, counts {openInitiatives, overdueInitiatives, suggestionsSurfaced, suggestionsAccepted, acceptanceRate, kpiRows, kpisNotComputed, kpisPastAlert}, kpisPastAlert (kpiId/series), notes}.',
].filter(Boolean).join('\n');

let draft = await agent(renderPrompt(null, null), { label: 'render sections', phase: 'Render', agentType: 'report-writer', schema: DRAFT_SCHEMA, effort: 'high' });
if (!draft) throw new Error('report-writer returned nothing; improvements sections not rendered');
noteSession(draft);
if (draft.written) skip(SUMMARY, 'report-writer reported written=true in the render step, which must not write; the Write step will overwrite the owned sections with the refuted text');
log('rendered ' + (draft.sectionsRewritten || []).join(', '));

// ---- Phase 3: Refute (on the unwritten markdown) ----------------------------------------------------------------------------------------
phase('Refute');
const CHECK_SPLIT = [
  { lens: 'correctness', sections: ['kpis'], focus: 'every KPI row against kpis/data/<kpi_id>/series.jsonl: exactly one row per (kpiId, series); the row uses the newest datapoint of the company slice (dimensions.companyId = ' + companyId + ') or, only when that slice is empty, of the all-up slice (no companyId and no runId), never another company or a per-run line of the fallback; value, unit, period, sampleSize (numerator / denominator), methodVersion and the cited line number match that line; Target warn / alert copied from kpis/metrics.json; bold exactly when past alert in the KPI direction; Trend compares only with the newest earlier datapoint of the same slice, same methodVersion and same dimensions ignoring runId, else n/a; the Method link points at an existing kpis/measurement/<kpi_id>.md whose frontmatter methodVersion matches; a KPI with no datapoint says "not computed; run /kpis" and shows no estimate' },
  { lens: 'evidence', sections: ['initiatives', 'suggestions'], focus: 'the initiative counters line and every row against change_management/master.json and the task files (status, priority, changeType, owner, dueAt, overdue days vs generatedAt, done/total/blocked task counts, finding ids, regulatory ref verbatim), the Blocked and Evidence requests lists, every suggestion row against suggestions/master.json (category, severity, status, repo, +/- lines, surfacedAt, decidedBy, PR), the acceptance, merge, revert and retention figures recomputed per kpis/measurement/suggestion_acceptance_rate.md and cross-checked with the suggestion_acceptance_rate series.jsonl, and every quoted decisionNote verbatim' },
];
const checkPrompt = (split, markdown) => [
  'You are an adversarial refuter for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Lens: ' + split.lens + '. Find every number, id, link or quotation in the report sections ' + JSON.stringify(split.sections) + ' that the workspace files do not support. Read-only.',
  'Report text to check (rendered, not yet written to disk; ignore sections outside your lens):\n' + (markdown || '(empty)'),
  timeRule() + ' Focus: ' + split.focus + '. Recount from the files yourself; do not trust the writer or the scout.',
  'Return {refuted (true when discrepancies is non-empty or you could not verify), confidence, lens: "' + split.lens + '", reason, checked, unverifiable, discrepancies: [{section, claim (as written), expected (the value the files support), source (file + line or record id)}]}.',
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

// ---- Phase 4: Write (only the refuted, approved markdown) --------------------------------------------------------------------------------
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
      'Write the APPROVED sections below into ' + SUMMARY + ' (template section 5 steps 2-5): split the existing file on level-2 headings, replace only ' + JSON.stringify(draft.sectionsRewritten || OWNED_SECTIONS) + ' with the approved text EXACTLY as given (no re-rendering, no re-counting, no rewording: adversarial refuters already checked these bytes), keep every foreign section and the title line byte-for-byte, keep canonical order.',
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

// ---- Phase 5: Validate --------------------------------------------------------------------------------------------------------------------
phase('Validate');
let validation = null;
if (!written) {
  log('nothing written: validation of summary.md skipped');
} else {
  validation = await agent(
    [
      'You are the validator for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Run node .claude/scripts/validate-data.mjs ' + SUMMARY + ' (frontmatter against .claude/schemas/v1/frontmatter/company-summary.schema.json and the layout), then npm run validate.',
      'Fix only the CONTENT of the ' + SUMMARY + ' frontmatter when it fails (quoted timestamps, sections[] equal to the level-2 headings in canonical order, semver version, provenance keys incl. inputsHash = ' + scout.inputsHash + '); never edit section bodies, schemas, series.jsonl or other files.',
      'Also compare the sections ' + JSON.stringify(draft.sectionsRewritten || OWNED_SECTIONS) + ' in the file with the approved text below: sectionsMatchApproved = true only when every heading and line is identical; list each differing line under failuresInFile (do not fix it).',
      'Approved sections:\n<<<APPROVED-SECTIONS\n' + (draft.markdown || '') + '\nAPPROVED-SECTIONS>>>',
      'Return {validationGreen (summary.md green), sectionsMatchApproved, failuresInFile, failuresElsewhere (reported, not fixed), fixed, schemaIssues}.',
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

// ---- Phase 6: Record --------------------------------------------------------------------------------------------------------------------------
phase('Record');
const covered = (scout.controlIdsCovered || []).slice(0, 200);
if ((scout.controlIdsCovered || []).length > covered.length) skip(null, 'observation controlIds truncated to 200 of ' + scout.controlIdsCovered.length);
const sectionIds = (draft.sectionsRewritten || OWNED_SECTIONS).join(', ');
let recordInstruction;
if (dryRun) {
  recordInstruction = 'Append one observation: id obs_<ULID>, title "dry-run: ' + WORKFLOW + ' rendered summary.md sections ' + sectionIds + ' without writing", description starting "dry-run:" with the counts ' + JSON.stringify(draft.counts || {}) + ', missing KPIs ' + JSON.stringify(missingKpis) + ' and ' + openDiscrepancies.length + ' unresolved discrepancy(ies), methods ["' + WORKFLOW + '"], subjects [{type: "company"}], collectedAt = generatedAt, result "inconclusive", tags ["report", "kpi", "dry-run"]. Do not run version.mjs.';
} else if (!writtenAndVerified) {
  const why = !approved
    ? openDiscrepancies.length + ' refuter discrepancy(ies) remained after ' + repairRounds + ' repair round(s), so summary.md was left unchanged: ' + JSON.stringify(openDiscrepancies.slice(0, 25))
    : !written ? 'the write step did not write summary.md (' + ((writeResult && writeResult.notes) || 'no result') + ')'
      : 'summary.md was written but did not pass validation or differs from the approved text: ' + JSON.stringify(validation ? validation.failuresInFile || [] : ['validator returned no result']);
  recordInstruction = 'Append one observation: id obs_<ULID>, title "' + WORKFLOW + ' did not regenerate summary.md sections ' + sectionIds + '", description stating that ' + why + ', with the rendered counts ' + JSON.stringify(draft.counts || {}) + ' and missing KPIs ' + JSON.stringify(missingKpis) + ', methods ["' + WORKFLOW + '"], subjects [{type: "company"}], collectedAt = generatedAt, result "inconclusive", tags ["report", "kpi", "unverified"]. Do NOT run version.mjs.';
} else {
  recordInstruction = 'Step 1: compute sha256 of ' + SUMMARY + ' (node -e with createHash from node:crypto) and append one observation: id obs_<ULID>, title "' + WORKFLOW + ' regenerated summary.md sections ' + ((writeResult.sectionsWritten || draft.sectionsRewritten || []).join(', ')) + '", description with the report version ' + (writeResult.version || '') + ', the counts ' + JSON.stringify(draft.counts || {}) + ', KPIs past alert ' + JSON.stringify(draft.kpisPastAlert || []) + ', missing KPIs ' + JSON.stringify(missingKpis) + ', the note that KPI series were rendered as found (not recomputed; /kpis runs separately) and the ' + repairRounds + ' repair round(s) needed before the refuters passed, methods ["' + WORKFLOW + '"], subjects [{type: "company"}], collectedAt = generatedAt, result "not-applicable", evidence [{type: "workspace-file", ref: "' + SUMMARY + '", sha256}], tags ["report", "kpi"]. Step 2: run node .claude/scripts/soc/version.mjs ' + companyId + ' --session ' + (sessionId || '<your session id>') + ' --workflow ' + WORKFLOW + ' and return the versions file it wrote.';
}
const record = await agent(
  [
    'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_LEDGER + ' and ' + SKILL_CONV + '. Append via `node .claude/scripts/soc/append.mjs ' + companyId + ' -` only.',
    'controlIds for the observation: ' + JSON.stringify(covered) + ' filtered to ids that exist as control records. The schema requires at least one; when the list is empty use the ledger control ids cited by the open findings that the initiatives remediate, and when there is still none append nothing and say so in skipped.',
    recordInstruction,
    timeRule(), provenanceRule('soc-ledger-keeper'),
    'Validate with node .claude/scripts/validate-data.mjs ' + LEDGER + '. Return {observationIds, versionFile, skipped}.',
  ].join('\n'),
  { label: 'record report', phase: 'Record', agentType: 'soc-ledger-keeper', schema: RECORD_SCHEMA, effort: 'low' },
);
if (!record) skip(null, 'ledger keeper returned no result; report not recorded on the ledger');
else { noteSession(record); for (const x of record.skipped || []) skip(null, 'record: ' + x); log('recorded ' + (record.observationIds || []).join(', ') + (record.versionFile ? ' and ' + record.versionFile : '')); }

return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  reportCurrent: false,
  currency,
  targets: draft.sectionsRewritten || [],
  observations: record ? (record.observationIds || []).length : 0,
  findings: 0,
  risks: 0,
  initiatives: scout.initiatives.total,
  initiativeCounters: scout.initiatives,
  suggestions: scout.suggestions.total,
  suggestionsByStatus: scout.suggestions.byStatus,
  kpis: { ran: false, recomputed: false, note: '/kpis must be run before this report', rows: latest.length, missing: missingKpis, pastAlert: draft.kpisPastAlert || [] },
  report: { written, verified: writtenAndVerified, version: writeResult ? writeResult.version || null : null, inputsHash: scout.inputsHash, validationGreen: validation ? validation.validationGreen : null, repairRounds, unresolvedDiscrepancies: openDiscrepancies.length, versionFile: record ? record.versionFile || null : null },
  skipped,
  sessionIds: [...sessionIds],
};
