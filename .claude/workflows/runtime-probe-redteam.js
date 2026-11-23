// runtime-probe-redteam: Autonomous red-team assessment using ARTEX to validate Maxwell findings and discover attack paths.
// ARTEX runs independently with its dual-graph planner/worker architecture, then artex-reconciler maps results to Maxwell's ledger.
// CRITICAL: Requires explicit written authorization from CISO/CTO/Board. Production environments must be explicitly listed.
// Scout: authorization check + ARTEX prerequisites. Probe: spawn ARTEX in sandbox with configured scope. Reconcile: map ARTEX 
// findings → Maxwell ledger with regulatory citations. Refute: validate exploitability claims. Write: append attack paths + findings.
//
// args: { companyId (required), appIds?: string[], envIds?: string[] (REQUIRED for prod/dr tiers), mode?: string 
//         (reconnaissance-only|limited-exploitation|full-redteam, default: limited-exploitation), goals?: string[],
//         authorization: { authorizedBy: {name, email, role}, authorizedAt, validUntil, legalBasis },
//         dryRun?: boolean, now?: RFC 3339 UTC, sessionId?: string, runId?: string }
//
// Returns { companyId, workflow, taskId, status, authorization, results: { attackPathsProven, findingsValidated, ... }, ... }

export const meta = {
  name: 'runtime-probe-redteam',
  description: 'Autonomous red-team assessment using ARTEX: validates Maxwell findings through actual exploitation attempts, discovers attack paths, proves exploitability with evidence chains. Requires explicit authorization.',
  phases: [
    { title: 'Authorize', detail: 'redteam-orchestrator validates authorization document (authorizedBy with CISO/CTO/Board role, validUntil after now, legalBasis reference), checks scope matches authorization exactly, confirms production environments explicitly listed' },
    { title: 'Prerequisites', detail: 'Check ARTEX binary available, PostgreSQL ready, recording proxy configured, credentials resolved and read-only confirmed, sandbox egress limited to allowed CIDRs/domains' },
    { title: 'Configure', detail: 'Build ARTEX task config from Maxwell context: translate applications/environments → root domains, allowedDomains from env urls[], open findings → goals, mode → prohibited actions, guard rules for human approval' },
    { title: 'Execute', detail: 'redteam-orchestrator spawns ARTEX in sandbox (3 workers default), monitors planner/worker/guard activity every 60s, intervenes if guard blocks exceed threshold or service disruption detected, collects evidence on completion/timeout' },
    { title: 'Export', detail: 'Export ARTEX dual graphs (asset graph, exploration graph), tool executions, guard interventions from PostgreSQL; collect recording-proxy HAR files, screenshots, calculate SHA-256 for all artifacts' },
    { title: 'Reconcile', detail: 'artex-reconciler maps ARTEX findings to Maxwell ledger: build attack paths for proven goals, match existing findings by fingerprint, map to regulatory controls, calculate exploitability scores' },
    { title: 'Refute', detail: 'refuter validates attack paths and findings through evidence/regulatory-mapping/exploitability lenses; high/critical findings must survive all three; observations for controls that blocked ARTEX' },
    { title: 'Write', detail: 'soc-ledger-keeper appends attack paths (artex/attack-path.schema.json), new/updated findings with exploitabilityConfirmed, ARTEX task record, incidents for authorization violations' },
    { title: 'Summary', detail: 'report-writer adds Autonomous Red-Team Assessment section to summary.md with proven attack paths, time-to-exploit, evidence links, and remediations in progress' },
  ],
};

const WORKFLOW = 'runtime-probe-redteam';
const ORCHESTRATOR_AGENT = 'redteam-orchestrator';
const RECONCILER_AGENT = 'artex-reconciler';
const REFUTER_AGENT = 'refuter';
const LEDGER_KEEPER = 'soc-ledger-keeper';
const REPORT_WRITER = 'report-writer';

const ARTEX_VERSION = '0.3.15';
const ARTEX_BINARY = process.env.ARTEX_BINARY || '/opt/artex/artex';
const DEFAULT_TIMEOUT = 18000; // 5 hours
const DEFAULT_WORKERS = 3;
const DEFAULT_MODE = 'limited-exploitation';

const VALID_MODES = ['reconnaissance-only', 'limited-exploitation', 'full-redteam'];
const VALID_AUTH_ROLES = ['CISO', 'CTO', 'Compliance-Head', 'Board-Authorized'];
const PROD_TIERS = ['prod', 'dr'];

const RFC3339Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required');

