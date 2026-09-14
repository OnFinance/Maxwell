---
name: soc-ledger
description: The append-only protocol for company-profile/<company_id>/soc/main.jsonl - the five record kinds and when to use each, superseding instead of editing, the finding fingerprint (sha256 over ruleId|target|normalised location), SLA due dates from the sla-table, observation results, linking findings to risks, initiatives and incidents, the append.mjs and version.mjs helpers, reading the latest state (last record per id) and the refresh-soc reconciliation rules (re-runs update by fingerprint, resolved when absent twice). Load before writing any line to the ledger or producing a versions/commit_<n>.diff.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; helpers in .claude/scripts/soc; needs .claude/skills/regulatory-catalogs/references/sla-table.json and the catalogs for SLA and control lookups
metadata:
  author: OnFinance
  version: 1.0.0
  schema: .claude/schemas/v1/soc/record.schema.json
allowed-tools: Read Grep Bash(node .claude/scripts/soc/*) Bash(node .claude/scripts/validate-data.mjs *) Bash(node -e *)
when_to_use: Whenever a workflow records a control, observation, finding, risk or incident, reconciles a re-run against earlier findings, or closes a refresh with a version diff
user-invocable: false
x-maxwell:
  kind: convention
  workflows: [refresh-soc, refresh-ctx, refresh-vendor-ctx, probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env, runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, impl-change-management, report-audit-findings, report-audit-improvements]
---
# State-of-controls ledger

`company-profile/<company_id>/soc/main.jsonl` is the single source of truth for what the company's controls
look like today and everything Maxwell has seen about them. One JSON object per line, validated against
`v1/soc/record.schema.json` (OSCAL 1.1.3 assessment-results vocabulary). Lines are never edited or deleted.
Read `maxwell-conventions` first for ids, timestamps, provenance and severity.

## 1. Record kinds

| kind | id | Use it for | Never for |
| --- | --- | --- | --- |
| `control` | `<instrumentId>:<controlId>` | the company's current implementation of one catalog control: `implementationStatus`, `effectiveness`, owner, parameters, `nextDueAt` | anything you observed (that is an observation) |
| `observation` | `obs_` ULID | what a probe, interview or document review saw, with `methods`, `subjects`, `result`, `evidence`, `toolOutput` | gaps with a severity (that is a finding) |
| `finding` | `fnd_` ULID | one gap against one target with severity, SLA, lifecycle status and a stable `fingerprint` | events in time (incident) or hypotheticals (risk) |
| `risk` | `rsk_` ULID | a potential loss event ("Because X, Y may occur, causing Z") rated by likelihood and impact, treated by initiatives | a concrete defect (finding) |
| `incident` | `inc_` ULID | something that happened, with response timestamps and regulator clocks (CERT-In/SEBI/RBI 6 h, DPDP 72 h) | a scanner hit nobody has confirmed |

Ratios that indicate a healthy ledger: one observation per probe run per subject, findings only for
`result: not-satisfied | partial` observations, one control record per applicable catalog control, few risks
(they aggregate findings), incidents only from confirmed events, PagerDuty or humans.

## 2. Append, never edit: superseding

- New identity: new id, no `supersedes`.
- Same identity, newer state (control re-assessed, finding status change, risk re-rated, incident progressed):
  append a full record with the **same id** and `supersedes: <same id>`. `append.mjs` refuses a duplicate id
  without `supersedes` and refuses `supersedes` pointing at an id that does not exist.
- Observation refreshed: new `obs_` id with `supersedes: <old obs id>`; `expiresAt` of the old one is moot.
- Legitimately repeating observations (same id re-appended by a scheduled job) need `--allow-duplicate-id`.
- The latest state of any id is its **last line**. Everything earlier is history and must stay readable.

```bash
node .claude/scripts/soc/append.mjs <company_id> record.json     # validate + append atomically
cat record.json | node .claude/scripts/soc/append.mjs <company_id> -
node .claude/scripts/soc/version.mjs <company_id> --session <sid> --workflow <name>   # end of a refresh
```

`version.mjs` writes `soc/versions/commit_<n>.diff` with `# maxwell-soc-*` headers and one `+` line per new
record; it verifies the previous prefix hash and refuses if the ledger was rewritten (`--force` only after a
human investigated). Run it once at the end of a workflow, not after every append.

## 3. Reading the latest state

```bash
node -e "const L={};for(const l of require('fs').readFileSync(process.argv[1],'utf8').split('\n'))if(l.trim()){const r=JSON.parse(l);L[r.id]=r}const K=process.argv[2];console.log(JSON.stringify(Object.values(L).filter(r=>!K||r.kind===K),null,1))" company-profile/<company_id>/soc/main.jsonl finding
```

Derived views you will need: open findings (`status` in `open|triaged|remediating`), findings by
`fingerprint`, controls by id, latest observation per `(methods, subjects)`, incidents with a pending
`regulatorReportRefs[].submittedAt`. Never keep a private index file; recompute from the ledger.

## 4. Controls

One control record per catalog control that applies to the company: intersect
`details.frameworksInScope` with each catalog's `applicability` (entityTypes, reCategories against
`regulatoryRegistrations[].category`). `frameworkRefs[0]` is the control itself (its instrument and id form the
record id); `frameworkRefs[1..]` are the catalog `mappings`. `title` is the catalog title, `statement` is the
company's own implementation, `parameters[].name` must be one of the catalog `params[].id`.

Derive, do not guess: `effectiveness` from the latest observation `result` (`satisfied` effective,
`partial` partially-effective, `not-satisfied` ineffective, none or `inconclusive` not-tested);
`lastAssessedAt` = that observation's `collectedAt`; `nextDueAt` = `lastAssessedAt` + catalog `cadence`
(`daily` 1 d, `weekly` 7 d, `monthly` 30 d, `quarterly` 91 d, `half-yearly` 182 d, `annual` 365 d, `biennial`
730 d, `continuous`/`event-driven` = next scheduled run of the probing workflow);
`implementationStatus` moves only on evidence or a human note.

## 5. Observations

Required: `controlIds` (existing control records), `title`, `methods` (the workflow name, or `manual`,
`interview`, `document-review`), `collectedAt`, `result`. Set `subjects` to the assets examined,
`expiresAt` to `collectedAt` + the control cadence (section 4 day counts), except that runtime probes use the
`runtime-probe-rules-of-engagement` defaults (`collectedAt` + 30 d for prod, + 90 d otherwise) whenever those are
shorter than the cadence (the earlier date wins), `evidence[]` to workspace files, URLs or command output,
and `toolOutput` when a scanner or prober wrote an export: `{format: sarif|ocsf|text, path, sha256}` where `path`
is the export path the workflow prompt passed, under `kpis/data/raw/sessions/<segment>/<name>.export.json`
(runtime probes: `kpis/data/raw/sessions/<sessionId>/<workflow>.<agent>.ocsf.export.json`; see `sarif-findings`,
`ocsf-findings`). Dry-run observations have no `toolOutput`.
`result` meanings: `satisfied` (no gap), `partial` (works for some subjects), `not-satisfied` (gap),
`not-applicable` (control does not bind this subject; say why), `inconclusive` (no access or evidence;
never turn this into a finding). Observations never carry severity.

## 6. Findings

Required: `title`, `severity`, `regulatoryRefs` (Indian instrument first), `target` (assetRef; `company` for
company-wide), `fingerprint`, `source`, `status`, `firstSeenAt`, `lastSeenAt`. Always add `controlIds`,
`relatedObservationIds`, `evidence`, `confidence`, and `cvss`/`cveIds` for vulnerabilities.

### Fingerprint
`fingerprint = sha256(ruleId + "|" + targetKey + "|" + normalisedLocation)` where

- `ruleId` is `source.ruleId`: the scanner rule id copied verbatim from the tool (`CVE-2021-23337`, `javascript.express.security.audit.xss.direct-response-write.direct-response-write` from semgrep), the OCSF `finding_info.analytic.name`, or for `agent-analysis`, `runtime-probe` and `manual` sources a stable kebab-case rule you choose once and reuse (`helm-privileged-container`, `iam-no-mfa-console-user`). It is required in practice: without it re-runs cannot match.
- `targetKey` is `type:ids` with ids joined by `/` in schema order: `company:<companyId>`, `application:<appId>`, `environment:<appId>/<envId>`, `repo:<appId>/<repoId>`, `image:<appId>/<imageId>`, `vendor:<vendorId>`.
- `normalisedLocation` is `location.path` with a leading `./` removed, backslashes turned into `/`, duplicate and trailing slashes collapsed, **no line numbers** (lines move; the finding does not). Empty string when there is no location. Image findings use the package manifest or file path inside the image, not the digest.

```bash
node -e "const [r,t,l]=process.argv.slice(1);console.log(require('crypto').createHash('sha256').update(r+'|'+t+'|'+l).digest('hex'))" CVE-2021-23337 image:trading-api/batch-settlement package-lock.json
```

Same fingerprint = same finding: append a supersession, never a second `fnd_` id. When a scanner supplies
`partialFingerprints`, keep them in the export for traceability but compute the Maxwell fingerprint as above
so the same rule on the same file keeps one identity when lines move or a tool changes its hashing.

### Severity and SLA
`severity`: apply the single finding-severity rule in `maxwell-conventions` section 4 (CVSS or
`security-severity` score first, with KEV and EPSS per `cve-enrichment`; otherwise the catalog `defaultSeverity`
of the most specific control cited; the scanner level only when no catalog control resolves). Then look up the SLA:

1. Collect the instruments in `details.frameworksInScope` plus the ones in `regulatoryRefs`.
2. Pick the topic: `patch-sla` for vulnerabilities and misconfigurations with a fix, otherwise the `hardRequirements[].topic` of the cited instrument in `regulatory-catalogs/references/instruments.json` whose requirement the control implements (`mfa`, `log-retention`, `encryption`, `sbom` ...), else no topic (defaults apply).
3. In `sla-table.json` select rows where `instrument` is in the set, `topic` matches and `severity` equals the finding severity or is `any`. Under `most-strict-wins` take the smallest `days`; under `company-override` first replace `patch-sla` days and the defaults with `sdlc/policy.json dependencyPolicy.vulnerabilitySlaDays[severity]` when set. Catalog `slaDays` on the control itself, when present, is one more candidate row.
4. No row: `defaults[severity]` with `slaBasis: {instrument: <most specific cited>, days}`.
5. `slaDueAt = firstSeenAt + days` (KEV `dueDate` is a ceiling if earlier). Copy the chosen row into `slaBasis` verbatim (`instrument`, `controlId`, `topic`, `severity`, `days`).

### Status
`open` at creation; `triaged` once an owner or initiative exists (`initiativeId`); `remediating` when the
initiative starts; `resolved` (with `resolvedAt`) on verified fix or the absence rule below; `risk-accepted`
requires a risk record in `accepted` status and `statusReason`; `false-positive` and `duplicate` require
`statusReason` (for duplicate, name the surviving `fnd_` id). Transitions are listed in `maxwell-conventions`.

## 7. Linking findings, risks, initiatives and incidents

- finding -> observation: `relatedObservationIds` (the evidence). finding -> control: `controlIds`.
- risk -> findings: `relatedFindingIds`; risk -> treatment: `mitigations[].initiativeId`, `deadline`;
  risk -> threat: `threatIds` (ATT&CK `T1195.002`, ATLAS `AML.T0010`). Raise a risk when several findings
  share a cause or when a finding is accepted rather than fixed.
- finding -> initiative: `initiativeId` (also listed in `change_management/master.json findingIds`), and
  `suggestionIds` for proposed diffs. `impl-change-management` sets these and moves status to `triaged`.
- incident -> findings: `relatedFindingIds`; `dedupKey` for Maxwell-raised incidents is
  `maxwell:<controlId lower-cased>:<assetId>:<first 16 hex of the finding fingerprint>` so it joins PagerDuty
  `incident_key`; an incident a runtime probe itself caused uses
  `probe-side-effect:<appId>/<envId>:<runId>` instead (rules-of-engagement section 7), which never joins PagerDuty; `regulatorReportRefs[]` one per regulator with `deadlineHours` copied from the sla-table
  (`incident-reporting` 6 h for CERT-In, SEBI and RBI; `breach-notification` 72 h for DPDP when
  `affectedDataClassifications` includes `pii` or `spdi`).
- Every finding, risk and initiative cites at least one `regulatoryRef`; cite the control's `frameworkRefs`.

## 8. refresh-soc reconciliation rules

Run after every probe and at the end of `refresh-soc`. Inputs: the latest-state map (section 3), the new
observations and candidate findings from this run, and the run scope (which subjects each probe covered).

1. **Match by fingerprint.** For each candidate: if a finding with the same `fingerprint` exists,
   append a supersession with the same id: keep `firstSeenAt`, set `lastSeenAt` = this run's `collectedAt`,
   refresh `severity`, `cvss`, `evidence`, `relatedObservationIds`, `location`; keep `status` unless the rules
   below change it. Otherwise mint a new `fnd_` id with `status: open`, `firstSeenAt = lastSeenAt = collectedAt`.
2. **Reopen.** A `resolved` finding whose fingerprint reappears is superseded with `status: open` and a
   `statusReason` ("regressed in run <runId>"), `resolvedAt` removed. `false-positive`, `duplicate` and an
   unexpired `risk-accepted` keep their status and only get `lastSeenAt` refreshed; an expired risk acceptance
   (`acceptedUntil` passed) reopens both the risk and the finding.
3. **Resolved when absent twice.** A finding is absent from a run when that run covered its `target` for its
   controls and did not produce its fingerprint. Absence is derived, not stored, and is counted in **distinct
   runs, never in observations** (one run writes one observation per control per subject, so counting lines
   would resolve a finding after a single missed run). Take the observations that satisfy all of:
   `result` is not `inconclusive`; `methods` contains the finding's originating workflow
   (`provenance.workflow` of its first record); `subjects` cover the finding's `target`; `controlIds` overlap
   the finding's `controlIds`; `collectedAt > finding.lastSeenAt`. Group them by run key =
   `provenance.runId`, or `provenance.sessionId` when `runId` is absent. When there are two or more distinct run
   keys, append `status: resolved`, `resolvedAt` = the latest `collectedAt` within the second run (in
   `collectedAt` order), `statusReason: "not observed in two consecutive <workflow> runs"`. One run's absence
   changes nothing (flaky scans, partial scopes); a run whose only observations for the subject are
   `inconclusive` (including dry runs) does not count. Any run that re-produced the fingerprint already moved
   `lastSeenAt` forward (rule 1), which restarts the count.
4. **Controls follow observations.** After findings are reconciled, supersede each affected control record
   with the new `effectiveness`, `lastAssessedAt`, `nextDueAt` and `evidence`; `implementationStatus`
   changes only when the observation shows the implementation itself changed.
5. **Risks and incidents** are never auto-closed by absence; they close through their own lifecycle.
6. **Order of writes** within a run: observations, findings, risks, controls, incidents (so every
   `relatedObservationIds`, `relatedFindingIds` and `controlIds` already exists when `append.mjs` checks them).
7. Finish with `version.mjs --session <sid> --workflow <name>`, then `npm run validate`.

## 9. Common rejections

`append.mjs` enforces the schema, `companyId` equal to the directory, duplicate ids and dangling `supersedes`.
The first two bullets are ledger invariants it does **not** check across lines: verify them yourself before
appending (the refuter and `validator` agents do), because a violation is permanent in an append-only file.

- `controlIds` / `relatedObservationIds` / `relatedFindingIds` naming records not yet in this ledger; create them first.
- `recordedAt` earlier than the last line's `recordedAt`.
- `provenance.sessionId/workflow/agent` missing on harness-produced records; `supersedes` naming an id of another kind.
- `toolOutput.path` outside `kpis/data/raw/sessions/<x>/<y>.export.json`.
- `status: resolved` without `resolvedAt`; `risk-accepted` without `statusReason`; incident `contained` without
  `containedAt`; `regulatorReportRefs[].submittedAt` without `reference`.
- Missing `regulatoryRefs` on a finding or risk (regulator-first, AGENTS.md section 6).
