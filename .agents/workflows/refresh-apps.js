// refresh-apps: keep applications/<app_id>/ current. For every application of the company it syncs Maxwell's gitignored
// checkout of each repo to the remote default branch, re-derives the repo record (pinnedCommit, lastFetchedAt, languages,
// build and CI system, manifests, IaC/Helm/agent-code/CODEOWNERS flags), and compares the environment files, image
// records and credential references with what the checkouts now show. Drift and gaps become soc observations.
// Shape: Scout (applications, repos, environments, images, credential keys in scope) -> Sync (pipeline per repo:
// app-cataloguer clones or fast-forwards the checkout and PROPOSES the refreshed repo record plus image and IaC facts;
// it never pushes, never edits files in the checkout and never writes workspace files) -> Review (pipeline per
// application: app-cataloguer compares env files, image records and credential references with the repo facts and
// proposes gaps) -> Verify (refuter lenses evidence and regulatory-mapping over record regressions and gaps; majority,
// unanimity for regressions that remove a language, manifest or flag) -> Write (validator writes the confirmed repo
// records) -> Ledger (soc-ledger-keeper appends one observation per repo plus one per confirmed gap group) -> Summary
// (report-writer rewrites the applications section and proposes its report observation) -> Version (soc-ledger-keeper
// appends that observation, then soc/version.mjs runs once).
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
// Environment files, image records, credentials.json and application README files are never rewritten here: they carry
// human decisions (tier, exposure, probe access, encrypted references), so drift is recorded for a human to apply.
// Nothing is deleted: a repo whose remote is gone keeps its record and gets a checkout-unavailable observation.
// dryRun performs no clone or fetch and writes no file: it lists what would be synced and records only 'inconclusive'
// evidence-request observations.
export const meta = {
  name: 'refresh-apps',
  description: 'Sync app repo checkouts, refresh repo records, check env, image and credential drift, refute, write, ledger gaps. args: companyId, appIds, envIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Scout', detail: 'Applications, repo records, environments, images and credential keys in scope' },
    { title: 'Sync', detail: 'One app-cataloguer per repo syncs the checkout and proposes the refreshed repo record (no workspace writes)' },
    { title: 'Review', detail: 'One app-cataloguer per application compares env files, images and credential references with repo facts' },
    { title: 'Verify', detail: 'refuter lenses evidence and regulatory-mapping over record regressions and gap batches' },
    { title: 'Write', detail: 'validator writes the confirmed repo records and validates each file' },
    { title: 'Ledger', detail: 'soc-ledger-keeper appends one observation per repo plus one per confirmed gap group' },
    { title: 'Summary', detail: 'report-writer rewrites the applications section of summary.md and proposes its report observation' },
    { title: 'Version', detail: 'soc-ledger-keeper appends the report observation, then soc/version.mjs writes versions/commit_<n>.diff' },
  ],
};

const WORKFLOW = 'refresh-apps';
const a = args || {};
const companyId = a.companyId;
if (typeof companyId !== 'string' || !companyId) throw new Error('refresh-apps: args.companyId is required (company-profile/<companyId>)');
const dryRun = a.dryRun === true;
const NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
let now = typeof a.now === 'string' && a.now ? a.now : null;
if (now && !NOW_RE.test(now)) throw new Error('refresh-apps: args.now must be an RFC 3339 UTC timestamp with a trailing Z');
const sessionId = typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : null;
const runId = typeof a.runId === 'string' && a.runId ? a.runId : null;
const appIds = Array.isArray(a.appIds) && a.appIds.length ? a.appIds : null;
const envIds = Array.isArray(a.envIds) && a.envIds.length ? a.envIds : null;

const PROFILE = `company-profile/${companyId}/details.json`;
const LEDGER = `company-profile/${companyId}/soc/main.jsonl`;
const SUMMARY = `company-profile/${companyId}/summary.md`;
const REPO_SCHEMA = '.claude/schemas/v1/application/repo.schema.json';
const ENV_SCHEMA = '.claude/schemas/v1/application/environment.schema.json';
const IMAGE_SCHEMA = '.claude/schemas/v1/application/image.schema.json';
const SLA_TABLE = '.claude/skills/regulatory-catalogs/references/sla-table.json';

const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };

const common = (agentName) => `Company: ${companyId}. Workflow: ${WORKFLOW}. You are the '${agentName}' specialist.
Read .claude/skills/maxwell-conventions/SKILL.md first.
TIME: NOW = '${now}' (resolved once by the workflow; never read a clock or guess a date). Use it for lastFetchedAt, recordedAt, collectedAt and provenance.generatedAt.
PROVENANCE on every record or file you write: harness = the harness you run on ('claude-code' or 'opencode'), generatedAt = NOW, sessionId = ${sessionId || 'your own harness session id (never invent one)'}, ${runId ? `runId = '${runId}'` : 'runId = MAXWELL_RUN_ID when set, otherwise omit runId'}, workflow = '${WORKFLOW}', agent = '${agentName}'.
Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (never open ${LEDGER} for writing); every other file write must pass \`node .claude/scripts/validate-data.mjs <path>\` before you report success.
Read-only against targets: never push, never create branches, tags or commits, never edit a file inside an applications/<app_id>/repos/<repo_id>/ checkout, never print a token, credential value or URL with embedded credentials. Credential references are resolved only with \`node .claude/scripts/creds/sops.mjs get <app_id> <key>\` (a locator, never a value).
${appIds ? `Scope: applications ${JSON.stringify(appIds)} only.` : ''} ${envIds ? `Environments ${JSON.stringify(envIds)} only.` : ''}
${dryRun ? 'DRY RUN: no clone, no fetch, no checkout and no file write in this stage.' : ''}`;

