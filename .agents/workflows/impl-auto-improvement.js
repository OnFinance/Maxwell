// impl-auto-improvement: turns open ledger findings that point at a source location inside an application repo with
// a local checkout into minimal, reviewable unified diffs under company-profile/<companyId>/suggestions/, registers
// them in suggestions/master.json (proposed -> surfaced), links them to the findings on the ledger, re-checks open
// suggestions for merges and reverts (accepted -> merged, merged -> reverted) and runs the 30-day retention check.
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean, now?: RFC3339 'Z' string,
//         sessionId?: string, runId?: string }
// Shape: Scout (findings with location.path in repos whose checkout exists, minus findings with an open suggestion or a
// rejection the finding has not moved past; surfaced/accepted/merged suggestions to re-check; merged suggestions due a
// retention check) -> per-finding pipeline: fix-author stages a diff in a /tmp scratch tree with node -e (never in the
// checkout, never with Write/Edit) -> 3-lens refute (correctness, minimality, in-place; majority, unanimity for
// critical/high) -> Register (validator writes the .diff, fix-author re-proves apply --check, counts and sha256 on the
// written file, validator appends the proposed master.json entry only after that proof) -> Link (soc-ledger-keeper
// supersedes findings with suggestionIds and appends observations) -> Recheck (fix-author runs skill section 9 reverse
// and forward apply --check, log -S and merge-base --is-ancestor; validator records accepted -> merged and
// merged -> reverted) -> Retention (fix-author proves ancestry with merge-base --is-ancestor, refuter checks that every
// retained=false claim is internally consistent, validator records retentionCheckedAt/retained) -> Summary
// (report-writer rewrites the suggestions section) -> Surface (validator moves the listed entries proposed -> surfaced).
// Every ledger write goes through node .claude/scripts/soc/append.mjs; every file write is validated with
// node .claude/scripts/validate-data.mjs. dryRun: authoring and refutation run, nothing is written except one
// inconclusive observation describing the diffs that would have been proposed.
export const meta = {
  name: 'impl-auto-improvement',
  description: 'Drafts minimal unified diffs for open findings in checked-out repos, refutes and registers them, re-checks merges and reverts and the 30-day retention of merged ones.',
  phases: [
    { title: 'Scout', detail: 'Open findings with a source location in a repo that has a local checkout at its pinnedCommit, minus open or unaddressed-rejected suggestions; suggestions to re-check; merged suggestions due a retention check' },
    { title: 'Author', detail: 'fix-author stages one single-category diff per finding in a /tmp scratch tree with node -e per the diff-suggestions skill, hashes it, removes the scratch tree and proves the checkout is untouched' },
    { title: 'Refute', detail: 'refuter lenses correctness, minimality and in-place; majority survives, critical/high findings need all three' },
    { title: 'Register', detail: 'validator writes each surviving diff, fix-author re-proves apply --check, counts and sha256 on the written file, then validator appends a proposed entry to suggestions/master.json' },
    { title: 'Link', detail: 'soc-ledger-keeper supersedes each finding with the new suggestionId and appends proposal and checkout-state observations' },
    { title: 'Recheck', detail: 'fix-author runs skill section 9 reverse/forward apply --check, log -S and merge-base --is-ancestor on surfaced, accepted and merged suggestions; validator records accepted -> merged and merged -> reverted' },
    { title: 'Retention', detail: 'fix-author checks merged suggestions (mergedAt + 30 d) with merge-base --is-ancestor; refuter checks retained=false claims for internal consistency; validator records the result' },
    { title: 'Summary', detail: 'report-writer rewrites the suggestions section of summary.md and returns which suggestion ids it listed' },
    { title: 'Surface', detail: 'validator moves every listed proposed entry to surfaced with surfacedAt' },
  ],
};

const WORKFLOW = 'impl-auto-improvement';
const BASE_TAGS = ['auto-improvement', 'suggestion'];

const companyId = args && args.companyId;
if (!companyId) throw new Error('args.companyId is required (company-profile/<companyId>)');
const dryRun = Boolean(args && args.dryRun);
const now = (args && args.now) || null;
const sessionId = (args && args.sessionId) || null;
const runId = (args && args.runId) || null;
const appFilter = args && Array.isArray(args.appIds) && args.appIds.length ? args.appIds : null;
const envFilter = args && Array.isArray(args.envIds) && args.envIds.length ? args.envIds : null;

const PROFILE = 'company-profile/' + companyId;
const LEDGER = PROFILE + '/soc/main.jsonl';
const SUG_MASTER = PROFILE + '/suggestions/master.json';
const SKILL_DIFF = '.claude/skills/diff-suggestions/SKILL.md';
const SKILL_CONV = '.claude/skills/maxwell-conventions/SKILL.md';
const SKILL_LEDGER = '.claude/skills/soc-ledger/SKILL.md';
const SKILL_REG = '.claude/skills/regulatory-catalogs/SKILL.md';
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SCRATCH_PREFIX = '/tmp/maxwell-diff.';

const skipped = [];
const skip = (id, reason) => { skipped.push(id ? { id, reason } : { reason }); log('skipped ' + (id || '-') + ': ' + reason); };
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };

const CLOCK_CMD = 'node -e "console.log(new Date(performance.timeOrigin).toISOString().slice(0, 19) + \'Z\')"';
let runNow = now;
const timeRule = () => (runNow
  ? 'NOW = ' + runNow + '. Use it for createdAt, surfacedAt, retentionCheckedAt, updatedAt, recordedAt, collectedAt and provenance.generatedAt.'
  : 'NOW is unknown: take it once from ' + CLOCK_CMD + ' (or the latest timestamp a tool you have reports) and reuse that single RFC 3339 UTC value with trailing Z everywhere.');
const provenanceRule = (agentName) => 'Provenance on everything you write: harness (claude-code or opencode, whichever you run under), generatedAt = NOW, sessionId = '
  + (sessionId || 'your own harness session id') + ', ' + (runId ? 'runId = ' + runId : 'runId = MAXWELL_RUN_ID when set, otherwise omit it')
  + ', workflow = ' + WORKFLOW + ', agent = ' + agentName + '.';
const NEVER_TOUCH = 'Never write, edit, stage, commit, stash, checkout or clean anything inside applications/<app_id>/repos/<repo_id>/ (the gitignored checkout): it is read-only evidence pinned to pinnedCommit. Never write secret values.';
// fix-author may run node -e, git -C applications/* {rev-parse,status,log,show,ls-files,apply --check,merge-base --is-ancestor},
// mktemp -d /tmp/maxwell-diff.* and the section 5 awk. Shell variables do not survive between its Bash calls, the write
// guard blocks Write/Edit outside the workspace, and settings.json denies every rm -rf, so the recipes below use literal
// paths and node -e throughout.
const SHELL_RULES = 'Tool rules for this step: every Bash call is separate, so never use shell variables ($T, T=$(...)) or pipes/redirections; paste the literal absolute path mktemp printed into every later command. The Write and Edit tools CANNOT be used under /tmp (the write guard rejects every path outside the workspace), sed and heredocs are not in your tool list, and rm -rf is denied by .claude/settings.json: do all scratch file work with node -e. A node -e script may write only under the scratch directory, never in the workspace or the checkout.';

// ---- Output schemas -------------------------------------------------------------------------------------
const STR = { type: 'string' };
const STRS = { type: 'array', items: STR };
const REG_REF = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: STR, instrument: STR, controlId: STR } };
const REPO_REF = { type: 'object', required: ['appId', 'repoId'], properties: { appId: STR, repoId: STR, diffPath: STR, baseCommit: STR, mergeCommit: STR } };

const SCOUT_SCHEMA = {
  type: 'object',
  required: ['now', 'candidates', 'recheckDue', 'retentionDue', 'skipped'],
  properties: {
    sessionId: STR,
    now: STR,
    openFindingsTotal: { type: 'integer' },
    existingSuggestions: { type: 'integer' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['findingId', 'title', 'severity', 'appId', 'repoId', 'path', 'pinnedCommit', 'ledgerControlIds', 'regulatoryRefs'],
        properties: {
          findingId: STR, title: STR, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          appId: STR, repoId: STR, path: STR, startLine: { type: 'integer' }, endLine: { type: 'integer' },
          ruleId: STR, sourceKind: STR, sourceWorkflow: STR, pinnedCommit: STR, defaultBranch: STR,
          ledgerControlIds: STRS, regulatoryRefs: { type: 'array', items: REG_REF }, initiativeId: STR,
          cveIds: STRS, description: STR, latestRecordedAt: STR,
          priorRejections: { type: 'array', items: { type: 'object', required: ['suggestionId', 'decisionNote'], properties: { suggestionId: STR, decidedAt: STR, decisionNote: STR, title: STR, category: STR } } },
        },
      },
    },
    recheckDue: {
      type: 'array',
      items: { type: 'object', required: ['suggestionId', 'status', 'repos'], properties: { suggestionId: STR, status: { type: 'string', enum: ['surfaced', 'accepted', 'merged'] }, mergedAt: STR, findingIds: STRS, repos: { type: 'array', items: REPO_REF } } },
    },
    retentionDue: {
      type: 'array',
      items: {
        type: 'object',
        required: ['suggestionId', 'mergedAt', 'repos'],
        properties: {
          suggestionId: STR, mergedAt: STR, status: STR,
          repos: { type: 'array', items: { type: 'object', required: ['appId', 'repoId', 'mergeCommit'], properties: { appId: STR, repoId: STR, mergeCommit: STR, diffPath: STR } } },
        },
      },
    },
    skipped: { type: 'array', items: { type: 'object', required: ['reason'], properties: { id: STR, reason: STR } } },
  },
};

