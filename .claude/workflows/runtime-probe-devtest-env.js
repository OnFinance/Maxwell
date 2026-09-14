// runtime-probe-devtest-env: read-only runtime probe of running container workloads (Kubernetes / Docker hosts) for one company.
// Tier-filtered: only environments whose tier is dev, test or devtest; every other tier is logged as skipped with the workflow that owns it.
// args: { companyId (required), appIds?: string[], envIds?: string[] (bare "dev-mumbai" or qualified "trading-api/dev-mumbai"), dryRun?: boolean,
//         now?: RFC3339 'Z' string (the ONLY clock for allowedWindows/changeFreeze decisions; absent or malformed => every would-be-live environment is blocked with NO_RUN_TIMESTAMP), sessionId?: string, runId?: string }
// Shape: Scout (apps -> env files, grouped by tier devtest|qa|prod) -> inline preconditions from
// runtime-probe-rules-of-engagement (run timestamp, readOnly, method, prod gating on explicit envIds, changeFreeze, allowedWindows,
// rateLimitPerMinute) -> Probe: container-prober per (app, env); live probes run one at a time because they share one OCSF export
// file per agent per workflow per session (RoE section 5), dry-run and blocked plans run concurrently -> Refute: evidence and
// regulatory-mapping lenses (plus production-safety on prod/dr; majority rule, unanimity for high/critical, production-safety veto)
// for ordinary records; abort-derived safety records (incidents, the unredactable-data risk, the read-write credential finding)
// are fail-safe: written unless every lens refutes; a refuted assessed observation is downgraded to inconclusive, never dropped
// -> Dedup (barrier) -> soc-ledger-keeper appends via soc/append.mjs with soc-ledger section 8 supersession and closes with
// soc/version.mjs -> report-writer refreshes summary.md. CISO alerts come from pre-refutation incident candidates.
// Dry run: no command touches any target; only inconclusive "DRY RUN:" observations and evidence requests are produced.
export const meta = {
  name: 'runtime-probe-devtest-env',
  description: 'Read-only runtime probe of running containers in dev, test and devtest environments only; the CNT-01..CNT-11 checks of runtime-probe-appcontainers with devtest SLA weighting.',
  phases: [
    { title: 'Scout', detail: 'List every (app, env) pair from applications/*/env/*.json, group by tier and apply the rules-of-engagement preconditions inline (args.now is the only clock); log every skipped or blocked environment' },
    { title: 'Probe', detail: 'container-prober runs the read-only CNT-01..CNT-11 checks per (app, env) within rateLimitPerMinute (live probes one at a time: shared OCSF export), or plans them in dry-run / blocked mode' },
    { title: 'Refute', detail: 'refuter lenses per candidate (evidence, regulatory-mapping, plus production-safety on prod/dr); safety records are fail-safe; refuted assessed observations become inconclusive' },
    { title: 'Dedup', detail: 'Barrier: merge surviving findings by fingerprint and observations by (controls, subjects, check), keeping the worst result' },
    { title: 'Write', detail: 'soc-ledger-keeper appends controls, observations, findings (fingerprint supersession), risks and incidents via soc/append.mjs, then writes soc/versions/commit_<n>.diff' },
    { title: 'Summary', detail: 'report-writer refreshes the control-summary and open-findings sections of summary.md and returns counts' },
  ],
};

const WORKFLOW = 'runtime-probe-devtest-env';
const PROBE_AGENT = 'container-prober';
const TIER_GROUPS = { devtest: ['dev', 'test', 'devtest'], qa: ['qa', 'uat', 'staging'], prod: ['prod', 'dr'] };
const TIER_FILTER = ['devtest']; // null = every tier group; otherwise the only group this workflow may touch
const REQUIRE_ENV_IDS = false;
const BASE_TAGS = ['runtime-probe', 'containers'];
const CHECKS = 'CNT-01 running image digest vs applications/<app>/images/<image_id>.json (mutable tags fail), CNT-02 non-root UID / runAsNonRoot, CNT-03 readOnlyRootFilesystem, CNT-04 no privileged / hostPID / hostNetwork / hostIPC / CAP_SYS_ADMIN and capabilities dropped, CNT-05 CPU and memory requests and limits, CNT-06 no secrets injected as literal env vars (names only, never values), CNT-07 log shipping agent or sidecar present, CNT-08 log retention >= 180 days stored in India (CERT-In 2022; one year for pii/spdi under DPDP Rules 2025), CNT-09 base image and registry-scan patch level within the SLA table, CNT-10 CycloneDX SBOM present and non-empty for every running digest (SEBI CSCRF GV.SC.S5), CNT-11 pod security admission restricted in qa/prod, plus liveness/readiness probes and imagePullPolicy/registry are the company\'s own';
const BLOCKED_CONTROL_HINT = 'sebi-cscrf-2024 GV.SC.S5 (SBOM), PR.DS.S6 (software integrity), PR.IP.S1 (baseline configuration and hardening), PR.MA.S3 and PR.IP.S12 (patching, vulnerability management), PR.AA.S3 and PR.DS.S1 (least privilege, secrets), PR.AA.S8 and DE.CM.S2 (log management, monitoring); cert-in-directions-2022 Dir-iv (180-day log retention in India); dpdp-rules-2025 6(1)(b), 6(1)(c) and 6(1)(e) when dataClassification contains pii or spdi; rbi-cyber-tech-directions-2026 secure configuration and log management clauses for banks/NBFCs/PSOs only when its catalog file exists';
const SAFETY_RULE_IDS = ['probe-credential-not-read-only', 'ROE-RW-CREDENTIAL'];
const UNREDACTABLE_RISK_TITLE = 'Probe exposed to unredactable sensitive data';
const MAX_REFUTED_CLAIMS_PER_TARGET = 40; // ordinary findings + risks + assessed observations; keeps a large estate under the 1000-agent cap
const CATALOG_RULE = 'Control ids come from .claude/skills/regulatory-catalogs/references/catalogs/<instrument>.catalog.json (and references/instruments.json, references/sla-table.json; read .claude/skills/regulatory-catalogs/SKILL.md when it exists). If an instrument has no catalog file, omit that regulatoryRef and list "catalog missing: <instrument>" in skipped; never invent a controlId. If sla-table.json is missing, list "sla-table missing" in skipped and never take SLA days or regulator clocks from memory.';

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const rawNow = args ? args.now : undefined;
const NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const nowIsValid = (v) => typeof v === 'string' && NOW_RE.test(v) && !Number.isNaN(new Date(v).getTime()) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
const nowProblem = rawNow === undefined || rawNow === null || rawNow === ''
  ? 'NO_RUN_TIMESTAMP: args.now not supplied'
  : nowIsValid(rawNow) ? null : 'NO_RUN_TIMESTAMP: args.now "' + String(rawNow).slice(0, 40) + '" is not an RFC 3339 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)';
const now = nowProblem ? null : rawNow; // only the caller's timestamp is trusted for window/freeze decisions (resume-safe)
const NOW_INPUT = now || 'BLOCKED:NO_RUN_TIMESTAMP';
const sessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.filter((e) => typeof e === 'string' && e).length ? args.envIds.filter((e) => typeof e === 'string' && e) : null;
const exportDir = 'kpis/data/raw/sessions/' + (sessionId || runId || 'unattributed-' + WORKFLOW);
const ocsfExportPath = exportDir + '/' + WORKFLOW + '.' + PROBE_AGENT + '.ocsf.export.json';
const textExportPath = exportDir + '/' + WORKFLOW + '.' + PROBE_AGENT + '.text.export.json';
const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const emptyResult = (extra) => ({ companyId, workflow: WORKFLOW, dryRun, now, nowProblem, tiers: { devtest: 0, qa: 0, prod: 0 }, targets: [], controls: 0, observations: 0, findings: 0, reseenFindings: 0, risks: 0, incidents: 0, initiatives: 0, suggestions: 0, evidenceRequests: [], cisoAlerts: [], skipped, sessionIds: [...sessionIds], ...extra });
if (nowProblem) log(nowProblem + ': every environment that would be probed live is blocked and recorded as inconclusive with an evidence request (runners should inject args.now)');
if (REQUIRE_ENV_IDS && !envFilter) log(WORKFLOW + ': args.envIds not supplied, so every prod/dr environment is recorded as blocked (PROD_GATING) with an inconclusive observation and an evidence request; re-run with envIds naming each environment, e.g. { companyId: "' + companyId + '", envIds: ["trading-api/prod-mumbai"] }');
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const tierGroupOf = (tier) => Object.keys(TIER_GROUPS).find((g) => TIER_GROUPS[g].includes(tier)) || null;
const tierWorkflowFor = (group) => ({ devtest: 'runtime-probe-devtest-env', qa: 'runtime-probe-qa-env', prod: 'runtime-probe-prod-env' }[group] || 'runtime-probe-sandboxes');
const envNamedQualified = (t) => Boolean(envFilter && envFilter.includes(t.appId + '/' + t.envId));
const envNamed = (t) => Boolean(envFilter && (envFilter.includes(t.envId) || envNamedQualified(t)));
const errText = (e) => String((e && e.message) || e).slice(0, 300);
const clip = (s, n) => { const v = String(s || ''); return v.length > n ? v.slice(0, n - 3) + '...' : v; };

// ---- Rules-of-engagement time checks (pure functions of args.now so a resumed run decides the same way) ----------
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMinutes = (hhmm) => { const parts = String(hhmm).split(':'); return Number(parts[0]) * 60 + Number(parts[1] || 0); };
const windowIsValid = (w) => Boolean(w && Array.isArray(w.daysOfWeek) && w.daysOfWeek.length && w.daysOfWeek.every((d) => DAY_NAMES.includes(d)) && HHMM_RE.test(String(w.startUtc)) && HHMM_RE.test(String(w.endUtc)));
const inWeeklyWindow = (nowIso, w) => {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime()) || !windowIsValid(w)) return false;
  const day = DAY_NAMES[d.getUTCDay()];
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const start = toMinutes(w.startUtc); const end = toMinutes(w.endUtc);
  if (start === end) return w.daysOfWeek.includes(day); // whole day
  if (end > start) return w.daysOfWeek.includes(day) && minute >= start && minute < end;
  // wraps past midnight: the second half belongs to the day the window started on
  const prevDay = DAY_NAMES[(d.getUTCDay() + 6) % 7];
  return (w.daysOfWeek.includes(day) && minute >= start) || (w.daysOfWeek.includes(prevDay) && minute < end);
};
const freezeIsValid = (f) => Boolean(f && nowIsValid(f.from) && nowIsValid(f.to));
const inFreeze = (nowIso, f) => {
  const t = new Date(nowIso).getTime(); const from = new Date(f.from).getTime(); const to = new Date(f.to).getTime();
  return !Number.isNaN(t) && !Number.isNaN(from) && !Number.isNaN(to) && t >= from && t < to;
};
const describeWindows = (ws) => (ws || []).map((w) => ((w && w.daysOfWeek) || []).join('/') + ' ' + (w && w.startUtc) + '-' + (w && w.endUtc) + 'Z').join(', ');

