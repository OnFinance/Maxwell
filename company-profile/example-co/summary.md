---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "4.7.0"
sections: [overview, regulatory-posture, data-flows, vendors, control-summary, open-findings]
provenance:
  harness: claude-code
  generatedAt: "2026-09-14T19:14:04Z"
  sessionId: "25584b4f-cb91-4da7-9198-1c6516a03390"
  runId: "run_01M2FGNVVQ15ZKXZWGW74YWAAQ"
  workflow: probe-agent-graph
  agent: report-writer
  inputsHash: "a9176feb3bf92aecd34e625e83596381eafd078959be42a9a881e22506be6637"
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

Frameworks in scope: `sebi-cscrf-2024`, `rbi-cyber-tech-directions-2026`, `rbi-outsourcing-risk-directions-2025`,
`cert-in-directions-2022`, `dpdp-rules-2025`, `iso-27001-2022`.

**Repealed instrument migrated (2026-09-14T14:41:43Z).** RBI repealed `rbi-it-outsourcing-md-2023` on 2025-11-28
(circular DOR.RRC.REC.302/33-01-010/2025-26) and replaced it with the entity-wise Managing Risks in Outsourcing
Directions, 2025 (for NBFCs RBI/DOR/2025-26/363), registered as `rbi-outsourcing-risk-directions-2025`.
`soc/migrate-instrument.mjs` swapped it in `frameworksInScope`, superseded the 64 `rbi-it-outsourcing-md-2023`
control records as `not-applicable` (each names its successor controls; paragraph 16, the minimum clause set for
agreements, has no mapped successor), appended the 176 successor controls that apply to example-co, and re-mapped
the 6 open vendor findings from paragraphs 19(e) and 22(a) to successor paragraphs 79 and 84-86 (ledger version
`soc/versions/commit_6.diff`). Existing IT outsourcing agreements had to comply by 2026-04-10 or at renewal. The
drift `refresh-ctx` raised is resolved: observation [obs_01M2G651Z4433JB67Q5G0T111A] (result `satisfied`, 2026-09-14T14:46:47Z)
supersedes [obs_01M2FH0ZNKQRSBK4RWM938HDWT], and risk [rsk_01M2FH0ZPG0XQAA2PZ522ZNGQK] moved through `investigating`
and `mitigating` to `closed` after the profile, registry and ledger checks passed.

0 escalated claim(s) awaiting human resolution as of this refresh.

Refresh date: 2026-09-14 (`provenance.generatedAt` 2026-09-14T08:31:29Z).

## Vendors
`refresh-vendor-ctx` refreshed this section as of 2026-09-14T10:46:39Z: 0 vendors onboarded, 1 updated
(`github`, re-read at 2026-09-14T10:46:39Z), 6 new finding(s) raised this run, 0 findings re-seen. Source:
`company-profile/example-co/vendors/*.json` (3 files) and vendor-targeted findings in `soc/main.jsonl`.

| Vendor | Legal name | Status | Materiality | Critical functions | Hosting vs. residency | Newest assurance | Expiry | Open findings |
|---|---|---|---|---|---|---|---|---|
| `aws` | Amazon Web Services, Inc. | active | material | order-routing (`mcp-gateway`) | AWS ap-south-1, hosting `IN`; app residency requirement `IN` (match) | soc2-type2 (Ernst & Young LLP, period ending 2026-03-31) | 2027-03-31 | [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] |
| `github` | GitHub, Inc. | active | material | none (`supportsCriticalFunction: false`; repos back `mcp-gateway`, `db-models`) | GitHub Enterprise Cloud, hosting `US`; no critical function assigned so no residency requirement applies | soc2-type2 (Ernst & Young LLP, period ending 2025-09-30) | 2026-09-30 | [fnd_01M2FS4806WHXANC3Q9QXEAXGF], [fnd_01M2FS481DGTPTR9NJGKAAMF49], [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] |
| `mongodb-atlas` | MongoDB, Inc. | active | material | order-routing (`mcp-gateway`) | Atlas on AWS ap-south-1, hosting `IN`; app residency requirement `IN` (match) | none on file | n/a | [fnd_01M2FS9EBVSP2DPWN5K2D91QKW], [fnd_01M2FS9ECP3E0MTCRQFEJ97930] |

