---
kpiId: cm_actionability
methodVersion: 1.0.0
updatedAt: "2026-09-13"
owner:
  type: human
  id: maxwell-maintainers
inputs: [change-management]
status: active
---
# Change management: actionability

**Definition.** The share of initiatives created in the period that a human could start executing without
asking a question. Ratio 0–1, higher is better.

**Actionable initiative test (all must hold).**
1. `master.json` entry has an `owner` and a `dueAt`.
2. At least one task file exists under `initiatives/<id>/tasks/`.
3. Every task has non-empty `acceptanceCriteria`, a `verificationMethod`, and a `rootCause`.
4. The initiative cites at least one `regulatoryRef` and at least one `findingId` or `controlId`.
5. Every task has an `owner`.

**Formula.** `cm_actionability = actionable initiatives / initiatives with createdAt in period`.

**Dimensions.** `companyId`, `severity`, `sourceWorkflow`. A per-criterion breakdown (which test failed most)
is recorded in the datapoint `notes` so the failing rubric item can be fixed in the planner agent.

**Source.** `company-profile/<c>/change_management/master.json` and `initiatives/*/tasks/task_*.json`. No harness
data is involved; the KPI is deterministic over the workspace state.