// ---- Schemas for structured agent output -------------------------------------------------------------------------
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['targets', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    harness: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    ciso: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } } },
    existingControlIds: { type: 'array', items: { type: 'string' } },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'envId', 'tier', 'method', 'readOnly'],
        properties: {
          appId: { type: 'string' },
          envId: { type: 'string' },
          envFile: { type: 'string' },
          tier: { type: 'string' },
          exposure: { type: 'string' },
          method: { type: 'string' },
          readOnly: { type: 'boolean' },
          credentialKey: { type: 'string' },
          rateLimitPerMinute: { type: 'integer' },
          allowedWindows: { type: 'array', items: { type: 'object', required: ['daysOfWeek', 'startUtc', 'endUtc'], properties: { daysOfWeek: { type: 'array', items: { type: 'string' } }, startUtc: { type: 'string' }, endUtc: { type: 'string' } } } },
          changeFreeze: { type: 'array', items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } } } },
          provider: { type: 'string' },
          region: { type: 'string' },
          cluster: { type: 'string' },
          namespace: { type: 'string' },
          dataClassification: { type: 'array', items: { type: 'string' } },
          logsRetentionDays: { type: 'integer' },
          logsInIndia: { type: 'boolean' },
          imageIds: { type: 'array', items: { type: 'string' } },
          sbomIds: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string' },
          notes: { type: 'string' },
        },
      },
    },
    skipped: { type: 'array', items: { type: 'object', required: ['reason'], properties: { appId: { type: 'string' }, envId: { type: 'string' }, reason: { type: 'string' } } } },
  },
};

const REG_REF = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const EVIDENCE = { type: 'array', items: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string' }, ref: { type: 'string' }, sha256: { type: 'string' }, collectedAt: { type: 'string' }, description: { type: 'string' } } } };
const CANDIDATE_RECORD = { type: 'object', required: ['kind', 'id', 'title'], properties: { kind: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] }, confidence: { type: 'string' }, result: { type: 'string', enum: ['satisfied', 'not-satisfied', 'partial', 'not-applicable', 'inconclusive'] }, controlIds: { type: 'array', items: { type: 'string' } }, regulatoryRefs: { type: 'array', items: REG_REF }, fingerprint: { type: 'string' }, status: { type: 'string' }, methods: { type: 'array', items: { type: 'string' } }, evidence: EVIDENCE } };
const PROBE_SCHEMA = {
  type: 'object',
  required: ['appId', 'envIds', 'aborted', 'checks', 'candidateObservations', 'candidateFindings', 'evidenceRequests', 'exports'],
  properties: {
    sessionId: { type: 'string' },
    agent: { type: 'string' },
    workflow: { type: 'string' },
    companyId: { type: 'string' },
    appId: { type: 'string' },
    envIds: { type: 'array', items: { type: 'string' } },
    dryRun: { type: 'boolean' },
    aborted: { type: 'boolean' },
    abortReason: { type: 'string' },
    access: { type: 'object', properties: { method: { type: 'string' }, credentialKey: { type: 'string' }, identityReadOnly: { type: 'boolean' }, window: { type: 'string' }, commandsExecuted: { type: 'integer' } } },
    checks: { type: 'array', items: { type: 'object', required: ['checkId', 'status'], properties: { envId: { type: 'string' }, checkId: { type: 'string' }, ruleId: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'warning', 'unknown', 'not-applicable', 'inconclusive'] }, subject: { type: 'string' }, evidenceRef: { type: 'string' } } } },
    candidateObservations: { type: 'array', items: CANDIDATE_RECORD },
    candidateFindings: { type: 'array', items: CANDIDATE_RECORD },
    candidateRisks: { type: 'array', items: CANDIDATE_RECORD },
    candidateIncidents: { type: 'array', items: CANDIDATE_RECORD },
    evidenceRequests: { type: 'array', items: { type: 'object', required: ['envId', 'ask'], properties: { envId: { type: 'string' }, checkId: { type: 'string' }, controlIds: { type: 'array', items: { type: 'string' } }, ask: { type: 'string' }, owner: { type: 'string' } } } },
    exports: { type: 'array', items: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sha256: { type: 'string' }, events: { type: 'integer' } } } },
    skipped: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    sessionId: { type: 'string' },
    refuted: { type: 'boolean' },
    lens: { type: 'string' },
    confidence: { type: 'string' },
    reason: { type: 'string' },
    checked: { type: 'array', items: { type: 'string' } },
    unredactedDataInExport: { type: 'boolean' },
    correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
    correctedRegulatoryRefs: { type: 'array', items: REG_REF },
    correctedControlIds: { type: 'array', items: { type: 'string' } },
  },
};

const WRITE_SCHEMA = {
  type: 'object',
  required: ['observationIds', 'findingIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    controlIds: { type: 'array', items: { type: 'string' } },
    observationIds: { type: 'array', items: { type: 'string' } },
    findingIds: { type: 'array', items: { type: 'string' } },
    supersededFindingIds: { type: 'array', items: { type: 'string' } },
    riskIds: { type: 'array', items: { type: 'string' } },
    incidentIds: { type: 'array', items: { type: 'string' } },
    versionDiff: { type: 'string' },
    skipped: { type: 'array', items: { type: 'string' } },
  },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['updated', 'openFindings'],
  properties: {
    sessionId: { type: 'string' },
    updated: { type: 'boolean' },
    openFindings: { type: 'integer' },
    bySeverity: { type: 'object', properties: { critical: { type: 'integer' }, high: { type: 'integer' }, medium: { type: 'integer' }, low: { type: 'integer' }, info: { type: 'integer' } } },
    controlsAssessed: { type: 'integer' },
    version: { type: 'string' },
    notes: { type: 'string' },
  },
};

// ---- Phase 1: Scout ---------------------------------------------------------------------------------------------
phase('Scout');
log('Scouting ' + companyId + ' for container environments' + (TIER_FILTER ? ' (tier group ' + TIER_FILTER.join('/') + ': ' + TIER_FILTER.map((g) => TIER_GROUPS[g].join('|')).join(', ') + ')' : ' (all tiers)') + (appFilter ? ' apps: ' + appFilter.join(', ') : '') + (envFilter ? ' envs: ' + envFilter.join(', ') : '') + (dryRun ? ' [DRY RUN]' : '') + ' now ' + NOW_INPUT);
const scout = await agent(
  [
    'You are scouting the Maxwell workspace for the ' + WORKFLOW + ' workflow. Company: ' + companyId + '. Strictly read-only: do not write or edit any file (do not apply any drift to details.json or anything else), do not use Edit, WebSearch or WebFetch, and do not touch any live system. Use only Read, Glob and Grep.',
    'Read company-profile/' + companyId + '/details.json: return its entityTypes, and ciso = {name, email, phone} of the contacts[] entry whose role is "ciso" (omit ciso when there is none).',
    'List every application directory under applications/.',
    appFilter ? 'Only consider these appIds: ' + appFilter.join(', ') + '. Add a skipped entry {appId, reason: "filtered by args.appIds"} for every other app.' : 'Consider every application.',
    'For every applications/<app_id>/env/<env_id>.json return one target with: appId, envId, envFile (the path), tier, exposure, method (probeAccess.method), readOnly (probeAccess.readOnly, literally as found), credentialKey (probeAccess.credentialKey when present), rateLimitPerMinute, allowedWindows (verbatim), changeFreeze (verbatim), provider/region/cluster/namespace from hosting, dataClassification, observability.logsRetentionDays and logsInIndia, imageIds (the <image_id> of every applications/<app_id>/images/<image_id>.json that is not a *.cdx.json), sbomIds (the <image_id> of every applications/<app_id>/images/<image_id>.cdx.json), owner (the env or app owner name/email if the env record or README names one) and notes. Do NOT filter by tier or envIds yourself: the workflow applies the tier and prod-gating rules; list every environment you find.',
    'Never read applications/<app_id>/credentials.json and never run sops. Add a skipped entry for an app with no env/ directory ({appId, reason: "no env/*.json - run refresh-ctx"}) and for any env file that fails to parse.',
    'Also read company-profile/' + companyId + '/soc/main.jsonl and return existingControlIds: the ids of every kind "control" record (instrument-qualified, e.g. sebi-cscrf-2024:GV.SC.S5).',
    'Return harness = "claude-code" or "opencode" (whichever you run under). Return {harness, entityTypes, ciso, existingControlIds, targets, skipped}; list every app you considered either as a target or as skipped so nothing is dropped silently.',
  ].filter(Boolean).join('\n'),
  { label: 'scout', phase: 'Scout', agentType: 'ctx-researcher', schema: SCOUT_SCHEMA, effort: 'low' },
);
if (!scout) {
  const reason = 'scout returned nothing; nothing probed or written (the OpenCode runner flag --dry-run starts no agent sessions: request a probe dry run with args.dryRun only)';
  log(reason);
  skipped.push({ reason });
  return emptyResult({ scoutFailed: true });
}
noteSession(scout);
const harness = scout.harness || 'claude-code';
const entityTypes = scout.entityTypes || [];
const ciso = scout.ciso && (scout.ciso.name || scout.ciso.email) ? scout.ciso : null;
const existingControlIds = scout.existingControlIds || [];
for (const s of scout.skipped || []) { skipped.push(s); log('skipped ' + (s.appId || '?') + (s.envId ? '/' + s.envId : '') + ': ' + s.reason); }

