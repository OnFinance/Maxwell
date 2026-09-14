// impl-change-management: turns open ledger findings and risks that no initiative owns into ITIL-typed
// remediation initiatives with actionable tasks under company-profile/<companyId>/change_management/.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean, now?: RFC3339 'Z' string,
//         sessionId?: string, runId?: string }
// Shape: Scout (open findings/risks without initiativeId grouped by root cause + control) -> per-group pipeline:
// change-planner drafts initiative + tasks -> 2-lens refute (actionability, regulatory-mapping) -> validator writes
// master.json / timeline.json / tasks (sequential, one group at a time so master.json never races) ->
// soc-ledger-keeper links findings, risks and controls by superseding records (initiativeId, risk open -> investigating
// -> mitigating, control implementationStatus -> planned) -> report-writer refreshes the
// initiatives section of summary.md. Every ledger write goes through node .claude/scripts/soc/append.mjs and every
// file write is validated with node .claude/scripts/validate-data.mjs.
export const meta = {
  name: 'impl-change-management',
  description: 'Groups open findings and risks by root cause and control, drafts ITIL-typed initiatives with owners, SLA due dates and testable tasks, links the ledger and refreshes the initiatives report section.',
  phases: [
    { title: 'Scout', detail: 'List open findings and risks that no initiative owns, grouped by root cause and control; resolve contacts and existing initiatives' },
    { title: 'Plan', detail: 'change-planner drafts one initiative with tasks per group, passing the actionability rubric (owner, dueAt from the SLA table, ITIL changeType, acceptance criteria, verification, root cause)' },
    { title: 'Refute', detail: 'refuter judges each draft through the actionability and regulatory-mapping lenses; every draft must survive regulatory-mapping, critical/high/emergency drafts both lenses' },
    { title: 'Write', detail: 'validator materialises master.json, initiatives/<init_id>/timeline.json and tasks/task_<n>.json for each surviving draft and validates them' },
    { title: 'Link', detail: 'soc-ledger-keeper supersedes each linked finding, risk and control (initiativeId, risk lifecycle, planned) via soc/append.mjs' },
    { title: 'Summary', detail: 'report-writer refreshes the initiatives section of summary.md and returns counts' },
  ],
};

const WORKFLOW = 'impl-change-management';
const BASE_TAGS = ['change-management', 'remediation'];

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const now = (args && args.now) || null;
const sessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.length ? args.envIds : null;
const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };

const CLOCK_CMD = 'node -e "console.log(new Date(performance.timeOrigin).toISOString().slice(0, 19) + \'Z\')"';
const makeTimeRule = (ts) => (ts
  ? 'Use ' + ts + ' as createdAt, recordedAt, collectedAt, updatedAt, generatedAt and every event "at" you write (RFC 3339 UTC with trailing Z); derive dueAt by adding slaBasis.days calendar days to it.'
  : 'No run timestamp is known: run ' + CLOCK_CMD + ' once (or read it from a tool you have) and use that single value for every timestamp you write; derive dueAt by adding slaBasis.days calendar days to it.');
let timeRule = makeTimeRule(now);
const provenanceRule = 'Every record you write carries provenance: harness (claude-code or opencode, whichever you run under), generatedAt, sessionId'
  + (sessionId ? ' = ' + sessionId : ' (your own harness session id; omit only if you cannot determine it)')
  + (runId ? ', runId = ' + runId : ', runId from MAXWELL_RUN_ID when set') + ', workflow = ' + WORKFLOW + ', agent = <your agent name>.';
const dryRunRule = dryRun
  ? 'DRY RUN: do not write any file under company-profile/. Plan only and return the draft; the run records a single inconclusive observation instead of initiatives.'
  : '';

// ---- Schemas for structured agent output -------------------------------------------------------------
const REG_REF = {
  type: 'object',
  required: ['regulator', 'instrument', 'controlId'],
  properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } },
};
// common.schema actor is {type, id} with additionalProperties false: no name key.
const ACTOR = { type: 'object', required: ['type', 'id'], properties: { type: { type: 'string', enum: ['human', 'agent', 'script'] }, id: { type: 'string' } } };
const ASSET_REF = {
  type: 'object',
  required: ['type'],
  properties: { type: { type: 'string' }, appId: { type: 'string' }, repoId: { type: 'string' }, envId: { type: 'string' }, imageId: { type: 'string' }, vendorId: { type: 'string' }, path: { type: 'string' } },
};
const SLA_BASIS = {
  type: 'object',
  required: ['source', 'topic', 'days'],
  properties: { source: { type: 'string', enum: ['sla-table', 'defaults', 'company-policy'] }, instrument: { type: 'string' }, controlId: { type: 'string' }, topic: { type: 'string' }, days: { type: 'integer' } },
};