// ---------------------------------------------------------------- Scout
phase('Scout');
if (!now) {
  const clock = await agent(`Company: ${companyId}. Workflow: ${WORKFLOW}. You are the 'soc-ledger-keeper' specialist, used here only as the workflow clock: read nothing, write nothing, append nothing.
Run exactly once: node -e "console.log(new Date(Date.parse(Date())).toISOString().slice(0,19)+'Z')"
Return its output verbatim as now.`, { label: 'clock', phase: 'Scout', agentType: 'soc-ledger-keeper', effort: 'low', schema: { type: 'object', required: ['now'], properties: { sessionId: { type: 'string' }, now: { type: 'string' } } } });
  if (!clock || typeof clock.now !== 'string' || !NOW_RE.test(clock.now.trim())) throw new Error(`refresh-apps: could not resolve NOW (clock returned ${JSON.stringify(clock && clock.now)}); pass args.now and re-run`);
  noteSession(clock);
  now = clock.now.trim();
}
log(`NOW = ${now} (${a.now ? 'args.now' : 'read once by the clock step'}); every prompt uses this literal`);

const SCOUT_SCHEMA = {
  type: 'object',
  required: ['frameworksInScope', 'applications', 'existingControlIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    frameworksInScope: { type: 'array', items: { type: 'string' } },
    applications: {
      type: 'array',
      items: {
        type: 'object',
        required: ['appId', 'repos', 'environments', 'images', 'credentialsPresent'],
        properties: {
          appId: { type: 'string' },
          repos: { type: 'array', items: { type: 'object', required: ['repoId', 'recordPath', 'url', 'defaultBranch', 'checkoutPresent'], properties: { repoId: { type: 'string' }, recordPath: { type: 'string' }, url: { type: 'string' }, defaultBranch: { type: 'string' }, pinnedCommit: { type: 'string' }, lastFetchedAt: { type: 'string' }, localCheckout: { type: 'string' }, checkoutPresent: { type: 'boolean' } } } },
          environments: { type: 'array', items: { type: 'object', required: ['envId', 'path', 'tier'], properties: { envId: { type: 'string' }, path: { type: 'string' }, tier: { type: 'string' }, exposure: { type: 'string' }, probeMethod: { type: 'string' }, probeCredentialKey: { type: 'string' }, iac: { type: 'array', items: { type: 'object', properties: { repoId: { type: 'string' }, path: { type: 'string' }, tool: { type: 'string' } } } } } } },
          images: { type: 'array', items: { type: 'object', required: ['imageId', 'path', 'ref'], properties: { imageId: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' }, builtFromRepoId: { type: 'string' }, sbomPath: { type: 'string' } } } },
          credentialsPresent: { type: 'boolean' },
        },
      },
    },
    existingControlIds: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', required: ['target', 'reason'], properties: { target: { type: 'string' }, reason: { type: 'string' } } } },
  },
};
const scout = await agent(`${common('app-cataloguer')}
SCOUT (read-only, write nothing, run no git command). Read ${PROFILE} (frameworksInScope) and ${LEDGER} if it exists (ids of the latest kind 'control' records).
APPLICATION-TO-COMPANY RULE (deterministic; no application schema carries companyId, so never infer the link from README prose or hosting.accountRef): when company-profile/ contains exactly one company directory every applications/<app_id>/ belongs to it; otherwise the company's applications are the union of ${PROFILE} criticalFunctions[].appIds${appIds ? ` and ${JSON.stringify(appIds)} (args.appIds)` : ''}. List every other applications/<app_id>/ under skipped with reason 'no company link'.${appIds ? ` Of the linked applications keep only ${JSON.stringify(appIds)}; list every other one under skipped with reason 'filtered by args.appIds'.` : ''}
For each kept application return: every repos/<repo_id>.json (repoId, recordPath, url, defaultBranch, pinnedCommit, lastFetchedAt, localCheckout, checkoutPresent = the checkout directory exists and contains a .git entry), every env/<env_id>.json${envIds ? ` whose envId is in ${JSON.stringify(envIds)} (others under skipped with reason 'filtered by args.envIds')` : ''} (envId, path, tier, exposure, probeMethod = probeAccess.method, probeCredentialKey = probeAccess.credentialKey, iac[]), every images/<image_id>.json that is not a .cdx.json (imageId, path, ref, builtFromRepoId = builtFrom.repoId, sbomPath), and credentialsPresent = credentials.json exists. Never decrypt or open credentials.json content. Nothing is dropped silently: every exclusion goes to skipped.`, { label: 'scout', phase: 'Scout', agentType: 'app-cataloguer', schema: SCOUT_SCHEMA, effort: 'low' });
if (!scout) throw new Error('refresh-apps: Scout returned nothing; cannot continue');
noteSession(scout);
for (const x of scout.skipped || []) skipped.push(`scout: ${x.target} - ${x.reason}`);
const apps = scout.applications || [];
const allRepos = apps.flatMap((app) => app.repos.map((r) => ({ ...r, appId: app.appId })));
log(`Scout: ${apps.length} application(s), ${allRepos.length} repo record(s) (${allRepos.filter((r) => r.checkoutPresent).length} with checkout), ${apps.reduce((n, x) => n + x.environments.length, 0)} environment file(s), ${apps.reduce((n, x) => n + x.images.length, 0)} image record(s)`);

const result = { companyId, workflow: WORKFLOW, dryRun, targets: allRepos.map((r) => `${r.appId}/${r.repoId}`), reposSynced: 0, reposAdvanced: 0, recordsWritten: 0, regressionsProposed: 0, regressionsConfirmed: 0, gapsProposed: 0, gapsConfirmed: 0, observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, versionFile: '', summaryUpdated: false, skipped, sessionIds: [] };
if (!allRepos.length) {
  log('Quiet exit: no application repo record in scope; nothing to refresh.');
  result.sessionIds = [...sessionIds];
  return result;
}

// ---------------------------------------------------------------- Sync (pipeline per repo)
const REG_REF = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const GAP_KINDS = ['checkout-unavailable', 'default-branch-changed', 'visibility-changed', 'codeowners-missing', 'untracked-repo', 'image-untracked', 'image-digest-unknown', 'image-sbom-missing', 'env-iac-drift', 'env-url-drift', 'probe-credential-missing', 'credentials-unverifiable', 'credential-rotation-overdue', 'evidence-request'];
const GAP = { type: 'object', required: ['kind', 'target', 'detail', 'evidence'], properties: { kind: { type: 'string', enum: GAP_KINDS }, target: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, regulatoryRefs: { type: 'array', items: REG_REF } } };
const REPO_FIELDS = ['defaultBranch', 'visibility', 'pinnedCommit', 'lastFetchedAt', 'languages', 'buildSystem', 'ciSystem', 'packageManifests', 'containsIac', 'containsHelmChart', 'containsAgentCode', 'codeownersPresent', 'branchProtection', 'localCheckout'];
const SYNC_SCHEMA = {
  type: 'object',
  required: ['appId', 'repoId', 'synced', 'previousCommit', 'headCommit', 'recordUpdate', 'imageRefs', 'iacFacts', 'gaps', 'sources'],
  properties: {
    sessionId: { type: 'string' },
    appId: { type: 'string' },
    repoId: { type: 'string' },
    synced: { type: 'boolean', description: 'true when the checkout now matches the remote default branch head' },
    previousCommit: { type: 'string' },
    headCommit: { type: 'string' },
    commitsAdvanced: { type: 'integer' },
    recordUpdate: { type: 'object', description: `Proposed values for these repo record fields only, each evidenced by the checkout: ${REPO_FIELDS.join(', ')}. Omit a field you could not establish.`, properties: {} },
    imageRefs: { type: 'array', description: 'Container images this repo builds or deploys', items: { type: 'object', required: ['ref', 'source'], properties: { ref: { type: 'string' }, source: { type: 'string', description: 'checkout-relative path:line' }, built: { type: 'boolean', description: 'true when a Dockerfile in this repo builds it' }, digest: { type: 'string' } } } },
    iacFacts: { type: 'array', description: 'Deployment facts IaC or manifests in this repo state', items: { type: 'object', required: ['kind', 'value', 'source'], properties: { kind: { type: 'string', enum: ['namespace', 'cluster', 'region', 'hostname', 'url', 'iac-path', 'secrets-backend', 'log-retention-days'] }, value: { type: 'string' }, envHint: { type: 'string' }, source: { type: 'string' } } } },
    gaps: { type: 'array', items: GAP },
    sources: { type: 'array', items: { type: 'string' } },
  },
};

const syncPrompt = (r) => `${common('app-cataloguer')}
${dryRun ? 'DRY RUN PLAN' : 'SYNC AND DESCRIBE'} repo '${r.appId}/${r.repoId}' (record ${r.recordPath}, remote ${r.url}, default branch ${r.defaultBranch}, recorded pinnedCommit ${r.pinnedCommit || 'none'}, checkout ${r.localCheckout || `applications/${r.appId}/repos/${r.repoId}`}, checkout present: ${r.checkoutPresent}). PROPOSE ONLY: you do not write ${r.recordPath}; a validator writes it after verification.
Read ${REPO_SCHEMA} (its example is the reference shape) and the current record.
${dryRun
    ? `Run no git command. Return synced false, previousCommit = the recorded pinnedCommit (or ''), headCommit '', recordUpdate {}, imageRefs [], iacFacts [], and one gap of kind 'evidence-request' describing the clone or fetch this repo needs and any credential it would require.`
    : `1. Sync the checkout to the remote default branch, read-only towards the remote:
   - checkout absent: \`git clone --depth 50 --branch ${r.defaultBranch} ${r.url} applications/${r.appId}/repos/${r.repoId}\`;
   - checkout present: \`git -C applications/${r.appId}/repos/${r.repoId} fetch --depth 50 origin ${r.defaultBranch}\` then \`git -C applications/${r.appId}/repos/${r.repoId} checkout --detach FETCH_HEAD\`.
   If the remote default branch no longer exists, run \`git ls-remote --symref ${r.url} HEAD\` and propose defaultBranch from it (gap default-branch-changed). If the remote is unreachable or needs credentials you do not have, stop syncing, return synced false and gap checkout-unavailable with the git error text (redact anything that looks like a credential).
2. previousCommit = the recorded pinnedCommit; headCommit = \`git -C <checkout> rev-parse HEAD\`; commitsAdvanced from \`git -C <checkout> rev-list --count <previousCommit>..HEAD\` when previousCommit is still in the fetched history (omit otherwise).
3. recordUpdate: pinnedCommit = headCommit, lastFetchedAt = NOW, and every other field in ${JSON.stringify(REPO_FIELDS)} you can establish from the checkout at HEAD with the schema's enums: languages from file extensions of tracked files (\`git ls-files\`), buildSystem and packageManifests from lockfiles and manifests, ciSystem from CI definitions, containsIac (Terraform, OpenTofu, CloudFormation, Pulumi, Ansible, CDK), containsHelmChart (Chart.yaml or kustomization), containsAgentCode (LLM SDK imports, MCP server definitions, agent or harness configs), codeownersPresent (CODEOWNERS in root, .github or docs). visibility only when the host tells you without credentials. branchProtection only from evidence you can read without credentials; otherwise omit it (never guess). Keep a value unchanged by omitting it when the checkout gives no evidence either way.
4. imageRefs: every image a Dockerfile, compose file, Helm values, Kubernetes manifest or CI job in this repo builds, pulls or deploys, with source path:line, built true for images this repo's Dockerfiles produce, digest only when written in the file.
5. iacFacts: namespaces, clusters, regions, public hostnames and URLs, IaC root paths, secrets backends and log retention settings the IaC, charts or manifests declare, with source path:line and envHint when a file names an environment (dev, qa, prod, ...).
6. gaps: default-branch-changed, visibility-changed, codeowners-missing (repos with containsIac, containsHelmChart or containsAgentCode and no CODEOWNERS), untracked-repo (submodules or CI jobs that check out another repository that has no record under applications/), each with checkout-relative evidence and regulatoryRefs citing the most specific Indian asset-inventory or change-management control of ${JSON.stringify(scout.frameworksInScope)} first.`}
sources: the checkout-relative files you read.`;

phase('Sync');
const synced = await pipeline(allRepos, async (r, _item, index) => {
  const out = await agent(syncPrompt(r), { label: `sync ${r.appId}/${r.repoId} #${index + 1}`, phase: 'Sync', agentType: 'app-cataloguer', schema: SYNC_SCHEMA, effort: dryRun ? 'low' : 'medium' });
  if (!out) { skipped.push(`sync: ${r.appId}/${r.repoId} returned nothing (agent failed or was skipped); its record is left unchanged`); return null; }
  noteSession(out);
  if (out.synced) result.reposSynced += 1;
  if (out.synced && out.headCommit && out.previousCommit && out.headCommit !== out.previousCommit) result.reposAdvanced += 1;
  log(`${r.appId}/${r.repoId}: synced ${out.synced}, ${out.previousCommit ? out.previousCommit.slice(0, 7) : 'none'} -> ${out.headCommit ? out.headCommit.slice(0, 7) : 'none'}${typeof out.commitsAdvanced === 'number' ? ` (+${out.commitsAdvanced})` : ''}, ${(out.imageRefs || []).length} image ref(s), ${(out.iacFacts || []).length} IaC fact(s), ${(out.gaps || []).length} gap(s)`);
  return { repo: r, out };
});
const perRepo = synced.filter(Boolean);

