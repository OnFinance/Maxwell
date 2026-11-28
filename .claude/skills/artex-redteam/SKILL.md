---
name: artex-redteam
description: How Maxwell runs ARTEX autonomous red-team assessments through the runtime-probe-redteam workflow - the authorization gate (CISO/CTO/Compliance-Head/Board-Authorized, unexpired, legal basis), the three modes (reconnaissance-only, limited-exploitation, full-redteam) and their prohibited actions, production gating, the ARTEX config the orchestrator builds, running ARTEX only through the sandboxed runner, exporting the dual graphs and evidence to artex/tasks/<artex_task_id>/, and reconciling attack paths and task records (schemas v1/artex/attack-path and v1/artex/task) into candidate ledger findings, observations and incidents. Load before running runtime-probe-redteam or reconciling an ARTEX task.
license: AGPL-3.0-only
metadata:
  artexVersion: "0.3.15"
x-maxwell:
  kind: runbook
  workflows: [runtime-probe-redteam]
---
# ARTEX autonomous red-team

ARTEX is an autonomous offensive-security agent (dual-graph planner/worker) that Maxwell drives to *validate*
findings by attempting exploitation, prove attack paths with evidence, and measure time-to-exploit. It is wired
into Maxwell through the `runtime-probe-redteam` workflow and two agents: `redteam-orchestrator` (gate, config,
execution, export) and `artex-reconciler` (exports -> attack-path/task files + candidate ledger records).

## 1. Authorization is non-negotiable
No ARTEX run starts without an explicit, current, written authorization in `args.authorization`:
`{ authorizedBy: {name, email, role}, authorizedAt, validUntil, legalBasis }`. The role must be one of `CISO`,
`CTO`, `Compliance-Head`, `Board-Authorized`; `validUntil` must be after the run timestamp; `legalBasis` must
reference a signed document. `full-redteam` against any `prod`/`dr` environment requires `Board-Authorized`.
The orchestrator validates this and returns `authorized: false` (it never throws) when a check fails.

## 2. Production gating
A `prod` or `dr` tier environment may be touched only when it is named explicitly in `args.envIds`. Never infer a
production target from an application or domain.

## 3. Modes and prohibited actions
- **reconnaissance-only** — passive discovery and safe tools only; all exploitation is prohibited.
- **limited-exploitation** (default) — non-destructive exploits with guard approval; `data-modification`,
  `data-deletion`, `service-disruption` and `credential-bruteforce` stay prohibited.
- **full-redteam** — all ARTEX capabilities within authorization; the destructive actions above stay prohibited
  unless the authorization explicitly covers them.

## 4. Running ARTEX
ARTEX runs **only** through `node .claude/scripts/artex/run.mjs` inside the sandbox executor. Never call a scanner,
browser, `kubectl`, `aws`, `gcloud`, `az`, `docker`, `curl`, `openssl` or `ssh` directly. The runner pins ARTEX
`0.3.15`. The orchestrator watches guard interventions and stops ARTEX on a scope violation, a service-disruption
trigger, or when guard blocks exceed the threshold, recording each as an incident candidate.

## 5. Exports and evidence
After a run, export the dual graphs and evidence with `node .claude/scripts/artex/export-graphs.mjs --task
<artex_task_id> --output artex/tasks/<artex_task_id>/`. Everything ARTEX produces lives under
`artex/tasks/<artex_task_id>/` only: `asset-graph.json`, `exploration-graph.json`, `tool-executions.json`,
`guard-interventions.json`, `export-metadata.json`, `execution.log`, `guard-log.jsonl`, `proxy-captures/*.har`,
`screenshots/*`, the task record `task.json` and one attack path per proven goal under `attack-paths/`. Compute a
SHA-256 for every artefact you cite. Never create a file outside this directory.

## 6. Reconciling into the ledger
`artex-reconciler` writes `task.json` (schema `v1/artex/task`) and each attack path (schema
`v1/artex/attack-path`) and validates them with `node .claude/scripts/validate-data.mjs <path>`. It then returns
**candidate** ledger records for `soc-ledger-keeper` — it never appends to `soc/main.jsonl` itself:
- **findings**: match an existing finding by its `fingerprint` and reuse it; put the exploitation evidence in
  `evidence[]` and tag it `artex:exploited`. Do not add keys the finding schema lacks.
- **observations**: for controls that blocked ARTEX (a control that worked is evidence it is effective).
- **incidents**: for authorization or scope violations.

Every finding, risk and incident cites at least one `regulatoryRef` from an applicable instrument (SEBI CSCRF,
RBI 2026, CERT-In, DPDP, or a company catalog). Severity for a proven exploit follows the sla-table, escalated for
confirmed exploitability. The `refuter` attacks every candidate through the evidence, regulatory-mapping and
exploitability lenses; high and critical findings must survive all three.

## 7. Dry run
`args.dryRun` plans only: the orchestrator validates authorization and builds the ARTEX config, but starts no run,
writes no `artex/` file and appends nothing to the ledger.

## References
- `references/integration.md` — the full integration guide (architecture, prerequisites, safety mechanisms).
- `references/quickstart.md` — step-by-step local setup and dry-run/reconnaissance testing.