const mode = (args && args.mode) || DEFAULT_MODE;
if (!VALID_MODES.includes(mode)) {
  throw new Error(`args.mode must be one of: ${VALID_MODES.join(', ')}`);
}

const authorization = args && args.authorization;
if (!authorization) {
  throw new Error('args.authorization is required: { authorizedBy: {name, email, role}, authorizedAt, validUntil, legalBasis }');
}

// Validate authorization structure
if (!authorization.authorizedBy || !authorization.authorizedBy.name || !authorization.authorizedBy.email || !authorization.authorizedBy.role) {
  throw new Error('authorization.authorizedBy must have name, email, and role');
}

if (!VALID_AUTH_ROLES.includes(authorization.authorizedBy.role)) {
  throw new Error(`authorization.authorizedBy.role must be one of: ${VALID_AUTH_ROLES.join(', ')}`);
}

if (!EMAIL.test(authorization.authorizedBy.email)) {
  throw new Error('authorization.authorizedBy.email must be a valid email address');
}

if (!authorization.authorizedAt || !RFC3339Z.test(authorization.authorizedAt)) {
  throw new Error('authorization.authorizedAt must be RFC 3339 UTC with trailing Z');
}

if (!authorization.validUntil || !RFC3339Z.test(authorization.validUntil)) {
  throw new Error('authorization.validUntil must be RFC 3339 UTC with trailing Z');
}

if (new Date(authorization.validUntil) <= new Date()) {
  throw new Error('authorization.validUntil must be in the future (authorization expired)');
}

if (!authorization.legalBasis || typeof authorization.legalBasis !== 'string') {
  throw new Error('authorization.legalBasis is required (reference to signed authorization document)');
}

const dryRun = Boolean(args && args.dryRun);
const argNow = (args && args.now) || null;
const argSessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;

const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.length ? args.envIds : null;

const goals = args && Array.isArray(args.goals) && args.goals.length ? args.goals : null;

const skipped = [];
const incidents = [];
const cisoAlerts = [];
const sessionIds = new Set(argSessionId ? [argSessionId] : []);

const skip = (entry) => { 
  skipped.push(entry); 
  log('SKIPPED:', entry.reason); 
};

// Generate task ID
const { randomBytes } = await import('node:crypto');
const taskIdSuffix = randomBytes(13).toString('base64url').slice(0, 18).toUpperCase();
const taskId = `artex_${taskIdSuffix}`;
const artexTaskId = `artex-task-${taskIdSuffix.toLowerCase()}`;

log(`Starting autonomous red-team assessment`);
log(`Company: ${companyId}`);
log(`Mode: ${mode}`);
log(`Task: ${taskId} (ARTEX: ${artexTaskId})`);
log(`Authorization: ${authorization.authorizedBy.role} (${authorization.authorizedBy.name})`);
log(`Valid until: ${authorization.validUntil}`);
log(`Legal basis: ${authorization.legalBasis}`);

// Production gating check
const hasProdEnvs = envFilter && envFilter.some(e => PROD_TIERS.some(t => e.includes(t)));
if (hasProdEnvs && mode === 'full-redteam' && authorization.authorizedBy.role !== 'Board-Authorized') {
  throw new Error('full-redteam mode on production requires Board-Authorized role');
}

if (hasProdEnvs) {
  log(`WARNING: Production environments explicitly listed: ${envFilter.filter(e => PROD_TIERS.some(t => e.includes(t))).join(', ')}`);
}

// Phase 1: Prerequisites check
log('Phase 1: Checking prerequisites...');

const prereqCheck = await runAgent(ORCHESTRATOR_AGENT, {
  task: 'prerequisites-check',
  companyId,
  artexBinary: ARTEX_BINARY,
  artexVersion: ARTEX_VERSION,
  mode,
  appIds: appFilter,
  envIds: envFilter,
  dryRun
});

if (!prereqCheck.success) {
  skip({ reason: `Prerequisites check failed: ${prereqCheck.reason}` });
  return {
    companyId,
    workflow: WORKFLOW,
    taskId,
    status: 'skipped',
    authorization,
    skipped,
    sessionIds: Array.from(sessionIds)
  };
}

log('Prerequisites check passed');

// Phase 2: Configure ARTEX task
log('Phase 2: Configuring ARTEX task...');

const taskConfig = await runAgent(ORCHESTRATOR_AGENT, {
  task: 'configure-artex',
  companyId,
  taskId: artexTaskId,
  mode,
  appIds: appFilter,
  envIds: envFilter,
  goals,
  authorization,
  sessionId: argSessionId,
  runId
});

sessionIds.add(taskConfig.sessionId);