// Inline preconditions (rules-of-engagement section 1). A failed precondition does not drop the environment: it is
// probed in "blocked" mode, which runs no command and yields one inconclusive observation plus an evidence request.
const scoutTargets = (scout.targets || []).filter((t) => t && t.appId && t.envId);
const appsByEnvId = new Map();
for (const t of scoutTargets) appsByEnvId.set(t.envId, (appsByEnvId.get(t.envId) || new Set()).add(t.appId));
const targets = [];
for (const t of scoutTargets) {
  const label = t.appId + '/' + t.envId;
  const group = tierGroupOf(t.tier);
  if (!group) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'tier "' + t.tier + '" is not a container-probe tier (sandbox tier belongs to runtime-probe-sandboxes)' }); log('skipped ' + label + ': tier ' + t.tier); continue; }
  if (TIER_FILTER && !TIER_FILTER.includes(group)) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'tier "' + t.tier + '" (' + group + ') is outside this workflow; use ' + tierWorkflowFor(group) + ' or runtime-probe-appcontainers' }); log('skipped ' + label + ': tier ' + t.tier + ' outside ' + WORKFLOW); continue; }
  if (envFilter && !envNamed(t)) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'filtered by args.envIds' }); log('skipped ' + label + ': filtered by args.envIds'); continue; }
  const blockers = [];
  const wouldBeLive = !dryRun;
  if (wouldBeLive && nowProblem) blockers.push(nowProblem);
  if (group === 'prod' && !envFilter) blockers.push('PROD_GATING: tier ' + t.tier + ' is probed only when args.envIds names "' + label + '" explicitly (no wildcard, no inference from appIds)');
  else if (group === 'prod' && !envNamedQualified(t) && (appsByEnvId.get(t.envId) || new Set()).size > 1) blockers.push('PROD_GATING: args.envIds names "' + t.envId + '" without an app and ' + appsByEnvId.get(t.envId).size + ' applications have an environment with that id; name it as "' + label + '" or narrow with appIds');
  if (t.readOnly !== true) blockers.push('PROBE_ACCESS_NOT_READ_ONLY: probeAccess.readOnly must be literally true');
  if (t.method === 'none') blockers.push('probeAccess.method is none: evidence must be requested from humans');
  else if (t.method !== 'kubeconfig' && t.method !== 'docker-socket' && t.method !== 'cloud-api') blockers.push('METHOD_UNSUITABLE: probeAccess.method ' + t.method + ' cannot enumerate container workloads (needs kubeconfig, docker-socket or cloud-api)');
  else if (!t.credentialKey) blockers.push('probeAccess.credentialKey missing for method ' + t.method);
  const badFreezes = (t.changeFreeze || []).filter((f) => !freezeIsValid(f));
  if (badFreezes.length) blockers.push('CHANGE_FREEZE_UNPARSEABLE: ' + badFreezes.map((f) => JSON.stringify(f)).join(', ') + ' (from/to must be RFC 3339 UTC; a freeze that cannot be evaluated closes the environment)');
  const badWindows = (t.allowedWindows || []).filter((w) => !windowIsValid(w));
  if (badWindows.length) blockers.push('ALLOWED_WINDOWS_UNPARSEABLE: ' + badWindows.map((w) => JSON.stringify(w)).join(', ') + ' (daysOfWeek sun..sat, startUtc/endUtc HH:MM)');
  if (now) {
    const freeze = (t.changeFreeze || []).filter(freezeIsValid).find((f) => inFreeze(now, f));
    if (freeze) blockers.push('CHANGE_FREEZE_ACTIVE: ' + freeze.from + ' to ' + freeze.to + (freeze.reason ? ' (' + freeze.reason + ')' : ''));
    const validWindows = (t.allowedWindows || []).filter(windowIsValid);
    if (Array.isArray(t.allowedWindows) && t.allowedWindows.length && !validWindows.some((w) => inWeeklyWindow(now, w))) blockers.push('OUTSIDE_ALLOWED_WINDOW: ' + now + ' is outside allowedWindows ' + describeWindows(t.allowedWindows));
  }
  const declaredRate = Number.isInteger(t.rateLimitPerMinute) && t.rateLimitPerMinute > 0 ? t.rateLimitPerMinute : 30;
  const rateLimit = group === 'prod' ? Math.min(declaredRate, 60) : declaredRate;
  if (group === 'prod' && declaredRate > 60) log(label + ': declared rateLimitPerMinute ' + declaredRate + ' capped to 60 on prod (rules of engagement)');
  const mode = blockers.length ? 'blocked' : dryRun ? 'dry-run' : 'live';
  if (blockers.length) log(label + ' blocked (' + blockers.join('; ') + '); will record an inconclusive observation and an evidence request');
  targets.push({ ...t, group, rateLimit, mode, blockers });
}
if (envFilter) {
  for (const id of envFilter) {
    const found = id.includes('/') ? scoutTargets.some((t) => t.appId + '/' + t.envId === id) : scoutTargets.some((t) => t.envId === id);
    if (!found) { skipped.push({ envId: id, reason: 'args.envIds names "' + id + '" but no matching applications/' + (appFilter ? '{' + appFilter.join(',') + '}' : '*') + '/env/<env_id>.json was found' }); log('skipped ' + id + ': named in args.envIds but not found'); }
  }
}
const byGroup = { devtest: 0, qa: 0, prod: 0 };
for (const t of targets) byGroup[t.group] += 1;
log(targets.length + ' environment(s) in scope: devtest ' + byGroup.devtest + ', qa ' + byGroup.qa + ', prod ' + byGroup.prod + '; ' + targets.filter((t) => t.mode === 'blocked').length + ' blocked, ' + skipped.length + ' skipped; ' + existingControlIds.length + ' existing control record(s)');
if (!targets.length) {
  log('No container environment in scope for ' + companyId + ' under ' + WORKFLOW + '; nothing to probe');
  return emptyResult({ tiers: byGroup });
}

// ---- Shared prompt rules -----------------------------------------------------------------------------------------
const timeRule = (now
  ? 'Use ' + now + ' as recordedAt, collectedAt, firstSeenAt and lastSeenAt unless a command returned later (then use the time it returned, from `date -u`).'
  : 'No valid args.now (' + nowProblem + '): no environment is probed live in this run. Stamp recordedAt, collectedAt, generatedAt, firstSeenAt and lastSeenAt from one `date -u +%Y-%m-%dT%H:%M:%SZ` reading taken when you start; it is a record timestamp only, never a window or freeze decision.')
  + ' RFC 3339 UTC with trailing Z. expiresAt = collectedAt + 30 days for prod/dr, + 90 days otherwise.';
const provenanceRule = 'Every record carries provenance: harness "' + harness + '", generatedAt, sessionId' + (sessionId ? ' "' + sessionId + '"' : ' (your own harness session id)') + (runId ? ', runId "' + runId + '"' : ', runId from MAXWELL_RUN_ID when set') + ', workflow "' + WORKFLOW + '", agent = your agent name.';
const targetKeyOf = (t) => 'environment:' + t.appId + '/' + t.envId;

