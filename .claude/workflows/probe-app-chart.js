// probe-app-chart: static probe of Helm chart and Kubernetes manifest in every application repo checkout for one company.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean, now?: RFC3339 'Z' string,
//         sessionId?: string, runId?: string } - without args.now the Scout reads the clock once and every stage reuses it.
// Shape: Scout (repos with checkouts, applicable instruments, run timestamp) -> per-repo pipeline: chart-auditor probe ->
// evidence + regulatory-mapping refute -> fingerprint dedup (barrier) -> soc-ledger-keeper appends missing controls, observations
// and findings (same-id supersession by fingerprint) -> control re-assessment -> report-writer updates summary.md open-findings.
// Every ledger write goes through node .claude/scripts/soc/append.mjs; every file write is validated.
export const meta = {
  name: 'probe-app-chart',
  description: 'Static probe of Helm charts, Kustomize overlays and raw Kubernetes manifests per app repo; pod security, network and supply-chain gaps mapped to SEBI CSCRF, RBI 2026, CIS 8.1.',
  phases: [
    { title: 'Scout', detail: 'List target repos with local checkouts, applicable instruments and the run timestamp; log missing checkouts and filtered apps' },
    { title: 'Probe', detail: 'chart-auditor reviews each checkout, exports SARIF, returns candidate observations and findings' },
    { title: 'Refute', detail: 'refuter judges each candidate through the evidence and regulatory-mapping lenses; every finding must survive the evidence lens, high/critical both' },
    { title: 'Dedup', detail: 'Barrier: merge surviving findings by fingerprint across all repos and observations by control within each repo' },
    { title: 'Write', detail: 'soc-ledger-keeper appends missing applicable controls, observations and findings (same-id supersession by fingerprint), then re-assesses controls' },
    { title: 'Summary', detail: 'report-writer refreshes the open-findings section of summary.md and returns counts' },
  ],
};

const WORKFLOW = 'probe-app-chart';
const PROBE_AGENT = 'chart-auditor';
const BASE_TAGS = ["helm","kubernetes","static-probe"];
const TARGET_NOUN = 'Helm chart and Kubernetes manifest';
const SUMMARY_NOUN = 'Helm chart and manifest gaps';
const MAPPING_RULE = '';
const requiredMappingGap = () => '';
const SCOUT_EXTRA = '';
const TARGET_RULE = 'For every applications/<app_id>/repos/<repo_id>.json decide whether it is a target. A repo is a target when its record has "containsHelmChart": true, or when any applications/<app_id>/env/<env_id>.json lists an "iac" root whose repoId is this repo with tool helm or kustomize (if args.envIds is given, only those env files count). For each target list the chart roots (directories containing Chart.yaml or kustomization.yaml) and any raw manifest directories (k8s/, manifests/, deploy/) relative to the checkout.';
const WRITE_EXTRA = '';
const PROBE_CHECKS = [
  'Checklist:\n- Pod security: containers without securityContext.runAsNonRoot, readOnlyRootFilesystem, allowPrivilegeEscalation: false and capabilities.drop: [ALL]; privileged: true; hostNetwork, hostPID, hostIPC; hostPath mounts; missing seccompProfile RuntimeDefault; namespaces without pod-security.kubernetes.io/enforce labels.\n- Images: tags :latest or no tag, no digest pinning, imagePullPolicy Always missing on mutable tags, images from docker.io/library or unknown registries instead of the company registry, init/sidecar images unpinned.\n- Resources and availability: missing CPU/memory requests and limits, no PodDisruptionBudget for prod replicas, replicas: 1 for regulated workloads, no readiness/liveness probes, no topologySpreadConstraints.\n- Network: no NetworkPolicy or default-deny for the namespace, Ingress without TLS or with wildcard hosts, Services of type LoadBalancer/NodePort on internal workloads, CORS wildcard in ingress annotations.\n- Secrets and identity: plaintext secrets in values.yaml or templates, Secret manifests with literal data, ServiceAccount automountServiceAccountToken not false, default ServiceAccount used, RBAC Roles with verbs ["*"] or cluster-admin bindings, missing ExternalSecret/SecretProviderClass when the env secretsBackend is a vault/secrets manager.\n- Chart hygiene: Chart.yaml dependencies without pinned versions or repository, values schema (values.schema.json) absent, templates that disable validation, kustomize patches removing security fields, helm hooks that run privileged jobs.',
  'To review rendered manifests, render through scan.mjs with --from-stdout (--tool helm -- template {src}/<chart> -f {src}/<chart>/values.yaml for each values file; --tool kustomize -- build {src}/<overlay>); chart dependencies are not fetched. Run scanners only through node .claude/scripts/toolchain/scan.mjs at their pinned versions (scanner-toolchain skill), over the chart sources in the checkout, which kube-linter, checkov and trivy render themselves: kube-linter lint --format sarif, checkov -d {src}/<dir> --framework helm,kubernetes -o sarif, trivy config --format sarif, and kubeconform (convert its JSON output into SARIF results); kube-score is not pinned. If scan.mjs cannot run them (exit 3), review rendered manifests manually (yq/jq) and write the SARIF yourself (tool name "maxwell-chart-auditor").',
  'Cite sebi-cscrf-2024 first for SEBI REs (PR.IP.S1 baseline hardening and least functionality, PR.AA.S2 segmentation, PR.AA.S3 least privilege, PR.AA.S17 API security, PR.DS.S1 encryption in transit, PR.DS.S6 image integrity, PR.MA.S3 patching, GV.SC.S5 SBOM), rbi-cyber-tech-directions-2026 and rbi-it-outsourcing-md-2023 (App-I.6(a) container governance, App-I.6(c)) for banks/NBFCs, irdai-info-cyber-security-2023 for insurers; then cis-controls-8.1 (safeguards 4.x, 12.x, 16.x) and nist-800-53-r5 (CM-6, SC-7, AC-6).',
];

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const argNow = (args && typeof args.now === 'string' && args.now) || null;
if (argNow && !RFC3339_Z.test(argNow)) throw new Error('args.now must be an RFC 3339 UTC timestamp with a trailing Z, got ' + argNow);
const sessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.length ? args.envIds : null;
const exportDir = 'kpis/data/raw/sessions/' + (sessionId || runId || 'unattributed-' + WORKFLOW);
const LEDGER = 'company-profile/' + companyId + '/soc/main.jsonl';
const CLOCK_CMD = 'date -u +%Y-%m-%dT%H:%M:%SZ';
const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
let mappingControlIds = new Set();