log(`ARTEX goals: ${taskConfig.config.goals.join(', ')}`);
log(`Allowed domains: ${taskConfig.config.allowedDomains.join(', ')}`);
log(`Prohibited actions: ${Object.keys(taskConfig.config.prohibitedActions).filter(k => taskConfig.config.prohibitedActions[k]).join(', ')}`);

// Phase 3: Execute ARTEX (if not dry-run)
let artexResult;
if (dryRun) {
  log('DRY RUN: Skipping ARTEX execution');
  artexResult = {
    status: 'dry-run',
    taskId: artexTaskId,
    config: taskConfig.config
  };
} else {
  log('Phase 3: Executing ARTEX...');
  log(`This will take up to ${Math.floor(DEFAULT_TIMEOUT / 3600)} hours`);
  
  artexResult = await runAgent(ORCHESTRATOR_AGENT, {
    task: 'execute-artex',
    companyId,
    taskId: artexTaskId,
    config: taskConfig,
    sessionId: argSessionId,
    runId
  });
  
  sessionIds.add(artexResult.sessionId);
  
  log(`ARTEX execution ${artexResult.status}`);
  log(`Duration: ${artexResult.duration?.value} ${artexResult.duration?.unit}`);
  log(`Assets discovered: ${artexResult.results?.assetsDiscovered || 0}`);
  log(`Guard interventions: ${artexResult.results?.guardInterventions || 0}`);
  
  // Check for incidents
  if (artexResult.incidents && artexResult.incidents.length > 0) {
    log(`WARNING: ${artexResult.incidents.length} incidents detected`);
    incidents.push(...artexResult.incidents);
    
    // If authorization violation, stop immediately
    const authViolation = artexResult.incidents.find(i => i.type === 'authorization-violation');
    if (authViolation) {
      cisoAlerts.push({
        severity: 'critical',
        title: 'ARTEX authorization violation detected',
        description: authViolation.description,
        taskId: artexTaskId
      });
      
      return {
        companyId,
        workflow: WORKFLOW,
        taskId,
        status: 'cancelled-authorization-violation',
        authorization,
        artexResult,
        incidents,
        cisoAlerts,
        sessionIds: Array.from(sessionIds)
      };
    }
  }
}

// Phase 4: Export graphs (if ARTEX ran)
let graphExports;
if (!dryRun && artexResult.status !== 'failed') {
  log('Phase 4: Exporting ARTEX graphs...');
  
  graphExports = await runAgent(ORCHESTRATOR_AGENT, {
    task: 'export-graphs',
    companyId,
    taskId: artexTaskId,
    postgresUrl: taskConfig.postgresUrl,
    outputDir: `artex/tasks/${artexTaskId}`,
    sessionId: argSessionId,
    runId
  });
  
  sessionIds.add(graphExports.sessionId);
  
  log(`Exported graphs to ${graphExports.outputDir}`);
  log(`SHA-256: ${graphExports.metadata.sha256}`);
  log(`Assets: ${graphExports.metadata.stats.assets}`);
  log(`Goals: ${graphExports.metadata.stats.goals}`);
  log(`Tool executions: ${graphExports.metadata.stats.executions}`);
}

// Phase 5: Reconcile to Maxwell ledger
let reconciliation;
if (!dryRun && graphExports) {
  log('Phase 5: Reconciling ARTEX findings to Maxwell ledger...');
  
  reconciliation = await runAgent(RECONCILER_AGENT, {
    companyId,
    taskId: artexTaskId,
    graphExports,
    authorization,
    mode,
    sessionId: argSessionId,
    runId
  });
  
  sessionIds.add(reconciliation.sessionId);
  
  log(`Attack paths created: ${reconciliation.attackPathsCreated?.length || 0}`);
  log(`Findings created: ${reconciliation.findingsCreated?.length || 0}`);
  log(`Findings updated: ${reconciliation.findingsUpdated?.length || 0}`);
  log(`Observations created: ${reconciliation.observationsCreated?.length || 0}`);
}