// ---- Phase 2: Probe (live probes one at a time: they merge into one shared export file; plans run concurrently) ---
const probePrompt = (t) => [
  'You are the ' + PROBE_AGENT + ' running the ' + WORKFLOW + ' workflow. Inputs: companyId ' + companyId + ' (entityTypes: ' + (entityTypes.join(', ') || 'unknown') + '), appId ' + t.appId + ', envId ' + t.envId + ' (tier ' + t.tier + ', group ' + t.group + ', exposure ' + (t.exposure || 'unknown') + '), workflow ' + WORKFLOW + ', sessionId ' + (sessionId || '<your own session id>') + ', runId ' + (runId || '<MAXWELL_RUN_ID or omit>') + ', harness ' + harness + ', dryRun ' + String(t.mode !== 'live') + ', now ' + NOW_INPUT + ', envIds (as the workflow received them) ' + JSON.stringify(envFilter || []) + ', exportDir ' + exportDir + '.',
  now
    ? 'now is the caller\'s clock: evaluate allowedWindows and changeFreeze against ' + now + ' only, never your own clock.'
    : 'now is the blocked marker BLOCKED:NO_RUN_TIMESTAMP because ' + nowProblem + '. That is a supplied input, not MISSING_INPUT: do not abort; this environment runs in ' + t.mode + ' mode, no window or freeze decision is made from your own clock, and `date -u` is used only to stamp records.',
  'Read first, in this order: .claude/skills/runtime-probe-rules-of-engagement/SKILL.md (binding), .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/credentials-sops/SKILL.md, .claude/skills/ocsf-findings/SKILL.md, .claude/skills/soc-ledger/SKILL.md (sections 5-7), then the regulatory catalogs. ' + CATALOG_RULE,
  'Then read applications/' + t.appId + '/env/' + t.envId + '.json, applications/' + t.appId + '/README.md, applications/' + t.appId + '/images/*.json (registered digests: ' + ((t.imageIds || []).join(', ') || 'none registered') + '; SBOM refs: ' + ((t.sbomIds || []).join(', ') || 'none') + '), company-profile/' + companyId + '/details.json and company-profile/' + companyId + '/sdlc/policy.json.',
  'Environment facts from the scout: provider ' + (t.provider || '?') + ', region ' + (t.region || '?') + ', cluster ' + (t.cluster || '?') + ', namespace ' + (t.namespace || '(none declared: use --all-namespaces sparingly)') + ', probeAccess.method ' + t.method + (t.credentialKey ? ', credentialKey ' + t.credentialKey : '') + ', dataClassification ' + ((t.dataClassification || []).join(', ') || 'none') + ', declared log retention ' + (t.logsRetentionDays != null ? t.logsRetentionDays + ' days' : 'unknown') + (t.logsInIndia != null ? ' (logsInIndia ' + t.logsInIndia + ')' : '') + ', allowedWindows ' + (describeWindows(t.allowedWindows) || 'any time') + ', changeFreeze ' + ((t.changeFreeze || []).length || 'none') + ' window(s).',
  'RATE LIMIT: at most ' + t.rateLimit + ' target commands per minute for this environment (one CLI invocation = one command; prefer -o json to cut calls). Count them and return the count as access.commandsExecuted.' + (t.group === 'prod' ? ' This is a PRODUCTION-tier environment: read-only command families only, never exceed 60/min, stop at the first permission error repeat, never `kubectl get secret`, never logs/exec/port-forward.' : ''),
  t.mode === 'live'
    ? 'LIVE PROBE (read-only). Preconditions already checked by the workflow against now ' + now + ': changeFreeze and allowedWindows OK, readOnly true, method ' + t.method + '. Re-check them yourself against that same now; if any fails, stop and answer aborted with the reason code. Wall clock (RoE section 1, mid-probe abort only): before the first target command and again before each check group take a fresh `date -u +%Y-%m-%dT%H:%M:%SZ` and re-evaluate changeFreeze ' + JSON.stringify(t.changeFreeze || []) + ' ([from, to)) and allowedWindows ' + (describeWindows(t.allowedWindows) || '(none declared: any time)') + ' (endUtc < startUtc wraps past midnight) against it; a fresh reading inside a freeze or outside every window aborts with WINDOW_CLOSED after the running command finishes. That reading never turns a no-go into a go. Resolve the credential locator with `node .claude/scripts/creds/sops.mjs get ' + t.appId + ' ' + (t.credentialKey || '<credentialKey>') + '`; abort unless scope is read-only and its envIds contains ' + t.envId + '. Prove the identity is read-only first (kubectl auth can-i --list / docker info / aws sts get-caller-identity) and abort with CREDENTIAL_NOT_READ_ONLY plus the candidate finding described below if it can write. Then run the checks: ' + CHECKS + '. Only the command families allowed by the rules of engagement (kubectl get/describe/top/auth can-i/version/api-resources, docker inspect/ps/images/version/info, cloud describe/list/get); every command through node .claude/scripts/sandbox/exec.mjs --company <company_id> --app <app_id> --env <env_id> -- <command> (sandbox-executors skill), which applies the 60-second timeout and output cap; no apply/create/patch/delete/exec/attach/cp/port-forward/logs, no `kubectl get ... -o yaml` of a Secret.'
    : t.mode === 'dry-run'
      ? 'DRY RUN: run NO command against any target. Read the workspace, resolve only the credential REFERENCE (`node .claude/scripts/creds/sops.mjs get ' + t.appId + ' ' + (t.credentialKey || '<credentialKey>') + '`, it prints a locator, never a value), and return the full plan: for every check (' + CHECKS + ') the exact command line you would run with locators shown as $NAME, the control ids it evidences, and the evidence a human would have to attach instead. Return candidateObservations with result "inconclusive", description starting "DRY RUN:", no toolOutput; candidateFindings, candidateRisks and candidateIncidents must be empty; do not write an export file.'
      : 'BLOCKED: a rules-of-engagement precondition failed for this environment: ' + t.blockers.join('; ') + '. Run NO command against any target and do not resolve any credential. Return exactly one candidateObservation per environment with result "inconclusive", methods ["' + WORKFLOW + '"], subjects [{type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"}], collectedAt = the run timestamp, controlIds = every control this probe would have evidenced (exact ids from the catalogs: ' + BLOCKED_CONTROL_HINT + '), and a description that starts "BLOCKED (' + t.blockers.join('; ').replace(/"/g, '\'') + '):" and states each blocker verbatim. Return one evidenceRequest per check group stating what a human should attach (e.g. redacted `kubectl get pods -n ' + (t.namespace || '<ns>') + ' -o json` export with sha256, log-group retention screenshot, SBOM attestation output). candidateFindings, candidateRisks and candidateIncidents must be empty; do not write an export file.',
  t.mode === 'live'
    ? 'Redact inside the command pipeline, before head and before anything reaches stdout, a file or a hash (rules-of-engagement sections 2 and 6: jq projection or walk stages for env[].value, Config.Env and task-definition environment; never a bare `kubectl get pods -o json` or `docker inspect`): tokens, kubeconfig material, Secret values, env var values whose names look secret, PAN/Aadhaar/account/phone/email patterns. Keep image digests, pod names, namespaces and ARNs. Per-command sha256 is over the redacted output as stored in the export; never pipe a target command into sha256sum or tee. Export the OCSF events for this environment to ' + ocsfExportPath + ' and the redacted command outputs, keyed by evidence ref, to ' + textExportPath + '. Both files are shared by every live environment of this run (one file per agent per workflow per session, RoE section 5); the workflow runs live probes one at a time, so Read each file if it exists and append your events or keys, never remove another environment\'s; create the directory; these are the only paths you may write. Return both under exports with the sha256 of each file after your write (the workflow hands the ledger keeper the final hash taken after the last live probe).'
    : 'Write no export file in ' + t.mode + ' mode.',
  'Every check result goes into checks[] as {envId, checkId (CNT-nn), ruleId (the kebab-case ruleId from your agent file section 3 table), status pass|fail|warning|unknown|not-applicable (inconclusive when not run), subject, evidenceRef}.',
  'Candidate records must already be shaped like v1/soc/record.schema.json examples. Observations: kind, id obs_<ULID>, recordedAt, companyId, controlIds in <instrument>:<controlId> form (prefer ids that already exist in the ledger: ' + (existingControlIds.join(', ') || 'none yet') + '), title starting with the CNT-nn check id, description, methods ["' + WORKFLOW + '"], subjects [{type: "environment", appId, envId}] (add {type: "image", appId, imageId} per image examined), collectedAt, expiresAt, result, toolOutput {format: "ocsf", path: "' + ocsfExportPath + '", sha256} for live runs, evidence [{type: "command-output", ref: <command with locators as $NAME>, sha256, collectedAt, description starting with the CNT-nn check id}], provenance; one observation per (check, control set, subject). Findings: kind, id fnd_<ULID>, title, description (pod/container, digest, what was seen), severity from the catalog and SLA table (tier ' + t.tier + ' weighting), confidence (confirmed|likely|possible|unverified), controlIds, regulatoryRefs (most specific Indian instrument first: sebi-cscrf-2024, rbi-cyber-tech-directions-2026, irdai-info-cyber-security-2023, cert-in-directions-2022, dpdp-rules-2025; then cis-controls-8.1 / nist-800-53-r5' + ((t.dataClassification || []).includes('cardholder') ? '; add pci-dss-4.0.1 for cardholder data' : '') + '), target {type: image|environment, appId, imageId|envId}, location {path: <stable normalised location per your agent file section 6>}, fingerprint exactly as soc-ledger section 6 and your agent file section 6: printf %s "<ruleId>|<targetKey>|<normalisedLocation>" | sha256sum, where ruleId = the kebab-case ruleId from your check table (keep the CNT-nn id in evidence[].description), targetKey = "' + targetKeyOf(t) + '" for environment targets or "image:' + t.appId + '/<imageId>" for image targets, and normalisedLocation = location.path (never timestamps, titles or JSON); source per your agent file section 9 ({kind: "ocsf", ocsfClassUid, ruleId, tool, toolVersion} when the event is in the export, {kind: "runtime-probe", ruleId, tool} otherwise); status "open", slaDueAt and slaBasis from the SLA table, relatedObservationIds, firstSeenAt, lastSeenAt, evidence, tags starting with ' + BASE_TAGS.join(', ') + ', ' + t.group + '. One finding per (check, workload or image).',
  'Abort conditions (rules-of-engagement section 7, agent file section 8: PERMISSION_DENIED, RATE_LIMITED, WINDOW_CLOSED, UNREDACTABLE_DATA, CREDENTIAL_NOT_READ_ONLY, PROBE_SIDE_EFFECT): return aborted true with abortReason, and return one inconclusive candidateObservation per environment whose description starts "BLOCKED (<abortReason>):" (controlIds = the controls of the check groups not completed) plus one evidenceRequest per check group not completed; keep the assessed observations of check groups you finished. In addition:',
  '- UNREDACTABLE_DATA: a candidateRisk {kind "risk", id rsk_<ULID>, title "' + UNREDACTABLE_RISK_TITLE + '", statement ("Because <what was exposed>, <what may happen>, causing <impact>"), severity "high", likelihood (rare|unlikely|possible|likely|almost-certain; suggested "possible"), impact (negligible|minor|moderate|major|severe; suggested "major"), status "open", regulatoryRefs [{regulator "MeitY", instrument "dpdp-rules-2025", controlId "6(1)(a)" or whichever 6(1)(a)-(g) sub-clause the catalog says fits} first, then {regulator "CERT-In", instrument "cert-in-directions-2022", controlId from its catalog, e.g. "Annex-I.xii"}], provenance}.',
  '- CREDENTIAL_NOT_READ_ONLY: a candidateFinding with source.ruleId "probe-credential-not-read-only" (your agent file\'s id; the RoE skill names the same rule ROE-RW-CREDENTIAL), source {kind "runtime-probe", ruleId, tool "container-prober"}, severity "high", target {type "environment", appId "' + t.appId + '", envId "' + t.envId + '"}, no location, fingerprint = printf %s "probe-credential-not-read-only|' + targetKeyOf(t) + '|" | sha256sum, regulatoryRefs citing sebi-cscrf-2024 PR.AA.S3 (least privilege) first, then PR.AA.S1 (identity and credential management), then the RBI 2026 Directions access-control clause only if its catalog exists (exact catalog ids only; PR.AA.S2 is network segmentation, not access management).',
  '- PROBE_SIDE_EFFECT: a candidateIncident {kind "incident", id inc_<ULID>, category "unauthorised-access" (the closed enum has no unauthorised-change), title containing "probe side effect", status "detected", severity "high", detectedAt, dedupKey "probe-side-effect:' + t.appId + '/' + t.envId + ':' + (runId || now || '<runId or now>') + '" (the rules-of-engagement section 7 key for incidents the probe itself caused; it deliberately never matches a PagerDuty key); affectedAssets [{type "environment", appId, envId}], affectedDataClassifications ' + JSON.stringify(t.dataClassification || []) + ', relatedFindingIds where they exist}, and a summary sentence addressed to the company\'s CISO' + (ciso ? ' (' + (ciso.name || '') + (ciso.email ? ' <' + ciso.email + '>' : '') + ')' : '') + '.',
  'Return skipped: every check you could not perform and why. Do NOT append to the ledger and do not touch summary.md: the soc-ledger-keeper writes after refutation.',
  timeRule, provenanceRule,
  'Answer with the single JSON object described in your agent instructions (section 9) in the structured-output shape, including summary (one paragraph).',
].join('\n');

phase('Probe');
const probeResults = targets.map(() => null);
const explained = new Set(); // target indices whose loss is already recorded in skipped
const probeOne = async (t, index) => {
  let r = null;
  try {
    r = await agent(probePrompt(t), { label: 'probe ' + t.appId + '/' + t.envId + ' [' + t.mode + '] #' + (index + 1), phase: 'Probe', agentType: PROBE_AGENT, schema: PROBE_SCHEMA, effort: t.mode === 'live' ? 'high' : 'low' });
  } catch (e) {
    skipped.push({ appId: t.appId, envId: t.envId, reason: 'probe agent failed (' + errText(e) + '); nothing written for this environment' }); explained.add(index); log('probe failed for ' + t.appId + '/' + t.envId + ': ' + errText(e)); return;
  }
  if (!r) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'probe agent returned no schema-valid result; nothing written for this environment' }); explained.add(index); log('probe failed for ' + t.appId + '/' + t.envId); return; }
  noteSession(r);
  for (const s of r.skipped || []) skipped.push({ appId: t.appId, envId: t.envId, reason: 'probe: ' + s });
  if (r.aborted) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'probe aborted: ' + (r.abortReason || 'unspecified') }); log(t.appId + '/' + t.envId + ': probe aborted with ' + (r.abortReason || 'unspecified')); }
  log(t.appId + '/' + t.envId + ' [' + t.mode + ']: ' + (r.checks || []).length + ' check(s), ' + (r.candidateObservations || []).length + ' observation(s), ' + (r.candidateFindings || []).length + ' candidate finding(s), ' + (r.evidenceRequests || []).length + ' evidence request(s), ' + (r.access && Number.isInteger(r.access.commandsExecuted) ? r.access.commandsExecuted : 0) + ' command(s) executed');
  probeResults[index] = { target: t, probe: r };
};
const liveIndices = targets.map((t, i) => (t.mode === 'live' ? i : -1)).filter((i) => i >= 0);
const planIndices = targets.map((t, i) => (t.mode !== 'live' ? i : -1)).filter((i) => i >= 0);
await parallel([
  async () => { for (const i of liveIndices) await probeOne(targets[i], i); },
  ...planIndices.map((i) => () => probeOne(targets[i], i)),
]);
// Final export hashes: live probes ran sequentially in liveIndices order, so the last report per path is the final file state.
const finalExports = new Map();
for (const i of liveIndices) {
  const pr = probeResults[i];
  for (const e of (pr && pr.probe.exports) || []) if (e && e.path && e.sha256) finalExports.set(e.path, e.sha256);
}
const finalOcsfSha = finalExports.get(ocsfExportPath) || null;
if (liveIndices.some((i) => probeResults[i]) && !finalOcsfSha) skipped.push({ reason: 'no live probe reported a sha256 for ' + ocsfExportPath + '; observations are written without toolOutput' });
// Rules-of-engagement section 7: the CISO hears about every suspected probe side effect, whether or not refutation keeps it.
const preRefutationIncidents = [];
for (const i of liveIndices) {
  const pr = probeResults[i];
  if (pr) for (const inc of pr.probe.candidateIncidents || []) if (inc) preRefutationIncidents.push({ index: i, target: pr.target, incident: inc });
}

