// execute-scr — Secure Code Review for one company. Scouts every application repo with its exposure and data
// classification (from all of applications/<app>/env/*.json), selects the OWASP ASVS 5.0 level and chapters per repo
// from that exposure, runs the secure-code-reviewer per repo, refutes every candidate finding adversarially
// (lenses exploitability + evidence, the evidence lens vetoing at every severity; high and critical need unanimity,
// critical adds reproduction), dedups by fingerprint across repos, appends observations and findings through
// node .claude/scripts/soc/append.mjs, then runs the probe-sdlc (sdlc-auditor) and probe-dev-env (devenv-auditor)
// checks inline with the same refute -> dedup -> ledger path and the same fixed rule tables as the standalone
// workflows, versions the ledger with soc/version.mjs and finally lets the report-writer refresh summary.md.
// args: { companyId (required), appIds?: string[], envIds?: string[] (restricts the DevEnv environment records only),
//         dryRun?: boolean, now?: RFC3339 UTC 'Z' string, sessionId?: string, runId?: string }
export const meta = {
  name: 'execute-scr',
  description: 'Secure code review of every app repo, ASVS 5 scope chosen by exposure and data class, refuted and ledgered, then probe-sdlc and probe-dev-env inline. args: companyId, appIds, envIds, dryRun, now',
  phases: [
    { title: 'Scout', detail: 'List repos with checkout, languages, exposure and data classification from all env files; rank by risk' },
    { title: 'Review', detail: 'secure-code-reviewer reviews each repo against the ASVS 5 level and chapters selected by exposure' },
    { title: 'Refute', detail: 'refuter lenses exploitability and evidence per finding; evidence vetoes, high and critical need unanimity, critical adds reproduction' },
    { title: 'Dedup', detail: 'Barrier: drop duplicate findings by fingerprint across repos before anything is written' },
    { title: 'Ledger', detail: 'soc-ledger-keeper appends controls, observations and findings via soc/append.mjs, one repo at a time' },
    { title: 'SDLC', detail: 'Inline probe-sdlc: sdlc-auditor compares sdlc/policy.json with repo evidence, refuted and ledgered' },
    { title: 'DevEnv', detail: 'Inline probe-dev-env: devenv-auditor reviews developer configs and dev-tier envs, refuted and ledgered' },
    { title: 'Report', detail: 'soc/version.mjs records the ledger diff; report-writer refreshes open-findings and control-summary in summary.md' },
  ],
};

const a = args || {};
const companyId = a.companyId;
if (typeof companyId !== 'string' || !companyId) throw new Error('execute-scr: args.companyId is required');
const WORKFLOW = 'execute-scr';
const dryRun = a.dryRun === true;
const appIds = Array.isArray(a.appIds) && a.appIds.length ? a.appIds : null;
const envIds = Array.isArray(a.envIds) && a.envIds.length ? a.envIds : null;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
let runNow = typeof a.now === 'string' && TIMESTAMP_RE.test(a.now) ? a.now : '';
const sessionId = typeof a.sessionId === 'string' ? a.sessionId : '';
const runId = typeof a.runId === 'string' ? a.runId : '';
const profile = `company-profile/${companyId}`;
// sarif-findings section 3: kpis/data/raw/sessions/<sid>/<workflow>.<appId>.<repoId>.sarif.export.json. Without
// args.sessionId the agent that writes the log uses its own harness session id for <sid> and returns it.
const exportDir = `kpis/data/raw/sessions/${sessionId || '<your harness session id>'}`;
const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const SEVERITY_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
const CONFIDENCE = ['confirmed', 'likely', 'possible', 'unverified'];
const SCR_LENSES = ['exploitability', 'evidence'];
const SCR_CRITICAL_LENSES = ['exploitability', 'evidence', 'reproduction'];
// Lens names are the refuter agent's closed set (correctness, evidence, regulatory-mapping, exploitability, reproduction).
const SDLC_LENSES = ['evidence', 'correctness', 'regulatory-mapping'];
const DEVENV_LENSES = ['evidence', 'correctness'];
const VETO_LENS = 'evidence';
const EXPOSURE_RANK = { internet: 4, partner: 3, internal: 2, isolated: 1, unknown: 0 };
const SENSITIVE_CLASSES = ['restricted', 'pii', 'spdi', 'cardholder', 'financial', 'regulatory'];
const DEV_TIERS = ['dev', 'test', 'devtest', 'sandbox'];

// NIST SSDF 1.1 practices (PW.3 was withdrawn in 1.1 and folded into PW.4).
const SSDF_PRACTICES = ['PO.1', 'PO.2', 'PO.3', 'PO.4', 'PO.5', 'PS.1', 'PS.2', 'PS.3', 'PW.1', 'PW.2', 'PW.4', 'PW.5', 'PW.6', 'PW.7', 'PW.8', 'PW.9', 'RV.1', 'RV.2', 'RV.3'];
// Fixed SDLC rule ids: ssdf-<SSDF 1.1 task lower-cased, dots as hyphens>-<check> (id, practice, scope, meaning).
// Keep word for word identical to SSDF_RULES in probe-sdlc.js: the ruleId is the first fingerprint input.
const SSDF_RULES = [
  ['ssdf-po-1-1-policy-missing-or-invalid', 'PO.1', 'company', 'sdlc/policy.json missing, unreadable or schema-invalid (high)'],
  ['ssdf-po-1-1-policy-review-overdue', 'PO.1', 'company', 'effectiveFrom plus reviewCadenceMonths already past, or no named policy owner'],
  ['ssdf-po-1-2-no-security-requirements', 'PO.1', 'company', 'no secure coding standard, threat-modelling requirement or SECURITY.md referenced by the policy or present in any repo'],
  ['ssdf-po-2-1-security-roles-undefined', 'PO.2', 'company', 'no security owner, approver role or owning team named for security-sensitive code paths'],
  ['ssdf-po-3-1-gate-tool-absent', 'PO.3', 'company', 'a ciGates tool the policy names is absent from every CI configuration in scope'],
  ['ssdf-po-4-1-no-blocking-gate', 'PO.4', 'company', 'no gate is blocking, gates block only on non-default branches, or minSeverityToBlock is critical for sast or sca on repos handling spdi, cardholder or payments'],
  ['ssdf-po-4-1-sla-longer-than-regulator', 'PO.4', 'company', 'dependencyPolicy.vulnerabilitySlaDays longer than the regulator patch-sla row in sla-table.json for the same severity (high)'],
  ['ssdf-po-4-2-mapping-overclaim', 'PO.4', 'company', 'an ssdfMapping entry marked implemented with no evidence in any repo, used only when no more specific rule here fits'],
  ['ssdf-po-5-1-release-approval-gap', 'PO.5', 'company|repo', 'environmentsOrder skips UAT or staging for prod-bound changes, approvalsRequired below 1 for prod, or a prod deploy job with no environment protection or approval'],
  ['ssdf-po-5-1-environment-separation', 'PO.5', 'company|repo', 'prod deploy reachable from feature branches, dev or test jobs using prod credentials or targets, or deploys during an environment changeFreeze not prevented'],
  ['ssdf-po-5-1-deploy-window-market-hours', 'PO.5', 'company|repo', 'deploymentWindows or deploy schedules overlapping NSE/BSE market hours (09:00-15:30 IST) for a SEBI-regulated trading or investment platform'],
  ['ssdf-po-5-1-no-emergency-change-process', 'PO.5', 'company', 'no emergencyChangeProcess, or rollbackPlanRequired absent or false, in releaseProcess'],
  ['ssdf-po-5-1-no-rollback-mechanism', 'PO.5', 'repo', 'rollbackPlanRequired true but no previous-release redeploy job, Helm rollback or GitOps history visible'],
  ['ssdf-ps-1-1-branch-unprotected', 'PS.1', 'repo', 'default or protected branch unprotected, enforceAdmins false in a prod-deploying repo, or public visibility for proprietary code'],
  ['ssdf-ps-1-1-ci-secrets-outside-backend', 'PS.1', 'company|repo', 'CI or deployment secrets held as literal or plain CI variables instead of the secretsManagement.backend the policy mandates (file names only; committed key files belong to the dev-env rule devenv-committed-key-material)'],
  ['ssdf-ps-2-1-unsigned-commits', 'PS.2', 'repo', 'signedCommitsRequired true but requireSignedCommits false or unsigned commits on the default branch'],
  ['ssdf-ps-2-1-unsigned-release-artefacts', 'PS.2', 'repo', 'release tags, images or artefacts neither signed nor checksummed although the policy requires release integrity'],
  ['ssdf-ps-3-1-release-not-archived', 'PS.3', 'repo', 'released versions not tagged or their artefacts not retained, so a released build cannot be reproduced'],
  ['ssdf-ps-3-2-sbom-missing', 'PS.3', 'company|repo', 'sbomRequired false where the instrument demands an SBOM, or no, empty or wrong-format SBOM for a prod image'],
  ['ssdf-pw-1-1-agent-code-no-injection-controls', 'PW.1', 'repo', 'containsAgentCode without the aiCodingPolicy.promptInjectionControls referenced anywhere in the repo'],
  ['ssdf-pw-2-1-no-design-review', 'PW.2', 'repo', 'internet or partner exposed repo handling sensitive data with no threat model or design review record'],
  ['ssdf-pw-4-1-missing-lockfile', 'PW.4', 'repo', 'lockfilesRequired true but a packageManifests entry has no committed lockfile'],
  ['ssdf-pw-4-1-unapproved-registry', 'PW.4', 'repo', 'registry configuration pointing outside dependencyPolicy.allowedRegistries'],
  ['ssdf-pw-4-4-no-dependency-update-automation', 'PW.4', 'repo', 'no renovate or dependabot configuration where the policy promises dependency update automation'],
  ['ssdf-pw-7-1-no-pr-security-checklist', 'PW.7', 'repo', 'no PR or MR template with a security and data-impact checklist for repos handling pii, spdi, cardholder or financial data'],
  ['ssdf-pw-7-2-approvers-below-policy', 'PW.7', 'repo', 'branchProtection.minApprovers below codeReview.minApprovers, or dismissStaleReviews false'],
  ['ssdf-pw-7-2-codeowners-not-enforced', 'PW.7', 'repo', 'codeownersEnforced true but requireCodeOwnerReviews false, no CODEOWNERS file, or no owner for auth, payments, KYC, crypto, infra or CI paths'],
  ['ssdf-pw-7-2-direct-push-to-protected', 'PW.7', 'repo', 'first-parent commits on a protected branch with no PR reference and no bot author'],
  ['ssdf-pw-7-2-ai-review-only', 'PW.7', 'repo', 'aiReviewAllowed false or humanReviewRequired true, yet an AI review bot is the only required review or check'],
  ['ssdf-pw-8-2-test-gate-not-enforced', 'PW.8', 'repo', 'claimed unit-tests, integration-tests or dast gate not run in CI or run with failures ignored'],
  ['ssdf-pw-8-2-no-coverage-threshold', 'PW.8', 'repo', 'tests run in CI but no coverage threshold configured anywhere'],
  ['ssdf-pw-9-1-insecure-release-defaults', 'PW.9', 'repo', 'production configuration shipped by the repo with insecure defaults (debug on, TLS verification off, default admin accounts)'],
  ['ssdf-rv-1-2-security-gate-missing', 'RV.1', 'repo', 'claimed sast, secrets, sca, container or iac gate absent from the repo CI'],
  ['ssdf-rv-1-2-security-gate-non-blocking', 'RV.1', 'repo', 'claimed security gate present but continue-on-error, allow_failure, soft_fail, exit-code 0 or missing from branchProtection.statusChecks'],
  ['ssdf-rv-1-3-no-disclosure-route', 'RV.1', 'company', 'no SECURITY.md or security.txt vulnerability disclosure route for internet-facing applications'],
  ['ssdf-rv-2-2-no-audit-remediation-loop', 'RV.2', 'company', 'no annual or post-major-change security audit, or no tracked closure of audit findings'],
];
const ssdfRulesNote = (scope) => `Rule ids are FIXED and supersede the dotted ssdf-<task> ids in your agent checklist; use them in the SARIF rules[] too. Use exactly one id from this table for every finding (never invent, rename or suffix one; when no id fits, record the gap in an observation description instead). Two distinct gaps that share an id and a location become one finding listing both clauses. Ids for this ${scope} target: ${SSDF_RULES.filter((r) => r[2].split('|').includes(scope)).map(([id, practice, , meaning]) => `${id} [${practice}] ${meaning}`).join('; ')}.`;

