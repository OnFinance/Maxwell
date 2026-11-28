// runtime-probe-redteam: one authorised ARTEX autonomous red-team task that validates a company's open findings by
// attempting exploitation, discovers attack paths and proves exploitability, then reconciles the result into Maxwell's
// ledger. ARTEX runs only through node .claude/scripts/artex/run.mjs inside the sandbox; the redteam-orchestrator agent
// gates on the written authorization (CISO/CTO/Compliance-Head/Board-Authorized, unexpired, legal basis) and the
// prerequisites before anything touches a target, artex-reconciler maps the dual-graph exports to attack-path and
// task records plus candidate ledger findings/observations/incidents, the refuter attacks them and soc-ledger-keeper
// appends the survivors. Unlike the read-only runtime probes this workflow may attempt non-destructive exploitation in
// limited-exploitation and full-redteam modes, so authorization and production gating are enforced, not inferred.
//
// args: { companyId (required), appIds?: string[], envIds?: string[] (REQUIRED to touch any prod/dr tier environment,
//         named explicitly and never inferred), mode?: 'reconnaissance-only'|'limited-exploitation'|'full-redteam'
//         (default limited-exploitation), goals?: string[], authorization?: { authorizedBy: {name, email, role},
//         authorizedAt, validUntil, legalBasis }, dryRun?: boolean, now?: RFC 3339 UTC 'Z' string, sessionId?: string,
//         runId?: string, companyCatalogs?: [{instrumentId, file, ...}] }
// Dry run plans only: it asks the orchestrator to validate authorization and build the ARTEX config but starts no
// ARTEX run, writes no artex/ file and appends nothing to the ledger.
// Returns { companyId, workflow, mode, dryRun, now, taskId, artexTaskId, status, authorized, targets, attackPaths,
//           findings, observations, incidents, cisoAlerts, skipped, sessionIds }.
export const meta = {
  name: 'runtime-probe-redteam',
  description: 'Authorised ARTEX autonomous red-team: validates open findings by attempting exploitation, proves attack paths with evidence, maps them to SEBI CSCRF, RBI 2026, CERT-In and DPDP.',
  phases: [
    { title: 'Authorize', detail: 'redteam-orchestrator validates the written authorization (authorizedBy with a CISO/CTO/Compliance-Head/Board-Authorized role, validUntil after the run timestamp, legalBasis reference), confirms production environments are explicitly listed in envIds, and checks prerequisites (ARTEX binary, PostgreSQL, recording proxy, read-only credential references, sandbox egress)' },
    { title: 'Configure', detail: 'redteam-orchestrator turns the in-scope applications, environments and open findings into one ARTEX task config: root and allowed domains, allowed/denied CIDRs, goals, guard rules and the prohibited actions implied by the mode; dry run stops here' },
    { title: 'Execute', detail: 'redteam-orchestrator starts ARTEX only through node .claude/scripts/artex/run.mjs inside the sandbox, watches guard interventions and stops on a scope-violation or service-disruption trigger, then collects the evidence' },
    { title: 'Export', detail: 'redteam-orchestrator writes the dual-graph exports (asset graph, exploration graph, tool executions, guard interventions) and the HAR/screenshot evidence under artex/tasks/<artex_task_id>/ with node .claude/scripts/artex/export-graphs.mjs and hashes every artefact' },
    { title: 'Reconcile', detail: 'artex-reconciler writes the task record and one attack path per proven goal under artex/tasks/<artex_task_id>/, matches existing findings by fingerprint, and returns candidate ledger findings, observations for controls that blocked ARTEX and incidents for authorization or scope violations' },
    { title: 'Refute', detail: 'refuter attacks each candidate through the evidence, regulatory-mapping and exploitability lenses; high and critical findings must survive all three' },
    { title: 'Write', detail: 'soc-ledger-keeper appends the surviving findings, observations and incidents through soc/append.mjs, then writes soc/versions/commit_<n>.diff with soc/version.mjs' },
    { title: 'Summary', detail: 'report-writer refreshes the open-findings section of summary.md with the proven attack paths and exploitability evidence' },
  ],
};

