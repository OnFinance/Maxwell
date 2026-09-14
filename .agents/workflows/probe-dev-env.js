// probe-dev-env — audits the developer environment of every application: developer configuration in each repo
// checkout (dotenv and key files, dev containers and compose, toolchain pinning, editor tasks and git hooks, AI
// harness and MCP configuration, local-run defaults) and every dev-tier environment record
// (applications/<app>/env/*.json with tier dev | test | devtest | sandbox) against company-profile/<c>/sdlc/policy.json
// and the regulator baseline. Static only: it reads workspace files and never touches a running system. Candidate
// findings are refuted (lenses evidence + correctness; the evidence lens is a veto at every severity, high and
// critical need unanimity), deduplicated by fingerprint across targets, appended through
// node .claude/scripts/soc/append.mjs, versioned with soc/version.mjs, and summary.md is refreshed.
// execute-scr runs the same checks inline as its DevEnv phase with the same fixed DEVENV_RULES table (kept word for
// word identical in both files), so rule ids and fingerprints match and re-runs of either collide.
// args: { companyId (required), appIds?: string[], envIds?: string[] (restricts dev-tier environment records),
//         dryRun?: boolean, now?: RFC3339 UTC 'Z' string, sessionId?: string, runId?: string }
export const meta = {
  name: 'probe-dev-env',
  description: 'Static audit of developer configs in repo checkouts and dev-tier env records against the SDLC policy, refuted and ledgered. args: companyId, appIds, envIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Scout', detail: 'List repos, dev-tier environment records and the SDLC policy digest from the workspace files' },
    { title: 'Audit', detail: 'devenv-auditor reviews developer configuration per repo and per environment-only application' },
    { title: 'Refute', detail: 'refuter lenses evidence and correctness per finding; evidence refutation vetoes, high and critical need unanimity' },
    { title: 'Dedup', detail: 'Barrier: drop duplicate findings by fingerprint across targets before anything is written' },
    { title: 'Ledger', detail: 'soc-ledger-keeper appends controls, observations and findings via soc/append.mjs, one target at a time' },
    { title: 'Report', detail: 'soc/version.mjs records the ledger diff; report-writer refreshes control-summary and open-findings in summary.md' },
  ],
};

const a = args || {};
const companyId = a.companyId;
if (typeof companyId !== 'string' || !companyId) throw new Error('probe-dev-env: args.companyId is required');
const WORKFLOW = 'probe-dev-env';
const dryRun = a.dryRun === true;
const appIds = Array.isArray(a.appIds) && a.appIds.length ? a.appIds : null;
const envIds = Array.isArray(a.envIds) && a.envIds.length ? a.envIds : null;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
let runNow = typeof a.now === 'string' && TIMESTAMP_RE.test(a.now) ? a.now : '';
const sessionId = typeof a.sessionId === 'string' ? a.sessionId : '';
const runId = typeof a.runId === 'string' ? a.runId : '';
const profile = `company-profile/${companyId}`;
const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
const CONFIDENCE = ['confirmed', 'likely', 'possible', 'unverified'];
// Lens names are the refuter agent's closed set; correctness carries the policy-reading check here.
const LENSES = ['evidence', 'correctness'];
const VETO_LENS = 'evidence';
const DEV_TIERS = ['dev', 'test', 'devtest', 'sandbox'];

// Fixed developer-environment rule ids (id, area, meaning). Keep word for word identical to DEVENV_RULES in
// execute-scr.js: the ruleId is the first fingerprint input, so a model-chosen id would split one gap into two findings.
const DEVENV_RULES = [
  ['devenv-committed-dotenv', 'secrets-hygiene', 'tracked .env, .env.local, .env.development or .env.staging with non-placeholder values, or a populated .env.example'],
  ['devenv-committed-key-material', 'secrets-hygiene', 'tracked private keys, keystores, kubeconfigs, cloud service-account JSON, .npmrc/.pypirc auth tokens or .docker/config.json auths'],
  ['devenv-secret-in-history', 'secrets-hygiene', 'secret removed from HEAD but still present in git history'],
  ['devenv-gitignore-gaps', 'secrets-hygiene', '.gitignore missing .env*, *.pem, *.key, kubeconfig or dump extensions'],
  ['devenv-no-local-secret-scan', 'secrets-hygiene', 'no pre-commit, husky or lefthook secrets hook while CI scanning is the only control'],
  ['devenv-secrets-backend-mismatch', 'secrets-hygiene', 'dev env secretsBackend env-files, ci-variables or plain compose values while the policy mandates a vault or cloud secret manager'],
  ['devenv-compose-privileged', 'dev-containers-and-compose', 'privileged, host network or pid, SYS_ADMIN/NET_ADMIN, docker socket or home, ~/.ssh or ~/.aws mounts in compose or devcontainer'],
  ['devenv-compose-exposed-ports', 'dev-containers-and-compose', 'databases, caches, brokers or admin UIs bound to 0.0.0.0 on shared dev hosts'],
  ['devenv-default-db-credentials', 'dev-containers-and-compose', 'default database passwords reused by a shared dev or test environment record'],
  ['devenv-unpinned-dev-image', 'dev-containers-and-compose', 'dev base images on latest or floating tags, unversioned devcontainer features, or unapproved registries'],
  ['devenv-dev-image-root', 'dev-containers-and-compose', 'Dockerfile.dev or devcontainer running as root with passwordless sudo'],
  ['devenv-missing-lockfile', 'toolchain-pinning', 'a package manifest without its lockfile while lockfilesRequired is true, or setup scripts that install without frozen/ci mode'],
  ['devenv-unapproved-registry', 'toolchain-pinning', 'registry configuration outside dependencyPolicy.allowedRegistries or --extra-index-url'],
  ['devenv-curl-pipe-shell', 'toolchain-pinning', 'curl or wget piped to a shell, or unsigned downloads without checksum, in Makefile, bootstrap, postCreateCommand or postinstall'],
  ['devenv-unpinned-runtime', 'toolchain-pinning', 'no runtime version pin (.nvmrc, .tool-versions, engines, .python-version, toolchain) where CI pins one'],
  ['devenv-editor-autorun-task', 'editor-and-hooks', 'editor tasks that run on folder open or pre-launch tasks running network scripts'],
  ['devenv-untrusted-extension', 'editor-and-hooks', 'recommended extensions outside the allow-list or workspace trust disabled'],
  ['devenv-hooks-disabled', 'editor-and-hooks', 'hooks bypassed: empty core.hooksPath, HUSKY=0, SKIP=gitleaks or --no-verify in scripts'],
  ['devenv-harness-not-allowed', 'ai-harness-config', 'configuration for an AI coding harness not in aiCodingPolicy.harnessesAllowed'],
  ['devenv-harness-auto-approve', 'ai-harness-config', 'harness permission modes that auto-approve edits, shell or web fetch while humanReviewRequired is true'],
  ['devenv-mcp-server-unlisted', 'ai-harness-config', 'MCP servers not on the allow-list, unpinned npx @latest launches, plain http, or literal production tokens'],
  ['devenv-harness-secrets-in-config', 'ai-harness-config', 'literal API keys or database URLs in harness config, MCP env blocks or instruction files'],
  ['devenv-harness-data-class', 'ai-harness-config', 'harness context or MCP tools reaching data classes outside aiCodingPolicy.allowedDataClasses'],
  ['devenv-prompt-bypass-instruction', 'ai-harness-config', 'instruction files telling the assistant to skip tests, disable hooks, push to main or ignore review'],
  ['devenv-real-data-dump', 'dev-data-and-exposure', 'tracked dumps, exports or fixtures holding real personal or payment data (counts only, never values)'],
  ['devenv-prod-data-in-dev-env', 'dev-data-and-exposure', 'dev-tier environment record with pii, spdi, cardholder, financial or regulatory data and no masking evidence'],
  ['devenv-dev-env-exposure', 'dev-data-and-exposure', 'dev or test tier exposed internet or partner, or sharing hosting account, cluster or namespace with prod'],
  ['devenv-dev-env-residency', 'dev-data-and-exposure', 'dev env residency or hosting region outside India while holding personal or payment data'],
  ['devenv-dev-env-log-retention', 'dev-data-and-exposure', 'shared dev or test env feeding UAT with logsRetentionDays below 180 or logs outside India'],
  ['devenv-insecure-defaults-leak', 'local-run-defaults', 'debug flags, TLS verification off, CORS wildcard or auth bypass flags in shared config that also loads in test, uat or staging'],
  ['devenv-seeded-admin-user', 'local-run-defaults', 'seed scripts creating admin or maker-checker users with fixed passwords that run above local'],
];
const devenvRulesNote = `Rule ids are FIXED; use exactly one id from this table for every finding (never invent, rename or suffix one; when no id fits, return an observation instead of a finding and say which check is missing in its description): ${DEVENV_RULES.map(([id, area, meaning]) => `${id} [${area}] ${meaning}`).join('; ')}.`;

