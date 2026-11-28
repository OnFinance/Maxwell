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

Status: under construction. It is built and benchmarked by an automated improvement loop. Each PR reports its
benchmark scores (SmartBugs-curated, OpenZeppelin Contracts and its security advisories, sealevel-attacks).
