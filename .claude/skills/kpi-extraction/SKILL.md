---
name: kpi-extraction
description: How Maxwell turns harness session transcripts (Claude Code JSONL, OpenCode exports) and workspace state into the six KPIs - cost of audit, change-management actionability, coverage and time to implementation, suggestion acceptance rate, incident rate. Use when ingesting sessions, computing or explaining KPIs, or changing the pricing table.
license: AGPL-3.0-only
metadata:
  methodologyDir: kpis/measurement
x-maxwell:
  kind: capability
  workflows: [kpis, report-audit-improvements, report-audit-findings]
---
# KPI extraction

## Pipeline
1. **Session meta** — `hooks/session-start.mjs` writes `kpis/data/raw/sessions/<harness>/<sid>.meta.json` at
   session start; `hooks/user-prompt.mjs` fills `workflow`, `companyId` and `args` from the `/<workflow>` prompt.
2. **Ingest** — `hooks/session-end.mjs` calls `node .claude/scripts/sessions/ingest.mjs --harness <h> --session
   <sid> [--transcript <path>]`, which applies the sampling policy from `kpis/metrics.json`, copies the transcript
   (gitignored) and writes `<sid>.summary.json` (OpenTelemetry GenAI-aligned token, cost and tool-call counters).
3. **Compute** — `npm run kpis [-- --company <id> --since <date> --kpi <id>]` appends one line per KPI/period/
   dimension to `kpis/data/<kpi_id>/series.jsonl` and one run record to `kpis/measurement/runs.jsonl`.
4. **Explain** — every KPI has a methodology document `kpis/measurement/<kpi_id>.md` (frontmatter validated).

## Rules that keep the numbers defensible
- Cost is always recomputed from tokens with `references/pricing.json` (five buckets: input, output, cache write
  5m, cache write 1h, cache read). Harness-reported cost is a cross-check (`costUsd.reported`, `deltaPct`).
- Claude Code transcripts are deduplicated per `requestId` keeping the max-total-token record; OpenCode stored
  `cost` is ignored.
- Never edit `series.jsonl` lines; recomputation appends with a new `computedAt` and the same `methodVersion`, so
  history stays auditable. Bump `methodVersion` in the methodology doc frontmatter when a formula changes.
- KPIs over workspace state (actionability, coverage, time to implementation, acceptance, incidents) are pure
  functions of the files; run them any time without a harness.
- PagerDuty reconciliation joins on `incident_key == dedupKey` only; mismatches are reported, not merged.

## Pricing table maintenance
`references/pricing.json` is validated against `vocab/pricing.schema.json`. When Anthropic changes list prices,
add a new file version by updating `asOf` and the affected rows; summaries record the `pricingVersion` they used,
so older sessions remain comparable.
