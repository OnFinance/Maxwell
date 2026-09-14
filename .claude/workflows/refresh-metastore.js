// refresh-metastore: rebuild company-profile/<companyId>/sdlc/metastore.json, the point-in-time inventory of where the
// company's data lives (catalogs, schemas, tables, classified columns), which pipelines move it and the OpenLineage
// edges between datasets, and record classification and retention gaps as soc observations.
// Shape: Scout (repos and environments in scope, previous snapshot ids) -> Catalogue (pipeline: one
// metastore-cataloguer per repo, PROPOSE ONLY, reads the gitignored checkout and never connects to a database)
// -> Dedup (barrier: merge catalogs/tables/columns/pipelines/lineage across repos, stricter classification wins,
// plus a deterministic PII-name cross-check) -> Verify (refuter lenses evidence, classification, regulatory-mapping
// over gap batches; majority, unanimity for retention gaps) -> Write (validator writes metastore.json in size-bounded
// batches, carrying forward only what this run could not recrawl) -> Ledger (soc-ledger-keeper appends observations)
// -> Summary (report-writer rewrites the data-flows section and proposes its report observation) -> Version
// (soc-ledger-keeper appends that observation, then soc/version.mjs runs once).
// args: { companyId (required), appIds?: string[], envIds?: string[], dryRun?: boolean,
//         now?: RFC3339 UTC string, sessionId?: string, runId?: string }
// NOW is resolved once: args.now when given, otherwise a clock step (soc-ledger-keeper, which may run `node -e`) reads
// it before the Scout; every prompt then receives that literal because the cataloguer, refuter and report-writer
// have no clock.
// appIds narrow the repos catalogued. Carry-forward rule: a previous catalog, pipeline or lineage edge is kept only
// when this run could not recrawl its source (application outside args.appIds, repo without checkout, repo agent
// returned nothing, or catalog listed under notRecrawled); a catalog or pipeline a successfully catalogued repo no
// longer defines is dropped and reported. envIds narrow the environment files used to sanity-check classification,
// residency and endpointRef keys. Retention thresholds come from the in-scope instruments' hardRequirements
// (topics log-retention / data-retention) collected by the Scout, never from a hard-coded number.
// dryRun lists the sources each repo would be catalogued from and writes only 'inconclusive' evidence-request
// observations: metastore.json, summary.md and the version diff are not touched.
export const meta = {
  name: 'refresh-metastore',
  description: 'Catalog tables, columns, pipelines and lineage per repo, dedup, write sdlc/metastore.json, ledger classification gaps. args: companyId, appIds, envIds, dryRun, now, sessionId, runId',
  phases: [
    { title: 'Scout', detail: 'Repos and environments in scope, previous snapshot catalog and pipeline ids' },
    { title: 'Catalogue', detail: 'One metastore-cataloguer per repo proposes catalogs, pipelines, lineage and gaps (no writes)' },
    { title: 'Dedup', detail: 'Barrier: merge by catalogId, fullyQualifiedName, pipelineId and lineage job; stricter classification wins' },
    { title: 'Verify', detail: 'refuter lenses evidence, classification, regulatory-mapping over gap batches per application' },
    { title: 'Write', detail: 'validator writes sdlc/metastore.json in size-bounded batches and validates each write' },
    { title: 'Ledger', detail: 'soc-ledger-keeper appends one observation per repo plus one per confirmed gap group' },
    { title: 'Summary', detail: 'report-writer rewrites the data-flows section of summary.md and proposes its report observation' },
    { title: 'Version', detail: 'soc-ledger-keeper appends the report observation, then soc/version.mjs writes versions/commit_<n>.diff' },
  ],
};

const WORKFLOW = 'refresh-metastore';
const a = args || {};
const companyId = a.companyId;
if (typeof companyId !== 'string' || !companyId) throw new Error('refresh-metastore: args.companyId is required (company-profile/<companyId>)');
const dryRun = a.dryRun === true;
const NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
let now = typeof a.now === 'string' && a.now ? a.now : null;
if (now && !NOW_RE.test(now)) throw new Error('refresh-metastore: args.now must be an RFC 3339 UTC timestamp with a trailing Z');
const sessionId = typeof a.sessionId === 'string' && a.sessionId ? a.sessionId : null;
const runId = typeof a.runId === 'string' && a.runId ? a.runId : null;
const appIds = Array.isArray(a.appIds) && a.appIds.length ? a.appIds : null;
const envIds = Array.isArray(a.envIds) && a.envIds.length ? a.envIds : null;

const PROFILE = `company-profile/${companyId}/details.json`;
const METASTORE = `company-profile/${companyId}/sdlc/metastore.json`;
const LEDGER = `company-profile/${companyId}/soc/main.jsonl`;
const SUMMARY = `company-profile/${companyId}/summary.md`;
const SCHEMA_FILE = '.claude/schemas/v1/company/metastore.schema.json';
const PIPELINE_REF = '.claude/skills/reference-architectures/references/investigation-saver-drhp-offline-copy.md';
const INSTRUMENTS = '.claude/skills/regulatory-catalogs/references/instruments.json';

const skipped = [];
const sessionIds = new Set(sessionId ? [sessionId] : []);
const noteSession = (r) => { if (r && typeof r.sessionId === 'string' && r.sessionId) sessionIds.add(r.sessionId); };

const common = (agentName) => `Company: ${companyId}. Workflow: ${WORKFLOW}. You are the '${agentName}' specialist.
Read .claude/skills/maxwell-conventions/SKILL.md first.
TIME: NOW = '${now}' (resolved once by the workflow; never read a clock or guess a date). Use it for snapshotAt, recordedAt, collectedAt and provenance.generatedAt.
PROVENANCE on every record or file you write: harness = the harness you run on ('claude-code' or 'opencode'), generatedAt = NOW, sessionId = ${sessionId || 'your own harness session id (never invent one)'}, ${runId ? `runId = '${runId}'` : 'runId = MAXWELL_RUN_ID when set, otherwise omit runId'}, workflow = '${WORKFLOW}', agent = '${agentName}'.
Every ledger write goes through \`node .claude/scripts/soc/append.mjs ${companyId} -\` (never open ${LEDGER} for writing); every other file write must pass \`node .claude/scripts/validate-data.mjs <path>\` before you report success.
Read-only against targets: never connect to a database, warehouse, catalog API or orchestrator, never modify a repo checkout, never print a connection string, hostname with credentials, token or secret value. endpointRef values are credentials keys resolved with \`node .claude/scripts/creds/sops.mjs get <app_id> <key>\` (a locator, never a value).
${appIds ? `Scope: applications ${JSON.stringify(appIds)} only.` : ''} ${envIds ? `Environments ${JSON.stringify(envIds)} only.` : ''}
${dryRun ? 'DRY RUN: write no file in this stage.' : ''}`;