<!-- source: company-profile/example-co/vendors/*.json services[].hostingCountries vs applications/mcp-gateway/env/*.json residency; open findings = latest kind:finding per id with target.type:vendor and status open in soc/main.jsonl -->

Expiry note: GitHub's SOC 2 Type II report expires 2026-09-30, 16 days after this run's
`provenance.generatedAt` (2026-09-14T10:46:39Z), inside the 90-day assurance-expiring window; flagged in
[fnd_01M2FS4806WHXANC3Q9QXEAXGF]. `mongodb-atlas` carries no `assurance[]` entry in its vendor file at all.

## Data flows
`refresh-metastore` catalogued this run: 1 catalog (0 carried forward, 0 dropped), 14 tables, 36 PII columns,
0 pipelines, 0 lineage edges, 12 confirmed gap(s), from `company-profile/example-co/sdlc/metastore.json`
(`snapshotAt` 2026-09-14T11:10:49Z).

### Catalogs by application

| App | Catalog | Type | Tables | PII columns | Residency |
|---|---|---|---|---|---|
| `db-models` | `db-models-mongodb` | other (MongoDB document store; no document-store catalog type exists yet, see `schema-gap` below) | 14 | 36 | unknown — endpoint and region not resolvable (`endpointRef: db-models-mongodb-ro` is a placeholder, not a resolvable locator) [obs_01M2FTMXD2BWZNQ5TE51A42A5P] |

Table-level counts (columns / of which PII), all under schema `default`: `secrets` 7/6, `webinar` 4/0,
`communities` 5/1, `new_discussions` 20/7, `entity` 48/7, `insights_raw` 23/0, `insights_raw_crypto` 23/0,
`insights_raw_us_stocks` 23/0, `insights` 24/0, `user` 54/13, `notifications` 8/0, `feedback` 3/1, `reward`
9/1, `cached_chats` 2/0 (sum: 14 tables, 36 pii columns). `secrets` and `user` also carry `spdi` and
`financial`-classified columns (trading-account credentials, portfolio holdings and values)
[obs_01M2FTMXD2S83CCJ9B0H279E2R].

`mcp-gateway`'s repo `mongodb-mcp-server` recorded no catalog: it is a generic MongoDB MCP client whose
database, collections and fields come from a connection string supplied at runtime, so nothing could be
recorded from code [obs_01M2FTV6HWRF2KFZCSKGXQ4EC8]. It is the only application backing the
`order-routing` critical function (`details.json` `criticalFunctions[0]`).

### Pipelines and lineage
`pipelines: []` and `lineage: []` in `sdlc/metastore.json` — no orchestrator, source repo, schedule or
OpenLineage edge is recorded this run, so no source -> job -> sink chain carrying pii, spdi, cardholder or
financial data can be shown.

### Retention versus in-scope instruments
No table in `db-models-mongodb` carries a `retentionDays` value (all null in `sdlc/metastore.json`), so no
recorded retention period can be compared against the in-scope instruments' data- and log-retention periods
(`dpdp-rules-2025:8(3)` data-retention 1 year, `dpdp-rules-2025:6(1)(e)` log-retention 1 year,
`cert-in-directions-2022:Dir-v`/`Dir-vi` data-retention 5 years, `cert-in-directions-2022:Dir-iv` log-retention
180 days): no record-keeping period stated by an in-scope instrument is present in the metastore to compare.
This is itself an evidence request: `user`, `secrets` and several other collections hold personal data with
no retention setting, TTL index or expiry field in code [obs_01M2FTMXD2QGV91CGDAFY0YQ0S]. For `mcp-gateway`,
log retention is configured outside the repo (env files state prod 365 days, qa 180 days via a Wazuh SIEM) and
is requested for confirmation against `cert-in-directions-2022:Dir-iv` (180 days) and
`rbi-cyber-tech-directions-2026:95` [obs_01M2FTV6MCKCJTVHDHHP02KJ2V].

### Confirmed gaps (12)
db-models / onfinance-db-model-master (9): 1 endpointRef-missing [obs_01M2FTMXD2BWZNQ5TE51A42A5P], 3
evidence-request [obs_01M2FTMXD2QGV91CGDAFY0YQ0S], 4 classification-conflict
[obs_01M2FTMXD2S83CCJ9B0H279E2R], 1 schema-gap [obs_01M2FTN49XKFG0B4JAZRP4P6X1]. mcp-gateway /
mongodb-mcp-server (3): evidence-request for target inventory/residency
[obs_01M2FTV6K4Q25G1JT58HAZDV36], log retention [obs_01M2FTV6MCKCJTVHDHHP02KJ2V], and telemetry PII transfer
[obs_01M2FTV6NJKW6VW58KFH78E5AV]. Catalogue-level summaries: [obs_01M2FTMXD188SPBHGHF4AMHN97],
[obs_01M2FTV6HWRF2KFZCSKGXQ4EC8].

<!-- source: sdlc/metastore.json catalogs[].schemas[].tables[].columns[] counted by pii:true; soc/main.jsonl kind:observation with provenance.workflow:refresh-metastore and provenance.runId:run_01M2FGNVVQ15ZKXZWGW74YWAAQ -->

## Control summary
Latest control record per id in `company-profile/example-co/soc/main.jsonl` after the `rbi-it-outsourcing-md-2023`
migration at 2026-09-14T14:41:43Z: 540 records, 476 applicable. `refresh-soc` created 360 of them at
2026-09-14T09:55:06Z; since then `probe-iac` and `probe-schemas` re-assessed 19 controls from their observations.

| Instrument | Controls | Not applicable | Effective | Partially effective | Ineffective | Not tested | Coverage |
|---|---|---|---|---|---|---|---|
| `sebi-cscrf-2024` (SEBI CSCRF 2024) | 124 | 0 | 0 | 4 | 7 | 113 | 9 % (11 of 124) |
| `rbi-cyber-tech-directions-2026` (RBI Cyber Tech Directions 2026) | 99 | 0 | 0 | 1 | 1 | 97 | 2 % (2 of 99) |
| `rbi-outsourcing-risk-directions-2025` (RBI Outsourcing Directions 2025) | 176 | 0 | 0 | 0 | 0 | 176 | 0 % (0 of 176) |
| `dpdp-rules-2025` (DPDP Rules 2025) | 48 | 0 | 0 | 2 | 3 | 43 | 10 % (5 of 48) |
| `cert-in-directions-2022` (CERT-In Directions 2022) | 29 | 0 | 0 | 0 | 1 | 28 | 3 % (1 of 29) |
| `rbi-it-outsourcing-md-2023` (repealed 2025-11-28) | 64 | 64 | 0 | 0 | 0 | 0 | n/a |
| **Total** | **540** | **64** | **0** | **7** | **12** | **457** | **4 % (19 of 476)** |

<!-- source: latest-state map over soc/main.jsonl kind=control, grouped by id prefix before ':'; not-applicable counted separately, the rest by effectiveness -->

Coverage divides the controls whose latest record carries a `lastAssessedAt` set from an observation `result` by
the applicable (not `not-applicable`) controls; `kpis/measurement/cm_coverage.md` defines the KPI.

## Open findings
`probe-schemas` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 2853edbc-3a09-4ec1-87ad-1afe187bb68c): 6 new data and API schema finding(s)
([fnd_01M2GMN60SYB8DHVX3XN4J84G5], [fnd_01M2GMN61NFQDTRGPZ5RMSMTWN], [fnd_01M2GMN62KVM9J9R852X3E3ST7],
[fnd_01M2GMN63DEDR29P66QTKND8E7], [fnd_01M2GMWPZ5DKN7DNH3D65T47FZ], [fnd_01M2GMWQ01QA647X5MYFGNS1MG]), 3
re-seen (0 reopened: [fnd_01M2G2AGPX8KWSY1KXGYADK4TK], [fnd_01M2G2AGVRZPBP3VH8FNAYH46V],
[fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] superseded with refreshed evidence, `status: open` unchanged), 11
observation(s) recorded (5 `not-satisfied`, 6 `partial`) [obs_01M2GMN5XBVMCMJ5V8VX8NR0BP],
[obs_01M2GMN5Y80ZKENZ2Z6TTWZR8K], [obs_01M2GMN5Z4B894SNSBPQRJEPMC], [obs_01M2GMN5ZYPC3SSB8KCNXB8X7T],
[obs_01M2GMWPRJJM5QFJX3G6NBT6JR], [obs_01M2GMWPSGBCYNXA6S2ZR7ZT5R], [obs_01M2GMWPTCBSW5HH427MNF8GB4],
[obs_01M2GMWPVB6XWCYHPQM9DMJ8P7], [obs_01M2GMWPWB887N582RCGZ1MNPP], [obs_01M2GMWPXBDB3P7BKCD617KSR8],
[obs_01M2GMWPY9B54SGT32H9MFQ5KY]. Two new findings target the `db-models` repo
`onfinance-db-model-master`'s data schema — Zerodha and Binance trading-account credentials persisted in
plain text with no encryption ([fnd_01M2GMN61NFQDTRGPZ5RMSMTWN]) and no retention, expiry or purge mechanism
for personal data or trading credentials ([fnd_01M2GMN63DEDR29P66QTKND8E7]) — plus two classification/consent
gaps in the same repo ([fnd_01M2GMN60SYB8DHVX3XN4J84G5], [fnd_01M2GMN62KVM9J9R852X3E3ST7]). Two more target the
`mcp-gateway` repo `mongodb-mcp-server`'s API contract: `switch-connection`'s `connectionString` argument
carries no `isSecret`/classification annotation ([fnd_01M2GMWPZ5DKN7DNH3D65T47FZ]) and `MDB_MCP_DRY_RUN` dumps
the full resolved config, including `isSecret`-marked fields, with no redaction
([fnd_01M2GMWQ01QA647X5MYFGNS1MG]).

`probe-iac` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` ba28bc2c-2822-41eb-92a8-b6389d3f1d0d): 1 new IaC misconfiguration finding
([fnd_01M2GJYP56VKDHARQPPFVATT0D]), 0 re-seen (0 reopened), 5 observation(s) recorded (2 `not-satisfied`, 3
`partial`) [obs_01M2GJT53BPGENG0VRARSM1K13], [obs_01M2GJT54AQ19T0RTD2Q1YH0BA],
[obs_01M2GJT5571NMNHVA729XDW07Z], [obs_01M2GJT565V6DXPG6MJKH6MG84], [obs_01M2GJT5722DBPKT7XMV26HS8E]. The
new finding targets the `mcp-gateway` repo `mongodb-mcp-server`'s `deploy/aws/Dockerfile`: the base image
carries no digest and `npm install -g mongodb-mcp-server@latest` installs whatever release is current at
build time, both with no lockfile, against `sdlc/policy.json dependencyPolicy.lockfilesRequired = true`.

`probe-schemas` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 314aa113-98aa-471e-941d-e1aa88798b5a): 7 new data and API schema finding(s)
([fnd_01M2G2AGNMHKF9PCB4C85A3JQ3], [fnd_01M2G2AGPX8KWSY1KXGYADK4TK], [fnd_01M2G2AGR581507FMK0EADFKY6],
[fnd_01M2G2AGSC977KASP37WQXYSQA], [fnd_01M2G2AGTH64FMR4XR77ZAJH7B], [fnd_01M2G2AGVRZPBP3VH8FNAYH46V],
[fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP]), 0 re-seen (0 reopened), 13 observation(s) recorded (9 `not-satisfied`, 4
`partial` against the schemas and tool contracts probed) [obs_01M2G24FKAKAVS5JTG628HDYT2],
[obs_01M2G24FM6869QF05J12Z8TVGB], [obs_01M2G24FN1C2V6TGNBNKX670H0], [obs_01M2G24FNWEXHPV4BHQXK1FFQ0],
[obs_01M2G24FPP5W96NFAQ6JF098SJ], [obs_01M2G2AGBTAPAK55XVEY24ANB4], [obs_01M2G2AGD08YM217WSQQWNP85A],
[obs_01M2G2AGE8XFQ4B12MRJBDWYCA], [obs_01M2G2AGFHXSCH94CR7SMFERAW], [obs_01M2G2AGGSXWPRR33K23JB6E90],
[obs_01M2G2AGHZT55J4AESPB6B0FPH], [obs_01M2G2AGK6ZVDTF4D9A0FNYF6V], [obs_01M2G2AGMDK4QXKHJRCYDQKTZT]. All
7 new findings target the `mcp-gateway` repo `mongodb-mcp-server`: unmasked personal/financial data returned
or exported by MCP tools, a plaintext-password response, missing default authentication on the HTTP
transport, unbounded/unvalidated tool arguments reaching the MongoDB driver, and MCP tool schemas carrying no
personal-data classification markers.

`probe-cicd-env` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 1a5b055e-58b2-4969-9611-d47c345c064a): 9 new CI/CD and supply-chain finding(s)
([fnd_01M2GH5AS0MM2F8MSFTDP36VV9], [fnd_01M2GH5AT8SW3Z6ZTZ73YN7QY6], [fnd_01M2GH5AVF2ZCBDXD5F25S2VGS],
[fnd_01M2GH5AWP81VXEQVWFXFRP3D9], [fnd_01M2GH5AXYX8NH35F6135G6VB4], [fnd_01M2GH5AZ5M0KCRXNTEY3DPH69],
[fnd_01M2GH5B0C1BP3QP8HHA0MJNVY], [fnd_01M2GH5B1JFJYTA2MGWES48JP5], [fnd_01M2GH5B2SNX0PD3EKVNVTPAG7]), 0
re-seen (0 reopened), 8 observation(s) recorded. All 9 new findings target the `mcp-gateway` repo
`mongodb-mcp-server`'s CI/CD pipeline and supply chain: an unpinned `node:24-alpine` base image on both
Dockerfiles, an unverified `curl | tar` binary install alongside an ignored `VERSION` build arg, no
dependency/SCA scan and no container-image scan gating publish, no IaC lint for the checked-in Azure Bicep
templates, a secrets-scanning gate (`git-secrets --register-aws`) narrower than the `gitleaks` tool the
policy declares, published images that are never signed/attested with cosign, a CI-generated SBOM that is
never captured into the workspace image inventory, and a static Docker Hub credential where the same repo
already uses OIDC federation for another publish target.

`probe-agent-graph` ran against `example-co` this run (`provenance.runId` run_01M2FGNVVQ15ZKXZWGW74YWAAQ,
`provenance.sessionId` 25584b4f-cb91-4da7-9198-1c6516a03390): 3 new agent-graph finding(s) against the OWASP
Agentic AI Top 10 2026 (`owasp-agentic-top10-2026`) ([fnd_01M2GPBK5MBCAFFV7KNH83JV1F],
[fnd_01M2GPBK5MSHBXGGFSRYHPXQY2], [fnd_01M2GPBK5MB962TKED1TFBTF3A]), 0 re-seen (0 reopened), 5 observation(s)
recorded [obs_01M2GPBK5JXJTXXTT6R2YA05PN], [obs_01M2GPBK5M3198JC7AD8BMB21H]. All 3 new findings target the
`mcp-gateway` repo `mongodb-mcp-server`: the elicitation-based confirmation for destructive MongoDB/Atlas
tools auto-approves when the client omits elicitation support
([fnd_01M2GPBK5MBCAFFV7KNH83JV1F], SEBI sebi-cscrf-2024 PR.AA.S3), write/delete MongoDB and Atlas tool
categories are enabled by default with no allow-list ([fnd_01M2GPBK5MSHBXGGFSRYHPXQY2], SEBI sebi-cscrf-2024
PR.AA.S3), and the streamable HTTP transport has no authentication by default
([fnd_01M2GPBK5MB962TKED1TFBTF3A], SEBI sebi-cscrf-2024 PR.AA.S17).

Latest record per finding id in `company-profile/example-co/soc/main.jsonl` with `status` in
`open | triaged | remediating`, as of `provenance.generatedAt` 2026-09-14T19:14:04Z (32 open: 21 high, 11
medium, 0 past SLA):

### High

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FS4806WHXANC3Q9QXEAXGF] | assurance-expiring: github-cloud SOC 2 Type II report expires 2026-09-30, inside 90-day window | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S4 (SEBI CSCRF 2024) | 2026-09-14 | 2026-10-14T10:46:39Z | due in 30 d | open | n/a |
| [fnd_01M2FS9ECP3E0MTCRQFEJ97930] | contract-expiring: ATLAS-2025-1189 ended 2026-05-31, 106 days ago, no renewal evidence | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S4 | 2026-09-14 | 2026-10-14T10:46:39Z | due in 30 d | open | n/a |
| [fnd_01M2G2AGPX8KWSY1KXGYADK4TK] | find/export tools return full unmasked documents from pii/financial-classified collections | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGR581507FMK0EADFKY6] | aggregate tool returns full unmasked pipeline results | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGSC977KASP37WQXYSQA] | export tool writes full unmasked documents to an unencrypted local file | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGTH64FMR4XR77ZAJH7B] | CreateDBUserTool returns a newly generated password in plain text | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGVRZPBP3VH8FNAYH46V] | mcp-gateway's HTTP transport (/mcp) has no default authentication | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AS0MM2F8MSFTDP36VV9] | Both Dockerfiles pin `node:24-alpine` with no content digest | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S1 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AT8SW3Z6ZTZ73YN7QY6] | Unverified binary download in mcp-publish.yml, and deploy/aws/Dockerfile silently ignores its own version pin | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S4 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AVF2ZCBDXD5F25S2VGS] | No dependency/SCA vulnerability scan in any of the 20 CI workflows | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S12 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AWP81VXEQVWFXFRP3D9] | No container image vulnerability scan before the image is pushed to Docker Hub | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S12 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5AZ5M0KCRXNTEY3DPH69] | Policy's blocking secrets gate (gitleaks) is actually a narrower AWS-only scanner (git-secrets) | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S4 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GH5B1JFJYTA2MGWES48JP5] | SBOM generated by CI is never captured into the workspace image inventory for mcp-gateway | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 GV.SC.S5 | 2026-09-14 | 2026-10-14T13:48:42Z | due in 30 d | open | n/a |
| [fnd_01M2GH5B2SNX0PD3EKVNVTPAG7] | Docker Hub publish uses a static shared credential instead of the OIDC federation already used elsewhere in the repo | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T13:48:42Z | due in 7 d | open | n/a |
| [fnd_01M2GJYP56VKDHARQPPFVATT0D] | AWS Bedrock AgentCore Dockerfile has no pinned base image or package version | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S3 | 2026-09-14 | 2026-09-21T18:08:50Z | due in 7 d | open | n/a |
| [fnd_01M2GMN61NFQDTRGPZ5RMSMTWN] | Zerodha and Binance trading-account credentials persisted in plain text with no encryption | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.DS.S1 | 2026-09-14 | 2026-10-14T18:36:43Z | due in 30 d | open | n/a |
| [fnd_01M2GMWPZ5DKN7DNH3D65T47FZ] | switch-connection tool's connectionString argument carries no isSecret/classification annotation | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T18:36:43Z | due in 7 d | open | n/a |
| [fnd_01M2GMWQ01QA647X5MYFGNS1MG] | MDB_MCP_DRY_RUN dumps the full resolved config, including isSecret-marked fields, with no redaction | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T18:36:43Z | due in 7 d | open | n/a |
| [fnd_01M2GPBK5MBCAFFV7KNH83JV1F] | Elicitation-based approval for destructive MongoDB/Atlas tools auto-approves when the client omits elicitation support | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 (OWASP Agentic AI Top 10 2026 ASI09) | 2026-09-14 | 2026-09-21T19:14:04Z | due in 7 d | open | n/a |
| [fnd_01M2GPBK5MSHBXGGFSRYHPXQY2] | Write/delete MongoDB and Atlas tool categories are enabled by default with no allow-list | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S3 | 2026-09-14 | 2026-09-21T19:14:04Z | due in 7 d | open | n/a |
| [fnd_01M2GPBK5MB962TKED1TFBTF3A] | Streamable HTTP transport has no authentication by default | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T19:14:04Z | due in 7 d | open | n/a |

### Medium

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] | material-without-evidence: aws-mumbai (order-routing, pii/financial) has no documented exit plan | vendor `aws` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS481DGTPTR9NJGKAAMF49] | contract-expiring: GH-ENT-2025-07 ended 2026-06-30, 76 days before now, no renewal evidence | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] | material-without-evidence: github lacks audit rights and a documented exit plan | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS9EBVSP2DPWN5K2D91QKW] | material-without-evidence: atlas-mumbai has no audit rights, no exit plan, contract lapsed | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2G2AGNMHKF9PCB4C85A3JQ3] | MongoDB MCP tool schemas carry no personal-data classification markers | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 14 d | open | n/a |
| [fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] | Open EJSON filter/pipeline/document arguments and unbounded database/collection names reach the MongoDB driver directly | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 14 d | open | n/a |
| [fnd_01M2GH5AXYX8NH35F6135G6VB4] | No IaC lint/scan for the checked-in Azure Bicep templates | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S6 | 2026-09-14 | 2026-09-28T13:48:42Z | due in 14 d | open | n/a |
| [fnd_01M2GH5B0C1BP3QP8HHA0MJNVY] | Published image is never signed or attested with cosign | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.IP.S2 | 2026-09-14 | 2026-09-28T13:48:42Z | due in 14 d | open | n/a |
| [fnd_01M2GMN60SYB8DHVX3XN4J84G5] | Metastore-catalogued PII/SPDI columns carry no classification annotation in models.py | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T18:36:43Z | due in 14 d | open | n/a |
| [fnd_01M2GMN62KVM9J9R852X3E3ST7] | User document has no consent/purpose/notice reference | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 GV.OC.S2 | 2026-09-14 | 2026-09-28T18:36:43Z | due in 14 d | open | n/a |
| [fnd_01M2GMN63DEDR29P66QTKND8E7] | No retention, expiry or purge mechanism for personal data or trading credentials | repo `db-models/onfinance-db-model-master` | SEBI sebi-cscrf-2024 PR.AA.S13 | 2026-09-14 | 2026-12-13T18:36:43Z | due in 90 d | open | n/a |

<!-- source: latest-state map over soc/main.jsonl kind=finding, filtered to status in open|triaged|remediating; SLA status = ceil((slaDueAt - 2026-09-14T19:14:04Z)/86400000) days -->

No findings in `risk-accepted`, `false-positive` or `duplicate` this period.