const provenanceRule = 'Every record you write carries provenance: harness (claude-code or opencode, whichever you run under), generatedAt, sessionId'
  + (sessionId ? ' = ' + sessionId : ' (your own harness session id; omit only if you cannot determine it)')
  + (runId ? ', runId = ' + runId : ', runId from MAXWELL_RUN_ID when set') + ', workflow = ' + WORKFLOW + ', agent = <your agent name>.';
const dryRunRule = dryRun
  ? 'DRY RUN: do not run scanners that write outside ' + exportDir + ', do not raise findings. Plan the checks, list the evidence you would need, and return observations with result "inconclusive" whose description starts with "dry-run:" and lists the planned checks. findings must be an empty array.'
  : '';

// ---- Schemas for structured agent output -------------------------------------------------------------
const STRS = { type: 'array', items: { type: 'string' } };
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['now', 'targets', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    now: { type: 'string' },
    entityTypes: STRS,
    frameworksInScope: STRS,
    applicableInstruments: STRS,
    workflowControlIds: STRS,
    mappingControlIds: STRS,
    existingControlIds: STRS,
    targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'repoId', 'checkout'],
        properties: {
          appId: { type: 'string' },
          repoId: { type: 'string' },
          checkout: { type: 'string' },
          pinnedCommit: { type: 'string' },
          roots: STRS,
          imageIds: STRS,
          envIds: STRS,
          notes: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        required: ['reason'],
        properties: { appId: { type: 'string' }, repoId: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};

const REG_REF = {
  type: 'object',
  required: ['regulator', 'instrument', 'controlId'],
  properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } },
};
const EVIDENCE = {
  type: 'array',
  items: { type: 'object', required: ['type', 'ref'], properties: { type: { type: 'string' }, ref: { type: 'string' }, description: { type: 'string' }, sha256: { type: 'string' } } },
};
const SEVERITY = { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] };
const PROBE_SCHEMA = {
  type: 'object',
  required: ['appId', 'repoId', 'observations', 'findings', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    appId: { type: 'string' },
    repoId: { type: 'string' },
    pinnedCommit: { type: 'string' },
    sarifPath: { type: 'string' },
    sarifSha256: { type: 'string' },
    observations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['controlId', 'result', 'title', 'description'],
        properties: {
          controlId: { type: 'string' },
          frameworkRef: REG_REF,
          controlTitle: { type: 'string' },
          result: { type: 'string', enum: ['satisfied', 'not-satisfied', 'partial', 'not-applicable', 'inconclusive'] },
          title: { type: 'string' },
          description: { type: 'string' },
          evidence: EVIDENCE,
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'description', 'severity', 'confidence', 'ruleId', 'tool', 'path', 'fingerprint', 'regulatoryRefs', 'tags'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          severity: SEVERITY,
          confidence: { type: 'string', enum: ['confirmed', 'likely', 'possible', 'unverified'] },
          ruleId: { type: 'string' },
          tool: { type: 'string' },
          toolVersion: { type: 'string' },
          path: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          fingerprint: { type: 'string' },
          controlIds: STRS,
          regulatoryRefs: { type: 'array', items: REG_REF },
          targetType: { type: 'string', enum: ['repo', 'image', 'environment', 'application'] },
          targetId: { type: 'string' },
          tags: STRS,
          remediation: { type: 'string' },
          evidence: EVIDENCE,
        },
      },
    },
    skipped: STRS,
    notes: { type: 'string' },
  },
};

// The refuter's own output contract (.claude/agents/refuter.md) plus the corrected* fields it maps corrections onto.
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    sessionId: { type: 'string' },
    refuted: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    lens: { type: 'string' },
    reason: { type: 'string' },
    corrections: {
      type: 'array',
      items: { type: 'object', properties: { path: { type: 'string' }, current: {}, proposed: {}, why: { type: 'string' } } },
    },
    checked: STRS,
    unverifiable: STRS,
    correctedSeverity: SEVERITY,
    correctedRegulatoryRefs: { type: 'array', items: REG_REF },
    correctedControlIds: STRS,
  },
};

const WRITE_SCHEMA = {
  type: 'object',
  required: ['observationIds', 'findingIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    controlIds: STRS,
    observationIds: STRS,
    findingIds: STRS,
    supersededFindingIds: STRS,
    reopenedFindingIds: STRS,
    skipped: STRS,
  },
};

const CONTROLS_SCHEMA = {
  type: 'object',
  required: ['reassessedControlIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    reassessedControlIds: STRS,
    skipped: STRS,
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
    version: { type: 'string' },
    notes: { type: 'string' },
  },
};

