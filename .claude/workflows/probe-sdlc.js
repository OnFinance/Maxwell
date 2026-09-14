// probe-sdlc — compares company-profile/<companyId>/sdlc/policy.json with the evidence in every repo record
// (applications/*/repos/*.json) and local checkout, records one observation per NIST SSDF 1.1 practice that
// could be assessed and one finding per gap, adversarially refutes the findings (the evidence lens vetoes at every
// severity; high and critical need unanimity), appends them to the soc ledger through
// node .claude/scripts/soc/append.mjs, versions the ledger with soc/version.mjs and updates summary.md.
// Rule ids come from the fixed SSDF_RULES table, kept word for word identical in execute-scr.js, so standalone and
// inline runs fingerprint to the same ledger findings.
// args: { companyId (required), appIds?: string[], envIds?: string[] (ignored here), dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
export const meta = {
  name: 'probe-sdlc',
  description: 'Compare sdlc/policy.json with repo evidence: one observation per NIST SSDF practice, a finding per gap, refuted and ledgered. args: companyId, appIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Scout', detail: 'List repos and summarise the SDLC policy from the workspace files' },
    { title: 'Audit', detail: 'sdlc-auditor compares the policy with each repo and with company-wide practices' },
    { title: 'Refute', detail: 'Three refuter lenses per finding: evidence (veto), correctness (policy reading), regulatory-mapping; high and critical need unanimity' },
    { title: 'Ledger', detail: 'soc-ledger-keeper appends validated observations and findings, one target at a time' },
    { title: 'Report', detail: 'soc/version.mjs records the ledger diff; report-writer refreshes control-summary and open-findings in summary.md' },
  ],
};

const a = args || {};
const companyId = a.companyId;
if (typeof companyId !== 'string' || !companyId) throw new Error('probe-sdlc: args.companyId is required');
const WORKFLOW = 'probe-sdlc';
const dryRun = a.dryRun === true;
const appIds = Array.isArray(a.appIds) && a.appIds.length ? a.appIds : null;
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
const LENSES = ['evidence', 'correctness', 'regulatory-mapping'];
const VETO_LENS = 'evidence';

// NIST SSDF 1.1 practices (PW.3 was withdrawn in 1.1 and folded into PW.4).
const SSDF_PRACTICES = ['PO.1', 'PO.2', 'PO.3', 'PO.4', 'PO.5', 'PS.1', 'PS.2', 'PS.3', 'PW.1', 'PW.2', 'PW.4', 'PW.5', 'PW.6', 'PW.7', 'PW.8', 'PW.9', 'RV.1', 'RV.2', 'RV.3'];
// Fixed SDLC rule ids: ssdf-<SSDF 1.1 task lower-cased, dots as hyphens>-<check> (id, practice, scope, meaning).
// Keep word for word identical to SSDF_RULES in execute-scr.js: the ruleId is the first fingerprint input.
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

// ---------- shared prompt fragments ----------
const nowCommand = 'node -e "console.log((new Date).toISOString().slice(0,19)+\'Z\')"';
const timeNote = () => (runNow
  ? `Use "${runNow}" for every timestamp you write (recordedAt, generatedAt, collectedAt, firstSeenAt, lastSeenAt, expiresAt base).`
  : `No run timestamp was supplied. Never run date. If your tools allow \`node -e\`, run \`${nowCommand}\` once and reuse that value for every timestamp you write, and return it as "now"; otherwise omit optional timestamps such as evidence collectedAt.`);
const provenanceNote = (agentName) => `Provenance on every record: harness "claude-code" (or "opencode" when MAXWELL_HARNESS=opencode), workflow "${WORKFLOW}", agent "${agentName}", sessionId ${sessionId ? `"${sessionId}"` : 'the session id your harness reports (never invent one)'}, runId ${runId ? `"${runId}"` : 'the MAXWELL_RUN_ID environment variable when set, otherwise omit runId'}. ${timeNote()}`;
const dryNote = dryRun
  ? 'DRY RUN: do not run any tool against a repository or system and do not write any file. Plan what you would examine, list the evidence you would need, and describe each intended check. Every observation you return must have result "inconclusive" and a description starting with "dry-run: evidence requested — ". Return no findings and omit sarifPath.'
  : '';
