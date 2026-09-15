---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "5.3.0"
sections: [overview, regulatory-posture, applications, vendors, data-flows, control-summary, open-findings]
provenance:
  harness: opencode
  generatedAt: "2026-09-15T15:14:31Z"
  sessionId: ses_f5a4f0e07ffeV5eqNxf7yDi0wc
  runId: run_01M2GDZ3Q3S5WYCB3MV02QJXZ1
  workflow: probe-agent-graph
  agent: report-writer
  model: "cloudflare-workers-ai/@cf/zai-org/glm-5.3"
  inputsHash: 81a185da81995e31326df0567ba00018a651c722d25592c8b23c7e1ac3d63a4a
---
# Example Capital Markets — cyber resilience summary

## overview
Fictional fixture company: a SEBI mid-size RE discount broker and depository participant with an RBI middle-layer NBFC
arm, headquartered in Mumbai. Two applications are in scope: `mcp-gateway` (a MongoDB MCP server used by internal
AI agents) and `db-models` (a shared Python data-model library). Workflows populate the remaining sections.

## Regulatory posture
Active registrations (`company-profile/example-co/details.json`): SEBI INZ000999999 (category `mid-size-re`,
status active), SEBI IN-DP-999-2016 (category `mid-size-re`, status active, depository participant), RBI
N-13.09999 (category `nbfc-middle-layer`, status active).

Frameworks in scope (8): `sebi-cscrf-2024`, `rbi-cyber-tech-directions-2026`, `rbi-outsourcing-risk-directions-2025`,
`cert-in-directions-2022`, `dpdp-rules-2025`, `iso-27001-2022`, `dpdp-act-2023`, `rbi-digital-payment-security-2021`.

**Drift applied this run: 2 × `instrument_became_applicable` on `/frameworksInScope` (both recorded
2026-09-14T17:03:20Z).**

- `dpdp-act-2023` appended [obs_01M2GH97KXN2WXTZ181R216N5C] (result `not-satisfied`, control `dpdp-rules-2025:1`):
  the instrument registry lists the MeitY DPDP Act 2023 as applicable to this company's entity types
  `stock-broker`, `depository-participant` and `nbfc` in jurisdiction `IN`, effective 2025-11-13 and already
  commenced, while `frameworksInScope` covered the DPDP regime only through `dpdp-rules-2025`.
- `rbi-digital-payment-security-2021` appended [obs_01M2GH97M1CSN3D82H8M6WM8GN] (result `not-satisfied`, control
  `rbi-cyber-tech-directions-2026:12`): the registry lists it as applicable to `nbfc` in jurisdiction `IN`,
  effective 2021-08-18, and it was absent from `frameworksInScope` before this run; the observation carries the
  registry caveat that its status after RBI's Nov 2025 and Jul 2026 consolidations is not yet verified on
  rbi.org.in and must be confirmed before citing.

1 escalated claim awaiting human resolution as of this refresh: [rsk_01M2GH97M1ZYX3TQJ4BJ0CEE6M] (`high`,
status `investigating`, control `sebi-cscrf-2024:GV.OC.S2`) — SEBI's Recognised Intermediaries register returns
"No record(s) available." for DP registration IN-DP-999-2016 while `details.json` lists the
`depository-participant` entity type backed by that registration as active, so the company may be operating
depository-participant services without a currently valid SEBI DP registration (or the profile may misstate the
licence); the claim was not unanimously confirmed (the entity-identity lens refuted, two lenses did not). Per the
`refresh-ctx` rules the entity type is left in place and the claim is escalated for human resolution against
CDSL's and NSDL's own DP lists and the SEBI register.

Refresh date: 2026-09-14 (`provenance.generatedAt` 2026-09-14T17:03:20Z).

<!-- source: details.json regulatoryRegistrations and frameworksInScope; soc/main.jsonl kind:observation title "instrument_became_applicable: /frameworksInScope" with provenance.runId run_01M2GDZ3Q3S5WYCB3MV02QJXZ1 (2 records, lines 692-693); escalated claim = kind:risk rsk_01M2GH97M1ZYX3TQJ4BJ0CEE6M (line 694) -->

## Applications

`refresh-apps` (runId `run_01M2GDZ3Q3S5WYCB3MV02QJXZ1`) refreshed this section as of 2026-09-14T23:04:57Z: 2/2
repos synced, 0 commits advanced, 2 record(s) written, 7 confirmed gap(s). 2 applications are in scope, the union
of the `applications/*/` directories and `details.json` `criticalFunctions[].appIds` (`mcp-gateway` is the only
application backing the `order-routing` critical function). Both repo records were rewritten this run
(`lastFetchedAt` 2026-09-14T23:04:57Z) with unchanged pins ([obs_01M2H53C4QM42QXRZJXXT52ADM],
[obs_01M2H2N7D8M45YFXJNZ7C3VQMT]). Environment log retention below is compared with CERT-In
cert-in-directions-2022 Dir-iv (CERT-In Directions 2022), which requires 180 days of logs.

### mcp-gateway

Internal MongoDB MCP gateway used by ExampleCo's AI agents to query the client-data and order stores (data
classes pii, financial; `applications/mcp-gateway/README.md`); the only application backing `order-routing`
(`details.json` `criticalFunctions[0].appIds`).

Environments (`applications/mcp-gateway/env/*.json`):