// ---------- shared prompt fragments ----------
const nowCommand = 'node -e "console.log((new Date).toISOString().slice(0,19)+\'Z\')"';
const timeNote = () => (runNow
  ? `Use "${runNow}" for every timestamp you write (recordedAt, generatedAt, collectedAt, firstSeenAt, lastSeenAt, expiresAt base).`
  : `No run timestamp was supplied. Never run date. If your tools allow \`node -e\`, run \`${nowCommand}\` once and reuse that value for every timestamp you write, and return it as "now"; otherwise omit optional timestamps such as evidence collectedAt.`);
const provenanceNote = (agentName) => `Provenance on every record: harness "claude-code" (or "opencode" when MAXWELL_HARNESS=opencode), workflow "${WORKFLOW}", agent "${agentName}", sessionId ${sessionId ? `"${sessionId}"` : 'the session id your harness reports (never invent one)'}, runId ${runId ? `"${runId}"` : 'the MAXWELL_RUN_ID environment variable when set, otherwise omit runId'}. ${timeNote()}`;
const dryNote = dryRun
  ? 'DRY RUN: do not run any scanner and do not write any file. Plan what you would examine, list the evidence you would need, and describe each intended check. Every observation you return must have result "inconclusive" and a description starting with "dry-run: evidence requested — ". Return findings as an empty array and omit sarifPath.'
  : '';
const readOnlyNote = 'Read-only and static: only read workspace files; never modify a repository, never run a build, install, container, compose file, dev server, fetch, push or network call, never decrypt applications/*/credentials.json, and never print secret values (report a committed secret by file name, line and secret type only; never the value, a prefix of it or a hash of it). Scanners run only offline with local rules (gitleaks detect --no-git --redact; trufflehog filesystem --no-verification); a tool that needs the network goes to skipped. Return data, not prose.';
const evidenceNote = 'Evidence items carry type, ref, optional sha256, optional collectedAt and an optional description of at most 200 characters (for example "lines 12-19 at <sha>" or "18412 matches; values not printed"); no other keys. Quote the command or file you relied on in ref or description so a refuter can re-check it.';
const tagRule = 'tags ["dev-env", "dev-env:<area>"] where <area> is lower-cased with every character outside a-z, 0-9, colon, underscore and hyphen replaced by "-" (tags must match ^[a-z0-9][a-z0-9:_-]{0,47}$)';
const ledgerReuseNote = (key) => `Before choosing a ruleId, grep ${profile}/soc/main.jsonl for findings whose target is ${key} (and environment:<appId>/<envId> for environment gaps): when one has the same location path and its source.ruleId is in the table, reuse that exact ruleId and path so the ledger supersedes instead of duplicating.`;
const appFilterNote = appIds ? `Only consider applications whose appId is one of: ${appIds.join(', ')}.` : 'Consider every application under applications/.';
const envFilterNote = envIds ? `Only list dev-tier environments whose envId is one of: ${envIds.join(', ')}.` : 'List every dev-tier environment.';
const sarifNameFor = (t) => (t.type === 'repo' ? `${WORKFLOW}.${t.appId}.${t.repoId}.sarif.export.json` : `${WORKFLOW}.${t.appId}.environments.sarif.export.json`);
const sarifPathHint = (t) => `kpis/data/raw/sessions/${sessionId || '<your harness session id>'}/${sarifNameFor(t)}`;

