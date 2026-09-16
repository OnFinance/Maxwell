---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "6.0.0"
sections: [overview, regulatory-posture, applications, vendors, data-flows, control-summary, open-findings, initiatives, suggestions]
provenance:
  harness: opencode
  generatedAt: "2026-09-16T02:18:09Z"
  sessionId: 453ecc6e-1346-418f-a2c0-1bfcead851c3
  runId: run_01M2GDZ3Q3S5WYCB3MV02QJXZ1
  workflow: impl-auto-improvement
  agent: report-writer
  model: "cloudflare-workers-ai/@cf/zai-org/glm-5.3"
  inputsHash: 9faddd89ec7009eeff89e4b15fe452ae4582f388e0689dd48b97c18b3393465b
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
as of `provenance.generatedAt` 2026-09-15T19:42:44Z, grouped by instrument: 551 control ids, 485 applicable, 66
not-applicable. The baseline for this section's previous write was the `refresh-soc` snapshot at 2026-09-14T18:35:14Z
(544 control ids, 478 applicable); four batches since appended 65 control records, creating 7 new control ids —
`sebi-cscrf-2024:PR.DS.S6` (`probe-iac`, 2026-09-15T00:05:59Z), `cert-in-directions-2022:Dir-v` and
`cert-in-directions-2022:Dir-vi` (`probe-schemas`, 2026-09-15T02:47:35Z), `rbi-cyber-tech-directions-2026:83` and
`rbi-cyber-tech-directions-2026:88` (`probe-agent-graph`, 2026-09-15T15:14:31Z) and `sebi-cscrf-2024:PR.DS.S5`
(`execute-scr`, this run) — and re-assessing 58 existing controls (16 by `probe-iac`, 23 by `probe-schemas`, 19 by
`probe-agent-graph`).

- `sebi-cscrf-2024` (SEBI CSCRF 2024): 126 controls; 0 effective, 18 partially effective, 8 ineffective, 100 not tested; coverage 30 % (38 observed of 126).
- `rbi-cyber-tech-directions-2026` (RBI Cyber Tech Directions 2026): 102 controls, 2 not applicable (`77` and `134`, both set not-applicable by `refresh-soc` at 2026-09-14T18:35:14Z and kept there by the 2026-09-15 batches, `134` retaining its partially-effective probe history); of 100 applicable: 0 effective, 7 partially effective, 2 ineffective, 91 not tested; coverage 11 % (11 observed of 100).
- `rbi-outsourcing-risk-directions-2025` (RBI Outsourcing Directions 2025): 176 controls; 0 effective, 0 partially effective, 1 ineffective, 175 not tested; coverage 1 % (1 observed of 176).
- `dpdp-rules-2025` (DPDP Rules 2025): 52 controls; 0 effective, 7 partially effective, 4 ineffective, 41 not tested; coverage 42 % (22 observed of 52).
- `cert-in-directions-2022` (CERT-In Directions 2022): 31 controls; 0 effective, 1 partially effective, 0 ineffective, 30 not tested; coverage 16 % (5 observed of 31).
- `rbi-it-outsourcing-md-2023` (repealed 2025-11-28): 64 controls, all 64 not applicable; excluded from the effectiveness counts and from coverage.
- Total: 551 controls (485 applicable); 0 effective, 33 partially effective, 15 ineffective, 437 not tested; coverage 16 % (77 observed of 485).

Effectiveness moves since that snapshot: to partially effective — `sebi-cscrf-2024` PR.AA.S2, PR.IP.S1, PR.IP.S2,
PR.DS.S2, ID.AM.S2, ID.AM.S3, GV.PO.S1, PR.AA.S8, EV.ST.S1 and PR.IP.S15 (all from not-tested), ID.AM.S1, PR.DS.S1,
PR.AA.S13 and PR.DS.S4 (all from ineffective), `dpdp-rules-2025` 6(1), 6(1)(a), 8(3), 13(3) and 15,
`rbi-cyber-tech-directions-2026` 30, 31, 36, 49, 140 and the new 83 and 88, and `cert-in-directions-2022` Dir-iv (from
ineffective). To ineffective — `sebi-cscrf-2024` PR.AA.S3, PR.AA.S9, RC.RP.S1 and the new PR.DS.S6,
`dpdp-rules-2025` 6(1)(e), `rbi-cyber-tech-directions-2026` 171 and `rbi-outsourcing-risk-directions-2025` 97(xi) (all
from not-tested). `probe-iac` had assessed `sebi-cscrf-2024` PR.AA.S1 and PR.AA.S3 `effective` at 2026-09-14T11:33:17Z;
`probe-schemas` and `probe-agent-graph` re-assessed them `partially-effective` and `ineffective` respectively, so no
control is effective as of this write.