// ---- Phase 1: Scout -----------------------------------------------------------------------------------
phase('Scout');
log('Scouting ' + companyId + ' for ' + TARGET_NOUN + ' repos' + (appFilter ? ' (apps: ' + appFilter.join(', ') + ')' : '') + (envFilter ? ' (envs: ' + envFilter.join(', ') + ')' : ''));
const scout = await agent(
  [
    'You are scouting the Maxwell workspace for the ' + WORKFLOW + ' workflow. Company: ' + companyId + '. Read-only: do not write any file.',
    argNow ? 'Run timestamp: ' + argNow + ' (return it verbatim as now).' : 'Run `' + CLOCK_CMD + '` once and return its output as now; every later stage of this run reuses that single timestamp.',
    'Read company-profile/' + companyId + '/details.json: return entityTypes and frameworksInScope. Read .claude/skills/regulatory-catalogs/references/instruments.json and return applicableInstruments: the instrumentIds in frameworksInScope whose applicability covers the company (applicability.entityTypes empty or intersecting entityTypes; applicability.categories, when present, intersecting details.json regulatoryRegistrations[].category; applicability.jurisdictions empty or containing IN when the company is Indian). Never return an instrument whose registry status is repealed or superseded (it may be cited only as a secondary, historical mapping); return its supersededBy successors instead when they are in frameworksInScope and cover the company.',
    'For every applicable instrument whose .claude/skills/regulatory-catalogs/references/catalogs/<instrumentId>.catalog.json exists, walk its groups and controls and return workflowControlIds: the instrument-qualified ids ("<instrumentId>:<controlId>") of every control whose probeWorkflows includes "' + WORKFLOW + '".',
    SCOUT_EXTRA,
    'List every application directory under applications/.',
    appFilter ? 'Only consider these appIds: ' + appFilter.join(', ') + '. Add a skipped entry for every other app with reason "filtered by args.appIds".' : 'Consider every application.',
    envFilter ? 'Only environment files applications/<app_id>/env/{' + envFilter.join(',') + '}.json count when deciding targets.' : '',
    TARGET_RULE,
    'A target is only usable when a local checkout directory exists at applications/<app_id>/repos/<repo_id>/ (the repo record localCheckout, gitignored). Verify with Glob (the pattern applications/<app_id>/repos/<repo_id>/** must match at least one file). If the directory is missing or empty, do NOT list it as a target: add a skipped entry {appId, repoId, reason: "checkout missing at applications/<app_id>/repos/<repo_id>/ - run refresh-ctx or clone it"}. Never clone or fetch anything.',
    'Also read ' + LEDGER + ' and return existingControlIds: the ids of every kind "control" record (instrument-qualified, e.g. sebi-cscrf-2024:GV.SC.S5) so later stages reference controls that exist.',
    'Return {now, entityTypes, frameworksInScope, applicableInstruments, workflowControlIds, mappingControlIds, existingControlIds, targets [{appId, repoId, checkout, pinnedCommit, roots, imageIds, envIds, notes}], skipped [{appId, repoId, reason}]}. List every app you considered either as a target or as skipped so nothing is dropped silently.',
  ].filter(Boolean).join('\n'),
  { label: 'scout', phase: 'Scout', agentType: 'ctx-researcher', schema: SCOUT_SCHEMA, effort: 'low' },
);
if (!scout) throw new Error('Scout returned nothing; cannot continue');
noteSession(scout);
const now = argNow || scout.now;
if (!now || !RFC3339_Z.test(now)) throw new Error('No usable run timestamp: pass args.now (RFC 3339 UTC with Z); Scout returned ' + JSON.stringify(scout.now));
for (const s of scout.skipped || []) { skipped.push(s); log('skipped ' + (s.appId || '?') + (s.repoId ? '/' + s.repoId : '') + ': ' + s.reason); }
const targets = (scout.targets || []).filter((t) => t && t.appId && t.repoId && t.checkout);
const entityTypes = scout.entityTypes || [];
const applicableInstruments = scout.applicableInstruments || [];
const workflowControlIds = scout.workflowControlIds || [];
const existingControlIds = scout.existingControlIds || [];
mappingControlIds = new Set(scout.mappingControlIds || []);
log('run timestamp ' + now + '; ' + targets.length + ' target repo(s) with checkouts; ' + skipped.length + ' skipped; ' + existingControlIds.length + ' existing control record(s); applicable instruments: ' + (applicableInstruments.join(', ') || 'none resolved'));
if (!targets.length) {
  log('No ' + TARGET_NOUN + ' repo with a local checkout for ' + companyId + '; nothing to probe');
  return { companyId, workflow: WORKFLOW, dryRun, now, targets: [], observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, skipped, sessionIds: [...sessionIds] };
}

const probeTimeRule = 'Run timestamp: ' + now + '. Use it for every timestamp you write (SARIF invocation times, provenance.generatedAt); never read the clock yourself.';
const ledgerTimeRule = 'Run timestamp: ' + now + '. Use it as collectedAt, generatedAt, lastSeenAt, and firstSeenAt of new findings, lastAssessedAt and the base for expiresAt, nextDueAt and slaDueAt arithmetic (never read the clock yourself). recordedAt must never decrease within ' + LEDGER + ': immediately before your first append read the last line and set recordedAt on every record you append = the later of ' + now + ' and that line\'s recordedAt.';