| Env | Tier | Exposure | Residency | Log retention (days) | Logs in India | vs Dir-iv (180 d) |
|---|---|---|---|---|---|---|
| prod | prod | partner | IN | 365 | yes | meets (>= 180 d) |
| qa | qa | internal | IN | 180 | yes | meets (exactly 180 d) |
| dev | dev | internal | IN | 30 | yes | below 180 d |

Dev's 30-day log retention is below the 180 days required by CERT-In cert-in-directions-2022 Dir-iv.

Repo: `mongodb-mcp-server` — `https://github.com/OnFinance/mongodb-mcp-server.git` (public, host github, default
branch `main`, build system pnpm, CI github-actions): head commit (pinned)
`aaa72a040db4c32f3d6488d5e28e2892a68e9ee0`, last fetched 2026-09-14T23:04:57Z; 0 commits advanced this run
[obs_01M2H53C4QM42QXRZJXXT52ADM] (result `partial`).

Images: 0 image records (missing) — `applications/mcp-gateway/images/` does not exist, so no registry digest or
SBOM is on file. The repo's CI builds and pushes `docker.io/mongodb/mongodb-mcp-server` and the deployment IaC
registered to qa and prod deploys `docker.io/mongodb/mongodb-mcp-server:1.11.0`, but no record tracks the image
that actually runs in these environments [obs_01M2H53C4VE2YHVQ9GFZM9AYYX] (result `not-satisfied`,
`sebi-cscrf-2024:ID.AM.S1`).

Open findings: 7 (6 high, 1 medium), all targeting repo `mcp-gateway/mongodb-mcp-server`. Last probe
`collectedAt`: 2026-09-14T13:14:50Z (`probe-schemas`; `probe-iac` ran earlier at 2026-09-14T11:33:17Z).

Confirmed drift and credential gaps from this run (all 7 involve `mcp-gateway`):

- untracked-repo (1): the vulnerability-scanner agentic workflow checks out the upstream repository
  `mongodb-js/mongodb-mcp-server`, which no record under `applications/` covers, so code fetched from it during
  CI is outside Maxwell's per-repo pinning and inventory [obs_01M2H53C4V6GBVSZKD5DAV56XK] (partial,
  `sebi-cscrf-2024:ID.AM.S1`, `sebi-cscrf-2024:ID.AM.S3`).
- env-iac-drift (2): the qa and prod environment records declare EKS clusters and AWS Secrets Manager, but the
  deployment IaC registered to both environments deploys an Azure Container Apps managed environment with
  azure-container-apps-secrets [obs_01M2H53C4VPQP4WRQERB4K5QGH] (not-satisfied, `sebi-cscrf-2024:PR.IP.S3`).
- env-url-drift (2): the qa and prod environment records carry no `urls` array while their deployment IaC
  declares an external public ingress and outputs the public MCP endpoint URL; qa records exposure `internal`
  while its IaC declares an external ingress [obs_01M2H53C4V0G8DQMQRW2R0YNAA] (partial,
  `sebi-cscrf-2024:ID.AM.S1`).
- image-untracked (1): `docker.io/mongodb/mongodb-mcp-server`, built in CI and deployed to qa and prod (see
  Images above) [obs_01M2H53C4VE2YHVQ9GFZM9AYYX] (not-satisfied, `sebi-cscrf-2024:ID.AM.S1`).
- credentials-unverifiable (1): `applications/mcp-gateway/credentials.json` is present and sops-encrypted, but
  no age decryption key is available on the executor, so the dev (`dev-docker-socket`), qa (`qa-kubeconfig-ro`)
  and prod (`prod-kubeconfig-ro`) probe credential entries and their rotation dates cannot be verified
  [obs_01M2H53C4VDK68193RX7H52D3Y] (inconclusive, `sebi-cscrf-2024:PR.AA.S1`).

### db-models

Shared Python data-model library consumed by internal services (dev only, no runtime;
`applications/db-models/README.md`).

Environments (`applications/db-models/env/dev.json`): 1 environment.

| Env | Tier | Exposure | Residency | Log retention (days) | Logs in India | vs Dir-iv (180 d) |
|---|---|---|---|---|---|---|
| dev | dev | isolated | IN | 0 | yes | below 180 d |

`probeAccess.method` is `none` (no credential key). The 0-day log retention is below the 180 days that
CERT-In cert-in-directions-2022 Dir-iv requires.

Repo: `onfinance-db-model-master` — `https://github.com/OnFinance/onfinance_db_model_master.git` (public, host
github, default branch `master`, build system pip, CI none): head commit (pinned)
`70b3633e171a1b8d389b27bb901c84c34a0e9bf6`, last fetched 2026-09-14T23:04:57Z; 0 commits advanced this run
[obs_01M2H2N7D8M45YFXJNZ7C3VQMT] (result `satisfied`: the refresh confirmed no gaps involving this repo).

Images: 0 image records (missing) — no `applications/db-models/images/` directory exists; no image-related gap
was confirmed for this application this run.

Open findings: 0. Last probe `collectedAt`: 2026-09-14T13:14:50Z (`probe-schemas`, e.g.
[obs_01M2G24FKAKAVS5JTG628HDYT2]).