// Phase 6: Refute findings
let refutation;
if (!dryRun && reconciliation) {
  log('Phase 6: Refuting findings...');
  
  const candidateFindings = [
    ...(reconciliation.findingsCreated || []),
    ...(reconciliation.findingsUpdated || [])
  ];
  
  refutation = await runAgent(REFUTER_AGENT, {
    candidates: candidateFindings,
    lenses: ['evidence', 'regulatory-mapping', 'exploitability'],
    context: {
      workflow: WORKFLOW,
      artexTaskId,
      mode,
      authorization
    },
    sessionId: argSessionId,
    runId
  });
  
  sessionIds.add(refutation.sessionId);
  
  log(`Findings accepted: ${refutation.accepted?.length || 0}`);
  log(`Findings rejected: ${refutation.rejected?.length || 0}`);
  
  if (refutation.rejected && refutation.rejected.length > candidateFindings.length / 2) {
    cisoAlerts.push({
      severity: 'high',
      title: 'Over 50% of ARTEX findings rejected by refuter',
      description: `${refutation.rejected.length} of ${candidateFindings.length} findings failed validation. Human review recommended.`,
      taskId: artexTaskId
    });
  }
}

// Phase 7: Write to ledger
let ledgerWrite;
if (!dryRun && refutation && refutation.accepted && refutation.accepted.length > 0) {
  log('Phase 7: Writing to SOC ledger...');
  
  ledgerWrite = await runAgent(LEDGER_KEEPER, {
    companyId,
    records: [
      ...reconciliation.attackPaths,
      ...refutation.accepted,
      ...(reconciliation.observations || []),
      {
        schemaVersion: '1',
        kind: 'artex-task',
        id: taskId,
        recordedAt: new Date().toISOString(),
        companyId,
        taskId: artexTaskId,
        status: artexResult.status,
        scope: {
          mode,
          appIds: appFilter,
          envIds: envFilter
        },
        authorization,
        startedAt: artexResult.startedAt,
        completedAt: artexResult.completedAt,
        duration: artexResult.duration,
        results: artexResult.results,
        graphExport: {
          assetGraphPath: `artex/tasks/${artexTaskId}/asset-graph.json`,
          explorationGraphPath: `artex/tasks/${artexTaskId}/exploration-graph.json`,
          sha256: graphExports.metadata.sha256
        },
        incidents: artexResult.incidents || [],
        reconciliationStatus: 'completed',
        reconciledFindingIds: refutation.accepted.map(f => f.id),
        reconciledAttackPathIds: reconciliation.attackPaths.map(ap => ap.id),
        provenance: {
          harness: 'claude-code',
          generatedAt: new Date().toISOString(),
          sessionId: argSessionId,
          runId,
          workflow: WORKFLOW,
          agent: ORCHESTRATOR_AGENT
        }
      }
    ],
    workflow: WORKFLOW,
    sessionId: argSessionId,
    runId
  });
  
  sessionIds.add(ledgerWrite.sessionId);
  
  log(`Ledger append: ${ledgerWrite.recordsAppended} records`);
}

// Phase 8: Update summary
if (!dryRun && ledgerWrite) {
  log('Phase 8: Updating summary...');
  
  const summaryUpdate = await runAgent(REPORT_WRITER, {
    companyId,
    sections: ['autonomous-redteam', 'open-findings', 'change-management'],
    context: {
      artexTaskId,
      attackPaths: reconciliation.attackPaths,
      authorization
    },
    sessionId: argSessionId,
    runId
  });
  
  sessionIds.add(summaryUpdate.sessionId);
  
  log('Summary updated');
}

// Final result
log('Autonomous red-team assessment complete');

return {
  companyId,
  workflow: WORKFLOW,
  taskId,
  artexTaskId,
  status: artexResult?.status || 'dry-run',
  authorization,
  mode,
  appIds: appFilter,
  envIds: envFilter,
  goals: taskConfig?.config?.goals,
  artexResult,
  graphExports,
  reconciliation: reconciliation ? {
    attackPathsCreated: reconciliation.attackPaths?.length || 0,
    findingsCreated: reconciliation.findingsCreated?.length || 0,
    findingsUpdated: reconciliation.findingsUpdated?.length || 0,
    observationsCreated: reconciliation.observationsCreated?.length || 0
  } : null,
  refutation: refutation ? {
    accepted: refutation.accepted?.length || 0,
    rejected: refutation.rejected?.length || 0
  } : null,
  ledgerWrite: ledgerWrite ? {
    recordsAppended: ledgerWrite.recordsAppended
  } : null,
  incidents,
  cisoAlerts,
  skipped,
  dryRun,
  sessionIds: Array.from(sessionIds)
};

// Helper to run agent (simplified - actual implementation would use Claude Code's agent runner)
async function runAgent(agentName, params) {
  // This is a placeholder - actual implementation would:
  // 1. Load agent definition from .claude/agents/<agentName>.md
  // 2. Construct prompt with params
  // 3. Invoke Claude Code agent runner
  // 4. Parse structured output
  // 5. Return result
  
  throw new Error(`runAgent is a placeholder - implement using Claude Code's agent invocation`);
}