// ---------------------------------------------------------------- Review (pipeline per application)
const REVIEW_SCHEMA = { type: 'object', required: ['appId', 'gaps'], properties: { sessionId: { type: 'string' }, appId: { type: 'string' }, gaps: { type: 'array', items: GAP }, notes: { type: 'string' } } };
const reviewPrompt = (app, repoOuts) => `${common('app-cataloguer')}
${dryRun ? 'DRY RUN REVIEW' : 'REVIEW'} application '${app.appId}' (read-only; write nothing; run no git command). Read ${ENV_SCHEMA}, ${IMAGE_SCHEMA}, ${SLA_TABLE} and applications/${app.appId}/README.md.
Environment files: ${JSON.stringify(app.environments)}
Image records: ${JSON.stringify(app.images)}
Credentials file present: ${app.credentialsPresent}
Repo facts from the Sync stage: ${JSON.stringify(repoOuts.map(({ repo, out }) => ({ repoId: repo.repoId, synced: out.synced, headCommit: out.headCommit, imageRefs: out.imageRefs, iacFacts: out.iacFacts })))}
${dryRun
    ? `Return only 'evidence-request' gaps: one per environment whose probe credential reference cannot be checked without a live run, and one per image record whose digest or SBOM would need a registry lookup.`
    : `Propose gaps, each with evidence (workspace path or checkout-relative path:line under applications/${app.appId}/repos/) and regulatoryRefs (most specific Indian asset-inventory, configuration or credential-management control of ${JSON.stringify(scout.frameworksInScope)} first):
