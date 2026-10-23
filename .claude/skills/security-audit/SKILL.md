---
name: security-audit
description: Run coverage-led, source-first security audits in Maxwell's execute-scr workflow, with explicit trust boundaries, independent verification, deterministic coverage records, and confirmed/needs_validation/rejected verdicts.
license: MIT-derived; see references/UPSTREAM.md and references/LICENSE
compatibility: Requires Node.js 22 and a Maxwell application repository checkout. Target-controlled execution additionally requires the configured Maxwell sandbox.
metadata:
  author: OnFinance
  version: 1.0.0
allowed-tools: Read Grep Glob Bash(node .claude/scripts/security-audit/*)
x-maxwell:
  kind: runbook
---
# Coverage-led security audit

Use this skill for secure code review through `execute-scr`. It adapts Cloudflare's source-first audit method to
Maxwell's application inventory, sandbox, SARIF exports, regulatory mappings, and state-of-controls ledger.

## Audit contract

1. Identify the lower-trust principal, accepted input or action, intended control, crossed boundary, affected
   principal or resource, and concrete security result for every candidate.
2. Seed deterministic coverage units before hunting. A unit is repository, subsystem, boundary, and attack class.
3. Keep one parent owner for shared state. Reviewers and critics return data; they do not edit coverage or verdict
   exports.
4. Treat source inspection as read-only. Run target-controlled code only through Maxwell's configured sandbox. If
   the sandbox cannot enforce isolation, retain the candidate as `needs_validation` with the exact blocker.
5. Verify every candidate independently. Verify the normalized final record again before it reaches SARIF or the
   SOC ledger.
6. Use only `confirmed`, `needs_validation`, and `rejected` verdicts. Only `confirmed` records may become findings.
7. Preserve unresolved work in the session exports. Do not turn missing evidence into a clean result.

## Profiles

- `quick`: coarse subsystem grouping, one hunter wave, one final critic, one verifier per candidate.
- `standard`: subsystem-specific units, critic after each wave, separate candidate and final-record verification.
- `deep`: standard behavior plus lifecycle-specific units and a second pass over unchanged prior coverage.

The default is `standard`. Scope and budget reduce breadth or defer work; they never reduce the evidence bar.

## Maxwell outputs

Audit records belong under `kpis/data/raw/sessions/<sessionId>/` as immutable `*.export.json` files. Confirmed
findings continue through the existing SARIF and `soc/main.jsonl` writers. `needs_validation` items may produce an
inconclusive observation when they carry a valid regulatory mapping. Rejected candidates remain in the audit export
for traceability and never enter the SOC ledger.

Run the validators before accepting an export:

```bash
node .claude/scripts/security-audit/validate.mjs <export.json>
```

See `references/ATTACK-CLASSES.md` for the coverage taxonomy and `references/UPSTREAM.md` for attribution and the
pinned upstream revision.
