---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "4.7.0"
sections: [overview, regulatory-posture, vendors, data-flows, control-summary, open-findings]
provenance:
  harness: opencode
  generatedAt: "2026-09-14T21:59:48Z"
  sessionId: "ses_f5ddfd1f2ffeC0bYhZN5tu6rj3"
  runId: run_01M2GDZ3Q3S5WYCB3MV02QJXZ1
  workflow: refresh-metastore
  agent: report-writer
  inputsHash: fff2796598bbc6a6435e45ac3f9b033987cb681582d37cc17474fee0fad0af24
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
([obs_01M2FTV6K4Q25G1JT58HAZDV36], [obs_01M2FTV6MCKCJTVHDHHP02KJ2V], [obs_01M2FTV6NJKW6VW58KFH78E5AV]); 0 environments
were skipped (no runtime probe ran and the ledger records no freeze, window or credential skip). Coverage basis: applicable
control ids named in the `controlIds` of at least one of the 45 ledger observations (39 substantive, 6 report-generation,
all collected on 2026-09-14), over the 478 applicable controls; this mirrors `cm_coverage`
(kpis/measurement/cm_coverage.md), except that the KPI's `excludedWorkflows` (kpis/metrics.json) drops `refresh-*`
observations, which would give 18 of 478 (4 %).

<!-- source: latest-state map over soc/main.jsonl kind=control (710 lines, last line per record id), grouped by instrument id prefix before ':'; effectiveness counts exclude implementationStatus not-applicable; coverage = applicable control ids in controlIds of the 45 kind=observation records -->

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