// ---- Phase 2 + 3: per-repo pipeline (probe -> refute) ---------------------------------------------------
phase('Probe');
log('Probing ' + targets.length + ' repo(s); refutation runs interleaved per repo inside the same pipeline (agents are tagged phase Refute)');
const probePrompt = (t) => [
  'You are the ' + PROBE_AGENT + ' running the ' + WORKFLOW + ' workflow for company ' + companyId + ' (entityTypes: ' + (entityTypes.join(', ') || 'unknown') + '; applicable instruments: ' + (applicableInstruments.join(', ') || 'resolve them from details.json and instruments.json') + ').',
  'Target: app ' + t.appId + ', repo ' + t.repoId + ', checkout ' + t.checkout + (t.pinnedCommit ? ' at commit ' + t.pinnedCommit : '') + '. Roots to review: ' + ((t.roots || []).join(', ') || 'discover them yourself') + '.' + (t.imageIds && t.imageIds.length ? ' Related image records: ' + t.imageIds.join(', ') + '.' : '') + (t.notes ? ' Scout notes: ' + t.notes : ''),
  'Read first: applications/' + t.appId + '/README.md, applications/' + t.appId + '/repos/' + t.repoId + '.json, applications/' + t.appId + '/env/*.json, company-profile/' + companyId + '/details.json, company-profile/' + companyId + '/sdlc/policy.json.',
  'Read the skills: .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/sarif-findings/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md (and its references/instruments.json, sla-table.json and catalogs), .claude/skills/soc-ledger/SKILL.md, .claude/skills/reference-architectures/SKILL.md.',
  'STATIC and READ-ONLY: inspect files in the checkout only. Never run terraform/helm/kubectl against real infrastructure, never contact a registry, cluster, cloud API, database or model endpoint, never modify the checkout. Run only the commands your agent definition permits, and every scanner only through node .claude/scripts/toolchain/scan.mjs (pinned; scanner-toolchain skill); when scan.mjs exits 3 (no executor) or a tool is not pinned, say so in skipped and review manually.',
  ...PROBE_CHECKS,
  'Export: write a SARIF 2.1.0 log of every result to ' + exportDir + '/' + WORKFLOW + '.' + t.appId + '.' + t.repoId + '.sarif.export.json (create the directory; this path is sanctioned by the layout) and return it as sarifPath with its sha256 (sha256sum <path>) as sarifSha256. Follow .claude/skills/sarif-findings/SKILL.md sections 2-3: set automationDetails.id to maxwell/' + WORKFLOW + '/' + companyId + '/' + t.appId + '/' + t.repoId + ', versionControlProvenance[0].revisionId to the pinned commit, artifactLocation.uri relative to the checkout, secrets redacted from message text and snippets, and fingerprints["maxwell/v1"] on every result equal to the ledger fingerprint below.',
  'Fingerprint (soc-ledger section 6): fingerprint = sha256 hex of "<ruleId>|<targetKey>|<normalisedPath>" where ruleId is the scanner rule id copied verbatim (for a hand-written maxwell-* SARIF result, a stable kebab-case id naming the class of gap, reused across runs, never per instance), targetKey is "repo:' + t.appId + '/' + t.repoId + '" (or "image:' + t.appId + '/<imageId>" or "environment:' + t.appId + '/<envId>" when targetType is image or environment) and normalisedPath is the checkout-relative path with any leading ./ removed, backslashes turned into /, duplicate and trailing slashes collapsed and NO line numbers or timestamps, so re-runs match. Compute it with `printf %s "<ruleId>|<targetKey>|<normalisedPath>" | sha256sum` and keep only the 64-hex first field.',
  'Return observations: one per control you evidenced (controlId in instrument-qualified form <instrumentId>:<controlId>, e.g. sebi-cscrf-2024:PR.IP.S1; the instrument must be one of the applicable instruments; prefer these catalog controls mapped to this workflow: ' + (workflowControlIds.join(', ') || 'none resolved') + '; and these existing ledger controls: ' + (existingControlIds.join(', ') || 'none yet') + '; when you need a control that is in neither list include frameworkRef {regulator, instrument, controlId} and controlTitle so the ledger keeper can check it against the catalog), result satisfied|not-satisfied|partial|not-applicable|inconclusive, title, description, evidence [{type: workspace-file|sarif|command-output|sbom|url, ref, description, sha256?}]. Results that are pass/informational feed result satisfied; never turn inconclusive evidence into a finding.',
  'Return findings: only gaps you can point at (path + line + snippet in description), severity per .claude/skills/maxwell-conventions/SKILL.md section 4 (a security-severity or CVSS score first; otherwise the catalog defaultSeverity of the most specific control cited; the scanner level error=high/warning=medium/note=low only when no catalog control resolves; never intuition; info-level results are observations, not findings), confidence, ruleId, tool, toolVersion, path (relative to the checkout), startLine/endLine, fingerprint, controlIds (subset of the observation controlIds), regulatoryRefs (regulator from the regulators vocab, instrument from the instruments vocab and applicable to the company, controlId; most specific Indian instrument first), targetType repo (or image/environment when the gap is really about that asset, with targetId), tags (lower-case, start with ' + BASE_TAGS.join(', ') + '), remediation, evidence.',
  'Return skipped: every root, file type or check you could not perform (tool missing or not permitted, file unreadable, out of scope) so nothing is dropped silently. Do NOT write to the ledger or summary.md: the soc-ledger-keeper does that after refutation.',
  probeTimeRule, provenanceRule, dryRunRule,
].filter(Boolean).join('\n');

const normPath = (x) => String(x || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
const runLabel = runId || sessionId || (WORKFLOW + ' at ' + now);
const targetOf = (t, f) => {
  if (f.targetType === 'image' && f.targetId) return { type: 'image', appId: t.appId, imageId: f.targetId };
  if (f.targetType === 'environment' && f.targetId) return { type: 'environment', appId: t.appId, envId: f.targetId };
  if (f.targetType === 'application') return { type: 'application', appId: t.appId };
  return { type: 'repo', appId: t.appId, repoId: t.repoId };
};
// Fingerprints are computed here from ruleId, target and path instead of trusting the probe's copy: models drop
// characters when they retype a 64-hex hash (2026-09-14: six db-models findings lost that way). Workflow scripts have
// no crypto module, so this is a plain SHA-256.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const sha256Hex = (text) => {
  const bytes = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 4294967296);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, j) => { h[j] = (h[j] + v) | 0; });
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
};
// targetKey as the probe prompt defines it (soc-ledger section 6).
const targetKeyOf = (t, f) => {
  const tg = targetOf(t, f);
  if (tg.type === 'image') return 'image:' + t.appId + '/' + tg.imageId;
  if (tg.type === 'environment') return 'environment:' + t.appId + '/' + tg.envId;
  if (tg.type === 'application') return 'application:' + t.appId;
  return 'repo:' + t.appId + '/' + t.repoId;
};
// The candidate as the ledger keeper will append it, minus the fields computed at write time.
const candidateRecord = (t, probe, f) => ({
  kind: 'finding',
  title: f.title,
  description: f.description + (f.remediation ? '\nRemediation: ' + f.remediation : ''),
  severity: f.severity,
  confidence: f.confidence,
  controlIds: f.controlIds || [],
  regulatoryRefs: f.regulatoryRefs || [],
  target: targetOf(t, f),
  location: Object.assign({ path: normPath(f.path) }, Number.isInteger(f.startLine) ? { startLine: f.startLine } : {}, Number.isInteger(f.endLine) ? { endLine: f.endLine } : {}),
  fingerprint: f.fingerprint,
  source: Object.assign({ kind: 'sarif', ruleId: f.ruleId, tool: f.tool }, f.toolVersion ? { toolVersion: f.toolVersion } : {}),
  status: 'open',
  evidence: (f.evidence || []).concat(probe.sarifPath ? [Object.assign({ type: 'sarif', ref: probe.sarifPath }, probe.sarifSha256 ? { sha256: probe.sarifSha256 } : {})] : []),
  tags: f.tags || [],
});