This run (`execute-scr`, runId `run_01M2GDZ3Q3S5WYCB3MV02QJXZ1`, `recordedAt` 2026-09-15T19:42:44Z) appended 90 ledger
lines: 73 observations, 16 findings and 1 control record — the new `sebi-cscrf-2024:PR.DS.S5` (unknown, `not-tested`,
first assessed by [obs_01M2KMNHPJB1NRPWQTYPREHRZ8]). The batch re-assessed no existing control, so the distribution above
changes only by that +1 not-tested id. The 73 observations break down 23 `not-satisfied`, 24 `partial`, 10 `satisfied`,
12 `not-applicable` and 4 `inconclusive` — the db-models dependency-CVE status (no scanner executor configured,
`sdlc/executor.json` absent) [obs_01M2KC7W3PDEXXXW7QC7BHMZE4], the absent root-cause-analysis process
[obs_01M2KFQ6B4A4R3KCJB4QYH58FR], the unbuildable repo's missing build provenance [obs_01M2KGVJJ21P79839X4NKNPAC1] and the
uncaptured `branchProtection` of master [obs_01M2KGVJJ2NB6FNRWWPSJF326D]; the first three's controls carry later
conclusive observations in this same batch, the last leaves its control inconclusive (below).

Maxwell observed 77 of the 485 applicable controls in this period (16 %); 2 controls are inconclusive for lack of access:
`sebi-cscrf-2024:PR.IP.S3` change-management enforcement settings, unverifiable offline until `refresh-ctx` captures
`branchProtection` [obs_01M2KGVJJ2NB6FNRWWPSJF326D], and `rbi-cyber-tech-directions-2026:95` audit-trail retention, whose
eks-prod-mumbai / eks-nonprod-mumbai log-shipping configuration has been requested since 2026-09-14T11:10:49Z
[obs_01M2FTV6MCKCJTVHDHHP02KJ2V]; 0 environments were skipped (no runtime probe ran and the ledger records no freeze,
window or credential skip). Coverage basis: applicable control ids named in the `controlIds` of at least one of the 217
ledger observations (this run's 73 and 144 earlier, of which 11 are report-generation), over the 485 applicable controls;
this mirrors `cm_coverage` (kpis/measurement/cm_coverage.md), except that the KPI's `excludedWorkflows`
(kpis/metrics.json) drops `refresh-*` observations, which would give 70 of 485 (14 %).

<!-- source: latest-state map over soc/main.jsonl kind=control (993 lines, last record per id, both JSON field orderings checked because some records put "id" after "companyId"), grouped by instrument id prefix before ':'; new ids since the 2026-09-14T18:35:14Z refresh-soc snapshot = sebi PR.DS.S6 (line 743, probe-iac), cert-in Dir-v (786) + Dir-vi (787) + rbi-cyber 48 (788, probe-schemas), rbi-cyber 83 (854) + 88 (855, probe-agent-graph), sebi PR.DS.S5 (984, execute-scr); post-baseline control records = lines 743, 770-785 (probe-iac 2026-09-15T00:05:59Z), 786-788, 831-853 (probe-schemas 2026-09-15T02:47:35Z), 854-855, 885-903 (probe-agent-graph 2026-09-15T15:14:31Z), 984 (execute-scr); baseline values per id from the last 2026-09-14 record (refresh-soc 09:55 lines 11-365, probe-iac-1 11:33 lines 388-441, refresh-soc 18:35 lines 697-710, migration 14:41 line 609); effectiveness counts exclude implementationStatus not-applicable; coverage = applicable control ids in controlIds of the 217 kind=observation records (585 of 993 lines verified record by record: this run 904-991, probe-iac-2 744-761, probe-schemas-2 789-824, probe-agent-graph 856-874, metastore-2 723-733, refresh-apps 735-741, vendor 368-386, iac-1 390-399, schemas-1 410-422, reports 4/367/377/387/688/695-696/711-712/722/734/742/2) -->

## Open findings
`execute-scr` ran against `example-co` this run (`provenance.runId` run_01M2GDZ3Q3S5WYCB3MV02QJXZ1; this run's 90 ledger
lines were appended by the `soc-ledger-keeper` at 2026-09-15T19:42:44Z): 16 new finding(s) — 3 secure-code-review
([fnd_01M2KBJW4AHE221KPTRV1G60YC], [fnd_01M2KBJW4A8E9GMQHZT9F9WTAG], [fnd_01M2KC7W3QM0V86PVA3SVA01FN]), 6 SDLC policy
gaps ([fnd_01M2KFQ6B40J52A6C0Q1XFPM10], [fnd_01M2KFQ6B4EF1Z113T0NKDY04Q], [fnd_01M2KFQ6B4KPYSFR0AR8SV4G4K],
[fnd_01M2KFQ6B43WV47NMR95AXZBT0], [fnd_01M2KGVJJ2AXNAXRE08PZ2Z7YP], [fnd_01M2KGVJJ2Y4M9DRQY90C7TAMS]) and 7
developer-environment gaps ([fnd_01M2KM42DZQK8J4EZEB68ZQ103], [fnd_01M2KM42DZDZSFHCN7YYBM94V2],
[fnd_01M2KM42DZ98VAGYD0E8TRV3FQ], [fnd_01M2KM42DZE09A2PZ557A7SX2F], [fnd_01M2KM42DZ66HX2ZKMY2QQ5JJC],
[fnd_01M2KMNHPJ7Z0Y0YJT6YZR4NZM], [fnd_01M2KMNHPKKK5K3C1EYGED2KGG]) — 0 re-seen (0 superseded) and 73 observation(s) —
23 `not-satisfied`, 24 `partial`, 10 `satisfied`, 12 `not-applicable`, 4 `inconclusive` — against repo
`mcp-gateway/mongodb-mcp-server` at pinned commit aaa72a040db4c32f3d6488d5e28e2892a68e9ee0, repo
`db-models/onfinance-db-model-master` at pinned commit 70b3633e171a1b8d389b27bb901c84c34a0e9bf6, the company SDLC policy
and the mcp-gateway dev environment (evidence:
`kpis/data/raw/sessions/opencode/ses_f5966a873ffeW6ABw4BrDNZjnn.execute-scr.mcp-gateway.mongodb-mcp-server.sarif.export.json`,
sha256 1c38ee55…, and
`kpis/data/raw/sessions/opencode/453ecc6e-1346-418f-a2c0-1bfcead851c3.execute-scr.db-models.onfinance-db-model-master.sarif.export.json`).
The batch created 1 new control record (`sebi-cscrf-2024:PR.DS.S5`, `not-tested`) and re-assessed no existing control.

The three secure-code-review findings land on the gateway and the data-model library behind the `order-routing` critical
function. Two break human oversight and data protection on the deployed gateway: the elicitation confirmation gate fails
open for clients without elicitation support, so destructive tools execute against the pii/financial stores with no human
approval while `aiCodingPolicy.humanReviewRequired` is true [fnd_01M2KBJW4AHE221KPTRV1G60YC] (SEBI sebi-cscrf-2024
PR.AA.S3), and default-on telemetry ships the machine identifier and usage metadata to the MongoDB cloud with no consent
notice [fnd_01M2KBJW4A8E9GMQHZT9F9WTAG] (MeitY dpdp-rules-2025 3). One is an at-rest failure in the data-model library:
Zerodha broker credentials, the TOTP 2FA seed, API secrets and access tokens are modelled as plain StringField in the
secrets collection the metastore classifies restricted and spdi [fnd_01M2KC7W3QM0V86PVA3SVA01FN] (SEBI sebi-cscrf-2024
PR.DS.S1), the same root cause covering `user.user_password` and `user.user_binance_auth_creds`. The SDLC gaps are
company-level policy failures (no security requirements, no SBOM despite `sbomRequired: false` against GV.SC.S5, no
audit remediation loop, no security owner) plus two db-models repo gaps (the blocking vitest gate never runs because the
repo has no CI, and no PR security checklist). The seven developer-environment gaps all live on the developer-laptop
fleet that builds the order-routing gateway, including an unauthenticated integration-test mongod published on all
interfaces, the repo's own dev logs kept 30 days against the CERT-In 180-day baseline, and gh-aw agent configuration
with bash auto-approved. The SCR review also confirmed the unauthenticated `/mcp` route on the shipped AWS image, but
that condition is already carried by [fnd_01M2G2AGVRZPBP3VH8FNAYH46V] and [fnd_01M2HCWMBDDT80V2CWJ5Z7BH17], so no
duplicate was appended; likewise the dev-env finding [fnd_01M2KM42DZ66HX2ZKMY2QQ5JJC] normalises the AGENT-POL-01 gap
([fnd_01M2K7B0MJ3239WAE0AKHRMK5E], probe-agent-graph) under the fixed devenv rule id, and both ids stay open because
this run superseded nothing (the keeper wrote no supersession for either).

Latest record per finding id in `company-profile/example-co/soc/main.jsonl` with `status` in
`open | triaged | remediating`, as of `provenance.generatedAt` 2026-09-15T19:42:44Z (50 open, 0 past SLA):

### High

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FS4806WHXANC3Q9QXEAXGF] | assurance-expiring: github-cloud SOC 2 Type II report expires 2026-09-30, inside 90-day window | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S4 (SEBI CSCRF 2024) | 2026-09-14 | 2026-10-14T10:46:39Z | due in 29 d | open | n/a |
| [fnd_01M2FS9ECP3E0MTCRQFEJ97930] | contract-expiring: ATLAS-2025-1189 ended 2026-05-31, 106 days before NOW, no renewal evidence | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S4 | 2026-09-14 | 2026-10-14T10:46:39Z | due in 29 d | open | n/a |
| [fnd_01M2G2AGPX8KWSY1KXGYADK4TK] | find tool returns full unmasked documents from pii/financial collections | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 6 d | open | n/a |
| [fnd_01M2G2AGR581507FMK0EADFKY6] | aggregate tool returns full unmasked pipeline results | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 6 d | open | n/a |
| [fnd_01M2G2AGSC977KASP37WQXYSQA] | export tool writes full unmasked documents to an unencrypted local file | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 6 d | open | n/a |
| [fnd_01M2G2AGVRZPBP3VH8FNAYH46V] | MCP HTTP transport endpoint ships with no authentication, rate limiting or idempotency controls by default | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 6 d | open | n/a |
| [fnd_01M2G2AGTH64FMR4XR77ZAJH7B] | atlas-create-db-user takes a plaintext password argument and echoes the generated password back in the tool response | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S6 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 6 d | open | n/a |
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
| [fnd_01M2KBJW4AHE221KPTRV1G60YC] | mcp-gateway/mongodb-mcp-server: Human-confirmation gate for destructive MCP tools fails open for clients without elicitation support | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |
| [fnd_01M2KC7W3QM0V86PVA3SVA01FN] | db-models/onfinance-db-model-master: Cleartext broker credentials modelled in the secrets MongoDB collection | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.DS.S1 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |
| [fnd_01M2KFQ6B4EF1Z113T0NKDY04Q] | SBOM disclaimed by policy and absent on file while SEBI CSCRF requires one for critical software | company | SEBI sebi-cscrf-2024 GV.SC.S5 | 2026-09-15 | 2026-10-15T19:42:44Z | due in 30 d | open | n/a |
| [fnd_01M2KFQ6B4KPYSFR0AR8SV4G4K] | SDLC policy has no audit remediation loop: no post-major-change audit and no tracked closure of audit findings | company | SEBI sebi-cscrf-2024 Sec-4.4 | 2026-09-15 | 2026-12-14T19:42:44Z | due in 90 d | open | n/a |
| [fnd_01M2KM42DZQK8J4EZEB68ZQ103] | Integration-test mongod published unauthenticated on all interfaces of developer laptops | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S1 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |
| [fnd_01M2KM42DZDZSFHCN7YYBM94V2] | Dev environment retains logs only 30 days against the CERT-In 180-day baseline | environment `mcp-gateway/dev` | CERT-In cert-in-directions-2022 Dir-iv (CERT-In Directions 2022) | 2026-09-15 | 2026-10-15T19:42:44Z | due in 30 d | open | n/a |
| [fnd_01M2KM42DZ98VAGYD0E8TRV3FQ] | Agentic-workflows agent file tells developers AI agents run full bash and edit by default and should not be restricted | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |
| [fnd_01M2KM42DZE09A2PZ557A7SX2F] | .gitignore ignores only the exact name .env, leaving .env* variants and key files trackable in a public repo | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |
| [fnd_01M2KM42DZ66HX2ZKMY2QQ5JJC] | Repo ships GitHub Copilot and gh-aw harness configuration outside aiCodingPolicy.harnessesAllowed | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.PO.S1 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |
| [fnd_01M2KMNHPKKK5K3C1EYGED2KGG] | db-models/onfinance-db-model-master: no lockfile for the setup.py manifest although the SDLC policy requires lockfiles | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.DS.S6 | 2026-09-15 | 2026-09-22T19:42:44Z | due in 7 d | open | n/a |

