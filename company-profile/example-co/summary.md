---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "4.1.0"
sections: [overview, regulatory-posture, data-flows, vendors, control-summary, open-findings]
provenance:
  harness: claude-code
  generatedAt: "2026-09-14T13:14:50Z"
  sessionId: "314aa113-98aa-471e-941d-e1aa88798b5a"
  runId: run_01M2FGNVVQ15ZKXZWGW74YWAAQ
  workflow: probe-schemas
  agent: report-writer
  inputsHash: 2047d7d534d61557e42789b6242b07b0918bbd6bb9069480a0fb5bb5535b3890
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

Frameworks in scope: `sebi-cscrf-2024`, `rbi-cyber-tech-directions-2026`, `rbi-it-outsourcing-md-2023`,
`cert-in-directions-2022`, `dpdp-rules-2025`, `iso-27001-2022`.

**Drift applied in this run (`regime_overhaul@/frameworksInScope`).** `rbi-it-outsourcing-md-2023` remains
listed in `frameworksInScope`, but RBI repealed it for NBFCs on 2025-11-28 and replaced it with the Reserve
Bank of India (NBFC — Managing Risks in Outsourcing) Directions, 2025 (RBI/DOR/2025-26/363), which has no
vocab id and cannot be expressed via `supersedes[]`. Third-party IT and cyber arrangements outside the
outsourcing directions already fall under RBI rbi-cyber-tech-directions-2026 paras 126-135, in scope. The
profile itself was left unchanged this run; the regime change is recorded as observation
[obs_01M2FH0ZNKQRSBK4RWM938HDWT] anchored on `` `rbi-cyber-tech-directions-2026:12` `` and as risk
[rsk_01M2FH0ZPG0XQAA2PZ522ZNGQK] (severity medium, status open).

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
`refresh-soc` reconciled the ledger this run: 360 new control records, 1 re-assessed
(`sebi-cscrf-2024:GV.SC.S3`, supersession recorded at 2026-09-14T09:19:31Z), 0 findings resolved by the
absent-twice rule, 0 findings and 0 risks reopened after expired acceptances, 0 SLA dates recomputed.

Latest control record per id in `company-profile/example-co/soc/main.jsonl` (362 total), grouped by
instrument (per-family breakdown within each instrument is uniform: every control is `not-tested`, so
category-level rows carry no additional information this run):

| Instrument | Controls | Effective | Partially effective | Ineffective | Not tested | Coverage |
|---|---|---|---|---|---|---|
| `sebi-cscrf-2024` (SEBI CSCRF 2024) | 124 | 0 | 0 | 0 | 124 | 0 % (0 of 124) |
| `rbi-cyber-tech-directions-2026` (RBI Cyber Tech Directions 2026) | 97 | 0 | 0 | 0 | 97 | 0 % (0 of 97) |
| `rbi-it-outsourcing-md-2023` (RBI IT Outsourcing MD 2023) | 64 | 0 | 0 | 0 | 64 | 0 % (0 of 64) |
| `dpdp-rules-2025` (DPDP Rules 2025) | 48 | 0 | 0 | 0 | 48 | 0 % (0 of 48) |
| `cert-in-directions-2022` (CERT-In Directions 2022) | 29 | 0 | 0 | 0 | 29 | 0 % (0 of 29) |
| **Total** | **362** | **0** | **0** | **0** | **362** | **0 % (0 of 362)** |

<!-- source: latest-state map over soc/main.jsonl kind=control, grouped by id prefix before ':', counted by effectiveness -->

Coverage mirrors `cm_coverage` (methodology: `kpis/measurement/cm_coverage.md`): a control counts as observed
when its latest record carries a `lastAssessedAt` set from an observation `result`. None of the 362 applicable
controls has one yet.

Maxwell observed 0 of 362 applicable controls in this period (0 %); 0 controls were inconclusive for lack of
access; 0 environments were skipped (freeze / window / no credentials). The only non-`not-applicable`
observation recorded this run, [obs_01M2FH0ZNKQRSBK4RWM938HDWT], is a `refresh-ctx` regulatory-drift finding
(`result: not-satisfied`) against `` `rbi-cyber-tech-directions-2026:12` ``, not a control assessment against
evidence, so it was not reconciled into that control's `effectiveness`/`lastAssessedAt` and does not count
toward coverage.

## Open findings
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

Latest record per finding id in `company-profile/example-co/soc/main.jsonl` with `status` in
`open | triaged | remediating`, as of `provenance.generatedAt` 2026-09-14T13:14:50Z (13 open, 0 past SLA):

### High

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FS4806WHXANC3Q9QXEAXGF] | assurance-expiring: github-cloud SOC 2 Type II report expires 2026-09-30, inside 90-day window | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S4 (SEBI CSCRF 2024) | 2026-09-14 | 2026-10-14T10:46:39Z | due in 30 d | open | n/a |
| [fnd_01M2FS9ECP3E0MTCRQFEJ97930] | contract-expiring: ATLAS-2025-1189 ended 2026-05-31, 106 days ago, no renewal evidence | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S4 | 2026-09-14 | 2026-10-14T10:46:39Z | due in 30 d | open | n/a |
| [fnd_01M2G2AGPX8KWSY1KXGYADK4TK] | find tool returns full unmasked documents from pii/financial collections | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGR581507FMK0EADFKY6] | aggregate tool returns full unmasked pipeline results | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGSC977KASP37WQXYSQA] | export tool writes full unmasked documents to an unencrypted local file | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.DS.S4 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGTH64FMR4XR77ZAJH7B] | CreateDBUserTool returns a newly generated password in plain text | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S1 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGVRZPBP3VH8FNAYH46V] | MCP HTTP transport has no default authentication requirement | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S6 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |
| [fnd_01M2G2AGX1GZ9THG6HJ1VPP1EP] | Core MongoDB tool arguments accept unbounded, unvalidated input that reaches the driver | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 PR.AA.S17 | 2026-09-14 | 2026-09-21T13:14:50Z | due in 7 d | open | n/a |

### Medium

| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_01M2FRY4TTS6M3JJD1F1P7J0TQ] | material-without-evidence: aws-mumbai (order-routing, pii/financial) has no documented exit plan | vendor `aws` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS481DGTPTR9NJGKAAMF49] | contract-expiring: GH-ENT-2025-07 ended 2026-06-30, 76 days before now, no renewal evidence | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS482NWXE7E5MCZY2QMAZ0] | material-without-evidence: github lacks audit rights and a documented exit plan | vendor `github` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2FS9EBVSP2DPWN5K2D91QKW] | material-without-evidence: atlas-mumbai has no audit rights, no exit plan, contract lapsed | vendor `mongodb-atlas` | SEBI sebi-cscrf-2024 GV.SC.S3 | 2026-09-14 | 2026-12-13T10:46:39Z | due in 90 d | open | n/a |
| [fnd_01M2G2AGNMHKF9PCB4C85A3JQ3] | MongoDB MCP tool schemas carry no personal-data classification markers | repo `mcp-gateway/mongodb-mcp-server` | SEBI sebi-cscrf-2024 ID.AM.S5 | 2026-09-14 | 2026-09-28T13:14:50Z | due in 14 d | open | n/a |

<!-- source: latest-state map over soc/main.jsonl kind=finding, filtered to status in open|triaged|remediating; SLA status = ceil((slaDueAt - 2026-09-14T13:14:50Z)/86400000) days -->

No findings in `risk-accepted`, `false-positive` or `duplicate` this period.