const AUTHOR_SCHEMA = {
  type: 'object',
  required: ['findingId', 'status', 'checkout', 'scratchRemoved', 'skipped'],
  properties: {
    sessionId: STR,
    model: STR,
    findingId: STR,
    status: { type: 'string', enum: ['drafted', 'not-fixable-by-diff', 'checkout-mismatch', 'checkout-dirty', 'already-fixed'] },
    reason: STR,
    checkout: { type: 'object', required: ['head', 'pinnedCommit', 'clean'], properties: { head: STR, pinnedCommit: STR, clean: { type: 'boolean' }, statusPorcelainLines: { type: 'integer' } } },
    scratchDir: STR,
    scratchRemoved: { type: 'boolean' },
    suggestion: {
      type: 'object',
      required: ['suggestionId', 'title', 'rationale', 'category', 'severity', 'appId', 'repoId', 'diffName', 'baseCommit', 'diffText', 'diffSha256', 'linesAdded', 'linesRemoved', 'filesChanged', 'filesTouched', 'applyCheckPassed', 'controlIds', 'regulatoryRefs'],
      properties: {
        suggestionId: { type: 'string', pattern: '^sug_[0-7][0-9A-HJKMNP-TV-Z]{25}$' },
        title: STR,
        rationale: STR,
        category: { type: 'string', enum: ['dependency-upgrade', 'config-hardening', 'iac-fix', 'cicd-gate', 'secret-removal', 'policy-document', 'test-added', 'logging-monitoring', 'access-control', 'encryption', 'network-policy', 'container-hardening', 'agent-guardrail', 'data-pipeline-control', 'other'] },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        appId: STR,
        repoId: STR,
        diffName: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]*\\.diff$' },
        baseCommit: STR,
        diffText: STR,
        diffSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        linesAdded: { type: 'integer' },
        linesRemoved: { type: 'integer' },
        filesChanged: { type: 'integer' },
        filesTouched: STRS,
        applyCheckPassed: { type: 'boolean' },
        controlIds: STRS,
        regulatoryRefs: { type: 'array', items: REG_REF },
        initiativeId: STR,
        addressesRejections: STRS,
      },
    },
    skipped: STRS,
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: {
    sessionId: STR,
    refuted: { type: 'boolean' },
    confidence: { type: 'number' },
    lens: STR,
    reason: STR,
    checked: STRS,
    unverifiable: STRS,
    correctedCategory: STR,
    correctedSeverity: STR,
    correctedRegulatoryRefs: { type: 'array', items: REG_REF },
    correctedControlIds: STRS,
  },
};

const DIFF_WRITE_SCHEMA = {
  type: 'object',
  required: ['diffPath', 'validationGreen', 'skipped'],
  properties: { sessionId: STR, diffPath: STR, validationGreen: { type: 'boolean' }, schemaIssues: STRS, skipped: STRS },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['diffPath', 'applyCheckPassed', 'linesAdded', 'linesRemoved', 'filesChanged', 'sha256', 'matches', 'reason'],
  properties: { sessionId: STR, diffPath: STR, absolutePath: STR, applyCheckPassed: { type: 'boolean' }, applyCheckExit: { type: 'integer' }, linesAdded: { type: 'integer' }, linesRemoved: { type: 'integer' }, filesChanged: { type: 'integer' }, sha256: STR, matches: { type: 'boolean' }, reason: STR },
};

const REGISTER_SCHEMA = {
  type: 'object',
  required: ['suggestionId', 'filesWritten', 'validationGreen', 'skipped'],
  properties: { sessionId: STR, suggestionId: STR, filesWritten: STRS, validationGreen: { type: 'boolean' }, schemaIssues: STRS, skipped: STRS },
};

const LINK_SCHEMA = {
  type: 'object',
  required: ['findingIds', 'observationIds', 'skipped'],
  properties: { sessionId: STR, findingIds: STRS, observationIds: STRS, skipped: STRS },
};

const RECHECK_SCHEMA = {
  type: 'object',
  required: ['suggestionId', 'state', 'repos', 'reason'],
  properties: {
    sessionId: STR,
    suggestionId: STR,
    state: { type: 'string', enum: ['merged', 'not-merged', 'reverted', 'still-present', 'moved-on', 'inconclusive'] },
    reason: STR,
    repos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['repoId', 'headCommit', 'reverseCheckExit', 'forwardCheckExit'],
        properties: {
          repoId: STR, headCommit: STR, reverseCheckExit: { type: 'integer' }, forwardCheckExit: { type: 'integer' },
          mergeCommit: STR, mergeCommittedAt: STR, mergeAncestorExit: { type: 'integer' },
          revertCommit: STR, revertCommittedAt: STR, revertAncestorExit: { type: 'integer' }, evidenceCommands: STRS,
        },
      },
    },
  },
};

const RETENTION_SCHEMA = {
  type: 'object',
  required: ['suggestionId', 'verdict', 'repos', 'reason'],
  properties: {
    sessionId: STR,
    suggestionId: STR,
    verdict: { type: 'string', enum: ['retained', 'not-retained', 'inconclusive'] },
    reason: STR,
    repos: {
      type: 'array',
      items: {
        type: 'object',
        required: ['repoId', 'mergeCommit', 'headCommit', 'ancestor', 'ancestorExit'],
        properties: { repoId: STR, mergeCommit: STR, headCommit: STR, pinnedCommit: STR, headCommittedAt: STR, ancestor: { type: 'boolean' }, ancestorExit: { type: 'integer' }, reverseCheckExit: { type: 'integer' }, forwardCheckExit: { type: 'integer' }, revertCommit: STR, evidenceCommand: STR },
      },
    },
  },
};

const MASTER_WRITE_SCHEMA = {
  type: 'object',
  required: ['updated', 'validationGreen', 'skipped'],
  properties: { sessionId: STR, updated: STRS, validationGreen: { type: 'boolean' }, schemaIssues: STRS, skipped: STRS },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['updated', 'listedSuggestionIds'],
  properties: { sessionId: STR, updated: { type: 'boolean' }, listedSuggestionIds: STRS, version: STR, inputsHash: STR, acceptanceRate: STR, notes: STR },
};

const SURFACE_SCHEMA = {
  type: 'object',
  required: ['surfacedIds', 'validationGreen', 'skipped'],
  properties: { sessionId: STR, surfacedIds: STRS, validationGreen: { type: 'boolean' }, schemaIssues: STRS, skipped: STRS },
};

