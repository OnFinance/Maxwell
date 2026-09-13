---
kpiId: incident_rate
methodVersion: 1.0.0
updatedAt: "2026-09-13"
owner:
  type: human
  id: maxwell-maintainers
inputs: [soc-ledger, pagerduty, change-management]
status: active
---
# Incident rate

**Definition.** Security incidents per month per application, with optional reconciliation against PagerDuty.
Lower is better. Secondary datapoints: mean time to acknowledge (MTTA), mean time to resolve (MTTR), incidents
per 1,000 changes, and regulator-reporting timeliness.

**Primary source.** `incident` records in `company-profile/<c>/soc/main.jsonl` (latest record per id). An
incident is counted in the month of `detectedAt`; severity `info` is excluded.

**Reconciliation with PagerDuty (optional).** Exports under `kpis/data/raw/pagerduty/*.json` (PagerDuty REST v2
`GET /incidents` shape). Join key: PagerDuty `incident_key` equals the Maxwell `dedupKey`
(`maxwell:{controlId}:{assetId}:{findingHash16}`), which Maxwell sets when it raises an incident and which
integrations must pass as the Events API `dedup_key`. Incidents present only in PagerDuty (in scope services)
are added to the count with `source: pagerduty` in the datapoint notes; incidents present only in Maxwell are
counted as unpaged. Reconciliation mismatches are reported, never silently merged.

**Formulae.**
```
incident_rate(app, month) = incidents(app, month)
incidents_per_1000_changes = incidents / (closed initiatives + merged suggestions) × 1000
MTTA = mean(acknowledgedAt − detectedAt)   (PagerDuty mean_seconds_to_first_ack when reconciled)
MTTR = mean(resolvedAt − detectedAt)       (PagerDuty mean_seconds_to_resolve when reconciled)
regulator_timeliness = incidents with reportedToRegulatorAt − detectedAt ≤ deadlineHours / incidents requiring a report
```
Deadlines come from `regulatorReportRefs[].deadlineHours` (CERT-In and RBI 6 hours, DPDP and NYDFS 72 hours).

**Dimensions.** `companyId`, `appId`, `envId`, `severity`, `source` (maxwell/pagerduty/both).