const readOnlyNote = 'Read-only: never modify a repository, never run a build, install, fetch, push or network call, never print secret values (report a committed secret by file name and line only). Return data, not prose.';
const evidenceNote = 'Evidence items carry type, ref, optional sha256, optional collectedAt and an optional description of at most 200 characters (for example "lines 18-27 at <sha>" or "23 of 412 commits without PR reference"); no other keys. Quote the command or file you relied on in ref or description so a refuter can re-check it.';
const practiceTag = 'tags ["sdlc", "ssdf:<practice>"] where <practice> is lower-cased with dots replaced by "-" (tags must match ^[a-z0-9][a-z0-9:_-]{0,47}$, so PO.3 becomes "ssdf:po-3")';
if (Array.isArray(a.envIds) && a.envIds.length) log(`args.envIds (${a.envIds.join(', ')}) ignored: probe-sdlc audits repos and the policy, not environments`);
const appFilterNote = appIds ? `Only consider applications whose appId is one of: ${appIds.join(', ')}.` : 'Consider every application under applications/.';
const sarifNameFor = (t) => (t.type === 'company' ? `${WORKFLOW}.${companyId}.company.sarif.export.json` : `${WORKFLOW}.${t.appId}.${t.repoId}.sarif.export.json`);
const sarifPathHint = (t) => `kpis/data/raw/sessions/${sessionId || '<your harness session id>'}/${sarifNameFor(t)}`;

// ---------- schemas ----------
const SKIPPED_SCHEMA = { type: 'array', items: { type: 'object', required: ['target', 'reason'], properties: { target: { type: 'string' }, reason: { type: 'string' } } } };
const REG_REF_SCHEMA = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const EVIDENCE_SCHEMA = { type: 'object', required: ['type', 'ref'], properties: { type: { enum: ['workspace-file', 'url', 'command-output', 'screenshot', 'log-excerpt', 'ticket', 'pull-request', 'commit', 'sbom', 'sarif', 'ocsf'] }, ref: { type: 'string' }, sha256: { type: 'string' }, collectedAt: { type: 'string' }, description: { type: 'string', maxLength: 200 } } };
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['companyId', 'policyFound', 'policySummary', 'repos', 'skipped'],
  properties: {
    companyId: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    primaryInstruments: { type: 'array', items: { type: 'string' } },
    policyFound: { type: 'boolean' },
    policySummary: { type: 'string' },
    ssdfPracticesClaimed: { type: 'array', items: { type: 'object', required: ['practice', 'status'], properties: { practice: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } } } },
    repos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'repoId', 'recordPath'],
        properties: {
          appId: { type: 'string' }, repoId: { type: 'string' }, recordPath: { type: 'string' }, localCheckout: { type: 'string' },
          host: { type: 'string' }, ciSystem: { type: 'string' }, buildSystem: { type: 'string' }, exposure: { type: 'string' },
          containsAgentCode: { type: 'boolean' }, codeownersPresent: { type: 'boolean' }, branchProtectionSummary: { type: 'string' },
        },
      },
    },
    skipped: SKIPPED_SCHEMA,
    sessionId: { type: 'string' },
  },
};
const OBSERVATION_ITEM = { type: 'object', required: ['title', 'description', 'practice', 'result', 'regulatoryRefs', 'evidence'], properties: { title: { type: 'string' }, description: { type: 'string' }, practice: { enum: SSDF_PRACTICES }, area: { type: 'string' }, result: { enum: ['satisfied', 'not-satisfied', 'partial', 'not-applicable', 'inconclusive'] }, regulatoryRefs: { type: 'array', minItems: 1, items: REG_REF_SCHEMA }, evidence: { type: 'array', items: EVIDENCE_SCHEMA } } };
const FINDING_ITEM = { type: 'object', required: ['title', 'description', 'severity', 'confidence', 'practice', 'ruleId', 'regulatoryRefs', 'evidence'], properties: { title: { type: 'string' }, description: { type: 'string' }, severity: { enum: SEVERITY_ORDER }, confidence: { enum: CONFIDENCE }, practice: { enum: SSDF_PRACTICES }, area: { type: 'string' }, ruleId: { enum: SSDF_RULES.map((r) => r[0]) }, cweId: { type: 'string' }, location: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } } }, impact: { type: 'string' }, remediation: { type: 'string' }, regulatoryRefs: { type: 'array', minItems: 1, items: REG_REF_SCHEMA }, evidence: { type: 'array', items: EVIDENCE_SCHEMA } } };
const AUDIT_SCHEMA = { type: 'object', required: ['target', 'observations', 'findings', 'skipped'], properties: { target: { type: 'object', required: ['type'], properties: { type: { enum: ['repo', 'company'] }, appId: { type: 'string' }, repoId: { type: 'string' } } }, observations: { type: 'array', items: OBSERVATION_ITEM }, findings: { type: 'array', items: FINDING_ITEM }, sarifPath: { type: 'string' }, sarifSha256: { type: 'string' }, skipped: SKIPPED_SCHEMA, sessionId: { type: 'string' } } };
const REFUTE_SCHEMA = { type: 'object', required: ['refuted', 'reason'], properties: { refuted: { type: 'boolean' }, confidence: { type: 'number' }, lens: { type: 'string' }, reason: { type: 'string' }, corrections: { type: 'array', items: { type: 'object', required: ['path', 'why'], properties: { path: { type: 'string' }, current: {}, proposed: {}, why: { type: 'string' } } } }, checked: { type: 'array', items: { type: 'string' } }, unverifiable: { type: 'array', items: { type: 'string' } }, sessionId: { type: 'string' } } };
const LEDGER_SCHEMA = { type: 'object', required: ['controlsAppended', 'observationsAppended', 'findingsAppended', 'observationIds', 'findingIds', 'supersededFindingIds', 'skipped'], properties: { controlsAppended: { type: 'integer' }, observationsAppended: { type: 'integer' }, findingsAppended: { type: 'integer' }, observationIds: { type: 'array', items: { type: 'string' } }, findingIds: { type: 'array', items: { type: 'string' } }, supersededFindingIds: { type: 'array', items: { type: 'string' } }, now: { type: 'string' }, skipped: SKIPPED_SCHEMA, sessionId: { type: 'string' } } };
const VERSION_SCHEMA = { type: 'object', required: ['written'], properties: { written: { type: 'string' }, error: { type: 'string' }, sessionId: { type: 'string' } } };
const REPORT_SCHEMA = { type: 'object', required: ['sectionsUpdated', 'sectionsSkipped', 'openFindings'], properties: { sectionsUpdated: { type: 'array', items: { type: 'string' } }, sectionsSkipped: { type: 'array', items: { type: 'string' } }, openFindings: { type: 'integer' }, observations: { type: 'integer' }, version: { type: 'string' }, sessionId: { type: 'string' } } };