- env-iac-drift: an environment file's hosting.namespace, hosting.cluster, hosting.region, secretsBackend or iac[].path disagrees with an iacFacts entry whose envHint matches that environment (or the only environment of that tier). Name both values.
- env-url-drift: a public hostname or URL in iacFacts for an environment is missing from that environment's urls, or an environment URL no longer appears in any repo.
- image-untracked: an imageRefs entry with built true, or deployed to a recorded environment, has no image record under applications/${app.appId}/images/ (image records need a digest, so propose, never create one).
- image-digest-unknown: an image record whose ref has no digest pin while the repo deploys it by tag.
- image-sbom-missing: an image record whose sbomPath file does not exist or is empty ({} or zero components).
- probe-credential-missing: an environment whose probeAccess.method is not 'none' and whose credentialKey has no entry: check with \`node .claude/scripts/creds/sops.mjs get ${app.appId} <credentialKey>\`. If that command fails because no decryption key is available (not because the entry is missing), propose one credentials-unverifiable gap for the application instead and do not guess.
- credential-rotation-overdue: when sops.mjs get succeeds, an entry whose rotation.nextRotationAt is before NOW.
Never print a credential locator's secret material; the locator itself (an env var name, vault path or ARN) may be quoted.`}`;

phase('Review');
const appsWithRepos = apps.filter((app) => perRepo.some((p) => p.repo.appId === app.appId));
for (const app of apps.filter((x) => !appsWithRepos.includes(x))) skipped.push(`review: ${app.appId} has no synced repo output; environment, image and credential drift not reviewed`);
const reviewed = await pipeline(appsWithRepos, async (app, _item, index) => {
  const out = await agent(reviewPrompt(app, perRepo.filter((p) => p.repo.appId === app.appId)), { label: `review ${app.appId} #${index + 1}`, phase: 'Review', agentType: 'app-cataloguer', schema: REVIEW_SCHEMA, effort: dryRun ? 'low' : 'medium' });
  if (!out) { skipped.push(`review: ${app.appId} returned nothing; environment, image and credential drift not reviewed`); return null; }
  noteSession(out);
  return { appId: app.appId, gaps: out.gaps || [] };
});