<!-- source: applications/*/README.md, env/*.json (tier, exposure, residency, observability.logsRetentionDays, logsInIndia) and repos/*.json (url, defaultBranch, pinnedCommit, lastFetchedAt); run summary (2/2 synced, 0 advanced, 2 repo records written, 7 gaps) from soc/main.jsonl kind:observation methods ["refresh-apps"] (7 records, lines 735-741; gaps = untracked-repo 1 + env-iac-drift 2 + env-url-drift 2 + image-untracked 1 + credentials-unverifiable 1); open findings = latest kind:finding per id, status open, target repo (mcp-gateway: 7, lines 423-429; db-models: none); no applications/*/images/ directory exists (Glob returned no files) -->

## Vendors
`refresh-vendor-ctx` refreshed this section as of 2026-09-14T20:15:18Z: 0 vendors onboarded, 1 updated
(`mongodb-atlas`, re-read at 2026-09-14T20:15:18Z), 6 findings re-seen — the run's ledger write reported
1 new finding, but every flag this run matched a finding already on the ledger, so all six were superseded
rather than duplicated and no new finding id was appended ([obs_01M2GVRF8XQRHSY1GTYN4DTKWQ],
[obs_01M2GWH5Y6PQN67B17YNGV0MK5], [obs_01M2GXD5EJHEBW7GHMMNKHJHV9]; each assesses
`sebi-cscrf-2024:GV.SC.S3`, result `not-satisfied`). Source:
`company-profile/example-co/vendors/*.json` (3 files) and vendor-targeted findings in `soc/main.jsonl`.

| Vendor | Legal name | Status | Materiality | Critical functions | Hosting vs. residency | Newest assurance | Expiry | Open findings |
|---|---|---|---|---|---|---|---|---|
| `aws` | Amazon Web Services, Inc. | active | material | order-routing (`mcp-gateway`) | AWS ap-south-1, hosting `IN`; app residency requirement `IN` (match) | soc2-type2 (Ernst & Young LLP, period ending 2026-03-31) | 2027-03-31 | [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] |
| `github` | GitHub, Inc. | active | material | none (`supportsCriticalFunction: false`; repos back `mcp-gateway`, `db-models`) | GitHub Enterprise Cloud, hosting `US`; no critical function assigned so no residency requirement applies | soc2-type2 (Ernst & Young LLP, period ending 2025-09-30) | 2026-09-30 | [fnd_01M2FS4806WHXANC3Q9QXEAXGF], [fnd_01M2FS481DGTPTR9NJGKAAMF49], [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] |
| `mongodb-atlas` | MongoDB, Inc. | active | material | order-routing (`mcp-gateway`) | Atlas on AWS ap-south-1, hosting `IN`; app residency requirement `IN` (match) | none on file | n/a | [fnd_01M2FS9EBVSP2DPWN5K2D91QKW], [fnd_01M2FS9ECP3E0MTCRQFEJ97930] |