// ---- Phase 1: Scout -------------------------------------------------------------------------------------
phase('Scout');
log('Scouting ' + companyId + ' for fixable findings' + (appFilter ? ' (apps: ' + appFilter.join(', ') + ')' : '') + (envFilter ? ' (envs: ' + envFilter.join(', ') + ')' : ''));
const scout = await agent(
  [
    'You are scouting for the ' + WORKFLOW + ' workflow, company ' + companyId + '. READ-ONLY: append nothing, write no file.',
    'Read ' + SKILL_CONV + ', ' + SKILL_LEDGER + ' (latest state = last record per id) and ' + SKILL_DIFF + ' sections 1, 2, 7 and 9.',
    runNow ? 'Return now = ' + runNow + '.' : 'Run ' + CLOCK_CMD + ' once and return it as now; later stages reuse it.',
    'Read ' + LEDGER + ' and ' + SUG_MASTER + ' (treat a missing master as empty). For every application directory under applications/, read repos/<repo_id>.json (pinnedCommit, defaultBranch, localCheckout).',
    'candidates: every finding whose LATEST record has status open|triaged|remediating, a location.path, and a target that names a repo (target.type "repo" with appId + repoId, or an application/image target whose location.path is unambiguously inside exactly one repo of that application: say which in description). The repo record must have pinnedCommit and its localCheckout directory must exist (check with node -e and existsSync from node:fs; never list or modify the checkout otherwise).',
    appFilter ? 'Keep only candidates whose appId is in ' + JSON.stringify(appFilter) + '.' : '',
    envFilter ? 'envIds ' + JSON.stringify(envFilter) + ' were passed: repo-located findings have no environment, so keep them only when their target.envId is absent or in that list.' : '',
    'Exclude a finding (and list it in skipped with the reason) when: an entry in suggestions/master.json lists it in findingIds with status proposed|surfaced|accepted|merged; its location.path is absolute or traverses upwards; the repo record or checkout is missing; it is filtered out by scope. Never drop anything silently.',
    'Rejected suggestions: for every entry with status rejected that lists the finding, compare its decidedAt with the finding history. When no record of that finding has recordedAt later than decidedAt, excluding records whose provenance.workflow is ' + WORKFLOW + ' (those only add suggestionIds), EXCLUDE the finding and add a skipped entry "rejected <sug_id> at <decidedAt> and the finding has not changed since: <decisionNote>". When the finding has a newer record, keep it and return every such rejection in priorRejections [{suggestionId, decidedAt, decisionNote (verbatim), title, category}].',
    'For each candidate return findingId, title, severity, appId, repoId, path, startLine, endLine, ruleId, sourceKind (source.kind), sourceWorkflow (provenance.workflow of its first record), pinnedCommit, defaultBranch, ledgerControlIds (the finding controlIds, instrument-qualified), regulatoryRefs, initiativeId (when the finding carries one), cveIds, latestRecordedAt, priorRejections (may be empty) and a one-paragraph description copied from the finding.',
    'retentionDue: every suggestion with status merged, mergedAt + 30 days <= now and no retentionCheckedAt: {suggestionId, mergedAt, status, repos: [{appId, repoId, mergeCommit, diffPath}]}. Suggestions whose repos lack mergeCommit go to skipped.',
    'recheckDue (skill section 9): every suggestion with status surfaced or accepted, plus every merged suggestion that is NOT in retentionDue (revert detection), whose every repo has a diffPath that exists and a repo record with a localCheckout that exists: {suggestionId, status, mergedAt (merged only), findingIds, repos: [{appId, repoId, diffPath, baseCommit, mergeCommit (merged only)}]}. Entries that fail those checks go to skipped.',
    'Also return openFindingsTotal (latest findings with an open status, before filtering) and existingSuggestions (length of suggestions[]).',
  ].filter(Boolean).join('\n'),
  { label: 'scout', phase: 'Scout', agentType: 'soc-ledger-keeper', schema: SCOUT_SCHEMA, effort: 'medium' },
);
if (!scout) {
  // run-workflow.mjs --dry-run returns null for every schema agent(): report a planned-only result instead of failing.
  if (dryRun) {
    skip(null, 'dry-run: scout returned no result (runtime dry-run executes no agent); nothing authored or written');
    return { companyId, workflow: WORKFLOW, dryRun, plannedOnly: true, phases: ['Scout', 'Author', 'Refute', 'Register', 'Link', 'Recheck', 'Retention', 'Summary', 'Surface'], targets: [], observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, surfaced: 0, rechecked: 0, retentionChecked: 0, skipped, sessionIds: [...sessionIds] };
  }
  throw new Error('Scout returned nothing; cannot continue');
}
noteSession(scout);
if (!runNow && typeof scout.now === 'string' && /Z$/.test(scout.now)) runNow = scout.now;
for (const s of scout.skipped || []) skip(s.id, 'scout: ' + s.reason);
const candidates = (scout.candidates || []).filter((c) => c && c.findingId && c.appId && c.repoId && c.path);
const retentionDue = (scout.retentionDue || []).filter((r) => r && r.suggestionId);
const retentionIds = new Set(retentionDue.map((r) => r.suggestionId));
const recheckDue = (scout.recheckDue || []).filter((r) => r && r.suggestionId && (r.repos || []).length && !retentionIds.has(r.suggestionId));
log(candidates.length + ' candidate finding(s) of ' + (scout.openFindingsTotal || 0) + ' open; ' + recheckDue.length + ' suggestion(s) to re-check; ' + retentionDue.length + ' merged suggestion(s) due a retention check; ' + (scout.existingSuggestions || 0) + ' suggestion(s) already indexed');

// ---- Phase 2 + 3: per-finding pipeline (author -> refute) -----------------------------------------------
phase('Author');
const authorPrompt = (c) => [
  'You are the fix-author for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' in full, then ' + SKILL_CONV + ' and ' + SKILL_REG + ' (for regulatory refs; if the skill file is absent use its references/ catalogs).',
  'Finding to fix (latest ledger state, from ' + LEDGER + '):\n' + JSON.stringify(c, null, 1),
  NEVER_TOUCH,
  SHELL_RULES,
  'Step 1 - pin: read applications/' + c.appId + '/repos/' + c.repoId + '.json; run git -C applications/' + c.appId + '/repos/' + c.repoId + ' rev-parse HEAD and git -C applications/' + c.appId + '/repos/' + c.repoId + ' status --porcelain. Return checkout {head, pinnedCommit, clean, statusPorcelainLines}. If HEAD neither equals nor starts with pinnedCommit (the record may hold an abbreviated SHA) return status checkout-mismatch; if the tree is dirty return status checkout-dirty; in both cases stop without a suggestion (scratchRemoved true, nothing was created).',
  'Step 2 - understand: read ' + c.path + (c.startLine ? ' around lines ' + c.startLine + '-' + (c.endLine || c.startLine) : '') + ' in the checkout and whatever else you need (read-only). If the gap is already fixed at pinnedCommit return status already-fixed with the evidence in reason; if it cannot be fixed by a repository diff (needs a live-system change, a vendor action or a process) return status not-fixable-by-diff with a reason naming what change-management should do instead.',
  (c.priorRejections || []).length
    ? 'Prior rejections: reviewers rejected earlier suggestions for this finding with these notes (verbatim): ' + JSON.stringify(c.priorRejections) + '. Your change must address every decisionNote (a different approach, a smaller scope, or the constraint the reviewer named); the rationale must say how, per rejected sug_ id, and addressesRejections must list those ids. If no diff can address a note, return not-fixable-by-diff quoting it.'
    : '',
  'Step 3 - stage (skill section 3, with node -e instead of shell redirection, sed or rm):',
  '3a. Mint suggestionId = "sug_" + ULID with the maxwell-conventions node -e recipe. Run mktemp -d ' + SCRATCH_PREFIX + 'XXXXXX once and copy the literal path it prints (below <T>, e.g. ' + SCRATCH_PREFIX + 'k3P9qz) into every later command; return it as scratchDir.',
  '3b. One node -e call copies each repo-relative path <p> you change from applications/' + c.appId + '/repos/' + c.repoId + '/<p> to <T>/a/<p> and <T>/b/<p>: mkdirSync of the parent with recursive true, copyFileSync, then chmodSync to the source statSync mode (all from node:fs). A new file exists only under b/, a deleted file only under a/.',
  '3c. Edit ONLY the b/ copies, each with a node -e read / exact-substring replace / write (readFileSync and writeFileSync from node:fs on the literal <T>/b/<p> path; exit with status 3 when the old text is not found so a silent no-op is impossible). The Write and Edit tools do not work here.',
  '3d. Produce the diff with one node -e call: execFileSync from node:child_process running git with the argument array ["-C", "<T>", "diff", "--no-index", "--unified=3", "--no-color", "--src-prefix=", "--dst-prefix=", "a", "b"] and options {encoding: "utf8", maxBuffer: 67108864}. git exits 1 when the trees differ: catch the error, accept it only when its status is 1 and take its stdout; any other status, or an empty output, is a failure. Rewrite only the added/deleted file headers with multiline regexes and a replacer function (no $1 inside the shell string): /^diff --git b\\/(.+) b\\/\\1$/gm and /^diff --git a\\/(.+) a\\/\\1$/gm both become "diff --git a/<p> b/<p>". Write the result to <T>/<diffName> with writeFileSync and print its sha256 (createHash from node:crypto over the same string, hex) - that is diffSha256. Every header must read diff --git a/<repo-relative> b/<repo-relative>.',
  'Constraints: one category, the smallest change that closes the finding, <= 400 changed lines and <= 10 files, no generated artefacts, no secrets, no new hostnames; keep the repo style (indentation, quoting, pinning conventions). Do NOT write the diff into company-profile/: the validator writes it after refutation, through the write guard that scans it for secrets.',
  'Step 4 - prove and clean up: (i) git -C applications/' + c.appId + '/repos/' + c.repoId + ' apply --check <T>/<diffName> (absolute path; applyCheckPassed = exit 0). (ii) linesAdded linesRemoved filesChanged with the section 5 awk one-liner on <T>/<diffName>. (iii) Secret scan with node -e: test the file content against the section 6 pattern AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|sk-ant-|xox[baprs]- ; any hit drops the suggestion: return not-fixable-by-diff naming a rotation task for impl-change-management. (iv) Read <T>/<diffName> with the Read tool (or print it with node -e) to return diffText exactly. (v) Re-run rev-parse HEAD and status --porcelain to prove the checkout is still clean at pinnedCommit. (vi) Remove the scratch tree with node -e: first check that the literal path starts with ' + SCRATCH_PREFIX + ' (exit with status 5 otherwise), then rmSync(<T>, {recursive: true, force: true}) from node:fs, then existsSync(<T>) must be false. scratchRemoved = true only when that final check passed; if any earlier step failed, still run the removal before returning.',
  'Return status drafted with suggestion {suggestionId, title (imperative, PR-title length), rationale (why, what the diff does, what risk it closes; cite ' + c.findingId + ' and the most specific Indian clause first), category, severity (copied from the finding: ' + c.severity + '), appId, repoId, diffName (kebab-case, ends .diff), baseCommit (the full 40-hex SHA from rev-parse HEAD), diffText (the exact diff bytes as text), diffSha256, linesAdded, linesRemoved, filesChanged, filesTouched (repo-relative paths), applyCheckPassed, controlIds (BARE catalog ids, the part after the colon of ' + JSON.stringify(c.ledgerControlIds || []) + '), regulatoryRefs (from the finding, Indian instrument first), initiativeId (' + (c.initiativeId || 'omit: the finding has none') + '), addressesRejections}, checkout, scratchDir, scratchRemoved, model (the model id you run as) and skipped (anything you chose not to change and why).',
  timeRule(),
].filter(Boolean).join('\n');