// ---------------------------------------------------------------- Scout
phase('Scout');
if (!now) {
  const clock = await agent(`Company: ${companyId}. Workflow: ${WORKFLOW}. You are the 'soc-ledger-keeper' specialist, used here only as the workflow clock: read nothing, write nothing, append nothing.
Run exactly once: node -e "console.log(new Date(Date.parse(Date())).toISOString().slice(0,19)+'Z')"
Return its output verbatim as now.`, { label: 'clock', phase: 'Scout', agentType: 'soc-ledger-keeper', effort: 'low', schema: { type: 'object', required: ['now'], properties: { sessionId: { type: 'string' }, now: { type: 'string' } } } });
  if (!clock || typeof clock.now !== 'string' || !NOW_RE.test(clock.now.trim())) throw new Error(`refresh-metastore: could not resolve NOW (clock returned ${JSON.stringify(clock && clock.now)}); pass args.now and re-run`);
  noteSession(clock);
  now = clock.now.trim();
}
log(`NOW = ${now} (${a.now ? 'args.now' : 'read once by the clock step'}); every prompt uses this literal`);
const SCOUT_SCHEMA = {
  type: 'object',
  required: ['entityTypes', 'frameworksInScope', 'dataResidency', 'retentionRequirements', 'repos', 'environments', 'previousSnapshot', 'existingControlIds', 'skipped'],
  properties: {
    sessionId: { type: 'string' },
    entityTypes: { type: 'array', items: { type: 'string' } },
    frameworksInScope: { type: 'array', items: { type: 'string' } },
    dataResidency: { type: 'array', items: { type: 'string' } },
    retentionRequirements: { type: 'array', description: 'hardRequirements with topic log-retention or data-retention of in-scope instruments (instruments.json), plus retention params of their catalog controls', items: { type: 'object', required: ['instrumentId', 'topic', 'value', 'unit', 'requirement'], properties: { instrumentId: { type: 'string' }, controlId: { type: 'string' }, topic: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, requirement: { type: 'string' }, source: { type: 'string' } } } },
    repos: { type: 'array', items: { type: 'object', required: ['appId', 'repoId', 'recordPath', 'checkoutPresent'], properties: { appId: { type: 'string' }, repoId: { type: 'string' }, recordPath: { type: 'string' }, localCheckout: { type: 'string' }, checkoutPresent: { type: 'boolean' }, pinnedCommit: { type: 'string' }, languages: { type: 'array', items: { type: 'string' } }, dataSignals: { type: 'array', items: { type: 'string' }, description: 'Paths that suggest data definitions: migrations, ORM models, dbt, DAGs, catalog exports, Kafka Connect, Spark/Glue jobs' }, dataSignalsTruncated: { type: 'integer', description: 'Matching paths beyond the 20 returned (0 when none)' } } } },
    environments: { type: 'array', items: { type: 'object', required: ['appId', 'envId', 'path'], properties: { appId: { type: 'string' }, envId: { type: 'string' }, path: { type: 'string' }, tier: { type: 'string' }, dataClassification: { type: 'array', items: { type: 'string' } }, residency: { type: 'array', items: { type: 'string' } }, probeCredentialKey: { type: 'string' }, logsRetentionDays: { type: 'integer' } } } },
    previousSnapshot: { type: 'object', required: ['present', 'catalogs', 'pipelines', 'lineageEdges'], properties: { present: { type: 'boolean' }, snapshotAt: { type: 'string' }, catalogs: { type: 'array', items: { type: 'object', required: ['catalogId', 'appId', 'type'], properties: { catalogId: { type: 'string' }, appId: { type: 'string' }, type: { type: 'string' }, tables: { type: 'integer' } } } }, pipelines: { type: 'array', items: { type: 'object', required: ['pipelineId'], properties: { pipelineId: { type: 'string' }, appId: { type: 'string', description: 'sourceRepo.appId, empty when absent' }, repoId: { type: 'string', description: 'sourceRepo.repoId, empty when absent' } } } }, lineageEdges: { type: 'integer' } } },
    existingControlIds: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', required: ['target', 'reason'], properties: { target: { type: 'string' }, reason: { type: 'string' } } } },
  },
};
const scout = await agent(`${common('metastore-cataloguer')}
SCOUT (read-only, write nothing). Read ${PROFILE} (entityTypes, frameworksInScope, dataResidency), ${METASTORE} if it exists (summarise only: catalogId, appId, type and table count per catalog, pipelineId with sourceRepo appId/repoId per pipeline, lineage edge count, snapshotAt), and ${LEDGER} if it exists (ids of the latest kind 'control' records).
retentionRequirements: from ${INSTRUMENTS}, every hardRequirements[] entry with topic 'log-retention' or 'data-retention' of an instrument in frameworksInScope whose unit is days, months or years (skip boolean ones), copied verbatim (instrumentId, controlId, topic, value, unit, requirement, source '${INSTRUMENTS}'); add any retention-period param (params[] with a numeric default and a days/months/years unit) of a control in that instrument's catalog file under .claude/skills/regulatory-catalogs/references/catalogs/ with source = the catalog path. Never add a period that neither file states.
APPLICATION-TO-COMPANY RULE (deterministic; no application schema carries companyId, so never infer the link from README prose or hosting.accountRef): when company-profile/ contains exactly one company directory every applications/<app_id>/ belongs to it; otherwise the company's applications are the union of ${PROFILE} criticalFunctions[].appIds${appIds ? ` and ${JSON.stringify(appIds)} (args.appIds)` : ''}. List every other applications/<app_id>/ under skipped with reason 'no company link'.${appIds ? ` Of the linked applications keep only ${JSON.stringify(appIds)}; list every other one under skipped with reason 'filtered by args.appIds'.` : ''}
For each kept application: every repos/<repo_id>.json (appId, repoId, recordPath, localCheckout, checkoutPresent = the checkout directory exists, pinnedCommit, languages, dataSignals = up to 20 paths found with Glob under the checkout that look like migrations, ORM models, schema.sql, dbt models, Airflow/Dagster/Prefect DAGs, catalog exports, Kafka Connect, Spark, Glue or Databricks job definitions, dataSignalsTruncated = how many more matched) and every env/<env_id>.json${envIds ? ` whose envId is in ${JSON.stringify(envIds)} (others under skipped with reason 'filtered by args.envIds')` : ''} (tier, dataClassification, residency, probeAccess.credentialKey, observability.logsRetentionDays).
A repo without a checkout stays in the list with checkoutPresent false. Nothing is dropped silently: every exclusion goes to skipped.`, { label: 'scout', phase: 'Scout', agentType: 'metastore-cataloguer', schema: SCOUT_SCHEMA, effort: 'low' });
if (!scout) throw new Error('refresh-metastore: Scout returned nothing; cannot continue');
noteSession(scout);
for (const x of scout.skipped || []) skipped.push(`scout: ${x.target} — ${x.reason}`);
for (const r of scout.repos || []) if (r.dataSignalsTruncated > 0) log(`scout: ${r.appId}/${r.repoId} has ${r.dataSignalsTruncated} data-signal path(s) beyond the 20 listed; the cataloguer globs the checkout itself`);
const retentionRequirements = scout.retentionRequirements || [];
const repos = (scout.repos || []).filter((r) => r.checkoutPresent);
for (const r of (scout.repos || []).filter((x) => !x.checkoutPresent)) skipped.push(`catalogue: ${r.appId}/${r.repoId} has no local checkout; its previous catalogs (if any) are carried forward as not-recrawled`);
const prev = scout.previousSnapshot || { present: false, catalogs: [], pipelines: [], lineageEdges: 0 };
log(`Scout: ${repos.length} repo checkout(s) to catalogue, ${(scout.environments || []).length} environment file(s), previous snapshot ${prev.present ? `${prev.catalogs.length} catalogs / ${(prev.pipelines || []).length} pipelines / ${prev.lineageEdges} lineage edges at ${prev.snapshotAt || 'unknown'}` : 'absent'}`);

