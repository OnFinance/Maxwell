# Maxwell web3

Smart-contract security auditor for **Ethereum** (Solidity/EVM) and **Solana** (Anchor and native Rust programs),
part of the Maxwell family. It runs headlessly on Claude Code and writes SARIF 2.1.0.

This is the `web3` branch of OnFinance/Maxwell: an independent (orphan) branch holding smart-contract code only.
Fintech compliance (SEBI, RBI, IRDAI, CERT-In, DPDP controls, SOC ledger) lives on the `main` branch. The two
branches share no history and are never merged into each other; Maxwell on `main` consumes this auditor's SARIF
output.

## Interface

```sh
node bin/audit.mjs --target <dir> --chain ethereum|solana --out results.sarif.json
```

- `--target`: absolute path to a project directory (Foundry/Hardhat tree, Anchor workspace, Cargo crate) or a
  single source file. SARIF URIs are relative to it (to its directory for a single file).
- `--chain`: `ethereum` audits `*.sol`; `solana` audits `*.rs`. Dependencies, build output, tests, mocks and
  scripts are skipped, and so are Solidity files that declare only interfaces.
- `--out`: SARIF 2.1.0 file. Each result has `ruleId` = `properties.category` (chain taxonomy), `level`,
  `message.text`, a `region` with `startLine`/`endLine`, and `properties.severity`
  (`critical|high|medium|low|informational`), `exploitScenario`, `remediation` and `confidence`.
  `runs[0].properties.costUsd` is the total spend of the nested model runs.
- Exit code 0 whenever a SARIF file was written (also with no findings, and when the `claude` CLI is missing, in
  which case the log carries an error notification). Exit code 2 for bad arguments.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAXWELL_EVAL_BUDGET_USD` / `MAXWELL_BUDGET_USD` | `5` | Total USD budget; 90% is split into per-run `--max-budget-usd` caps. |
| `MAXWELL_REVIEW_MODEL`, `MAXWELL_REFUTE_MODEL` | `opus` | Models for the specialist reviewer and the refuter. |
| `MAXWELL_CONCURRENCY` | `3` | Parallel review batches. |
| `MAXWELL_DEADLINE_MS` | `1080000` | Wall-clock limit (18 min); later runs are skipped. |
| `MAXWELL_CLAUDE_BIN` | `claude` | Path to the Claude Code CLI. |

How it works: deterministic discovery and lexical pre-analysis (`src/`), then one tool-less `claude -p` specialist
review per batch of files (`agents/<chain>-reviewer.md` + `skills/<chain>-checklist.md`, output constrained by
`schemas/findings.schema.json`), then an adversarial refuter run (`agents/refuter.md`,
`schemas/verdicts.schema.json`) over every medium-or-worse candidate. Only findings the refuter confirms with
confidence >= 0.6 are reported.

Status: under construction. It is built and benchmarked by an automated improvement loop. Each PR reports its
benchmark scores (SmartBugs-curated, OpenZeppelin Contracts and its security advisories, sealevel-attacks).