const WORKFLOW = 'runtime-probe-redteam';
const ORCHESTRATOR = 'redteam-orchestrator';
const RECONCILER = 'artex-reconciler';
const REFUTER = 'refuter';
const LEDGER_KEEPER = 'soc-ledger-keeper';
const REPORT_WRITER = 'report-writer';
const ARTEX_RUNNER = 'node .claude/scripts/artex/run.mjs';
const ARTEX_EXPORT = 'node .claude/scripts/artex/export-graphs.mjs';
const VALID_MODES = ['reconnaissance-only', 'limited-exploitation', 'full-redteam'];
const PROD_TIERS = ['prod', 'dr'];
const DEFAULT_MODE = 'limited-exploitation';
const RFC3339Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');

const mode = (args && args.mode) || DEFAULT_MODE;
if (!VALID_MODES.includes(mode)) throw new Error('args.mode must be one of: ' + VALID_MODES.join(', '));

const dryRun = Boolean(args && args.dryRun);
const argNow = args && typeof args.now === 'string' && RFC3339Z.test(args.now.trim()) ? args.now.trim() : null;
const argSessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.length ? args.envIds : null;
const goals = args && Array.isArray(args.goals) && args.goals.length ? args.goals : null;
const authorization = (args && args.authorization) || null;

// Company catalogs (regulatory-catalogs skill section 8): run-headless passes args.companyCatalogs only when
// company-profile/<companyId>/catalogs/ holds the company's own catalogs. Without them every prompt is exactly as before.
const companyCatalogs = (args && Array.isArray(args.companyCatalogs) ? args.companyCatalogs : []).filter((c) => companyId && c
  && /^co:[a-z0-9][a-z0-9-]{1,62}:[a-z0-9][a-z0-9-]{1,62}$/.test(c.instrumentId) && c.instrumentId.indexOf('co:' + companyId + ':') === 0
  && c.file === 'company-profile/' + companyId + '/catalogs/' + c.instrumentId.slice(companyId.length + 4) + '.catalog.json');
const COMPANY_CATALOG_RULE = !companyCatalogs.length ? '' : '\n\nCompany catalogs: besides the shared catalogs, company ' + companyId
  + ' has its own catalogs, which apply to ' + companyId + ' only: ' + companyCatalogs.map((c) => c.instrumentId + ' (' + c.file + ')').join(', ')
  + '. Follow section 8 of .claude/skills/regulatory-catalogs/SKILL.md. Treat each as an instrument in scope for ' + companyId
  + ' (the instruments.json registry, frameworksInScope and the instrument-level entity filters do not apply to it; each control\'s own applicability does): include its controls wherever you select applicable instruments or controls, and key and cite them exactly like shared controls - ledger control id \'<instrumentId>:<controlId>\', regulatoryRef {regulator: the catalog\'s regulator, instrument: the instrumentId, controlId}. Severity comes from the control\'s defaultSeverity; the SLA from its slaDays (slaBasis.instrument = the instrumentId), else the sla-table defaults. Cite the most specific shared instrument first when one covers the gap and the company control after it; a company control comes first only when no shared control covers the gap. These ids are valid for ' + companyId
  + ': never refute or drop a mapping only because it cites one of them. Never cite any other \'co:\' id, and label these controls company-specific wherever you report controls.';
const ask = (prompt, opts) => agent(typeof prompt === 'string' ? prompt + COMPANY_CATALOG_RULE : prompt, opts);

