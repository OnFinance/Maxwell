---
kpiId: cm_time_to_implementation
methodVersion: 1.0.0
updatedAt: "2026-09-13"
owner:
  type: human
  id: maxwell-maintainers
inputs: [change-management, soc-ledger]
status: active
---
# Change management: time to implementation

**Definition.** Elapsed time from an initiative's creation to its closure, and whether closure happened inside
the regulatory SLA. Reported in days (median and p90) plus an SLA compliance ratio. Lower days and higher
compliance are better.

**Formulae.**
```
ttl(initiative) = closedAt − createdAt               (initiatives with status closed, closedAt in period)
cm_time_to_implementation.median = median(ttl)        cm_time_to_implementation.p90 = p90(ttl)
sla_compliance = initiatives closed with closedAt ≤ dueAt / initiatives closed
overdue_open   = open initiatives with dueAt < now   (reported as a count datapoint)
```
`dueAt` is set by the planner from `slaBasis` (instrument + control + days) resolved through
`.claude/skills/regulatory-catalogs/references/sla-table.json`, e.g. SEBI CSCRF 7 days for high-severity patch
findings and 3 months for VAPT findings, IRDAI 30 days for critical findings, PCI DSS 4.0.1 30 days for
critical patches, CISA BOD 26-04 tiers for KEV exposure. Company overrides live in `details.json.riskAppetite`.

**Also derived (DORA-style).** Lead time for change of the linked suggestions: `mergedAt − createdAt` of
suggestions in `merged` state, to compare the agent's own change velocity with the human initiative velocity.

**Dimensions.** `companyId`, `severity`, `changeType` (standard/normal/emergency), `sourceWorkflow`.

**Source.** `change_management/master.json` (createdAt, dueAt, closedAt, status, severity, slaBasis),
`initiatives/*/timeline.json` (used to validate closedAt against the `closed` event), `suggestions/master.json`.