const SCOUT_SCHEMA = {
  type: 'object',
  required: ['groups', 'contacts', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    now: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    frameworksInScope: { type: 'array', items: { type: 'string' } },
    contacts: { type: 'array', items: { type: 'object', required: ['role', 'email'], properties: { role: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } } },
    existingInitiativeIds: { type: 'array', items: { type: 'string' } },
    existingControlIds: { type: 'array', items: { type: 'string' } },
    openFindingsTotal: { type: 'integer' },
    openRisksTotal: { type: 'integer' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['groupId', 'rootCauseCategory', 'severity', 'findingIds', 'riskIds', 'ledgerControlIds', 'regulatoryRefs', 'targets'],
        properties: {
          groupId: { type: 'string' },
          titleHint: { type: 'string' },
          rootCauseCategory: { type: 'string', enum: ['missing-control', 'misconfiguration', 'vulnerable-dependency', 'insecure-code', 'process-gap', 'vendor-gap', 'awareness', 'unknown'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          findingIds: { type: 'array', items: { type: 'string' } },
          riskIds: { type: 'array', items: { type: 'string' } },
          ledgerControlIds: { type: 'array', items: { type: 'string' } },
          regulatoryRefs: { type: 'array', items: REG_REF },
          targets: { type: 'array', items: ASSET_REF },
          primaryInstrument: { type: 'string' },
          earliestSlaDueAt: { type: 'string' },
          summaryOfGaps: { type: 'string' },
        },
      },
    },
    skipped: { type: 'array', items: { type: 'object', required: ['reason'], properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
  },
};

const TASK = {
  type: 'object',
  required: ['seq', 'title', 'description', 'owner', 'acceptanceCriteria', 'verificationMethod', 'rootCause', 'targets', 'effortEstimateHours', 'dependsOn'],
  properties: {
    seq: { type: 'integer' },
    title: { type: 'string' },
    description: { type: 'string' },
    owner: ACTOR,
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    verificationMethod: { type: 'object', required: ['type', 'description'], properties: { type: { type: 'string', enum: ['re-probe', 'manual-test', 'code-review', 'evidence-review', 'pentest', 'attestation'] }, workflow: { type: 'string' }, description: { type: 'string' } } },
    rootCause: { type: 'object', required: ['category', 'description'], properties: { category: { type: 'string' }, description: { type: 'string' } } },
    targets: { type: 'array', items: ASSET_REF },
    effortEstimateHours: { type: 'number' },
    dueAt: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'integer' } },
  },
};
const PLAN_SCHEMA = {
  type: 'object',
  required: ['groupId', 'initiativeId', 'initiative', 'tasks', 'rubric', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    groupId: { type: 'string' },
    initiativeId: { type: 'string', pattern: '^init_[0-7][0-9A-HJKMNP-TV-Z]{25}$' },
    initiative: {
      type: 'object',
      required: ['title', 'summary', 'severity', 'priority', 'changeType', 'owner', 'slaBasis', 'dueAt', 'findingIds', 'riskIds', 'controlIds', 'regulatoryRefs', 'targets'],
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        priority: { type: 'string', enum: ['p1', 'p2', 'p3', 'p4'] },
        changeType: { type: 'string', enum: ['standard', 'normal', 'emergency'] },
        owner: ACTOR,
        intendedApprover: ACTOR,
        slaBasis: SLA_BASIS,
        dueAt: { type: 'string' },
        rollbackPlan: { type: 'string' },
        riskAssessment: { type: 'string' },
        findingIds: { type: 'array', items: { type: 'string' } },
        riskIds: { type: 'array', items: { type: 'string' } },
        controlIds: { type: 'array', items: { type: 'string' } },
        regulatoryRefs: { type: 'array', items: REG_REF },
        targets: { type: 'array', items: ASSET_REF },
      },
    },
    tasks: { type: 'array', items: TASK },
    rubric: {
      type: 'object',
      required: ['ownerFromContacts', 'dueAtFromSlaTable', 'everyTaskHasAcceptanceCriteria', 'everyTaskHasVerification', 'everyTaskHasRootCause', 'changeTypeJustified'],
      properties: {
        ownerFromContacts: { type: 'boolean' },
        dueAtFromSlaTable: { type: 'boolean' },
        everyTaskHasAcceptanceCriteria: { type: 'boolean' },
        everyTaskHasVerification: { type: 'boolean' },
        everyTaskHasRootCause: { type: 'boolean' },
        changeTypeJustified: { type: 'boolean' },
        notes: { type: 'string' },
      },
    },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    sessionId: { type: 'string' },
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    correctedOwner: ACTOR,
    correctedDueAt: { type: 'string' },
    correctedSlaBasis: SLA_BASIS,
    correctedChangeType: { type: 'string', enum: ['standard', 'normal', 'emergency'] },
    correctedPriority: { type: 'string', enum: ['p1', 'p2', 'p3', 'p4'] },
    correctedRegulatoryRefs: { type: 'array', items: REG_REF },
    correctedControlIds: { type: 'array', items: { type: 'string' } },
    droppedTaskSeqs: { type: 'array', items: { type: 'integer' } },
  },
};

