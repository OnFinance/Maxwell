---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "2.0.0"
sections: [overview, regulatory-posture, vendors, control-summary]
provenance:
  harness: claude-code
  generatedAt: "2026-09-14T10:46:39Z"
  sessionId: 30803fac-c775-4bd4-b5a5-82ebddf41fac
  runId: run_01M2FGNVVQ15ZKXZWGW74YWAAQ
  workflow: refresh-vendor-ctx
  agent: report-writer
  inputsHash: d01538e3b9f91b0ab123ecdf7dbb5f376eb368af763ef2b501c859f3ec4a316d
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