const refutePrompt = (t, probe, f, lens, note) => [
  'You are the refuter for the ' + WORKFLOW + ' workflow. Lens: ' + lens + '. Try to REFUTE the candidate finding below under that lens; the burden of proof is on the candidate, so default to refuted=true when you cannot verify it yourself from files you opened.',
  'Context: ' + JSON.stringify({ companyId, workflow: WORKFLOW, sessionId: sessionId || undefined, runId: runId || undefined, appId: t.appId, repoId: t.repoId, checkout: t.checkout, pinnedCommit: t.pinnedCommit || undefined, sarifPath: probe.sarifPath || undefined, sarifSha256: probe.sarifSha256 || undefined, now }),
  'Candidate finding (the record as it will be appended; id, provenance, recordedAt, firstSeenAt, lastSeenAt, relatedObservationIds, slaBasis and slaDueAt are computed by the ledger keeper after refutation, so do not check them and never refute for their absence):\n' + JSON.stringify(candidateRecord(t, probe, f), null, 1),
  note || '',
  lens === 'evidence'
    ? 'What to check (evidence lens): open the cited location in the checkout (' + t.checkout + '/' + f.path + ') and the SARIF export (' + (probe.sarifPath || 'none was written') + '); confirm the code or configuration actually exhibits the gap, is not overridden elsewhere (values overlays, provider defaults, ignore files, compensating controls in the same repo), is reachable in a deployed environment (applications/' + t.appId + '/env/*.json), and that the severity is justified. Put a lower severity the evidence supports in correctedSeverity; never raise it.'
    : 'What to check (regulatory-mapping lens): read .claude/skills/regulatory-catalogs/SKILL.md and its references; check that every regulatoryRef instrument applies to this company (company-profile/' + companyId + '/details.json frameworksInScope, entityTypes and regulatoryRegistrations against instruments.json applicability), that the controlId exists in that instrument catalog when a catalog file exists and actually covers the gap, that the most specific Indian instrument is cited first, and that severity follows .claude/skills/maxwell-conventions/SKILL.md section 4 (score, else catalog defaultSeverity, else scanner level). ' + MAPPING_RULE + ' Refute only when no applicable clause exists or the mapping cannot be repaired.',
  'Read-only: never modify the checkout or the workspace. Return your verdict in the output schema: refuted, confidence, lens, reason, corrections, checked, unverifiable. Map every repairable correction to severity, regulatoryRefs or controlIds onto correctedSeverity, correctedRegulatoryRefs (full objects, Indian instrument first) and correctedControlIds (instrument-qualified); a repairable candidate is refuted=false.',
  'The candidate fingerprint was computed by the workflow as sha256(ruleId|targetKey|path). Match SARIF results by ruleId, path and lines; a SARIF fingerprints value that differs from it is a transcription slip in the export, never a reason to refute.',
].filter(Boolean).join('\n');

const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
const rank = (s) => SEV_ORDER.indexOf(s);
const lower = (a, b) => (rank(a) <= rank(b) ? a : b);
const higher = (a, b) => (rank(a) >= rank(b) ? a : b);
const isSevere = (s) => s === 'high' || s === 'critical';