// ---- Phase 3: Refute ---------------------------------------------------------------------------------------------
const lensesFor = (t) => (t.group === 'prod' ? ['evidence', 'regulatory-mapping', 'production-safety'] : ['evidence', 'regulatory-mapping']);
const ruleIdOf = (c) => (c && c.source && typeof c.source.ruleId === 'string' ? c.source.ruleId : null);
const checkIdOf = (c) => {
  const texts = [c && c.title].concat(((c && c.evidence) || []).map((e) => e && e.description));
  for (const s of texts) { const m = /\bCNT-\d{2}\b/.exec(String(s || '')); if (m) return m[0]; }
  return '';
};
const isSafetyRecord = (c) => Boolean(c && (c.kind === 'incident' || (c.kind === 'risk' && String(c.title || '').toLowerCase() === UNREDACTABLE_RISK_TITLE.toLowerCase()) || (c.kind === 'finding' && SAFETY_RULE_IDS.includes(ruleIdOf(c)))));
const refutePrompt = (t, claim, lens, probe) => [
  'You are an adversarial refuter for the ' + WORKFLOW + ' workflow (company ' + companyId + ', app ' + t.appId + ', env ' + t.envId + ', tier ' + t.tier + '). Lens: ' + lens + '. Try to REFUTE the candidate ' + claim.kind + ' below; default to refuted=true if you cannot verify it from the workspace.',
  'Candidate:\n' + JSON.stringify(claim, null, 1),
  'Probe context: access ' + JSON.stringify(probe.access || {}) + '; aborted ' + String(Boolean(probe.aborted)) + (probe.abortReason ? ' (' + probe.abortReason + ')' : '') + '; exports ' + JSON.stringify(probe.exports || []) + '; checks ' + JSON.stringify((probe.checks || []).filter((c) => c && (c.envId === undefined || c.envId === t.envId) && (!ruleIdOf(claim) && !checkIdOf(claim) ? true : c.ruleId === ruleIdOf(claim) || c.checkId === ruleIdOf(claim) || (checkIdOf(claim) && c.checkId === checkIdOf(claim)))).slice(0, 40)) + '.',
  isSafetyRecord(claim)
    ? 'This is an abort-derived safety record (probe side-effect incident, unredactable-data risk or read-write probe credential finding). It exists precisely because non-read activity, unredacted data or a writable credential was seen, so judge only whether the reported event is supported by the probe output and the workspace; never refute it because the evidence shows that activity or data.'
    : '',
  lens === 'evidence'
    ? 'Evidence lens: open the OCSF export ' + ocsfExportPath + ' and the text export ' + textExportPath + ' named in exports/evidence, applications/' + t.appId + '/env/' + t.envId + '.json and applications/' + t.appId + '/images/*.json. The export is shared by every live environment of this run: look for the events of this app/env. Confirm the export actually contains an event for this check and subject, that the redacted excerpt or hash-backed evidenceRef shows what the candidate claims (for a finding or not-satisfied/partial observation the gap: digest mismatch, missing limit, root user, missing SBOM, retention below threshold; for a satisfied or not-applicable observation that every pod/container in scope was actually examined and passed, not a sample), that no compensating control in the environment record or image record explains it (LimitRange, PodSecurity label, SBOM attested elsewhere), and that the severity is justified for tier ' + t.tier + '. Return correctedSeverity only to LOWER the severity when the evidence supports a lesser level (the workflow never raises severity from a refuter). If either export holds an unredacted secret, token, kubeconfig fragment or PII, set unredactedDataInExport true.'
    : lens === 'regulatory-mapping'
      ? 'Regulatory-mapping lens: ' + CATALOG_RULE + ' Check that every regulatoryRef instrument applies to this company (company-profile/' + companyId + '/details.json entityTypes and registrations), that each controlId exists in that instrument catalog and in the ledger (company-profile/' + companyId + '/soc/main.jsonl) or is derivable from the catalog, that the most specific Indian instrument is cited first, and that severity and slaBasis match the SLA table row (observations carry no severity: check only that their controlIds exist, apply to this company and are the clauses the CNT check actually evidences). Return correctedRegulatoryRefs / correctedControlIds / correctedSeverity (only to lower it) when the mapping is wrong but the gap is real; refute only when no applicable clause exists or the mapping cannot be repaired.'
      : 'Production-safety lens (prod/dr environment): refute the candidate if the evidence could only have been gathered outside the read-only command families of .claude/skills/runtime-probe-rules-of-engagement/SKILL.md (any evidence ref or export command containing apply, create, patch, edit, delete, scale, rollout, exec, attach, cp, port-forward, logs, get secret, run, start, stop, kill, put-, update-, or a non-read verb), if the export contains an unredacted secret, token, kubeconfig fragment or PII, if the command count exceeds rateLimitPerMinute ' + t.rateLimit + ' for the elapsed time, if the collectedAt timestamps fall outside allowedWindows ' + (describeWindows(t.allowedWindows) || 'any time') + ' or inside a changeFreeze window, or if the finding recommends an immediate production change instead of a change-managed remediation. Whenever the export holds unredacted data, set unredactedDataInExport true (the workflow then raises the "' + UNREDACTABLE_RISK_TITLE + '" risk). Accept only when the candidate is consistent with a read-only, in-window, rate-limited probe. Return correctedSeverity only to lower it.',
  'Read-only: never modify the workspace, never run commands, never touch a live system. Return {refuted, lens, reason, checked, unredactedDataInExport?, correctedSeverity?, correctedRegulatoryRefs?, correctedControlIds?}.',
].filter(Boolean).join('\n');

const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
const RESULT_RANK = { 'not-satisfied': 4, partial: 3, inconclusive: 2, satisfied: 1, 'not-applicable': 1 };
const CONFIDENCE = ['confirmed', 'likely', 'possible', 'unverified'];
const isSevere = (c) => c.severity === 'high' || c.severity === 'critical' || c.kind === 'incident';
const notesOf = (valid) => clip(valid.map((v) => (v.lens || '?') + ' ' + (v.refuted ? 'refuted' : 'accepted') + ': ' + v.reason).join(' | '), 1500);
// Strip workflow-only keys so a keeper that copies a candidate verbatim does not trip unevaluatedProperties:false.
const sanitize = (c) => {
  const out = { ...c };
  delete out.refutation;
  if (out.kind !== 'finding' || !CONFIDENCE.includes(out.confidence)) delete out.confidence;
  return out;
};
const downgrade = (o, prefix) => ({ ...o, result: 'inconclusive', description: clip(prefix + ' ' + String(o.description || o.title || ''), 19000) });