// ---------- helpers ----------
// Same key as the ledger fingerprint input (soc-ledger section 6) and as execute-scr's inline SDLC step.
const normalisePath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
const targetKey = (t) => (t.type === 'company' ? `company:${companyId}` : `repo:${t.appId}/${t.repoId}`);
const findingKey = (t, f) => `${f.ruleId}|${targetKey(t)}|${normalisePath(f.location && f.location.path)}`;
const lowerSeverity = (x, y) => (SEVERITY_ORDER.indexOf(x) <= SEVERITY_ORDER.indexOf(y) ? x : y);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };
const noteNow = (r) => { if (!runNow && r && typeof r.now === 'string' && TIMESTAMP_RE.test(r.now)) runNow = r.now; };
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// Refutation verdict: evidence vetoes at every severity; high and critical need every lens to answer and none to
// refute; otherwise a majority of answering lenses decides. Missing verdicts are counted apart from refutations, and
// a candidate nobody could judge goes to skipped. An upward severity correction is accepted only from the
// regulatory-mapping lens when it cites the catalog defaultSeverity.
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
const correctionFor = (v, pointer) => { const c = (v && Array.isArray(v.corrections) ? v.corrections : []).find((x) => x && x.path === pointer); return c || undefined; };
const correctSeverity = (f, lenses, votes) => {
  let severity = f.severity;
  const i = lenses.indexOf('regulatory-mapping');
  const rm = i >= 0 && votes[i] && !votes[i].refuted ? correctionFor(votes[i], '/severity') : undefined;
  if (rm && SEVERITY_ORDER.includes(rm.proposed) && (SEVERITY_ORDER.indexOf(rm.proposed) < SEVERITY_ORDER.indexOf(severity) || /defaultSeverity/i.test(String(rm.why)))) severity = rm.proposed;
  votes.forEach((v, j) => {
    if (!v || v.refuted || j === i) return;
    const c = correctionFor(v, '/severity'); if (c && SEVERITY_ORDER.includes(c.proposed)) severity = lowerSeverity(severity, c.proposed);
  });
  return severity;
};

