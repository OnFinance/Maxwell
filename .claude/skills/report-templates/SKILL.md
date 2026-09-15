---
name: report-templates
description: The exact section structure of company-profile/<c>/summary.md (frontmatter per v1/frontmatter/company-summary.schema.json with the twelve-value sections enum and inputsHash), the templates report-audit-findings uses for executive summary, regulatory posture table, findings by severity with SLA status, risks, incidents and coverage, the templates report-audit-improvements uses for initiative status, suggestion acceptance and the KPI table from kpis/data/<kpi>/series.jsonl with methodology links, the [fnd_…]/[obs_…]/regulatoryRef citation style, and the rule that each report rewrites only its own sections. Load before writing or editing any summary.md.
license: AGPL-3.0-only
compatibility: Requires the Maxwell workspace layout; the report-writer reads the soc ledger, change_management, suggestions and kpis/data series and writes only summary.md plus soc observations
metadata:
  author: OnFinance
  version: "1.0.0"
  schema: .claude/schemas/v1/frontmatter/company-summary.schema.json
allowed-tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash(node .claude/scripts/*)
  - Bash(sha256sum *)
  - Bash(cat *)
  - Bash(cut *)
when_to_use: When a report-audit-findings or report-audit-improvements workflow (or the report-writer agent) needs to produce or refresh a company summary, or when a status command quotes summary.md sections
user-invocable: false
x-maxwell:
  kind: convention
  workflows: [report-audit-findings, report-audit-improvements, refresh-ctx, refresh-vendor-ctx, refresh-metastore, refresh-apps, refresh-soc, impl-change-management, impl-auto-improvement, status]
---
# Report templates for `summary.md`

`company-profile/<company_id>/summary.md` is the one human-readable report per company. It is regenerated,
never appended to, and it is the only report file that may exist: findings go to the ledger, reports go here
and to `observation` records, nothing goes to a new `.md`. Two workflows share the file and each **rewrites
only its own level-2 sections**, leaving every other section byte-for-byte unchanged:

| Section id (frontmatter `sections[]`) | Heading | Owner |
|---|---|---|
| `overview` | `## Overview` | report-audit-findings |
| `regulatory-posture` | `## Regulatory posture` | report-audit-findings |
| `organization-context` | `## Organization context` | report-audit-findings (from `context.json`; omit when absent) |
| `applications` | `## Applications` | report-audit-findings |
| `data-flows` | `## Data flows` | report-audit-findings (from `sdlc/metastore.json`; omit when absent) |
| `vendors` | `## Vendors` | report-audit-findings (omit when `vendors/` is empty) |
| `control-summary` | `## Control summary` | report-audit-findings |
| `open-findings` | `## Open findings` | report-audit-findings |
| `risks` | `## Risks` | report-audit-findings |
| `incidents` | `## Incidents` | report-audit-findings |
| `initiatives` | `## Initiatives` | report-audit-improvements |
| `suggestions` | `## Suggestions` | report-audit-improvements |
| `kpis` | `## KPIs` | report-audit-improvements |

Sections appear in this order. `sections[]` lists exactly the headings present, in document order; a section
whose source is empty is still written with a single line `No records as of <generatedAt>.` unless the table
above says "omit". Headings are exact strings; `/status` reads the frontmatter (`sections[]`, `generatedAt`) and reviewers diff
the sections, so a renamed heading breaks both.

Matching an existing file: map each `## ` heading to a section id by lower-casing it and replacing spaces with
hyphens, so the seed fixture's `## overview` and the canonical `## Overview` are the same section. When you
rewrite a section you own, write the canonical heading from the table; never rename a heading you do not own.
The document title line `# <title>` sits between the frontmatter and the first section and belongs to
report-audit-findings.

Early refreshes: between audits other workflows ask the report-writer to refresh a subset of these sections
so `/status` stays current. The table above is the owner of record; the rows below are copied verbatim from the
section-ownership table in `.claude/agents/report-writer.md`, which is authoritative if the two ever differ:

| calling workflow | default sections |
|---|---|
| report-audit-findings | overview, regulatory-posture, organization-context, applications, data-flows, vendors, control-summary, open-findings, risks, incidents |
| report-audit-improvements | initiatives, suggestions, kpis |
| refresh-ctx | regulatory-posture, organization-context |
| refresh-vendor-ctx | vendors |
| refresh-metastore | data-flows |
| refresh-apps | applications |
| refresh-soc | control-summary |
| probe-*, execute-scr | open-findings, control-summary |
| runtime-probe-* | control-summary, open-findings |
| impl-change-management | initiatives |
| impl-auto-improvement | suggestions |

So every `probe-*` workflow, `execute-scr` and every `runtime-probe-*` workflow refreshes `control-summary` and
`open-findings` (that is what they request), and `refresh-ctx` refreshes `regulatory-posture` and `organization-context`. Early
refreshes render with the same templates below, so the next `report-audit-*` run overwrites them without
drift. A requested id outside a workflow's row, or a workflow with no row, goes to `sectionsSkipped` with the
reason.

## 1. Frontmatter
```yaml
---
schemaVersion: "1"
kind: maxwell.company.summary
companyId: <company_id>
title: <Legal name> cyber resilience summary
version: "1.4.0"          # new file 1.0.0; bump minor on every regeneration, major (minor and patch reset) when sections[] changes
sections: [overview, regulatory-posture, applications, control-summary, open-findings, risks, incidents, initiatives, suggestions, kpis]
provenance:
  harness: claude-code
  generatedAt: "2026-09-13T08:00:00Z"   # quote every timestamp
  sessionId: <sid>
  runId: <MAXWELL_RUN_ID>
  workflow: report-audit-findings       # the workflow that last wrote
  agent: report-writer
  model: <model id>
  inputsHash: <sha256>
---
```
`inputsHash` is sha256 over the concatenated bytes of, in this exact order: `details.json`,
`sdlc/policy.json`, `sdlc/metastore.json`, `vendors/*.json` sorted by file name, `soc/main.jsonl`,
`change_management/master.json`, `change_management/initiatives/*/timeline.json` sorted by initiative id,
`suggestions/master.json`.
- `details.json` and `soc/main.jsonl` are mandatory: if either is absent, write nothing and report
  `<path> absent`.
- Every other file is **skipped when absent** (a new company may have no `change_management/master.json` or
  `suggestions/master.json` yet). List the files with Glob first and put only files that exist on the
  command line, so `cat` never prints an error while the pipeline still exits 0 over a partial input. Name
  each skipped file in the return `notes` ("suggestions/master.json absent; excluded from inputsHash").
- Take only the 64 hex characters: `sha256sum` prints `<hash>  -`.
```
cat company-profile/<c>/details.json company-profile/<c>/sdlc/policy.json \
  company-profile/<c>/vendors/nsdl-payments.json company-profile/<c>/vendors/tcs-bancs.json \
  company-profile/<c>/soc/main.jsonl company-profile/<c>/change_management/master.json \
  company-profile/<c>/change_management/initiatives/init_01J7Q3V8K2M4N6P8R0S2T4V6Y5/timeline.json \
  company-profile/<c>/suggestions/master.json | sha256sum | cut -d' ' -f1
```
(here `sdlc/metastore.json` was absent, so it is not on the line). Never type a hash from memory.

Every write updates the whole frontmatter (version, provenance, inputsHash), even when only some sections
were rewritten. The hash therefore proves only that the sections **the last writer rendered** match the
inputs; sections written earlier by another workflow may be older. Hence the quiet-exit rule below.

**Quiet exit (report current).** A workflow may skip the rewrite and say "report current" only when **all**
of these hold; otherwise it rewrites its sections:
1. the freshly computed `inputsHash` equals `provenance.inputsHash`;
2. `provenance.workflow` is the calling workflow itself, so its own sections were the ones rendered against
   that hash (after `refresh-soc` rewrote `control-summary`, the next `report-audit-findings` always rewrites,
   because its `open-findings`, `risks`, `incidents` and `overview` were rendered against an older ledger);
3. every section the caller owns and whose source is non-empty is present in `sections[]`;
4. the UTC date of `provenance.generatedAt` equals today's UTC date (the run timestamp). Time-relative
   columns (`due in <n> d`, `overdue <n> d`, past-SLA counts, `**MISSED**` clocks, overdue initiatives) change
   as the date moves without any input changing, so they are recomputed on every new day;
5. for `report-audit-improvements`: no `kpis/data/<kpi_id>/series.jsonl` datapoint for this company has a
   `computedAt` later than `provenance.generatedAt` (series files are not a hash input);
6. for `report-audit-findings`: no `applications/<app_id>/env/*.json`, `images/*.json` or `repos/*.json`
   record has a `provenance.generatedAt` later than the report's `provenance.generatedAt` (application files
   are not a hash input either).
A caller that asks for a forced rewrite never exits quietly.

## 2. Citation style
- Ledger records are cited in square brackets by id: `[fnd_01J7Q3V8K2M4N6P8R0S2T4V6X9]`,
  `[obs_01J7Q3V8K2M4N6P8R0S2T4V6W8]`, `[rsk_…]`, `[inc_…]`, `[init_…]`, `[sug_…]`. Controls are cited by their
  qualified ledger id in backticks: `` `sebi-cscrf-2024:GV.SC.S5` ``.
- Regulatory references are written `regulator instrument controlId` exactly as the `regulatoryRef` object
  reads: `SEBI sebi-cscrf-2024 GV.SC.S5`, `CERT-In cert-in-directions-2022 Dir-iv`; add the catalog title in
  parentheses once per section on first use. Control ids are the catalog ids verbatim (`[A-Za-z0-9._()-]`
  only, so never `§`, `Rule 6(1)` with spaces, or a clause paraphrase).
- Evidence is never pasted; refer to it as `evidence: command-output sha256 a3f1…` or the workspace path.
- Every number in a table must be reproducible from the ledger or a `series.jsonl` line; write the query in a
  trailing `<!-- source: … -->` HTML comment when it is not obvious.
- Dates are `YYYY-MM-DD` in prose, full RFC 3339 in tables that carry SLA clocks.

## 3. report-audit-findings templates

### `## Overview` (executive summary, <= 200 words)
Paragraph 1: entity type(s) and regulators from `details.json`, RE category, applications in scope, period
covered (`firstSeenAt` min to `generatedAt`). Paragraph 2: the numbers: controls assessed / satisfied /
partial / not-satisfied / inconclusive, open findings by severity, findings past SLA, open risks, incidents
in period, regulator reports filed on time. Paragraph 3: the three items a CISO must act on this week, each
with a citation. No adjectives that a number does not support.

### `## Regulatory posture`
```
| Instrument | Regulator | Applicability | Controls | Implemented | Partial | Planned | Not impl. | Unknown | Open findings | Past SLA |
|---|---|---|---|---|---|---|---|---|---|---|
| sebi-cscrf-2024 (SEBI CSCRF 2024) | SEBI | qualified-re | 48 | 31 | 7 | 2 | 5 | 3 | 7 | 2 |
```
One row per instrument in `details.json` registrations plus every instrument cited by a ledger control.
Counts come from `implementationStatus` of the latest control record per id (supersession chain; `alternative`
counts as Implemented and `not-applicable` is excluded from Controls, both stated under the table), findings from `status in
open|triaged|remediating`. Below the table, one bullet per instrument naming the weakest control family
(`GV.SC`, `PR.AA`) with a citation.

### `## Organization context`
Source `company-profile/<c>/context.json`; omit the section when the file is absent. Open with the `summary`
paragraph and the context `status`. Then:
```
| Business unit | Listed | Licences | Obligations | Processes |
|---|---|---|---|---|
| Broking and depository services | No | SEBI stock broker INZ000123456 (active), CDSL DP IN-DP-123-2016 (active) | MCA Companies Act 2013 | secretarial-compliance |
```
One row per business unit. Below it, one bullet per licence: its obligations (regulator, source), offerings
(with `count` when set), customer segments and platforms with their cybersecurity instruments. Then a
`Questionnaires` sub-list: per questionnaire the counts answered / open / not-applicable, and the first 20 **open**
questions verbatim with their `questionId`, `answerableFrom` and reason, internal ones first (then one line `and <n> more open questions in context.json`),
so a human can answer them with `node .claude/scripts/ctx/answer.mjs <company_id> <question_id>`. Processes are grouped by `kind` with their
obligation ids. Cite no control ids here; this section describes the business, not its posture.

### `## Applications`
One subsection `### <app_id>` per application: environments (tier, exposure, residency, log retention days
and whether >= 180 in India, citing `CERT-In cert-in-directions-2022 Dir-iv` when below), repos with `pinnedCommit`, images with SBOM status
(present / present-but-empty / missing), open findings count by severity, last probe `collectedAt`.

### `## Control summary`
Ordered by control family, one line per family: `GV.SC Supply chain: 6 controls; 4 effective, 1 partially
effective, 1 not tested; coverage 83 % (5 observed of 6)`. Coverage here mirrors `cm_coverage`; link the
methodology `kpis/measurement/cm_coverage.md`.

### `## Open findings`
Grouped `### Critical`, `### High`, `### Medium`, `### Low`, `### Info`, empty groups omitted:
```
| Id | Title | Target | Regulatory ref | First seen | SLA due | SLA status | Status | Initiative |
|---|---|---|---|---|---|---|---|---|
| [fnd_…] | batch-settlement image ships lodash 4.17.20 | image trading-api/batch-settlement | SEBI sebi-cscrf-2024 PR.MA.S3 | 2026-09-13 | 2026-09-20T08:05:00Z | due in 7 d | open | [init_…] |
```
`SLA status` is one of `overdue <n> d`, `due in <n> d`, `met`, `n/a` computed from `slaDueAt` against
`generatedAt`; never reinterpret the SLA table here. Findings in `risk-accepted`, `false-positive`,
`duplicate` are listed in a final `### Closed this period` table with `statusReason`.

### `## Risks`
`| Id | Title | Severity | Likelihood | Impact | Status | Owner | Deadline | Mitigation initiative |`, open
statuses first, then `accepted` and `deviation-approved` with the approver named in prose.

### `## Incidents`
`| Id | Title | Severity | Status | Detected | Contained | Regulator | Clock (h) | Reported | On time |` where
`Clock` is `regulatorReportRefs[].deadlineHours` and `On time` compares `submittedAt - detectedAt` with it. A
missing `submittedAt` with the clock expired is written `**MISSED**` and repeated in the Overview.

### Coverage paragraph (end of `## Control summary`)
"Maxwell observed N of M applicable controls in this period (X %); Y controls were inconclusive for lack of
access ([obs_…], [obs_…]); Z environments were skipped (freeze / window / no credentials)." Cite each
inconclusive observation; these are the task requests the improvements report tracks.

## 4. report-audit-improvements templates

### `## Initiatives`
Counters line from `change_management/master.json` (`open / closed / cancelled / overdue`), then:
```
| Id | Title | Status | Priority | Change type | Owner | Due | Tasks (done/total, blocked) | Findings | Regulatory ref |
```
Overdue rows first with `**overdue <n> d**`. Below the table, `### Blocked` listing every blocked task with
`blockedReason` and owner, and `### Evidence requests` listing tasks whose `verificationMethod.type` is
`re-probe` and status is not done (these close the inconclusive observations from the findings report).

### `## Suggestions`
```
| Id | Title | Category | Severity | Status | Repo | +/- lines | Surfaced | Decided by | PR |
```
Then acceptance figures for the period, computed exactly like `kpis/measurement/suggestion_acceptance_rate.md`
(acceptance, merge, revert, 30-day retention) and a `### Rejections` list quoting `decisionNote` verbatim so
prompt tuning has the reviewer's words.

### `## KPIs`
One row per KPI, newest datapoint per `series` from `kpis/data/<kpi_id>/series.jsonl` filtered to this
`companyId` (or the all-up dimension tuple when no company slice exists):
```
| KPI | Series | Period | Value | Unit | Sample | Target (warn / alert) | Trend | Method |
|---|---|---|---|---|---|---|---|---|
| Cost of audit | raw | 2026-09-01 -> 2026-09-13 | 312.48 | usd | 10 | 400 / 800 | -8 % vs prior | [cost_of_audit v1.0.0](../../kpis/measurement/cost_of_audit.md) |
```
`Sample` is the datapoint's `sampleSize` (`numerator / denominator` when both exist). Targets are
`targets.warn / targets.alert` from `kpis/metrics.json`; a value past `alert` is bold. `Trend` compares with the previous datapoint
of the same `methodVersion` and dimensions; write `n/a` across method versions. Every row links the
methodology doc and states `methodVersion`. Never compute a KPI here; if `series.jsonl` has no datapoint,
write `not computed; run /kpis` and do not estimate.

## 5. Procedure (both workflows)
1. Compute `inputsHash` (section 1); exit quietly with "report current" only when every quiet-exit condition
   in section 1 holds (hash match alone is not enough).
2. Read the existing `summary.md`; split on `^## ` headings; keep foreign sections verbatim.
3. Render your sections from the sources; run every table through the citation checks in section 2.
4. Write the file with the merged sections in canonical order and the updated frontmatter (version bump).
5. `node .claude/scripts/validate-data.mjs company-profile/<c>/summary.md`.
6. Record the report generation on the ledger as one `observation` (`title: "<workflow> regenerated
   summary.md sections <ids>"`, `methods: ["<workflow>"]`, `controlIds` = the instrument-qualified control ids
   the report cited, `result: "not-applicable"`, `collectedAt` = `generatedAt`, `evidence: [{type:
   "workspace-file", ref: "company-profile/<c>/summary.md", sha256}]` with `sha256sum` of the written file).
   The report-writer does not append it: it returns the record as `proposedObservation` and the workflow
   routes it to `soc-ledger-keeper` (`soc/append.mjs`), then runs `soc/version.mjs`. No observation when the
   report was current.
7. Return the section ids rewritten, the counts in the tables, and any MISSED regulator clock.