### Medium

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] | material-without-evidence: aws-mumbai (order-routing, pii/financial) has no documented exit plan | vendor `aws` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2FS481DGTPTR9NJGKAAMF49] | contract-expiring: GH-ENT-2025-07 ended 2026-06-30, 76 days before now, no renewal evidence | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] | material-without-evidence: github lacks audit rights and a documented exit plan | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2FS9EBVSP2DPWN5K2D91QKW] | material-without-evidence: atlas-mumbai has no audit right and no documented exit plan | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 89 d | open | n/a |
| [fnd_01M2G2AGNMHKF9PCB4C85A3JQ3] | MongoDB MCP tool schemas carry no personal-data classification markers | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 13 d | open | n/a |
| [fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] | zod tool-argument schemas leave database-bound input unbounded and unvalidated | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 13 d | open | n/a |
| [fnd_01M2K7B0MJTNGRN4D0GZYBD5FS] | Setup wizard writes npx -y mongodb-mcp-server@latest into six harness MCP configs | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.SC.S2 | 2026-09-15 | 2026-09-29T15:14:31Z | due in 14 d | open | n/a |
| [fnd_01M2K7B0MJMG3TT4DFMEJWQDA8] | search-knowledge sends the unredacted model query to knowledge.mongodb.com by default | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S2 | 2026-09-15 | 2026-09-29T15:14:31Z | due in 14 d | open | n/a |
| [fnd_01M2KBJW4A8E9GMQHZT9F9WTAG] | mcp-gateway/mongodb-mcp-server: Telemetry enabled by default sends machine and usage identifiers to the MongoDB cloud with no consent gate | repo `mcp-gateway/mongodb-mcp-server` | MeitY dpdp-rules-2025 3 (DPDP Rules 2025) | 2026-09-15 | 2026-09-29T19:42:44Z | due in 14 d | open | n/a |
| [fnd_01M2KFQ6B40J52A6C0Q1XFPM10] | SDLC policy defines no security requirements: no secure coding standard, threat modelling or SECURITY.md anywhere | company | SEBI sebi-cscrf-2024 PR.IP.S2 (SEBI CSCRF 2024) | 2026-09-15 | 2026-12-14T19:42:44Z | due in 90 d | open | n/a |
| [fnd_01M2KFQ6B43WV47NMR95AXZBT0] | No security owner, approver role or owning team named for security-sensitive code paths | company | SEBI sebi-cscrf-2024 GV.RR.S2 | 2026-09-15 | 2026-12-14T19:42:44Z | due in 90 d | open | n/a |
| [fnd_01M2KGVJJ2AXNAXRE08PZ2Z7YP] | db-models/onfinance-db-model-master: blocking unit-tests gate never runs - no CI, no tests, and the policy names JS runner vitest for a Python repo | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.IP.S6 | 2026-09-15 | 2026-12-14T19:42:44Z | due in 90 d | open | n/a |
| [fnd_01M2KGVJJ2Y4M9DRQY90C7TAMS] | db-models/onfinance-db-model-master: no PR security or data-impact checklist for the repo defining the pii, spdi and financial storage schema | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-15 | 2026-12-14T19:42:44Z | due in 90 d | open | n/a |
| [fnd_01M2KMNHPJ7Z0Y0YJT6YZR4NZM] | db-models/onfinance-db-model-master: no local secrets-scanning hook and no CI, so the policy CI secret scan never reaches this repo | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-15 | 2026-09-29T19:42:44Z | due in 14 d | open | n/a |