// ---------- Scout ----------
phase('Scout');
const scout = await agent(`Scout company "${companyId}" for an SDLC policy probe. ${appFilterNote}
Read .claude/skills/maxwell-conventions/SKILL.md first. Then read ${profile}/details.json (entityTypes, regulators), ${profile}/sdlc/policy.json (if absent set policyFound=false and say so in policySummary) and every applications/*/repos/*.json record.
For each repo return appId, repoId, recordPath (the workspace path of the record), localCheckout (from the record; omit when the directory does not exist on disk), host, ciSystem, buildSystem, containsAgentCode, codeownersPresent, a one-line branchProtectionSummary, and exposure = the highest exposure of that application's environments in applications/<appId>/env/*.json (internet > partner > internal > isolated; "unknown" when no env file exists).
policySummary: a compact plain-text digest of branching, codeReview, ciGates (gate/tool/blocking/threshold), releaseProcess, secretsManagement, dependencyPolicy and aiCodingPolicy so an auditor can compare without re-reading. ssdfPracticesClaimed: the policy's ssdfMapping entries verbatim.
primaryInstruments: the vocab instrument ids that apply to the entityTypes (SEBI CSCRF 2024 for SEBI-regulated entities, RBI Cyber and Technology Directions 2026 for RBI-regulated ones, IRDAI 2023 for insurers, CERT-In 2022 and DPDP Rules 2025 for all, then nist-ssdf-800-218).
List in skipped every application with no repo record and every repo excluded by the filter, with a reason. Read-only; return data only.`, { label: 'scout', phase: 'Scout', schema: SCOUT_SCHEMA, agentType: 'ctx-researcher', effort: 'medium' });
if (!scout) throw new Error('probe-sdlc: scout returned nothing');
noteSession(scout);
skipped.push(...(scout.skipped || []));
if (!scout.policyFound) log(`${profile}/sdlc/policy.json is missing or unreadable; the company-level audit will record that as a gap`);
const scoutRepos = scout.repos || [];
const repos = scoutRepos.filter((r) => !appIds || appIds.includes(r.appId));
for (const r of scoutRepos.filter((r) => appIds && !appIds.includes(r.appId))) skipped.push({ target: `repo:${r.appId}/${r.repoId}`, reason: `excluded by args.appIds (${appIds.join(', ')})` });
const targets = [{ type: 'company' }, ...repos.map((r) => ({ ...r, type: 'repo' }))];
log(`Scout: ${repos.length} repos + 1 company-level target; ${skipped.length} skipped`);