const skipped = [];
const cisoAlerts = [];
const sessionIds = new Set(argSessionId ? [argSessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const skip = (entry) => { skipped.push(entry); log('SKIPPED:', entry.reason); };
const scopeLine = 'Scope: company ' + companyId + ', mode ' + mode
  + (appFilter ? ', appIds ' + appFilter.join(', ') : ', all applications')
  + (envFilter ? ', envIds ' + envFilter.join(', ') : ', no environment filter')
  + (goals ? ', goals ' + goals.join(' | ') : ', goals derived from open findings') + '.';

// A deterministic ARTEX task id derived from the run identity (resume-stable; never Date.now/Math.random).
const idSeed = (runId || argSessionId || argNow || companyId).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
const artexTaskId = 'artex-task-' + (idSeed + 'xxxxxxxx').slice(0, 12);
const taskRecordPath = 'artex/tasks/' + artexTaskId + '/task.json';
const exportDir = 'artex/tasks/' + artexTaskId;

log('Red-team ' + companyId + ' in ' + mode + ' mode' + (dryRun ? ' [dry run]' : '') + '; task ' + artexTaskId);

// ---- Phase 1: Authorize + prerequisites ----------------------------------------------------------------------------
phase('Authorize');
const authResult = await ask(
  [
    'You are the ' + ORCHESTRATOR + ' for the ' + WORKFLOW + ' workflow. ' + scopeLine,
    'Read .claude/skills/artex-redteam/SKILL.md and .claude/skills/runtime-probe-rules-of-engagement/SKILL.md first.',
    argNow ? 'Run timestamp: args.now = ' + argNow + '. Do not read the clock; return runTimestamp = "' + argNow + '".'
      : 'Run timestamp: args.now was not passed. Run `date -u +%Y-%m-%dT%H:%M:%SZ` exactly once and return it verbatim as runTimestamp; it is the single run timestamp for every window and record decision.',
    'Return harness = "claude-code" or "opencode" and sessionId = your harness session id when you know it.',
    'Authorization is non-negotiable. The caller passed authorization = ' + JSON.stringify(authorization) + '.',
    'Validate it: authorizedBy must have name, a valid email and role in [CISO, CTO, Compliance-Head, Board-Authorized]; authorizedAt and validUntil must be RFC 3339 UTC with a trailing Z; validUntil must be after the run timestamp; legalBasis must reference a signed authorization document. full-redteam mode against any prod/dr environment requires role Board-Authorized.',
    'Production gating: a prod or dr tier environment may be touched only when it is named explicitly in args.envIds (' + (envFilter ? envFilter.join(', ') : 'none were passed') + '); never infer one.',
    'Prerequisites (do not start anything, just check and report): the ARTEX binary resolves, PostgreSQL is reachable, the recording proxy is configured, every credential reference in applications/<app_id>/credentials.json for the in-scope environments is read-only (resolve references only, never values), and sandbox egress is limited to the allowed CIDRs/domains.',
    'Return {authorized: boolean, reason: string, runTimestamp, harness, sessionId, prerequisites: {ready: boolean, blockers: string[]}, prodEnvsListed: boolean, productionInScope: boolean}. Set authorized false (never throw) when any check fails, and explain which in reason.',
  ].join('\n'),
  { label: 'authorize', phase: 'Authorize', agentType: ORCHESTRATOR, schema: null, effort: 'high' },
);
noteSession(authResult);

const now = argNow || (authResult && typeof authResult.runTimestamp === 'string' && RFC3339Z.test(authResult.runTimestamp.trim()) ? authResult.runTimestamp.trim() : null);
const authorized = Boolean(authResult && authResult.authorized);
const prereqReady = Boolean(authResult && authResult.prerequisites && authResult.prerequisites.ready);
if (!authorized) skip({ reason: 'authorization not confirmed: ' + ((authResult && authResult.reason) || 'orchestrator returned no verdict') });
else if (!prereqReady) skip({ reason: 'prerequisites not ready: ' + (((authResult.prerequisites || {}).blockers || []).join('; ') || 'unspecified') });
if (!now) skip({ reason: 'no run timestamp (pass args.now for a resume-stable run)' });

// ---- Phase 2: Configure (planning; always runs so the scope is on the record) --------------------------------------
phase('Configure');
const taskConfig = await ask(
  [
    'You are the ' + ORCHESTRATOR + ' configuring the ARTEX task for the ' + WORKFLOW + ' workflow. ' + scopeLine,
    'Build one ARTEX task config from the workspace. Read applications/<app_id>/env/<env_id>.json for each in-scope environment (never open credentials.json ciphertext) and the open findings in company-profile/' + companyId + '/soc/main.jsonl.',
    'Translate: applications and environments -> rootDomains and allowedDomains (from env urls[] only); env network ranges -> allowedCIDRs; third-party and payment ranges -> deniedCIDRs; ' + (goals ? 'the caller goals ' + JSON.stringify(goals) : 'the open findings worth validating') + ' -> goals; mode ' + mode + ' -> the prohibited actions it implies (reconnaissance-only forbids all exploitation; limited-exploitation forbids data-modification, data-deletion, service-disruption and credential-bruteforce; full-redteam keeps only the destructive ones prohibited). Add guard rules requiring human approval for any action beyond the autoApprove safe tools.',
    'This is planning only: do not start ARTEX and write no file. Task id for this run is ' + artexTaskId + '.',
    'Return {config: {goals: string[], rootDomains: string[], allowedDomains: string[], allowedCIDRs: string[], deniedCIDRs: string[], prohibitedActions: object, guard: object}, targets: [{appId, envId, tier}], notes, sessionId}.',
  ].join('\n'),
  { label: 'configure', phase: 'Configure', agentType: ORCHESTRATOR, schema: null, effort: 'high' },
);
noteSession(taskConfig);
const targets = (taskConfig && Array.isArray(taskConfig.targets) ? taskConfig.targets : []).filter((t) => t && t.appId && t.envId);
if (taskConfig && taskConfig.config) log('ARTEX goals: ' + ((taskConfig.config.goals || []).join(' | ') || 'none') + '; allowed domains: ' + ((taskConfig.config.allowedDomains || []).join(', ') || 'none'));

// Decide whether to proceed past planning. Dry run, or any failed gate, stops here with a plan-only result.
const proceed = !dryRun && authorized && prereqReady && Boolean(now) && Boolean(taskConfig && taskConfig.config);
if (!proceed) {
  log(dryRun ? 'dry run: no ARTEX execution, no artex/ file, nothing appended to the ledger' : 'not proceeding past planning: ' + (skipped.map((s) => s.reason).join('; ') || 'no config'));
  return {
    companyId, workflow: WORKFLOW, mode, dryRun, now,
    taskId: null, artexTaskId, status: dryRun ? 'planned' : 'skipped',
    authorized, targets, config: (taskConfig && taskConfig.config) || null,
    attackPaths: [], findings: [], observations: [], incidents: [], cisoAlerts, skipped,
    sessionIds: [...sessionIds],
  };
}

// ---- Phase 3: Execute ----------------------------------------------------------------------------------------------
phase('Execute');
const execResult = await ask(
  [
    'You are the ' + ORCHESTRATOR + ' executing ARTEX for the ' + WORKFLOW + ' workflow, company ' + companyId + ', task ' + artexTaskId + ', mode ' + mode + '.',
    'Start ARTEX ONLY through `' + ARTEX_RUNNER + '` inside the sandbox, with the config you built: ' + JSON.stringify((taskConfig && taskConfig.config) || {}) + '. Never call a scanner, browser, kubectl, aws, curl or openssl directly, and never exceed the allowed domains/CIDRs.',
    'Monitor guard interventions. Stop ARTEX immediately on a scope violation (an action outside the allowed scope), a service-disruption trigger, or when guard blocks exceed the threshold; record each as an incident candidate.',
    'Respect the rules of engagement in .claude/skills/runtime-probe-rules-of-engagement/SKILL.md and the mode\'s prohibited actions. Never attempt a prohibited action even if ARTEX plans one.',
    'Return {status: queued|running|completed|failed|timeout|cancelled, startedAt, completedAt, results: {assetsDiscovered, findingsGenerated, attackPathsProven, guardInterventions}, incidents: [{type, description}], sessionId}.',
  ].join('\n'),
  { label: 'execute', phase: 'Execute', agentType: ORCHESTRATOR, schema: null, effort: 'high' },
);
noteSession(execResult);
const execStatus = (execResult && execResult.status) || 'failed';
log('ARTEX execution: ' + execStatus + '; ' + (((execResult || {}).results || {}).assetsDiscovered || 0) + ' asset(s), ' + (((execResult || {}).results || {}).guardInterventions || 0) + ' guard intervention(s)');
const authViolation = (execResult && Array.isArray(execResult.incidents) ? execResult.incidents : []).find((i) => i && i.type === 'authorization-violation');
if (authViolation) {
  cisoAlerts.push({ kind: 'authorization-violation', message: 'CISO: ARTEX attempted an action outside authorization during ' + WORKFLOW + ' for ' + companyId + '; the run was cancelled. ' + (authViolation.description || '') });
  skip({ reason: 'authorization violation during execution; run cancelled before reconciliation' });
  return {
    companyId, workflow: WORKFLOW, mode, dryRun, now, taskId: null, artexTaskId, status: 'cancelled-authorization-violation',
    authorized, targets, attackPaths: [], findings: [], observations: [], incidents: [], cisoAlerts, skipped, sessionIds: [...sessionIds],
  };
}
if (execStatus === 'failed') skip({ reason: 'ARTEX execution failed; nothing to reconcile' });

// ---- Phase 4: Export -----------------------------------------------------------------------------------------------
phase('Export');
let exportResult = null;
if (execStatus !== 'failed') {
  exportResult = await ask(
    [
      'You are the ' + ORCHESTRATOR + ' exporting ARTEX results for task ' + artexTaskId + '. Run `' + ARTEX_EXPORT + ' --task ' + artexTaskId + ' --output ' + exportDir + '/`.',
      'Collect the dual graphs (asset-graph.json, exploration-graph.json), tool-executions, guard-interventions and the recording-proxy HAR files and screenshots under ' + exportDir + '/. Compute a SHA-256 for every artefact. Write only under ' + exportDir + '/ and create no file elsewhere.',
      'Return {outputDir, artefacts: [{path, sha256}], stats: {assets, goals, executions}, sessionId}.',
    ].join('\n'),
    { label: 'export', phase: 'Export', agentType: ORCHESTRATOR, schema: null, effort: 'medium' },
  );
  noteSession(exportResult);
  if (exportResult) log('exported ARTEX graphs to ' + (exportResult.outputDir || exportDir));
  else skip({ reason: 'graph export returned no result; cannot reconcile without exports' });
}

// ---- Phase 5: Reconcile --------------------------------------------------------------------------------------------
phase('Reconcile');
let reconciliation = null;
if (exportResult) {
  reconciliation = await ask(
    [
      'You are the ' + RECONCILER + ' for the ' + WORKFLOW + ' workflow, company ' + companyId + ', task ' + artexTaskId + '.',
      'Read the exports under ' + exportDir + '/ (asset-graph.json, exploration-graph.json, tool-executions, guard-interventions) and the evidence artefacts. Read .claude/skills/artex-redteam/SKILL.md, .claude/skills/soc-ledger/SKILL.md and .claude/skills/regulatory-catalogs/SKILL.md first.',
      'Write the task record to ' + taskRecordPath + ' (schema v1/artex/task) and one attack path per proven goal to ' + exportDir + '/attack-paths/<path_id>.json (schema v1/artex/attack-path), hashing every artefact you cite. Run `node .claude/scripts/validate-data.mjs <path>` on each file you write and fix what it reports.',
      'Then return CANDIDATE ledger records for soc-ledger-keeper (do not append them yourself): findings (match an existing finding by its fingerprint and reuse it; put the exploitation evidence in evidence[] and tag it artex:exploited, never add schema-less keys), observations for controls that blocked ARTEX, and incidents for authorization or scope violations. Every finding/risk/incident must cite at least one regulatoryRef from an applicable instrument. Escalate severity for a proven exploit per the sla-table.',
      'Run timestamp for records: ' + now + '. Return {taskRecordPath, attackPaths: [{id, path, goal, severity}], findings: [...], observations: [...], incidents: [...], sessionId}.',
    ].join('\n'),
    { label: 'reconcile', phase: 'Reconcile', agentType: RECONCILER, schema: null, effort: 'high' },
  );
  noteSession(reconciliation);
  if (reconciliation) log('reconciled ' + ((reconciliation.attackPaths || []).length) + ' attack path(s), ' + ((reconciliation.findings || []).length) + ' finding candidate(s)');
  else skip({ reason: 'reconciler returned no result; nothing to refute or write' });
}

// ---- Phase 6: Refute -----------------------------------------------------------------------------------------------
phase('Refute');
const candidateFindings = reconciliation && Array.isArray(reconciliation.findings) ? reconciliation.findings : [];
let refutation = null;
if (candidateFindings.length) {
  refutation = await ask(
    [
      'You are the ' + REFUTER + ' for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Attack each candidate finding through the evidence, regulatory-mapping and exploitability lenses, using the attack paths and evidence under ' + exportDir + '/ and the ledger.',
      'A high or critical finding must survive all three lenses to be accepted; default to refuted when the exploitation evidence does not support the claim. Return {accepted: [...the surviving finding records...], rejected: [{title, reason}], sessionId}.',
      'Candidates:\n' + JSON.stringify(candidateFindings, null, 1),
    ].join('\n'),
    { label: 'refute', phase: 'Refute', agentType: REFUTER, schema: null, effort: 'high' },
  );
  noteSession(refutation);
  if (refutation && (refutation.rejected || []).length > candidateFindings.length / 2) {
    cisoAlerts.push({ kind: 'high-rejection-rate', message: 'CISO: over half of the ARTEX findings for ' + companyId + ' failed refutation (' + (refutation.rejected || []).length + '/' + candidateFindings.length + '); human review recommended.' });
  }
}
const acceptedFindings = refutation && Array.isArray(refutation.accepted) ? refutation.accepted : [];
const observations = reconciliation && Array.isArray(reconciliation.observations) ? reconciliation.observations : [];
const incidents = reconciliation && Array.isArray(reconciliation.incidents) ? reconciliation.incidents : [];

// ---- Phase 7: Write ------------------------------------------------------------------------------------------------
phase('Write');
let ledgerWrite = null;
const toWrite = acceptedFindings.length + observations.length + incidents.length;
if (toWrite) {
  ledgerWrite = await ask(
    [
      'You are the ' + LEDGER_KEEPER + ' for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md (sections 2, 6, 7, 8) and .claude/skills/maxwell-conventions/SKILL.md first.',
      'Append EVERY record below to company-profile/' + companyId + '/soc/main.jsonl by piping JSON to `node .claude/scripts/soc/append.mjs ' + companyId + ' -` (append-only; never edit the ledger; never write a scratch file). For a finding whose fingerprint already exists, append a superseding record with the same id instead of minting a new one. Reconcile findings, observations and incidents exactly as the soc-ledger skill describes; mint obs_/fnd_/rsk_/inc_ ULIDs and set provenance {harness, generatedAt: ' + now + ', sessionId, runId: ' + JSON.stringify(runId) + ', workflow: "' + WORKFLOW + '", agent: "' + LEDGER_KEEPER + '"}.',
      'Attack paths and the ARTEX task record are already written as files under ' + exportDir + '/ by the reconciler; do not copy them into the ledger.',
      'Findings:\n' + JSON.stringify(acceptedFindings, null, 1),
      'Observations:\n' + JSON.stringify(observations, null, 1),
      'Incidents:\n' + JSON.stringify(incidents, null, 1),
      'Then run `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/soc/main.jsonl`, fix what it reports by appending corrections, and run `node .claude/scripts/soc/version.mjs ' + companyId + ' --workflow ' + WORKFLOW + '`. Return {findingIds, observationIds, incidentIds, diffPath, skipped, sessionId}.',
    ].join('\n'),
    { label: 'write ledger', phase: 'Write', agentType: LEDGER_KEEPER, schema: null, effort: 'medium' },
  );
  noteSession(ledgerWrite);
  if (ledgerWrite) log('ledger: ' + ((ledgerWrite.findingIds || []).length) + ' finding(s), ' + ((ledgerWrite.observationIds || []).length) + ' observation(s), ' + ((ledgerWrite.incidentIds || []).length) + ' incident(s)');
  else skip({ reason: 'ledger keeper returned no result; accepted records NOT written' });
  for (const inc of (ledgerWrite && ledgerWrite.incidentIds) || []) cisoAlerts.push({ kind: 'incident', message: 'CISO: ' + WORKFLOW + ' recorded incident ' + inc + ' for ' + companyId + '; reporting deadlines may apply.' });
} else {
  log('nothing survived refutation; ledger unchanged');
}

// ---- Phase 8: Summary ----------------------------------------------------------------------------------------------
phase('Summary');
let summary = null;
if (ledgerWrite && ((ledgerWrite.findingIds || []).length || (ledgerWrite.incidentIds || []).length)) {
  summary = await ask(
    [
      'You are the ' + REPORT_WRITER + '. Refresh the "open-findings" section (and "incidents" when this run wrote any) of company-profile/' + companyId + '/summary.md after the ' + WORKFLOW + ' workflow. Read .claude/skills/report-templates/SKILL.md first and keep the [fnd_...]/[inc_...] citation style.',
      'This run proved ' + ((reconciliation && reconciliation.attackPaths) || []).length + ' attack path(s) and recorded ' + ((ledgerWrite.findingIds || []).length) + ' finding(s) ' + JSON.stringify(ledgerWrite.findingIds || []) + ' with exploitation evidence under ' + exportDir + '/. Edit only those sections and the frontmatter (bump version, recompute provenance.inputsHash). Create no other file.',
      'provenance.generatedAt = ' + now + '. Validate with `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/summary.md` and return {updated, sections, openFindings, version, sessionId}.',
    ].join('\n'),
    { label: 'summary', phase: 'Summary', agentType: REPORT_WRITER, schema: null, effort: 'medium' },
  );
  noteSession(summary);
  if (summary) log('summary.md: ' + (summary.openFindings != null ? summary.openFindings + ' open finding(s)' : 'updated') + ', version ' + ((summary && summary.version) || '?'));
  else skip({ reason: 'report-writer returned no result; summary.md may be stale' });
} else {
  log('no findings or incidents written; summary.md left unchanged');
}

if (cisoAlerts.length) log('CISO ALERT: ' + cisoAlerts.map((a) => a.message).join(' | '));
log('done: task ' + artexTaskId + ' status ' + execStatus + '; ' + acceptedFindings.length + ' finding(s) accepted, ' + skipped.length + ' skipped item(s)');

return {
  companyId,
  workflow: WORKFLOW,
  mode,
  dryRun,
  now,
  taskId: artexTaskId,
  artexTaskId,
  status: execStatus,
  authorized,
  targets,
  taskRecordPath: (reconciliation && reconciliation.taskRecordPath) || taskRecordPath,
  attackPaths: (reconciliation && reconciliation.attackPaths) || [],
  findings: (ledgerWrite && ledgerWrite.findingIds) || [],
  observations: (ledgerWrite && ledgerWrite.observationIds) || [],
  incidents: (ledgerWrite && ledgerWrite.incidentIds) || [],
  summaryUpdated: Boolean(summary && summary.updated),
  cisoAlerts,
  skipped,
  sessionIds: [...sessionIds],
};