const result = { companyId, workflow: WORKFLOW, dryRun, targets: repos.map((r) => `${r.appId}/${r.repoId}`), catalogs: 0, tables: 0, columns: 0, piiColumns: 0, pipelines: 0, lineageEdges: 0, carriedForwardCatalogs: 0, droppedCatalogs: 0, carriedForwardPipelines: 0, droppedPipelines: 0, gapsProposed: 0, gapsConfirmed: 0, metastoreWritten: false, observations: 0, findings: 0, risks: 0, initiatives: 0, suggestions: 0, versionFile: '', summaryUpdated: false, skipped, sessionIds: [] };
if (!repos.length) {
  log('Quiet exit: no repo checkout in scope; metastore.json, ledger and summary left unchanged.');
  result.sessionIds = [...sessionIds];
  return result;
}

// ---------------------------------------------------------------- Catalogue (pipeline per repo)
const REG_REF = { type: 'object', required: ['regulator', 'instrument', 'controlId'], properties: { regulator: { type: 'string' }, instrument: { type: 'string' }, controlId: { type: 'string' } } };
const LOOSE = { type: 'object', properties: {} };
const CATALOGUE_SCHEMA = {
  type: 'object',
  required: ['appId', 'repoId', 'catalogs', 'pipelines', 'lineage', 'sources', 'gaps', 'notRecrawled'],
  properties: {
    sessionId: { type: 'string' },
    appId: { type: 'string' },
    repoId: { type: 'string' },
    commit: { type: 'string' },
    catalogs: { type: 'array', description: 'metastore.schema.json #/$defs/catalog objects restricted to what this repo evidences', items: { type: 'object', required: ['catalogId', 'type', 'endpointRef', 'appId', 'schemas'], properties: { catalogId: { type: 'string' }, type: { type: 'string' }, endpointRef: { type: 'string' }, appId: { type: 'string' }, schemas: { type: 'array', items: { type: 'object', required: ['name', 'tables'], properties: { name: { type: 'string' }, tables: { type: 'array', items: LOOSE } } } } } } },
    pipelines: { type: 'array', description: 'metastore.schema.json #/$defs/pipeline objects', items: { type: 'object', required: ['pipelineId', 'name', 'orchestrator', 'owner'], properties: { pipelineId: { type: 'string' }, name: { type: 'string' }, orchestrator: { type: 'string' }, schedule: { type: 'string' }, owner: { type: 'string' }, sourceRepo: { type: 'object', required: ['appId', 'repoId'], properties: { appId: { type: 'string' }, repoId: { type: 'string' } } } } } },
    lineage: { type: 'array', description: 'metastore.schema.json #/$defs/lineageEdge objects', items: { type: 'object', required: ['job', 'inputs', 'outputs'], properties: { job: { type: 'object', required: ['namespace', 'name'], properties: { namespace: { type: 'string' }, name: { type: 'string' } } }, inputs: { type: 'array', items: LOOSE }, outputs: { type: 'array', items: LOOSE }, facets: LOOSE } } },
    sources: { type: 'array', items: { type: 'string' }, description: 'Checkout-relative files read' },
    gaps: { type: 'array', items: { type: 'object', required: ['kind', 'target', 'detail', 'evidence'], properties: { kind: { type: 'string', enum: ['endpointRef-missing', 'columns-unreadable', 'retention-below-regulatory', 'log-retention-below-180d', 'lineage-break', 'classification-conflict', 'residency-conflict', 'schema-gap', 'evidence-request'] }, target: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, regulatoryRefs: { type: 'array', items: REG_REF } } } },
    notRecrawled: { type: 'array', items: { type: 'object', required: ['catalogId', 'reason'], properties: { catalogId: { type: 'string' }, reason: { type: 'string' } } } },
  },
};