// ---------- Audit + Refute (per target, no barrier between stages) ----------
const auditPrompt = (t) => {
  const common = `You are the sdlc-auditor for company "${companyId}" (entity types: ${(scout.entityTypes || []).join(', ') || 'unknown'}; primary instruments: ${(scout.primaryInstruments || []).join(', ') || 'unknown'}).
Read .claude/skills/maxwell-conventions/SKILL.md, .claude/skills/soc-ledger/SKILL.md (record shapes only — you do not write to the ledger), .claude/skills/sarif-findings/SKILL.md, .claude/skills/regulatory-catalogs/SKILL.md and its references (instruments.json, catalogs/*.catalog.json, sla-table.json) so every regulatoryRef cites a real control id and every severity comes from the catalog control defaultSeverity, never from intuition.
The policy under test is ${profile}/sdlc/policy.json (policyFound=${scout.policyFound}). Digest: ${scout.policySummary}
Claimed SSDF mapping: ${JSON.stringify(scout.ssdfPracticesClaimed || [])}
${readOnlyNote} ${evidenceNote} ${dryNote}
${dryRun ? '' : `SARIF: write your hand-authored SARIF 2.1.0 log (driver maxwell-sdlc-auditor) to ${sarifPathHint(t)}${sessionId ? '' : ' (the <sid> segment is your own harness session id; return it as sessionId)'}, never overwrite an existing export, and return sarifPath and its sha256 as sarifSha256. If you write no log, omit both.`}
Return one observation per NIST SSDF 1.1 practice you could assess (practice and area = one of ${SSDF_PRACTICES.join(', ')}; PW.3 was withdrawn in SSDF 1.1 and folded into PW.4; result satisfied | partial | not-satisfied | not-applicable | inconclusive) with the evidence you actually looked at (workspace-file refs to repo records, CI files, CODEOWNERS, lockfiles, SBOMs), and one finding per gap where observed behaviour falls short of the policy or of the regulator baseline.
${ssdfRulesNote(t.type)}
Before choosing a ruleId, grep ${profile}/soc/main.jsonl for findings whose target is ${targetKey(t)}: when one has the same location path and its source.ruleId is in the table, reuse that exact ruleId and path so the ledger supersedes instead of duplicating.
Each finding needs: ruleId from the table, practice and area = the practice in the table row, severity and confidence, regulatoryRefs (at least one) with the most specific Indian instrument first and nist-ssdf-800-218 <task> second, a location (path relative to the repo root such as .github/workflows/ci.yml with line numbers when the gap is in a checked-out file; for gaps in a workspace record use the record path relative to the workspace root such as applications/<app>/repos/<repo>.json), impact, remediation and evidence. Do not report the same gap twice under two practices.`;
  if (t.type === 'company') {
    return `${common}
Target: the company as a whole (target.type "company"). Assess policy-level practices across the ${targets.length - 1} repos listed by the scout: PO.1 (security requirements defined, policy owner, effectiveFrom age versus reviewCadenceMonths), PO.2 (roles: owner, codeowners), PO.3 (toolchain: are the ciGates in the policy actually present in at least one CI config, are tools pinned), PO.4 (criteria: blocking gates and minSeverityToBlock, vulnerabilitySlaDays versus the sla-table), PO.5 (release approvals and environment separation: releaseProcess.environmentsOrder, approvalsRequired, deployment windows outside NSE/BSE market hours, emergency change handling), PS.1 (secrets and code protection: secretsManagement backend versus how CI holds secrets), PS.2 and PS.3 (release integrity, signing, archiving and SBOM policy), RV.1 and RV.2 (disclosure route, audit and remediation loop) and the completeness of ssdfMapping (claimed implemented practices with no evidence anywhere are findings). A missing or invalid policy.json is a high-severity company finding (ruleId ssdf-po-1-1-policy-missing-or-invalid, location ${profile}/sdlc/policy.json).
Repos in scope: ${JSON.stringify(repos.map((r) => ({ appId: r.appId, repoId: r.repoId, recordPath: r.recordPath, localCheckout: r.localCheckout || null })))}`;
  }
  return `${common}
Target: repo "${t.repoId}" of application "${t.appId}" (target.type "repo"; record ${t.recordPath}; localCheckout ${t.localCheckout || 'none — limit yourself to the record and the application README'}; host ${t.host || 'unknown'}; ciSystem ${t.ciSystem || 'unknown'}; buildSystem ${t.buildSystem || 'unknown'}; exposure ${t.exposure || 'unknown'}; containsAgentCode ${t.containsAgentCode === true}; codeownersPresent ${t.codeownersPresent === true}; branch protection: ${t.branchProtectionSummary || 'not recorded'}).
Compare, clause by clause:
- branching.protectedBranches and signedCommitsRequired against branchProtection.required, minApprovers, requireSignedCommits, requireLinearHistory, enforceAdmins (PS.1, PS.2);
- codeReview.minApprovers, codeownersEnforced, selfApprovalAllowed, aiReviewAllowed against branchProtection.minApprovers, requireCodeOwnerReviews, dismissStaleReviews, codeownersPresent and the CODEOWNERS file (PW.7);
- every ciGates entry against branchProtection.statusChecks and the CI configuration in the checkout (.github/workflows/*.yml, .gitlab-ci.yml, Jenkinsfile, azure-pipelines.yml, .circleci/config.yml, bitbucket-pipelines.yml): gate present, same tool, blocking, threshold honoured (PW.8 for test gates, RV.1 for security gates; exact action and image pinning belongs to probe-cicd-env);
- releaseProcess against deployment jobs, environment protection rules, approvals, deployment windows and rollback jobs (PO.5 for approvals, environment separation and rollback; PS.2 and PS.3 for release signing, tagging and artefact retention);
- secretsManagement against how CI and deployment jobs obtain secrets (PS.1, PO.5; committed .env or key files and local secrets hooks belong to probe-dev-env, report file names only);
- dependencyPolicy against lockfiles for every packageManifests entry, registry configuration (.npmrc, pip.conf, settings.xml, .yarnrc.yml) versus allowedRegistries and dependency update automation (PW.4), an SBOM step and applications/${t.appId}/images/*.cdx.json (PS.3), scanner thresholds versus vulnerabilitySlaDays (RV.1);
- aiCodingPolicy against the review gates for AI-authored changes and agent code (${t.containsAgentCode === true ? 'this repo contains agent code' : 'no agent code recorded'}) without the promptInjectionControls named in the policy (PW.1, PW.7; harness configuration files themselves belong to probe-dev-env);
- production configuration defaults shipped by the repo (PW.9) and design or threat-model records for exposed repos (PW.2);
- ssdfMapping claims against what this repo actually shows.`;
};