const WRITE_SCHEMA = {
  type: 'object',
  required: ['initiativeId', 'taskIds', 'filesWritten', 'validationGreen', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    initiativeId: { type: 'string' },
    taskIds: { type: 'array', items: { type: 'string' } },
    filesWritten: { type: 'array', items: { type: 'string' } },
    validationGreen: { type: 'boolean' },
    schemaIssues: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};

const LINK_SCHEMA = {
  type: 'object',
  required: ['findingIds', 'riskIds', 'observationIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    findingIds: { type: 'array', items: { type: 'string' } },
    riskIds: { type: 'array', items: { type: 'string' } },
    observationIds: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['updated', 'openInitiatives'],
  properties: {
    sessionId: { type: 'string' },
    updated: { type: 'boolean' },
    openInitiatives: { type: 'integer' },
    overdueInitiatives: { type: 'integer' },
    version: { type: 'string' },
    notes: { type: 'string' },
  },
};

// ---- Phase 1: Scout -----------------------------------------------------------------------------------
phase('Scout');
log('Scouting ' + companyId + ' for open findings and risks without an initiative' + (appFilter ? ' (apps: ' + appFilter.join(', ') + ')' : '') + (envFilter ? ' (envs: ' + envFilter.join(', ') + ')' : ''));
const scout = await agent(
  [
    'You are scouting the Maxwell workspace for the ' + WORKFLOW + ' workflow. Company: ' + companyId + '. Read-only: do not append to the ledger and do not write any file.',
    now ? 'Run timestamp: ' + now + ' (return it as now).' : 'Run ' + CLOCK_CMD + ' once and return the value as now; every later stage reuses it so the run has one consistent timestamp.',
    'Read .claude/skills/maxwell-conventions/SKILL.md and .claude/skills/soc-ledger/SKILL.md (section on reading the latest state: last record per id following supersedes).',
    'Read company-profile/' + companyId + '/details.json: return entityTypes, frameworksInScope and contacts [{role, name, email}] (the change-planner picks owners from these by role).',
    'Read company-profile/' + companyId + '/change_management/master.json and return existingInitiativeIds. Read company-profile/' + companyId + '/soc/main.jsonl and compute the latest state per record id.',
    'Candidates: every kind "finding" whose latest state has status open|triaged|remediating and no initiativeId, and every kind "risk" whose latest state has status open|investigating|mitigating and no mitigations[].initiativeId. Return openFindingsTotal / openRisksTotal as the totals before filtering.',
    appFilter ? 'Only keep candidates whose target.appId is one of: ' + appFilter.join(', ') + ' (company-wide targets with no appId are kept). Add a skipped entry for every candidate dropped by this filter.' : '',
    envFilter ? 'Only keep candidates whose target.envId is one of: ' + envFilter.join(', ') + ' or whose target has no envId. Add a skipped entry for every candidate dropped by this filter.' : '',
    'Group candidates by root cause and control: two candidates belong to the same group when they share a rootCause category (infer it from source.ruleId, tags, title and description: missing-control, misconfiguration, vulnerable-dependency, insecure-code, process-gap, vendor-gap, awareness, unknown) AND at least one ledger controlId (or, when controlIds are empty, the same primary regulatoryRef instrument + controlId). Keep groups small enough to be one ITIL change (at most 8 findings per group; split by target when larger and say so in summaryOfGaps).',
    'For each group return groupId (e.g. g1, g2), titleHint, rootCauseCategory, severity (highest among members), findingIds, riskIds, ledgerControlIds (instrument-qualified "<instrumentId>:<controlId>" ids from the members that exist as control records), regulatoryRefs (union, most specific Indian instrument first), targets (union of member target assetRefs), primaryInstrument, earliestSlaDueAt (min slaDueAt among member findings) and summaryOfGaps (two sentences citing member ids).',
    'Return existingControlIds (ids of every kind "control" record) and skipped [{id, reason}] for every candidate you dropped (already linked, filtered, malformed) so nothing is dropped silently.',
  ].filter(Boolean).join('\n'),
  { label: 'scout', phase: 'Scout', agentType: 'soc-ledger-keeper', schema: SCOUT_SCHEMA, effort: 'medium' },
);
if (!scout) {
  // run-workflow.mjs --dry-run returns null for every schema agent(): report a planned-only result instead of failing.
  if (dryRun) {
    skipped.push({ reason: 'dry-run: scout returned no result (runtime dry-run executes no agent); nothing planned or written' });
    log('dry-run: scout returned nothing; planned-only result');
    return { companyId, workflow: WORKFLOW, dryRun, plannedOnly: true, phases: ['Scout', 'Plan', 'Refute', 'Write', 'Link', 'Summary'], targets: [], observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, skipped, sessionIds: [...sessionIds] };
  }
  throw new Error('Scout returned nothing; cannot continue');
}
noteSession(scout);
if (!now && typeof scout.now === 'string' && /Z$/.test(scout.now)) timeRule = makeTimeRule(scout.now);
for (const s of scout.skipped || []) { skipped.push(s); log('skipped ' + (s.id || '?') + ': ' + s.reason); }
const groups = (scout.groups || []).filter((g) => g && g.groupId && ((g.findingIds || []).length || (g.riskIds || []).length));
const contacts = scout.contacts || [];
const existingControlIds = scout.existingControlIds || [];
log(groups.length + ' group(s) from ' + (scout.openFindingsTotal || 0) + ' open finding(s) and ' + (scout.openRisksTotal || 0) + ' open risk(s); ' + contacts.length + ' contact(s); ' + (scout.existingInitiativeIds || []).length + ' existing initiative(s)');
if (!groups.length) {
  log('No unowned open finding or risk for ' + companyId + '; nothing to plan');
  return { companyId, workflow: WORKFLOW, dryRun, targets: [], observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, skipped, sessionIds: [...sessionIds] };
}
if (!contacts.length) skipped.push({ reason: 'scout returned no contacts from details.json (the schema requires at least one); the actionability refuter will reject drafts whose owners are not real contacts' });

// ---- Phase 2 + 3: per-group pipeline (plan -> refute) -------------------------------------------------
phase('Plan');
log('Planning ' + groups.length + ' initiative(s); refutation runs interleaved per group inside the same pipeline (agents are tagged phase Refute)');
const planPrompt = (g) => [
  'You are the change-planner running the ' + WORKFLOW + ' workflow for company ' + companyId + ' (entityTypes: ' + ((scout.entityTypes || []).join(', ') || 'unknown') + '; frameworks in scope: ' + ((scout.frameworksInScope || []).join(', ') || 'unknown') + ').',
  'Read the skills first: .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/soc-ledger/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md and its references/sla-table.json (SLA days by instrument, topic, severity; when the skill file is missing use references/catalogs/*.catalog.json and the sla-table.json, and say so in rubric.notes).',
  'Read company-profile/' + companyId + '/details.json, company-profile/' + companyId + '/sdlc/policy.json, company-profile/' + companyId + '/change_management/master.json (do not duplicate an existing initiative with the same findingIds) and the latest ledger records for every id in this group from company-profile/' + companyId + '/soc/main.jsonl. Read the schemas .claude/schemas/v1/change-management/master.schema.json and task.schema.json so the draft maps one-to-one onto their fields.',
  'Group to plan:\n' + JSON.stringify(g, null, 1),
  'Draft ONE initiative (an ITIL 4 change) and its tasks. Do NOT write any file: return the draft; the validator materialises it after refutation.',
  'Actionability rubric (every item must be true or the draft is rejected):\n- owner: a human from details.json contacts chosen by role (contactRole enum values only - misconfiguration / insecure-code / vulnerable-dependency -> cto, else head-it; detection and logging gaps -> soc-lead; process-gap / awareness -> ciso; vendor-gap -> compliance-officer; personal-data gaps -> dpo; when the preferred role has no contact use the ciso contact and say so in rubric.notes), as {type: "human", id: <email>} (actor objects carry only type and id). intendedApprover: the ciso contact for normal changes, the ciso for emergency changes with the cto named in riskAssessment as ECAB member, omitted for standard (pre-authorised). It is NOT written as approver: the schema forbids approver/approvedAt while an initiative is proposed.\n- changeType: standard when the change is a pre-authorised low-risk configuration or dependency bump with a documented rollback; emergency only when a critical finding is past its slaDueAt or a risk is likely/almost-certain with major/severe impact; normal otherwise. Explain in rubric.notes.\n- priority: p1 critical or emergency, p2 high, p3 medium, p4 low/info.\n- slaBasis: the sla-table row for the primary instrument + topic + group severity ({source: "sla-table", instrument, controlId?, topic, days}); when no row matches use {source: "defaults", topic, days} from the table defaults; when sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays overrides a patch-sla row use source "company-policy". dueAt = createdAt + days (never earlier than the run timestamp).\n- rollbackPlan (required for normal and emergency) and riskAssessment describing blast radius and mitigations.\n- tasks: 1 to 6 imperative tasks with seq 1..n, description saying what to change where and the constraints, owner (human from contacts, may differ from the initiative owner), acceptanceCriteria (>= 2 testable statements), verificationMethod ({type, description, workflow?}: set workflow ONLY when type is re-probe, and it must be a probe-* or runtime-probe-* workflow from .claude/schemas/vocab/workflows.schema.json (pattern ^(runtime-)?probe-); omit workflow for manual-test / code-review / evidence-review / pentest / attestation, which carry concrete steps and the expected result in description. A finding raised by execute-scr uses code-review or re-probe with probe-sdlc; one raised by refresh-* uses the probe that covers that control or evidence-review - never re-probe with a refresh-* or execute-scr workflow), rootCause {category: ' + (g.rootCauseCategory || 'unknown') + ', description specific to the task}, targets (subset of the initiative targets), effortEstimateHours, dueAt (never later than the initiative dueAt), dependsOn (seq numbers of prerequisite tasks).',
  'findingIds / riskIds / regulatoryRefs / targets: copy from the group. controlIds: the BARE catalog control ids (the part after the colon, e.g. GV.SC.S5) of the group ledgerControlIds, each matching a regulatoryRefs entry; change_management/master.json uses bare ids (common controlId pattern has no colon) while the ledger uses "<instrumentId>:<controlId>" (known ledger controls: ' + (existingControlIds.join(', ') || 'none') + '). regulatoryRefs must cite the most specific Indian instrument first and use the catalog control id verbatim.',
  'Mint initiativeId = "init_" + a fresh ULID with the node -e recipe in .claude/skills/maxwell-conventions/SKILL.md section 1 (never typed by hand) and return it; the validator uses it as the directory name.',
  'Return {groupId, initiativeId, initiative, tasks, rubric, skipped} where rubric answers each rubric item with true/false and skipped lists every member id you left out of the draft and why.',
  timeRule, provenanceRule, dryRunRule,
].filter(Boolean).join('\n');

const refutePrompt = (g, draft, lens) => [
  'You are an adversarial refuter for the ' + WORKFLOW + ' workflow (company ' + companyId + '). Lens: ' + lens + '. Try to REFUTE the draft initiative below; default to refuted=true if you cannot verify it yourself from the workspace.',
  'Draft (group ' + g.groupId + '):\n' + JSON.stringify(draft, null, 1),
  lens === 'actionability'
    ? 'Actionability lens: verify against company-profile/' + companyId + '/details.json that the owner and every task owner are real contacts (email present under contacts[]), that every task has >= 2 testable acceptanceCriteria, a verificationMethod with concrete steps (workflow present only for re-probe and then a probe-* or runtime-probe-* workflow from .claude/schemas/vocab/workflows.schema.json; a task that breaks this is dropped via droppedTaskSeqs unless its type can simply be corrected, which you say in reason), a rootCause with a specific description, an effort estimate and a dueAt not later than the initiative dueAt, that dependsOn forms no cycle, that rollbackPlan exists for normal/emergency changes, and that the changeType and priority are justified by the linked ledger records in company-profile/' + companyId + '/soc/main.jsonl (an emergency change needs a critical past-SLA finding or a likely+major risk). Return correctedOwner / correctedChangeType / correctedPriority / droppedTaskSeqs when the draft is fixable; refute only when the initiative could not be executed as written.'
    : 'Regulatory-mapping lens: read .claude/skills/regulatory-catalogs/SKILL.md, references/sla-table.json and references/catalogs/*.catalog.json; check that every regulatoryRef instrument applies to this company (details.json entityTypes, regulatoryRegistrations, frameworksInScope), that each bare controlId exists in that catalog and as a ledger control record "<instrument>:<controlId>", that the most specific Indian instrument is cited first, that slaBasis matches an actual table row (instrument, topic, severity, days) or the table defaults, and that dueAt = createdAt + days. Return correctedRegulatoryRefs / correctedControlIds (bare ids) / correctedSlaBasis / correctedDueAt when the mapping is wrong but the change is warranted; refute only when no applicable clause exists or the linked findings are not open.',
  'Read-only: never modify the workspace. Return {refuted, reason, corrected* fields as applicable}.',
].join('\n');

const planned = await pipeline(
  groups,
  async (g, _item, index) => {
    const r = await agent(planPrompt(g), { label: 'plan ' + g.groupId + ' #' + (index + 1), phase: 'Plan', agentType: 'change-planner', schema: PLAN_SCHEMA, effort: 'high' });
    if (!r) { skipped.push({ id: g.groupId, reason: 'change-planner returned no schema-valid draft' }); log('plan failed for ' + g.groupId); return null; }
    noteSession(r);
    for (const s of r.skipped || []) skipped.push({ id: g.groupId, reason: 'plan: ' + s });
    const rubric = r.rubric || {};
    const failedRubric = Object.keys(rubric).filter((k) => k !== 'notes' && rubric[k] === false);
    if (failedRubric.length) { skipped.push({ id: g.groupId, reason: 'draft failed the actionability rubric: ' + failedRubric.join(', ') + (rubric.notes ? ' - ' + rubric.notes : '') }); log(g.groupId + ': rubric failed (' + failedRubric.join(', ') + ')'); return null; }
    log(g.groupId + ': draft "' + (r.initiative && r.initiative.title) + '" with ' + (r.tasks || []).length + ' task(s), ' + (r.initiative && r.initiative.changeType) + ' change, due ' + (r.initiative && r.initiative.dueAt));
    return { group: g, draft: r };
  },
  async (prev) => {
    if (!prev) return null;
    const { group: g, draft } = prev;
    if (dryRun) { skipped.push({ id: g.groupId, reason: 'dry-run: draft "' + (draft.initiative && draft.initiative.title) + '" not refuted or written' }); return { group: g, draft, accepted: false }; }
    const candidate = { initiative: draft.initiative, tasks: draft.tasks, rubric: draft.rubric };
    const votes = await parallel(['actionability', 'regulatory-mapping'].map((lens) => () =>
      agent(refutePrompt(g, candidate, lens), { label: 'refute ' + lens + ' ' + g.groupId, phase: 'Refute', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' })));
    const valid = votes.filter(Boolean);
    valid.forEach(noteSession);
    const refutations = valid.filter((v) => v.refuted).length;
    const severe = draft.initiative.severity === 'high' || draft.initiative.severity === 'critical' || draft.initiative.changeType === 'emergency';
    const byLens = { actionability: votes[0], 'regulatory-mapping': votes[1] };
    // AGENTS.md section 6: every initiative must cite an applicable regulatoryRef, so the regulatory-mapping lens must
    // answer and not refute for every severity. critical/high (and any emergency change) must also get a non-refuting
    // actionability verdict; for medium/low/info a missing actionability verdict is tolerated but a refutation is not.
    const regOk = Boolean(byLens['regulatory-mapping']) && !byLens['regulatory-mapping'].refuted;
    const actOk = byLens.actionability ? !byLens.actionability.refuted : !severe;
    const survives = regOk && actOk;
    if (!byLens.actionability && !severe && survives) skipped.push({ id: g.groupId, reason: 'actionability refuter returned no verdict; medium/low/info draft kept on the regulatory-mapping verdict alone' });
    if (!survives) { skipped.push({ id: g.groupId, reason: 'refuted (' + refutations + '/' + valid.length + ' lenses): ' + draft.initiative.title + ' - ' + valid.map((v) => v.reason).join(' | ') }); log(g.groupId + ': refuted'); return { group: g, draft, accepted: false }; }
    const initiative = { ...draft.initiative };
    let tasks = (draft.tasks || []).slice();
    // corrected* fields are applied only from verdicts that did not refute the draft.
    for (const v of valid.filter((x) => !x.refuted)) {
      if (v.correctedOwner) initiative.owner = v.correctedOwner;
      if (v.correctedChangeType) initiative.changeType = v.correctedChangeType;
      if (v.correctedPriority) initiative.priority = v.correctedPriority;
      if (v.correctedSlaBasis) initiative.slaBasis = v.correctedSlaBasis;
      if (v.correctedDueAt) initiative.dueAt = v.correctedDueAt;
      if (v.correctedRegulatoryRefs && v.correctedRegulatoryRefs.length) initiative.regulatoryRefs = v.correctedRegulatoryRefs;
      if (v.correctedControlIds && v.correctedControlIds.length) initiative.controlIds = v.correctedControlIds;
      if (v.droppedTaskSeqs && v.droppedTaskSeqs.length) {
        const drop = new Set(v.droppedTaskSeqs);
        tasks = tasks.filter((t) => !drop.has(t.seq));
        skipped.push({ id: g.groupId, reason: 'refuter dropped task(s) ' + v.droppedTaskSeqs.join(', ') + ': ' + v.reason });
      }
    }
    if (!tasks.length) { skipped.push({ id: g.groupId, reason: 'no task survived refutation; initiative not written' }); return { group: g, draft, accepted: false }; }
    // Renumber seq to 1..n and remap dependsOn through old seq -> new seq; drop dependencies on removed tasks.
    const seqMap = new Map(tasks.map((t, i) => [t.seq, i + 1]));
    tasks = tasks.map((t, i) => {
      const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
      const removed = deps.filter((d) => !seqMap.has(d));
      if (removed.length) skipped.push({ id: g.groupId, reason: 'task "' + t.title + '" (seq ' + t.seq + ' -> ' + (i + 1) + ') lost dependency on dropped task seq ' + removed.join(', ') });
      const remapped = [...new Set(deps.filter((d) => seqMap.has(d)).map((d) => seqMap.get(d)))].filter((d) => d !== i + 1);
      return { ...t, seq: i + 1, dependsOn: remapped };
    });
    log(g.groupId + ': survived refutation with ' + tasks.length + ' task(s)');
    return { group: g, draft: { ...draft, initiative, tasks }, accepted: true, refutation: valid.map((v) => ({ refuted: v.refuted, reason: v.reason })) };
  },
);
const accepted = planned.filter((p) => p && p.accepted);
log(accepted.length + '/' + groups.length + ' initiative draft(s) accepted');

// ---- Phase 4: Write (sequential so master.json counters and task numbering never race) --------------------
phase('Write');
const written = [];
if (dryRun) {
  log('dry-run: no initiative files written');
} else {
  for (const p of accepted) {
    const w = await agent(
      [
        'You are the validator materialising one change-management initiative for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/maxwell-conventions/SKILL.md, .claude/schemas/v1/change-management/master.schema.json, timeline.schema.json and task.schema.json first.',
        'initiativeId = ' + p.draft.initiativeId + ' (minted by the change-planner; if it already exists in master.json stop and return validationGreen false with the reason). Files to write, all validated with node .claude/scripts/validate-data.mjs <path>:',
        '1. company-profile/' + companyId + '/change_management/initiatives/<init_id>/tasks/task_<n>.json for each task below (taskId task_<seq>, seq, initiativeId, companyId, status "todo", humanEdited false, createdAt, evidence [], suggestionIds [], dependsOn as task_<seq> ids, dueAt as given, no startedAt).',
        '2. company-profile/' + companyId + '/change_management/initiatives/<init_id>/timeline.json with events evt_1 {type: created, toStatus: proposed, actor: {type: agent, id: "change-planner"}, note citing the finding/risk ids}, then one evt_<n> {type: task-added, toStatus: todo, refs.taskId} per task in seq order, all at the run timestamp. Every event requires eventId, at, type, actor, note and refs (refs may be {} but must be present; task-added events carry refs.taskId; the created event carries refs.findingId of the first finding when present), plus sessionId/runId. Name the intended approver in the created event note.',
        '3. company-profile/' + companyId + '/change_management/master.json: read it, append the initiative to initiatives[] (never reorder or delete): initiativeId, title, summary, status "proposed", severity, priority, changeType, owner, NO approver and NO approvedAt (forbidden while proposed; the draft intendedApprover goes only into the timeline note), createdAt, dueAt, slaBasis, rollbackPlan, riskAssessment, findingIds, riskIds, controlIds (bare catalog ids, no instrument prefix), regulatoryRefs, targets, taskCounts {total, done: 0, blocked: 0}, suggestionIds [], sourceWorkflow "' + WORKFLOW + '", provenance; then recompute counters (open/closed/cancelled/overdue over every initiative; overdue = open with dueAt < updatedAt), set updatedAt and the index-level provenance.',
        'Draft initiative:\n' + JSON.stringify(p.draft.initiative, null, 1),
        'Tasks:\n' + JSON.stringify(p.draft.tasks, null, 1),
        'Refutation record (cite in the created event note): ' + JSON.stringify(p.refutation || []),
        timeRule, provenanceRule,
        'Do not touch the ledger or summary.md. Fix content until node .claude/scripts/validate-data.mjs is green for every file you wrote; never edit schemas. Return {initiativeId, taskIds, filesWritten, validationGreen, schemaIssues, skipped}.',
      ].join('\n'),
      { label: 'write ' + p.group.groupId, phase: 'Write', agentType: 'validator', schema: WRITE_SCHEMA, effort: 'medium' },
    );
    if (!w || !w.initiativeId) { skipped.push({ id: p.group.groupId, reason: 'validator returned no result; initiative "' + p.draft.initiative.title + '" not written' }); continue; }
    noteSession(w);
    for (const s of w.skipped || []) skipped.push({ id: p.group.groupId, reason: 'write: ' + s });
    for (const s of w.schemaIssues || []) skipped.push({ id: p.group.groupId, reason: 'schema issue: ' + s });
    if (!w.validationGreen) { skipped.push({ id: p.group.groupId, reason: 'validation not green for ' + w.initiativeId + '; ledger not linked' }); continue; }
    written.push({ group: p.group, draft: p.draft, initiativeId: w.initiativeId, taskIds: w.taskIds || [], filesWritten: w.filesWritten || [] });
    log(p.group.groupId + ': wrote ' + w.initiativeId + ' with ' + (w.taskIds || []).length + ' task file(s)');
  }
}

// ---- Phase 5: Link (ledger) -----------------------------------------------------------------------------
phase('Link');
const linked = { findingIds: [], riskIds: [], observationIds: [] };
if (dryRun) {
  const l = await agent(
    [
      'You are the soc-ledger-keeper for a DRY RUN of the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md.',
      'Append exactly one observation via `node .claude/scripts/soc/append.mjs ' + companyId + ' -`: kind observation, id obs_<ULID>, controlIds = the union of ledgerControlIds of the groups below that exist as control records (the schema requires at least one; when none exists, do not append and report that in skipped), title "dry-run: impl-change-management planned ' + planned.filter(Boolean).length + ' initiative(s)", description starting with "dry-run:" stating that ' + planned.filter(Boolean).length + ' draft(s) were produced for ' + groups.length + ' group(s) (not refuted or written) and listing per group the draft title, changeType, owner and member finding/risk ids, methods ["' + WORKFLOW + '"], subjects = the union of group targets, collectedAt, result "inconclusive", tags ' + JSON.stringify(BASE_TAGS.concat(['dry-run'])) + '. Do not supersede any finding or risk.',
      'Groups:\n' + JSON.stringify(planned.filter(Boolean).map((p) => ({ groupId: p.group.groupId, title: p.draft.initiative.title, changeType: p.draft.initiative.changeType, owner: p.draft.initiative.owner, findingIds: p.group.findingIds, riskIds: p.group.riskIds, ledgerControlIds: p.group.ledgerControlIds, targets: p.group.targets })), null, 1),
      timeRule, provenanceRule,
      'Validate with node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/soc/main.jsonl. Return {findingIds: [], riskIds: [], observationIds, skipped}.',
    ].join('\n'),
    { label: 'dry-run observation', phase: 'Link', agentType: 'soc-ledger-keeper', schema: LINK_SCHEMA, effort: 'low' },
  );
  if (l) { noteSession(l); linked.observationIds.push(...(l.observationIds || [])); for (const s of l.skipped || []) skipped.push({ reason: 'link: ' + s }); }
  else skipped.push({ reason: 'ledger keeper returned no result; dry-run observation not written' });
} else if (!written.length) {
  log('no initiative written; ledger untouched');
} else {
  for (const w of written) {
    const l = await agent(
      [
        'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md before writing. Ledger: company-profile/' + companyId + '/soc/main.jsonl (append-only). Write EVERY record by piping JSON to `node .claude/scripts/soc/append.mjs ' + companyId + ' -`; never edit the ledger directly.',
        'Initiative ' + w.initiativeId + ' ("' + w.draft.initiative.title + '") now remediates findings ' + JSON.stringify(w.draft.initiative.findingIds || []) + ' and mitigates risks ' + JSON.stringify(w.draft.initiative.riskIds || []) + '; its dueAt is ' + w.draft.initiative.dueAt + '.',
        'Step 1 - findings: for each finding id, take its LATEST record (last line with that id), copy it in full, set supersedes = the same id (findings keep their identity across supersessions), initiativeId = "' + w.initiativeId + '", status "triaged" when it was "open" (keep remediating/triaged as is), recordedAt = now, fresh provenance; append it. Skip and report any finding whose latest status is no longer open|triaged|remediating.',
        'Step 2 - risks: for each risk id, copy its latest record, supersedes = same id, append to mitigations[] {description: "' + w.draft.initiative.title + '", initiativeId: "' + w.initiativeId + '", dueAt: "' + w.draft.initiative.dueAt + '"}, recordedAt = now, fresh provenance. Follow the risk lifecycle open -> investigating -> mitigating without skipping a state: when the latest status is "open", first append a superseding copy with status "investigating" (no mitigation added), then append the mitigating record; when it is "investigating", append only the mitigating record; keep "mitigating" as is (still add the mitigation). Skip and report any risk whose latest status is closed, accepted or deviation-approved.',
        'Step 2b - controls: for each ledger control id in ' + JSON.stringify(w.group.ledgerControlIds || []) + ' that exists as a control record, when its latest implementationStatus is "unknown" or "not-implemented", append a superseding copy (supersedes = same id) with implementationStatus "planned" (maxwell-conventions section 5: planned once an initiative exists), recordedAt = now and fresh provenance; never downgrade partial, implemented, not-applicable or alternative, and leave effectiveness unchanged. Return the control ids you superseded in skipped as "control <id> -> planned" so the run logs them.',
        'Step 3 - observation: append one observation (id obs_<ULID>, controlIds = ' + JSON.stringify(w.group.ledgerControlIds || []) + ' (instrument-qualified) filtered to ids that exist as control records; the schema requires at least one, so when none exists skip this observation and say so in skipped), title "Initiative ' + w.initiativeId + ' raised for <n> finding(s) and <m> risk(s)", description naming the change type, owner, dueAt and the task ids ' + JSON.stringify(w.taskIds) + ', methods ["' + WORKFLOW + '"], subjects = ' + JSON.stringify(w.draft.initiative.targets || []) + ', collectedAt, result "not-applicable", evidence [{type: "workspace-file", ref: "company-profile/' + companyId + '/change_management/master.json"}, {type: "workspace-file", ref: "company-profile/' + companyId + '/change_management/initiatives/' + w.initiativeId + '/timeline.json"}], tags ' + JSON.stringify(BASE_TAGS) + ').',
        timeRule, provenanceRule,
        'After writing run `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/soc/main.jsonl` and fix anything it reports. Do not touch summary.md or change_management files. Return {findingIds, riskIds, observationIds, skipped} where skipped lists every record you could not write and why (plus the control supersessions noted above).',
      ].join('\n'),
      { label: 'link ' + w.initiativeId, phase: 'Link', agentType: 'soc-ledger-keeper', schema: LINK_SCHEMA, effort: 'medium' },
    );
    if (!l) { skipped.push({ id: w.initiativeId, reason: 'ledger keeper returned no result; findings/risks not linked to ' + w.initiativeId }); continue; }
    noteSession(l);
    linked.findingIds.push(...(l.findingIds || []));
    linked.riskIds.push(...(l.riskIds || []));
    linked.observationIds.push(...(l.observationIds || []));
    for (const s of l.skipped || []) skipped.push({ id: w.initiativeId, reason: 'link: ' + s });
    log(w.initiativeId + ': linked ' + (l.findingIds || []).length + ' finding(s), ' + (l.riskIds || []).length + ' risk(s)');
  }
}

// ---- Phase 6: Summary -----------------------------------------------------------------------------------
phase('Summary');
let summary = null;
if (dryRun) {
  log('dry-run: summary.md left unchanged');
} else if (!written.length) {
  log('nothing was written; summary.md left unchanged');
} else {
  summary = await agent(
    [
      'You are the report-writer. Refresh the "initiatives" section of company-profile/' + companyId + '/summary.md after the ' + WORKFLOW + ' workflow. Read .claude/skills/report-templates/SKILL.md (section 4, Initiatives template) and .claude/skills/maxwell-conventions/SKILL.md first.',
      'Sources of truth: company-profile/' + companyId + '/change_management/master.json, initiatives/*/timeline.json and tasks/*.json, and the ledger company-profile/' + companyId + '/soc/main.jsonl. Render the counters line and the initiatives table (overdue rows first), the "### Blocked" and "### Evidence requests" subsections exactly as the template says. New this run: ' + JSON.stringify(written.map((w) => w.initiativeId)) + '.',
      'Edit only that section and the frontmatter: bump version minor, keep "sections" accurate and in canonical order, and recompute provenance.inputsHash exactly as the template describes. Leave every other section byte-for-byte unchanged. Do not create any other file.',
      timeRule, provenanceRule,
      'Validate with `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/summary.md` and return {updated, openInitiatives, overdueInitiatives, version, notes}.',
    ].join('\n'),
    { label: 'summary', phase: 'Summary', agentType: 'report-writer', schema: SUMMARY_SCHEMA, effort: 'medium' },
  );
  if (!summary) skipped.push({ reason: 'report-writer returned no result; summary.md initiatives section may be stale' });
  else { noteSession(summary); log('summary.md initiatives: ' + summary.openInitiatives + ' open, ' + (summary.overdueInitiatives || 0) + ' overdue, version ' + (summary.version || '?')); }
}

log('done: ' + written.length + ' initiative(s), ' + written.reduce((n, w) => n + w.taskIds.length, 0) + ' task(s), ' + linked.findingIds.length + ' finding(s) and ' + linked.riskIds.length + ' risk(s) linked, ' + skipped.length + ' skipped item(s) logged');
return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  targets: groups.map((g) => g.groupId + ':' + (g.findingIds || []).concat(g.riskIds || []).join(',')),
  observations: linked.observationIds.length,
  findings: linked.findingIds.length,
  risks: linked.riskIds.length,
  initiatives: written.length,
  tasks: written.reduce((n, w) => n + w.taskIds.length, 0),
  suggestions: 0,
  ids: { initiativeIds: written.map((w) => w.initiativeId), taskIds: written.flatMap((w) => w.taskIds.map((t) => w.initiativeId + '/' + t)), findingIds: linked.findingIds, riskIds: linked.riskIds, observationIds: linked.observationIds },
  summary,
  skipped,
  sessionIds: [...sessionIds],
};