// Fixed developer-environment rule ids (id, area, meaning). Keep word for word identical to DEVENV_RULES in
// probe-dev-env.js: the ruleId is the first fingerprint input, so a model-chosen id would split one gap into two findings.
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
const readOnlyNote = 'Read-only: never modify a repository, never run a build, install, fetch, push or network call, never print secret values (report a committed secret by file name, line and secret type only; never the value, a prefix of it or a hash of it). Return data, not prose.';
const offlineScannerNote = 'Scanners run only offline with local rules: semgrep --metrics=off --config <the repo .semgrep/ directory or a local rules directory> (never --config auto, p/ or r/ registry packs), trivy fs --offline-scan --skip-db-update, grype dir:<path> only with a cached database, bandit, gosec, brakeman, gitleaks detect --no-git --redact. A tool that is missing or needs the network goes to skipped with the reason.';
const evidenceNote = 'Evidence items carry type, ref, optional sha256, optional collectedAt and an optional description of at most 200 characters (for example "lines 88-131 at <sha>"); no other keys. Quote the command or file you relied on in ref or description so a refuter can re-check it.';
const tagRule = (prefix, sub) => `tags ["${prefix}", "${sub || prefix}:<area>"] where <area> is lower-cased with every character outside a-z, 0-9, colon, underscore and hyphen replaced by "-" (tags must match ^[a-z0-9][a-z0-9:_-]{0,47}$, so "PO.3" becomes "po-3" and "V6" becomes "v6")`;
const appFilterNote = appIds ? `Only list repos and environments of applications whose appId is one of: ${appIds.join(', ')} (others go to skipped).` : 'Consider every application under applications/.';
const ledgerReuseNote = (key, table) => `Before choosing a ruleId, grep ${profile}/soc/main.jsonl for findings whose target is ${key}: when one has the same location path${table ? ' and its source.ruleId is in the table' : ''}, reuse that exact source.ruleId and path so the ledger supersedes instead of duplicating.`;