const LENSES = ['correctness', 'minimality', 'in-place'];
const refutePrompt = (c, a, lens) => [
  'You are an adversarial refuter for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Lens: ' + lens + '. Try to REFUTE the proposed suggestion below; default to refuted=true when you cannot verify it from the workspace. Read-only.',
  'Finding: ' + JSON.stringify({ findingId: c.findingId, title: c.title, severity: c.severity, appId: c.appId, repoId: c.repoId, path: c.path, startLine: c.startLine, ruleId: c.ruleId, regulatoryRefs: c.regulatoryRefs, priorRejections: c.priorRejections || [] }),
  'Proposed suggestion (diffText is the full unified diff):\n' + JSON.stringify(a.suggestion, null, 1),
  'Checkout state reported by the fix-author: ' + JSON.stringify(a.checkout),
  lens === 'correctness'
    ? 'Correctness lens: read the finding in ' + LEDGER + ' and the pre-image files in applications/' + c.appId + '/repos/' + c.repoId + '/. Refute when the diff does not close the finding (wrong file or line, fix bypassable, dependency version still vulnerable per cves/data when cveIds exist), breaks syntax or semantics of the file (YAML/JSON/HCL/Dockerfile/code), introduces a new weakness, headers are not a/<repo-relative> b/<repo-relative>, the hunk counts do not match linesAdded/linesRemoved/filesChanged, severity differs from the finding, a regulatoryRef/controlId is not in the catalog, or (when priorRejections is non-empty) the change or rationale does not address every quoted decisionNote. Return corrected* fields when only the metadata is wrong.'
    : lens === 'minimality'
      ? 'Minimality lens: refute when the diff mixes categories (e.g. dependency bump plus CI gate), touches lines unrelated to the finding, reformats or reorders code, exceeds 400 changed lines or 10 files, adds generated artefacts, or when a clearly smaller change would close the same finding. Say which hunks to drop.'
      : 'In-place lens: the target repository must not be modified. Refute when the checkout state is not clean or HEAD does not equal (or start with) pinnedCommit, when the post-image (+ lines) is already present in the checkout file while the pre-image (- and context lines) is not (a sign the checkout was edited), when the diff paths escape the repo or point into company-profile/ or .claude/, or when the suggestion implies commits, pushes, branches or stashes. Read the checkout files named in filesTouched and compare them with the diff pre-image.',
  'Return {refuted, confidence, lens: "' + lens + '", reason, checked, unverifiable, corrected* when applicable}.',
].join('\n');

