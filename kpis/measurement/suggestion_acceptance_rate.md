---
kpiId: suggestion_acceptance_rate
methodVersion: 1.0.0
updatedAt: "2026-09-13"
owner:
  type: human
  id: maxwell-maintainers
inputs: [suggestions, git]
status: active
---
# Acceptance rate of auto-improvement suggestions

**Definition.** Of the code-change suggestions Maxwell surfaced to humans, the share that were accepted. Ratio
0–1, higher is better. Follows the GitHub Copilot convention: partial acceptance counts as acceptance and
suggestion size is not weighted; the team rate is the mean of per-reviewer rates when `decidedBy` is present,
otherwise the pooled ratio.

**Lifecycle used.** `proposed → surfaced → (accepted | rejected) → merged → (reverted)`, plus `superseded`
and `expired` (surfaced but never decided within 30 days; counted as not accepted).

**Formulae.**
```
acceptance_rate = |accepted ∪ merged ∪ reverted| / |accepted ∪ merged ∪ reverted ∪ rejected ∪ expired|
merge_rate      = |merged ∪ reverted| / |accepted ∪ merged ∪ reverted|
revert_rate     = |reverted within 30 days of mergedAt| / |merged ∪ reverted|
retention_30d   = |merged with retentionCheckedAt ≥ mergedAt+30d and retained = true| / |merged checked|
```
Decisions are dated by `decidedAt` (period assignment uses `surfacedAt`).

**Retention check.** `retained` is set by the `impl-auto-improvement` workflow on later runs by checking that
the diff's hunks still apply cleanly (or are present) at the target repo's current pinned commit; a revert is
detected through `prUrls` state or a missing hunk. Copilot's published ~88% retention is the comparison baseline.

**Dimensions.** `companyId`, `category`, `severity`, `appId`, `repoId`, `sourceWorkflow`, `decidedBy`.

**Source.** `company-profile/<c>/suggestions/master.json`; git state of `applications/<app>/repos/<repo>/`
checkouts when available.
