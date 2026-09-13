---
name: reference-architectures
description: Offline copies of two OnFinance reference systems - how regulatory context is refreshed (grounding contract, drift kinds, adversarial verify, never-delete) and what a realistic regulated-fintech data pipeline plus agent harness deployment looks like (outbox to ECS runs, harness catalogue, governed egress, SBOM attestation). Use when refreshing context, modelling a metastore, or writing probe checklists.
license: AGPL-3.0-only
metadata:
  source: OnFinance/regulatory-comms-manager@f53afdf, OnFinance/investigation-saver-drhp@81c6ed9
  captured: "2026-09-13"
x-maxwell:
  kind: catalog
  workflows: [refresh-ctx, refresh-vendor-ctx, refresh-metastore, runtime-probe-datapipeline, runtime-probe-harnesses, runtime-probe-sandboxes, probe-agent-graph, probe-cicd-env, probe-iac, probe-dev-env]
---
# Reference architectures (offline copies)

Two private OnFinance repositories were read once and their mechanics copied here. Maxwell never calls them.

- `references/investigation-saver-drhp-offline-copy.md` — the data-pipeline and agent-harness model: stage DAG,
  Postgres schemas `platform|session|governance`, table and column names, lineage chain, harness catalogue
  (`cc-core|cc-docs|cc-browser|oc-video`, egress `offline|loopback-only|governed`), sandbox controls, tool
  allow/deny lists, budgets, CI/CD scanners and release pinning, `DRHP_*` environment conventions, and a derived
  probe checklist (section 7).
- The regulatory-context refresh mechanics live next to the catalogs in
  `../regulatory-catalogs/references/regulatory-comms-manager-offline-copy.md`: grounding contract, bias toward
  no-op, drift kinds, three-lens adversarial verification with unanimous non-refutation for destructive drift,
  never-delete-only-mark, quiet exit, closed vocabularies for clause and obligation updates.

## How to use
1. `refresh-ctx` / `refresh-vendor-ctx`: copy the grounding contract and bias-toward-no-op text into every
   research prompt; emit drift as `observation` records and escalations as `risk` records in the soc ledger; never
   remove a registration or vendor, mark its status instead.
2. `refresh-metastore`: model catalogs and tables after section 2 of the DRHP copy; when a company has no
   catalog product, the "metastore" is the set of databases, schemas, tables, object stores and queues the
   pipeline touches, plus the lineage chain.
3. Probe workflows: turn section 7 of the DRHP copy into observations per control; an SBOM that is present but
   empty is a missing SBOM.
