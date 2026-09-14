---
name: sarif-findings
description: How Maxwell's static probes (probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env) emit and consume SARIF 2.1.0 - the tool.driver and rules blocks, results with ruleId, level, message, locations, partialFingerprints and baselineState, the sanctioned export path kpis/data/raw/sessions/<harness>/<sid>.<tool>.export.json, and the exact conversion of a SARIF result into a soc ledger finding (security-severity score, else catalog defaultSeverity, else level to severity, the Maxwell fingerprint, rule to source, controls via the regulator catalog probeWorkflows mapping). Load before running or hand-writing any scanner output and before turning scanner results into observations or findings.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; scanners run only through toolchain/scan.mjs at the versions pinned in the scanner-toolchain skill, inside the executor set by /connect-sandbox - when scan.mjs cannot run one (exit 3) the agent writes the SARIF log itself with a maxwell-* driver name
metadata:
  author: OnFinance
  version: "1.0.0"
  sarifVersion: "2.1.0"
  sarifSchema: https://json.schemastore.org/sarif-2.1.0.json
allowed-tools: Read Grep Glob Write Bash(node .claude/scripts/*) Bash(node -e *) Bash(helm template *) Bash(kustomize build *) Bash(sha256sum *) Bash(jq *)
when_to_use: Whenever a static probe runs a scanner or reviews code, IaC, charts, schemas, CI configuration or agent graphs by hand and must record the results; and whenever the soc-ledger-keeper converts a *.sarif.export.json into ledger observations and findings
user-invocable: false
x-maxwell:
  kind: capability
  workflows: [probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env, refresh-soc, report-audit-findings]
---
# SARIF findings

Every static probe produces exactly one SARIF 2.1.0 log per (workflow, target) and the ledger keeper converts
it into observations and findings. SARIF is the evidence; the ledger is the record. Runtime probes use OCSF
instead (`ocsf-findings`). Read `maxwell-conventions` for ids, timestamps and severity and `soc-ledger` for the
ledger protocol; this skill covers only the SARIF side and the conversion.

## 1. Minimal valid log

```json
{ "version": "2.1.0", "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "runs": [ { "tool": { "driver": { "name": "Semgrep OSS", "version": "1.99.0", "semanticVersion": "1.99.0",
        "informationUri": "https://semgrep.dev", "rules": [ { "id": "javascript.express.security.audit.xss.direct-response-write.direct-response-write",
          "name": "javascript.express.security.audit.xss.direct-response-write.direct-response-write", "shortDescription": { "text": "Unescaped user input rendered by res.send" },
          "fullDescription": { "text": "..." }, "helpUri": "https://semgrep.dev/r/...",
          "defaultConfiguration": { "level": "error" },
          "properties": { "security-severity": "7.5", "tags": [ "security", "cwe-79", "owasp-asvs-5.0:5.3.3" ] } } ] } },
      "automationDetails": { "id": "maxwell/probe-cicd-env/kalpataru-securities/trading-api/trading-platform",
        "properties": { "runId": "run_01J7Q3V8K2M4N6P8R0S2T4V702", "sessionId": "8f3b1c2a-4d5e-4f60-9a7b-1c2d3e4f5a6b" } },
      "versionControlProvenance": [ { "repositoryUri": "https://github.com/kalpataru-sec/trading-platform",
        "revisionId": "9f2c4d1e7a3b5c6d8e0f1a2b3c4d5e6f7a8b9c0d" } ],
      "originalUriBaseIds": { "SRCROOT": { "description": { "text": "repo root at pinnedCommit" } } },
      "invocations": [ { "executionSuccessful": true, "startTimeUtc": "2026-09-13T08:02:11Z", "endTimeUtc": "2026-09-13T08:03:40Z" } ],
      "results": [ { "ruleId": "javascript.express.security.audit.xss.direct-response-write.direct-response-write", "ruleIndex": 0, "level": "error", "kind": "fail",
          "message": { "text": "User-controlled `req.query.q` reaches res.send without escaping" },
          "locations": [ { "physicalLocation": { "artifactLocation": { "uri": "src/routes/search.js", "uriBaseId": "SRCROOT" },
            "region": { "startLine": 42, "endLine": 44 } } } ],
          "partialFingerprints": { "primaryLocationLineHash": "5f1c8e2b9a3d4c6e:1" },
          "fingerprints": { "maxwell/v1": "c5d3...64 hex" },
          "baselineState": "new",
          "properties": { "cveIds": [], "maxwell/controlIds": [ "sebi-cscrf-2024:PR.IP.S15" ] } } ] } ] }
```

Rules: one `run` per tool (several tools in one log means several runs, never merged rule tables); every
`result.ruleId` must appear in `tool.driver.rules[]`; `kind` is `fail` for a gap, `pass` for an explicit
satisfied check, `informational` for context that raises no finding; `level` is `error|warning|note|none`.

## 2. Producing the log

| Source | Command | Driver name it produces |
| --- | --- | --- |
| Terraform, CloudFormation, Pulumi (`probe-iac`) | `checkov -d <dir> -o sarif --output-file-path <dir>`; `trivy config --format sarif -o <out> <dir>` | as emitted, e.g. `Checkov`, `Trivy` |
| Helm, Kustomize, raw manifests (`probe-app-chart`) | render first (`helm template`, `kustomize build`) then `kube-linter lint --format sarif`, `kubescape scan --format sarif`, `checkov --framework helm,kubernetes` | as emitted, e.g. `Checkov` |
| OpenAPI, SQL migrations, Avro/Proto (`probe-schemas`) | `spectral lint -f sarif`, `semgrep --config p/secrets --sarif`, `sqlfluff lint --format json` (convert by hand) | as emitted, e.g. `Semgrep OSS`; hand-converted `sqlfluff` output: `maxwell-schema-auditor` |
| GitHub Actions, GitLab CI, Jenkinsfiles (`probe-cicd-env`) | `zizmor --format sarif <repo>`, `actionlint -format '{{json .}}'` (convert), `semgrep --config p/github-actions --sarif` | as emitted; hand-converted `actionlint` output: `maxwell-cicd-auditor` |
| Agent graphs, MCP configs (`probe-agent-graph`) | `semgrep --config p/python --sarif`, project linters | as emitted |
| Source code review (`execute-scr`) | `semgrep --config auto --sarif`, `grype dir:<repo> -o sarif`, `trivy fs --format sarif` | as emitted |
| Policies, developer laptops, dev environments (`probe-sdlc`, `probe-dev-env`) and any target with no scanner | write the log yourself | `maxwell-<agent>` (e.g. `maxwell-iac-auditor`) |

The driver-name column is a hint, not a lookup: whatever `tool.driver.name` the scanner writes (Semgrep, for
example, writes `Semgrep OSS` or `Semgrep PRO` depending on the engine) is kept in the log and copied verbatim
into `source.tool`; never normalise it, and never rename a scanner's `ruleId`. Output you convert by hand
(`sqlfluff`, `actionlint` JSON) has no SARIF driver of its own, so it is a hand-written log with the
`maxwell-<agent>` driver, but its `rules[].id` stays the tool's own rule code (sqlfluff `CP01`, actionlint
`expression`), which is already stable across runs.

When you write the log yourself: `tool.driver.name` is `maxwell-<agent name>`, `version` is the
`metadata.version` of this skill, `rules[].id`, for a gap no tool names, is a stable kebab-case rule you choose once and reuse across runs
(`helm-privileged-container`, `gha-pull-request-target-checkout`, `tf-s3-bucket-public-acl`), `helpUri` may be
omitted. Never invent a rule id per finding instance; the rule is the class of gap, the location is the instance.

Always set `automationDetails.id` to `maxwell/<workflow>/<companyId>/<appId>/<repoId|imageId>` and
`versionControlProvenance[].revisionId` to `repos/<repoId>.json pinnedCommit`. Redact secrets in
`message.text` and snippets before writing (the write guard blocks key-shaped strings; a blocked write means
the tool captured a secret, not that the guard is wrong).

## 3. Where the export lives

`layout.json` sanctions raw tool output only as `kpis/data/raw/sessions/<segment>/<name>.export.json` (two
segments under `sessions/`, name ending `.export.json`). Use:

- `kpis/data/raw/sessions/<harness>/<sid>.<tool>.export.json` for a tool run attributable to one session
  (`kpis/data/raw/sessions/claude-code/8f3b1c2a-4d5e-4f60-9a7b-1c2d3e4f5a6b.semgrep.sarif.export.json`);
- `kpis/data/raw/sessions/<sid>/<workflow>.<appId>.<repoId>.sarif.export.json`, the form the shipped static
  workflows pass as `exportDir`, when the workflow hands you the directory. Both satisfy the observation
  `toolOutput.path` pattern; never put exports anywhere else and never name them `.jsonl`, `.meta.json` or
  `.summary.json` (those names are reserved for session ingestion).

Compute `sha256sum <path>` and carry it in three places: the observation `toolOutput.sha256`, every finding's
`evidence[] {type: "sarif", ref: <path>, sha256}` and the workflow result (`sarifSha256`). One export per
(workflow, target, tool); a re-run in a new session writes a new file, never overwrites.

## 4. Converting a result into a ledger finding

| SARIF | Ledger finding field | Rule |
| --- | --- | --- |
| `rule.properties.security-severity`, `result.properties.cvss`, catalog control, `result.level` | `severity` | the single rule in `maxwell-conventions` section 4, in order: a `security-severity` or CVSS score maps as a CVSS base score; otherwise the catalog `defaultSeverity` of the most specific control in `controlIds`; `level` (`error` high, `warning` medium, `note` low, `none` info) only when no catalog control resolves. Never raise or lower one input by another |
| `result.properties.cvss` / `cveIds` | `cvss`, `cveIds` | copy; version must match the vector prefix; enrich via `cve-enrichment` |
| `result.ruleId` | `source.ruleId` | verbatim |
| `tool.driver.name` / `.version` | `source.tool` / `source.toolVersion` | verbatim, whatever the scanner emits; `source.kind: "sarif"`; hand-written logs keep `kind: "sarif"` with the `maxwell-*` driver, `agent-analysis` is for gaps with no log at all |
| `physicalLocation.artifactLocation.uri` | `location.path` | strip `uriBaseId`, `file://`, leading `./` and the checkout prefix; must be repo- or image-relative |
| `region.startLine` / `endLine` | `location.startLine` / `endLine` | copy; omit when the tool gives none |
| `message.text` + rule `fullDescription` | `description` | message first, then the rule text, then how you confirmed it; `title` is one line naming the asset and the weakness |
| `partialFingerprints`, `fingerprints` | (evidence only) | keep in the export; the ledger `fingerprint` is computed below |
| `baselineState` | reconciliation hint | `new` -> new `fnd_`; `unchanged`/`updated` -> supersession of the fingerprint match; `absent` -> one absence for the resolved-when-absent-twice rule |
| `kind: pass` / `informational` | observation only | never a finding; feeds `result: satisfied` |
| `suppressions[]` with `status: accepted` | `status: risk-accepted` | only when a ledger risk in `accepted` status exists; otherwise ignore the suppression and note it in `description` |

### Fingerprint

`fingerprint = sha256(ruleId + "|" + targetKey + "|" + normalisedPath)` exactly as `soc-ledger` section 6
defines it: `targetKey` is `repo:<appId>/<repoId>` or `image:<appId>/<imageId>`, `normalisedPath` is
`location.path` without line numbers. Write the same value into the SARIF result as
`fingerprints["maxwell/v1"]` so the export and the ledger can be joined without recomputation.

```bash
node -e "const [r,t,l]=process.argv.slice(1);console.log(require('crypto').createHash('sha256').update(r+'|'+t+'|'+l).digest('hex'))" javascript.express.security.audit.xss.direct-response-write.direct-response-write repo:trading-api/trading-platform src/routes/search.js
```

Do not derive the ledger fingerprint from `partialFingerprints.primaryLocationLineHash`: it changes when lines
move and differs between tools that hit the same rule on the same file.

### Controls and regulatory references

1. Load the catalogs in `.claude/skills/regulatory-catalogs/references/catalogs/*.catalog.json` for the
   instruments in `details.frameworksInScope`.
2. Candidate controls are those whose `probeWorkflows` contains the current workflow; narrow by `category`,
   `evidenceExpected` and the rule's `tags` (a `cwe-79` tag matches secure-coding controls, `sbom` tags match
   `GV.SC.S5`-style controls). The workflow prompt usually names the primary control; use it.
3. `controlIds` = `<instrumentId>:<controlId>` of every matched control that already exists in the ledger (create
   the control record first when it does not). `regulatoryRefs[0]` is the Indian instrument's control, then the
   catalog `mappings` (NIST SSDF, CIS, OWASP ASVS). Record the chosen ids in the SARIF result
   `properties["maxwell/controlIds"]` so the refuter can check the mapping.
4. `target` is the repo or image the run scanned (from `automationDetails.id`), never `company` for a code hit.

### Observations from the same log

One observation per control evidenced, `methods: [<workflow>]`, `subjects` = the scanned asset,
`toolOutput: {format: "sarif", path, sha256}`, `result` = `satisfied` when every result for that control is
`pass`/none, `not-satisfied` when any `fail` at high or above, `partial` otherwise, `inconclusive` when the
invocation has `executionSuccessful: false` or the scanner could not read the target. Findings reference these
via `relatedObservationIds`.

## 5. Worked conversion

A hand-written log (no scanner covered the pattern): `cicd-auditor` read `.github/workflows/release.yml` and saw a
`pull_request_target` trigger that checks out `github.event.pull_request.head.sha` and then runs `npm ci` with
the release secrets in scope. SARIF result: driver `maxwell-cicd-auditor 1.0.0`, `ruleId
gha-pull-request-target-checkout`, `level error`, rule `security-severity 8.1`, location
`.github/workflows/release.yml:17-23`, target `repo:trading-api/trading-platform`. (Had zizmor reported it, the
`ruleId`, `source.tool` and fingerprint input would be exactly what zizmor wrote, not this Maxwell rule id.)

Ledger finding: `severity: high` (score 8.1, step 1 of the severity rule), `source: {kind: sarif, tool:
maxwell-cicd-auditor, toolVersion: "1.0.0", ruleId: gha-pull-request-target-checkout}`, `location: {path: ".github/workflows/release.yml", startLine: 17,
endLine: 23}`, `fingerprint: sha256("gha-pull-request-target-checkout|repo:trading-api/trading-platform|
.github/workflows/release.yml")`, `controlIds: ["sebi-cscrf-2024:PR.DS.S6"]` (integrity of software and source code; its catalog
`probeWorkflows` include `probe-cicd-env`), `regulatoryRefs: [{SEBI, sebi-cscrf-2024, PR.DS.S6}, {NIST,
nist-csf-2.0, PR.DS-01}, {NIST, nist-ssdf-800-218, PS.2.1}]` (the control's catalog `mappings`), `slaBasis`
from the `patch-sla` row for `sebi-cscrf-2024` at `high` (a misconfiguration with a fix; see `soc-ledger`
section 6), `slaDueAt = firstSeenAt + slaBasis.days`, `evidence: [{type: sarif, ref: <export path>,
sha256}]`, `status: open`, `confidence: confirmed` when you reproduced it by reading the file, `likely` when only
the scanner says so.

## 6. Common mistakes

- A result whose `ruleId` is not in `rules[]`, or a rule table copied from another tool's run.
- `artifactLocation.uri` absolute or containing the local checkout path (`/home/.../repo/src/a.js`).
- Line numbers in the fingerprint input; a fingerprint reused for two different rules on one file.
- `level: none` or `kind: pass` turned into a finding; `severity: info` findings (record an observation).
- A log stored under `applications/` or `company-profile/`; an export overwritten by a later session.
- `security-severity` copied as `severity` text instead of mapped from the numeric score.
- Findings with no `regulatoryRefs` or citing a global framework before the Indian instrument.
- Forgetting `automationDetails.properties.runId`, which is what ties the export to `cost_of_audit`.