<!-- source: latest-state map over soc/main.jsonl kind=finding (993 lines, 65 finding records across 50 ids), last line per id, filtered to status in open|triaged|remediating; execute-scr batch = lines 904-993 recordedAt 2026-09-15T19:42:44Z (73 observations 904-917/920-926/928-946/951-969/972-978/985-991, 16 findings 918-919/927/947-950/970-971/979-983/992-993, 1 control 984); severity counts 36 high + 14 medium = 50 open, 0 past SLA. The 16 new rows were verified field-by-field against the ledger: status open (grep "status":"open" over the 16 ids: 20 matches incl. commit_15.diff), firstSeenAt 2026-09-15T19:42:44Z (20 matches), severity via grep "severity":"high" over the 16 ids (8 of 10 non-SDLC rows matched: fnd_01M2KBJW4AHE221KPTRV1G60YC, fnd_01M2KC7W3QM0V86PVA3SVA01FN, fnd_01M2KM42DZQK8J4EZEB68ZQ103, fnd_01M2KM42DZDZSFHCN7YYBM94V2, fnd_01M2KM42DZ98VAGYD0E8TRV3FQ, fnd_01M2KM42DZE09A2PZ557A7SX2F, fnd_01M2KM42DZ66HX2ZKMY2QQ5JJC, fnd_01M2KMNHPKKK5K3C1EYGED2KGG; plus the 2 high SDLC rows read in full) and the SARIF result properties (sha256 1c38ee55…; medium = fnd_01M2KBJW4A8E9GMQHZT9F9WTAG dpdp-rules-2025:3 and fnd_01M2KMNHPJ7Z0Y0YJT6YZR4NZM sebi-cscrf-2024:PR.IP.S2, plus the 4 medium SDLC rows read in full: fnd_01M2KFQ6B40J52A6C0Q1XFPM10, fnd_01M2KFQ6B43WV47NMR95AXZBT0, fnd_01M2KGVJJ2AXNAXRE08PZ2Z7YP, fnd_01M2KGVJJ2Y4M9DRQY90C7TAMS); slaDueAt verified by grep over the 16 ids: 2026-09-22T19:42:44Z (7 d, sebi-cscrf-2024 PR.MA.S3 patch-sla high) for fnd_01M2KBJW4AHE221KPTRV1G60YC, fnd_01M2KC7W3QM0V86PVA3SVA01FN, fnd_01M2KM42DZQK8J4EZEB68ZQ103, fnd_01M2KM42DZ98VAGYD0E8TRV3FQ, fnd_01M2KM42DZE09A2PZ557A7SX2F, fnd_01M2KM42DZ66HX2ZKMY2QQ5JJC, fnd_01M2KMNHPKKK5K3C1EYGED2KGG; 2026-09-29T19:42:44Z (14 d, patch-sla medium) for fnd_01M2KBJW4A8E9GMQHZT9F9WTAG and fnd_01M2KMNHPJ7Z0Y0YJT6YZR4NZM; 2026-10-15T19:42:44Z (30 d) for fnd_01M2KM42DZDZSFHCN7YYBM94V2 and fnd_01M2KFQ6B4EF1Z113T0NKDY04Q; 2026-12-14T19:42:44Z (90 d) for fnd_01M2KFQ6B4KPYSFR0AR8SV4G4K, fnd_01M2KFQ6B40J52A6C0Q1XFPM10, fnd_01M2KFQ6B43WV47NMR95AXZBT0, fnd_01M2KGVJJ2AXNAXRE08PZ2Z7YP, fnd_01M2KGVJJ2Y4M9DRQY90C7TAMS (the last five read in full at lines 947-950, 970-971); targets verified by grep over the 16 ids (repo mcp-gateway/mongodb-mcp-server x6, repo db-models/onfinance-db-model-master x3) plus company x4 and environment mcp-gateway/dev x1 read in full; regulatoryRefs[0] as tabulated, from the records read in full (SDLC rows) or the SARIF result properties and each record's severity derivation (SCR and dev-env rows). The 34 pre-existing rows are unchanged: no line in 904-993 carries a pre-existing finding id (grep "supersedes":"fnd_ found no match in lines 904-993; this run re-seen 0 findings), so their latest records and the previous section's verified values stand (vendor rows lines 714-721, probe-iac rows 762-769, probe-schemas rows 825-830, first-run schema rows 423-429); their SLA status was recomputed against the new generatedAt: the 5 rows due 2026-09-21T13:14:50Z move 5 d -> 6 d and the 2 rows due 2026-09-28T13:14:50Z move 12 d -> 13 d, all other rows unchanged. Observation result counts 23 not-satisfied + 24 partial + 10 satisfied + 12 not-applicable + 4 inconclusive = 73 (inconclusive: obs_01M2KC7W3PDEXXXW7QC7BHMZE4, obs_01M2KFQ6B4A4R3KCJB4QYH58FR, obs_01M2KGVJJ21P79839X4NKNPAC1, obs_01M2KGVJJ2NB6FNRWWPSJF326D; the results of the 5 dev-env observations not fully visible in place were verified by grep: obs_01M2KM42DTR4YX8F7F0GDPB7QP, obs_01M2KM42DYFQ90GTVVXE6WSMFR, obs_01M2KM42DYNG2Z6PQVZ5CDJVP6 and obs_01M2KMNHPEX22EG5NSKATCAKN6 not-satisfied, obs_01M2KMNHPJB1NRPWQTYPREHRZ8 satisfied). SLA status = ceil((slaDueAt - 2026-09-15T19:42:44Z)/86400000) d; 0 rows past SLA -->