const refuteOne = async (t, probe, c, what, i) => {
  const lenses = lensesFor(t);
  const votes = await parallel(lenses.map((lens) => () =>
    agent(refutePrompt(t, c, lens, probe), { label: 'refute ' + lens + ' ' + t.appId + '/' + t.envId + ' ' + what + ' #' + (i + 1), phase: 'Refute', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' })));
  const answered = lenses.map((lens, k) => (votes && votes[k] ? { ...votes[k], lens } : null));
  const valid = answered.filter(Boolean);
  valid.forEach(noteSession);
  const refutations = valid.filter((v) => v.refuted).length;
  const accepted = valid.length - refutations;
  const safetyVerdict = answered[lenses.indexOf('production-safety')];
  const vetoed = lenses.includes('production-safety') && (!safetyVerdict || safetyVerdict.refuted);
  return { lenses, valid, refutations, accepted, vetoed, unredacted: valid.some((v) => v.unredactedDataInExport === true) };
};
const applyCorrections = (t, c, valid, keepSeverity) => {
  const merged = { ...c };
  for (const v of valid) {
    if (v.correctedSeverity && merged.severity && v.correctedSeverity !== merged.severity) {
      if (!keepSeverity && SEV_ORDER.indexOf(v.correctedSeverity) < SEV_ORDER.indexOf(merged.severity)) merged.severity = v.correctedSeverity;
      else skipped.push({ appId: t.appId, envId: t.envId, reason: 'severity correction not applied (' + v.lens + ' proposed ' + v.correctedSeverity + ' for ' + merged.severity + ' "' + clip(c.title, 120) + '"' + (keepSeverity ? ': safety records keep severity high' : ': refuters may only lower severity') + '); review by hand' });
    }
    if (v.correctedRegulatoryRefs && v.correctedRegulatoryRefs.length) merged.regulatoryRefs = v.correctedRegulatoryRefs;
    if (v.correctedControlIds && v.correctedControlIds.length) merged.controlIds = v.correctedControlIds;
  }
  return merged;
};

const refuteTarget = async ({ target: t, probe }) => {
  const allFindings = (probe.candidateFindings || []).filter(Boolean);
  const findings = allFindings.filter((f) => f.fingerprint && f.severity);
  if (allFindings.length - findings.length) skipped.push({ appId: t.appId, envId: t.envId, reason: (allFindings.length - findings.length) + ' candidate finding(s) lacked a fingerprint or severity and were dropped before refutation' });
  const risks = (probe.candidateRisks || []).filter(Boolean);
  const incidents = (probe.candidateIncidents || []).filter(Boolean);
  const observations = (probe.candidateObservations || []).filter(Boolean);
  if (t.mode !== 'live') {
    const n = findings.length + risks.length + incidents.length;
    if (n) skipped.push({ appId: t.appId, envId: t.envId, reason: t.mode + ': ' + n + ' candidate finding/risk/incident record(s) discarded (no target command ran); only inconclusive observations are written' });
    return { target: t, probe, observations, findings: [], risks: [], incidents: [] };
  }
  const out = { target: t, probe, observations: observations.filter((o) => o.result === 'inconclusive' || !o.result), findings: [], risks: [], incidents: [] };
  let unredacted = false;
  const unredactedNotes = [];
  let n = 0;
  // 1. Abort-derived safety records: fail-safe, written unless every lens answered and refuted; no production-safety veto.
  const safety = findings.filter(isSafetyRecord).concat(risks.filter(isSafetyRecord), incidents);
  for (const c of safety) {
    const r = await refuteOne(t, probe, c, c.kind + ' (safety)', n++);
    if (r.unredacted) { unredacted = true; unredactedNotes.push(notesOf(r.valid)); }
    if (r.valid.length === r.lenses.length && r.refutations === r.lenses.length) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'safety ' + c.kind + ' refuted by every lens (' + r.lenses.length + '/' + r.lenses.length + '): ' + c.title + ' - ' + notesOf(r.valid) }); continue; }
    const merged = applyCorrections(t, c, r.valid, true);
    merged.description = clip((c.description ? String(c.description) + '\n' : '') + 'Refutation notes (fail-safe: written unless every lens refutes; ' + r.valid.length + '/' + r.lenses.length + ' lenses answered, ' + r.refutations + ' refuted): ' + (notesOf(r.valid) || 'no lens answered'), 19000);
    out[c.kind === 'finding' ? 'findings' : c.kind === 'risk' ? 'risks' : 'incidents'].push(sanitize(merged));
  }
  // 2. Ordinary findings (most severe first) and risks, then assessed observations, within the per-target refutation cap.
  let budgetLeft = MAX_REFUTED_CLAIMS_PER_TARGET;
  const ordinary = findings.filter((f) => !isSafetyRecord(f)).sort((a, b) => SEV_ORDER.indexOf(b.severity) - SEV_ORDER.indexOf(a.severity)).concat(risks.filter((x) => !isSafetyRecord(x)));
  for (const c of ordinary) {
    if (budgetLeft <= 0) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'refutation cap (' + MAX_REFUTED_CLAIMS_PER_TARGET + ' claims per environment) reached; candidate ' + c.kind + ' not refuted and not written: ' + c.title }); continue; }
    budgetLeft -= 1;
    const r = await refuteOne(t, probe, c, c.kind, n++);
    if (r.unredacted) { unredacted = true; unredactedNotes.push(notesOf(r.valid)); }
    // Strict majority of the lenses that answered; high/critical need every lens to answer and none to refute.
    // On prod/dr the production-safety lens is a veto, and a missing production-safety verdict counts as a refutation.
    const survives = !r.vetoed && r.valid.length > 0 && (isSevere(c) ? r.refutations === 0 && r.valid.length === r.lenses.length : r.accepted > r.refutations);
    if (!survives) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'refuted ' + c.kind + ' (' + r.refutations + '/' + r.valid.length + ' of ' + r.lenses.length + ' lenses' + (r.vetoed ? ', production-safety veto' : '') + '): ' + c.title + ' - ' + notesOf(r.valid) }); continue; }
    const merged = applyCorrections(t, c, r.valid, false);
    merged.description = clip((c.description ? String(c.description) + '\n' : '') + 'Refuter notes: ' + notesOf(r.valid), 19000);
    out[c.kind === 'finding' ? 'findings' : 'risks'].push(sanitize(merged));
  }
  // Assessed observations are claims about a control too (a false "satisfied" is false assurance). A refuted one is
  // downgraded to inconclusive, never dropped, so the run is not read as an absence by refresh-soc (soc-ledger 8.3).
  const assessed = observations.filter((o) => o.result && o.result !== 'inconclusive');
  let downgraded = 0;
  for (const o of assessed) {
    if (budgetLeft <= 0) { out.observations.push(sanitize(downgrade(o, 'UNREFUTED (refutation cap of ' + MAX_REFUTED_CLAIMS_PER_TARGET + ' claims per environment reached; probe reported ' + o.result + '):'))); downgraded += 1; continue; }
    budgetLeft -= 1;
    const r = await refuteOne(t, probe, o, 'observation', n++);
    if (r.unredacted) { unredacted = true; unredactedNotes.push(notesOf(r.valid)); }
    const survives = !r.vetoed && r.valid.length > 0 && r.accepted > r.refutations;
    if (!survives) { out.observations.push(sanitize(downgrade(o, 'REFUTED (' + (notesOf(r.valid) || 'no lens answered') + (r.vetoed ? '; production-safety veto' : '') + '; probe reported ' + o.result + '):'))); downgraded += 1; continue; }
    out.observations.push(sanitize(applyCorrections(t, o, r.valid, false)));
  }
  if (assessed.length + ordinary.length > MAX_REFUTED_CLAIMS_PER_TARGET) log(t.appId + '/' + t.envId + ': refutation cap ' + MAX_REFUTED_CLAIMS_PER_TARGET + ' reached; ' + (assessed.length + ordinary.length - MAX_REFUTED_CLAIMS_PER_TARGET) + ' claim(s) not refuted (findings/risks skipped, observations written as inconclusive)');
  // 3. A refuter saw unredacted data in the export: raise the RoE section 7 risk unless the prober already did.
  if (unredacted && !out.risks.some(isSafetyRecord)) {
    out.risks.push({
      kind: 'risk',
      id: 'rsk_MINT',
      title: UNREDACTABLE_RISK_TITLE,
      statement: 'Because the ' + WORKFLOW + ' export under ' + exportDir + ' for ' + t.appId + '/' + t.envId + ' holds output the redaction did not remove, personal data or credentials may be read by anyone with access to the workspace session exports, causing a personal data breach under DPDP Rules 2025 and a CERT-In reportable data leak.',
      description: clip('Raised by the workflow from refuter verdicts (unredactedDataInExport): ' + unredactedNotes.join(' || '), 19000),
      severity: 'high',
      likelihood: 'possible',
      impact: 'major',
      status: 'open',
      regulatoryRefs: [{ regulator: 'MeitY', instrument: 'dpdp-rules-2025', controlId: '6(1)(a)' }, { regulator: 'CERT-In', instrument: 'cert-in-directions-2022', controlId: 'Annex-I.xii' }],
    });
    log('RISK: refuter reported unredacted data in the export for ' + t.appId + '/' + t.envId);
  }
  log(t.appId + '/' + t.envId + ': ' + (assessed.length - downgraded) + '/' + assessed.length + ' assessed observation(s) kept (' + downgraded + ' downgraded to inconclusive), ' + out.findings.length + '/' + findings.length + ' finding(s), ' + out.risks.length + ' risk(s), ' + out.incidents.length + '/' + incidents.length + ' incident(s) after ' + lensesFor(t).length + '-lens refutation');
  return out;
};

phase('Refute');
const refutedResults = targets.map(() => null);
await parallel(probeResults.map((pr, i) => async () => {
  if (!pr) return;
  try { refutedResults[i] = await refuteTarget(pr); } catch (e) { skipped.push({ appId: pr.target.appId, envId: pr.target.envId, reason: 'refutation failed (' + errText(e) + '); nothing written for this environment' }); explained.add(i); }
}));
// No silent drops: every target that produced nothing to write has a skipped entry saying so.
for (let i = 0; i < targets.length; i += 1) {
  if (!refutedResults[i] && !explained.has(i)) skipped.push({ appId: targets[i].appId, envId: targets[i].envId, reason: 'pipeline stage failed or agent cap reached; nothing written' });
}