// Regressions: a proposed record value that removes information the record holds (a language, manifest or true flag
// becoming false) needs every lens to agree before it is written; additions and commit moves need a majority.
const regressions = [];
const recordChanges = [];
for (const { repo, out } of perRepo) {
  const update = out.synced ? { ...(out.recordUpdate || {}) } : {};
  if (!Object.keys(update).length) { if (!out.synced) skipped.push(`write: ${repo.appId}/${repo.repoId} not synced; record left unchanged`); continue; }
  recordChanges.push({ repo, update, headCommit: out.headCommit });
}
for (const c of recordChanges) regressions.push({ key: `reg-${regressions.length + 1}`, appId: c.repo.appId, repoId: c.repo.repoId, recordPath: c.repo.recordPath, proposed: c.update, note: 'Any language, packageManifests entry or true boolean in the current record that this proposal removes or sets false is a regression' });
result.regressionsProposed = regressions.length;

const gapCandidates = [];
const gapSeen = new Set();
for (const g of [...perRepo.flatMap(({ repo, out }) => (out.gaps || []).map((x) => ({ ...x, appId: repo.appId, repoId: repo.repoId }))), ...reviewed.filter(Boolean).flatMap((r) => r.gaps.map((x) => ({ ...x, appId: r.appId })))]) {
  const key = `${g.appId}|${g.kind}|${g.target}`;
  if (gapSeen.has(key)) continue;
  gapSeen.add(key);
  gapCandidates.push({ ...g, key: `gap-${gapCandidates.length + 1}` });
}
result.gapsProposed = gapCandidates.length;
log(`Review: ${recordChanges.length} repo record update(s) proposed, ${gapCandidates.length} gap candidate(s)`);

