# Maxwell web3: conventions for agents and contributors

- Branch: `web3`, an orphan branch of OnFinance/Maxwell. PRs target `web3`, never `main`. Do not merge `main` into
  this branch or this branch into `main`.
- Scope: smart-contract security only (Ethereum/EVM and Solana). Never add fintech compliance features; those
  belong on `main`.
- Runtime: Node >= 22, ES modules, no build step. Keep dependencies minimal and pinned.
- Entrypoint: `bin/audit.mjs` (contract in README.md). Output is SARIF 2.1.0; every result carries
  `properties.category`, `severity`, `exploitScenario` and `remediation`.
- Structure (grow into it): `src/` deterministic code (project discovery, parsers, tool adapters, SARIF),
  `agents/` prompt files for specialist reviewers and the refuter, `skills/` vulnerability checklists,
  `schemas/` JSON Schemas for outputs, `test/` `node --test` tests, `test/fixtures/` small hand-written projects.
- Layout:
  - `bin/audit.mjs`: CLI only (argument parsing, write SARIF, exit codes). Logic lives in `src/`.
  - `src/audit.mjs` pipeline: `discover.mjs` (in-scope files) -> `plan.mjs` (batches, budget fit) ->
    `prompts.mjs` (assembles agent + skill files, numbered source, `hints.mjs` pre-analysis) -> `claude.mjs`
    (headless run) -> `findings.mjs` (normalise, dedupe, apply verdicts) -> `sarif.mjs`.
    `taxonomy.mjs` is the single source of categories and severities; `budget.mjs` tracks spend.
  - `agents/<chain>-reviewer.md`, `agents/refuter.md`: system prompts. `skills/<chain>-checklist.md`: per-category
    report / not-a-finding guidance. Change prompts there, never inline in code.
  - `schemas/findings.schema.json`, `schemas/verdicts.schema.json`: passed to `claude -p --json-schema`.
- Nested model runs: `claude -p --output-format json --tools "" --strict-mcp-config --setting-sources ""` with the
  prompt on stdin and a `--max-budget-usd` cap reserved from the run budget (sum of caps never exceeds 90% of
  `MAXWELL_EVAL_BUDGET_USD`). Reviewers get no tools: all source is inlined, so runs are hermetic.
- Tests: `npm test` runs `test/*.test.mjs` only. `src/audit.mjs` takes an injectable `runner`; end-to-end tests
  use `test/fixtures/fake-claude.mjs` via `MAXWELL_CLAUDE_BIN`, so tests never spend money or need the network.
- Every candidate finding is adversarially refuted before it is reported. Prefer silence to a false alarm.
- External tools (slither, aderyn, mythril, echidna, forge, anchor, cargo-audit) are optional: detect them and
  degrade gracefully.
- Never special-case benchmark contracts. Never use mainnet keys or send mainnet transactions.
- `npm test` must pass before every commit.