// ---------- schemas ----------
const SKIPPED_SCHEMA = { type: 'array', items: { type: 'object', required: ['target', 'reason'], properties: { target: { type: 'string' }, reason: { type: 'string' } } } };
const REG_REF_SCHEMA = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const EVIDENCE_SCHEMA = { type: 'object', required: ['type', 'ref'], properties: { type: { enum: ['workspace-file', 'url', 'command-output', 'screenshot', 'log-excerpt', 'ticket', 'pull-request', 'commit', 'sbom', 'sarif', 'ocsf'] }, ref: { type: 'string' }, sha256: { type: 'string' }, collectedAt: { type: 'string' }, description: { type: 'string', maxLength: 200 } } };
// Mirrors common.schema.json assetRef: the ids each type needs are required, so a bare {type:"repo"} fails the schema retry.
const TARGET_SCHEMA = {
  type: 'object',
  required: ['type'],
  properties: { type: { enum: ['company', 'application', 'environment', 'repo', 'image'] }, appId: { type: 'string' }, envId: { type: 'string' }, repoId: { type: 'string' }, imageId: { type: 'string' } },
  allOf: [
    { if: { required: ['type'], properties: { type: { enum: ['application', 'environment', 'repo', 'image'] } } }, then: { required: ['appId'] } },
    { if: { required: ['type'], properties: { type: { const: 'environment' } } }, then: { required: ['envId'] } },
    { if: { required: ['type'], properties: { type: { const: 'repo' } } }, then: { required: ['repoId'] } },
    { if: { required: ['type'], properties: { type: { const: 'image' } } }, then: { required: ['imageId'] } },
  ],
};
const LOCATION_SCHEMA = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } } };
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['companyId', 'repos', 'policyFound', 'policySummary', 'skipped'],
  properties: {
    companyId: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    primaryInstruments: { type: 'array', items: { type: 'string' } },
    frameworksInScope: { type: 'array', items: { type: 'string' } },
    policyFound: { type: 'boolean' },
    policySummary: { type: 'string' },
    ssdfPracticesClaimed: { type: 'array', items: { type: 'object', required: ['practice', 'status'], properties: { practice: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } } } },
    devEnvironments: { type: 'array', items: { type: 'object', required: ['appId', 'envId', 'tier', 'recordPath'], properties: { appId: { type: 'string' }, envId: { type: 'string' }, tier: { type: 'string' }, exposure: { type: 'string' }, secretsBackend: { type: 'string' }, dataClassification: { type: 'array', items: { type: 'string' } }, recordPath: { type: 'string' } } } },
    repos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'repoId', 'recordPath', 'exposure', 'dataClassification'],
        properties: {
          appId: { type: 'string' }, repoId: { type: 'string' }, recordPath: { type: 'string' }, localCheckout: { type: 'string' },
          host: { type: 'string' }, ciSystem: { type: 'string' }, buildSystem: { type: 'string' }, defaultBranch: { type: 'string' }, pinnedCommit: { type: 'string' },
          languages: { type: 'array', items: { type: 'string' } }, packageManifests: { type: 'array', items: { type: 'string' } },
          exposure: { enum: ['internet', 'partner', 'internal', 'isolated', 'unknown'] },
          dataClassification: { type: 'array', items: { type: 'string' } },
          environmentTiers: { type: 'array', items: { type: 'string' } },
          containsAgentCode: { type: 'boolean' }, containsIac: { type: 'boolean' }, codeownersPresent: { type: 'boolean' }, usesWebRtc: { type: 'boolean' },
          branchProtectionSummary: { type: 'string' }, entryPoints: { type: 'string' },
        },
      },
    },
    skipped: SKIPPED_SCHEMA,
    sessionId: { type: 'string' },
  },
};
const OBSERVATION_ITEM = (areaSchema) => ({ type: 'object', required: ['title', 'description', 'area', 'result', 'regulatoryRefs', 'evidence'], properties: { title: { type: 'string' }, description: { type: 'string' }, area: areaSchema, practice: { type: 'string' }, result: { enum: ['satisfied', 'not-satisfied', 'partial', 'not-applicable', 'inconclusive'] }, subject: TARGET_SCHEMA, regulatoryRefs: { type: 'array', minItems: 1, items: REG_REF_SCHEMA }, evidence: { type: 'array', items: EVIDENCE_SCHEMA } } });
const FINDING_ITEM = (ruleIdSchema, areaSchema, extraRequired) => ({ type: 'object', required: ['title', 'description', 'severity', 'confidence', 'area', 'ruleId', 'regulatoryRefs', 'evidence', ...extraRequired], properties: { title: { type: 'string' }, description: { type: 'string' }, severity: { enum: SEVERITY_ORDER }, confidence: { enum: CONFIDENCE }, area: areaSchema, practice: { type: 'string' }, ruleId: ruleIdSchema, cweId: { type: 'string' }, asvsRequirement: { type: 'string' }, tool: { type: 'string' }, toolVersion: { type: 'string' }, target: TARGET_SCHEMA, location: LOCATION_SCHEMA, dataFlow: { type: 'string' }, exploitScenario: { type: 'string' }, impact: { type: 'string' }, remediation: { type: 'string' }, cvssVector: { type: 'string' }, cvssScore: { type: 'number' }, regulatoryRefs: { type: 'array', minItems: 1, items: REG_REF_SCHEMA }, evidence: { type: 'array', items: EVIDENCE_SCHEMA } } });
const PROBE_SCHEMA = (observationItem, findingItem) => ({ type: 'object', required: ['observations', 'findings', 'skipped'], properties: { observations: { type: 'array', items: observationItem }, findings: { type: 'array', items: findingItem }, sarifPath: { type: 'string' }, sarifSha256: { type: 'string' }, skipped: SKIPPED_SCHEMA, sessionId: { type: 'string' } } });
const SCR_SCHEMA = PROBE_SCHEMA(OBSERVATION_ITEM({ type: 'string' }), FINDING_ITEM({ type: 'string' }, { type: 'string' }, ['location']));
const SDLC_SCHEMA = PROBE_SCHEMA(OBSERVATION_ITEM({ enum: SSDF_PRACTICES }), FINDING_ITEM({ enum: SSDF_RULES.map((r) => r[0]) }, { enum: SSDF_PRACTICES }, []));
const DEVENV_SCHEMA = PROBE_SCHEMA(OBSERVATION_ITEM({ type: 'string' }), FINDING_ITEM({ enum: DEVENV_RULES.map((r) => r[0]) }, { type: 'string' }, ['target']));
const REFUTE_SCHEMA = { type: 'object', required: ['refuted', 'reason'], properties: { refuted: { type: 'boolean' }, confidence: { type: 'number' }, lens: { type: 'string' }, reason: { type: 'string' }, corrections: { type: 'array', items: { type: 'object', required: ['path', 'why'], properties: { path: { type: 'string' }, current: {}, proposed: {}, why: { type: 'string' } } } }, checked: { type: 'array', items: { type: 'string' } }, unverifiable: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' } } };
const LEDGER_SCHEMA = { type: 'object', required: ['controlsAppended', 'observationsAppended', 'findingsAppended', 'observationIds', 'findingIds', 'supersededFindingIds', 'skipped'], properties: { controlsAppended: { type: 'integer' }, observationsAppended: { type: 'integer' }, findingsAppended: { type: 'integer' }, observationIds: { type: 'array', items: { type: 'string' } }, findingIds: { type: 'array', items: { type: 'string' } }, supersededFindingIds: { type: 'array', items: { type: 'string' } }, now: { type: 'string' }, skipped: SKIPPED_SCHEMA, sessionId: { type: 'string' } } };
const VERSION_SCHEMA = { type: 'object', required: ['written'], properties: { written: { type: 'string' }, error: { type: 'string' }, sessionId: { type: 'string' } } };
const REPORT_SCHEMA = { type: 'object', required: ['sectionsUpdated', 'sectionsSkipped', 'openFindings'], properties: { sectionsUpdated: { type: 'array', items: { type: 'string' } }, sectionsSkipped: { type: 'array', items: { type: 'string' } }, openFindings: { type: 'integer' }, observations: { type: 'integer' }, version: { type: 'string' }, sessionId: { type: 'string' } } };

// ---------- helpers ----------
const normalisePath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
const targetKey = (t) => {
  if (!t || t.type === 'company') return `company:${companyId}`;
  if (t.type === 'application') return `application:${t.appId}`;
  if (t.type === 'environment') return `environment:${t.appId}/${t.envId}`;
  if (t.type === 'image') return `image:${t.appId}/${t.imageId}`;
  return `repo:${t.appId}/${t.repoId}`;
};
const findingKey = (t, f) => `${f.ruleId}|${targetKey(f.target || t)}|${normalisePath(f.location && f.location.path)}`;
const lowerSeverity = (x, y) => (SEVERITY_ORDER.indexOf(x) <= SEVERITY_ORDER.indexOf(y) ? x : y);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const noteNow = (r) => { if (!runNow && r && typeof r.now === 'string' && TIMESTAMP_RE.test(r.now)) runNow = r.now; };
const repoLabel = (r) => `${r.appId}/${r.repoId}`;
const hasSensitiveData = (classes) => (classes || []).some((c) => SENSITIVE_CLASSES.includes(c));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Fill ids a candidate target omitted from the audited repo; null when they cannot be recovered, so the caller falls
// back to the default subject (a bare {type:"repo"} is not a valid assetRef and breaks the dedup key).
const repairTarget = (ft, r, knownEnvs) => {
  if (!ft || !ft.type) return null;
  if (ft.type === 'company') return { type: 'company' };
  const appId = ft.appId || r.appId;
  if (!appId) return null;
  if (ft.type === 'repo') { const repoId = ft.repoId || (appId === r.appId ? r.repoId : ''); return repoId ? { type: 'repo', appId, repoId } : null; }
  if (ft.type === 'environment') {
    if (!ft.envId) return null;
    if (knownEnvs && appId === r.appId && !knownEnvs.some((e) => e.envId === ft.envId)) return null;
    return { type: 'environment', appId, envId: ft.envId };
  }
  if (ft.type === 'image') return ft.imageId ? { type: 'image', appId, imageId: ft.imageId } : null;
  if (ft.type === 'application') return { type: 'application', appId };
  return null;
};

// Accept a SARIF export only at the sanctioned per-session path; otherwise ignore it (findings then use agent-analysis).
const acceptSarif = (res, name, label) => {
  if (!res.sarifPath) { delete res.sarifSha256; return; }
  const sid = sessionId || res.sessionId || '';
  const segment = sid ? escapeRe(sid) : '(?!run_|unattributed)[A-Za-z0-9._-]+';
  const ok = new RegExp(`^kpis/data/raw/sessions/${segment}/${escapeRe(name)}$`).test(res.sarifPath) && /^[A-Za-z0-9._\/-]+$/.test(res.sarifPath);
  const shaOk = !res.sarifSha256 || /^[a-f0-9]{64}$/.test(res.sarifSha256);
  if (ok && shaOk) return;
  skipped.push({ target: `${label}: ${res.sarifPath}`, reason: `SARIF export ignored: expected kpis/data/raw/sessions/<sessionId>/${name} with a 64-hex sha256` });
  delete res.sarifPath; delete res.sarifSha256;
};

// OWASP ASVS 5.0 scope selection. Level: internet + sensitive data => L3; internet, partner, unknown or sensitive data
// => L2; else L1. Chapters shrink with exposure; V17 (WebRTC) is added when the scout saw WebRTC code in the checkout;
// agent code adds the LLM and agentic lenses.
const ASVS_CHAPTERS = {
  V1: 'Encoding and Sanitization', V2: 'Validation and Business Logic', V3: 'Web Frontend Security', V4: 'API and Web Service',
  V5: 'File Handling', V6: 'Authentication', V7: 'Session Management', V8: 'Authorization', V9: 'Self-contained Tokens',
  V10: 'OAuth and OIDC', V11: 'Cryptography', V12: 'Secure Communication', V13: 'Configuration', V14: 'Data Protection',
  V15: 'Secure Coding and Architecture', V16: 'Security Logging and Error Handling', V17: 'WebRTC',
};
const asvsScope = (r) => {
  const sensitive = hasSensitiveData(r.dataClassification);
  const exposure = EXPOSURE_RANK[r.exposure] === undefined ? 'unknown' : r.exposure;
  let level = 1;
  if (exposure === 'internet' && sensitive) level = 3;
  else if (exposure === 'internet' || exposure === 'partner' || exposure === 'unknown' || sensitive) level = 2;
  let chapters;
  if (exposure === 'internet' || exposure === 'unknown') chapters = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16'];
  else if (exposure === 'partner') chapters = ['V1', 'V2', 'V4', 'V5', 'V6', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16'];
  else if (exposure === 'internal') chapters = ['V1', 'V2', 'V4', 'V6', 'V8', 'V11', 'V13', 'V14', 'V15', 'V16'];
  else chapters = ['V1', 'V2', 'V11', 'V13', 'V14', 'V15', 'V16'];
  if (sensitive && !chapters.includes('V14')) chapters.push('V14');
  if (r.usesWebRtc === true) chapters.push('V17');
  const extraLenses = [];
  if (r.containsAgentCode) extraLenses.push('owasp-llm-top10-2025 (LLM01 prompt injection, LLM02 sensitive information disclosure, LLM05 improper output handling, LLM06 excessive agency)', 'owasp-agentic-top10-2026 (ASI01 agent goal hijack, ASI02 tool misuse and exploitation, ASI03 identity and privilege abuse, ASI05 unexpected code execution, ASI06 memory and context poisoning)');
  return { level, chapters, extraLenses, sensitive, exposure };
};
const riskRank = (r) => EXPOSURE_RANK[r.exposure] * 10 + (hasSensitiveData(r.dataClassification) ? 5 : 0) + (r.containsAgentCode ? 2 : 0) + (r.localCheckout ? 1 : 0);

// Generic adversarial refutation through the refuter agent (one candidate, one lens per call).
// Verdict: the evidence lens vetoes at every severity; high and critical need every lens to answer and none to
// refute; otherwise a majority of the answering lenses decides and a split keeps the candidate at confidence
// "possible". Lenses that return nothing are counted apart from refutations: a candidate no lens could judge (or a
// high/critical one missing a lens, or any one missing the evidence lens) goes to skipped, not to rejected.
// Severity corrections from non-refuting lenses only lower severity, except the regulatory-mapping lens, whose
// correction is also accepted upward when it cites the catalog defaultSeverity.
const refutePrompt = (kind, t, f, lens, extra) => `Refute one candidate. lens: "${lens}". context: {"companyId":"${companyId}","workflow":"${WORKFLOW}"${sessionId ? `,"sessionId":"${sessionId}"` : ''}${runId ? `,"runId":"${runId}"` : ''},"target":"${targetKey(f.target || t)}"}. Candidate kind: ${kind}.
candidate: ${JSON.stringify(f)}
This is a pre-ledger candidate: id, fingerprint, provenance, controlIds, slaBasis, slaDueAt, firstSeenAt and lastSeenAt are added by the soc-ledger-keeper after you, so their absence never refutes; helper keys (area, ruleId, cweId, asvsRequirement, practice, dataFlow, exploitScenario, impact, remediation, cvssVector, cvssScore) are data to verify. Location paths are relative to the repo root${t && t.localCheckout ? ` (checkout at ${t.localCheckout})` : ''} unless they start with applications/ or company-profile/. Evidence descriptions (line ranges, counts, command lines) are part of the claim.
${extra}
Lens guidance for this workflow — exploitability: trace the data flow from an attacker-controlled source to the sink in the cited code; refute when input is validated, encoded, parameterised or the sink is unreachable for this exposure. evidence: the cited file and line at the pinned commit really contain what the candidate says, and nothing in the repo (middleware, framework defaults, config, tests) already compensates. reproduction: another auditor could redo it from the description alone and it does not duplicate a finding already open in ${profile}/soc/main.jsonl. correctness: facts in title and description match the files, the ruleId's meaning fits the gap, and for policy gaps ${profile}/sdlc/policy.json really requires what the candidate says (a stricter-than-policy expectation is not a gap unless the regulator baseline demands it). regulatory-mapping: the cited control applies to this company's entity types, the most specific Indian instrument is first, any nist-ssdf-800-218 task belongs to the cited practice (SSDF 1.1 has no PW.3), and severity equals the catalog defaultSeverity when no CVSS is given; when it does not, propose the catalog value with a "/severity" correction whose why names the catalog defaultSeverity.
Return your standard output contract. Use corrections with path "/severity", "/confidence" or "/regulatoryRefs" when the value should change.`;

const correctionFor = (v, pointer) => (v && Array.isArray(v.corrections) ? v.corrections : []).find((x) => x && x.path === pointer);
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
const refuteFindings = async (kind, phaseName, t, findings, lensesFor, extra) => {
  const kept = []; const rejected = []; let unavailableCount = 0;
  await pipeline(findings, async (f, item, fi) => {
    const lenses = lensesFor(f);
    const tag = `refute ${targetKey(f.target || t)} #${fi + 1}`;
    const votes = await parallel(lenses.map((lens) => () => agent(refutePrompt(kind, t, f, lens, extra), { label: `refute ${lens} ${targetKey(f.target || t)} #${fi + 1}`, phase: phaseName, schema: REFUTE_SCHEMA, agentType: 'refuter', effort: 'high' })));
    votes.forEach(noteSession);
    const d = decide(f, lenses, votes);
    if (d.unavailable) log(`${tag}: ${d.unavailable} lens(es) returned nothing (counted as unavailable, not as refuted)`);
    if (d.outcome === 'unavailable') { unavailableCount += 1; skipped.push({ target: `${kind} ${targetKey(f.target || t)} ${f.ruleId}`, reason: `${d.reason}; candidate "${f.title}" not ledgered, re-run to verify` }); return null; }
    if (d.outcome === 'rejected') { rejected.push({ title: f.title, ruleId: f.ruleId, refutedCount: d.refutedCount, reason: d.reason, reasons: votes.map((v, i) => (v ? `${v.lens || lenses[i]}: ${v.reason}` : `${lenses[i]}: unavailable`)) }); return null; }
    let severity = f.severity; let confidence = f.confidence; let regulatoryRefs = f.regulatoryRefs;
    const rmIndex = lenses.indexOf('regulatory-mapping');
    const rm = rmIndex >= 0 && votes[rmIndex] && !votes[rmIndex].refuted ? correctionFor(votes[rmIndex], '/severity') : undefined;
    if (rm && SEVERITY_ORDER.includes(rm.proposed) && (SEVERITY_ORDER.indexOf(rm.proposed) < SEVERITY_ORDER.indexOf(severity) || /defaultSeverity/i.test(String(rm.why)))) severity = rm.proposed;
    votes.forEach((v, i) => {
      if (!v || v.refuted) return;
      const sev = correctionFor(v, '/severity'); if (i !== rmIndex && sev && SEVERITY_ORDER.includes(sev.proposed)) severity = lowerSeverity(severity, sev.proposed);
      const conf = correctionFor(v, '/confidence'); if (conf && CONFIDENCE.includes(conf.proposed)) confidence = conf.proposed;
      const refs = correctionFor(v, '/regulatoryRefs'); if (refs && Array.isArray(refs.proposed) && refs.proposed.length && refs.proposed.every((x) => x && x.regulator && x.instrument && x.controlId)) regulatoryRefs = refs.proposed;
    });
    if (severity !== f.severity) log(`${tag}: severity corrected ${f.severity} -> ${severity}`);
    if (d.split) { confidence = 'possible'; log(`${tag}: split vote (${d.refutedCount}/${lenses.length} refuted); kept with confidence "possible"`); }
    kept.push({ ...f, severity, confidence, regulatoryRefs, refutation: { lenses, refutedCount: d.refutedCount, unavailable: d.unavailable, unanimityRequired: d.unanimityRequired } });
    return null;
  });
  if (rejected.length) log(`${kind} ${targetKey(t)}: ${rejected.length} of ${findings.length} candidate findings refuted`);
  const lost = findings.length - kept.length - rejected.length - unavailableCount;
  if (lost > 0) skipped.push({ target: `${kind} ${targetKey(t)}`, reason: `${lost} candidate(s) lost to refute-stage errors; not ledgered` });
  return { kept, rejected };
};

// Cross-target dedup by fingerprint key (call only after the whole fan-out has resolved — that await is the barrier).
// The seen set is shared by the SCR, SDLC and DevEnv stages so one defect is never ledgered twice in the same run.
const seenFingerprintKeys = new Set();
const dedupResults = (results, label) => {
  const seen = seenFingerprintKeys; let duplicates = 0;
  for (const r of results) {
    r.findings = r.findings.filter((f) => { const k = findingKey(r.target, f); if (seen.has(k)) { duplicates += 1; return false; } seen.add(k); return true; });
  }
  if (duplicates) log(`${label} dedup: dropped ${duplicates} duplicate findings across targets`);
  return duplicates;
};

const applyDryRun = (r, t) => {
  if (!dryRun) return r;
  if (r.findings.length) log(`dry-run: dropped ${r.findings.length} candidate findings for ${targetKey(t)} (only inconclusive observations are written)`);
  r.findings = [];
  delete r.sarifPath; delete r.sarifSha256;
  r.observations = r.observations.map((o) => ({ ...o, result: 'inconclusive', description: o.description.startsWith('dry-run:') ? o.description : `dry-run: evidence requested — ${o.description}` }));
  return r;
};

// Ledger stage: sequential per target so recordedAt stays monotonic within main.jsonl.
// source.kind: "sarif" with the scanner or maxwell-<agent> driver whenever the result sits in an accepted SARIF
// export; "agent-analysis" only when no log exists for the target.
const ledgerWrite = async (results, { phaseName, methods, tagPrefix, tagSub, agentName }) => {
  const out = { controls: 0, observationIds: [], findingIds: [], supersededFindingIds: [] };
  for (const r of results) {
    if (!r || (!r.observations.length && !r.findings.length)) { if (r) log(`${targetKey(r.target)}: nothing to ledger`); continue; }
    const subjectJson = JSON.stringify(r.target);
    const sarifEvidence = r.sarifPath ? `{"type":"sarif","ref":"${r.sarifPath}"${r.sarifSha256 ? `,"sha256":"${r.sarifSha256}"` : ''}}` : '';
    const sourceRule = r.sarifPath
      ? `{"kind":"sarif","ruleId":"<ruleId>","tool":"<candidate tool, or maxwell-${agentName} when the candidate has none>","toolVersion":"<candidate toolVersion, or 1.0.0 for the maxwell-${agentName} driver>"} (every result is in the SARIF export ${r.sarifPath}; omit toolVersion only when a scanner candidate lacks it)`
      : `{"kind":"agent-analysis","ruleId":"<ruleId>","tool":"${agentName}"} (no SARIF log exists for this target; name any scanner in the description)`;
    const w = await agent(`You are the soc-ledger-keeper for company "${companyId}". Read .claude/skills/soc-ledger/SKILL.md, .claude/skills/maxwell-conventions/SKILL.md and .claude/skills/regulatory-catalogs/SKILL.md (with references/sla-table.json and references/catalogs/*.catalog.json) before writing. Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (record JSON on stdin); never edit ${profile}/soc/main.jsonl directly. ${provenanceNote('soc-ledger-keeper')}
Default subject: ${subjectJson}. Candidate records (already refuted): ${JSON.stringify({ observations: r.observations, findings: r.findings, sarifPath: r.sarifPath || null, sarifSha256: r.sarifSha256 || null })}
Rules:
1. Controls first. Every observation and finding must carry controlIds with at least one "<instrument>:<controlId>" built from its regulatoryRefs. For each such id not yet present in ${profile}/soc/main.jsonl append a control record (kind "control", id "<instrument>:<controlId>", frameworkRefs [the ref itself, then the catalog mappings], title and category from the catalog entry, implementationStatus "unknown", effectiveness "not-tested", applicableAssets [the subject]) and count it in controlsAppended. Skip a regulatoryRef whose control id does not exist in the catalogs and say so in skipped.
2. Observations: kind "observation", id a fresh obs_ ULID (mint with the helper named in maxwell-conventions, never by hand), methods ${JSON.stringify(methods)}, subjects [candidate.subject or the default subject], result as given, collectedAt = now, expiresAt = now + 30 days, evidence as given${sarifEvidence ? ` plus ${sarifEvidence}, toolOutput {"format":"sarif","path":"${r.sarifPath}"${r.sarifSha256 ? `,"sha256":"${r.sarifSha256}"` : ''}}` : ''}, ${tagRule(tagPrefix, tagSub)}.
3. Findings: kind "finding", target = candidate.target or the default subject, source ${sourceRule}, severity and confidence as given, regulatoryRefs as given (most specific Indian instrument first), location as given (path relative to the repo root, never absolute), cvss {version, vector, score} when the candidate carries cvssVector and cvssScore, description = candidate description plus dataFlow, exploitScenario, impact and remediation, status "open", firstSeenAt/lastSeenAt = now, slaBasis and slaDueAt from references/sla-table.json following the soc-ledger skill section 6 (topic patch-sla for defects with a fix; company-override uses ${profile}/sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays when present), fingerprint = sha256 hex over "<ruleId>|<targetKey>|<normalisedLocation>" exactly as the soc-ledger skill defines (targetKey such as repo:<appId>/<repoId>, location path without line numbers, empty when there is none), computed with the \`node -e\` one-liner shown in soc-ledger section 6 (printf and sha256sum are not in your tools), relatedObservationIds = the ids of the observations you just appended for the same area, evidence as given${sarifEvidence ? ` plus ${sarifEvidence}` : ''}, ${tagRule(tagPrefix, tagSub)} plus "cwe:<cwe id lower-cased>" (for example "cwe:cwe-89") when the candidate carries cweId. Build title as one line naming the asset and the weakness (max 200 characters). ${evidenceNote} Drop candidate keys the record schema does not have (area, practice, ruleId, cweId, asvsRequirement, tool, toolVersion, dataFlow, exploitScenario, impact, remediation, cvssVector, cvssScore, subject, refutation) after mapping them as described. Before appending, grep ${profile}/soc/main.jsonl for the fingerprint: when a finding with the same fingerprint exists and its latest record is open, triaged or remediating, append a superseding record with the SAME id, "supersedes" set to that id, the original firstSeenAt preserved and lastSeenAt = now, and list the id in supersededFindingIds; when it is resolved, reopen it (status "open", statusReason "regressed in run ${runId || WORKFLOW}", no resolvedAt) as the skill section 8 prescribes; when false-positive, duplicate or an unexpired risk-accepted, only refresh lastSeenAt; otherwise mint a fresh fnd_ ULID.
4. Append controls, then observations, then findings. After all appends run \`node .claude/scripts/validate-data.mjs ${profile}/soc/main.jsonl\` and fix any rejected record by appending a corrected record (never rewrite lines). A candidate you could not ledger goes into skipped with the validator message.
Return the counts, the ids you appended and the timestamp you used as now.`, { label: `ledger ${targetKey(r.target)}`, phase: phaseName, schema: LEDGER_SCHEMA, agentType: 'soc-ledger-keeper', effort: 'medium' });
    if (!w) { skipped.push({ target: `ledger ${targetKey(r.target)}`, reason: 'soc-ledger-keeper returned no schema-valid result; records not written' }); continue; }
    noteSession(w); noteNow(w);
    out.controls += w.controlsAppended; out.observationIds.push(...w.observationIds); out.findingIds.push(...w.findingIds); out.supersededFindingIds.push(...(w.supersededFindingIds || []));
    skipped.push(...(w.skipped || []).map((s) => ({ target: `ledger ${targetKey(r.target)}: ${s.target}`, reason: s.reason })));
  }
  return out;
};

// ========== Scout ==========
phase('Scout');
const scout = await agent(`Scout company "${companyId}" for a secure code review. ${appFilterNote}
Read .claude/skills/maxwell-conventions/SKILL.md first. Then read ${profile}/details.json (entityTypes, regulators, frameworksInScope), ${profile}/sdlc/policy.json (if absent set policyFound=false and say so in policySummary), every applications/*/repos/*.json record, every applications/*/env/*.json record (all of them, whatever their tier: exposure and data classification drive the review scope) and applications/*/README.md.
For each repo return appId, repoId, recordPath, localCheckout (from the record; omit when the directory does not exist on disk), host, ciSystem, buildSystem, defaultBranch, pinnedCommit, languages, packageManifests, containsAgentCode, containsIac, codeownersPresent, usesWebRtc (true only when the checkout references RTCPeerConnection, getUserMedia, simple-peer, mediasoup, livekit, janus, pion or a TURN/STUN server configuration), a one-line branchProtectionSummary, entryPoints (one line: the HTTP frameworks, routers, queue consumers, CLIs and jobs you can see in the checkout or README), exposure = the highest exposure of all of that application's environments (internet > partner > internal > isolated; "unknown" when no env file exists), dataClassification = the union of dataClassification across all of those environments, environmentTiers = their tiers.
devEnvironments: every environment whose tier is ${DEV_TIERS.join(', ')}, with appId, envId, tier, exposure, secretsBackend, dataClassification and recordPath.
policySummary: a compact plain-text digest of branching, codeReview, ciGates (gate/tool/blocking/threshold), releaseProcess, secretsManagement, dependencyPolicy and aiCodingPolicy so an auditor can compare without re-reading. ssdfPracticesClaimed: the ssdfMapping entries verbatim.
primaryInstruments: the vocab instrument ids that apply to the entityTypes (sebi-cscrf-2024 for SEBI-regulated entities, rbi-cyber-tech-directions-2026 for RBI-regulated ones, irdai-info-cyber-security-2023 for insurers, cert-in-directions-2022 and dpdp-rules-2025 for all, then owasp-asvs-5.0 and nist-ssdf-800-218).
List in skipped every application with no repo record, every repo without a local checkout, and every application excluded by the filter, each with a reason. Read-only; return data only.`, { label: 'scout', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'ctx-researcher', effort: 'medium' });
if (!scout) throw new Error('execute-scr: scout returned nothing');
noteSession(scout);
skipped.push(...(scout.skipped || []));
const inAppScope = (x) => !appIds || appIds.includes(x.appId);
for (const r of (scout.repos || []).filter((r) => !inAppScope(r))) skipped.push({ target: `repo:${repoLabel(r)}`, reason: `excluded by args.appIds (${appIds.join(', ')})` });
const repos = (scout.repos || []).filter(inAppScope).map((r) => ({ ...r, type: 'repo', scope: asvsScope(r) })).sort((x, y) => riskRank(y) - riskRank(x));
// args.envIds narrows only the DevEnv environment records; ASVS scope always uses every environment of the application.
const devEnvironments = (scout.devEnvironments || []).filter((e) => inAppScope(e) && (!envIds || envIds.includes(e.envId)));
for (const e of (scout.devEnvironments || []).filter((e) => inAppScope(e) && envIds && !envIds.includes(e.envId))) skipped.push({ target: `devenv environment:${e.appId}/${e.envId}`, reason: `excluded by args.envIds (${envIds.join(', ')}); still counted for ASVS exposure and data classification` });
const reviewable = repos.filter((r) => r.localCheckout);
for (const r of repos.filter((r) => !r.localCheckout)) skipped.push({ target: `repo:${repoLabel(r)}`, reason: 'no local checkout on disk; secure code review needs source (run refresh-ctx to clone under applications/<app>/repos/)' });
log(`Scout: ${repos.length} repos (${reviewable.length} with checkout), ${devEnvironments.length} dev-tier environments in DevEnv scope, policyFound=${scout.policyFound}; review order: ${reviewable.map((r) => `${repoLabel(r)} [${r.scope.exposure}, ASVS L${r.scope.level}, ${r.scope.chapters.length} chapters]`).join('; ') || 'none'}`);
if (!scout.policyFound) log(`${profile}/sdlc/policy.json is missing or unreadable; the inline SDLC probe will record that as a gap`);

// ========== Review (per repo, pipelined into Refute) ==========
const entityNote = `(entity types: ${(scout.entityTypes || []).join(', ') || 'unknown'}; primary instruments: ${(scout.primaryInstruments || []).join(', ') || 'unknown'})`;
const scrSarifName = (r) => `${WORKFLOW}.${r.appId}.${r.repoId}.sarif.export.json`;
const reviewPrompt = (r) => `You are the secure-code-reviewer for company "${companyId}" ${entityNote}. Target repo "${r.repoId}" of application "${r.appId}": record ${r.recordPath}, checkout ${r.localCheckout}, pinned commit ${r.pinnedCommit || 'unknown'}, languages ${(r.languages || []).join(', ') || 'unknown'}, package manifests ${(r.packageManifests || []).join(', ') || 'none recorded'}, entry points: ${r.entryPoints || 'not recorded'}. Exposure ${r.scope.exposure}; data classification ${(r.dataClassification || []).join(', ') || 'none recorded'}; environment tiers ${(r.environmentTiers || []).join(', ') || 'unknown'}; containsAgentCode ${r.containsAgentCode === true}.
Read .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/sarif-findings/SKILL.md (how to export SARIF and map scanner levels to severity), .claude/skills/regulatory-catalogs/SKILL.md with its references, and .claude/skills/cve-enrichment/SKILL.md when you identify a vulnerable dependency.
Scope: OWASP ASVS 5.0 Level ${r.scope.level}, chapters ${r.scope.chapters.map((c) => `${c} ${ASVS_CHAPTERS[c]}`).join('; ')}.${r.scope.extraLenses.length ? ` Additional lenses because the repo contains agent code: ${r.scope.extraLenses.join('; ')}.` : ''} Prioritise the code that handles ${r.scope.sensitive ? 'the sensitive data classes listed above (KYC records, PAN/Aadhaar, account and transaction data, card data)' : 'authentication, authorisation and external input'} and every network-facing entry point.
${readOnlyNote} ${offlineScannerNote} ${evidenceNote} ${dryNote}
Method: (1) map the entry points and trust boundaries from the checkout; (2) ${dryRun ? 'list the offline scanners you would run and the SARIF export you would write (do not run or write anything)' : `run the installed offline scanners above and write one SARIF 2.1.0 log (one run per scanner plus the maxwell-secure-code-reviewer run for hand-review results) to ${exportDir}/${scrSarifName(r)}${sessionId ? '' : ' (the <sid> segment is your own harness session id; return it as sessionId)'} following .claude/skills/sarif-findings/SKILL.md sections 1-3; return it as sarifPath with its sha256 as sarifSha256; create the directory; this is the only file you may write; never overwrite an existing export`}; (3) review by hand, chapter by chapter, following data from source to sink; (4) check committed secrets by pattern (report file, line and secret type only, never the value or a hash of it), hard-coded credentials, weak crypto, insecure deserialisation, SQL/NoSQL/command/template injection, missing authorisation on routes, IDOR on account or client identifiers, mass assignment, SSRF, path traversal, unsafe file upload, JWT and session handling, TLS and certificate validation, logging of PII or secrets, and error handling that leaks stack traces.
${ledgerReuseNote(`repo:${r.appId}/${r.repoId}`, false)}
Return one observation per ASVS chapter in scope (area = the chapter id such as "V6"; result satisfied | partial | not-satisfied | not-applicable | inconclusive; evidence = the files you actually read, as workspace-file refs relative to the workspace root) and one finding per concrete defect: area = chapter id, ruleId = the scanner rule id when a scanner found it, otherwise the asvs-v<chapter>-<weakness> id from your agent checklist table (for example "asvs-v6-password-policy", "asvs-v8-idor-account-id"; the requirement number goes in asvsRequirement, never in the ruleId), cweId "CWE-<n>", asvsRequirement (for example "V8.2.2" for IDOR/BOLA data-specific access control), tool and toolVersion (the scanner, or "maxwell-secure-code-reviewer" and "1.0.0" for hand-review results in your SARIF log), target {type "repo", appId "${r.appId}", repoId "${r.repoId}"}, location {path relative to the repo root, startLine, endLine}, dataFlow (source -> sink in one line), exploitScenario, impact for this exposure and data class, remediation, cvssVector and cvssScore (CVSS 3.1) when you can justify them, severity from cvss when present and otherwise from the catalog defaultSeverity of the most specific regulatory control cited (never intuition), confidence, regulatoryRefs (at least one) with the most specific Indian instrument first (for example sebi-cscrf-2024 for a SEBI entity, rbi-cyber-tech-directions-2026 for an RBI entity, cert-in-directions-2022 or dpdp-rules-2025) and owasp-asvs-5.0 <requirement id> second, evidence (workspace-file refs with line ranges in description, and the SARIF export when present). Do not report style issues, do not report the same defect at two locations when one fix covers both, and never report a defect you cannot point at with a path and line. List everything you could not review (binary blobs, generated code, languages you skipped, scanners not run) in skipped.`;

const reviewStage = async (r) => {
  const res = await agent(reviewPrompt(r), { label: `review ${repoLabel(r)}`, phase: 'Review', schema: SCR_SCHEMA, agentType: 'secure-code-reviewer', effort: 'high' });
  if (!res) { skipped.push({ target: `repo:${repoLabel(r)}`, reason: 'secure-code-reviewer returned no schema-valid result' }); return null; }
  noteSession(res);
  skipped.push(...(res.skipped || []).map((s) => ({ target: `repo:${repoLabel(r)}: ${s.target}`, reason: s.reason })));
  res.target = { type: 'repo', appId: r.appId, repoId: r.repoId };
  res.findings = res.findings.map((f) => ({ ...f, target: repairTarget(f.target, r) || res.target }));
  acceptSarif(res, scrSarifName(r), `repo:${repoLabel(r)}`);
  return applyDryRun(res, r);
};
const scrRefuteStage = async (res, r) => {
  if (!res || !res.findings.length) return res;
  const { kept, rejected } = await refuteFindings('secure-code-review finding', 'Refute', r, res.findings, (f) => (f.severity === 'critical' ? SCR_CRITICAL_LENSES : SCR_LENSES), `The repo record is ${r.recordPath}; exposure ${r.scope.exposure}; data classes ${(r.dataClassification || []).join(', ') || 'none'}; ASVS level ${r.scope.level}.`);
  return { ...res, findings: kept, refuted: rejected };
};

phase('Review');
const reviewed = (await pipeline(reviewable, reviewStage, scrRefuteStage)).filter(Boolean);

// ========== Dedup (barrier: the awaited pipeline above) ==========
phase('Dedup');
const scrDuplicates = dedupResults(reviewed, 'scr');
const scrObs = reviewed.reduce((n, r) => n + r.observations.length, 0);
const scrFnd = reviewed.reduce((n, r) => n + r.findings.length, 0);
const scrRefuted = reviewed.reduce((n, r) => n + ((r.refuted && r.refuted.length) || 0), 0);
log(`Review complete: ${scrObs} observations, ${scrFnd} findings after refutation (${scrRefuted} refuted, ${scrDuplicates} duplicates dropped)`);

// ========== Ledger ==========
phase('Ledger');
const scrWritten = await ledgerWrite(reviewed, { phaseName: 'Ledger', methods: [WORKFLOW], tagPrefix: 'scr', agentName: 'secure-code-reviewer' });
log(`Ledger (scr): ${scrWritten.controls} controls, ${scrWritten.observationIds.length} observations, ${scrWritten.findingIds.length} findings (${scrWritten.supersededFindingIds.length} re-seen)`);

// ========== SDLC (inline probe-sdlc: company target + every repo record) ==========
phase('SDLC');
const sdlcTargets = [{ type: 'company' }, ...repos];
const sdlcSarifName = (t) => (t.type === 'company' ? `probe-sdlc.${companyId}.company.sarif.export.json` : `probe-sdlc.${t.appId}.${t.repoId}.sarif.export.json`);
const sdlcCommon = (t) => `You are the sdlc-auditor for company "${companyId}" ${entityNote}, running inside the ${WORKFLOW} workflow as the probe-sdlc step.
Read .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/soc-ledger/SKILL.md (record shapes only — you do not write to the ledger), .claude/skills/sarif-findings/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md and its references (instruments.json, catalogs/*.catalog.json, sla-table.json) so every regulatoryRef cites a real control id and every severity comes from the catalog defaultSeverity, never from intuition.
The policy under test is ${profile}/sdlc/policy.json (policyFound=${scout.policyFound}). Digest: ${scout.policySummary}
Claimed SSDF mapping: ${JSON.stringify(scout.ssdfPracticesClaimed || [])}
${readOnlyNote} ${evidenceNote} ${dryNote}
${dryRun ? '' : `SARIF: write your hand-authored SARIF 2.1.0 log (driver maxwell-sdlc-auditor) to ${exportDir}/${sdlcSarifName(t)}${sessionId ? '' : ' (the <sid> segment is your own harness session id; return it as sessionId)'}, never overwrite an existing export, and return sarifPath and its sha256 as sarifSha256. If you write no log, omit both.`}
Return one observation per NIST SSDF 1.1 practice you could assess (area and practice = one of ${SSDF_PRACTICES.join(', ')}; PW.3 was withdrawn in SSDF 1.1 and folded into PW.4; result satisfied | partial | not-satisfied | not-applicable | inconclusive) with the evidence you actually looked at (workspace-file refs to repo records, CI files, CODEOWNERS, lockfiles, SBOMs), and one finding per gap where observed behaviour falls short of the policy or of the regulator baseline.
${ssdfRulesNote(t.type)}
${ledgerReuseNote(targetKey(t), true)}
Each finding needs: ruleId from the table, area and practice = the practice in the table row, severity and confidence, regulatoryRefs (at least one) with the most specific Indian instrument first and nist-ssdf-800-218 <task> second, a location (path relative to the repo root such as .github/workflows/ci.yml with line numbers when the gap is in a checked-out file; for gaps in the workspace record use the record path relative to the workspace root), impact, remediation and evidence. Do not report the same gap twice under two practices.`;
const sdlcPrompt = (t) => {
  if (t.type === 'company') {
    return `${sdlcCommon(t)}
Target: the company as a whole. Assess policy-level practices across the ${repos.length} repos listed below: PO.1 (security requirements defined, policy owner, effectiveFrom age versus reviewCadenceMonths), PO.2 (roles: owner, codeowners), PO.3 (toolchain: are the ciGates in the policy present in at least one CI config, are tools pinned), PO.4 (criteria: blocking gates and minSeverityToBlock, vulnerabilitySlaDays versus the sla-table), PO.5 (release approvals and environment separation: releaseProcess.environmentsOrder, approvalsRequired, deployment windows outside NSE/BSE market hours, emergency change handling), PS.1 (secrets and code protection: secretsManagement backend versus how CI holds secrets), PS.2 and PS.3 (release integrity, signing, archiving and SBOM policy), RV.1 and RV.2 (disclosure route, audit and remediation loop) and the completeness of ssdfMapping (claimed implemented practices with no evidence anywhere are findings). A missing or invalid policy.json is a high-severity company finding (ruleId ssdf-po-1-1-policy-missing-or-invalid, location ${profile}/sdlc/policy.json).
Repos in scope: ${JSON.stringify(repos.map((r) => ({ appId: r.appId, repoId: r.repoId, recordPath: r.recordPath, localCheckout: r.localCheckout || null })))}`;
  }
  return `${sdlcCommon(t)}
Target: repo "${t.repoId}" of application "${t.appId}" (record ${t.recordPath}; localCheckout ${t.localCheckout || 'none — limit yourself to the record and the application README'}; host ${t.host || 'unknown'}; ciSystem ${t.ciSystem || 'unknown'}; buildSystem ${t.buildSystem || 'unknown'}; exposure ${t.exposure}; containsAgentCode ${t.containsAgentCode === true}; codeownersPresent ${t.codeownersPresent === true}; branch protection: ${t.branchProtectionSummary || 'not recorded'}).
Compare, clause by clause: branching.protectedBranches and signedCommitsRequired against branchProtection (PS.1, PS.2); codeReview against minApprovers, requireCodeOwnerReviews, dismissStaleReviews and the CODEOWNERS file (PW.7); every ciGates entry against branchProtection.statusChecks and the CI configuration in the checkout (.github/workflows/*.yml, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml, .circleci/config.yml, bitbucket-pipelines.yml): gate present, same tool, blocking, threshold honoured (PW.8 for test gates, RV.1 for security gates; exact action and image pinning belongs to probe-cicd-env); releaseProcess against deployment jobs, environment protection rules, approvals, deployment windows and rollback jobs (PO.5 for approvals, environment separation and rollback; PS.2 and PS.3 for release signing, tagging and artefact retention); secretsManagement against how CI and deployment jobs obtain secrets (PS.1, PO.5; committed .env or key files and local secrets hooks belong to the DevEnv step, report file names only); dependencyPolicy against lockfiles for every packageManifests entry, registry configuration (.npmrc, pip.conf, settings.xml, .yarnrc.yml) versus allowedRegistries and dependency update automation (PW.4), an SBOM step and applications/${t.appId}/images/*.cdx.json (PS.3), scanner thresholds versus vulnerabilitySlaDays (RV.1); aiCodingPolicy against the review gates for AI-authored changes and agent code without the promptInjectionControls named in the policy (PW.1, PW.7; harness configuration files themselves belong to the DevEnv step); production configuration defaults shipped by the repo (PW.9) and design or threat-model records for exposed repos (PW.2); ssdfMapping claims against what this repo actually shows.`;
};
const sdlcAuditStage = async (t) => {
  const res = await agent(sdlcPrompt(t), { label: `sdlc audit ${t.type === 'company' ? 'company' : repoLabel(t)}`, phase: 'SDLC', schema: SDLC_SCHEMA, agentType: 'sdlc-auditor', effort: 'high' });
  if (!res) { skipped.push({ target: `sdlc ${targetKey(t)}`, reason: 'sdlc-auditor returned no schema-valid result' }); return null; }
  noteSession(res);
  skipped.push(...(res.skipped || []).map((s) => ({ target: `sdlc ${targetKey(t)}: ${s.target}`, reason: s.reason })));
  // SDLC gaps always belong to the audit target, exactly as in standalone probe-sdlc, so both fingerprint alike.
  res.target = t.type === 'company' ? { type: 'company' } : { type: 'repo', appId: t.appId, repoId: t.repoId };
  res.findings = res.findings.map((f) => ({ ...f, target: res.target }));
  res.observations = res.observations.map((o) => { const { subject: _drop, ...rest } = o; return rest; });
  acceptSarif(res, sdlcSarifName(t), `sdlc ${targetKey(t)}`);
  return applyDryRun(res, t);
};
const sdlcRefuteStage = async (res, t) => {
  if (!res || !res.findings.length) return res;
  const { kept, rejected } = await refuteFindings('sdlc gap', 'SDLC', t, res.findings, () => SDLC_LENSES, `Policy digest: ${scout.policySummary}`);
  return { ...res, findings: kept, refuted: rejected };
};
const sdlcAudited = (await pipeline(sdlcTargets, sdlcAuditStage, sdlcRefuteStage)).filter(Boolean);
const sdlcDuplicates = dedupResults(sdlcAudited, 'sdlc');
const sdlcWritten = await ledgerWrite(sdlcAudited, { phaseName: 'SDLC', methods: [WORKFLOW, 'probe-sdlc'], tagPrefix: 'sdlc', tagSub: 'ssdf', agentName: 'sdlc-auditor' });
const sdlcRefuted = sdlcAudited.reduce((n, r) => n + ((r.refuted && r.refuted.length) || 0), 0);
log(`SDLC: ${sdlcWritten.controls} controls, ${sdlcWritten.observationIds.length} observations, ${sdlcWritten.findingIds.length} findings (${sdlcRefuted} refuted, ${sdlcDuplicates} duplicates dropped)`);

// ========== DevEnv (inline probe-dev-env: developer configs per repo + dev-tier environment records) ==========
phase('DevEnv');
const devEnvsFor = (appId) => devEnvironments.filter((e) => e.appId === appId);
const devTargets = repos.filter((r) => r.localCheckout || devEnvsFor(r.appId).length);
for (const r of repos.filter((r) => !r.localCheckout && !devEnvsFor(r.appId).length)) skipped.push({ target: `devenv repo:${repoLabel(r)}`, reason: 'no local checkout and no dev-tier environment record; nothing to audit' });
// Environment records are audited once per application, by its first DevEnv repo target.
const envOwner = new Map();
for (const r of devTargets) if (!envOwner.has(r.appId)) envOwner.set(r.appId, repoLabel(r));
const ownsEnvs = (r) => envOwner.get(r.appId) === repoLabel(r);
const devSarifName = (r) => `probe-dev-env.${r.appId}.${r.repoId}.sarif.export.json`;
const devEnvScopeNote = (r) => (ownsEnvs(r)
  ? `Dev-tier environment records for this application (you audit them for the whole application): ${JSON.stringify(devEnvsFor(r.appId))}`
  : `Dev-tier environment records for application "${r.appId}" are audited by the ${envOwner.get(r.appId)} target in this run: do not return environment observations or findings with an environment target, and return dev-data-and-exposure only for dumps and fixtures in this checkout.`);
const devPrompt = (r) => `You are the devenv-auditor for company "${companyId}" ${entityNote}, running inside the ${WORKFLOW} workflow as the probe-dev-env step. Target repo "${r.repoId}" of application "${r.appId}": record ${r.recordPath}, checkout ${r.localCheckout || 'none — limit yourself to the environment records and the application README'}, languages ${(r.languages || []).join(', ') || 'unknown'}, containsAgentCode ${r.containsAgentCode === true}, production exposure ${r.scope.exposure}, data classes in production ${(r.dataClassification || []).join(', ') || 'none recorded'}.
${devEnvScopeNote(r)}
Read .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/soc-ledger/SKILL.md (record shapes only), .claude/skills/sarif-findings/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md with its references, and .claude/skills/credentials-sops/SKILL.md (what a credential reference looks like versus a value). Policy digest from ${profile}/sdlc/policy.json (policyFound=${scout.policyFound}): ${scout.policySummary}
${readOnlyNote} Scanners run only offline (gitleaks detect --no-git --redact; trufflehog filesystem --no-verification); a tool that needs the network goes to skipped. ${evidenceNote} ${dryNote}
${dryRun ? '' : `SARIF: write your hand-authored SARIF 2.1.0 log (driver maxwell-devenv-auditor plus one run per offline scanner) to ${exportDir}/${devSarifName(r)}${sessionId ? '' : ' (the <sid> segment is your own harness session id; return it as sessionId)'}, never overwrite an existing export, and return sarifPath and its sha256 as sarifSha256. If you write no log, omit both.`}
Audit the developer environment, area by area, and return one observation per area (result satisfied | partial | not-satisfied | not-applicable | inconclusive, subject = the repo {type "repo", appId, repoId} or {type "environment", appId, envId}, evidence = the files you read):
- secrets-hygiene: committed .env*, *.pem, *.key, id_rsa, kubeconfig, service-account JSON, .npmrc/.pypirc tokens, docker-compose environment blocks with real values, .env.example that is actually populated; .gitignore covering them; pre-commit or husky secrets scanning versus secretsManagement.scanningInCi; secretsBackend of each dev env versus policy secretsManagement.backend (env-files or ci-variables in dev is a finding when the policy mandates a vault);
- dev-containers-and-compose: .devcontainer/devcontainer.json, docker-compose*.yml, Dockerfile.dev, Tiltfile, skaffold.yaml — images pinned by digest or tag, running as root, privileged or host network mode, docker socket mounts, ports bound to 0.0.0.0, databases with default passwords, volumes that mount the whole home directory;
- toolchain-pinning: .nvmrc, .tool-versions, .python-version, engines in package.json, lockfiles present and installed with frozen/ci mode in the dev scripts, registry configuration versus dependencyPolicy.allowedRegistries, postinstall scripts and curl-pipe-sh in Makefile or setup scripts;
- editor-and-hooks: .vscode/settings.json and extensions.json, .idea/, .editorconfig, .pre-commit-config.yaml, .husky/, lefthook.yml — tasks that run arbitrary shell on open, recommended extensions from untrusted publishers, hooks disabled with --no-verify in scripts;
- ai-harness-config: .claude/settings.json and .claude/settings.local.json, .mcp.json, .cursor/rules and .cursorrules, opencode.json, AGENTS.md, CLAUDE.md, .github/copilot-instructions.md — harnesses outside aiCodingPolicy.harnessesAllowed, permission modes that auto-approve writes or shell, MCP servers not on an allowlist or reached over plain http, missing session logging, prompt files that instruct the agent to bypass review, and data classes exposed to the harness beyond allowedDataClasses;
- dev-data-and-exposure: dev-tier environments whose dataClassification includes pii, spdi, cardholder, financial or regulatory (production data in dev: a dpdp-rules-2025 Rule 6 reasonable security safeguards gap; cite dpdp-act-2023 only when purpose limitation itself is at issue), exposure internet or partner for a dev tier, residency outside IN, logsRetentionDays below the CERT-In 180-day baseline, missing changeFreeze on shared dev/test that feed UAT;
- local-run-defaults: debug flags, DEBUG=true, insecure TLS verification disabled, CORS wildcard, default admin credentials or seeded test users in fixtures that also load in higher tiers.
${devenvRulesNote}
${ledgerReuseNote(`repo:${r.appId}/${r.repoId} (and environment:${r.appId}/<envId> for environment gaps)`, true)}
One finding per concrete gap: ruleId from the table, area as in the table, target {type "repo", appId "${r.appId}", repoId "${r.repoId}"} for gaps in the checkout or {type "environment", appId "${r.appId}", envId} for gaps in an environment record (always include every id), location {path relative to the repo root, or the environment record path relative to the workspace root, with line numbers}, severity from the catalog defaultSeverity of the most specific regulatory control cited, confidence, regulatoryRefs (at least one) with the most specific Indian instrument first (sebi-cscrf-2024, rbi-cyber-tech-directions-2026, irdai-info-cyber-security-2023, cert-in-directions-2022, dpdp-rules-2025) and a global mapping second (nist-ssdf-800-218 PO.5/PS.1/PW.4, cis-controls-8.1, owasp-agentic-top10-2026 or csa-mcp-security-2025 for harness and MCP gaps), impact, remediation and evidence. Report a committed secret by file, line and secret type only; never the value, a prefix of it or a hash of it. List what you could not inspect in skipped.`;
const devAuditStage = async (r) => {
  const res = await agent(devPrompt(r), { label: `devenv audit ${repoLabel(r)}`, phase: 'DevEnv', schema: DEVENV_SCHEMA, agentType: 'devenv-auditor', effort: 'high' });
  if (!res) { skipped.push({ target: `devenv repo:${repoLabel(r)}`, reason: 'devenv-auditor returned no schema-valid result' }); return null; }
  noteSession(res);
  skipped.push(...(res.skipped || []).map((s) => ({ target: `devenv repo:${repoLabel(r)}: ${s.target}`, reason: s.reason })));
  res.target = { type: 'repo', appId: r.appId, repoId: r.repoId };
  const envs = devEnvsFor(r.appId);
  res.findings = res.findings.map((f) => {
    const target = repairTarget(f.target, r, envs);
    if (!target) log(`devenv ${repoLabel(r)}: finding "${f.ruleId}" target ${JSON.stringify(f.target || null)} lacked recoverable ids; using ${targetKey(res.target)}`);
    return { ...f, target: target || res.target };
  });
  res.observations = res.observations.map((o) => { const subject = repairTarget(o.subject, r, envs); const { subject: _drop, ...rest } = o; return subject ? { ...rest, subject } : rest; });
  if (!ownsEnvs(r)) {
    const before = res.findings.length;
    res.findings = res.findings.filter((f) => f.target.type !== 'environment');
    res.observations = res.observations.filter((o) => !o.subject || o.subject.type !== 'environment');
    if (before !== res.findings.length) log(`devenv ${repoLabel(r)}: dropped ${before - res.findings.length} environment findings (audited by ${envOwner.get(r.appId)})`);
  }
  acceptSarif(res, devSarifName(r), `devenv repo:${repoLabel(r)}`);
  return applyDryRun(res, r);
};
const devRefuteStage = async (res, r) => {
  if (!res || !res.findings.length) return res;
  const { kept, rejected } = await refuteFindings('dev-environment gap', 'DevEnv', r, res.findings, () => DEVENV_LENSES, `Dev-tier environment records: ${JSON.stringify(devEnvsFor(r.appId))}. Policy digest: ${scout.policySummary}`);
  return { ...res, findings: kept, refuted: rejected };
};
const devAudited = (await pipeline(devTargets, devAuditStage, devRefuteStage)).filter(Boolean);
const devDuplicates = dedupResults(devAudited, 'devenv');
const devWritten = await ledgerWrite(devAudited, { phaseName: 'DevEnv', methods: [WORKFLOW, 'probe-dev-env'], tagPrefix: 'dev-env', agentName: 'devenv-auditor' });
const devRefuted = devAudited.reduce((n, r) => n + ((r.refuted && r.refuted.length) || 0), 0);
log(`DevEnv: ${devWritten.controls} controls, ${devWritten.observationIds.length} observations, ${devWritten.findingIds.length} findings (${devRefuted} refuted, ${devDuplicates} duplicates dropped)`);

// ========== Report (version diff, then summary) ==========
phase('Report');
const observationIds = [...scrWritten.observationIds, ...sdlcWritten.observationIds, ...devWritten.observationIds];
const findingIds = [...scrWritten.findingIds, ...sdlcWritten.findingIds, ...devWritten.findingIds];
const controlsAppended = scrWritten.controls + sdlcWritten.controls + devWritten.controls;
const reseenIds = [...scrWritten.supersededFindingIds, ...sdlcWritten.supersededFindingIds, ...devWritten.supersededFindingIds];
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
  report = await agent(`You are the report-writer for company "${companyId}", called by workflow "${WORKFLOW}". Read .claude/skills/report-templates/SKILL.md and .claude/skills/maxwell-conventions/SKILL.md first. Requested sections: ["open-findings", "control-summary"].
Regenerate those two sections of ${profile}/summary.md from ${profile}/soc/main.jsonl using the report-templates layouts ("## Open findings": latest record per finding id, status open | triaged | remediating, grouped by severity with title, target, primary regulatoryRef, slaDueAt with SLA status and [fnd_...] citation; "## Control summary": control implementation and latest observation result per control with the coverage paragraph). This run appended ${scrWritten.findingIds.length} secure-code-review findings ${JSON.stringify(scrWritten.findingIds)}, ${sdlcWritten.findingIds.length} SDLC gaps ${JSON.stringify(sdlcWritten.findingIds)} and ${devWritten.findingIds.length} developer-environment gaps ${JSON.stringify(devWritten.findingIds)}; ${reseenIds.length} findings were re-seen ${JSON.stringify(reseenIds)}; observations ${JSON.stringify(observationIds)}. Check every one of these ids is reflected.
Follow your section-ownership table: when it has no row for "${WORKFLOW}" or the row does not include a requested section, do not edit that section, list it in sectionsSkipped with the reason, and still return the counts you computed from the ledger. For sections you do write: keep every other section byte-for-byte, keep frontmatter sections[] in document order, bump version minor and recompute provenance.inputsHash exactly as the company-summary schema description prescribes. ${provenanceNote('report-writer')}${runNow ? '' : ' Your tools cannot read the clock: use the latest recordedAt among this run\'s records in the ledger as generatedAt.'}
Run \`node .claude/scripts/validate-data.mjs ${profile}/summary.md\` after any edit and fix anything it rejects. Return sectionsUpdated, sectionsSkipped, openFindings (count of open, triaged and remediating findings in the ledger), observations (count of observations from this run you could read back) and the new version.`, { label: 'report', phase: 'Report', schema: REPORT_SCHEMA, agentType: 'report-writer', effort: 'medium' });
  if (!report) skipped.push({ target: `${profile}/summary.md`, reason: 'report-writer returned no schema-valid result; summary not updated' });
  else { noteSession(report); if (report.sectionsSkipped && report.sectionsSkipped.length) skipped.push({ target: `${profile}/summary.md`, reason: `report-writer skipped sections: ${report.sectionsSkipped.join(', ')}` }); }
}

if (skipped.length) log(`skipped (${skipped.length}): ${skipped.map((s) => `${s.target} — ${s.reason}`).join('; ')}`);

return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  targets: repos.map((r) => ({ target: targetKey(r), exposure: r.scope.exposure, asvsLevel: r.scope.level, chapters: r.scope.chapters, reviewed: Boolean(r.localCheckout) })),
  controls: controlsAppended,
  observations: observationIds.length,
  findings: findingIds.length,
  risks: 0,
  initiatives: 0,
  suggestions: 0,
  scr: { targets: reviewable.map(repoLabel), observations: scrWritten.observationIds.length, findings: scrWritten.findingIds.length, reseen: scrWritten.supersededFindingIds.length, refuted: scrRefuted, duplicatesDropped: scrDuplicates },
  sdlc: { targets: sdlcTargets.map(targetKey), observations: sdlcWritten.observationIds.length, findings: sdlcWritten.findingIds.length, reseen: sdlcWritten.supersededFindingIds.length, refuted: sdlcRefuted, duplicatesDropped: sdlcDuplicates },
  devEnv: { targets: devTargets.map(repoLabel), environments: devEnvironments.map((e) => `environment:${e.appId}/${e.envId}`), observations: devWritten.observationIds.length, findings: devWritten.findingIds.length, reseen: devWritten.supersededFindingIds.length, refuted: devRefuted, duplicatesDropped: devDuplicates },
  observationIds,
  findingIds,
  sarifExports: [...reviewed, ...sdlcAudited, ...devAudited].filter((r) => r.sarifPath).map((r) => r.sarifPath),
  versionFile,
  summary: report ? { sectionsUpdated: report.sectionsUpdated, sectionsSkipped: report.sectionsSkipped, version: report.version || null } : null,
  skipped,
  sessionIds: [...sessionIds],
};
