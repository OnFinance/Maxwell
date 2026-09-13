---
kpiId: cost_of_audit
methodVersion: 1.0.0
updatedAt: "2026-09-13"
owner:
  type: human
  id: maxwell-maintainers
inputs: [session-jsonl, session-summary, soc-ledger]
status: active
---
# Cost of audit

**Definition.** The monetary cost of producing one audit run (a bundle of harness sessions sharing a `runId`),
computed from model token usage at list price, plus optional human review time. Reported in USD, lower is better.

**Raw data (per session).** From the Claude Code transcript (`kpis/data/raw/sessions/claude-code/<sid>.jsonl`):
every record with `type: "assistant"` contributes `message.model`, `requestId`, `isSidechain`, and
`message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation.ephemeral_5m_input_tokens,
cache_creation.ephemeral_1h_input_tokens, output_tokens_details.thinking_tokens, server_tool_use.web_search_requests}`.
The transcript's `cost-state.totalCostUSD` (and, for headless runs, the `--output-format json` `total_cost_usd`)
is kept as `costUsd.reported` for cross-checking only. From OpenCode (`opencode export`): each assistant message's
`tokens.{input, output, reasoning, cache.read, cache.write}` and `model.{providerID, id}`; OpenCode's stored
`cost` is ignored because it omits cache-read pricing.

**Deduplication.** Claude Code writes several transcript lines per streamed API response with growing
`output_tokens`. Records are grouped by `requestId` (fallback `message.id`) and only the record with the largest
total token count is kept. `dedup.duplicatesDropped` in the session summary records how many were discarded.

**Formula.**
```
cost(session) = Σ_model [ input × P_in + output × P_out + cacheWrite5m × P_cw5m + cacheWrite1h × P_cw1h
                          + cacheRead × P_cr ] / 1e6  +  webSearchRequests × P_ws / 1000
cost_of_audit(run) = Σ_sessions cost(session) [+ humanReviewHours × loadedHourlyRate]
```
Prices come from the versioned table `.claude/skills/kpi-extraction/references/pricing.json`
(`pricingVersion` is stored on every summary). Thinking tokens are already included in `output_tokens` and are
reported for information only.

**Dimensions.** `runId`, `workflow` (from the session meta), `companyId`, `model`, `harness`, and main-thread vs
subagent (`isSidechain`).

**Normalisations.** Per control observed (observations appended to the soc ledger by sessions of the run), per
finding created, per application in scope.

**Cross-check.** `costUsd.deltaPct = (computed − reported) / reported`. A delta beyond ±5% is flagged in the
datapoint notes; the computed figure is always the KPI value because it is reproducible.

**Sampling.** Governed by `kpis/metrics.json.sampling`: `all`, `bundle` (every N-th session) or `stochastic`
(rate p with a deterministic seed derived from the session id). Sampled-out sessions still get a meta file.
