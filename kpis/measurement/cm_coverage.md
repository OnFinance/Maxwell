---
kpiId: cm_coverage
methodVersion: 1.0.0
updatedAt: "2026-09-13"
owner:
  type: human
  id: maxwell-maintainers
inputs: [soc-ledger, change-management]
status: active
---
# Change management: coverage

**Definition.** How much of the applicable control surface and asset surface Maxwell actually assessed in the
period. Two ratios, reported as separate datapoints with `dimensions.scope`:

- **Control coverage** = controls with at least one `observation` whose `collectedAt` is in the period
  ÷ applicable controls (control records whose `implementationStatus` is not `not-applicable`, latest record per
  control id wins).
- **Asset coverage** = (application, environment) pairs referenced by an observation `subjects[]` in the period
  ÷ all (application, environment) pairs defined under `applications/*/env/`.

A third datapoint, **finding-to-initiative coverage** = open findings with severity ≥ high that are linked to an
initiative (`initiativeId` set) ÷ open findings with severity ≥ high, measures whether findings are being turned
into change work.

**Formula notes.** The ledger is append-only, so "latest record per id" is the last line with that `id` or a
later line whose `supersedes` points at it. Observations count once per control id listed in `controlIds`.

**Dimensions.** `companyId`, `workflow` (from `observation.methods`), `appId`, `envId`.

**Source.** `company-profile/<c>/soc/main.jsonl`, `applications/*/env/*.json`, `change_management/master.json`.