const cataloguePrompt = (r) => `${common('metastore-cataloguer')}
${dryRun ? 'DRY RUN PLAN' : 'CATALOGUE'} repo '${r.appId}/${r.repoId}' (record ${r.recordPath}, checkout ${r.localCheckout || `applications/${r.appId}/repos/${r.repoId}/`}${r.pinnedCommit ? `, pinned ${r.pinnedCommit}` : ''}) — PROPOSE ONLY: in this workflow you do NOT write ${METASTORE}; the workflow merges every repo's answer and a validator writes the file. Ignore the "How you write" steps of your agent file and return the fragment instead.
Read ${SCHEMA_FILE} (the example is the reference shape), ${PIPELINE_REF} section 2, ${PROFILE} (dataResidency ${JSON.stringify(scout.dataResidency)}), the environment files of this application ${JSON.stringify((scout.environments || []).filter((e) => e.appId === r.appId).map((e) => e.path))} and, when present, ${METASTORE} (keep catalogId, pipelineId and fullyQualifiedName values stable).
Data signals seen by the scout: ${JSON.stringify(r.dataSignals || [])}
${dryRun ? `Do NOT extract tables or columns. Glob and Grep only to list the sources you would read (sources), and return catalogs [], pipelines [], lineage [] and one gap of kind 'evidence-request' per thing a human or a live run must supply (missing catalog export, unreadable migration directory, missing credentials key for an endpointRef, missing CODEOWNERS for owners).` : `Follow your modelling rules exactly: one catalogs[] entry per catalog product or database this repo defines (type rdbms for plain databases, other for object stores and queues), appId '${r.appId}', endpointRef = an existing credentials key of that application (confirm with sops.mjs get; if none exists use the environment's probeAccess.credentialKey and add gap endpointRef-missing); fullyQualifiedName '<catalog>.<schema>.<table>'; every column with dataType exactly as declared, dataClassification from your DPDP-aware rules and pii true exactly when dataClassification contains pii (spdi and cardholder imply pii); retentionDays only from code or config; pipelines[] with sourceRepo {appId:'${r.appId}', repoId:'${r.repoId}'}; lineage[] only when the job code names both input and output. Never invent a table or column: unreadable DDL is columns [] plus gap columns-unreadable.
Retention requirements of the in-scope instruments (the ONLY thresholds you may apply; convert months x 30 and years x 365 to days): ${JSON.stringify(retentionRequirements)}
Gaps (proposals for the ledger, not file content): retention-below-regulatory when a table's retentionDays is below a data-retention requirement above that binds the data the table holds (cite that requirement's instrumentId/controlId, e.g. dpdp-rules-2025 8(3) one year for personal data); when a trading, order, KYC or client-ledger table has a retention setting but no requirement above states a record-keeping period for that data, propose an evidence-request gap instead (the company's record-retention schedule and the record-keeping obligation it relies on must be supplied), never retention-below-regulatory; log-retention-below-180d when an audit or access-log table or pipeline keeps less than the log-retention requirement above for cert-in-directions-2022 Dir-iv (only when that requirement is in the list; otherwise an evidence-request gap); classification-conflict when a column's evidence points to two classes (you took the stricter one); residency-conflict when a location or namespace sits outside dataResidency for pii/spdi/cardholder/financial data; lineage-break when a job reads a dataset no catalog or job produces; endpointRef-missing; columns-unreadable. Each gap carries evidence (checkout-relative path:line) and regulatoryRefs with the most specific Indian instrument first (dpdp-rules-2025 6(1)(a)/8(3), cert-in-directions-2022 Dir-iv, the SEBI CSCRF or RBI data-classification/asset-inventory clause, then global mappings).`}
List previous-snapshot catalogs of application '${r.appId}' this repo should have evidenced but you could not re-read under notRecrawled.`;

phase('Catalogue');
const catalogued = await pipeline(repos, async (r, _item, index) => {
  const out = await agent(cataloguePrompt(r), { label: `catalogue ${r.appId}/${r.repoId} #${index + 1}`, phase: 'Catalogue', agentType: 'metastore-cataloguer', schema: CATALOGUE_SCHEMA, effort: dryRun ? 'low' : 'high' });
  if (!out) { skipped.push(`catalogue: ${r.appId}/${r.repoId} returned nothing (agent failed or was skipped); its previous catalogs are carried forward`); return null; }
  noteSession(out);
  for (const n of out.notRecrawled || []) skipped.push(`catalogue ${r.appId}/${r.repoId}: catalog ${n.catalogId} not recrawled — ${n.reason}`);
  const tables = (out.catalogs || []).reduce((n, c) => n + (c.schemas || []).reduce((m, s) => m + (s.tables || []).length, 0), 0);
  log(`${r.appId}/${r.repoId}: ${(out.catalogs || []).length} catalog(s), ${tables} table(s), ${(out.pipelines || []).length} pipeline(s), ${(out.lineage || []).length} lineage edge(s), ${(out.gaps || []).length} gap(s)`);
  return { repo: r, out };
});

// ---------------------------------------------------------------- Dedup (barrier: cross-repo merge)
phase('Dedup');
const perRepo = catalogued.filter(Boolean);
const SENSITIVE = ['pii', 'spdi', 'cardholder', 'financial', 'regulatory', 'restricted', 'confidential'];
const mergeClasses = (x, y) => {
  let classes = [...new Set([...(x || []), ...(y || [])])];
  if (classes.includes('cardholder') && !classes.includes('spdi')) classes.push('spdi');
  if ((classes.includes('spdi') || classes.includes('cardholder')) && !classes.includes('pii')) classes.push('pii');
  if (classes.some((c) => SENSITIVE.includes(c))) classes = classes.filter((c) => c !== 'internal' && c !== 'public');
  if (!classes.length) classes = ['internal'];
  return classes;
};
const normaliseColumn = (col) => { const dataClassification = mergeClasses(col.dataClassification, []); return { ...col, dataClassification, pii: dataClassification.includes('pii') }; };
const PII_NAME = /(^|_)(pan|pan_no|pan_number|aadhaar|aadhar|uid|mobile|phone|msisdn|email|e_mail|dob|date_of_birth|first_name|last_name|full_name|father_name|address|pincode|passport|voter_id|ckyc|ckyc_no|ucc|client_code|dp_client_id|ifsc|account_no|account_number|bank_account|card_no|card_number|pan_token|ip_address|device_id)($|_)/i;

const catalogs = new Map();
const tableOrigin = new Map();
const conflicts = [];
const nameSuspects = [];
for (const { repo, out } of perRepo) {
  for (const c of out.catalogs || []) {
    if (!catalogs.has(c.catalogId)) catalogs.set(c.catalogId, { catalogId: c.catalogId, type: c.type, endpointRef: c.endpointRef, appId: c.appId, schemas: new Map() });
    const cat = catalogs.get(c.catalogId);
    if (cat.type !== c.type || cat.endpointRef !== c.endpointRef) conflicts.push({ kind: 'classification-conflict', target: c.catalogId, detail: `catalog ${c.catalogId} described differently by ${repo.appId}/${repo.repoId} (type ${c.type}, endpointRef ${c.endpointRef}) than an earlier repo (type ${cat.type}, endpointRef ${cat.endpointRef}); kept the first`, evidence: [repo.recordPath], appId: repo.appId, repoId: repo.repoId });
    for (const s of c.schemas || []) {
      if (!cat.schemas.has(s.name)) cat.schemas.set(s.name, new Map());
      const tables = cat.schemas.get(s.name);
      for (const t of s.tables || []) {
        if (!t || !t.fullyQualifiedName) { skipped.push(`dedup: table without fullyQualifiedName from ${repo.appId}/${repo.repoId} in ${c.catalogId}.${s.name} dropped`); continue; }
        const incoming = { ...t, columns: (t.columns || []).map(normaliseColumn) };
        const existing = tables.get(t.fullyQualifiedName);
        if (!existing) { tables.set(t.fullyQualifiedName, incoming); tableOrigin.set(t.fullyQualifiedName, `${repo.appId}/${repo.repoId}`); }
        else {
          const cols = new Map(existing.columns.map((col) => [col.name, col]));
          for (const col of incoming.columns) {
            const had = cols.get(col.name);
            if (!had) { cols.set(col.name, col); continue; }
            const merged = mergeClasses(had.dataClassification, col.dataClassification);
            if (merged.length !== had.dataClassification.length || merged.length !== col.dataClassification.length) conflicts.push({ kind: 'classification-conflict', target: `${t.fullyQualifiedName}.${col.name}`, detail: `classified ${JSON.stringify(had.dataClassification)} by ${tableOrigin.get(t.fullyQualifiedName)} and ${JSON.stringify(col.dataClassification)} by ${repo.appId}/${repo.repoId}; merged to the stricter ${JSON.stringify(merged)}`, evidence: [repo.recordPath], appId: repo.appId, repoId: repo.repoId });
            cols.set(col.name, { ...had, dataClassification: merged, pii: merged.includes('pii') });
          }
          const retention = [existing.retentionDays, incoming.retentionDays].filter((x) => typeof x === 'number');
          tables.set(t.fullyQualifiedName, { ...incoming, ...existing, columns: [...cols.values()], ...(retention.length ? { retentionDays: Math.min(...retention) } : {}) });
        }
      }
    }
  }
}
for (const cat of catalogs.values()) for (const tables of cat.schemas.values()) for (const t of tables.values()) for (const col of t.columns) {
  if (PII_NAME.test(col.name) && !col.pii) nameSuspects.push({ kind: 'classification-conflict', target: `${t.fullyQualifiedName}.${col.name}`, detail: `column name matches the DPDP personal-data pattern but is classified ${JSON.stringify(col.dataClassification)} with pii false; confirm from the DDL/ORM and reclassify or document why it is not personal data`, evidence: [`${METASTORE}#${t.fullyQualifiedName}`], appId: cat.appId, repoId: (tableOrigin.get(t.fullyQualifiedName) || '/').split('/')[1] });
}

const pipelines = new Map();
for (const { repo, out } of perRepo) for (const p of out.pipelines || []) {
  if (pipelines.has(p.pipelineId)) { skipped.push(`dedup: pipeline ${p.pipelineId} from ${repo.appId}/${repo.repoId} duplicates an earlier repo's entry; kept the first`); continue; }
  pipelines.set(p.pipelineId, p);
}
const lineage = new Map();
const dsKey = (list) => (list || []).map((d) => `${d.namespace}/${d.name}`).sort().join(',');
for (const { out } of perRepo) for (const e of out.lineage || []) {
  const key = `${e.job.namespace}|${e.job.name}|${dsKey(e.inputs)}|${dsKey(e.outputs)}`;
  if (!lineage.has(key)) lineage.set(key, e);
}

const gapCandidates = [];
const gapSeen = new Set();
for (const g of [...perRepo.flatMap(({ repo, out }) => (out.gaps || []).map((x) => ({ ...x, appId: repo.appId, repoId: repo.repoId }))), ...conflicts, ...nameSuspects]) {
  const key = `${g.kind}|${g.target}`;
  if (gapSeen.has(key)) continue;
  gapSeen.add(key);
  gapCandidates.push({ ...g, key: `gap-${gapCandidates.length + 1}` });
}

const catalogList = [...catalogs.values()].map((c) => ({ catalogId: c.catalogId, type: c.type, endpointRef: c.endpointRef, appId: c.appId, schemas: [...c.schemas.entries()].map(([name, tables]) => ({ name, tables: [...tables.values()] })) }));
result.catalogs = catalogList.length;
result.tables = catalogList.reduce((n, c) => n + c.schemas.reduce((m, s) => m + s.tables.length, 0), 0);
result.columns = catalogList.reduce((n, c) => n + c.schemas.reduce((m, s) => m + s.tables.reduce((k, t) => k + t.columns.length, 0), 0), 0);
result.piiColumns = catalogList.reduce((n, c) => n + c.schemas.reduce((m, s) => m + s.tables.reduce((k, t) => k + t.columns.filter((col) => col.pii).length, 0), 0), 0);
result.pipelines = pipelines.size;
result.lineageEdges = lineage.size;
result.gapsProposed = gapCandidates.length;
// Carry-forward rule: keep a previous catalog or pipeline only when this run could not recrawl its source. A catalog
// carries no repoId, so it is attributed to its application: it is kept when the application is outside args.appIds,
// has no repo record in this run, has any repo that was not catalogued (no checkout or agent returned nothing), or a
// repo listed it under notRecrawled. Otherwise every repo of its application was catalogued and none defines it any
// more, so it is dropped and reported.
const freshCatalogIds = new Set(catalogList.map((c) => c.catalogId));
const cataloguedRepoKeys = new Set(perRepo.map(({ repo }) => `${repo.appId}/${repo.repoId}`));
const scoutRepos = scout.repos || [];
const scoutAppIds = new Set(scoutRepos.map((r) => r.appId));
const notRecrawledIds = new Set(perRepo.flatMap(({ out }) => (out.notRecrawled || []).map((n) => n.catalogId)));
const appUncatalogued = (appId) => scoutRepos.some((r) => r.appId === appId && !cataloguedRepoKeys.has(`${r.appId}/${r.repoId}`));
const catalogCarryReason = (c) => {
  if (appIds && !appIds.includes(c.appId)) return 'application outside args.appIds';
  if (!scoutAppIds.has(c.appId)) return 'application has no repo record in scope this run';
  if (notRecrawledIds.has(c.catalogId)) return 'listed as not recrawled by a repo cataloguer';
  if (appUncatalogued(c.appId)) return 'a repo of the application had no checkout or its cataloguer returned nothing';
  return null;
};
const carryForward = [];
const droppedCatalogs = [];
for (const c of (prev.catalogs || []).filter((x) => !freshCatalogIds.has(x.catalogId))) {
  const reason = catalogCarryReason(c);
  if (reason) { carryForward.push(c); skipped.push(`write: catalog ${c.catalogId} (${c.appId}) not recrawled this run (${reason}); carried forward unchanged from the previous snapshot`); }
  else { droppedCatalogs.push(c); skipped.push(`write: catalog ${c.catalogId} (${c.appId}) dropped from the snapshot: every repo of ${c.appId} was catalogued and none defines it any more`); }
}
const pipelineCarryReason = (p) => {
  if (!p.appId || !p.repoId) return 'previous pipeline has no sourceRepo';
  if (appIds && !appIds.includes(p.appId)) return 'application outside args.appIds';
  if (!cataloguedRepoKeys.has(`${p.appId}/${p.repoId}`)) return 'its source repo had no checkout or its cataloguer returned nothing';
  return null;
};
const carryPipelines = [];
const droppedPipelines = [];
for (const p of (prev.pipelines || []).filter((x) => !pipelines.has(x.pipelineId))) {
  const reason = pipelineCarryReason(p);
  if (reason) { carryPipelines.push(p); skipped.push(`write: pipeline ${p.pipelineId} not recrawled this run (${reason}); carried forward`); }
  else { droppedPipelines.push(p); skipped.push(`write: pipeline ${p.pipelineId} dropped: its source repo ${p.appId}/${p.repoId} was catalogued and no longer defines it`); }
}
result.carriedForwardCatalogs = carryForward.length;
result.droppedCatalogs = droppedCatalogs.length;
result.carriedForwardPipelines = carryPipelines.length;
result.droppedPipelines = droppedPipelines.length;
log(`Dedup: ${result.catalogs} catalogs, ${result.tables} tables, ${result.columns} columns (${result.piiColumns} pii), ${result.pipelines} pipelines, ${result.lineageEdges} lineage edges; ${gapCandidates.length} gap candidate(s) (${conflicts.length} merge conflicts, ${nameSuspects.length} PII-name suspects); carry forward ${carryForward.length} catalog(s) / ${carryPipelines.length} pipeline(s); dropped ${droppedCatalogs.length} catalog(s) / ${droppedPipelines.length} pipeline(s) no longer defined by catalogued repos`);
if (droppedCatalogs.length || droppedPipelines.length) log(`Dropped from the snapshot: ${[...droppedCatalogs.map((c) => `catalog ${c.catalogId}`), ...droppedPipelines.map((p) => `pipeline ${p.pipelineId}`)].join(', ')}`);

// ---------------------------------------------------------------- Verify (gap batches per application)
phase('Verify');
const LENSES = ['evidence', 'classification', 'regulatory-mapping'];
const BATCH_VERDICT = { type: 'object', required: ['verdicts'], properties: { sessionId: { type: 'string' }, verdicts: { type: 'array', items: { type: 'object', required: ['key', 'refuted', 'reason'], properties: { key: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' }, correctedRegulatoryRefs: { type: 'array', items: REG_REF } } } } } };
const UNANIMOUS_KINDS = ['retention-below-regulatory', 'log-retention-below-180d', 'residency-conflict'];
const refutePrompt = (appId, batch, lens) => `${common('refuter')}
Lens '${lens}'. Try to REFUTE each metastore gap below for application '${appId}' of ${companyId}; default to refuted=true for a gap the repo checkout under applications/${appId}/repos/ and the environment files do not show. Read only; never write; never connect to a data system.
${lens === 'evidence' ? 'evidence: open each evidence path (checkout-relative path:line or a table reference); the file must actually define the table, column, retention setting, job input/output or credentials key the gap is about. A gap with no readable evidence is refuted.' : ''}${lens === 'classification' ? 'classification: for classification-conflict gaps decide from the column name, declared type, ORM validators, comments and downstream use whether the data is personal (DPDP Act 2023 s.2(t)), SPDI, cardholder, financial or regulatory; refute a PII-name suspect only when the column clearly holds no personal data (e.g. pan_type enum, email_template_id). For retention and residency gaps check that the table really holds trading, order, KYC, ledger, audit-log or personal data.' : ''}${lens === 'regulatory-mapping' ? `regulatory-mapping: every regulatoryRef instrument applies to this company (${JSON.stringify(scout.frameworksInScope)} or ${INSTRUMENTS} applicability) and the controlId exists in its catalog; a retention gap's threshold equals a value in these in-scope retention requirements (instruments.json hardRequirements or catalog params) and that requirement binds the table's data: ${JSON.stringify(retentionRequirements)}; refute a retention-below-regulatory or log-retention-below-180d gap whose threshold is not in that list. Return correctedRegulatoryRefs when repairable instead of refuting.` : ''}
Return exactly one verdict per candidate keyed by its "key".
Candidates: ${JSON.stringify(batch)}`;

const gapAppIds = [...new Set(gapCandidates.map((g) => g.appId))];
const GAP_BATCH = 30;
const gapBatches = [];
for (const app of gapAppIds) { const list = gapCandidates.filter((g) => g.appId === app); for (let i = 0; i < list.length; i += GAP_BATCH) gapBatches.push({ appId: app, items: list.slice(i, i + GAP_BATCH) }); }
const verifiedBatches = dryRun ? gapBatches.map((b) => b.items) : await pipeline(gapBatches, async (b, _item, index) => {
  const votes = await parallel(LENSES.map((lens) => () => agent(refutePrompt(b.appId, b.items, lens), { label: `refute gaps ${b.appId} (${b.items.length}) [${lens}] #${index + 1}`, phase: 'Verify', agentType: 'refuter', schema: BATCH_VERDICT, effort: 'medium' })));
  votes.forEach(noteSession);
  LENSES.forEach((lens, i) => { if (!votes[i]) skipped.push(`verify: lens ${lens} returned nothing for ${b.appId} gap batch #${index + 1}; counted as abstention`); });
  return b.items.filter((g) => {
    const answers = votes.map((v, i) => { const x = v ? (v.verdicts || []).find((y) => y.key === g.key) : null; return x ? { ...x, lens: LENSES[i] } : null; }).filter(Boolean);
    const refutations = answers.filter((x) => x.refuted);
    const ok = UNANIMOUS_KINDS.includes(g.kind) ? (answers.length === LENSES.length && refutations.length === 0) : (answers.length >= 2 && refutations.length < 2);
    if (!ok) { skipped.push(`verify: gap ${g.kind} on ${g.target} not confirmed (${refutations.length} refuted of ${answers.length} answered): ${refutations.map((x) => `${x.lens}: ${x.reason}`).join(' | ') || 'missing verdicts'}`); return false; }
    const corrected = answers.find((x) => x.correctedRegulatoryRefs && x.correctedRegulatoryRefs.length);
    if (corrected) g.regulatoryRefs = corrected.correctedRegulatoryRefs;
    return true;
  });
});
if (dryRun && gapBatches.length) skipped.push('dry run: refutation skipped; every proposed gap is recorded only as an inconclusive evidence request');
const confirmedGaps = verifiedBatches.filter(Boolean).flat();
result.gapsConfirmed = dryRun ? 0 : confirmedGaps.length;
log(`Verify: ${dryRun ? `dry run, ${confirmedGaps.length} evidence request(s) pass through unverified` : `${confirmedGaps.length}/${gapCandidates.length} gap(s) confirmed`}`);

// ---------------------------------------------------------------- Write (validator, size-bounded batches)
phase('Write');
const WRITE_SCHEMA = { type: 'object', required: ['written', 'validated', 'failures'], properties: { sessionId: { type: 'string' }, written: { type: 'boolean' }, validated: { type: 'boolean' }, catalogs: { type: 'integer' }, tables: { type: 'integer' }, carriedLineageEdges: { type: 'integer' }, droppedLineageEdges: { type: 'integer' }, failures: { type: 'array', items: { type: 'string' } }, schemaIssues: { type: 'array', items: { type: 'string' } } } };
if (dryRun) {
  skipped.push(`dry run: ${METASTORE} not written by design (${result.catalogs} catalogs proposed)`);
} else if (!catalogList.length && !pipelines.size && !lineage.size) {
  skipped.push(`write: no repo produced any catalog, pipeline or lineage edge; ${METASTORE} left unchanged rather than overwritten with an empty snapshot`);
} else {
  // Pack schema entries into prompt-sized batches; the first batch replaces the file, later batches add schemas.
  const MAX_CHARS = 120000;
  const units = [];
  for (const c of catalogList) for (const s of c.schemas) units.push({ catalog: { catalogId: c.catalogId, type: c.type, endpointRef: c.endpointRef, appId: c.appId }, schema: s });
  for (const c of catalogList) if (!c.schemas.length) units.push({ catalog: { catalogId: c.catalogId, type: c.type, endpointRef: c.endpointRef, appId: c.appId }, schema: null });
  const batches = [];
  let current = []; let size = 0;
  for (const u of units) {
    const n = JSON.stringify(u).length;
    if (current.length && size + n > MAX_CHARS) { batches.push(current); current = []; size = 0; }
    current.push(u); size += n;
    if (n > MAX_CHARS) log(`write: schema ${u.catalog.catalogId}.${u.schema ? u.schema.name : ''} alone is ${n} characters; sent as its own batch`);
  }
  if (current.length) batches.push(current);
  if (!batches.length) batches.push([]);
  const snapshotAt = now;
  let ok = true;
  for (let i = 0; i < batches.length && ok; i += 1) {
    const first = i === 0;
    const w = await agent(`${common('validator')}
Read ${SCHEMA_FILE}. ${first ? `REPLACE ${METASTORE} with a new snapshot (read the previous file first if it exists; you need it for carried-forward catalogs).
Document: schemaVersion '1', kind 'maxwell.company.metastore', companyId '${companyId}', snapshotAt '${snapshotAt}', provenance as instructed (agent 'validator').
catalogs = the catalog/schema units of this batch (group units with the same catalogId into one catalog entry; a unit with schema null is a catalog with schemas []) PLUS, copied verbatim from the previous file, exactly these carried-forward catalogs: ${JSON.stringify(carryForward.map((c) => c.catalogId))}. Every other previous catalog is NOT copied (dropped: ${JSON.stringify(droppedCatalogs.map((c) => c.catalogId))}).
pipelines (${pipelines.size}): ${JSON.stringify([...pipelines.values()])}
PLUS, copied verbatim from the previous file, exactly these carried-forward pipelines: ${JSON.stringify(carryPipelines.map((p) => p.pipelineId))}. No other previous pipeline is copied.
lineage (${lineage.size}): ${JSON.stringify([...lineage.values()])}
PLUS every previous lineage edge that is not identical to one above AND whose job belongs to a carried-forward pipeline (job name or namespace names that pipelineId or its name) or whose input and output datasets all belong to carried-forward catalogs. Drop every other previous edge and return the counts as carriedLineageEdges and droppedLineageEdges.` : `ADD to the existing ${METASTORE} (written earlier in this run): for each unit, append its schema entry to the catalog with that catalogId, creating the catalog entry from the unit's catalog fields when it does not exist yet. Change nothing else except provenance.generatedAt.`}
Units (batch ${i + 1}/${batches.length}): ${JSON.stringify(batches[i])}
Content rules: keep keys exactly as the schema names them, no extra keys; a column's pii must be true exactly when dataClassification contains 'pii'; drop an optional field whose value violates its enum or pattern and list it under failures (never invent a replacement value); a table with no columns keeps columns []. Run \`node .claude/scripts/validate-data.mjs ${METASTORE}\` and fix content until it passes. Return {written, validated, catalogs, tables, ${first ? 'carriedLineageEdges, droppedLineageEdges, ' : ''}failures, schemaIssues}.`, { label: `write metastore ${i + 1}/${batches.length}`, phase: 'Write', agentType: 'validator', schema: WRITE_SCHEMA, effort: 'medium' });
    if (!w) { ok = false; skipped.push(`write: validator returned nothing for batch ${i + 1}/${batches.length}; ${METASTORE} may hold a partial snapshot — re-run refresh-metastore`); break; }
    noteSession(w);
    if (first && (w.carriedLineageEdges || w.droppedLineageEdges)) log(`write: previous lineage edges carried forward ${w.carriedLineageEdges || 0}, dropped ${w.droppedLineageEdges || 0}`);
    for (const f of w.failures || []) skipped.push(`write batch ${i + 1}: ${f}`);
    for (const f of w.schemaIssues || []) skipped.push(`write schema issue: ${f}`);
    if (!(w.written && w.validated)) { ok = false; skipped.push(`write: batch ${i + 1}/${batches.length} ${w.written ? 'written but failed validation' : 'not written'}; stopping further batches`); }
  }
  result.metastoreWritten = ok;
}

// ---------------------------------------------------------------- Ledger
phase('Ledger');
const LEDGER_SCHEMA = { type: 'object', required: ['observationIds', 'controlIds', 'skipped'], properties: { sessionId: { type: 'string' }, observationIds: { type: 'array', items: { type: 'string' } }, controlIds: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } } } };
const existingControlIds = scout.existingControlIds || [];
const ledgerApps = [...new Set(perRepo.map((p) => p.repo.appId))];
// Evidence may cite metastore.json only when this run actually wrote and validated it.
const metastoreCitable = !dryRun && result.metastoreWritten;
for (const app of ledgerApps) {
  const appRepos = perRepo.filter((p) => p.repo.appId === app);
  const appGaps = confirmedGaps.filter((g) => g.appId === app);
  const dryGaps = gapCandidates.filter((g) => g.appId === app);
  if (dryRun && !existingControlIds.length) { skipped.push(`ledger ${app}: dry run and the ledger has no control record to cite; ${appRepos.length} evidence-request observation(s) not recorded (a dry run never appends controls)`); continue; }
  const repoSummaries = appRepos.map(({ repo, out }) => ({ repoId: repo.repoId, sources: (out.sources || []).length, catalogs: (out.catalogs || []).map((c) => c.catalogId), pipelines: (out.pipelines || []).length, lineageEdges: (out.lineage || []).length }));
  const repoEvidence = metastoreCitable
    ? `[{type:'workspace-file', ref:'${METASTORE}'}, {type:'workspace-file', ref:'applications/${app}/repos/<repoId>.json'}]`
    : `[{type:'workspace-file', ref:'applications/${app}/repos/<repoId>.json'}] (do NOT cite ${METASTORE}: ${dryRun ? 'a dry run never writes it' : 'this run did not write it successfully'})`;
  const w = await agent(`${common('soc-ledger-keeper')}
Read .claude/skills/soc-ledger/SKILL.md sections 4, 5 and 9, ${PROFILE} and ${LEDGER}. Application '${app}'.
${dryRun
    ? `Step 1 - controls (READ-ONLY, dry run): observations must cite control records that already exist. Choose the most specific Indian data inventory / classification control (and, for retention or personal-data evidence requests, the matching retention or personal-data control) ONLY from these existing ledger control ids: ${JSON.stringify(existingControlIds)}. Append NO control record. When no existing id fits an observation, do not append that observation and list it under skipped with reason 'no existing control fits'.`
    : `Step 1 - controls: observations must cite control records that exist. Choose, from the instruments in ${JSON.stringify(scout.frameworksInScope)}, the most specific Indian controls for data inventory and classification (the SEBI CSCRF or RBI asset-inventory / data-classification clause for the company's entity type), dpdp-rules-2025:6(1)(a) for unprotected personal data, the controlId named by the retention requirement a retention gap cites (${JSON.stringify(retentionRequirements.map((x) => `${x.instrumentId}:${x.controlId || '?'}`))}) for retention. If one is missing from the ledger (existing: ${JSON.stringify(existingControlIds.slice(0, 200))}), append it first from its catalog (id '<instrumentId>:<controlId>', frameworkRefs, title, implementationStatus 'unknown', effectiveness 'not-tested'); an instrument without a catalog file cannot be used.`}
Step 2 - one observation per repo: methods ['${WORKFLOW}'], subjects [{type:'repo', appId:'${app}', repoId}], controlIds [the data-inventory control], collectedAt NOW, evidence ${repoEvidence}, ${dryRun
    ? `title 'Evidence requested: metastore sources for <repoId>', description starting 'dry-run: evidence requested — ' listing the sources that would be read and the evidence requests below, result 'inconclusive'.`
    : result.metastoreWritten
      ? `title 'Metastore catalogued: <repoId>', description with the counts, result 'satisfied' when the repo has no confirmed gap, 'partial' when it only has classification-conflict or lineage-break gaps, 'not-satisfied' when it has a retention or residency gap, 'inconclusive' when its sources were 0.`
      : `title 'Metastore not written: <repoId>', description stating that ${METASTORE} was not (fully) written or failed validation in this run (partial or unchanged file), with the proposed counts, result 'inconclusive'.`}
Repos: ${JSON.stringify(repoSummaries)}
Step 3 - ${dryRun ? 'one inconclusive observation per evidence-request gap below (same subjects, title prefixed "Evidence requested: ", description starting "dry-run: evidence requested — ", evidence = the gap evidence paths under applications/' + app + '/repos/<repoId>/ only), nothing else.' : 'one observation per confirmed gap group (same kind and repo): title \'<kind>: <target or count> in <repoId>\', description listing every target and detail, controlIds per step 1 (retention/log/residency/personal-data control plus the data-inventory control), result \'not-satisfied\' for retention-below-regulatory, log-retention-below-180d and residency-conflict, \'partial\' otherwise (\'inconclusive\' for evidence-request), evidence = the gap evidence paths as workspace-file refs under applications/' + app + '/repos/<repoId>/' + (metastoreCitable ? ' (or the metastore path)' : ' (a metastore path reference is replaced by the repo record path because the metastore was not written)') + ' plus the gap regulatoryRefs named in the description. Do not raise findings: probe workflows own findings for these gaps.'}
Gaps: ${JSON.stringify(dryRun ? dryGaps : appGaps)}
Order: controls, then observations. Never pass --allow-duplicate-id. After the batch run \`node .claude/scripts/validate-data.mjs ${LEDGER}\`. Return {observationIds, controlIds, skipped}.`, { label: `ledger ${app}`, phase: 'Ledger', agentType: 'soc-ledger-keeper', schema: LEDGER_SCHEMA, effort: 'medium' });
  if (!w) { skipped.push(`ledger: soc-ledger-keeper returned nothing for ${app}; ${appRepos.length} repo observation(s) and ${(dryRun ? dryGaps : appGaps).length} gap(s) not recorded`); continue; }
  noteSession(w);
  result.observations += (w.observationIds || []).length;
  for (const x of w.skipped || []) skipped.push(`ledger ${app}: ${x}`);
}
log(`Ledger: ${result.observations} observation(s) appended across ${ledgerApps.length} application(s)`);

// ---------------------------------------------------------------- Summary (before Version, so the report observation is versioned)
phase('Summary');
let proposedObservation = null;
if (dryRun) {
  skipped.push('dry run: summary.md data-flows section not updated by design');
} else if (!result.metastoreWritten) {
  log('metastore.json was not (fully) written; data-flows section left unchanged');
} else {
  const summary = await agent(`${common('report-writer')}
Read .claude/skills/report-templates/SKILL.md. Rewrite ONLY the 'data-flows' section of ${SUMMARY} (create the file from the template when absent) from ${METASTORE} and the ${WORKFLOW} observations in ${LEDGER}: catalogs by application with table and PII-column counts, the pipelines and lineage chains that carry pii, spdi, cardholder or financial data (source -> job -> sink), retention versus the periods the in-scope instruments state (${JSON.stringify(retentionRequirements.map((x) => `${x.instrumentId}${x.controlId ? `:${x.controlId}` : ''} ${x.topic} ${x.value} ${x.unit}`))}; say 'no record-keeping period stated by an in-scope instrument' where none applies), and the confirmed gaps cited as [obs_…]. Mention this run: ${result.catalogs} catalogs (${result.carriedForwardCatalogs} carried forward, ${result.droppedCatalogs} dropped), ${result.tables} tables, ${result.piiColumns} PII columns, ${result.pipelines} pipelines, ${result.lineageEdges} lineage edges, ${result.gapsConfirmed} confirmed gap(s). Keep every other section byte-identical, bump the frontmatter version (minor), set provenance as instructed and recompute provenance.inputsHash exactly as the company-summary schema describes. Validate with \`node .claude/scripts/validate-data.mjs ${SUMMARY}\`. Do not append to the ledger: follow report-templates section 5 step 6 and return the report observation as proposedObservation (omit the field when the report was already current).`, {
    label: 'summary data-flows', phase: 'Summary', agentType: 'report-writer', effort: 'low',
    schema: { type: 'object', required: ['updated'], properties: { sessionId: { type: 'string' }, updated: { type: 'boolean' }, version: { type: 'string' }, proposedObservation: { type: 'object', description: 'report-templates section 5 step 6 observation record without id and recordedAt' }, notes: { type: 'string' } } },
  });
  if (summary) { noteSession(summary); result.summaryUpdated = Boolean(summary.updated); proposedObservation = summary.proposedObservation || null; }
  else skipped.push('summary: report-writer returned nothing; data-flows section not updated');
}

// ---------------------------------------------------------------- Version (append the report observation, then version once)
phase('Version');
if (dryRun) {
  skipped.push('dry run: soc/version.mjs not run by design');
} else if (!result.observations && !proposedObservation) {
  log('Nothing appended to the ledger; version skipped');
} else {
  const version = await agent(`${common('soc-ledger-keeper')}
${proposedObservation ? `First append the report-writer's proposed observation (report-templates section 5 step 6) via append.mjs: mint id obs_<ULID>, set recordedAt NOW, keep every other field; if its controlIds is empty or names a control that is not in the ledger, use the data-inventory control this run's Ledger stage cited. Record: ${JSON.stringify(proposedObservation)}
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
log(`${WORKFLOW} done: metastore ${result.metastoreWritten ? 'written' : 'unchanged'}, ${result.observations} observations, version ${result.versionFile || 'none'}, ${skipped.length} skipped item(s) logged`);
return result;