const authored = await pipeline(
  candidates,
  async (c, _item, index) => {
    const a = await agent(authorPrompt(c), { label: 'author ' + c.findingId + ' #' + (index + 1), phase: 'Author', agentType: 'fix-author', schema: AUTHOR_SCHEMA, effort: 'high' });
    if (!a) { skip(c.findingId, 'fix-author returned no schema-valid result; scratch tree state unknown (check ' + SCRATCH_PREFIX + '* on this host)'); return null; }
    noteSession(a);
    for (const s of a.skipped || []) skip(c.findingId, 'author: ' + s);
    if (!a.scratchRemoved) skip(c.findingId, 'scratch tree ' + (a.scratchDir || SCRATCH_PREFIX + '*') + ' was NOT removed: it holds copies of company source files; remove it on the host');
    if (a.status !== 'drafted' || !a.suggestion) { skip(c.findingId, 'author status ' + a.status + (a.reason ? ': ' + a.reason : '')); return { candidate: c, author: a, accepted: false }; }
    if (!a.suggestion.applyCheckPassed) { skip(c.findingId, 'diff does not apply cleanly at pinnedCommit; not proposed'); return { candidate: c, author: a, accepted: false }; }
    if (!SHA256.test(a.suggestion.diffSha256 || '')) { skip(c.findingId, 'author returned no sha256 of the scratch diff; not proposed'); return { candidate: c, author: a, accepted: false }; }
    if (!a.checkout || !a.checkout.clean || !a.checkout.head || !a.checkout.pinnedCommit || !a.checkout.head.startsWith(a.checkout.pinnedCommit)) { skip(c.findingId, 'checkout not clean at pinnedCommit after authoring; not proposed'); return { candidate: c, author: a, accepted: false }; }
    const unaddressed = (c.priorRejections || []).map((r) => r.suggestionId).filter((id) => !(a.suggestion.addressesRejections || []).includes(id));
    if (unaddressed.length) { skip(c.findingId, 'draft does not claim to address rejected suggestion(s) ' + unaddressed.join(', ') + '; not proposed'); return { candidate: c, author: a, accepted: false }; }
    log(c.findingId + ': drafted ' + a.suggestion.suggestionId + ' (' + a.suggestion.category + ', +' + a.suggestion.linesAdded + '/-' + a.suggestion.linesRemoved + ' in ' + a.suggestion.filesChanged + ' file(s))');
    return { candidate: c, author: a, accepted: null };
  },
  async (prev) => {
    if (!prev || prev.accepted === false) return prev;
    const { candidate: c, author: a } = prev;
    const votes = await parallel(LENSES.map((lens) => () =>
      agent(refutePrompt(c, a, lens), { label: 'refute ' + lens + ' ' + a.suggestion.suggestionId, phase: 'Refute', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' })));
    const valid = votes.filter(Boolean);
    valid.forEach(noteSession);
    const refutations = valid.filter((v) => v.refuted).length;
    const severe = c.severity === 'critical' || c.severity === 'high';
    const inPlaceVote = votes[2];
    // Majority of the three lenses must fail to refute; critical/high findings need all three. An in-place refutation
    // always wins: a suggestion that may have touched the target is never registered.
    const survives = valid.length === LENSES.length
      && !(inPlaceVote && inPlaceVote.refuted)
      && (severe ? refutations === 0 : refutations <= 1);
    if (!survives) {
      skip(c.findingId, 'refuted ' + a.suggestion.suggestionId + ' (' + refutations + '/' + valid.length + ' lenses answered and refuted): ' + valid.filter((v) => v.refuted).map((v) => (v.lens || '?') + ': ' + v.reason).join(' | '));
      return { ...prev, accepted: false };
    }
    const suggestion = { ...a.suggestion };
    for (const v of valid.filter((x) => !x.refuted)) {
      if (v.correctedCategory) suggestion.category = v.correctedCategory;
      if (v.correctedSeverity) suggestion.severity = v.correctedSeverity;
      if (v.correctedRegulatoryRefs && v.correctedRegulatoryRefs.length) suggestion.regulatoryRefs = v.correctedRegulatoryRefs;
      if (v.correctedControlIds && v.correctedControlIds.length) suggestion.controlIds = v.correctedControlIds;
    }
    log(c.findingId + ': ' + suggestion.suggestionId + ' survived refutation (' + refutations + ' dissent)');
    return { ...prev, author: { ...a, suggestion }, accepted: true, refutation: valid.map((v) => ({ lens: v.lens, refuted: v.refuted, reason: v.reason })) };
  },
);
const accepted = authored.filter((p) => p && p.accepted);
log(accepted.length + '/' + candidates.length + ' suggestion(s) survived authoring and refutation');

// ---- Phase 4: Register (sequential: master.json is one file) ---------------------------------------------
phase('Register');
const registered = [];
const writeDiff = (s, diffPath, attempt) => agent(
  [
    'You are the validator writing one auto-improvement diff for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' sections 1 and 4 first.',
    (attempt > 1 ? 'SECOND ATTEMPT: the previous write did not reproduce the diff byte-for-byte (a dropped single-space context line, trailing whitespace or final newline is the usual cause). ' : '')
      + 'Write the diff text below to ' + diffPath + ' with the Write tool EXACTLY as given: every line, including context lines that are a single space, trailing whitespace and the final newline; no reformatting, no added or removed lines. Then run node .claude/scripts/validate-data.mjs ' + diffPath + '. If validation fails, do not repair hunks by hand: return validationGreen false with the validator output in skipped.',
    'Write nothing else: not master.json, not the ledger, not summary.md, not change_management/, not the checkout. Do not compute hashes.',
    'Diff text (between the markers, markers excluded):\n-----BEGIN MAXWELL DIFF-----\n' + s.diffText + (s.diffText.endsWith('\n') ? '' : '\n') + '-----END MAXWELL DIFF-----',
    'Return {diffPath, validationGreen, schemaIssues, skipped}.',
  ].join('\n'),
  { label: 'write diff ' + s.suggestionId + (attempt > 1 ? ' #' + attempt : ''), phase: 'Register', agentType: 'validator', schema: DIFF_WRITE_SCHEMA, effort: 'low' },
);
const verifyDiff = (p, diffPath, attempt) => {
  const s = p.author.suggestion;
  return agent(
    [
      'You are the fix-author re-proving a diff the validator just wrote for the ' + WORKFLOW + ' workflow, company ' + companyId + '. READ-ONLY: write nothing. ' + NEVER_TOUCH,
      'Diff: ' + diffPath + ' (workspace-relative). Expected: sha256 ' + s.diffSha256 + ', linesAdded ' + s.linesAdded + ', linesRemoved ' + s.linesRemoved + ', filesChanged ' + s.filesChanged + ', applies at ' + s.baseCommit + '.',
      '1. Print the workspace root with node -e (the current working directory) and form absolutePath = <root>/' + diffPath + '.',
      '2. git -C applications/' + s.appId + '/repos/' + s.repoId + ' rev-parse HEAD must equal ' + s.baseCommit + ' (otherwise matches false). git -C applications/' + s.appId + '/repos/' + s.repoId + ' apply --check <absolutePath>; applyCheckExit = its exit status, applyCheckPassed = exit 0.',
      '3. The section 5 awk one-liner on ' + diffPath + ' gives linesAdded linesRemoved filesChanged.',
      '4. sha256 of the file bytes with node -e (readFileSync from node:fs, createHash from node:crypto, hex).',
      'matches = applyCheckPassed AND the three counts equal the expected ones AND sha256 equals the expected hash. reason names every mismatch.',
      'Return {diffPath, absolutePath, applyCheckPassed, applyCheckExit, linesAdded, linesRemoved, filesChanged, sha256, matches, reason}.',
    ].join('\n'),
    { label: 'verify diff ' + s.suggestionId + (attempt > 1 ? ' #' + attempt : ''), phase: 'Register', agentType: 'fix-author', schema: VERIFY_SCHEMA, effort: 'low' },
  );
};
if (dryRun) {
  log('dry-run: no diff or master.json entry written');
} else {
  for (const p of accepted) {
    const s = p.author.suggestion;
    const diffPath = PROFILE + '/suggestions/suggestions/' + s.suggestionId + '/' + s.repoId + '/' + s.diffName;
    // Write the diff, then prove on the written bytes (apply --check, counts, sha256) before anything indexes it.
    let proof = null;
    for (let attempt = 1; attempt <= 2 && !(proof && proof.matches); attempt += 1) {
      const w = await writeDiff(s, diffPath, attempt);
      if (!w) { skip(s.suggestionId, 'validator returned no result writing ' + diffPath + ' (attempt ' + attempt + ')'); continue; }
      noteSession(w);
      for (const x of w.skipped || []) skip(s.suggestionId, 'write diff: ' + x);
      for (const x of w.schemaIssues || []) skip(s.suggestionId, 'schema issue: ' + x);
      if (!w.validationGreen) { skip(s.suggestionId, 'diff validation not green (attempt ' + attempt + ')'); continue; }
      proof = await verifyDiff(p, diffPath, attempt);
      if (!proof) { skip(s.suggestionId, 'fix-author returned no verification of ' + diffPath + ' (attempt ' + attempt + ')'); continue; }
      noteSession(proof);
      const ok = proof.matches && proof.applyCheckPassed && proof.sha256 === s.diffSha256
        && proof.linesAdded === s.linesAdded && proof.linesRemoved === s.linesRemoved && proof.filesChanged === s.filesChanged;
      if (!ok) { skip(s.suggestionId, 'written diff differs from the authored diff (attempt ' + attempt + '): ' + proof.reason); proof = { ...proof, matches: false }; }
    }
    if (!proof || !proof.matches) {
      skip(s.suggestionId, 'NOT registered and finding not linked: ' + diffPath + ' could not be written byte-for-byte; the file (if present) is an orphan outside master.json and must be removed by a human or overwritten by the next run');
      continue;
    }
    const r = await agent(
      [
        'You are the validator registering one auto-improvement suggestion for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' sections 1, 7 and 8, ' + SKILL_CONV + ' and .claude/schemas/v1/suggestions/master.schema.json first.',
        'The diff is already written at ' + diffPath + ' and was re-proved by the fix-author (apply --check exit 0, counts and sha256 match). Do not rewrite or touch it.',
        'Read ' + SUG_MASTER + ' (create it with schemaVersion "1", kind maxwell.sug.master, companyId, updatedAt, suggestions [] and provenance when absent) and append (never reorder or delete) {suggestionId, title, rationale, category, severity, status "proposed", createdAt = NOW, prUrls [], repos [{appId, repoId, diffPath: "' + diffPath + '", baseCommit, linesAdded, linesRemoved, filesChanged}], findingIds ["' + p.candidate.findingId + '"], controlIds (bare catalog ids), regulatoryRefs, initiativeId (only when given), sourceWorkflow "' + WORKFLOW + '", provenance (agent "fix-author", model "' + (p.author.model || 'claude-opus-5') + '")}. No surfacedAt, decidedAt, mergedAt or closedAt on a proposed entry. Set updatedAt = NOW and the index-level provenance (agent validator).',
        'Run node .claude/scripts/validate-data.mjs ' + SUG_MASTER + ' until green; fix content only, never schemas. Do not compute hashes.',
        'Suggestion:\n' + JSON.stringify({ ...s, diffText: undefined, diffSha256: undefined, addressesRejections: undefined }, null, 1),
        timeRule(), provenanceRule('validator'),
        'Do not touch the ledger, summary.md, change_management/ or the checkout. Return {suggestionId, filesWritten, validationGreen, schemaIssues, skipped}.',
      ].join('\n'),
      { label: 'register ' + s.suggestionId, phase: 'Register', agentType: 'validator', schema: REGISTER_SCHEMA, effort: 'medium' },
    );
    if (!r) { skip(p.candidate.findingId, 'validator returned no result; ' + s.suggestionId + ' not indexed (orphan diff at ' + diffPath + ')'); continue; }
    noteSession(r);
    for (const x of r.skipped || []) skip(s.suggestionId, 'register: ' + x);
    for (const x of r.schemaIssues || []) skip(s.suggestionId, 'schema issue: ' + x);
    if (!r.validationGreen) { skip(s.suggestionId, 'master.json validation not green; finding not linked'); continue; }
    registered.push({ candidate: p.candidate, suggestion: s, diffPath, diffSha256: s.diffSha256 });
    log('registered ' + s.suggestionId + ' at ' + diffPath);
    if (s.initiativeId) skip(s.suggestionId, 'task request for impl-change-management: add ' + s.suggestionId + ' to suggestionIds of the task in ' + s.initiativeId + ' that remediates ' + p.candidate.findingId + ' (diff-suggestions section 8; this workflow never edits task files)');
  }
}

// ---- Phase 5: Link (ledger) -------------------------------------------------------------------------------
phase('Link');
const linked = { findingIds: [], observationIds: [] };
const checkoutProblems = authored.filter((p) => p && p.author && (p.author.status === 'checkout-mismatch' || p.author.status === 'checkout-dirty'));
if (dryRun) {
  const drafts = authored.filter(Boolean).map((p) => ({
    findingId: p.candidate.findingId, ledgerControlIds: p.candidate.ledgerControlIds, appId: p.candidate.appId, repoId: p.candidate.repoId,
    authorStatus: p.author && p.author.status, accepted: p.accepted,
    suggestion: p.author && p.author.suggestion ? { title: p.author.suggestion.title, category: p.author.suggestion.category, linesAdded: p.author.suggestion.linesAdded, linesRemoved: p.author.suggestion.linesRemoved, diffName: p.author.suggestion.diffName } : null,
  }));
  const l = await agent(
    [
      'You are the soc-ledger-keeper for a DRY RUN of the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_LEDGER + ' and ' + SKILL_CONV + '.',
      'Append exactly one observation via `node .claude/scripts/soc/append.mjs ' + companyId + ' -`: id obs_<ULID>, controlIds = the union of ledgerControlIds below that exist as control records (at least one is required; if none exists append nothing and say so in skipped), title "dry-run: impl-auto-improvement would propose ' + accepted.length + ' diff(s)", description starting "dry-run:" listing per finding the author status, the would-be suggestion title, category and +/- line counts, and the re-checks (' + recheckDue.length + ') and retention checks (' + retentionDue.length + ') that were not run, methods ["' + WORKFLOW + '"], subjects = the repo assetRefs involved, collectedAt = NOW, result "inconclusive", tags ' + JSON.stringify(BASE_TAGS.concat(['dry-run'])) + '. Supersede nothing.',
      'Drafts:\n' + JSON.stringify(drafts, null, 1),
      timeRule(), provenanceRule('soc-ledger-keeper'),
      'Validate with node .claude/scripts/validate-data.mjs ' + LEDGER + '. Return {findingIds: [], observationIds, skipped}.',
    ].join('\n'),
    { label: 'dry-run observation', phase: 'Link', agentType: 'soc-ledger-keeper', schema: LINK_SCHEMA, effort: 'low' },
  );
  if (l) { noteSession(l); linked.observationIds.push(...(l.observationIds || [])); for (const x of l.skipped || []) skip(null, 'link: ' + x); }
  else skip(null, 'ledger keeper returned no result; dry-run observation not written');
} else if (!registered.length && !checkoutProblems.length) {
  log('nothing registered and no checkout problem; ledger untouched');
} else {
  const l = await agent(
    [
      'You are the soc-ledger-keeper for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_LEDGER + ', ' + SKILL_CONV + ' and ' + SKILL_DIFF + ' section 8 first. Write every record by piping JSON to `node .claude/scripts/soc/append.mjs ' + companyId + ' -`; never open the ledger for writing.',
      registered.length ? 'Step 1 - findings: for each registered suggestion below take the LATEST record of its finding, copy it in full, set supersedes = the same id, add the suggestionId to suggestionIds (keep existing ones, no duplicates), keep status (do not resolve: a proposal fixes nothing yet), recordedAt = NOW, fresh provenance; append. Skip and report any finding whose latest status is no longer open|triaged|remediating.' : '',
      registered.length ? 'Step 2 - proposal observations: per registered suggestion append one observation {id obs_<ULID>, controlIds = the finding ledgerControlIds that exist as control records (at least one; otherwise skip and report), title "Suggestion <sug_id> proposed for <fnd_id>", description naming the diff path, category and +/- counts, methods ["' + WORKFLOW + '"], subjects [{type: "repo", appId, repoId}], collectedAt = NOW, result "not-applicable", evidence [{type: "workspace-file", ref: <diffPath>, sha256: <diffSha256 below, verified on the written file>}], tags ' + JSON.stringify(BASE_TAGS) + '}.' : '',
      'Registered:\n' + JSON.stringify(registered.map((r) => ({ findingId: r.candidate.findingId, suggestionId: r.suggestion.suggestionId, diffPath: r.diffPath, diffSha256: r.diffSha256, category: r.suggestion.category, linesAdded: r.suggestion.linesAdded, linesRemoved: r.suggestion.linesRemoved, appId: r.suggestion.appId, repoId: r.suggestion.repoId, ledgerControlIds: r.candidate.ledgerControlIds })), null, 1),
      checkoutProblems.length ? 'Step 3 - checkout state: per entry below append one observation {id obs_<ULID>, controlIds = its ledgerControlIds that exist (at least one), title "Checkout of <repoId> not at pinnedCommit or modified outside Maxwell", description with head, pinnedCommit and porcelain line count and the request that refresh-ctx re-pin the checkout, methods ["' + WORKFLOW + '"], subjects [{type: "repo", appId, repoId}], collectedAt = NOW, result "inconclusive", tags ' + JSON.stringify(BASE_TAGS.concat(['checkout-state'])) + '}; one observation per repo, not per finding.\n' + JSON.stringify(checkoutProblems.map((p) => ({ findingId: p.candidate.findingId, appId: p.candidate.appId, repoId: p.candidate.repoId, status: p.author.status, checkout: p.author.checkout, ledgerControlIds: p.candidate.ledgerControlIds })), null, 1) : '',
      timeRule(), provenanceRule('soc-ledger-keeper'),
      'Validate with node .claude/scripts/validate-data.mjs ' + LEDGER + '. Return {findingIds (superseded), observationIds, skipped}.',
    ].filter(Boolean).join('\n'),
    { label: 'link ledger', phase: 'Link', agentType: 'soc-ledger-keeper', schema: LINK_SCHEMA, effort: 'medium' },
  );
  if (!l) skip(null, 'ledger keeper returned no result; findings not linked to ' + registered.map((r) => r.suggestion.suggestionId).join(', '));
  else {
    noteSession(l);
    linked.findingIds.push(...(l.findingIds || []));
    linked.observationIds.push(...(l.observationIds || []));
    for (const x of l.skipped || []) skip(null, 'link: ' + x);
    log('ledger: ' + (l.findingIds || []).length + ' finding(s) superseded, ' + (l.observationIds || []).length + ' observation(s) appended');
  }
}

// ---- Phase 6: Recheck (skill section 9: accepted -> merged, merged -> reverted) -----------------------------
phase('Recheck');
const recheckResults = [];
const recheckWrites = { merged: [], reverted: [] };
if (!recheckDue.length) {
  log('no surfaced, accepted or merged suggestion to re-check');
} else if (dryRun) {
  for (const r of recheckDue) skip(r.suggestionId, 'dry-run: merge/revert re-check not run');
} else {
  const checks = await pipeline(
    recheckDue,
    async (r, _item, index) => {
      const v = await agent(
        [
          'You are the fix-author running a READ-ONLY merge/revert re-check (diff-suggestions section 9) for the ' + WORKFLOW + ' workflow, company ' + companyId + '. ' + NEVER_TOUCH + ' This workflow never fetches: the checkout is whatever refresh-ctx last pinned.',
          'Suggestion ' + r.suggestionId + ' (status ' + r.status + (r.mergedAt ? ', mergedAt ' + r.mergedAt : '') + '). Repos: ' + JSON.stringify(r.repos),
          'For each repo (checkout = applications/<appId>/repos/<repoId>, absolute diff path = the workspace root printed by node -e as the current working directory + "/" + diffPath): headCommit = git -C <checkout> rev-parse HEAD (must equal or start with the repo record pinnedCommit and the tree must be clean per status --porcelain; otherwise state inconclusive). Run git -C <checkout> apply --check --reverse <abs diff> (reverseCheckExit) and git -C <checkout> apply --check <abs diff> (forwardCheckExit) and record both exit statuses.',
          'reverse 0 and forward non-zero: the change is present. Find the commit that introduced it with git -C <checkout> log --format=%H -S\'<distinctive added line from the diff>\' -- <path> (oldest hit that is not the baseCommit), then prove it with git -C <checkout> merge-base --is-ancestor <commit> HEAD (mergeAncestorExit must be 0) and take mergeCommittedAt from git -C <checkout> log -1 --format=%cI <commit>. forward 0 and reverse non-zero: not merged (or, for a merged suggestion, reverted: find the revert commit the same way with -S on a distinctive removed-then-restored line, prove it with merge-base --is-ancestor (revertAncestorExit 0) and take revertCommittedAt). Both non-zero: the code moved on.',
          'state per suggestion: for surfaced/accepted - merged when every repo proves a mergeCommit (40-hex, ancestor exit 0), not-merged when every repo forward-applies, moved-on when any repo applies in neither direction, inconclusive otherwise. For merged - reverted when every repo proves a revertCommit, still-present when every repo reverse-applies, moved-on when any applies in neither direction, inconclusive otherwise. Never guess a commit; quote each command you ran with its exit status in evidenceCommands.',
          'Return {suggestionId, state, reason, repos: [{repoId, headCommit, reverseCheckExit, forwardCheckExit, mergeCommit, mergeCommittedAt, mergeAncestorExit, revertCommit, revertCommittedAt, revertAncestorExit, evidenceCommands}]}.',
        ].join('\n'),
        { label: 'recheck ' + r.suggestionId + ' #' + (index + 1), phase: 'Recheck', agentType: 'fix-author', schema: RECHECK_SCHEMA, effort: 'medium' },
      );
      if (!v) { skip(r.suggestionId, 're-check returned no result'); return null; }
      noteSession(v);
      return { due: r, result: v };
    },
  );
  for (const x of checks.filter(Boolean)) {
    const { due: r, result: v } = x;
    recheckResults.push({ suggestionId: r.suggestionId, status: r.status, state: v.state });
    const repos = v.repos || [];
    const allRepos = repos.length === (r.repos || []).length;
    if (v.state === 'merged') {
      const proven = allRepos && repos.every((x2) => SHA40.test(x2.mergeCommit || '') && x2.mergeAncestorExit === 0 && x2.reverseCheckExit === 0 && x2.mergeCommittedAt);
      if (!proven) skip(r.suggestionId, 'merge claimed but not proven for every repo (40-hex mergeCommit, merge-base --is-ancestor exit 0, reverse apply --check exit 0); not recorded: ' + v.reason);
      else if (r.status === 'accepted') recheckWrites.merged.push({ suggestionId: r.suggestionId, mergedAt: repos.map((x2) => x2.mergeCommittedAt).sort().slice(-1)[0], repos: repos.map((x2) => ({ repoId: x2.repoId, mergeCommit: x2.mergeCommit })) });
      else skip(r.suggestionId, 'change found merged (' + repos.map((x2) => x2.repoId + '@' + x2.mergeCommit).join(', ') + ') but the suggestion is still surfaced: it stays surfaced until a human or script records accepted (agents never set decidedBy)');
    } else if (v.state === 'reverted') {
      const proven = r.status === 'merged' && allRepos && repos.every((x2) => SHA40.test(x2.revertCommit || '') && x2.revertAncestorExit === 0 && x2.forwardCheckExit === 0 && x2.revertCommittedAt);
      if (!proven) skip(r.suggestionId, 'revert claimed but not proven for every repo; not recorded: ' + v.reason);
      else recheckWrites.reverted.push({ suggestionId: r.suggestionId, revertedAt: repos.map((x2) => x2.revertCommittedAt).sort().slice(-1)[0], repos: repos.map((x2) => ({ repoId: x2.repoId, revertCommit: x2.revertCommit })) });
    } else if (v.state === 'moved-on') {
      skip(r.suggestionId, 'diff applies in neither direction at the pinned checkout (code moved on); status left ' + r.status + (r.status !== 'merged' ? ', finding(s) ' + (r.findingIds || []).join(', ') + ' need a superseding suggestion against the new pinnedCommit' : '') + ': ' + v.reason);
    } else if (v.state === 'inconclusive') {
      skip(r.suggestionId, 're-check inconclusive: ' + v.reason);
    } else {
      log(r.suggestionId + ': ' + v.state);
    }
  }
  if (recheckWrites.merged.length || recheckWrites.reverted.length) {
    const w = await agent(
      [
        'You are the validator recording merge/revert re-check results for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' sections 7 and 9 and .claude/schemas/v1/suggestions/master.schema.json.',
        'Edit ' + SUG_MASTER + ' in place for exactly these suggestion ids (never reorder or delete entries, never touch decidedAt, decidedBy or decisionNote):',
        recheckWrites.merged.length ? 'accepted -> merged (skip and report any whose current status is not accepted): set status "merged", mergedAt as given, repos[].mergeCommit per repoId as given:\n' + JSON.stringify(recheckWrites.merged, null, 1) : '',
        recheckWrites.reverted.length ? 'merged -> reverted (skip and report any whose current status is not merged): set status "reverted", revertedAt as given, repos[].revertCommit per repoId as given; keep mergedAt and mergeCommit:\n' + JSON.stringify(recheckWrites.reverted, null, 1) : '',
        'Commits and timestamps above were proven by the fix-author with merge-base --is-ancestor; copy them, invent nothing. Set updatedAt = NOW and the index-level provenance.',
        timeRule(), provenanceRule('validator'),
        'Run node .claude/scripts/validate-data.mjs ' + SUG_MASTER + ' until green (content fixes only). Return {updated (suggestion ids), validationGreen, schemaIssues, skipped}.',
      ].filter(Boolean).join('\n'),
      { label: 'record recheck', phase: 'Recheck', agentType: 'validator', schema: MASTER_WRITE_SCHEMA, effort: 'low' },
    );
    if (!w) skip(null, 'validator returned no result; merge/revert results not recorded');
    else {
      noteSession(w);
      for (const x of w.skipped || []) skip(null, 'recheck write: ' + x);
      for (const x of w.schemaIssues || []) skip(null, 'schema issue: ' + x);
      log('re-check recorded for ' + (w.updated || []).length + ' suggestion(s)' + (w.validationGreen ? '' : ' (validation NOT green)'));
    }
  }
}

// ---- Phase 7: Retention -------------------------------------------------------------------------------------
phase('Retention');
const retentionResults = [];
if (!retentionDue.length) {
  log('no merged suggestion is due a retention check');
} else if (dryRun) {
  for (const r of retentionDue) skip(r.suggestionId, 'dry-run: retention check not run');
} else {
  const checks = await pipeline(
    retentionDue,
    async (r, _item, index) => {
      const v = await agent(
        [
          'You are the fix-author running a READ-ONLY 30-day retention check for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' sections 7 and 9. ' + NEVER_TOUCH,
          'Suggestion ' + r.suggestionId + ' was merged at ' + r.mergedAt + '. Repos: ' + JSON.stringify(r.repos),
          'For each repo (checkout = applications/<appId>/repos/<repoId>): read the repo record; headCommit = git -C <checkout> rev-parse HEAD (must equal or start with pinnedCommit, otherwise the repo is inconclusive; this workflow never fetches, refresh-ctx re-pins); headCommittedAt = git -C <checkout> log -1 --format=%cI HEAD. The check is only meaningful when headCommittedAt >= mergedAt + 30 days; otherwise verdict inconclusive (the checkout predates the retention window; refresh-ctx must re-pin).',
          'ancestor: run git -C <checkout> merge-base --is-ancestor <mergeCommit> HEAD and record ancestorExit: 0 means ancestor (true), 1 means not an ancestor (false), any other status (unknown commit, shallow clone) makes the repo inconclusive. Quote the exact command and its exit status in evidenceCommand. When it is an ancestor, also look for a revert per skill section 9 using the absolute diff path (workspace root from node -e + "/" + diffPath): record reverseCheckExit of git -C <checkout> apply --check --reverse <abs diff> and forwardCheckExit of git -C <checkout> apply --check <abs diff>; reverse 0 means the change is still present; reverse non-zero with forward 0 means it was reverted, and the revert commit is found with git -C <checkout> log --format=%H -S\'<distinctive added line>\' -- <path> and proved with merge-base --is-ancestor. Record revertCommit only when a commit is proven.',
          'verdict: retained when every repo has ancestorExit 0 and no revert is proven; not-retained when any repo has ancestorExit 1 or a revert commit is proven; inconclusive otherwise. Never guess a commit.',
          'Return {suggestionId, verdict, reason, repos: [{repoId, mergeCommit, headCommit, pinnedCommit, headCommittedAt, ancestor, ancestorExit, reverseCheckExit, forwardCheckExit, revertCommit, evidenceCommand}]}.',
        ].join('\n'),
        { label: 'retention ' + r.suggestionId + ' #' + (index + 1), phase: 'Retention', agentType: 'fix-author', schema: RETENTION_SCHEMA, effort: 'medium' },
      );
      if (!v) { skip(r.suggestionId, 'retention check returned no result'); return null; }
      noteSession(v);
      if (v.verdict === 'inconclusive') { skip(r.suggestionId, 'retention inconclusive: ' + v.reason); return null; }
      const repos = v.repos || [];
      if (v.verdict === 'retained') {
        if (!repos.length || !repos.every((x) => x.ancestorExit === 0)) { skip(r.suggestionId, 'retained claimed without merge-base --is-ancestor exit 0 for every repo; not recorded'); return null; }
        return { due: r, result: v };
      }
      // retained=false is a regression claim. The refuter cannot run git, so it judges only whether the reported evidence
      // is internally consistent with the workspace files it can Read; git state it cannot see is not grounds to refute.
      const verdict = await agent(
        [
          'You are an adversarial refuter for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Lens: correctness. Judge whether the claim that suggestion ' + r.suggestionId + ' was NOT retained 30 days after merge is INTERNALLY CONSISTENT. You cannot run git; do not refute merely because git history or ancestry cannot be checked from files - list that under unverifiable instead.',
          'Claim (from a fix-author that ran merge-base --is-ancestor and apply --check):\n' + JSON.stringify(v, null, 1),
          'Suggestion entry as scouted: ' + JSON.stringify(r),
          'Refute ONLY when the evidence contradicts itself or the workspace: headCommit does not equal or start with the pinnedCommit in applications/<appId>/repos/<repoId>.json; headCommittedAt is earlier than mergedAt + 30 days; a repo is marked not an ancestor while ancestorExit is not 1, or evidenceCommand does not name merge-base --is-ancestor with the mergeCommit from ' + SUG_MASTER + '; a claimed revertCommit comes without forwardCheckExit 0 and a non-zero reverseCheckExit; or the diff post-image (+ lines of the registered diff) is still present, and its removed lines absent, in the checkout files at HEAD that you can Read while the claim relies on a revert. Otherwise refuted=false.',
          'Return {refuted, confidence, lens: "correctness", reason, checked, unverifiable}.',
        ].join('\n'),
        { label: 'refute retention ' + r.suggestionId, phase: 'Retention', agentType: 'refuter', schema: VERDICT_SCHEMA, effort: 'high' },
      );
      if (!verdict) { skip(r.suggestionId, 'refuter returned no verdict on retained=false; not recorded'); return null; }
      noteSession(verdict);
      if (verdict.refuted) { skip(r.suggestionId, 'retained=false claim is internally inconsistent: ' + verdict.reason); return null; }
      for (const u of verdict.unverifiable || []) log(r.suggestionId + ' retention (not verifiable from files): ' + u);
      return { due: r, result: v };
    },
  );
  retentionResults.push(...checks.filter(Boolean));
  if (retentionResults.length) {
    const w = await agent(
      [
        'You are the validator recording 30-day retention results for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' section 7 and .claude/schemas/v1/suggestions/master.schema.json.',
        'Edit ' + SUG_MASTER + ' in place for exactly these suggestion ids (never reorder or delete entries): set retentionCheckedAt = NOW and retained = (verdict == "retained"). When a revertCommit was proven for every repo of a not-retained suggestion, also move status merged -> reverted with revertedAt = the revert commit time given in reason when stated, else NOW, and repos[].revertCommit; otherwise keep status merged. Set updatedAt = NOW and the index-level provenance.',
        'Results:\n' + JSON.stringify(retentionResults.map((x) => ({ suggestionId: x.result.suggestionId, verdict: x.result.verdict, reason: x.result.reason, repos: x.result.repos })), null, 1),
        timeRule(), provenanceRule('validator'),
        'Run node .claude/scripts/validate-data.mjs ' + SUG_MASTER + ' until green (content fixes only). Return {updated (suggestion ids), validationGreen, schemaIssues, skipped}.',
      ].join('\n'),
      { label: 'record retention', phase: 'Retention', agentType: 'validator', schema: MASTER_WRITE_SCHEMA, effort: 'low' },
    );
    if (!w) skip(null, 'validator returned no result; retention results not recorded');
    else {
      noteSession(w);
      for (const x of w.skipped || []) skip(null, 'retention write: ' + x);
      for (const x of w.schemaIssues || []) skip(null, 'schema issue: ' + x);
      log('retention recorded for ' + (w.updated || []).length + ' suggestion(s)' + (w.validationGreen ? '' : ' (validation NOT green)'));
    }
  }
}

// ---- Phase 8: Summary -----------------------------------------------------------------------------------------
phase('Summary');
let summary = null;
const lifecycleChanged = recheckWrites.merged.length + recheckWrites.reverted.length;
if (dryRun) {
  log('dry-run: summary.md left unchanged');
} else if (!registered.length && !retentionResults.length && !lifecycleChanged) {
  log('no suggestion registered, no merge/revert and no retention result; summary.md left unchanged');
} else {
  summary = await agent(
    [
      'You are the report-writer. Rewrite ONLY the "suggestions" section (## Suggestions) of ' + PROFILE + '/summary.md after the ' + WORKFLOW + ' workflow (an early refresh per report-templates; report-audit-improvements remains the owner of record). Read .claude/skills/report-templates/SKILL.md (sections 1, 2, 4 Suggestions and 5) and ' + SKILL_CONV + ' first.',
      'Source of truth: ' + SUG_MASTER + ' (every entry), ' + LEDGER + ' for finding titles, and kpis/measurement/suggestion_acceptance_rate.md for how acceptance, merge, revert and 30-day retention are computed. Render the table (include every entry with status proposed or surfaced so reviewers see them), the acceptance figures and the ### Rejections list exactly as the template says. New this run: ' + JSON.stringify(registered.map((r) => r.suggestion.suggestionId)) + '; merged: ' + JSON.stringify(recheckWrites.merged.map((x) => x.suggestionId)) + '; reverted: ' + JSON.stringify(recheckWrites.reverted.map((x) => x.suggestionId)) + '; retention recorded: ' + JSON.stringify(retentionResults.map((x) => x.result.suggestionId)) + '.',
      'Leave every other section byte-for-byte unchanged; update the frontmatter (version minor bump, sections in canonical order, provenance with workflow ' + WORKFLOW + ', inputsHash recomputed per the template). Do not create any other file. Every number must be countable from ' + SUG_MASTER + '.',
      timeRule(), provenanceRule('report-writer'),
      'Validate with node .claude/scripts/validate-data.mjs ' + PROFILE + '/summary.md. Return {updated, listedSuggestionIds (every sug_ id that now appears in the section), version, inputsHash, acceptanceRate, notes}.',
    ].join('\n'),
    { label: 'summary suggestions', phase: 'Summary', agentType: 'report-writer', schema: SUMMARY_SCHEMA, effort: 'medium' },
  );
  if (!summary) skip(null, 'report-writer returned no result; suggestions section may be stale and nothing is surfaced');
  else { noteSession(summary); log('summary.md suggestions section ' + (summary.updated ? 'rewritten' : 'unchanged') + ', ' + (summary.listedSuggestionIds || []).length + ' suggestion(s) listed'); }
}

// ---- Phase 9: Surface ---------------------------------------------------------------------------------------------
phase('Surface');
let surfacedIds = [];
const toSurface = summary && summary.updated ? registered.map((r) => r.suggestion.suggestionId).filter((id) => (summary.listedSuggestionIds || []).includes(id)) : [];
for (const r of registered) if (!toSurface.includes(r.suggestion.suggestionId)) skip(r.suggestion.suggestionId, 'not listed in summary.md; stays proposed');
if (toSurface.length) {
  const s = await agent(
    [
      'You are the validator surfacing suggestions for the ' + WORKFLOW + ' workflow, company ' + companyId + '. Read ' + SKILL_DIFF + ' section 7 and .claude/schemas/v1/suggestions/master.schema.json.',
      'These suggestions were just shown to humans in the ## Suggestions section of ' + PROFILE + '/summary.md: ' + JSON.stringify(toSurface) + '. Verify each id appears in that section, then in ' + SUG_MASTER + ' move each from status proposed to surfaced with surfacedAt = NOW (leave prUrls as they are; add nothing else). Ignore ids whose status is no longer proposed and list them in skipped. Set updatedAt = NOW and the index-level provenance.',
      timeRule(), provenanceRule('validator'),
      'Run node .claude/scripts/validate-data.mjs ' + SUG_MASTER + ' until green. Return {surfacedIds, validationGreen, schemaIssues, skipped}.',
    ].join('\n'),
    { label: 'surface', phase: 'Surface', agentType: 'validator', schema: SURFACE_SCHEMA, effort: 'low' },
  );
  if (!s) skip(null, 'validator returned no result; suggestions stay proposed');
  else {
    noteSession(s);
    surfacedIds = s.surfacedIds || [];
    for (const x of s.skipped || []) skip(null, 'surface: ' + x);
    for (const x of s.schemaIssues || []) skip(null, 'schema issue: ' + x);
    log(surfacedIds.length + ' suggestion(s) surfaced');
  }
} else {
  log('nothing to surface');
}

log('done: ' + registered.length + ' suggestion(s) registered, ' + surfacedIds.length + ' surfaced, ' + recheckResults.length + ' re-checked (' + recheckWrites.merged.length + ' merged, ' + recheckWrites.reverted.length + ' reverted), ' + retentionResults.length + ' retention result(s), ' + skipped.length + ' skipped item(s) logged');
return {
  companyId,
  workflow: WORKFLOW,
  dryRun,
  targets: candidates.map((c) => c.findingId + '@' + c.appId + '/' + c.repoId + ':' + c.path),
  observations: linked.observationIds.length,
  findings: linked.findingIds.length,
  risks: 0,
  initiatives: 0,
  suggestions: registered.length,
  surfaced: surfacedIds.length,
  rechecked: recheckResults.length,
  retentionChecked: retentionResults.length,
  ids: {
    suggestionIds: registered.map((r) => r.suggestion.suggestionId),
    surfacedIds,
    merged: recheckWrites.merged.map((x) => x.suggestionId),
    reverted: recheckWrites.reverted.map((x) => x.suggestionId),
    recheck: recheckResults,
    retention: retentionResults.map((x) => ({ suggestionId: x.result.suggestionId, retained: x.result.verdict === 'retained' })),
    findingIds: linked.findingIds,
    observationIds: linked.observationIds,
  },
  summary,
  skipped,
  sessionIds: [...sessionIds],
};
