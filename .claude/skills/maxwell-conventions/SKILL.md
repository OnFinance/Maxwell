---
name: maxwell-conventions
description: The practical guide to writing any Maxwell record that validates first time - slugs versus prefixed ULIDs and how to mint one, RFC 3339 Z timestamps, the provenance block, the single severity rule (CVSS score, then catalog defaultSeverity, then scanner level) and the complete 5x5 risk likelihood x impact matrix, the closed status lifecycles with their allowed transitions, the never-invent-keys rule, how to run the validators, and where the worked example of every document type lives. Load before the first write of any workflow run and whenever a validator rejects a file.
license: AGPL-3.0-only
compatibility: Node 22, the Maxwell workspace layout (.claude/schemas/layout.json) and the validators under .claude/scripts; no network access needed
metadata:
  author: OnFinance
  version: 1.0.0
  schemaFamily: v1
allowed-tools: Read Grep Bash(node .claude/scripts/*) Bash(npm run *) Bash(node -e *)
when_to_use: Before writing or editing any JSON, JSONL or frontmatter file, when minting an id, when choosing a severity or a status, and when validate-data or the write hook rejects a file
user-invocable: false
x-maxwell:
  kind: convention
  workflows: [refresh-soc, refresh-ctx, refresh-vendor-ctx, refresh-metastore, probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env, runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, impl-change-management, impl-auto-improvement, report-audit-findings, report-audit-improvements, refresh-apps]
---
# Maxwell conventions

Every file Maxwell writes is matched to a schema by `.claude/schemas/layout.json` and validated by
`node .claude/scripts/validate-data.mjs`. This skill is the short path to output that passes. The schemas are
the law; when this page and a schema disagree, the schema wins and this page has a bug.

## 1. Identifiers

| Thing | Shape | Example | Chosen by |
| --- | --- | --- | --- |
| company, app, vendor, repo, image, env | slug `^[a-z0-9][a-z0-9-]{1,62}$` | `kalpataru-securities`, `prod-mumbai` | human, from the directory / file name |
| control record | `<instrumentId>:<controlId>` | `sebi-cscrf-2024:GV.SC.S5` | catalog: `frameworkRefs[0]` |
| observation, finding, risk, incident | `obs_`, `fnd_`, `rsk_`, `inc_` + ULID | `fnd_01J7Q3V8K2M4N6P8R0S2T4V6X9` | minted per record |
| initiative, suggestion, search, run | `init_`, `sug_`, `q_`, `run_` + ULID | `init_01M0EXSEJ04P58EWQQZTMMGYWY` | minted per document |
| task, timeline event | `task_<n>`, `evt_<n>` sequential from 1 | `task_3`, `evt_12` | next integer in that initiative |
| kpi | fixed enum in `common.schema.json#/$defs/kpiId` | `cost_of_audit` | never new |

A ULID is 26 Crockford base32 characters (`0-9A-HJKMNP-TV-Z`, no I, L, O, U) whose first character is `0`-`7`.
Mint one with the shared helper or with plain Node:

```bash
node -e "import('./.claude/hooks/lib.mjs').then(m => console.log('fnd_' + m.ulid()))"
node -e "const E='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=E[t%32]+s;t=Math.floor(t/32)}for(const b of crypto.getRandomValues(new Uint8Array(16)))s+=E[b%32];console.log(s)"
```

Never type a ULID by hand, never reuse one across kinds, never derive one from a hash. The slug of a new
company or application is the directory name and must match `companyId` / `appId` inside every file under it.
Session ids are what the harness gives you (Claude Code UUID or OpenCode `ses_...`); the run id comes from
`MAXWELL_RUN_ID` and both are printed in the session-start context line (`Maxwell session <sid> (run <runId>)`).

## 2. Timestamps and dates

- `timestamp`: RFC 3339 in UTC with a trailing `Z`, no offset, no fractional seconds by convention:
  `new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')` gives `2026-09-13T08:20:00Z`.
- `date`: `YYYY-MM-DD` (KEV `dateAdded`, EPSS `date`, `lastReviewedAt`, contract dates).
- Ledger `recordedAt` is monotonically non-decreasing within `main.jsonl`; `firstSeenAt` is preserved across
  supersessions; `slaDueAt = firstSeenAt + slaBasis.days` (for incidents `detectedAt + deadlineHours`).
- `provenance.generatedAt` is when you produced the document, not when the evidence was collected
  (`collectedAt`, `lastFetchedAt`, `lastScan.at` carry that).

## 3. The provenance block

Every generated document and every ledger line carries `provenance`; KPIs are attributed through it, so a
missing field silently corrupts `cost_of_audit`, `cm_*` and `incident_rate`.

```json
{ "harness": "claude-code", "generatedAt": "2026-09-13T08:20:00Z",
  "sessionId": "8f3b1c2a-4d5e-4f60-9a7b-1c2d3e4f5a6b", "runId": "run_01J7Q3V8K2M4N6P8R0S2T4V702",
  "workflow": "probe-cicd-env", "agent": "cicd-auditor", "model": "claude-opus-5" }
```

- `harness` is `MAXWELL_HARNESS` (`claude-code` or `opencode`); `human` and `script` are for hand-edited files
  and hooks. When harness is a harness, `sessionId`, `workflow` and `agent` are required by the ledger schema.
- `workflow` is a `vocab/workflows` value; use `manual` for ad-hoc work, never a made-up name.
- `agent` is the subagent name from `.claude/agents/<name>.md` (the file name, e.g. `iac-auditor`).
- `inputsHash` (sha256 of the ordered inputs) is optional but lets `refuter` and `validator` reproduce a result.
- Human-authored reference files (`instruments.json`, `sla-table.json`, SKILL frontmatter) have no or
  `harness: human` provenance; do not add one to a frontmatter block, the schema rejects it.

## 4. Severity

`critical | high | medium | low | info`, in that order of precedence. Derive, never estimate.

**Findings: one rule, applied in this order** (the `finding.severity` description in `v1/soc/record.schema.json`;
`sarif-findings`, `ocsf-findings`, `soc-ledger` and `cve-enrichment` all refer here):

1. **Score first.** A CVSS 3.x / 4.0 base score (`finding.cvss.score`, SARIF rule `properties.security-severity`,
   OCSF `vulnerabilities[].cve.cvss[].base_score`) maps as 9.0-10.0 `critical`, 7.0-8.9 `high`, 4.0-6.9
   `medium`, 0.1-3.9 `low`, 0.0 `info`. Vulnerabilities then take the KEV floor and EPSS uplift from
   `cve-enrichment` section 5 (KEV listed: at least `high`; `critical` when any affected asset is, or runs in, an
   environment with `exposure: internet` or `partner`).
2. **Otherwise the catalog.** The `defaultSeverity` of the most specific control cited (the control of the most
   specific Indian instrument in `controlIds` / `regulatoryRefs[0]`, from
   `.claude/skills/regulatory-catalogs/references/catalogs/*.catalog.json`).
3. **Only when no catalog control resolves**, the tool's own level: SARIF `result.level` `error` high, `warning`
   medium, `note` low, `none` info; OCSF `severity_id` 5/6 critical, 4 high, 3 medium, 2 low, 1 info. OCSF 0/99
   and a missing level never default to `info`: record an `inconclusive` observation instead of a finding.

Other records:

| Record | Rule |
| --- | --- |
| Risk | the likelihood x impact matrix below; `severity` is a lookup, never a judgement |
| Incident | the company's incident classification; regulator clocks do not depend on it |
| Observation | observations carry no severity; use `result` instead |

Risk matrix (rows `likelihood`, columns `impact`; all 25 cells, monotonic along both axes; it matches the risk
example in `v1/soc/record.schema.json`, `likely` x `major` = `high`):

| likelihood \ impact | `negligible` | `minor` | `moderate` | `major` | `severe` |
| --- | --- | --- | --- | --- | --- |
| `rare` | low | low | low | low | medium |
| `unlikely` | low | low | medium | medium | medium |
| `possible` | low | medium | medium | high | high |
| `likely` | low | medium | high | high | critical |
| `almost-certain` | medium | medium | high | critical | critical |

`info` is for observations with no risk; a finding with `severity: info` is almost always an observation
recorded in the wrong kind. Severity is independent of `priority` (`p1`-`p4`, set by the change manager).

## 5. Status lifecycles and allowed transitions

All vocabularies are in `.claude/schemas/vocab/statuses.schema.json`. Arrows are the only allowed moves;
anything else is a new record, not a transition. Conditional fields are enforced by the schemas.

**finding** `open -> triaged -> remediating -> resolved`; from `open` or `triaged` also `-> risk-accepted |
false-positive | duplicate` (each needs `statusReason` and `resolvedAt`). `resolved -> open` only by a new
supersession when the fingerprint is seen again. `risk-accepted -> open` when the linked risk's `acceptedUntil`
passes. Terminal: `resolved`, `false-positive`, `duplicate`.

**risk** `open -> investigating -> mitigating -> closed`; from `open` or `investigating` also `-> accepted |
deviation-approved` (require `acceptedBy`, `acceptedUntil`); `accepted -> open` when `acceptedUntil` passes.

**incident** `detected -> triaged -> contained -> eradicated -> recovered -> closed`; `detected | triaged ->
false-positive`. `contained` and later require `containedAt`; `recovered` and `closed` require `resolvedAt`.
Regulator clocks start at `detectedAt` regardless of status.

**initiative** `proposed -> approved -> in-progress -> verifying -> closed`; `in-progress <-> blocked`;
`verifying -> in-progress` on verification-failed; `proposed | approved -> cancelled`; `closed -> reopened ->
in-progress`. Every move is also an event in `timeline.json` with `toStatus` (event types listed in
`change-management/timeline.schema.json#/$defs/eventType`).

**task** `todo -> in-progress -> done`; `in-progress <-> blocked` (`blockedReason` only while blocked);
`-> cancelled` from any non-terminal state (`cancelledAt`, `cancelledReason`). `done` needs `startedAt`,
`doneAt`, evidence and a root cause. Mirror each move with a `task-*` timeline event.

**suggestion** `proposed -> surfaced -> accepted -> merged (-> reverted)`; `surfaced -> rejected | expired`;
any open state `-> superseded` (name the newer suggestion). A supersession chain counts once in KPIs.

**control** `implementationStatus` is a state, not a workflow: `unknown -> not-implemented | planned -> partial ->
implemented` (`not-implemented` when evidence shows the control is absent and nothing is planned; `planned` once
an initiative exists), or `not-applicable | alternative` by documented decision. `effectiveness` is `not-tested` until an observation
exists, then `effective | partially-effective | ineffective` from the latest `result`.

**vendor** `onboarding -> active -> exiting -> terminated`. **vex** per asset: `under_investigation ->
affected -> fixed`, or `-> not_affected` with a `justification` or `impactStatement`.

## 6. Never invent keys

Every Maxwell schema closes its objects (`additionalProperties: false` or `unevaluatedProperties: false`).
If the field you want does not exist:

1. Do not add it, do not smuggle it into `tags`, `notes` or `database_specific`.
2. Record the fact as a ledger observation: `kind: "observation"`, `methods: ["manual"]`, `result:
   "inconclusive"`, `controlIds` naming the control you were assessing, `description` saying which field is
   missing and what value you would have stored. Use `evidence[]` for the supporting file.
3. Continue without the field. A schema change is a separate, human-reviewed commit (`MAXWELL_SCHEMA_EDIT=1`);
   agents never edit `.claude/schemas/**`.

The same applies to enums: a regulator not in `vocab/regulators`, an instrument not in `vocab/instruments`, a
workflow name, a status, an evidence type. Pick the closest existing value and say so in `notes`/`description`.

## 7. Validation

```bash
node .claude/scripts/validate-data.mjs <path> [<path> ...]   # the file(s) you just wrote
npm run validate                                              # layout + data + frontmatter + workflows + mirror
npm run validate:schemas && npm run test:schemas              # only after a reviewed schema change
```

`validate-data` exits 0 when every file is valid, 2 when it found validation problems (schema mismatch, unparsable
file, unknown format), and any other non-zero code (usually 1) when the tool itself failed (missing dependency,
uncaught error): that is not a verdict on your file, fix the environment and re-run. Errors print as
`- <file>: does not match <schema>` followed by AJV messages; JSONL files add the line, `- <file>: line <n>: does
not match <schema>`. The first message is usually the real one, the `oneOf`/`if-then` cascade below it is noise.
In Claude Code the `PostToolUse` hook runs `validate-data` after the Write, Edit and MultiEdit tools only, so a
silent write through those tools means a valid file. It does not fire for files written from Bash (heredocs,
`jq > file`, scanners), by `append.mjs`, or in OpenCode sessions: after any such write run `validate-data`
yourself. `npm run validate` must be green before a task ends.
Frontmatter (`SKILL.md`, agents, commands, `summary.md`, `kpis/measurement/*.md`) is validated the same way;
keep `name` equal to the directory or file name.

## 8. Worked examples by document type

Each schema carries a complete, validated example under `examples[0]`. Print it instead of copying JSON from
memory, then change only the values:

```bash
node -e "console.log(JSON.stringify(require('./.claude/schemas/v1/company/details.schema.json').examples[0],null,2))"
```

| Document | Path | Schema (`.claude/schemas/v1/`) | Notes from the example |
| --- | --- | --- | --- |
| company details | `company-profile/<c>/details.json` | `company/details.schema.json` | `entityTypes`, `regulatoryRegistrations[].category` and `frameworksInScope` decide which instruments apply; contacts need `designated-officer` for CERT-In and `grievance-officer` for DPDP |
| organization context | `company-profile/<c>/context.json` | `company/context.schema.json` | written only by refresh-ctx (validator) and `ctx/answer.mjs`; ids are local slugs and every cross-reference must resolve (validate-data checks); `licenses[].registrationNo` must match a `details.json` registration; a human answers open questions with `node .claude/scripts/ctx/answer.mjs <c> <question_id>` (answer on stdin) |
| environment | `applications/<a>/env/<e>.json` | `application/environment.schema.json` | `probeAccess.readOnly` must be `true`, `credentialKey` is a locator; `changeFreeze` windows are honoured by probes |
| repo | `applications/<a>/repos/<r>.json` | `application/repo.schema.json` | `url` is a `gitUrl` (no embedded credentials); `pinnedCommit` is what you inspected; `localCheckout` is gitignored |
| image | `applications/<a>/images/<i>.json` | `application/image.schema.json` | `ref` is a fully-qualified OCI reference with digest; `sbomPath` points at the sibling `<i>.cdx.json` (validated by `application/sbom-ref.schema.json`, needs the `maxwell:*` metadata properties) |
| vendor | `company-profile/<c>/vendors/<v>.json` | `company/vendor.schema.json` | DORA ROI / RBI outsourcing shape; `materiality` and `services[].criticalFunctionRefs` link to `details.criticalFunctions` |
| ledger record | `company-profile/<c>/soc/main.jsonl` | `soc/record.schema.json` | five examples, one per kind; see the `soc-ledger` skill |
| initiative | `company-profile/<c>/change_management/master.json` | `change-management/master.schema.json` | `approvedAt`, `dueAt`, `slaBasis`, `regulatoryRefs` feed KPIs; each status move needs a timeline event |
| task | `.../initiatives/<init>/tasks/task_<n>.json` | `change-management/task.schema.json` | `humanEdited: false` at creation; `verificationMethod.workflow` names the re-probe |
| suggestion | `company-profile/<c>/suggestions/master.json` + `.diff` | `suggestions/master.schema.json` | diff lives at `suggestions/suggestions/<sug>/<repo>/<name>.diff`; `baseCommit` is required |
| cve search / record | `cves/search/<q>.json`, `cves/data/<id>.json` | `cve/search.schema.json`, `cve/record.schema.json` | see the `cve-enrichment` skill; file name replaces `:` with `_` |
| session meta / summary | `kpis/data/raw/sessions/<harness>/<sid>.*.json` | `session/*.schema.json` | written by hooks; tool exports use the path the workflow prompt passes (runtime probes: `kpis/data/raw/sessions/<sid>/<workflow>.<agent>.ocsf.export.json`; see `sarif-findings`, `ocsf-findings`) |

## 9. Small things that fail validation

- `schemaVersion` is the string `"1"`, never the number 1. `kind` is the exact const, e.g. `maxwell.app.image`.
- Arrays with `uniqueItems` reject byte-identical duplicates; `regulatoryRefs` need `regulator` +
  `instrument` + `controlId` and the regulator must be the instrument's issuer.
- Indian instrument first, global mappings second, in `regulatoryRefs` and `frameworkRefs`.
- `assetRef` needs `appId` for application/environment/repo/image, plus `envId`/`repoId`/`imageId`; `vendorId`
  for vendor; `company` needs nothing else.
- `location.path` is repo- or image-relative: never absolute, never `../`.
- `tags` are lowercase `^[a-z0-9][a-z0-9:_-]{0,47}$` (`pci:req6`, `supply-chain`).
- Text limits: `shortText` 200, `nonEmptyString` 4000, `longText` 20000 characters.
- OCI references must carry a registry host (`docker.io/library/node:22`, not `node:22`).
- Never write a secret value anywhere; the write guard blocks key-shaped strings and the validator blocks
  unencrypted `credentials.json`. Locators only (see `credentials-sops`).