<!-- source: company-profile/example-co/vendors/*.json services[].hostingCountries vs applications/mcp-gateway/env/*.json residency; open findings = latest kind:finding per id with target.type:vendor and status open in soc/main.jsonl (all six vendor findings re-seen and superseded by this run's records, appended 2026-09-14T20:15:18Z) -->

Expiry note: GitHub's SOC 2 Type II report expires 2026-09-30, 16 days after this run's
`provenance.generatedAt` (2026-09-14T20:15:18Z), inside the 90-day assurance-expiring window; flagged in
[fnd_01M2FS4806WHXANC3Q9QXEAXGF]. `mongodb-atlas` carries no `assurance[]` entry in its vendor file at all.

## Data flows
`refresh-metastore` catalogued this run: 2 catalogs (0 carried forward, 0 dropped), 14 tables, 36 PII columns,
3 pipelines, 0 lineage edges, 14 confirmed gap(s), from `company-profile/example-co/sdlc/metastore.json`
(`snapshotAt` 2026-09-14T21:59:48Z).

### Catalogs by application

| App | Catalog | Type | Tables | PII columns | Residency |
|---|---|---|---|---|---|
| `db-models` | `db-models-mongodb` | other (MongoDB document store; the metastore schema has no document-store catalog type, see the schema-gap below) | 14 | 36 | `IN` required (`details.json` `dataResidency`; `applications/db-models/env/dev.json` `residency`) but unconfirmable: the database location and region are unknown and `endpointRef: db-models-mongodb-ro` is a placeholder key no credentials entry resolves to [obs_01M2H1BMCQGCC0A07HJBMEQCJY] |
| `mcp-gateway` | `mcp-gateway-mongodb` | other (schema list recorded empty: the databases and collections exist only in the runtime-configured cluster) | 0 | 0 | `IN` required (`details.json` `dataResidency`; `applications/mcp-gateway/env/prod.json` `residency`) but unconfirmable: the served cluster is named only by `MDB_MCP_CONNECTION_STRING` at runtime, and `endpointRef: prod-kubeconfig-ro` is the prod probe credential key recorded per the modelling rule [obs_01M2H1VF3NG1KJVRS9ZYFX9A76]; the default telemetry egress to cloud.mongodb.com is a confirmed residency-conflict [obs_01M2H1VF3NM8DYDYMP8J6A6SDD] |

Table-level counts (columns / of which PII), all under schema `default` in `db-models-mongodb`: `secrets` 7/6,
`webinar` 4/0, `communities` 5/1, `new_discussions` 20/7, `entity` 48/7, `insights_raw` 23/0,
`insights_raw_crypto` 23/0, `insights_raw_us_stocks` 23/0, `insights` 26/0, `user` 54/13, `notifications`
8/0, `feedback` 3/1, `reward` 9/1, `cached_chats` 2/0 (sum: 14 tables, 255 columns, 36 PII columns).
`secrets` and `user` also carry `spdi` and `financial`-classified columns (broker trading-account
credentials, portfolio holdings and values); the stricter classes were taken in the catalog this run
[obs_01M2H1BMCQYAYTWGP8BKYXCKFY]. `mcp-gateway` is the only application backing the `order-routing`
critical function (`details.json` `criticalFunctions[0]`); whether `mcp-gateway-mongodb` and
`db-models-mongodb` are the same physical cluster is requested for runtime confirmation
[obs_01M2H1VF3NKNYJHS8Z8BXZT3DE].

### Pipelines and lineage
3 pipelines recorded, all owned by repo `mcp-gateway/mongodb-mcp-server`, orchestrator `custom`
[obs_01M2H1VF3G4EVWWZZSTT2DJXBB]. Each source -> job -> sink chain carries pii or financial data (no
cardholder-classified column exists in either catalog):

- `mongodb-mcp-tool-handler` — source: the runtime-configured MongoDB cluster named by
  `MDB_MCP_CONNECTION_STRING` (prod `dataClassification` is `pii, financial`,
  `applications/mcp-gateway/env/prod.json`) -> job: the MCP tool-call handler (find, aggregate, insert,
  update and delete tools) -> sink: the same cluster [obs_01M2H1VF3NKNYJHS8Z8BXZT3DE].
- `mongodb-mcp-export-tool` — source: the MongoDB cluster via find/aggregate -> job: the export tool ->
  sink: plaintext EJSON JSON files in the host exports folder (`~/.mongodb/mongodb-mcp/exports/<sessionId>/`,
  expired after 5 minutes and removed recursively on shutdown), carrying pii and financial data in prod;
  the pipeline object has no sink field, so this lives in the name and in the schema-gap below
  [obs_01M2H1VF3N8NATYT9XVASD12XF].
- `mongodb-mcp-telemetry` (schedule: every 30 seconds) — source: in-process events -> job: the telemetry
  batch sender -> sink: the MongoDB Atlas cloud telemetry API (`apiBaseUrl` default cloud.mongodb.com),
  carrying `device_id` (a device identifier, pii), `session_id` and tool events including `cluster_name` —
  a personal-data egress outside residency `IN`, confirmed as a residency-conflict
  [obs_01M2H1VF3NM8DYDYMP8J6A6SDD].

`lineage: []` — 0 OpenLineage edges, so the chains above rest on the pipeline records and gap
descriptions, not on recorded dataset lineage.

### Retention versus in-scope instruments
Record-keeping periods stated by the in-scope instruments — data retention: CERT-In
`cert-in-directions-2022:Dir-v` and `cert-in-directions-2022:Dir-vi` (CERT-In Directions 2022) 5 years;
MeitY `dpdp-rules-2025:8(3)` (DPDP Rules 2025) 1 year; `dpdp-rules-2025:8(1)` 3 years;
`dpdp-rules-2025:Sch1.B.4` 7 years. Log retention: CERT-In `cert-in-directions-2022:Dir-iv` 180 days;
MeitY `dpdp-rules-2025:6(1)(e)` 1 year; SEBI `sebi-cscrf-2024:PR.AA.S9` (SEBI CSCRF 2024) 6 months and
2 years for uniquely identified user logs on critical systems; RBI
`rbi-cyber-tech-directions-2026:95` (RBI Cyber Tech Directions 2026) 180 days.

No table in either catalog carries a `retentionDays` value in `sdlc/metastore.json`, so no recorded
retention period can be compared against any period above: nothing recorded in the metastore satisfies or
breaches them. For the client portfolio holdings and broker trading-account credentials in `user` and
`secrets`, no record-keeping period stated by an in-scope instrument — the company's own retention and
erasure schedule is the requested evidence [obs_01M2H1BMCQ18AF390G2D1VH8ZV]. Log retention is recorded
outside the metastore: the `mongodb-mcp-server` on-disk logger keeps tool-call and server logs only
30 days, below all four in-scope log-retention periods — a confirmed `not-satisfied` gap
[obs_01M2H1VF3NXP9G2FQRS3M7VTT2]. Prod's SIEM retention is declared as 365 days with logs in India
(`applications/mcp-gateway/env/prod.json` `observability`), above Dir-iv's 180 days; confirming that the
disk logger stays off in prod and that stderr reaches that SIEM is the open evidence request
[obs_01M2H1VF3NXP9G2FQRS3M7VTT2].

### Confirmed gaps (14)
db-models / onfinance-db-model-master (9): 1 endpointRef-missing [obs_01M2H1BMCQGCC0A07HJBMEQCJY], 3
evidence-request [obs_01M2H1BMCQ18AF390G2D1VH8ZV], 4 classification-conflict
[obs_01M2H1BMCQYAYTWGP8BKYXCKFY], 1 schema-gap [obs_01M2H1BMCQ3ZZXYQDBVVJ6KKFN]. mcp-gateway /
mongodb-mcp-server (5): 1 endpointRef-missing [obs_01M2H1VF3NG1KJVRS9ZYFX9A76], 1 evidence-request
[obs_01M2H1VF3NKNYJHS8Z8BXZT3DE], 1 log-retention-below-180d [obs_01M2H1VF3NXP9G2FQRS3M7VTT2], 1
residency-conflict [obs_01M2H1VF3NM8DYDYMP8J6A6SDD], 1 schema-gap [obs_01M2H1VF3N8NATYT9XVASD12XF].
Catalogue-level summaries: [obs_01M2H1BMCKM3TKBQR8T1MD9H9N] (db-models, result `partial`) and
[obs_01M2H1VF3G4EVWWZZSTT2DJXBB] (mcp-gateway, result `not-satisfied`).

<!-- source: sdlc/metastore.json catalogs[].schemas[].tables[].columns[] counted by pii:true; soc/main.jsonl kind:observation with provenance.workflow refresh-metastore and provenance.runId run_01M2GDZ3Q3S5WYCB3MV02QJXZ1, recordedAt 2026-09-14T21:59:48Z (lines 723-733) -->

## Control summary
Latest control record per id (last line per record id, supersession chain respected) in `company-profile/example-co/soc/main.jsonl`
as of `provenance.generatedAt` 2026-09-14T18:35:14Z, grouped by instrument: 544 control records, 478 applicable, 66
not-applicable. `refresh-soc` created 360 of them at 2026-09-14T09:55:06Z; `probe-iac` and `probe-schemas` have since
re-assessed 19 controls from their observations; the instrument migration at 2026-09-14T14:41:43Z added the 176
`rbi-outsourcing-risk-directions-2025` controls and superseded the 64 `rbi-it-outsourcing-md-2023` controls as
not-applicable; this run added 4 new controls and re-assessed 10.

- `sebi-cscrf-2024` (SEBI CSCRF 2024): 124 controls; 0 effective, 4 partially effective, 8 ineffective, 112 not tested; coverage 12 % (15 observed of 124).
- `rbi-cyber-tech-directions-2026` (RBI Cyber Tech Directions 2026): 99 controls, 2 not applicable; 0 effective, 0 partially effective, 1 ineffective, 96 not tested of 97 applicable; coverage 2 % (2 observed of 97).
- `rbi-outsourcing-risk-directions-2025` (RBI Outsourcing Directions 2025): 176 controls; 0 effective, 0 partially effective, 0 ineffective, 176 not tested; coverage 0 % (0 observed of 176).
- `dpdp-rules-2025` (DPDP Rules 2025): 52 controls; 0 effective, 2 partially effective, 4 ineffective, 46 not tested; coverage 13 % (7 observed of 52).
- `cert-in-directions-2022` (CERT-In Directions 2022): 29 controls; 0 effective, 0 partially effective, 1 ineffective, 28 not tested; coverage 3 % (1 observed of 29).
- `rbi-it-outsourcing-md-2023` (repealed 2025-11-28): 64 controls, all 64 not applicable; excluded from the effectiveness counts and from coverage.
- Total: 544 controls (478 applicable); 0 effective, 6 partially effective, 14 ineffective, 458 not tested; coverage 5 % (25 observed of 478).

This run (`refresh-soc`, runId `run_01M2GDZ3Q3S5WYCB3MV02QJXZ1`, `recordedAt` 2026-09-14T18:35:14Z) appended 14 control
records. 4 new: `dpdp-rules-2025:Sch1.B.10`, `dpdp-rules-2025:Sch1.B.11`, `dpdp-rules-2025:Sch1.B.12` and
`dpdp-rules-2025:Sch1.B.13` (category Consent Manager), all `not-tested`, `nextDueAt` set from this run. 10 re-assessed:
`sebi-cscrf-2024:GV.SC.S3` now `ineffective`, `lastAssessedAt` 2026-09-14T10:46:39Z from the `refresh-vendor-ctx`
observation [obs_01M2FS9EB1DXGYJVY2AQEZD8KB], with the `nextDueAt` its record was missing restored (cadence event-driven
per catalog); `rbi-cyber-tech-directions-2026:12` now `ineffective`, `lastAssessedAt` 2026-09-14T17:03:20Z from
[obs_01M2GH97M1CSN3D82H8M6WM8GN]; `dpdp-rules-2025:1` now `ineffective`, `lastAssessedAt` 2026-09-14T17:03:20Z from
[obs_01M2GH97KXN2WXTZ181R216N5C]; `rbi-cyber-tech-directions-2026:77` and `rbi-cyber-tech-directions-2026:134` moved to
`not-applicable` (catalog applicability no longer intersects the company's entity types and RE categories), keeping their
probe-era effectiveness (`ineffective`, `partially-effective`) as history; `sebi-cscrf-2024:GV.SC.S7`,
`rbi-cyber-tech-directions-2026:126`, `rbi-cyber-tech-directions-2026:174`, `rbi-cyber-tech-directions-2026:182` and
`dpdp-rules-2025:6(1)(f)` re-assessed still `not-tested`, with missing `nextDueAt` values restored. Reconciliation this run:
0 findings resolved by the absent-twice rule, 0 findings and 0 risks reopened after expired acceptances, 0 SLA dates
recomputed.

Maxwell observed 25 of the 478 applicable controls in this period (5 %); 5 controls were inconclusive for lack of access
([obs_01M2FTV6K4Q25G1JT58HAZDV36], [obs_01M2FTV6MCKCJTVHDHHP02KJ2V], [obs_01M2FTV6NJKW6WV58KFH78E5AV]); 0 environments
were skipped (no runtime probe ran and the ledger records no freeze, window or credential skip). Coverage basis: applicable
control ids named in the `controlIds` of at least one of the 45 ledger observations (39 substantive, 6 report-generation,
all collected on 2026-09-14), over the 478 applicable controls; this mirrors `cm_coverage`
(kpis/measurement/cm_coverage.md), except that the KPI's `excludedWorkflows` (kpis/metrics.json) drops `refresh-*`
observations, which would give 18 of 478 (4 %).

<!-- source: latest-state map over soc/main.jsonl kind=control (710 lines, last line per record id), grouped by instrument id prefix before ':'; effectiveness counts exclude implementationStatus not-applicable; coverage = applicable control ids in controlIds of the 45 kind=observation records -->

## Open findings
`probe-agent-graph` ran against `example-co` this run (`provenance.runId` run_01M2GDZ3Q3S5WYCB3MV02QJXZ1; this run's 50 ledger
lines were appended by the `soc-ledger-keeper` at 2026-09-15T15:14:31Z, session 453ecc6e-1346-418f-a2c0-1bfcead851c3): 10 new
agent-graph finding(s) ([fnd_01M2K7B0MJ68AR00YTNE2N00V2], [fnd_01M2K7B0MJW0K9WFVMPWT86BRE], [fnd_01M2K7B0MJ9BHSS0T664GGCW4N],
[fnd_01M2K7B0MJTNGRN4D0GZYBD5FS], [fnd_01M2K7B0MJN2XBQRW2XYYD6EBJ], [fnd_01M2K7B0MJQMT1S973WHW7K9GA],
[fnd_01M2K7B0MJJVWFWXF6KZ783GFZ], [fnd_01M2K7B0MJMG3TT4DFMEJWQDA8], [fnd_01M2K7B0MJ3239WAE0AKHRMK5E],
[fnd_01M2K7B0MJEKMTTH4EAKR1RHZY]), 0 re-seen (0 reopened) and 19 observation(s) — 4 `not-satisfied`
([obs_01M2K7B0MD6QPQYB5WX88W6X26], [obs_01M2K7B0MG6AJ4RNM48WZ65700], [obs_01M2K7B0MG9FJF21H81SMCBX3N],
[obs_01M2K7B0MGN30JPJFJ01YFGFH8]) and 15 `partial` ([obs_01M2K7B0MGRPDQ90XDE5PWYD7X], [obs_01M2K7B0MGJTYJ48C79N082WKV],
[obs_01M2K7B0MGNJTVJWN1NR4KP3F2], [obs_01M2K7B0MG83DXF609SVQX7AG9], [obs_01M2K7B0MGN03WM0T8X8C9WZTT],
[obs_01M2K7B0MGE3N7DVSDRHCDP3A1], [obs_01M2K7B0MGDC152RR083QKRDFK], [obs_01M2K7B0MGK245K0KKPZGG86CG],
[obs_01M2K7B0MGSDQDM6V06G1WM1AE], [obs_01M2K7B0MGNPK1C8RM7R8XWRX4], [obs_01M2K7B0MGKZBRBVQGA80GRADE],
[obs_01M2K7B0MGBQDKD63TYG9QF1HF], [obs_01M2K7B0MGW8N6BB0Q9XHZSWAQ], [obs_01M2K7B0MGB78NWYAXV8KAJ6X3],
[obs_01M2K7B0MJ8BDDZVARMWZSX5MQ]) — against the probed repo `mcp-gateway/mongodb-mcp-server` at pinned commit
aaa72a040db4c32f3d6488d5e28e2892a68e9ee0 (evidence:
`kpis/data/raw/sessions/opencode/run_01M2GDZ3Q3S5WYCB3MV02QJXZ1.probe-agent-graph.mcp-gateway.mongodb-mcp-server.sarif.export.json`,
sha256 c3c7b9dc…). The batch also created 2 new control records (`rbi-cyber-tech-directions-2026:83` and
`rbi-cyber-tech-directions-2026:88`, both `not-tested`) and re-assessed 19 controls — `sebi-cscrf-2024:PR.AA.S3`,
`sebi-cscrf-2024:PR.AA.S17`, `sebi-cscrf-2024:PR.DS.S6` and `dpdp-rules-2025:6(1)(b)` now `ineffective`, the other 15
`partially-effective`.

All ten new findings are agent-graph gaps in that repo — the deployed MCP gateway behind the `order-routing` critical
function — and every record carries an OWASP owasp-agentic-top10-2026 (OWASP Agentic Top 10 2026) mapping alongside its
primary SEBI CSCRF ref. Two break human oversight of destructive agent actions: the elicitation confirmation gate fails
open for clients without elicitation capability, so the eight default confirmation-required tools execute with no human
approval against headless harnesses while `aiCodingPolicy.humanReviewRequired` is true
[fnd_01M2K7B0MJ68AR00YTNE2N00V2] (OWASP owasp-agentic-top10-2026 ASI09), and 11 of 19 write-capable tools are enabled by
default with no approval step or allow-list [fnd_01M2K7B0MJQMT1S973WHW7K9GA] (OWASP owasp-agentic-top10-2026 ASI02).
Three are API-surface gaps: the HTTP MCP transport is deployed unauthenticated on 0.0.0.0 in the AWS deploy path the qa
and prod records register [fnd_01M2K7B0MJW0K9WFVMPWT86BRE] (OWASP owasp-agentic-top10-2026 ASI03), connect and
switch-connection accept model-controlled connection strings with no host allow-list
[fnd_01M2K7B0MJJVWFWXF6KZ783GFZ] (OWASP owasp-agentic-top10-2026 ASI03), and the HTTP endpoint has no rate limiting or
concurrency caps [fnd_01M2K7B0MJEKMTTH4EAKR1RHZY] (OWASP owasp-agentic-top10-2026 ASI08). Four are supply-chain gaps: the
AWS deploy image installs the server unpinned at registry latest on an unpinned base [fnd_01M2K7B0MJ9BHSS0T664GGCW4N],
the setup wizard writes npx -y mongodb-mcp-server@latest into six harness MCP configs
[fnd_01M2K7B0MJTNGRN4D0GZYBD5FS], the setup flow installs third-party agent skills globally with no integrity check
[fnd_01M2K7B0MJN2XBQRW2XYYD6EBJ], and the repo ships developer-harness configuration for GitHub Copilot outside
`aiCodingPolicy.harnessesAllowed` [fnd_01M2K7B0MJ3239WAE0AKHRMK5E] (all four OWASP owasp-agentic-top10-2026 ASI04). One
is an egress gap against IN residency: search-knowledge posts the unredacted model-composed query to
knowledge.mongodb.com by default [fnd_01M2K7B0MJMG3TT4DFMEJWQDA8] (OWASP owasp-agentic-top10-2026 ASI03). No finding
from this run targets db-models.

Latest record per finding id in `company-profile/example-co/soc/main.jsonl` with `status` in
`open | triaged | remediating`, as of `provenance.generatedAt` 2026-09-15T15:14:31Z (34 open, 0 past SLA):

### High

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FS4806WHXANC3Q9QXEAXGF] | assurance-expiring: github-cloud SOC 2 Type II report expires 2026-09-30, inside 90-day window | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S4 (SEBI CSCRF 2024) | 2026-09-14 | 2026-10-14T10:46:39Z | due in 29 d | open | n/a |
| [fnd_01M2FS9ECP3E0MTCRQFEJ97930] | contract-expiring: ATLAS-2025-1189 ended 2026-05-31, 106 days before NOW, no renewal evidence | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S4 | 2026-09-14 | 2026-10-14T10:46:39Z | due in 29 d | open | n/a |
| [fnd_01M2G2AGPX8KWSY1KXGYADK4TK] | find tool returns full unmasked documents from pii/financial collections | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 5 d | open | n/a |
| [fnd_01M2G2AGR581507FMK0EADFKY6] | aggregate tool returns full unmasked pipeline results | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 5 d | open | n/a |
| [fnd_01M2G2AGSC977KASP37WQXYSQA] | export tool writes full unmasked documents to an unencrypted local file | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 5 d | open | n/a |
| [fnd_01M2G2AGVRZPBP3VH8FNAYH46V] | MCP HTTP transport endpoint ships with no authentication, rate limiting or idempotency controls by default | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 5 d | open | n/a |
| [fnd_01M2G2AGTH64FMR4XR77ZAJH7B] | atlas-create-db-user takes a plaintext password argument and echoes the generated password back in the tool response | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S6 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 5 d | open | n/a |
| [fnd_01M2HCWMBDDT80V2CWJ5Z7BH17] | MCP gateway deploys unauthenticated on a public endpoint by default (qa/prod IaC root) | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBDGA1D4Z54RET9CNC9] | Baseline deployment parameters ship the gateway with no auth and write mode enabled | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBDCEGN51BKVVXGTV67] | qa/prod deployment template defines no logging, diagnostics or SIEM forwarding | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S8 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBDJTN23D3600K6QX9M] | Deployment location not constrained to India for an IN-residency pii/financial workload | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S13 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBDH7QTRQH0XHDBPAJK] | Single replica with autoscaling disabled for the order-routing critical function | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 RC.RP.S1 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBD5YRM4M6TKKT1M974] | Dev-root Dockerfile installs the server and base image unpinned (latest by default) | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S6 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBDBP41GF0TNY5731M8] | AWS deploy-root Dockerfile hardcodes @latest npm install for the qa/prod image | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S6 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HCWMBDEHJMTP3A934TCM7Q] | No owner, data-classification or environment tags on the deployed resources | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 ID.AM.S1 | 2026-09-15 | 2026-09-22T00:05:59Z | due in 7 d | open | n/a |
| [fnd_01M2HRGEX25CQZERDVHPVF1B96] | connect tool accepts a MongoDB connection string with embedded credentials as a plain tool argument | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S6 | 2026-09-15 | 2026-09-22T02:47:35Z | due in 7 d | open | n/a |
| [fnd_01M2HRGF3S0NWNNWDBY1CHD934] | switch-connection tool accepts a connection string with embedded credentials as a plain tool argument | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S6 | 2026-09-15 | 2026-09-22T02:47:35Z | due in 7 d | open | n/a |
| [fnd_01M2HRGFABHFN9JE2TDMJX32RE] | export tool writes query results (pii, financial) to plaintext EJSON files with no encryption or access controls | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S1 | 2026-09-15 | 2026-10-15T02:47:35Z | due in 30 d | open | n/a |
| [fnd_01M2K7B0MJ68AR00YTNE2N00V2] | MongoDB MCP confirmation gate fails open: destructive tools execute without human approval | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJW0K9WFVMPWT86BRE] | HTTP MCP transport deployed unauthenticated on 0.0.0.0 in the AWS deploy path | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJ9BHSS0T664GGCW4N] | AWS deploy image installs the MCP server unpinned at registry latest | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.SC.S5 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJN2XBQRW2XYYD6EBJ] | Setup installs third-party agent skills globally with no integrity check | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S1 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJQMT1S973WHW7K9GA] | Write tools enabled by default: 11 of 19 write-capable tools have no approval and no allow-list | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJJVWFWXF6KZ783GFZ] | connect and switch-connection accept model-controlled connection strings with no host allow-list | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S2 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJ3239WAE0AKHRMK5E] | Repo ships developer-harness configuration for GitHub Copilot outside harnessesAllowed | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.PO.S1 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |
| [fnd_01M2K7B0MJEKMTTH4EAKR1RHZY] | No rate limiting or concurrency caps on the HTTP MCP endpoint | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-15 | 2026-09-22T15:14:31Z | due in 7 d | open | n/a |

### Medium

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] | material-without-evidence: aws-mumbai (order-routing, pii/financial) has no documented exit plan | vendor `aws` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2FS481DGTPTR9NJGKAAMF49] | contract-expiring: GH-ENT-2025-07 ended 2026-06-30, 76 days before now, no renewal evidence | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] | material-without-evidence: github lacks audit rights and a documented exit plan | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2FS9EBVSP2DPWN5K2D91QKW] | material-without-evidence: atlas-mumbai has no audit right and no documented exit plan | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2G2AGNMHKF9PCB4C85A3JQ3] | MongoDB MCP tool schemas carry no personal-data classification markers | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 12 d | open | n/a |
| [fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] | zod tool-argument schemas leave database-bound input unbounded and unvalidated | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 12 d | open | n/a |
| [fnd_01M2K7B0MJTNGRN4D0GZYBD5FS] | Setup wizard writes npx -y mongodb-mcp-server@latest into six harness MCP configs | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.SC.S2 | 2026-09-15 | 2026-09-29T15:14:31Z | due in 14 d | open | n/a |
| [fnd_01M2K7B0MJMG3TT4DFMEJWQDA8] | search-knowledge sends the unredacted model query to knowledge.mongodb.com by default | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S2 | 2026-09-15 | 2026-09-29T15:14:31Z | due in 14 d | open | n/a |

<!-- source: latest-state map over soc/main.jsonl kind=finding (903 lines, 49 finding records across 34 ids), last line per id, filtered to status in open|triaged|remediating; probe-agent-graph batch = lines 854-903 recordedAt 2026-09-15T15:14:31Z, keeper session 453ecc6e-1346-418f-a2c0-1bfcead851c3 (2 new controls 854-855, 19 observations 856-874, 10 findings 875-884, 19 re-assessed controls 885-903); severity counts 26 high + 8 medium = 34 open, 0 past SLA. The 10 new rows were verified field-by-field against ledger lines 875-884: status open, firstSeenAt 2026-09-15T15:14:31Z, target repo mcp-gateway/mongodb-mcp-server, severity via "severity":"high|medium","confidence":"confirmed" (8 high; medium = fnd_01M2K7B0MJTNGRN4D0GZYBD5FS and fnd_01M2K7B0MJMG3TT4DFMEJWQDA8), slaDueAt 2026-09-22T15:14:31Z for the 8 high (slaBasis sebi-cscrf-2024 PR.MA.S3 patch-sla high 7 d) and 2026-09-29T15:14:31Z for the 2 medium (patch-sla medium 14 d), regulatoryRefs[0] as tabulated, and an owasp-agentic-top10-2026 ASI mapping per record (ASI09 line 875, ASI02 line 880, ASI08 line 884, ASI04 lines 877-879 and 883, ASI03 lines 876, 881-882). Note: the description prose of fnd_01M2K7B0MJ9BHSS0T664GGCW4N and fnd_01M2K7B0MJTNGRN4D0GZYBD5FS names sebi-cscrf-2024 PR.DS.S6, but each record's structured regulatoryRefs[0] is the control tabulated here (GV.SC.S5 / GV.SC.S2); the structured fields govern. The 24 pre-existing rows are unchanged: no line in 854-903 carries a pre-existing finding id (the run re-seen 0 findings), so their latest records and the previous section's verified values stand (vendor rows lines 714-721, probe-iac rows 762-769, probe-schemas rows 825-830, first-run schema rows 423-429); their SLA status was recomputed against the new generatedAt. Observation result counts 4 not-satisfied + 15 partial = 19 from lines 856-874. SLA status = ceil((slaDueAt - 2026-09-15T15:14:31Z)/86400000) d; 0 rows past SLA -->

No findings in `risk-accepted`, `false-positive` or `duplicate` this period.