// ---- Phase 4: Dedup (barrier: the same image runs in several environments, so fingerprints collide across targets) --
phase('Dedup');
const byFingerprint = new Map();
const perTarget = [];
const stableJson = (v) => (Array.isArray(v) ? '[' + v.map(stableJson).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}' : JSON.stringify(v));
for (const item of refutedResults.filter(Boolean)) {
  const t = item.target;
  const keep = [];
  for (const f of item.findings) {
    if (byFingerprint.has(f.fingerprint)) {
      const first = byFingerprint.get(f.fingerprint);
      skipped.push({ appId: t.appId, envId: t.envId, reason: 'duplicate fingerprint ' + f.fingerprint.slice(0, 12) + ' already reported for ' + first + ': ' + f.title });
      continue;
    }
    byFingerprint.set(f.fingerprint, t.appId + '/' + t.envId);
    keep.push(f);
  }
  // Observations merge on (controls, subjects, check); where several remain for the same key the worst result wins.
  const byKey = new Map();
  for (const o of item.observations || []) {
    if (!o || !Array.isArray(o.controlIds) || !o.controlIds.length) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'candidate observation without controlIds dropped: ' + (o && o.title) }); continue; }
    let rec = o;
    if (t.mode !== 'live') {
      const prefix = t.mode === 'dry-run' ? 'DRY RUN: ' : 'BLOCKED (' + t.blockers.join('; ') + '): ';
      const desc = String(o.description || '');
      rec = { ...o, result: 'inconclusive', description: desc.startsWith('DRY RUN:') || desc.startsWith('BLOCKED') ? desc : prefix + desc };
      delete rec.toolOutput;
    }
    const subjects = (Array.isArray(rec.subjects) ? rec.subjects : []).map(stableJson).sort().join(',');
    const key = rec.controlIds.slice().sort().join(',') + '|' + subjects + '|' + checkIdOf(rec);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, rec); continue; }
    const worse = (RESULT_RANK[rec.result] || 0) > (RESULT_RANK[prev.result] || 0);
    skipped.push({ appId: t.appId, envId: t.envId, reason: 'duplicate observation for ' + key.slice(0, 160) + ' merged: kept ' + (worse ? rec.result : prev.result) + ', dropped ' + (worse ? prev.result : rec.result) });
    if (worse) byKey.set(key, rec);
  }
  perTarget.push({ target: t, probe: item.probe, observations: [...byKey.values()], findings: keep, risks: item.risks, incidents: item.incidents });
}
const totalObs = perTarget.reduce((n, p) => n + p.observations.length, 0);
log(byFingerprint.size + ' unique finding(s), ' + totalObs + ' observation(s), ' + perTarget.reduce((n, p) => n + p.risks.length, 0) + ' risk(s), ' + perTarget.reduce((n, p) => n + p.incidents.length, 0) + ' incident(s) across ' + perTarget.length + ' environment(s) after dedup');

// ---- Phase 5: Write (sequential so ledger fingerprint/supersedes checks never race; version diff after the last append) --
phase('Write');
const written = { controlIds: [], observationIds: [], findingIds: [], supersededFindingIds: [], riskIds: [], incidentIds: [] };
const observationIdsByTarget = new Map();
const incidentIdsByTarget = new Map();
let versionDiff = null;
const regulatorClockRule = (t) => 'regulatorReportRefs: one entry per regulator from .claude/skills/regulatory-catalogs/references/sla-table.json topic "incident-reporting" for the instruments in details.json frameworksInScope (CERT-In, and SEBI or RBI per entityTypes)' + ((t.dataClassification || []).some((d) => d === 'pii' || d === 'spdi') ? ', plus topic "breach-notification" (DPDP) because dataClassification includes pii/spdi' : '') + ', each {regulator, instrument, slaTopic, deadlineHours} copied from the table row, never from memory; if the table is missing, omit regulatorReportRefs and list "sla-table missing: regulatorReportRefs not set" in skipped';
const writable = perTarget.filter((p) => p.observations.length || p.findings.length || p.risks.length || p.incidents.length);
for (let i = 0; i < writable.length; i += 1) {
  const p = writable[i];
  const t = p.target;
  const last = i === writable.length - 1;
  const runLabel = runId || now || '<this run>';
  let w = null;
  try {
    w = await agent(
      [
        'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md (sections 2, 3, 6, 7 and 8), .claude/skills/maxwell-conventions/SKILL.md and section 8 of .claude/skills/runtime-probe-rules-of-engagement/SKILL.md before writing. ' + CATALOG_RULE,
        'Ledger: company-profile/' + companyId + '/soc/main.jsonl (append-only). Write EVERY record by piping JSON to `node .claude/scripts/soc/append.mjs ' + companyId + ' -`; never edit the ledger directly. A rejected append means the record is wrong: fix it and retry. Candidates below contain only schema keys; do not add keys the record schema does not define.',
        'Target: app ' + t.appId + ', env ' + t.envId + ' (tier ' + t.tier + ', mode ' + t.mode + (t.blockers.length ? ', blockers: ' + t.blockers.join('; ') : '') + (p.probe.aborted ? ', probe aborted: ' + (p.probe.abortReason || 'unspecified') : '') + '). OCSF export: ' + (t.mode === 'live' ? (finalOcsfSha ? ocsfExportPath + ' with FINAL sha256 ' + finalOcsfSha + ' (hash of the shared file after the last live probe of this run)' : 'no final sha256 reported') : 'none (' + t.mode + ')') + '.',
        'Step 1 - controls: for each observation/finding controlId not present as a kind "control" record in the ledger, append a control record first (id = the instrument-qualified controlId, frameworkRefs from the regulatory-catalogs catalog, title, statement, implementationStatus derived from the observation result: satisfied->implemented, partial->partial, not-satisfied->not-implemented, not-applicable->not-applicable, inconclusive->unknown; applicableAssets [{type: environment, appId, envId}]). Never downgrade an existing control because of an inconclusive observation.',
        'Step 2 - observations: append each candidate below as kind observation (mint a fresh obs_<ULID> with node -e if the candidate id is missing or already present in the ledger), methods ["' + WORKFLOW + '"], subjects including {type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"}, result and description exactly as given (inconclusive records keep their "DRY RUN:" / "BLOCKED" / "REFUTED" / "UNREFUTED" description), ' + (t.mode === 'live' && finalOcsfSha ? 'toolOutput {format: "ocsf", path: "' + ocsfExportPath + '", sha256: "' + finalOcsfSha + '"} (replace any sha256 the candidate carries: only the final hash matches the file)' : 'no toolOutput') + ', evidence as given (per-command sha256 values stay as given), tags ' + JSON.stringify(BASE_TAGS.concat([t.group])) + '.',
        'Observations to write:\n' + JSON.stringify(p.observations, null, 1),
        p.findings.length
          ? 'Step 3 - findings, exactly as soc-ledger section 8 steps 1 and 2. Build the latest-state map (soc-ledger section 3) and look up each candidate\'s fingerprint:\n'
            + '(a) No finding has that fingerprint: append it with a fresh fnd_<ULID> (mint one if the candidate id is missing or already used), no supersedes, status "open", firstSeenAt = lastSeenAt = its collectedAt, controlIds that exist after step 1, regulatoryRefs exactly as given, target, location, fingerprint and source as given, slaDueAt = firstSeenAt + days and slaBasis {instrument, controlId, topic, severity, days} from the SLA table row matching the cited instruments, topic and severity, relatedObservationIds = the observation ids you just created for the same check and subject, evidence (include {type: "ocsf", ref: "' + ocsfExportPath + '"' + (finalOcsfSha ? ', sha256: "' + finalOcsfSha + '"' : '') + '}), confidence, tags. List its id under findingIds.\n'
            + '(b) A finding with that fingerprint exists (id X): append a full record with id X and supersedes X, never a second fnd_ id. Keep firstSeenAt, initiativeId and suggestionIds from the latest X record; set lastSeenAt = this run\'s collectedAt; refresh severity, evidence, relatedObservationIds, location and description (recompute slaDueAt/slaBasis from the kept firstSeenAt only if severity changed). Status: open, triaged and remediating keep their status; resolved becomes status "open" with statusReason "regressed in run ' + runLabel + '" and resolvedAt removed; false-positive, duplicate and a risk-accepted finding whose accepted risk (acceptedUntil) has not expired keep status, statusReason and resolvedAt and only refresh lastSeenAt; a risk-accepted finding whose acceptance expired becomes status "open" with statusReason "risk acceptance expired; re-seen in run ' + runLabel + '" and resolvedAt removed (list the risk id under skipped as "risk acceptance expired: re-rate via refresh-soc"). List X under supersededFindingIds, not findingIds.\n'
            + 'Findings to write:\n' + JSON.stringify(p.findings, null, 1)
          : 'Step 3 - findings: none for this environment.',
        p.risks.length ? 'Step 4 - risks: append each candidate below as kind risk with a fresh rsk_<ULID> (replace placeholder ids such as rsk_MINT) and every field the risk schema requires: title, statement ("Because X, Y may occur, causing Z"), severity, likelihood (rare|unlikely|possible|likely|almost-certain; use the candidate value, else "possible"), impact (negligible|minor|moderate|major|severe; use the candidate value, else "major"), status "open", and regulatoryRefs with DPDP Rules 2025 security safeguards first ({regulator "MeitY", instrument "dpdp-rules-2025", controlId "6(1)" sub-clause 6(1)(a)-(g) per the catalog}) and cert-in-directions-2022 second (catalog id); add relatedFindingIds for findings written in step 3 where they exist. If an open risk with the same title for this environment already exists, supersede it (same id, supersedes) instead of a new id.\n' + JSON.stringify(p.risks, null, 1) : '',
        p.incidents.length ? 'Step 5 - incidents: append each candidate below as kind incident (fresh inc_<ULID>; if an incident with the same dedupKey already exists, supersede it with its id instead), category "unauthorised-access" (the closed enum has no unauthorised-change; keep "probe side effect" in the title), status "detected", severity high, detectedAt, dedupKey "probe-side-effect:' + t.appId + '/' + t.envId + ':' + (runId || now || '<runId or now>') + '" (the rules-of-engagement section 7 key for incidents the probe itself caused; it deliberately never matches a PagerDuty key); affectedAssets [{type: "environment", appId: "' + t.appId + '", envId: "' + t.envId + '"}], affectedDataClassifications ' + JSON.stringify(t.dataClassification || []) + ' (only values the schema allows), relatedFindingIds where they exist, and ' + regulatorClockRule(t) + '.\n' + JSON.stringify(p.incidents, null, 1) : '',
        timeRule, provenanceRule,
        last ? 'FINAL STEP for this run: after your appends run `node .claude/scripts/soc/version.mjs ' + companyId + (sessionId ? ' --session ' + sessionId : '') + ' --workflow ' + WORKFLOW + '` so the ledger delta is written to soc/versions/commit_<n>.diff, and return its path as versionDiff.' : 'Do not run soc/version.mjs; a later write stage closes the run.',
        'After writing run `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/soc/main.jsonl` and fix anything it reports. Return {controlIds, observationIds, findingIds, supersededFindingIds, riskIds, incidentIds, versionDiff, skipped} where skipped lists every candidate you could not write and why. Do not touch summary.md.',
      ].filter(Boolean).join('\n'),
      { label: 'write ' + t.appId + '/' + t.envId, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'medium' },
    );
  } catch (e) {
    skipped.push({ appId: t.appId, envId: t.envId, reason: 'ledger keeper failed (' + errText(e) + '); ' + p.observations.length + ' observation(s), ' + p.findings.length + ' finding(s), ' + p.risks.length + ' risk(s), ' + p.incidents.length + ' incident(s) not written' });
    continue;
  }
  if (!w) { skipped.push({ appId: t.appId, envId: t.envId, reason: 'ledger keeper returned no result; ' + p.observations.length + ' observation(s), ' + p.findings.length + ' finding(s), ' + p.risks.length + ' risk(s), ' + p.incidents.length + ' incident(s) not written' }); continue; }
  noteSession(w);
  written.controlIds.push(...(w.controlIds || []));
  written.observationIds.push(...(w.observationIds || []));
  written.findingIds.push(...(w.findingIds || []));
  written.supersededFindingIds.push(...(w.supersededFindingIds || []));
  written.riskIds.push(...(w.riskIds || []));
  written.incidentIds.push(...(w.incidentIds || []));
  observationIdsByTarget.set(t.appId + '/' + t.envId, w.observationIds || []);
  incidentIdsByTarget.set(t.appId + '/' + t.envId, w.incidentIds || []);
  if (w.versionDiff) versionDiff = w.versionDiff;
  for (const s of w.skipped || []) skipped.push({ appId: t.appId, envId: t.envId, reason: 'write: ' + s });
  log(t.appId + '/' + t.envId + ': wrote ' + (w.observationIds || []).length + ' observation(s), ' + (w.findingIds || []).length + ' new and ' + (w.supersededFindingIds || []).length + ' re-seen finding(s), ' + (w.riskIds || []).length + ' risk(s), ' + (w.incidentIds || []).length + ' incident(s)');
}
if (!writable.length) log('nothing to write to the ledger');
else if (!versionDiff) skipped.push({ reason: 'soc/version.mjs did not report a commit diff; run `node .claude/scripts/soc/version.mjs ' + companyId + ' --workflow ' + WORKFLOW + '` manually' });

