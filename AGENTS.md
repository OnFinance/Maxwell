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
- Every candidate finding is adversarially refuted before it is reported. Prefer silence to a false alarm.
- External tools (slither, aderyn, mythril, echidna, forge, anchor, cargo-audit) are optional: detect them and
  degrade gracefully.
- Never special-case benchmark contracts. Never use mainnet keys or send mainnet transactions.
- `npm test` must pass before every commit.