No findings in `risk-accepted`, `false-positive` or `duplicate` this period.

## Initiatives
`impl-change-management` (runId `run_01M2GDZ3Q3S5WYCB3MV02QJXZ1`) created all 10 open initiatives this run
(`createdAt` 2026-09-15T23:48:58Z; every status `proposed`, every `changeType` `normal`), linking 24 open ledger
findings. Counters from `company-profile/example-co/change_management/master.json` (`updatedAt`
2026-09-15T23:48:58Z): **10 open / 0 closed / 0 cancelled / 0 overdue** as of 2026-09-15T23:48:58Z. Overdue
compares each initiative `dueAt` with `provenance.generatedAt`: the earliest `dueAt` is 2026-09-22T23:48:58Z,
7 days out, so no row below carries an `**overdue <n> d**` marker. The 33 tasks across the 10 initiatives are
all `todo` (0 done, 0 blocked).

| Id | Title | Status | Priority | Change type | Owner | Due | Tasks (done/total, blocked) | Findings | Regulatory ref |
|---|---|---|---|---|---|---|---|---|---|
| [init_01M2KS6TE1ME2P52YKY64T06JY] | Close vendor governance gaps for AWS, GitHub and MongoDB Atlas: renew lapsed contracts, restore audit rights and assurance, document exit plans | proposed | p2 | normal | compliance@example-co.invalid | 2026-10-15T23:48:58Z | 0/4, 0 blocked | 6 | SEBI sebi-cscrf-2024 GV.SC.S3 (SEBI CSCRF 2024) + 5 refs |
| [init_01M2KS0W59831JMAK8AVMGVZAN] | Mask, encrypt and allow-list sensitive data paths in MongoDB MCP tools and db models | proposed | p2 | normal | cto@example-co.invalid | 2026-09-22T23:48:58Z | 0/4, 0 blocked | 6 | SEBI sebi-cscrf-2024 PR.DS.S4 + 9 refs |
| [init_01M2KRVFNGEJFKP3NR1V9M2PM5] | Make destructive-tool confirmation gates fail closed and enforce least-privilege write defaults | proposed | p2 | normal | cto@example-co.invalid | 2026-09-22T23:48:58Z | 0/4, 0 blocked | 3 | SEBI sebi-cscrf-2024 PR.AA.S3 + 5 refs |
| [init_01M2KS1SY6B35R6CQ750H22FRW] | Bound and validate database-bound MCP tool input schemas in mongodb-mcp-server | proposed | p3 | normal | cto@example-co.invalid | 2026-09-29T23:48:58Z | 0/4, 0 blocked | 1 | SEBI sebi-cscrf-2024 PR.IP.S2 + 3 refs |
| [init_01M2KRZA4RAAZS0KDBFDKRVRXR] | Enable diagnostics, SIEM forwarding and 180-day log retention for mcp-gateway | proposed | p2 | normal | cto@example-co.invalid | 2026-09-22T23:48:58Z | 0/3, 0 blocked | 2 | SEBI sebi-cscrf-2024 PR.AA.S8 + 4 refs |
| [init_01M2KRS2JRQP1SV3DSBSDASETA] | Remove repo-shipped Copilot and gh-aw harness configuration from mongodb-mcp-server | proposed | p2 | normal | cto@example-co.invalid | 2026-09-22T23:48:58Z | 0/3, 0 blocked | 2 | SEBI sebi-cscrf-2024 GV.PO.S1 + 3 refs |
| [init_01M2KS3JBZ99R9Y0888DF7WSWP] | Broaden .gitignore secret patterns in the public mongodb-mcp-server repo | proposed | p2 | normal | cto@example-co.invalid | 2026-09-22T23:48:58Z | 0/2, 0 blocked | 1 | SEBI sebi-cscrf-2024 PR.DS.S4 + 1 ref |
| [init_01M2KSB50TKCHJMD8PT79GXGTM] | Add source pinning and checksum verification to the global third-party agent-skills install | proposed | p2 | normal | cto@example-co.invalid | 2026-09-22T23:48:58Z | 0/3, 0 blocked | 1 | SEBI sebi-cscrf-2024 PR.IP.S1 + 2 refs |
| [init_01M2KSEQN8DMX4CRTN5RP1XND8] | Annotate the MongoDB MCP tool schemas with personal-data classification markers | proposed | p3 | normal | ciso@example-co.invalid | 2026-09-29T23:48:58Z | 0/3, 0 blocked | 1 | SEBI sebi-cscrf-2024 ID.AM.S5 + 2 refs |
| [init_01M2KSV05T8TK1TJDJAS2EK3DW] | Add a local gitleaks pre-commit secrets-scanning hook to the db-models repo so the policy secret scan reaches it | proposed | p3 | normal | ciso@example-co.invalid | 2026-09-29T23:48:58Z | 0/3, 0 blocked | 1 | SEBI sebi-cscrf-2024 PR.IP.S2 + 1 ref |