const auditStage = async (t) => {
  const r = await agent(auditPrompt(t), { label: `audit ${t.type === 'company' ? 'company' : `${t.appId}/${t.repoId}`}`, phase: 'Audit', schema: AUDIT_SCHEMA, agentType: 'sdlc-auditor', effort: 'high' });
  if (!r) { skipped.push({ target: targetKey(t), reason: 'sdlc-auditor returned no schema-valid result' }); return null; }
  noteSession(r);
  skipped.push(...(r.skipped || []).map((s) => ({ target: `${targetKey(t)}: ${s.target}`, reason: s.reason })));
  // Findings always belong to the audit target; the auditor's own target echo is never trusted for ids.
  r.target = t.type === 'repo' ? { type: 'repo', appId: t.appId, repoId: t.repoId } : { type: 'company' };
  acceptSarif(r, t);
  if (dryRun) {
    if (r.findings.length) log(`dry-run: dropped ${r.findings.length} candidate findings for ${targetKey(t)} (only inconclusive observations are written)`);
    r.findings = [];
    delete r.sarifPath; delete r.sarifSha256;
    r.observations = r.observations.map((o) => ({ ...o, result: 'inconclusive', description: o.description.startsWith('dry-run:') ? o.description : `dry-run: evidence requested — ${o.description}` }));
  }
  return r;
};

const refutePrompt = (t, f, lens) => `Refute one candidate. lens: "${lens}". context: {"companyId":"${companyId}","workflow":"${WORKFLOW}"${sessionId ? `,"sessionId":"${sessionId}"` : ''}${runId ? `,"runId":"${runId}"` : ''},"target":"${targetKey(t)}"}. Candidate kind: SDLC policy gap.
candidate: ${JSON.stringify(f)}
This is a pre-ledger candidate: id, fingerprint, provenance, target, controlIds, slaBasis, slaDueAt, firstSeenAt and lastSeenAt are added by the soc-ledger-keeper after you, so their absence never refutes; practice, ruleId, impact and remediation are data to verify. Location paths are relative to the repo root${t.type === 'repo' && t.localCheckout ? ` (checkout at ${t.localCheckout})` : ''} unless they start with applications/ or company-profile/. Evidence descriptions (line ranges, counts, command lines) are part of the claim.
The policy under test is ${profile}/sdlc/policy.json. Lens guidance for this workflow — evidence: the cited file, record or line really shows the gap and nothing in the repo already compensates. correctness: the facts in title and description match the files, the ruleId's meaning fits the gap, and the policy clause really requires what the candidate says (a stricter-than-policy expectation is not a gap unless the regulator baseline demands it). regulatory-mapping: the cited control applies to this company's entity types, the most specific Indian instrument is first, the nist-ssdf-800-218 task belongs to the practice (SSDF 1.1 has no PW.3), and severity equals the catalog defaultSeverity; when it does not, propose the catalog value with a "/severity" correction whose why names the catalog defaultSeverity (upward corrections are accepted only from this lens and only on that basis).
Return your standard output contract. Use corrections with path "/severity" or "/confidence" when the value should change.`;

const refuteStage = async (r, t) => {
  if (!r || !r.findings.length) return r;
  const kept = []; const rejected = []; let unavailable = 0;
  await pipeline(r.findings, async (f, item, fi) => {
    const tag = `refute ${targetKey(t)} #${fi + 1}`;
    const votes = await parallel(LENSES.map((lens) => () => agent(refutePrompt(t, f, lens), { label: `refute ${lens} ${targetKey(t)} #${fi + 1}`, phase: 'Refute', schema: REFUTE_SCHEMA, agentType: 'refuter', effort: 'high' })));
    votes.forEach(noteSession);
    const d = decide(f, LENSES, votes);
    if (d.unavailable) log(`${tag}: ${d.unavailable} lens(es) returned nothing (counted as unavailable, not as refuted)`);
    if (d.outcome === 'unavailable') { unavailable += 1; skipped.push({ target: `${targetKey(t)} ${f.ruleId}`, reason: `${d.reason}; candidate "${f.title}" not ledgered, re-run to verify` }); return null; }
    if (d.outcome === 'rejected') { rejected.push({ title: f.title, ruleId: f.ruleId, refutedCount: d.refutedCount, reason: d.reason, reasons: votes.map((v, i) => (v ? `${v.lens || LENSES[i]}: ${v.reason}` : `${LENSES[i]}: unavailable`)) }); return null; }
    const severity = correctSeverity(f, LENSES, votes);
    let confidence = f.confidence;
    for (const v of votes) {
      if (!v || v.refuted) continue;
      const conf = correctionFor(v, '/confidence'); if (conf && CONFIDENCE.includes(conf.proposed)) confidence = conf.proposed;
    }
    if (severity !== f.severity) log(`${tag}: severity corrected ${f.severity} -> ${severity}`);
    if (d.split) { confidence = 'possible'; log(`${tag}: split vote (${d.refutedCount}/${LENSES.length} refuted); kept with confidence "possible"`); }
    if (SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(f.severity) && (severity === 'high' || severity === 'critical') && d.refutedCount) { confidence = 'possible'; log(`${tag}: raised to ${severity} after a split vote; kept with confidence "possible" for triage`); }
    kept.push({ ...f, severity, confidence, refutation: { lenses: LENSES, refutedCount: d.refutedCount, unavailable: d.unavailable, unanimityRequired: d.unanimityRequired } });
    return null;
  });
  if (rejected.length) log(`${targetKey(t)}: ${rejected.length} of ${r.findings.length} candidate findings refuted`);
  const lost = r.findings.length - kept.length - rejected.length - unavailable;
  if (lost > 0) skipped.push({ target: targetKey(t), reason: `${lost} candidate(s) lost to refute-stage errors; not ledgered` });
  return { ...r, findings: kept, refuted: rejected };
};