// ---------- schemas ----------
const SKIPPED_SCHEMA = { type: 'array', items: { type: 'object', required: ['target', 'reason'], properties: { target: { type: 'string' }, reason: { type: 'string' } } } };
const REG_REF_SCHEMA = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const EVIDENCE_SCHEMA = { type: 'object', required: ['type', 'ref'], properties: { type: { enum: ['workspace-file', 'url', 'command-output', 'screenshot', 'log-excerpt', 'ticket', 'pull-request', 'commit', 'sbom', 'sarif', 'ocsf'] }, ref: { type: 'string' }, sha256: { type: 'string' }, collectedAt: { type: 'string' }, description: { type: 'string', maxLength: 200 } } };
// Mirrors common.schema.json assetRef: the ids each type needs are required, so a bare {type:"repo"} fails the schema retry.
const TARGET_SCHEMA = {
  type: 'object',
  required: ['type'],
  properties: { type: { enum: ['application', 'environment', 'repo'] }, appId: { type: 'string' }, envId: { type: 'string' }, repoId: { type: 'string' } },
  allOf: [
    { if: { required: ['type'], properties: { type: { enum: ['application', 'environment', 'repo'] } } }, then: { required: ['appId'] } },
    { if: { required: ['type'], properties: { type: { const: 'environment' } } }, then: { required: ['envId'] } },
    { if: { required: ['type'], properties: { type: { const: 'repo' } } }, then: { required: ['repoId'] } },
  ],
};
const DEV_ENV_ITEM = { type: 'object', required: ['appId', 'envId', 'tier', 'recordPath'], properties: { appId: { type: 'string' }, envId: { type: 'string' }, tier: { type: 'string' }, exposure: { type: 'string' }, secretsBackend: { type: 'string' }, dataClassification: { type: 'array', items: { type: 'string' } }, residency: { type: 'array', items: { type: 'string' } }, logsRetentionDays: { type: 'integer' }, probeAccessMethod: { type: 'string' }, recordPath: { type: 'string' } } };
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['companyId', 'policyFound', 'policySummary', 'repos', 'devEnvironments', 'skipped'],
  properties: {
    companyId: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    primaryInstruments: { type: 'array', items: { type: 'string' } },
    policyFound: { type: 'boolean' },
    policySummary: { type: 'string' },
    applicationIds: { type: 'array', items: { type: 'string' } },
    devEnvironments: { type: 'array', items: DEV_ENV_ITEM },
    repos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'repoId', 'recordPath'],
        properties: {
          appId: { type: 'string' }, repoId: { type: 'string' }, recordPath: { type: 'string' }, localCheckout: { type: 'string' },
          languages: { type: 'array', items: { type: 'string' } }, buildSystem: { type: 'string' }, packageManifests: { type: 'array', items: { type: 'string' } },
          containsAgentCode: { type: 'boolean' }, prodExposure: { type: 'string' }, prodDataClassification: { type: 'array', items: { type: 'string' } },
          devConfigFiles: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    skipped: SKIPPED_SCHEMA,
    sessionId: { type: 'string' },
  },
};
const OBSERVATION_ITEM = { type: 'object', required: ['title', 'description', 'area', 'result', 'regulatoryRefs', 'evidence'], properties: { title: { type: 'string' }, description: { type: 'string' }, area: { type: 'string' }, result: { enum: ['satisfied', 'not-satisfied', 'partial', 'not-applicable', 'inconclusive'] }, subject: TARGET_SCHEMA, regulatoryRefs: { type: 'array', minItems: 1, items: REG_REF_SCHEMA }, evidence: { type: 'array', items: EVIDENCE_SCHEMA } } };
const FINDING_ITEM = { type: 'object', required: ['title', 'description', 'severity', 'confidence', 'area', 'ruleId', 'target', 'regulatoryRefs', 'evidence'], properties: { title: { type: 'string' }, description: { type: 'string' }, severity: { enum: SEVERITY_ORDER }, confidence: { enum: CONFIDENCE }, area: { type: 'string' }, ruleId: { enum: DEVENV_RULES.map((r) => r[0]) }, cweId: { type: 'string' }, target: TARGET_SCHEMA, location: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } } }, impact: { type: 'string' }, remediation: { type: 'string' }, regulatoryRefs: { type: 'array', minItems: 1, items: REG_REF_SCHEMA }, evidence: { type: 'array', items: EVIDENCE_SCHEMA } } };
const AUDIT_SCHEMA = { type: 'object', required: ['observations', 'findings', 'skipped'], properties: { observations: { type: 'array', items: OBSERVATION_ITEM }, findings: { type: 'array', items: FINDING_ITEM }, sarifPath: { type: 'string' }, sarifSha256: { type: 'string' }, skipped: SKIPPED_SCHEMA, sessionId: { type: 'string' } } };
const REFUTE_SCHEMA = { type: 'object', required: ['refuted', 'reason'], properties: { refuted: { type: 'boolean' }, confidence: { type: 'number' }, lens: { type: 'string' }, reason: { type: 'string' }, corrections: { type: 'array', items: { type: 'object', required: ['path', 'why'], properties: { path: { type: 'string' }, current: {}, proposed: {}, why: { type: 'string' } } } }, checked: { type: 'array', items: { type: 'string' } }, unverifiable: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' } } };
const LEDGER_SCHEMA = { type: 'object', required: ['controlsAppended', 'observationsAppended', 'findingsAppended', 'observationIds', 'findingIds', 'supersededFindingIds', 'skipped'], properties: { controlsAppended: { type: 'integer' }, observationsAppended: { type: 'integer' }, findingsAppended: { type: 'integer' }, observationIds: { type: 'array', items: { type: 'string' } }, findingIds: { type: 'array', items: { type: 'string' } }, supersededFindingIds: { type: 'array', items: { type: 'string' } }, now: { type: 'string' }, skipped: SKIPPED_SCHEMA, sessionId: { type: 'string' } } };
const VERSION_SCHEMA = { type: 'object', required: ['written'], properties: { written: { type: 'string' }, error: { type: 'string' }, sessionId: { type: 'string' } } };
const REPORT_SCHEMA = { type: 'object', required: ['sectionsUpdated', 'sectionsSkipped', 'openFindings'], properties: { sectionsUpdated: { type: 'array', items: { type: 'string' } }, sectionsSkipped: { type: 'array', items: { type: 'string' } }, openFindings: { type: 'integer' }, observations: { type: 'integer' }, version: { type: 'string' }, sessionId: { type: 'string' } } };

// ---------- helpers ----------
// Same key as the ledger fingerprint input (soc-ledger section 6) and as execute-scr's inline DevEnv step.
const normalisePath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
const targetKey = (t) => {
  if (!t || t.type === 'company') return `company:${companyId}`;
  if (t.type === 'application') return `application:${t.appId}`;
  if (t.type === 'environment') return `environment:${t.appId}/${t.envId}`;
  return `repo:${t.appId}/${t.repoId}`;
};
const findingKey = (t, f) => `${f.ruleId}|${targetKey(f.target || t)}|${normalisePath(f.location && f.location.path)}`;
const lowerSeverity = (x, y) => (SEVERITY_ORDER.indexOf(x) <= SEVERITY_ORDER.indexOf(y) ? x : y);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const noteNow = (r) => { if (!runNow && r && typeof r.now === 'string' && TIMESTAMP_RE.test(r.now)) runNow = r.now; };
const correctionFor = (v, pointer) => { const c = (v && Array.isArray(v.corrections) ? v.corrections : []).find((x) => x && x.path === pointer); return c ? c.proposed : undefined; };
const label = (t) => (t.type === 'repo' ? `${t.appId}/${t.repoId}` : `${t.appId} (environment records only)`);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fill the ids a candidate target omitted from the audit target; return null when the ids cannot be recovered so
// the caller falls back to the default subject (a bare {type:"repo"} is not a valid assetRef and breaks the dedup key).
const repairTarget = (ft, t, knownEnvs) => {
  if (!ft || !ft.type) return null;
  const appId = ft.appId || t.appId;
  if (ft.type === 'repo') {
    const repoId = ft.repoId || (t.type === 'repo' && appId === t.appId ? t.repoId : '');
    return appId && repoId ? { type: 'repo', appId, repoId } : null;
  }
  if (ft.type === 'environment') {
    if (!ft.envId || !appId) return null;
    if (appId === t.appId && knownEnvs.length && !knownEnvs.some((e) => e.envId === ft.envId)) return null;
    return { type: 'environment', appId, envId: ft.envId };
  }
  if (ft.type === 'application') return appId ? { type: 'application', appId } : null;
  return null;
};

// Accept a SARIF export only at the sanctioned per-session path for this target; otherwise ignore it (findings then
// fall back to source.kind agent-analysis).
const acceptSarif = (res, t) => {
  if (!res.sarifPath) { delete res.sarifSha256; return; }
  const sid = sessionId || res.sessionId || '';
  const segment = sid ? escapeRe(sid) : '(?!run_|unattributed)[A-Za-z0-9._-]+';
  const ok = new RegExp(`^kpis/data/raw/sessions/${segment}/${escapeRe(sarifNameFor(t))}$`).test(res.sarifPath) && /^[A-Za-z0-9._\/-]+$/.test(res.sarifPath);
  const shaOk = !res.sarifSha256 || /^[a-f0-9]{64}$/.test(res.sarifSha256);
  if (ok && shaOk) return;
  skipped.push({ target: `${targetKey(t)}: ${res.sarifPath}`, reason: `SARIF export ignored: expected kpis/data/raw/sessions/<sessionId>/${sarifNameFor(t)} with a 64-hex sha256` });
  delete res.sarifPath; delete res.sarifSha256;
};

// Refutation verdict. The evidence lens vetoes at every severity; high and critical need every lens to answer and
// none to refute; otherwise a majority of the lenses that answered decides. Lenses that returned nothing are counted
// separately: when none answered (or a required one is missing) the candidate goes to skipped, not to rejected.
const decide = (f, lenses, votes) => {
  const unavailable = lenses.filter((l, i) => !votes[i]);
  const refutedLenses = lenses.filter((l, i) => votes[i] && votes[i].refuted === true);
  const answered = lenses.length - unavailable.length;
  const unanimityRequired = f.severity === 'critical' || f.severity === 'high';
  const base = { refutedCount: refutedLenses.length, unavailable: unavailable.length, unanimityRequired };
  if (!answered) return { ...base, outcome: 'unavailable', reason: 'refuter unavailable: no lens returned a schema-valid verdict' };
  if (refutedLenses.includes(VETO_LENS)) return { ...base, outcome: 'rejected', reason: 'evidence lens refuted (veto at every severity)' };
  if (unanimityRequired) {
    if (refutedLenses.length) return { ...base, outcome: 'rejected', reason: `${f.severity} needs unanimity; refuted by ${refutedLenses.join(', ')}` };
    if (unavailable.length) return { ...base, outcome: 'unavailable', reason: `refuter partly unavailable (${unavailable.join(', ')}); ${f.severity} needs every lens` };
    return { ...base, outcome: 'kept', split: false };
  }
  if (lenses.includes(VETO_LENS) && unavailable.includes(VETO_LENS)) return { ...base, outcome: 'unavailable', reason: 'evidence lens unavailable; it holds a veto' };
  if (refutedLenses.length * 2 > answered || refutedLenses.length === answered) return { ...base, outcome: 'rejected', reason: `refuted by ${refutedLenses.join(', ')} of ${answered} answering lenses` };
  return { ...base, outcome: 'kept', split: refutedLenses.length > 0 };
};

// ========== Scout ==========
phase('Scout');
const scout = await agent(`Scout company "${companyId}" for a developer-environment probe. ${appFilterNote} ${envFilterNote}
Read .claude/skills/maxwell-conventions/SKILL.md first. Then read ${profile}/details.json (entityTypes, regulators, frameworksInScope), ${profile}/sdlc/policy.json (if absent set policyFound=false and say so in policySummary), every applications/*/repos/*.json record, every applications/*/env/*.json record and applications/*/README.md.
applicationIds: every application folder in scope.
devEnvironments: every environment whose tier is one of ${DEV_TIERS.join(', ')}, with appId, envId, tier, exposure, secretsBackend, dataClassification, residency, observability.logsRetentionDays as logsRetentionDays, probeAccess.method as probeAccessMethod and recordPath.
repos: for each repo record appId, repoId, recordPath, localCheckout (from the record; omit when the directory does not exist on disk), languages, buildSystem, packageManifests, containsAgentCode, prodExposure = the exposure of that application's non-dev environments (highest of internet > partner > internal > isolated; omit when none), prodDataClassification = the union of their dataClassification, devConfigFiles = the developer configuration files that exist at the top level of the checkout or one level down (for example .env.example, .devcontainer/devcontainer.json, docker-compose.yml, .nvmrc, .tool-versions, .vscode/settings.json, .pre-commit-config.yaml, .husky, .claude/settings.json, .mcp.json, .cursor/rules, opencode.json, AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, Makefile), relative to the repo root.
policySummary: a compact plain-text digest of secretsManagement, dependencyPolicy (lockfilesRequired, allowedRegistries), aiCodingPolicy (harnessesAllowed, humanReviewRequired, promptInjectionControls, allowedDataClasses), releaseProcess.environmentsOrder and the ciGates of type secrets.
primaryInstruments: the vocab instrument ids that apply to the entityTypes (sebi-cscrf-2024 for SEBI-regulated entities, rbi-cyber-tech-directions-2026 for RBI-regulated ones, irdai-info-cyber-security-2023 for insurers, cert-in-directions-2022 and dpdp-rules-2025 for all, then nist-ssdf-800-218 and cis-controls-8.1).
List in skipped every application with neither a repo record nor a dev-tier environment, every repo without a local checkout, and every application or environment excluded by the filters, each with a reason. Read-only; return data only.`, { label: 'scout', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'ctx-researcher', effort: 'medium' });
if (!scout) throw new Error('probe-dev-env: scout returned nothing');
noteSession(scout);
skipped.push(...(scout.skipped || []));
if (!scout.policyFound) log(`${profile}/sdlc/policy.json is missing or unreadable; the audit compares against the regulator baseline only`);

const devEnvs = (scout.devEnvironments || []).filter((e) => (!appIds || appIds.includes(e.appId)) && (!envIds || envIds.includes(e.envId)));
const devEnvsFor = (appId) => devEnvs.filter((e) => e.appId === appId);
const repos = (scout.repos || []).filter((r) => !appIds || appIds.includes(r.appId));
const repoTargets = repos.filter((r) => r.localCheckout || devEnvsFor(r.appId).length).map((r) => ({ ...r, type: 'repo' }));
for (const r of repos.filter((r) => !r.localCheckout && !devEnvsFor(r.appId).length)) skipped.push({ target: `repo:${r.appId}/${r.repoId}`, reason: 'no local checkout and no dev-tier environment record; nothing to audit' });
// Environment records are audited once per application: by its first repo target (or an environment-only target).
const envOwner = new Map();
for (const r of repoTargets) if (!envOwner.has(r.appId)) envOwner.set(r.appId, `${r.appId}/${r.repoId}`);
const ownsEnvs = (t) => t.type !== 'repo' || envOwner.get(t.appId) === `${t.appId}/${t.repoId}`;
const envsAuditedBy = (t) => (ownsEnvs(t) ? devEnvsFor(t.appId) : []);
const envOnlyTargets = [...new Set(devEnvs.map((e) => e.appId))].filter((appId) => !envOwner.has(appId)).map((appId) => ({ type: 'application', appId }));
const targets = [...repoTargets, ...envOnlyTargets];
log(`Scout: ${repos.length} repos (${repoTargets.filter((r) => r.localCheckout).length} with checkout), ${devEnvs.length} dev-tier environments, ${targets.length} audit targets (${envOnlyTargets.length} environment-only); policyFound=${scout.policyFound}`);
if (!targets.length) log('no repo checkout or dev-tier environment in scope; nothing to audit');

// ========== Audit + Refute (per target, no barrier between stages) ==========
const entityNote = `(entity types: ${(scout.entityTypes || []).join(', ') || 'unknown'}; primary instruments: ${(scout.primaryInstruments || []).join(', ') || 'unknown'})`;
const envScopeNote = (t) => {
  if (ownsEnvs(t)) return `Dev-tier environment records for this application (you audit them for the whole application): ${JSON.stringify(devEnvsFor(t.appId))}`;
  return `Dev-tier environment records for application "${t.appId}" are audited by the ${envOwner.get(t.appId)} target in this run: do not return environment observations or findings with an environment target, and return dev-data-and-exposure only for dumps and fixtures in this checkout.`;
};
const auditPrompt = (t) => `You are the devenv-auditor for company "${companyId}" ${entityNote}. ${t.type === 'repo'
  ? `Target repo "${t.repoId}" of application "${t.appId}": record ${t.recordPath}, checkout ${t.localCheckout || 'none — limit yourself to the environment records and the application README'}, languages ${(t.languages || []).join(', ') || 'unknown'}, build system ${t.buildSystem || 'unknown'}, containsAgentCode ${t.containsAgentCode === true}, production exposure ${t.prodExposure || 'unknown'}, production data classes ${(t.prodDataClassification || []).join(', ') || 'none recorded'}, developer config files seen by the scout: ${(t.devConfigFiles || []).join(', ') || 'none listed (look anyway)'}.`
  : `Target application "${t.appId}" has dev-tier environment records but no repo checkout in scope: audit the environment records and applications/${t.appId}/README.md only, and return not-applicable observations for the checkout-only areas.`}
${envScopeNote(t)}
Read .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/soc-ledger/SKILL.md (record shapes only — you do not write to the ledger), .claude/skills/sarif-findings/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md with its references (instruments.json, catalogs/*.catalog.json, sla-table.json) so every regulatoryRef cites a real control id and every severity comes from the catalog defaultSeverity, and .claude/skills/credentials-sops/SKILL.md (what a credential reference looks like versus a value). Policy digest from ${profile}/sdlc/policy.json (policyFound=${scout.policyFound}): ${scout.policySummary}
${readOnlyNote} ${evidenceNote} ${dryNote}
${dryRun ? '' : `SARIF: write your hand-authored SARIF 2.1.0 log (driver maxwell-devenv-auditor plus one run per offline scanner) to ${sarifPathHint(t)}${sessionId ? '' : ' (the <sid> segment is your own harness session id; return it as sessionId)'}, never overwrite an existing export, and return sarifPath and its sha256 as sarifSha256. If you write no log, omit both.`}
Audit the developer environment, area by area, and return one observation per area (result satisfied | partial | not-satisfied | not-applicable | inconclusive; subject = the repo {type "repo", appId, repoId}, or {type "environment", appId, envId} for dev-data-and-exposure gaps in an environment record; evidence = the files you read, as workspace-file refs relative to the workspace root):
- secrets-hygiene: committed .env*, *.pem, *.key, id_rsa, kubeconfig, service-account JSON, .npmrc/.pypirc tokens, docker-compose environment blocks with real values, .env.example that is actually populated; .gitignore covering them; pre-commit or husky secrets scanning versus secretsManagement.scanningInCi; secretsBackend of each dev env versus policy secretsManagement.backend (env-files or ci-variables in dev is a finding when the policy mandates a vault or cloud secret manager);
- dev-containers-and-compose: .devcontainer/devcontainer.json, docker-compose*.yml, Dockerfile.dev, Tiltfile, skaffold.yaml — images pinned by digest or tag, running as root, privileged or host network mode, docker socket mounts, ports bound to 0.0.0.0, databases with default passwords, volumes that mount the whole home directory;
- toolchain-pinning: .nvmrc, .tool-versions, .python-version, engines in package.json, lockfiles present and installed with frozen or ci mode in the dev scripts, registry configuration versus dependencyPolicy.allowedRegistries, postinstall scripts and curl-pipe-sh in Makefile or setup scripts;
- editor-and-hooks: .vscode/settings.json, tasks.json and extensions.json, .idea/, .editorconfig, .pre-commit-config.yaml, .husky/, lefthook.yml — tasks that run arbitrary shell on folder open, recommended extensions from untrusted publishers, hooks bypassed with --no-verify in scripts;
- ai-harness-config: .claude/settings.json and .claude/settings.local.json, .mcp.json, .cursor/rules and .cursorrules, opencode.json, AGENTS.md, CLAUDE.md, .github/copilot-instructions.md — harnesses outside aiCodingPolicy.harnessesAllowed, permission modes that auto-approve writes or shell, MCP servers not on an allowlist or reached over plain http, missing session logging, prompt files that tell the agent to bypass review, data classes exposed to the harness beyond allowedDataClasses;
- dev-data-and-exposure: dev-tier environments whose dataClassification includes pii, spdi, cardholder, financial or regulatory (production data in dev: a dpdp-rules-2025 Rule 6 reasonable security safeguards gap and a SEBI CSCRF data-security concern; cite dpdp-act-2023 only when purpose limitation itself is at issue), exposure internet or partner for a dev tier, residency outside IN, logsRetentionDays below the CERT-In 2022 180-day baseline, probeAccess that is not read-only;
- local-run-defaults: DEBUG=true or equivalent debug flags, TLS verification disabled, CORS wildcard, default admin credentials or seeded test users in fixtures that also load in higher tiers.
${devenvRulesNote}
${ledgerReuseNote(t.type === 'repo' ? `repo:${t.appId}/${t.repoId}` : `application:${t.appId}`)}
One finding per concrete gap: ruleId from the table, area as in the table, target {type "repo", appId "${t.appId}", repoId "${t.type === 'repo' ? t.repoId : '<repoId>'}"} for gaps in the checkout or {type "environment", appId, envId} for gaps in an environment record (always include every id), location {path relative to the repo root for checkout files, or the environment record path relative to the workspace root such as applications/<app>/env/<env>.json, with line numbers when known}, severity from the catalog defaultSeverity of the most specific regulatory control cited (never intuition), confidence, cweId when one fits (for example CWE-798 for hard-coded credentials, CWE-250 for unnecessary privileges), regulatoryRefs (at least one) with the most specific Indian instrument first (sebi-cscrf-2024, rbi-cyber-tech-directions-2026, irdai-info-cyber-security-2023, cert-in-directions-2022, dpdp-rules-2025) and a global mapping second (nist-ssdf-800-218 PO.5/PS.1/PW.4, cis-controls-8.1, owasp-agentic-top10-2026 or csa-mcp-security-2025 for harness and MCP gaps), impact, remediation and evidence. Do not report the same gap under two areas. List what you could not inspect in skipped.`;

const auditStage = async (t) => {
  const res = await agent(auditPrompt(t), { label: `audit ${label(t)}`, phase: 'Audit', schema: AUDIT_SCHEMA, agentType: 'devenv-auditor', effort: 'high' });
  if (!res) { skipped.push({ target: targetKey(t), reason: 'devenv-auditor returned no schema-valid result' }); return null; }
  noteSession(res);
  skipped.push(...(res.skipped || []).map((s) => ({ target: `${targetKey(t)}: ${s.target}`, reason: s.reason })));
  const firstEnv = devEnvsFor(t.appId)[0];
  res.target = t.type === 'repo' ? { type: 'repo', appId: t.appId, repoId: t.repoId } : (firstEnv ? { type: 'environment', appId: t.appId, envId: firstEnv.envId } : { type: 'application', appId: t.appId });
  const envs = devEnvsFor(t.appId);
  res.findings = res.findings.map((f) => {
    const target = repairTarget(f.target, t, envs);
    if (!target) log(`${targetKey(t)}: finding "${f.ruleId}" target ${JSON.stringify(f.target || null)} lacked recoverable ids; using ${targetKey(res.target)}`);
    return { ...f, target: target || res.target };
  });
  res.observations = res.observations.map((o) => { const subject = repairTarget(o.subject, t, envs); const { subject: _drop, ...rest } = o; return subject ? { ...rest, subject } : rest; });
  if (!ownsEnvs(t)) {
    const before = res.findings.length;
    res.findings = res.findings.filter((f) => f.target.type !== 'environment');
    res.observations = res.observations.filter((o) => !o.subject || o.subject.type !== 'environment');
    if (before !== res.findings.length) log(`${targetKey(t)}: dropped ${before - res.findings.length} environment findings (audited by ${envOwner.get(t.appId)})`);
  }
  acceptSarif(res, t);
  if (dryRun) {
    if (res.findings.length) log(`dry-run: dropped ${res.findings.length} candidate findings for ${targetKey(t)} (only inconclusive observations are written)`);
    res.findings = [];
    delete res.sarifPath; delete res.sarifSha256;
    res.observations = res.observations.map((o) => ({ ...o, result: 'inconclusive', description: o.description.startsWith('dry-run:') ? o.description : `dry-run: evidence requested — ${o.description}` }));
  }
  return res;
};

const refutePrompt = (t, f, lens) => `Refute one candidate. lens: "${lens}". context: {"companyId":"${companyId}","workflow":"${WORKFLOW}"${sessionId ? `,"sessionId":"${sessionId}"` : ''}${runId ? `,"runId":"${runId}"` : ''},"target":"${targetKey(f.target || t)}"}. Candidate kind: developer-environment gap.
candidate: ${JSON.stringify(f)}
This is a pre-ledger candidate: id, fingerprint, provenance, controlIds, slaBasis, slaDueAt, firstSeenAt and lastSeenAt are added by the soc-ledger-keeper after you, so their absence never refutes; area, ruleId, cweId, impact and remediation are data to verify. Location paths are relative to the repo root${t.localCheckout ? ` (checkout at ${t.localCheckout})` : ''} unless they start with applications/ or company-profile/. Evidence descriptions (line ranges, match counts, command lines) are part of the claim.
Dev-tier environment records: ${JSON.stringify(devEnvsFor(t.appId))}. Policy under test: ${profile}/sdlc/policy.json. Lens guidance for this workflow — evidence: the cited file and line really contain what the candidate says (a .env.example with placeholder values is not a committed secret; a compose file used only by CI test jobs is still developer configuration) and nothing in the repo already compensates (.gitignore, pre-commit hook, devcontainer override). correctness: the facts in title and description match the files, the ruleId's meaning fits the gap, and the policy or regulator baseline really requires what the candidate says (a stricter-than-policy expectation is not a gap unless the regulator baseline demands it); severity equals the catalog defaultSeverity of the cited control.
Return your standard output contract. Use corrections with path "/severity" or "/confidence" when the value should change.`;

const refuteStage = async (res, t) => {
  if (!res || !res.findings.length) return res;
  const kept = []; const rejected = []; let unavailable = 0;
  await pipeline(res.findings, async (f, item, fi) => {
    const tag = `refute ${targetKey(f.target || t)} #${fi + 1}`;
    const votes = await parallel(LENSES.map((lens) => () => agent(refutePrompt(t, f, lens), { label: `refute ${lens} ${targetKey(f.target || t)} #${fi + 1}`, phase: 'Refute', schema: REFUTE_SCHEMA, agentType: 'refuter', effort: 'high' })));
    votes.forEach(noteSession);
    const d = decide(f, LENSES, votes);
    if (d.unavailable) log(`${tag}: ${d.unavailable} lens(es) returned nothing (counted as unavailable, not as refuted)`);
    if (d.outcome === 'unavailable') { unavailable += 1; skipped.push({ target: `${targetKey(f.target || t)} ${f.ruleId}`, reason: `${d.reason}; candidate "${f.title}" not ledgered, re-run to verify` }); return null; }
    if (d.outcome === 'rejected') { rejected.push({ title: f.title, ruleId: f.ruleId, refutedCount: d.refutedCount, reason: d.reason, reasons: votes.filter(Boolean).map((v, i) => `${v.lens || LENSES[i]}: ${v.reason}`) }); return null; }
    let severity = f.severity; let confidence = f.confidence;
    for (const v of votes) {
      if (!v || v.refuted) continue;
      const sev = correctionFor(v, '/severity'); if (SEVERITY_ORDER.includes(sev)) severity = lowerSeverity(severity, sev);
      const conf = correctionFor(v, '/confidence'); if (CONFIDENCE.includes(conf)) confidence = conf;
    }
    if (severity !== f.severity) log(`${tag}: severity lowered ${f.severity} -> ${severity}`);
    if (d.split) { confidence = 'possible'; log(`${tag}: split vote (${d.refutedCount}/${LENSES.length} refuted); kept with confidence "possible"`); }
    kept.push({ ...f, severity, confidence, refutation: { lenses: LENSES, refutedCount: d.refutedCount, unavailable: d.unavailable, unanimityRequired: d.unanimityRequired } });
    return null;
  });
  if (rejected.length) log(`${targetKey(t)}: ${rejected.length} of ${res.findings.length} candidate findings refuted`);
  const lost = res.findings.length - kept.length - rejected.length - unavailable;
  if (lost > 0) skipped.push({ target: targetKey(t), reason: `${lost} candidate(s) lost to refute-stage errors; not ledgered` });
  return { ...res, findings: kept, refuted: rejected };
};

phase('Audit');
const audited = (await pipeline(targets, auditStage, refuteStage)).filter(Boolean);

// ========== Dedup (barrier: the awaited pipeline above) ==========
phase('Dedup');
const seen = new Set(); let duplicates = 0;
for (const r of audited) {
  r.findings = r.findings.filter((f) => { const k = findingKey(r.target, f); if (seen.has(k)) { duplicates += 1; return false; } seen.add(k); return true; });
}
if (duplicates) log(`dedup: dropped ${duplicates} duplicate findings across targets`);
const refutedTotal = audited.reduce((n, r) => n + ((r.refuted && r.refuted.length) || 0), 0);
log(`Audit complete: ${audited.reduce((n, r) => n + r.observations.length, 0)} observations, ${audited.reduce((n, r) => n + r.findings.length, 0)} findings after refutation (${refutedTotal} refuted, ${duplicates} duplicates dropped)`);

// ========== Ledger (sequential so recordedAt stays monotonic within main.jsonl) ==========
phase('Ledger');
const observationIds = []; const findingIds = []; const supersededFindingIds = []; let controlsAppended = 0;
for (const r of audited) {
  if (!r.observations.length && !r.findings.length) { log(`${targetKey(r.target)}: nothing to ledger`); continue; }
  const sarifEvidence = r.sarifPath ? `{"type":"sarif","ref":"${r.sarifPath}"${r.sarifSha256 ? `,"sha256":"${r.sarifSha256}"` : ''}}` : '';
  const sourceRule = r.sarifPath
    ? `{"kind":"sarif","ruleId":"<ruleId>","tool":"maxwell-devenv-auditor","toolVersion":"1.0.0"} (every result is in the SARIF export ${r.sarifPath}; when the candidate carries tool and toolVersion from an offline scanner run in that export, use those instead)`
    : '{"kind":"agent-analysis","ruleId":"<ruleId>","tool":"devenv-auditor"} (no SARIF log exists for this target)';
  const w = await agent(`You are the soc-ledger-keeper for company "${companyId}". Read .claude/skills/soc-ledger/SKILL.md, .claude/skills/maxwell-conventions/SKILL.md and .claude/skills/regulatory-catalogs/SKILL.md (with references/sla-table.json and references/catalogs/*.catalog.json) before writing. Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (record JSON on stdin); never edit ${profile}/soc/main.jsonl directly. ${provenanceNote('soc-ledger-keeper')}
Default subject: ${JSON.stringify(r.target)}. Candidate records from the devenv-auditor (already refuted): ${JSON.stringify({ observations: r.observations, findings: r.findings, sarifPath: r.sarifPath || null, sarifSha256: r.sarifSha256 || null })}
Rules:
1. Controls first. Every observation and finding must carry controlIds with at least one "<instrument>:<controlId>" built from its regulatoryRefs. For each such id not yet present in ${profile}/soc/main.jsonl append a control record (kind "control", id "<instrument>:<controlId>", frameworkRefs [the ref itself, then the catalog mappings], title and category from the catalog entry, implementationStatus "unknown", effectiveness "not-tested", applicableAssets [the subject]) and count it in controlsAppended. Skip a regulatoryRef whose control id does not exist in the catalogs and say so in skipped.
2. Observations: kind "observation", id a fresh obs_ ULID (mint with the helper named in maxwell-conventions, never by hand), methods ["${WORKFLOW}"], subjects [candidate.subject or the default subject], title, description and result as given, collectedAt = now, expiresAt = now + 30 days, evidence as given${sarifEvidence ? ` plus ${sarifEvidence}, toolOutput {"format":"sarif","path":"${r.sarifPath}"${r.sarifSha256 ? `,"sha256":"${r.sarifSha256}"` : ''}}` : ''}, ${tagRule}.
3. Findings: kind "finding", target = candidate.target or the default subject, source ${sourceRule}, severity and confidence as given, regulatoryRefs as given (most specific Indian instrument first), controlIds built from them, location as given (never an absolute path), title one line naming the asset and the weakness (max 200 characters), description = candidate description plus impact and remediation, status "open", firstSeenAt/lastSeenAt = now, slaBasis and slaDueAt from references/sla-table.json following the soc-ledger skill section 6 (topic patch-sla for misconfigurations with a fix; company-override uses ${profile}/sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays when present), fingerprint = sha256 hex over "<ruleId>|<targetKey>|<normalisedLocation>" exactly as the soc-ledger skill section 6 defines (targetKey such as repo:<appId>/<repoId> or environment:<appId>/<envId>; location path without line numbers, empty when there is none), computed with the \`node -e\` one-liner shown in soc-ledger section 6 (printf and sha256sum are not in your tools), relatedObservationIds = the ids of the observations you just appended for the same area, evidence as given${sarifEvidence ? ` plus ${sarifEvidence}` : ''}, ${tagRule} plus "cwe:<cwe id lower-cased>" (for example "cwe:cwe-798") when the candidate carries cweId. ${evidenceNote} Drop candidate keys the record schema does not have (area, ruleId, cweId, impact, remediation, subject, refutation) after mapping them as described. Before appending, grep ${profile}/soc/main.jsonl for the fingerprint: when a finding with the same fingerprint exists and its latest record is open, triaged or remediating, append a superseding record with the SAME id, "supersedes" set to that id, the original firstSeenAt preserved and lastSeenAt = now, and list the id in supersededFindingIds; when it is resolved, reopen it (status "open", statusReason "regressed in run ${runId || WORKFLOW}", no resolvedAt) as the skill section 8 prescribes; when false-positive, duplicate or an unexpired risk-accepted, only refresh lastSeenAt; otherwise mint a fresh fnd_ ULID.
4. Append controls, then observations, then findings. After all appends run \`node .claude/scripts/validate-data.mjs ${profile}/soc/main.jsonl\` and fix any rejected record by appending a corrected record (never rewrite lines). A candidate you could not ledger goes into skipped with the validator message.
Return the counts, the ids you appended and the timestamp you used as now.`, { label: `ledger ${targetKey(r.target)}`, phase: 'Ledger', schema: LEDGER_SCHEMA, agentType: 'soc-ledger-keeper', effort: 'medium' });
  if (!w) { skipped.push({ target: `ledger ${targetKey(r.target)}`, reason: 'soc-ledger-keeper returned no schema-valid result; records not written' }); continue; }
  noteSession(w); noteNow(w);
  controlsAppended += w.controlsAppended; observationIds.push(...w.observationIds); findingIds.push(...w.findingIds); supersededFindingIds.push(...(w.supersededFindingIds || []));
  skipped.push(...(w.skipped || []).map((s) => ({ target: `ledger ${targetKey(r.target)}: ${s.target}`, reason: s.reason })));
}
log(`Ledger: ${controlsAppended} controls, ${observationIds.length} observations, ${findingIds.length} findings appended (${supersededFindingIds.length} re-seen)`);

// ========== Report (version diff, then summary) ==========
phase('Report');
let versionFile = null;
if (observationIds.length || findingIds.length || controlsAppended) {
  const v = await agent(`You are the soc-ledger-keeper for company "${companyId}", closing workflow "${WORKFLOW}". Run \`node .claude/scripts/soc/version.mjs ${companyId} --session ${sessionId || '<your harness session id>'} --workflow ${WORKFLOW}\` from the workspace root. Never pass --force and never edit the ledger. Return written = the path of the versions/commit_<n>.diff it wrote (empty string when nothing was written) and error = its stderr verbatim when it failed.`, { label: 'version', phase: 'Report', schema: VERSION_SCHEMA, agentType: 'soc-ledger-keeper', effort: 'low' });
  if (!v) skipped.push({ target: `${profile}/soc/versions`, reason: 'version.mjs step returned no schema-valid result; ledger diff not written' });
  else { noteSession(v); versionFile = v.written || null; if (v.error) skipped.push({ target: `${profile}/soc/versions`, reason: `version.mjs failed: ${v.error}` }); }
}
let report = null;
if (dryRun) {
  log('dry-run: summary.md left unchanged (only inconclusive observations were written)');
} else if (!observationIds.length && !findingIds.length) {
  log('nothing was written to the ledger; summary.md left unchanged');
} else {
  report = await agent(`You are the report-writer for company "${companyId}", called by workflow "${WORKFLOW}". Read .claude/skills/report-templates/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md first. Requested sections: ["control-summary", "open-findings"].
Regenerate those two sections of ${profile}/summary.md from ${profile}/soc/main.jsonl using the report-templates layouts ("## Control summary": control implementation and latest observation result per control with the coverage paragraph; "## Open findings": latest record per finding id, status open | triaged | remediating, grouped by severity with title, target, primary regulatoryRef, slaDueAt with SLA status and [fnd_...] citation). This run appended developer-environment observations ${JSON.stringify(observationIds)} and findings ${JSON.stringify(findingIds)}; ${supersededFindingIds.length} findings were re-seen ${JSON.stringify(supersededFindingIds)}. Check every one of these ids is reflected.
Follow your section-ownership table: when it has no row for "${WORKFLOW}" or the row does not include a requested section, do not edit that section, list it in sectionsSkipped with the reason, and still return the counts you computed from the ledger. For sections you do write: keep every other section byte-for-byte, keep frontmatter sections[] in document order, bump version minor and recompute provenance.inputsHash exactly as the company-summary schema description prescribes. ${provenanceNote('report-writer')}${runNow ? '' : ' Your tools cannot read the clock: use the latest recordedAt among this run\'s records in the ledger as generatedAt.'}
Run \`node .claude/scripts/validate-data.mjs ${profile}/summary.md\` after any edit and fix anything it rejects. Return sectionsUpdated, sectionsSkipped, openFindings (count of open, triaged and remediating findings in the ledger), observations (count of this run's observations you could read back) and the new version.`, { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, agentType: 'report-writer', effort: 'medium' });
  if (!report) skipped.push({ target: `${profile}/summary.md`, reason: 'report-writer returned no schema-valid result; summary not updated' });
  else { noteSession(report); if (report.sectionsSkipped && report.sectionsSkipped.length) skipped.push({ target: `${profile}/summary.md`, reason: `report-writer skipped sections: ${report.sectionsSkipped.join(', ')}` }); }
}

if (skipped.length) log(`skipped (${skipped.length}): ${skipped.map((s) => `${s.target} — ${s.reason}`).join('; ')}`);

return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  targets: targets.map(targetKey),
  devEnvironments: devEnvs.map((e) => `environment:${e.appId}/${e.envId}`),
  controls: controlsAppended,
  observations: observationIds.length,
  findings: findingIds.length,
  risks: 0,
  initiatives: 0,
  suggestions: 0,
  refuted: refutedTotal,
  duplicatesDropped: duplicates,
  reseen: supersededFindingIds.length,
  observationIds,
  findingIds,
  supersededFindingIds,
  sarifExports: audited.filter((r) => r.sarifPath).map((r) => r.sarifPath),
  versionFile,
  summary: report ? { sectionsUpdated: report.sectionsUpdated, sectionsSkipped: report.sectionsSkipped, version: report.version || null } : null,
  skipped,
  sessionIds: [...sessionIds],
};