### Blocked

No blocked tasks as of 2026-09-15T23:48:58Z: all 33 tasks carry `status: todo` and no task file has a
`blockedReason` (Grep `"blockedReason"` over `change_management/initiatives/*/tasks/task_*.json` returns 0
matches); `taskCounts.blocked` is 0 in all 10 `master.json` entries.

### Evidence requests

10 of the 33 tasks verify by `verificationMethod.type: re-probe` and none is done yet; each names the probe
workflow that must re-run to supply the closing evidence for its linked finding(s):

- [init_01M2KS0W59831JMAK8AVMGVZAN] task_1 — Mask pii and financial fields in find and aggregate tool results
  (re-probe `probe-schemas`, owner cto@example-co.invalid, due 2026-09-21T23:48:58Z).
- [init_01M2KS0W59831JMAK8AVMGVZAN] task_2 — Encrypt MongoDB MCP export files at rest and mask exported fields
  (re-probe `probe-schemas`, owner cto@example-co.invalid, due 2026-09-22T23:48:58Z).
- [init_01M2KS0W59831JMAK8AVMGVZAN] task_3 — Enforce a host allow-list on MongoDB MCP connection strings
  (re-probe `probe-agent-graph`, owner cto@example-co.invalid, due 2026-09-21T23:48:58Z).
