---
name: ocsf-findings
description: How Maxwell's runtime probes (runtime-probe-appcontainers, -devtest-env, -qa-env, -prod-env, -harnesses, -sandboxes, -datapipeline, -network-perimeter, -identity-access) emit OCSF 1.9 Findings events - Compliance Finding (2003) for control checks, Vulnerability Finding (2002) for CVEs on running workloads, Detection Finding (2004) for suspicious activity seen in logs and Incident Finding (2005) for confirmed incidents - with the required attributes, severity_id and status_id mappings, finding_info.uid as the Maxwell fingerprint, redacted evidences, remediation, the per-agent export path kpis/data/raw/sessions/<sessionId>/<workflow>.<agent>.ocsf.export.json (none on dry runs) and the conversion of each class into soc ledger observations, findings and incidents. Load before writing any runtime probe output and before converting an *.ocsf.export.json into ledger records.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; probes obey runtime-probe-rules-of-engagement (read-only, credential locators only); no OCSF library needed, events are plain JSON validated by the soc-ledger-keeper on conversion
metadata:
  author: OnFinance
  version: "1.0.0"
  ocsfVersion: "1.9.0"
  ocsfSchema: https://schema.ocsf.io/1.9.0
allowed-tools: Read Grep Glob Write Bash(node .claude/scripts/*) Bash(node -e *) Bash(sha256sum *) Bash(jq *) Bash(date *)
when_to_use: Whenever a workflow name starts with runtime-probe- and probe output must be recorded, when a *-prober agent returns candidate observations or findings, and when refresh-soc or report-audit-findings reads an OCSF export
user-invocable: false
x-maxwell:
  kind: capability
  workflows: [runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, refresh-soc, report-audit-findings]
---
# OCSF findings

Runtime probes look at live systems, so their evidence is an event, not a file location: Maxwell records it as
OCSF 1.9 Findings-category events (`category_uid: 2`) and converts them into ledger records. Static probes use
SARIF instead (`sarif-findings`). Read `runtime-probe-rules-of-engagement` before producing anything here and
`soc-ledger` for the ledger side.

## 1. Which class

| class_uid | Class | Use for | Becomes |
| --- | --- | --- | --- |
| 2003 | Compliance Finding | one control check against one resource: pod runs as root, MFA off for a console user, log group retention < 180 d, security group open to 0.0.0.0/0 | observation (always) + finding when `compliance.status_id` is Fail |
| 2002 | Vulnerability Finding | a CVE present in a running image or host package (ECR/Artifact Registry scan, trivy image, grype) | finding with `cvss`, `cveIds`, plus a `cve-enrichment` record |
| 2004 | Detection Finding | activity seen in logs or telemetry during the probe window: WAF hits, impossible-travel logins, unexpected egress from a sandbox | observation; finding when `confidence_id` is 3 High and the activity was not blocked (`disposition_id` not 2 Blocked); incident candidate when `is_alert` and the company confirms |
| 2005 | Incident Finding | a confirmed incident with an owner, usually mirrored from PagerDuty or the SIEM | incident record with regulator clocks |

Never use 2006 Data Security or 2007 Application Security Posture; `source.ocsfClassUid` in the ledger accepts
them but no Maxwell workflow produces them and reports ignore them.

## 2. Attributes every event carries

```json
{ "category_uid": 2, "class_uid": 2003, "activity_id": 1, "type_uid": 200301,
  "time": 1789286400000, "severity_id": 4, "status_id": 1,
  "metadata": { "version": "1.9.0", "uid": "8f3b1c2a-4d5e-4f60-9a7b-1c2d3e4f5a6b:000017", "logged_time": 1789286460000,
    "product": { "name": "maxwell-container-prober", "vendor_name": "OnFinance", "version": "1.0.0" },
    "labels": [ "workflow:runtime-probe-prod-env", "run:run_01J7Q3V8K2M4N6P8R0S2T4V702", "company:kalpataru-securities" ] },
  "finding_info": { "uid": "c5d3...64 hex (the Maxwell fingerprint)", "title": "Pod trading-api-7d9f runs as root in prod-mumbai",
    "desc": "securityContext.runAsNonRoot is unset and the image USER is root",
    "analytic": { "type_id": 1, "type": "Rule", "name": "k8s-pod-runs-as-root", "uid": "k8s-pod-runs-as-root", "version": "1" },
    "created_time": 1789286400000, "first_seen_time": 1789286400000, "last_seen_time": 1789286400000,
    "data_sources": [ "kubectl get pod -n trading -o json" ], "types": [ "container-hardening" ] },
  "message": "runAsNonRoot unset on 3 of 3 replicas", "observables": [ { "name": "resources[0].uid", "type_id": 10, "value": "environment:trading-api/prod-mumbai" } ] }
```

- `activity_id`: 1 Create (first time this probe saw it), 2 Update (seen again), 3 Close (checked and gone).
  `type_uid = class_uid * 100 + activity_id`.
- `time` and every `*_time` are epoch milliseconds UTC; convert with `Date.parse(...)` and back with
  `new Date(ms).toISOString()`; the ledger wants RFC 3339 `Z` strings.
- `metadata.uid` is `<sessionId>:<6-digit sequence>` so events are unique per session; `metadata.labels` carry
  `workflow:`, `run:` and `company:` so the export is attributable without opening the ledger.
- `metadata.product.name` is `maxwell-<agent>`; a scanner's own OCSF (AWS Security Hub, Wiz, Prisma) keeps its
  product block and you add the labels.
- `finding_info.analytic.name` is the rule id (stable kebab-case, reused across runs; CVE id for 2002);
  `finding_info.uid` is the Maxwell fingerprint (section 4).
- `status_id` (base Finding): 0 Unknown, 1 New, 2 In Progress, 3 Suppressed, 4 Resolved, 5 Archived, 99 Other;
  probes emit 1 (or 4 with `activity_id: 3` when a previously exported fingerprint is now absent) and never 0,
  3 or 5.

### Class-specific blocks

**2003 Compliance Finding** adds `compliance` and `resources[]`:
`compliance: {control: "PR.AA.S2", standards: ["SEBI CSCRF 2024", "CIS Kubernetes Benchmark 1.9"], requirements:
["sebi-cscrf-2024:PR.AA.S2"], status: "Fail", status_id: 3, checks: [{name, uid, status_id, desc}]}` with
`status_id` 1 Pass, 2 Warning, 3 Fail, 0 Unknown, 99 Other (with `status: "Not Applicable"` when the control does
not bind the resource). `resources[]`: `{uid: "<assetRef key>",
name, type: "pod|node|iam-user|security-group|log-group|bucket|function|queue|sandbox", cloud_partition,
region: "ap-south-1", namespace, labels, owner}` where `uid` is the ledger `targetKey`
(`environment:<appId>/<envId>`, `image:<appId>/<imageId>`) and `name` the live object name.

**2002 Vulnerability Finding** adds `vulnerabilities[]` and `resources[]` (same shape as 2003; the singular
`resource` is deprecated since OCSF 1.1, do not emit it):
`{cve: {uid: "CVE-2024-5535", cvss: [{version: "3.1", base_score: 9.1, vector_string: "CVSS:3.1/..."}],
epss: {score: 0.0431, percentile: 0.9152, created_time}, created_time, modified_time}, title, desc, severity,
is_exploit_available (KEV), is_fix_available, affected_packages: [{name, version, purl,
fixed_in_version, path}], first_seen_time, last_seen_time, remediation: {desc, references: []}}`. One event per
(CVE, image), not per package instance.

**2004 Detection Finding** adds `evidences[]`, `attacks[]`, `confidence_id` (1 Low 2 Medium 3 High),
`disposition_id` (1 Allowed, 2 Blocked, 3 Quarantined, 15 Detected, 16 No Action, 17 Logged; the full list is in
the OCSF 1.9 dictionary, use 99 Other with a `disposition` text when unsure), `impact_id`, `risk_level_id`, `is_alert`. `evidences[]` entries are typed
(`process`, `actor`, `api`, `connection_info`, `src_endpoint`, `dst_endpoint`, `file`, `container`, `query`)
and **redacted**: ip addresses of customers, tokens, session ids and personal data replaced by
`[REDACTED:<class>]` (the classes and rules in `runtime-probe-rules-of-engagement` section 6) and the raw line
kept only as a sha256 of the redacted output in `evidences[].data.sha256`. `attacks[]` carry
`{technique: {uid: "T1078", name}, tactic: {uid, name}, version: "16.1"}` (ATLAS ids for agent harnesses).

**2005 Incident Finding** adds `finding_info_list[]` (the 2003/2004 events it aggregates), `assignee`,
`priority_id` (1 Low 2 Medium 3 High 4 Critical), `verdict_id` (1 False Positive 2 True Positive 3 Disregard
4 Suspicious 5 Benign 6 Test 7 Insufficient Data 8 Security Risk 9 Managed Externally 10 Duplicate),
`status_id` (1 New 2 In Progress 3 On Hold 4 Resolved 5 Closed), `ticket: {uid, src_url, type}`,
`src_url` (PagerDuty or SIEM link), `attacks[]`, `impact`.

## 3. Severity and status mappings

| `severity_id` | OCSF | Maxwell `severity` |
| --- | --- | --- |
| 6, 5 | Fatal, Critical | `critical` |
| 4 | High | `high` |
| 3 | Medium | `medium` |
| 2 | Low | `low` |
| 1 | Informational | `info` |
| 0, 99 | Unknown, Other | catalog `defaultSeverity` of the most specific control; when none resolves, no finding (an `inconclusive` observation); never `info` by default |

This is the `maxwell-conventions` section 4 rule seen from OCSF: a CVSS score first, then the catalog
`defaultSeverity`, and `severity_id` itself only when no catalog control resolves.

Set `severity_id` from evidence, not the reverse: for 2002 from the CVSS score (9.0+ 5, 7.0 4, 4.0 3, 0.1 2, 0
1) then KEV/EPSS uplift per `cve-enrichment`; for 2003 from the catalog `defaultSeverity` of the control checked
(`critical` 5, `high` 4 ...); for 2004 from `risk_level_id` (4 Critical 5, 3 High 4, 2 Medium 3, 1 Low 2, 0 Info 1);
for 2005 from the company's incident classification.

| Compliance `status_id` | Observation `result` | Finding |
| --- | --- | --- |
| 1 Pass | `satisfied` | none |
| 2 Warning | `partial` | yes, when the catalog control is mandatory |
| 3 Fail | `not-satisfied` | yes |
| 99 Other, `status: "Not Applicable"` | `not-applicable` (say why in `description`) | none |
| 0 Unknown | `inconclusive` (access denied, timeout, abort) | none; add a task request per the rules of engagement. Dry runs emit no event at all |

## 4. finding_info.uid is the fingerprint

`fingerprint = sha256(ruleId + "|" + targetKey + "|" + normalisedLocation)` (soc-ledger section 6) with
`ruleId = finding_info.analytic.name`, `targetKey = resources[0].uid` and
`normalisedLocation` = the stable object path inside the environment: `namespace/kind/name` for Kubernetes
(`trading/deployment/trading-api`), the ARN or resource id for cloud objects (`arn:aws:iam::123456789012:user/
ops-console`), the package path or versionless purl for 2002 (`pkg:deb/debian/libssl3`), the log source name for
2004 (`waf/alb-prod-mumbai`). Never include pod hashes, timestamps, replica indexes or IPs: the fingerprint must
survive a rollout. Write it in `finding_info.uid` and, on conversion, copy it verbatim into `finding.fingerprint`
so an export line and a ledger line join by string equality.

## 5. Where the export lives

The export path is exactly the one the workflow prompt passes. By default, and in every shipped
`runtime-probe-*` workflow, it is the `runtime-probe-rules-of-engagement` section 5 path
`kpis/data/raw/sessions/<sessionId>/<workflow>.<agent>.ocsf.export.json` (e.g.
`kpis/data/raw/sessions/8f3b1c2a-4d5e-4f60-9a7b-1c2d3e4f5a6b/runtime-probe-prod-env.container-prober.ocsf.export.json`).
The file is a JSON array of events in emission order, **one file per agent per workflow per session**: when it
already exists (a second environment or application in the same session, a resumed turn) read it, append the
new events keeping `metadata.uid` sequences unique, and write it back; never start a second file for the same
agent and workflow in that session, and never write into another session's file. Compute `sha256sum` after the
last write of the run and carry that value in every observation `toolOutput: {format: "ocsf", path, sha256}`
and every finding's `evidence[] {type: "ocsf", ref: path, sha256}` (so write ledger records only once the
export is final). Raw command output is not stored: it is redacted, hashed into `evidences[].data.sha256` and
summarised in `evidenceRef.description` (rules of engagement, evidence capture).

**Dry runs** (`args.dryRun: true`) execute no command, emit no events, write no export file and set no
`toolOutput`: the plan is recorded only as `inconclusive` observations whose `description` starts with
`DRY RUN:` (rules of engagement section 4).

## 6. Converting to ledger records

| OCSF | Ledger field | Rule |
| --- | --- | --- |
| `finding_info.title` / `desc` + `message` | `title` / `description` | title names the asset and the weakness; description adds the command family used and what was seen |
| `severity_id` | `severity` | table in section 3 |
| `finding_info.analytic.name` | `source.ruleId` | `source: {kind: "ocsf", ocsfClassUid: <class_uid>, ruleId, tool: metadata.product.name, toolVersion}` |
| `finding_info.uid` | `fingerprint` | verbatim |
| `resources[0].uid` | `target` | parse the targetKey back into an `assetRef` (`environment` needs `appId` + `envId`) |
| normalisedLocation | `location.path` | the same string used in the fingerprint; no `startLine` |
| `compliance.requirements[]` | `controlIds` | `<instrumentId>:<controlId>`; the control record must exist |
| `compliance.standards[]` + catalog `mappings` | `regulatoryRefs` | Indian instrument first; for 2002 always add `sebi-cscrf-2024`/`rbi-cyber-tech-directions-2026` patch-management controls as the workflow prompt names them |
| `vulnerabilities[].cve` | `cvss`, `cveIds` | `cvss: {version, vector, score}` (3.0, 3.1 or 4.0; never a 2.0 vector), `cveIds: [cve.uid]`; write `cves/data/<id>.json` via `cve-enrichment` and set the asset's VEX statement |
| `attacks[].technique.uid` | (risk) `threatIds` | when a risk is raised over several detections |
| `confidence_id` | `confidence` | 3 `confirmed`, 2 `likely`, 1 `possible`, absent `unverified` |
| `first_seen_time` / `last_seen_time` | `firstSeenAt` / `lastSeenAt` | ms to RFC 3339; on a fingerprint match keep the ledger `firstSeenAt` |
| `activity_id: 3` / `status_id: 4` | absence | counts as one absence for the resolved-when-absent-twice rule; never write `resolved` from a single probe |
| `remediation.desc` | `description` tail and the initiative task | never a separate file |

Order of writes is the `soc-ledger` order: observations (one per control per subject, `methods: [<workflow>]`,
`subjects` = the environment probed, `toolOutput` pointing at the export), then findings
(`relatedObservationIds`), then risks, then controls, then incidents. `slaDueAt`/`slaBasis` come from the
sla-table exactly as for SARIF findings; the `patch-sla` topic applies to 2002 and to 2003 gaps with a fix,
`mfa`, `log-retention`, `encryption`, `access-review` topics to the matching 2003 rules.

### 2005 to an incident record

`title`/`description` from the event; `severity` from `severity_id`; `status` from `status_id` (1 `detected`, 2
`triaged` or `contained` when `containedAt` is known, 4 `recovered`, 5 `closed`; `verdict_id` 1 ->
`false-positive`); `category` from the CERT-In Annex I list (`unauthorised-access`, `ddos`, `malware`,
`data-breach`, ...); `dedupKey` = the PagerDuty `incident_key` when the event came from PagerDuty, otherwise
`maxwell:<controlId lower-cased>:<assetId>:<first 16 hex of the finding fingerprint>`; `detectedAt` = the
earliest `first_seen_time` in `finding_info_list`; `regulatorReportRefs[]` one per regulator with
`deadlineHours` copied from the sla-table (`incident-reporting` 6 h CERT-In/SEBI/RBI, `breach-notification` 72
h DPDP when `affectedDataClassifications` includes `pii` or `spdi`); `relatedFindingIds` = the converted 2002/
2003/2004 events; `externalRefs.pagerdutyId` and `ticket` from `ticket`/`src_url`. A 2004 event alone never
becomes an incident; it needs a 2005 or a human confirmation recorded as a `manual` observation.

## 7. Worked example

`iam-prober` runs `runtime-probe-identity-access` for `kalpataru-securities` (a SEBI-registered stock broker,
so SEBI CSCRF applies) on `environment:trading-api/prod-mumbai`, AWS account `123456789012` in `ap-south-1`.
`aws iam get-account-summary` only returns account-level counts (`AccountMFAEnabled`, `Users`), so per-user MFA
state comes from the credential report: `aws iam generate-credential-report`, then `aws iam
get-credential-report --query Content --output text | base64 -d`, reading the `user`, `arn`,
`password_enabled` and `mfa_active` columns. Four rows have `password_enabled: true` and `mfa_active: false`,
one of them `arn:aws:iam::123456789012:user/ops-console`.

Emit one 2003 event per user (one control check against one resource): `analytic.name
iam-console-user-no-mfa`, `compliance: {control: "PR.AA.S7", standards: ["SEBI CSCRF 2024"], requirements:
["sebi-cscrf-2024:PR.AA.S7"], status: "Fail", status_id: 3}` (MFA on critical systems; its catalog
`probeWorkflows` include `runtime-probe-identity-access`), `resources[0]: {uid:
"environment:trading-api/prod-mumbai", type: "iam-user", name: "ops-console", region: "ap-south-1"}`,
`severity_id: 4` (catalog `defaultSeverity: high` of `PR.AA.S7`), `finding_info.uid =
sha256("iam-console-user-no-mfa|environment:trading-api/prod-mumbai|arn:aws:iam::123456789012:user/ops-console")`,
`evidences: [{api: {operation: "GetCredentialReport", service: {name: "iam"}}, data: {sha256: "<sha256 of the
redacted report>"}}]`. A root-account finding would use `arn:aws:iam::123456789012:root` as the location.

Convert: one observation `result: not-satisfied` on `sebi-cscrf-2024:PR.AA.S7` with `subjects` = the
environment and `toolOutput` = the export; four findings, each `severity: high`, `source: {kind: ocsf,
ocsfClassUid: 2003, ruleId: iam-console-user-no-mfa, tool: maxwell-iam-prober, toolVersion: "1.0.0"}`,
`location.path` = the user ARN, `fingerprint` = that event's `finding_info.uid`, `regulatoryRefs: [{SEBI,
sebi-cscrf-2024, PR.AA.S7}, {NIST, nist-csf-2.0, PR.AA-03}, {CIS, cis-controls-8.1, 6.3}]`, `slaBasis` from
the `mfa` topic row for `sebi-cscrf-2024` at `high`, or the sla-table `defaults[high]` with `slaBasis:
{instrument: sebi-cscrf-2024, days}` when no `mfa` row matches, `slaDueAt = firstSeenAt + slaBasis.days`,
`evidence: [{type: ocsf, ref: <export>, sha256}]`. For an RBI-regulated bank the same check cites the RBI
Directions MFA clause id taken from the RBI catalog (no `rbi-cyber-tech-directions-2026` catalog is loaded yet;
never reuse a SEBI id under the RBI instrument) and that control's `defaultSeverity`.

## 8. Common mistakes

- Emitting 2002/2003 events for a subject the credentials could not reach (that is a 2003 with `status_id: 0`
  and an `inconclusive` observation, plus a task request), or writing a finding from an `inconclusive` result.
- Fingerprints built from pod names, ARNs with session suffixes, timestamps or IPs.
- `severity_id: 0` left in place, or severity copied from a scanner without the catalog floor.
- `evidences[]` containing unredacted log lines, customer identifiers, credentials or full command output.
- Events with seconds instead of milliseconds in `time` (a 1970 date on conversion is the symptom).
- Storing the export anywhere but `kpis/data/raw/sessions/`, or reusing an export path across sessions.
- Turning a single 2004 detection into an incident, or an incident into a finding.
- `source.kind: "runtime-probe"` for events that have an OCSF export: use `ocsf` with `ocsfClassUid`;
  `runtime-probe` is for candidate findings a prober returns without any export (a dry run returns none).