// ---------------------------------------------------------------- Verify
phase('Verify');
const LENSES = ['evidence', 'regulatory-mapping'];
const BATCH_VERDICT = { type: 'object', required: ['verdicts'], properties: { sessionId: { type: 'string' }, verdicts: { type: 'array', items: { type: 'object', required: ['key', 'refuted', 'reason'], properties: { key: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' }, rejectedFields: { type: 'array', items: { type: 'string' } }, correctedRegulatoryRefs: { type: 'array', items: REG_REF } } } } } };
const refutePrompt = (kind, appId, batch, lens) => `${common('refuter')}
Lens '${lens}'. Try to REFUTE each ${kind === 'records' ? 'proposed repo record update' : 'application gap'} below for application '${appId}' of ${companyId}; default to refuted=true when the checkout under applications/${appId}/repos/ or the named workspace file does not show it. Read only; never write; run only read-only git commands (\`git -C <checkout> log|show|ls-files|rev-parse\`).
${kind === 'records'
    ? (lens === 'evidence'
      ? 'evidence: for each proposal compare every field with the current record at recordPath and with the checkout at the proposed pinnedCommit. Return rejectedFields for values the checkout does not support. A proposal that removes a language, a packageManifests entry or sets a true flag to false is refuted unless the checkout at HEAD clearly lacks it.'
      : 'regulatory-mapping: records carry no regulatory references; refute only a proposal whose values break the repo schema enums or patterns (list them in rejectedFields), otherwise do not refute.')
    : (lens === 'evidence'
      ? 'evidence: open each evidence path; the file must actually show the drift, missing record, missing credential entry or overdue rotation the gap claims. A gap whose evidence is unreadable is refuted.'
      : `regulatory-mapping: every regulatoryRef instrument applies to this company (${JSON.stringify(scout.frameworksInScope)}) and the controlId exists in its catalog under .claude/skills/regulatory-catalogs/references/catalogs/; return correctedRegulatoryRefs when repairable instead of refuting.`)}
Return exactly one verdict per candidate keyed by its "key".
Candidates: ${JSON.stringify(batch)}`;

const byApp = (items) => [...new Set(items.map((x) => x.appId))].map((appId) => ({ appId, items: items.filter((x) => x.appId === appId) }));
const judge = async (kind, groups, unanimous) => {
  if (dryRun) return groups.flatMap((g) => g.items).map((item) => ({ item, answers: [] }));
  const out = await pipeline(groups, async (g, _item, index) => {
    const votes = await parallel(LENSES.map((lens) => () => agent(refutePrompt(kind, g.appId, g.items, lens), { label: `refute ${kind} ${g.appId} (${g.items.length}) [${lens}] #${index + 1}`, phase: 'Verify', agentType: 'refuter', schema: BATCH_VERDICT, effort: 'medium' })));
    votes.forEach(noteSession);
    LENSES.forEach((lens, i) => { if (!votes[i]) skipped.push(`verify: lens ${lens} returned nothing for ${kind} of ${g.appId}; counted as abstention`); });
    return g.items.map((item) => ({ item, answers: votes.map((v, i) => { const x = v ? (v.verdicts || []).find((y) => y.key === item.key) : null; return x ? { ...x, lens: LENSES[i] } : null; }).filter(Boolean), unanimous }));
  });
  return out.filter(Boolean).flat();
};

const recordVerdicts = await judge('records', byApp(regressions), true);
const confirmedRecords = [];
for (const { item, answers } of recordVerdicts) {
  const change = recordChanges.find((c) => c.repo.recordPath === item.recordPath);
  if (dryRun) continue;
  const refutations = answers.filter((x) => x.refuted);
  const rejected = [...new Set(answers.flatMap((x) => x.rejectedFields || []))];
  const update = { ...change.update };
  for (const f of rejected) if (f !== 'pinnedCommit' && f !== 'lastFetchedAt') delete update[f];
  if (answers.length < LENSES.length || refutations.length) {
    const keep = { pinnedCommit: change.update.pinnedCommit, lastFetchedAt: change.update.lastFetchedAt };
    if (answers.length < LENSES.length) skipped.push(`verify: ${item.appId}/${item.repoId} record update lacked a verdict from every lens; only pinnedCommit and lastFetchedAt are written`);
    else skipped.push(`verify: ${item.appId}/${item.repoId} record update refuted (${refutations.map((x) => `${x.lens}: ${x.reason}`).join(' | ')}); only pinnedCommit and lastFetchedAt are written`);
    if (keep.pinnedCommit) confirmedRecords.push({ ...change, update: keep });
    continue;
  }
  for (const f of rejected) skipped.push(`verify: ${item.appId}/${item.repoId} field ${f} rejected by a lens; left unchanged`);
  confirmedRecords.push({ ...change, update });
}
result.regressionsConfirmed = confirmedRecords.length;

const gapVerdicts = await judge('gaps', byApp(gapCandidates), false);
const confirmedGaps = [];
for (const { item, answers } of gapVerdicts) {
  if (dryRun) { confirmedGaps.push(item); continue; }
  const refutations = answers.filter((x) => x.refuted);
  if (answers.length < 2 || refutations.length) { skipped.push(`verify: gap ${item.kind} on ${item.target} not confirmed (${refutations.length} refuted of ${answers.length} answered): ${refutations.map((x) => `${x.lens}: ${x.reason}`).join(' | ') || 'missing verdicts'}`); continue; }
  const corrected = answers.find((x) => x.correctedRegulatoryRefs && x.correctedRegulatoryRefs.length);
  confirmedGaps.push(corrected ? { ...item, regulatoryRefs: corrected.correctedRegulatoryRefs } : item);
}
if (dryRun && gapCandidates.length) skipped.push('dry run: refutation skipped; every proposed gap is recorded only as an inconclusive evidence request');
result.gapsConfirmed = dryRun ? 0 : confirmedGaps.length;
log(`Verify: ${dryRun ? 'dry run' : `${confirmedRecords.length}/${recordChanges.length} record update(s) and ${confirmedGaps.length}/${gapCandidates.length} gap(s) confirmed`}`);

// ---------------------------------------------------------------- Write (validator writes repo records only)
phase('Write');
const WRITE_SCHEMA = { type: 'object', required: ['written', 'failures'], properties: { sessionId: { type: 'string' }, written: { type: 'array', items: { type: 'string' } }, failures: { type: 'array', items: { type: 'string' } }, schemaIssues: { type: 'array', items: { type: 'string' } } } };
if (dryRun) {
  skipped.push('dry run: no repo record written by design');
} else if (!confirmedRecords.length) {
  log('Write: no confirmed repo record update');
} else {
  for (const app of byApp(confirmedRecords.map((c) => ({ ...c, appId: c.repo.appId })))) {
    const w = await agent(`${common('validator')}
Read ${REPO_SCHEMA}. Update these repo records of application '${app.appId}' in place: for each file set exactly the listed fields to the listed values, keep every other field byte-identical in meaning, and set provenance as instructed (agent 'validator').
${JSON.stringify(app.items.map((c) => ({ recordPath: c.repo.recordPath, set: c.update })))}
Content rules: keys exactly as the schema names them, no extra keys; drop a listed value that violates its enum or pattern and name it under failures (never invent a replacement). Run \`node .claude/scripts/validate-data.mjs <path>\` for every file and fix content until it passes. Return {written: [paths that validate], failures, schemaIssues}.`, { label: `write repo records ${app.appId}`, phase: 'Write', agentType: 'validator', schema: WRITE_SCHEMA, effort: 'low' });
    if (!w) { skipped.push(`write: validator returned nothing for ${app.appId}; ${app.items.length} record(s) not written`); continue; }
    noteSession(w);
    result.recordsWritten += (w.written || []).length;
    for (const f of w.failures || []) skipped.push(`write ${app.appId}: ${f}`);
    for (const f of w.schemaIssues || []) skipped.push(`write schema issue: ${f}`);
  }
}

// ---------------------------------------------------------------- Ledger
phase('Ledger');
const LEDGER_SCHEMA = { type: 'object', required: ['observationIds', 'controlIds', 'skipped'], properties: { sessionId: { type: 'string' }, observationIds: { type: 'array', items: { type: 'string' } }, controlIds: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } } } };
const existingControlIds = scout.existingControlIds || [];
for (const app of [...new Set(perRepo.map((p) => p.repo.appId))]) {
  const appRepos = perRepo.filter((p) => p.repo.appId === app).map(({ repo, out }) => ({ repoId: repo.repoId, recordPath: repo.recordPath, synced: out.synced, previousCommit: out.previousCommit, headCommit: out.headCommit, commitsAdvanced: out.commitsAdvanced, recordWritten: !dryRun && confirmedRecords.some((c) => c.repo.recordPath === repo.recordPath) }));
  const appGaps = confirmedGaps.filter((g) => g.appId === app);
  if (dryRun && !existingControlIds.length) { skipped.push(`ledger ${app}: dry run and the ledger has no control record to cite; evidence-request observations not recorded`); continue; }
  const w = await agent(`${common('soc-ledger-keeper')}
Read .claude/skills/soc-ledger/SKILL.md sections 4, 5 and 9, ${PROFILE} and ${LEDGER}. Application '${app}'.
${dryRun
    ? `Step 1 - controls (READ-ONLY, dry run): cite only these existing ledger control ids: ${JSON.stringify(existingControlIds.slice(0, 200))}. Append NO control record; when none fits an observation, skip it with reason 'no existing control fits'.`
    : `Step 1 - controls: observations must cite control records that exist. Choose, from the instruments in ${JSON.stringify(scout.frameworksInScope)}, the most specific Indian controls for asset inventory (the SEBI CSCRF or RBI Directions 2026 asset-inventory clause for the company's entity type), configuration or change management for drift gaps, and credential or secrets management for credential gaps. If one is missing from the ledger (existing: ${JSON.stringify(existingControlIds.slice(0, 200))}), append it first from its catalog (id '<instrumentId>:<controlId>', frameworkRefs, title, implementationStatus 'unknown', effectiveness 'not-tested'); an instrument without a catalog file cannot be used.`}
Step 2 - one observation per repo: methods ['${WORKFLOW}'], subjects [{type:'repo', appId:'${app}', repoId}], controlIds [the asset-inventory control], collectedAt NOW, evidence [{type:'workspace-file', ref: recordPath}], ${dryRun
    ? `title 'Evidence requested: sync of <repoId>', description starting 'dry-run: evidence requested - ', result 'inconclusive'.`
    : `title 'Application repo refreshed: <repoId>' when synced (description: previous and head commit, commits advanced, whether the record was written) with result 'satisfied' when the record was written and the repo has no confirmed gap, 'partial' when it has gaps; title 'Application repo not synced: <repoId>' with result 'inconclusive' when synced is false.`}
Repos: ${JSON.stringify(appRepos)}
Step 3 - ${dryRun ? 'one inconclusive observation per evidence-request gap below, title prefixed "Evidence requested: ", description starting "dry-run: evidence requested - ".' : "one observation per confirmed gap group (same kind): title '<kind>: <target or count> in " + app + "', description listing every target and detail, controlIds per step 1, result 'not-satisfied' for probe-credential-missing, credential-rotation-overdue, image-untracked and env-iac-drift, 'partial' for the other kinds ('inconclusive' for checkout-unavailable, credentials-unverifiable and evidence-request), evidence = the gap evidence paths as workspace-file refs, plus the gap regulatoryRefs named in the description. Do not raise findings: probe workflows own findings."}
Gaps: ${JSON.stringify(appGaps)}
Order: controls, then observations. Never pass --allow-duplicate-id. After the batch run \`node .claude/scripts/validate-data.mjs ${LEDGER}\`. Return {observationIds, controlIds, skipped}.`, { label: `ledger ${app}`, phase: 'Ledger', agentType: 'soc-ledger-keeper', schema: LEDGER_SCHEMA, effort: 'medium' });
  if (!w) { skipped.push(`ledger: soc-ledger-keeper returned nothing for ${app}; ${appRepos.length} repo observation(s) and ${appGaps.length} gap(s) not recorded`); continue; }
  noteSession(w);
  result.observations += (w.observationIds || []).length;
  for (const x of w.skipped || []) skipped.push(`ledger ${app}: ${x}`);
}
log(`Ledger: ${result.observations} observation(s) appended`);

// ---------------------------------------------------------------- Summary (before Version, so the report observation is versioned)
phase('Summary');
let proposedObservation = null;
if (dryRun) {
  skipped.push('dry run: summary.md applications section not updated by design');
} else if (!result.observations) {
  log('No observation appended; applications section left unchanged');
} else {
  const summary = await agent(`${common('report-writer')}
Read .claude/skills/report-templates/SKILL.md. Rewrite ONLY the 'applications' section of ${SUMMARY} (create the file from the template when absent) from applications/*/ records and the ${WORKFLOW} observations in ${LEDGER}: per application its environments by tier and exposure, its repos with head commit and last fetch time, image records with digest and SBOM status, and the confirmed drift and credential gaps cited as [obs_...]. Mention this run: ${result.reposSynced}/${allRepos.length} repos synced, ${result.reposAdvanced} advanced, ${result.recordsWritten} record(s) written, ${result.gapsConfirmed} confirmed gap(s). Keep every other section byte-identical, bump the frontmatter version (minor), set provenance as instructed and recompute provenance.inputsHash exactly as the company-summary schema describes. Validate with \`node .claude/scripts/validate-data.mjs ${SUMMARY}\`. Do not append to the ledger: follow report-templates section 5 step 6 and return the report observation as proposedObservation (omit the field when the report was already current).`, {
    label: 'summary applications', phase: 'Summary', agentType: 'report-writer', effort: 'low',
    schema: { type: 'object', required: ['updated'], properties: { sessionId: { type: 'string' }, updated: { type: 'boolean' }, version: { type: 'string' }, proposedObservation: { type: 'object', description: 'report-templates section 5 step 6 observation record without id and recordedAt' }, notes: { type: 'string' } } },
  });
  if (summary) { noteSession(summary); result.summaryUpdated = Boolean(summary.updated); proposedObservation = summary.proposedObservation || null; }
  else skipped.push('summary: report-writer returned nothing; applications section not updated');
}

// ---------------------------------------------------------------- Version
phase('Version');
if (dryRun) {
  skipped.push('dry run: soc/version.mjs not run by design');
} else if (!result.observations && !proposedObservation) {
  log('Nothing appended to the ledger; version skipped');
} else {
  const version = await agent(`${common('soc-ledger-keeper')}
${proposedObservation ? `First append the report-writer's proposed observation (report-templates section 5 step 6) via append.mjs: mint id obs_<ULID>, set recordedAt NOW, keep every other field; if its controlIds is empty or names a control that is not in the ledger, use the asset-inventory control this run's Ledger stage cited. Record: ${JSON.stringify(proposedObservation)}
Then r` : 'R'}un \`node .claude/scripts/soc/version.mjs ${companyId} --session ${sessionId || '<your harness session id>'} --workflow ${WORKFLOW}\` from the workspace root, once. Never pass --force. Return the observation id you appended (if any), the file version.mjs wrote (empty if it printed that nothing was written) and any error verbatim.`, {
    label: 'version ledger', phase: 'Version', agentType: 'soc-ledger-keeper', effort: 'low',
    schema: { type: 'object', required: ['versionFile'], properties: { sessionId: { type: 'string' }, reportObservationId: { type: 'string' }, versionFile: { type: 'string' }, error: { type: 'string' } } },
  });
  noteSession(version);
  if (version && version.reportObservationId) result.observations += 1;
  else if (proposedObservation) skipped.push('version: report observation not appended (keeper returned no id)');
  if (version && version.versionFile) result.versionFile = version.versionFile;
  else skipped.push(`version: ${version && version.error ? version.error : 'no version file written'}`);
}

result.sessionIds = [...sessionIds];
log(`${WORKFLOW} done: ${result.reposSynced}/${allRepos.length} repos synced (${result.reposAdvanced} advanced), ${result.recordsWritten} record(s) written, ${result.observations} observations, version ${result.versionFile || 'none'}, ${skipped.length} skipped item(s) logged`);
return result;