- [init_01M2KRVFNGEJFKP3NR1V9M2PM5] task_2 — Default the gateway to least privilege behind an explicit
  write-tool allow-list (re-probe `probe-agent-graph`, owner cto@example-co.invalid, due 2026-09-19T15:14:31Z).
- [init_01M2KS1SY6B35R6CQ750H22FRW] task_4 — Add regression tests for tool-argument bounds and verify with
  probe-schemas (re-probe `probe-schemas`, owner cto@example-co.invalid, due 2026-09-28T13:14:50Z).
- [init_01M2KRZA4RAAZS0KDBFDKRVRXR] task_1 — Enable diagnostic settings and a Log Analytics workspace in the
  mongodb-mcp-server bicep deployment (re-probe `probe-iac`, owner cto@example-co.invalid, due
  2026-09-19T23:48:58Z).
- [init_01M2KRS2JRQP1SV3DSBSDASETA] task_2 — Delete the repo-shipped GitHub Copilot and gh-aw harness
  configuration (re-probe `probe-agent-graph`, owner cto@example-co.invalid, due 2026-09-21T23:48:58Z).
- [init_01M2KSB50TKCHJMD8PT79GXGTM] task_1 — Pin the agent-skills source to a commit and gate the global skills
  install on verified checksums (re-probe `probe-agent-graph`, owner cto@example-co.invalid, due
  2026-09-21T23:48:58Z).
- [init_01M2KSEQN8DMX4CRTN5RP1XND8] task_2 — Annotate the MongoDB tool schemas with data-classification
  markers (re-probe `probe-schemas`, owner cto@example-co.invalid, due 2026-09-26T23:48:58Z).
- [init_01M2KSV05T8TK1TJDJAS2EK3DW] task_3 — Verify the db-models secrets-scanning control with probe-sdlc and
  reconcile the finding (re-probe `probe-sdlc`, owner ciso@example-co.invalid, due 2026-09-28T23:48:58Z).

<!-- source: counters and per-initiative fields from change_management/master.json (counters open 10, closed 0, cancelled 0, overdue 0, updatedAt 2026-09-15T23:48:58Z; status/priority/changeType/owner.id/dueAt/taskCounts/findingIds/regulatoryRefs per initiative; Findings column = len(findingIds) = 6, 6, 3, 1, 2, 2, 1, 1, 1, 1 = 24 distinct finding ids); tasks = 33 files under change_management/initiatives/*/tasks/ (Grep '"status": "todo"' = 33 matches, "blockedReason" = 0 matches, '"type": "re-probe"' = 10 matches with verificationMethod.workflow as listed); overdue = dueAt earlier than provenance.generatedAt 2026-09-15T23:48:58Z (0 initiatives, earliest dueAt 2026-09-22T23:48:58Z); timelines initiatives/*/timeline.json record only created/task-added events at 2026-09-15T23:48:58Z, so no initiative has moved past proposed; inputsHash order per company-summary.schema.json -->

## Suggestions

`impl-auto-improvement` (runId `run_01M2GDZ3Q3S5WYCB3MV02QJXZ1`) early-refreshed this section as of
2026-09-16T02:18:09Z; `report-audit-improvements` remains the owner of record.
`company-profile/example-co/suggestions/master.json` (`updatedAt` 2026-09-16T02:18:09Z) holds **5 suggestions,
all status `proposed`** (3 `iac-fix`, 1 `agent-guardrail`, 1 `cicd-gate`; 4 high, 1 medium), every one created this
run (`createdAt` 2026-09-16T02:18:09Z, `sourceWorkflow` `impl-auto-improvement`); 0 merged, 0 reverted and 0
retention checks recorded. Every entry is listed so reviewers see the open queue; none has reached `surfaced` yet,
so no `surfacedAt`, `decidedAt` or `decidedBy` exists and every `prUrls` is empty.

