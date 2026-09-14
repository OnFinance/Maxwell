---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: example-co
title: Example Capital Markets cyber resilience summary
version: "0.2.0"
sections: [overview, regulatory-posture]
provenance:
  harness: claude-code
  generatedAt: "2026-09-14T08:31:29Z"
  sessionId: f0fb0ca1-ccc3-4797-afc8-2bbe384b5053
  runId: run_01M2FGNVVQ15ZKXZWGW74YWAAQ
  workflow: refresh-ctx
  agent: report-writer
  inputsHash: 9d97c579a8dde931542cf19f2d31ba879428228f2b68ee31d0ba7228281d0a02
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