phase('Audit');
const audited = (await pipeline(targets, auditStage, refuteStage)).filter(Boolean);

// Dedup across targets (the awaited pipeline is the barrier): the same gap must not be ledgered twice.
const seen = new Set(); let duplicates = 0;
for (const r of audited) {
  r.findings = r.findings.filter((f) => { const k = findingKey(r.target, f); if (seen.has(k)) { duplicates += 1; return false; } seen.add(k); return true; });
}
if (duplicates) log(`dedup: dropped ${duplicates} duplicate findings across targets`);
const totalObs = audited.reduce((n, r) => n + r.observations.length, 0);
const totalFnd = audited.reduce((n, r) => n + r.findings.length, 0);
log(`Audit complete: ${totalObs} observations, ${totalFnd} findings after refutation`);

// ---------- Ledger (sequential so recordedAt stays monotonic within main.jsonl) ----------
phase('Ledger');
const observationIds = []; const findingIds = []; const supersededFindingIds = []; let controlsAppended = 0;
for (const r of audited) {
  if (!r.observations.length && !r.findings.length) { log(`${targetKey(r.target)}: nothing to ledger`); continue; }
  const sarifEvidence = r.sarifPath ? `{"type":"sarif","ref":"${r.sarifPath}"${r.sarifSha256 ? `,"sha256":"${r.sarifSha256}"` : ''}}` : '';
  const sourceRule = r.sarifPath
    ? `{"kind":"sarif","ruleId":"<ruleId>","tool":"maxwell-sdlc-auditor","toolVersion":"1.0.0"} (the results are in the hand-authored SARIF export ${r.sarifPath})`
    : '{"kind":"agent-analysis","ruleId":"<ruleId>","tool":"sdlc-auditor"} (no SARIF log exists for this target)';
  const w = await agent(`You are the soc-ledger-keeper for company "${companyId}". Read .claude/skills/soc-ledger/SKILL.md, .claude/skills/maxwell-conventions/SKILL.md and .claude/skills/regulatory-catalogs/SKILL.md (with references/sla-table.json) before writing. Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (record JSON on stdin); never edit ${profile}/soc/main.jsonl directly. ${provenanceNote('soc-ledger-keeper')}
Target: ${JSON.stringify(r.target)}. Candidate records from the sdlc-auditor (already refuted): ${JSON.stringify({ observations: r.observations, findings: r.findings, sarifPath: r.sarifPath || null, sarifSha256: r.sarifSha256 || null })}
Rules:
1. Observations: kind "observation", id a fresh obs_ ULID (mint ids the way the soc-ledger skill describes), methods ["${WORKFLOW}"], subjects [${r.target.type === 'company' ? '{"type":"company"}' : `{"type":"repo","appId":"${r.target.appId}","repoId":"${r.target.repoId}"}`}], result as given, collectedAt = now, expiresAt = now + 30 days, evidence as given${sarifEvidence ? ` plus ${sarifEvidence}, toolOutput {"format":"sarif","path":"${r.sarifPath}"${r.sarifSha256 ? `,"sha256":"${r.sarifSha256}"` : ''}}` : ''}, ${practiceTag}. controlIds must hold at least one "<instrument>:<controlId>" built from the candidate's regulatoryRefs; if that control record does not yet exist in the ledger, first append a control record for it (kind "control", id "<instrument>:<controlId>", frameworkRefs [the ref itself, then the catalog mappings], title and category from the catalog entry, implementationStatus "unknown", effectiveness "not-tested", applicableAssets = the subject; skip a regulatoryRef whose control id does not exist in the catalogs and say so in skipped) and count it in controlsAppended.
2. Findings: kind "finding", target = the subject above, source ${sourceRule}, severity and confidence as given, regulatoryRefs as given (most specific Indian instrument first), controlIds built from them, location as given (never an absolute path), description = candidate description plus impact and remediation, status "open", firstSeenAt/lastSeenAt = now, slaBasis and slaDueAt from references/sla-table.json following the soc-ledger skill section 6 (company-override uses ${profile}/sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays when present; slaDueAt = firstSeenAt + days), fingerprint = sha256 hex over "<ruleId>|<targetKey>|<normalisedLocation>" exactly as the soc-ledger skill section 6 defines (targetKey such as company:<companyId> or repo:<appId>/<repoId>; location path with leading ./ removed and no line numbers; empty when there is no location), computed with the \`node -e\` one-liner shown in soc-ledger section 6 (printf and sha256sum are not in your tools), relatedObservationIds = the ids of the observations you just appended for the same practice, evidence as given${sarifEvidence ? ` plus ${sarifEvidence}` : ''}, ${practiceTag}. ${evidenceNote} Drop candidate keys the record schema does not have (practice, area, ruleId, impact, remediation, refutation) after mapping them as described. Before appending, grep ${profile}/soc/main.jsonl for the fingerprint: when a finding with the same fingerprint exists and its latest record is open, triaged or remediating, append a superseding record with the SAME id, "supersedes" set to that id, the original firstSeenAt preserved and lastSeenAt = now, and list the id in supersededFindingIds; when it is resolved, reopen it (status "open", statusReason "regressed in run ${runId || WORKFLOW}", no resolvedAt) as the skill section 8 prescribes; when false-positive, duplicate or an unexpired risk-accepted, only refresh lastSeenAt; otherwise mint a fresh fnd_ ULID.
3. Append controls first, then observations, then findings. After all appends run \`node .claude/scripts/validate-data.mjs ${profile}/soc/main.jsonl\` and fix any record the validator rejects by appending a corrected record (never rewrite lines). A candidate you could not ledger goes into skipped with the validator message.
Return the counts, the ids you appended and the timestamp you used as now.`, { label: `ledger ${targetKey(r.target)}`, phase: 'Ledger', schema: LEDGER_SCHEMA, agentType: 'soc-ledger-keeper', effort: 'medium' });
  if (!w) { skipped.push({ target: targetKey(r.target), reason: 'soc-ledger-keeper returned no schema-valid result; records not written' }); continue; }
  noteSession(w); noteNow(w);
  controlsAppended += w.controlsAppended; observationIds.push(...w.observationIds); findingIds.push(...w.findingIds); supersededFindingIds.push(...(w.supersededFindingIds || []));
  skipped.push(...(w.skipped || []).map((s) => ({ target: `ledger ${targetKey(r.target)}: ${s.target}`, reason: s.reason })));
}
log(`Ledger: ${controlsAppended} controls, ${observationIds.length} observations, ${findingIds.length} findings appended (${supersededFindingIds.length} re-seen)`);