| Id | Title | Category | Severity | Status | Repo | +/- lines | Surfaced | Decided by | PR |
|---|---|---|---|---|---|---|---|---|---|
| [sug_01M2M19HQY6B6W6MRZW7HA1XA2] | Require platform auth for public ingress in the MCP gateway bicep template | iac-fix | high | proposed | `mcp-gateway/mongodb-mcp-server` | +4/-2 | n/a | n/a | none |
| [sug_01M2M0T59E8XRGTF3HC7N9RVT0] | Require Microsoft Entra ID auth and read-only mode in the Azure Bicep baseline parameters | iac-fix | high | proposed | `mcp-gateway/mongodb-mcp-server` | +5/-2 | n/a | n/a | none |
| [sug_01M2M1YDYTKJXNGMZTZEJNB4WR] | Bind integration-test mongod published port to loopback only | iac-fix | high | proposed | `mcp-gateway/mongodb-mcp-server` | +3/-2 | n/a | n/a | none |
| [sug_01M2M1XNDXVS780KHSVW7GZSHN] | Require tool allowlists and human review instead of default bash in agentic-workflows agent instructions | agent-guardrail | high | proposed | `mcp-gateway/mongodb-mcp-server` | +2/-2 | n/a | n/a | none |
| [sug_01M2M1Z5K82GX6E3YYZN2ZQVAW] | Add a pinned gitleaks pre-commit hook to scan every commit for secrets | cicd-gate | medium | proposed | `db-models/onfinance-db-model-master` | +10/-0 | n/a | n/a | none |

Each suggestion answers one open ledger finding (titles quoted from the latest record per id, recorded
2026-09-16T02:18:09Z); primary regulatory ref per the suggestion's `regulatoryRefs[0]` in master.json:

- [sug_01M2M19HQY6B6W6MRZW7HA1XA2] answers [fnd_01M2HCWMBDDT80V2CWJ5Z7BH17] "MCP gateway deploys unauthenticated on
  a public endpoint by default (qa/prod IaC root)" — SEBI sebi-cscrf-2024 PR.AA.S17 (SEBI CSCRF 2024), PR.AA.S2;
  MeitY dpdp-rules-2025 6(1)(b) (DPDP Rules 2025).
- [sug_01M2M0T59E8XRGTF3HC7N9RVT0] answers [fnd_01M2HCWMBDGA1D4Z54RET9CNC9] "Baseline deployment parameters ship
  the gateway with no auth and write mode enabled" — SEBI sebi-cscrf-2024 PR.AA.S17, PR.AA.S2; MeitY
  dpdp-rules-2025 6(1)(b).
- [sug_01M2M1YDYTKJXNGMZTZEJNB4WR] answers [fnd_01M2KM42DZQK8J4EZEB68ZQ103] "Integration-test mongod published
  unauthenticated on all interfaces of developer laptops" — SEBI sebi-cscrf-2024 PR.IP.S1, PR.AA.S2.
- [sug_01M2M1XNDXVS780KHSVW7GZSHN] answers [fnd_01M2KM42DZ98VAGYD0E8TRV3FQ] "Agentic-workflows agent file tells
  developers AI agents run full bash and edit by default and should not be restricted" — SEBI sebi-cscrf-2024
  PR.AA.S3.
- [sug_01M2M1Z5K82GX6E3YYZN2ZQVAW] answers [fnd_01M2KMNHPJ7Z0Y0YJT6YZR4NZM] "db-models/onfinance-db-model-master:
  no local secrets-scanning hook and no CI, so the policy CI secret scan never reaches this repo" — SEBI
  sebi-cscrf-2024 PR.IP.S2; it is the local-hook variant of [init_01M2KSV05T8TK1TJDJAS2EK3DW] (`initiativeId` in
  master.json).

Acceptance figures for the period to 2026-09-16T02:18:09Z, computed exactly like
[suggestion_acceptance_rate v1.0.0](../../kpis/measurement/suggestion_acceptance_rate.md):

- acceptance_rate = |accepted ∪ merged ∪ reverted| / |accepted ∪ merged ∪ reverted ∪ rejected ∪ expired| = 0/0 —
  not computable; no suggestion has been decided (0 accepted, 0 merged, 0 reverted, 0 rejected, 0 expired).
- merge_rate = |merged ∪ reverted| / |accepted ∪ merged ∪ reverted| = 0/0 — not computable; nothing accepted.
- revert_rate = |reverted within 30 days of mergedAt| / |merged ∪ reverted| = 0/0 — not computable; nothing merged.
- retention_30d = |merged with retentionCheckedAt ≥ mergedAt+30d and retained = true| / |merged checked| = 0/0 —
  not computable; 0 merged suggestions checked, no `retentionCheckedAt` recorded this run.

### Rejections

No rejections as of 2026-09-16T02:18:09Z: no entry in `suggestions/master.json` has status `rejected`, so there is
no `decisionNote` to quote.

<!-- source: suggestions/master.json (5 entries in suggestions[], all "status":"proposed", all "createdAt":"2026-09-16T02:18:09Z", all "prUrls":[]; categories iac-fix 3 + agent-guardrail 1 + cicd-gate 1; severity high 4, medium 1; +/- lines = repos[0].linesAdded/repos[0].linesRemoved; 0 merged, 0 reverted, 0 retention checks = no entry carries mergedAt/revertedAt/retentionCheckedAt/decidedBy/decisionNote); finding titles from soc/main.jsonl latest kind:finding record per id (lines 1045-1049, recordedAt 2026-09-16T02:18:09Z); regulatory refs from each suggestion's regulatoryRefs in master.json; acceptance/merge/revert/retention formulae from kpis/measurement/suggestion_acceptance_rate.md applied to the same 5 entries -->