const probed = await pipeline(
  targets,
  async (t, _item, index) => {
    const r = await agent(probePrompt(t), { label: 'probe ' + t.appId + '/' + t.repoId + ' #' + (index + 1), phase: 'Probe', agentType: PROBE_AGENT, schema: PROBE_SCHEMA, effort: 'high' });
    if (!r) { skipped.push({ appId: t.appId, repoId: t.repoId, reason: 'probe agent returned no schema-valid result' }); log('probe failed for ' + t.appId + '/' + t.repoId); return null; }
    noteSession(r);
    for (const s of r.skipped || []) skipped.push({ appId: t.appId, repoId: t.repoId, reason: 'probe: ' + s });
    log(t.appId + '/' + t.repoId + ': ' + (r.observations || []).length + ' observation(s), ' + (r.findings || []).length + ' candidate finding(s)' + (r.sarifPath ? ', sarif ' + r.sarifPath : ''));
    return { target: t, probe: r };
  },
  async (prev) => {
    if (!prev) return null;
    const { target: t, probe } = prev;
    const all = (probe.findings || []).filter(Boolean);
    const candidates = [];
    let recomputed = 0;
    for (const f of all) {
      if (f.ruleId && f.path) {
        const fp = sha256Hex(f.ruleId + '|' + targetKeyOf(t, f) + '|' + normPath(f.path));
        if (f.fingerprint !== fp) { recomputed += 1; f.fingerprint = fp; }
      }
      const why = !f.fingerprint || !f.path ? 'lacked a fingerprint or path'
        : !/^[0-9a-f]{64}$/.test(f.fingerprint) ? 'fingerprint is not a sha256 hex digest'
        : f.severity === 'info' ? 'severity info is recorded as an observation, not a finding'
        : !(f.regulatoryRefs || []).length ? 'cited no regulatoryRef'
        : requiredMappingGap(f);
      if (why) { skipped.push({ appId: t.appId, repoId: t.repoId, reason: 'candidate dropped before refutation (' + why + '): ' + (f.title || f.ruleId || '?') }); continue; }
      candidates.push(f);
    }
    if (recomputed) log(t.appId + '/' + t.repoId + ': ' + recomputed + ' candidate fingerprint(s) differed from sha256(ruleId|targetKey|path) and were recomputed');
    if (dryRun) {
      if (candidates.length) skipped.push({ appId: t.appId, repoId: t.repoId, reason: 'dry-run: ' + candidates.length + ' candidate finding(s) discarded; only inconclusive observations are written' });
      return { target: t, probe, findings: [] };
    }
    // Candidates are refuted concurrently, as many at a time as the harness allows; each returns its merged finding
    // or null. Refuting them one after another made this stage take hours on a slow model (2026-09-16).
    const refuted = await pipeline(candidates, async (f) => {
      const i = candidates.indexOf(f);
      const lenses = ['evidence', 'regulatory-mapping'];
      const votes = await parallel(lenses.map((lens) => () =>
        agent(refutePrompt(t, probe, f, lens), { label: 'refute ' + lens + ' ' + t.repoId + ' #' + (i + 1), phase: 'Refute', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' })));
      votes.forEach(noteSession);
      const [ev, mp] = votes;
      const drop = (why) => skipped.push({ appId: t.appId, repoId: t.repoId, reason: why + ': ' + f.title });
      // Every finding must survive the evidence lens; a mapping-lens refutation means no applicable clause exists.
      if (!ev) { drop('dropped: evidence lens returned no verdict'); return null; }
      if (ev.refuted) { drop('refuted by the evidence lens (' + ev.reason + ')'); return null; }
      if (mp && mp.refuted) { drop('refuted by the regulatory-mapping lens (' + mp.reason + ')'); return null; }
      const merged = { ...f };
      if (mp && mp.correctedRegulatoryRefs && mp.correctedRegulatoryRefs.length) merged.regulatoryRefs = mp.correctedRegulatoryRefs;
      if (mp && mp.correctedControlIds && mp.correctedControlIds.length) merged.controlIds = mp.correctedControlIds;
      // The mapping lens sets severity from the catalog; the evidence lens may only lower it, and its lowering is applied last.
      let severity = (mp && mp.correctedSeverity) || f.severity;
      if (ev.correctedSeverity) severity = lower(severity, ev.correctedSeverity);
      let evidenceReason = ev.reason;
      if (rank(severity) > rank(f.severity) && isSevere(severity) && !(ev.correctedSeverity && rank(ev.correctedSeverity) >= rank(severity))) {
        // The evidence lens judged the lower original severity: re-run it on the raised candidate before accepting high/critical.
        const again = await agent(refutePrompt(t, probe, { ...merged, severity }, 'evidence', 'The regulatory-mapping lens raised severity from ' + f.severity + ' to ' + severity + ' (' + mp.reason + '). Judge whether the evidence supports ' + severity + '.'),
          { label: 'refute evidence (raised) ' + t.repoId + ' #' + (i + 1), phase: 'Refute', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' });
        noteSession(again);
        if (!again || again.refuted) { drop('dropped after the mapping lens raised severity to ' + severity + ': evidence lens ' + (again ? 'refuted (' + again.reason + ')' : 'returned no verdict')); return null; }
        if (again.correctedSeverity) severity = lower(severity, again.correctedSeverity);
        evidenceReason = again.reason;
      }
      merged.severity = severity;
      // high/critical (before or after corrections) must have survived BOTH lenses.
      if (isSevere(higher(f.severity, merged.severity)) && !mp) { drop('dropped: ' + higher(f.severity, merged.severity) + ' finding needs both lenses but the regulatory-mapping lens returned no verdict'); return null; }
      const postGap = requiredMappingGap(merged);
      if (postGap || merged.severity === 'info') { drop('dropped after refutation corrections (' + (postGap || 'severity lowered to info; observation only') + ')'); return null; }
      merged.refutationSummary = 'Refutation: evidence lens not refuted (' + evidenceReason + ')' + (mp ? '; regulatory-mapping lens not refuted (' + mp.reason + ')' : '; regulatory-mapping lens returned no verdict') + '.';
      return merged;
    });
    const survivors = refuted.filter(Boolean);
    log(t.appId + '/' + t.repoId + ': ' + survivors.length + '/' + candidates.length + ' finding(s) survived refutation');
    return { target: t, probe, findings: survivors };
  },
);

// ---- Phase 4: Dedup (barrier: needs every repo's survivors) ---------------------------------------------
phase('Dedup');
const byFingerprint = new Map();
const perTarget = [];
for (const item of probed.filter(Boolean)) {
  const keep = [];
  for (const f of item.findings) {
    const key = f.fingerprint;
    if (byFingerprint.has(key)) {
      const first = byFingerprint.get(key);
      skipped.push({ appId: item.target.appId, repoId: item.target.repoId, reason: 'duplicate fingerprint ' + key.slice(0, 12) + ' already reported for ' + first.appId + '/' + first.repoId + ': ' + f.title });
      continue;
    }
    byFingerprint.set(key, { appId: item.target.appId, repoId: item.target.repoId });
    keep.push(f);
  }
  const seenControls = new Set();
  const observations = [];
  for (const o of item.probe.observations || []) {
    if (!o || !o.controlId) continue;
    if (seenControls.has(o.controlId)) { skipped.push({ appId: item.target.appId, repoId: item.target.repoId, reason: 'duplicate observation for control ' + o.controlId + ' merged' }); continue; }
    seenControls.add(o.controlId);
    observations.push(dryRun ? { ...o, result: 'inconclusive', description: (o.description || '').startsWith('dry-run:') ? o.description : 'dry-run: ' + o.description } : o);
  }
  perTarget.push({ target: item.target, probe: item.probe, observations, findings: keep });
}
const totalObs = perTarget.reduce((n, p) => n + p.observations.length, 0);
log(byFingerprint.size + ' unique finding(s) and ' + totalObs + ' observation(s) across ' + perTarget.length + ' repo(s) after dedup');

// ---- Phase 5: Write (sequential per repo so ledger id/fingerprint checks never race) ----------------------
phase('Write');
const written = { controlIds: [], observationIds: [], findingIds: [], supersededFindingIds: [], reopenedFindingIds: [], reassessedControlIds: [] };
const observedControlIds = new Set();
const CATALOG_RULE = 'A control is applicable only when its instrument is one of ' + JSON.stringify(applicableInstruments) + ' and, when .claude/skills/regulatory-catalogs/references/catalogs/<instrumentId>.catalog.json exists, its controlId exists in that catalog (walk groups and controls).';
for (const p of perTarget) {
  if (!p.observations.length && !p.findings.length) { log('nothing to write for ' + p.target.appId + '/' + p.target.repoId); continue; }
  const sarifEvidence = p.probe.sarifPath ? JSON.stringify(Object.assign({ type: 'sarif', ref: p.probe.sarifPath }, p.probe.sarifSha256 ? { sha256: p.probe.sarifSha256 } : {})) : null;
  const w = await agent(
    [
      'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md (sections 2, 4, 5, 6, 8 and 9), .claude/skills/maxwell-conventions/SKILL.md and .claude/skills/regulatory-catalogs/SKILL.md (references/instruments.json, sla-table.json and catalogs) before writing.',
      'Ledger: ' + LEDGER + ' (append-only). Write EVERY record by piping JSON to `node .claude/scripts/soc/append.mjs ' + companyId + ' -`; never edit the ledger directly. A rejected append means the record is wrong: fix it and retry. Read the latest state per id (last line per id, soc-ledger section 3) before deciding anything. Mint obs_/fnd_ ULIDs with the helper in maxwell-conventions, never by hand.',
      'Target: app ' + p.target.appId + ', repo ' + p.target.repoId + (p.target.pinnedCommit ? ' at ' + p.target.pinnedCommit : '') + '. SARIF export: ' + (p.probe.sarifPath || 'none') + (p.probe.sarifSha256 ? ' (sha256 ' + p.probe.sarifSha256 + ')' : '') + '.',
      dryRun
        ? 'Step 1 - controls (DRY RUN): create NO control records. Write an observation only when its controlId already exists as a kind "control" record; list every other controlId under skipped as "dry-run: control <id> not in ledger; observation not written".'
        : 'Step 1 - missing controls only: for each observation controlId with no kind "control" record in the ledger, create it only if it is applicable. ' + CATALOG_RULE + ' An applicable new control: id = the instrument-qualified controlId, frameworkRefs [the control itself {regulator, instrument, controlId}, then the catalog mappings], title = the catalog title (or the observation controlTitle when the instrument has no catalog file), implementationStatus "unknown" (it moves only on evidence of the implementation or a human note, never from one repo\'s scan result), effectiveness "not-tested" (the Controls step re-assesses it), applicableAssets [{type: "application", appId: "' + p.target.appId + '"}]. A controlId that is not applicable gets no control record and no observation: list it under skipped with the reason. Never supersede an existing control in this step.',
      'Step 2 - observations (one per control evidenced): kind observation, id obs_<ULID>, supersedes = the id of the latest observation whose methods include "' + WORKFLOW + '", whose subjects equal this repo and whose controlIds contain the same control (omit supersedes when none exists), controlIds [that control], title, description, methods ["' + WORKFLOW + '"], subjects [{type: "repo", appId: "' + p.target.appId + '", repoId: "' + p.target.repoId + '"}], collectedAt, expiresAt = collectedAt + the catalog cadence of the control in days (daily 1, weekly 7, monthly 30, quarterly 91, half-yearly 182, annual 365, biennial 730; continuous, event-driven or no catalog entry: 30, the static-probe re-run interval), result, ' + (dryRun ? 'no toolOutput, ' : 'toolOutput {format: "sarif", path: sarifPath, sha256: sarifSha256} when a SARIF export exists, ') + 'evidence, tags ' + JSON.stringify(BASE_TAGS) + '.',
      'Observations to write:\n' + JSON.stringify(p.observations, null, 1),
      dryRun
        ? 'DRY RUN: write these inconclusive observations only. Write no findings and no control records.'
        : 'Step 3 - findings (soc-ledger sections 6 and 8.1-8.2): for each candidate below grep the ledger for its fingerprint and take the latest record of the matching finding id.\n'
          + '(a) A finding with that fingerprint exists: append a supersession with the SAME id and supersedes = that id (never a second fnd_ id). Start from the latest record; keep id, firstSeenAt, target, source, initiativeId and suggestionIds; set lastSeenAt = the run timestamp; then by latest status: open, triaged or remediating keep the status and refresh severity, confidence, description, location, evidence, controlIds, regulatoryRefs, relatedObservationIds and tags from the candidate (recompute slaBasis/slaDueAt from the ORIGINAL firstSeenAt only when severity changed); resolved becomes status "open" with statusReason "regressed in run ' + runLabel + '", no resolvedAt, and the candidate refreshes as for open (list the id under reopenedFindingIds too); false-positive, duplicate, or risk-accepted whose accepted risk (a kind "risk" record in status accepted listing this finding in relatedFindingIds) has acceptedUntil after the run timestamp keep status, statusReason and every other field, refreshing ONLY lastSeenAt; risk-accepted whose acceptedUntil has passed becomes status "open" with statusReason "risk acceptance <rsk id> expired; re-observed in run ' + runLabel + '", refreshed as for open, and that risk is superseded (same id) with status "open". List every such id under supersededFindingIds, not findingIds.\n'
          + '(b) No finding has that fingerprint: mint a new fnd_ id with status "open", firstSeenAt = lastSeenAt = the run timestamp, and list it under findingIds.\n'
          + 'Build each record from the candidate: kind finding, title, description (the candidate description with the snippet, then its refutationSummary), severity, confidence, controlIds (must exist as control records; drop ids that do not and say so in skipped), regulatoryRefs (regulator/instrument/controlId exactly as given), target {type, appId, repoId|imageId|envId} from targetType/targetId (default the repo), location {path (checkout-relative, leading ./ removed), startLine, endLine}, fingerprint, source {kind: "sarif", ruleId, tool, toolVersion}, slaDueAt = firstSeenAt + slaBasis.days with slaBasis {instrument, controlId, topic, severity, days} copied verbatim from the .claude/skills/regulatory-catalogs/references/sla-table.json row chosen per soc-ledger section 6 (instruments in details.json frameworksInScope plus those cited, topic patch-sla for fixable misconfigurations unless the instrument hardRequirements name another topic the control implements, precedence as the table declares, defaults[severity] when no row matches; sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays overrides patch-sla only under company-override), relatedObservationIds (the observation ids you just appended for its controlIds), evidence (the candidate evidence' + (sarifEvidence ? ', which must include ' + sarifEvidence : '') + '), tags (as given). Do not copy candidate keys the record schema lacks (refutationSummary, ruleId, tool, toolVersion, path, startLine, endLine, targetType, targetId, remediation) after mapping them as described. ' + WRITE_EXTRA,
      dryRun ? '' : 'Findings to write:\n' + JSON.stringify(p.findings, null, 1),
      'Do not re-assess existing controls (effectiveness, lastAssessedAt, nextDueAt): the Controls step does that after every repo is written.',
      ledgerTimeRule, provenanceRule,
      'After writing run `node .claude/scripts/validate-data.mjs ' + LEDGER + '` and fix anything it reports. Return {controlIds (controls created), observationIds, findingIds (new), supersededFindingIds (re-seen), reopenedFindingIds, skipped} where skipped lists every observation or candidate you could not write and why. Do not touch summary.md.',
    ].filter(Boolean).join('\n'),
    { label: 'write ' + p.target.appId + '/' + p.target.repoId, phase: 'Write', agentType: 'soc-ledger-keeper', schema: WRITE_SCHEMA, effort: 'medium' },
  );
  if (!w) { skipped.push({ appId: p.target.appId, repoId: p.target.repoId, reason: 'ledger keeper returned no result; ' + p.observations.length + ' observation(s) and ' + p.findings.length + ' finding(s) not written' }); continue; }
  noteSession(w);
  written.controlIds.push(...(w.controlIds || []));
  written.observationIds.push(...(w.observationIds || []));
  written.findingIds.push(...(w.findingIds || []));
  written.supersededFindingIds.push(...(w.supersededFindingIds || []));
  written.reopenedFindingIds.push(...(w.reopenedFindingIds || []));
  if ((w.observationIds || []).length) for (const o of p.observations) if (o.result !== 'inconclusive') observedControlIds.add(o.controlId);
  for (const s of w.skipped || []) skipped.push({ appId: p.target.appId, repoId: p.target.repoId, reason: 'write: ' + s });
  log(p.target.appId + '/' + p.target.repoId + ': wrote ' + (w.observationIds || []).length + ' observation(s), ' + (w.findingIds || []).length + ' new and ' + (w.supersededFindingIds || []).length + ' re-seen finding(s)');
}

// Controls follow observations (soc-ledger 8.4): one re-assessment across every repo written in this run.
if (!dryRun && observedControlIds.size) {
  const c = await agent(
    [
      'You are the soc-ledger-keeper re-assessing controls after the ' + WORKFLOW + ' workflow wrote its observations and findings for company ' + companyId + '. Read .claude/skills/soc-ledger/SKILL.md sections 3, 4 and 8.4 first.',
      'Controls to re-assess (only those that exist as kind "control" records in ' + LEDGER + '; skip the rest and say so): ' + JSON.stringify([...observedControlIds]),
      'For each control: take the latest non-expired observation per subject whose controlIds contain it (this run\'s and earlier ones; expiresAt after the run timestamp) whose result is not inconclusive or not-applicable. Derive effectiveness across those subjects: all satisfied -> "effective"; all not-satisfied -> "ineffective"; any partial, or a mix of satisfied and not-satisfied -> "partially-effective"; none -> leave the control untouched and list it under skipped. lastAssessedAt = the latest collectedAt among them; nextDueAt = lastAssessedAt + the catalog cadence in days (daily 1, weekly 7, monthly 30, quarterly 91, half-yearly 182, annual 365, biennial 730; continuous, event-driven or no catalog entry: 30).',
      'Append a supersession of the control (same id, supersedes = that id) copying the latest record and changing only effectiveness, lastAssessedAt, nextDueAt, evidence (the latest workspace evidence of those observations) and applicableAssets (when the latest record lists applicableAssets, add {type: "application", appId} for every application observed in this run that is missing; when it omits them the control stays company-wide). Keep implementationStatus unchanged. Skip the append when effectiveness, lastAssessedAt and nextDueAt would all be unchanged. Append via `node .claude/scripts/soc/append.mjs ' + companyId + ' -`.',
      ledgerTimeRule, provenanceRule,
      'After writing run `node .claude/scripts/validate-data.mjs ' + LEDGER + '` and fix anything it reports. Return {reassessedControlIds, skipped}. Do not touch summary.md.',
    ].join('\n'),
    { label: 'controls', phase: 'Write', agentType: 'soc-ledger-keeper', schema: CONTROLS_SCHEMA, effort: 'medium' },
  );
  if (!c) skipped.push({ reason: 'control re-assessment returned no result; effectiveness of ' + observedControlIds.size + ' control(s) not updated' });
  else {
    noteSession(c);
    written.reassessedControlIds.push(...(c.reassessedControlIds || []));
    for (const s of c.skipped || []) skipped.push({ reason: 'controls: ' + s });
    log('re-assessed ' + (c.reassessedControlIds || []).length + ' control(s)');
  }
}

// ---- Phase 6: Summary ---------------------------------------------------------------------------------
phase('Summary');
let summary = null;
if (dryRun) {
  log('dry-run: summary.md left unchanged');
} else if (!written.observationIds.length && !written.findingIds.length && !written.supersededFindingIds.length) {
  log('nothing was written to the ledger; summary.md left unchanged');
} else {
  summary = await agent(
    [
      'You are the report-writer. Refresh the "open-findings" section of company-profile/' + companyId + '/summary.md after the ' + WORKFLOW + ' workflow. Read .claude/skills/report-templates/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md first.',
      'Source of truth: ' + LEDGER + '. Take the latest record per finding id (the last line for that id), keep status open|triaged|remediating, and render the open-findings section grouped by severity with title, target, primary regulatoryRef, slaDueAt and finding id. Mention the ' + SUMMARY_NOUN + ' written in this run: ' + written.findingIds.length + ' new finding(s) ' + JSON.stringify(written.findingIds) + ', ' + written.supersededFindingIds.length + ' re-seen (' + written.reopenedFindingIds.length + ' reopened), ' + written.observationIds.length + ' observation(s).',
      'Edit only that section and the frontmatter: bump version minor, keep "sections" accurate, and recompute provenance.inputsHash exactly as the company-summary schema describes (sha256 over details.json, sdlc/policy.json, sdlc/metastore.json if present, vendors/*.json sorted, soc/main.jsonl, change_management/master.json, change_management/initiatives/*/timeline.json sorted, suggestions/master.json). Do not create any other file.',
      'Run timestamp: ' + now + '. Use it as provenance.generatedAt.', provenanceRule,
      'Validate with `node .claude/scripts/validate-data.mjs company-profile/' + companyId + '/summary.md` and return {updated, openFindings, bySeverity, version, notes}.',
    ].join('\n'),
    { label: 'summary', phase: 'Summary', agentType: 'report-writer', schema: SUMMARY_SCHEMA, effort: 'medium' },
  );
  if (!summary) skipped.push({ reason: 'report-writer returned no result; summary.md may be stale' });
  else { noteSession(summary); log('summary.md open-findings: ' + summary.openFindings + ' open finding(s), version ' + (summary.version || '?')); }
}

log('done: ' + written.observationIds.length + ' observation(s), ' + written.findingIds.length + ' new and ' + written.supersededFindingIds.length + ' re-seen finding(s), ' + skipped.length + ' skipped item(s) logged');
return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  now,
  targets: targets.map((t) => t.appId + '/' + t.repoId),
  controls: written.controlIds.length,
  reassessedControls: written.reassessedControlIds.length,
  observations: written.observationIds.length,
  findings: written.findingIds.length,
  reseenFindings: written.supersededFindingIds.length,
  reopenedFindings: written.reopenedFindingIds.length,
  risks: 0,
  initiatives: 0,
  suggestions: 0,
  ids: written,
  summary,
  skipped,
  sessionIds: [...sessionIds],
};