// ---------- Report (version diff, then summary) ----------
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
Regenerate those two sections of ${profile}/summary.md from ${profile}/soc/main.jsonl using the report-templates layouts ("## Control summary": control implementation and latest observation result per control with the coverage paragraph; "## Open findings": latest record per finding id, status open | triaged | remediating, grouped by severity with title, target, primary regulatoryRef, slaDueAt with SLA status and [fnd_...] citation). This run appended SDLC observations ${JSON.stringify(observationIds)} and SDLC gap findings ${JSON.stringify(findingIds)}; ${supersededFindingIds.length} findings were re-seen ${JSON.stringify(supersededFindingIds)}. Check every one of these ids is reflected.
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
  observations: observationIds.length,
  findings: findingIds.length,
  controls: controlsAppended,
  risks: 0,
  initiatives: 0,
  suggestions: 0,
  refuted: audited.reduce((n, r) => n + ((r.refuted && r.refuted.length) || 0), 0),
  duplicatesDropped: duplicates,
  observationIds,
  findingIds,
  reseen: supersededFindingIds.length,
  supersededFindingIds,
  sarifExports: audited.filter((r) => r.sarifPath).map((r) => r.sarifPath),
  versionFile,
  summary: report ? { sectionsUpdated: report.sectionsUpdated, sectionsSkipped: report.sectionsSkipped, version: report.version || null } : null,
  skipped,
  sessionIds: [...sessionIds],
};