// Task requests for impl-change-management (rules-of-engagement section 8): one per blocked, dry-run or aborted environment.
const evidenceRequests = [];
for (const p of perTarget) {
  const t = p.target;
  const asks = (p.probe.evidenceRequests || []).filter((e) => e && e.ask);
  if (!asks.length) continue;
  const controlIds = [...new Set(asks.flatMap((e) => e.controlIds || []).concat(p.observations.filter((o) => o.result === 'inconclusive').flatMap((o) => o.controlIds || [])))];
  const obsIds = observationIdsByTarget.get(t.appId + '/' + t.envId) || [];
  const blockers = t.blockers.concat(p.probe.aborted ? ['ABORTED: ' + (p.probe.abortReason || 'unspecified')] : []);
  evidenceRequests.push({ kind: 'evidence-request', appId: t.appId, envId: t.envId, tier: t.tier, blockers, controlIds, requested: asks.map((e) => (e.checkId ? e.checkId + ': ' : '') + e.ask).join('\n'), owner: t.owner || asks.map((e) => e.owner).find(Boolean) || null, dueDays: 14, observationId: obsIds[0] || null, verificationMethod: { type: 're-probe', workflow: WORKFLOW, description: 'Re-run ' + WORKFLOW + ' for ' + t.appId + '/' + t.envId + (t.group === 'prod' ? ' with envIds naming it, ' : ' ') + 'inside its allowed window with args.now set, and confirm the requested checks return assessed (not inconclusive) observations' } });
}
if (evidenceRequests.length) log(evidenceRequests.length + ' evidence request(s) raised for impl-change-management');
// Rules-of-engagement section 7: every suspected probe side effect reaches the company's CISO through the return value,
// built from the pre-refutation candidates so a refuter can never silence it.
const cisoAlerts = [];
for (const a of preRefutationIncidents) {
  const key = a.target.appId + '/' + a.target.envId;
  const kept = refutedResults[a.index] && refutedResults[a.index].incidents.some((x) => x.title === a.incident.title);
  cisoAlerts.push({ appId: a.target.appId, envId: a.target.envId, tier: a.target.tier, title: a.incident.title, severity: a.incident.severity || 'high', escalateTo: ciso ? { role: 'ciso', name: ciso.name || null, email: ciso.email || null } : { role: 'ciso', name: null, email: null, note: 'company-profile/' + companyId + '/details.json names no ciso contact' }, reason: 'probe side effect suspected on a live environment; regulator clocks per sla-table.json incident-reporting apply from detectedAt', survivedRefutation: Boolean(kept), incidentIds: incidentIdsByTarget.get(key) || [] });
}
if (cisoAlerts.length) log('CISO ALERT' + (ciso ? ' for ' + (ciso.name || ciso.email) : '') + ': ' + cisoAlerts.length + ' suspected probe side effect(s): ' + cisoAlerts.map((a) => a.appId + '/' + a.envId).join(', '));

// ---- Phase 6: Summary -------------------------------------------------------------------------------------------
phase('Summary');
let summary = null;
if (!written.observationIds.length && !written.findingIds.length && !written.supersededFindingIds.length && !written.riskIds.length && !written.incidentIds.length) {
  log('nothing was written to the ledger; summary.md left unchanged');
} else {
  try {
    summary = await agent(
      [
        'You are the report-writer. Refresh the "control-summary" and "open-findings" sections of company-profile/' + companyId + '/summary.md after the ' + WORKFLOW + ' workflow' + (dryRun ? ' (DRY RUN: only inconclusive observations were written; say so in control-summary, do not claim any control was assessed)' : '') + '. Read .claude/skills/report-templates/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md first.',
        'Source of truth: company-profile/' + companyId + '/soc/main.jsonl. Take the latest record per id chain (follow supersedes). control-summary: per instrument, count controls by implementationStatus and cite the newest observation per control with [obs_...] ids; call out inconclusive observations from blocked, dry-run, aborted or refuted probes as coverage gaps with their blocker. open-findings: status open|triaged|remediating grouped by severity with title, target, primary regulatoryRef, slaDueAt and finding id.',
        'This run: environments ' + perTarget.map((p) => p.target.appId + '/' + p.target.envId + ' [' + p.target.mode + ']').join(', ') + '; ' + written.findingIds.length + ' new finding(s) ' + JSON.stringify(written.findingIds) + ', ' + written.supersededFindingIds.length + ' re-seen, ' + written.observationIds.length + ' observation(s), ' + written.riskIds.length + ' risk(s), ' + written.incidentIds.length + ' incident(s), ' + evidenceRequests.length + ' evidence request(s) pending.',
        'Edit only those sections and the frontmatter: bump version minor, keep "sections" accurate, and recompute provenance.inputsHash exactly as the company-summary schema describes. Do not create any other file.',
        timeRule, provenanceRule,
        'Validate with `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/summary.md` and return {updated, openFindings, bySeverity, controlsAssessed, version, notes}.',
      ].join('\n'),
      { label: 'summary', phase: 'Summary', agentType: 'report-writer', schema: SUMMARY_SCHEMA, effort: 'medium' },
    );
  } catch (e) {
    skipped.push({ reason: 'report-writer failed (' + errText(e) + '); summary.md may be stale' });
  }
  if (!summary) { if (!skipped.some((s) => /^report-writer failed/.test(s.reason))) skipped.push({ reason: 'report-writer returned no result; summary.md may be stale' }); }
  else { noteSession(summary); log('summary.md: ' + summary.openFindings + ' open finding(s), version ' + (summary.version || '?')); }
}

log('done: ' + perTarget.length + ' environment(s) (' + perTarget.filter((p) => p.target.mode === 'live').length + ' live, ' + perTarget.filter((p) => p.target.mode === 'dry-run').length + ' dry-run, ' + perTarget.filter((p) => p.target.mode === 'blocked').length + ' blocked), ' + written.observationIds.length + ' observation(s), ' + written.findingIds.length + ' new / ' + written.supersededFindingIds.length + ' re-seen finding(s), ' + written.riskIds.length + ' risk(s), ' + written.incidentIds.length + ' incident(s), ' + evidenceRequests.length + ' evidence request(s), ' + skipped.length + ' skipped item(s) logged');
return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  now,
  nowProblem,
  tiers: byGroup,
  targets: targets.map((t) => ({ appId: t.appId, envId: t.envId, tier: t.tier, group: t.group, mode: t.mode, rateLimitPerMinute: t.rateLimit, blockers: t.blockers })),
  controls: written.controlIds.length,
  observations: written.observationIds.length,
  findings: written.findingIds.length,
  reseenFindings: written.supersededFindingIds.length,
  risks: written.riskIds.length,
  incidents: written.incidentIds.length,
  initiatives: 0,
  suggestions: 0,
  ids: written,
  exports: finalOcsfSha ? [{ path: ocsfExportPath, sha256: finalOcsfSha }] : [],
  versionDiff,
  evidenceRequests,
  cisoAlerts,
  summary,
  skipped,
  sessionIds: [...sessionIds],
};
