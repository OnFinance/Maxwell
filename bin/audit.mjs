#!/usr/bin/env node
// Headless smart-contract audit entrypoint. Contract: see README.md.
//   node bin/audit.mjs --target <dir> --chain ethereum|solana --out <file>
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, USAGE } from '../src/args.mjs';
import { audit } from '../src/audit.mjs';
import { buildSarif } from '../src/sarif.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`error: ${err.message}\n${USAGE}`);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!fs.existsSync(opts.target)) {
  console.error(`error: target not found: ${opts.target}`);
  process.exit(2);
}

const log = (msg) => process.stderr.write(`maxwell-web3: ${msg}\n`);
let sarif;
try {
  sarif = await audit({ target: opts.target, chain: opts.chain, log });
} catch (err) {
  // Deterministic failure (unreadable tree, missing prompt file): still emit a valid, empty SARIF log.
  log(`audit failed: ${err.stack || err}`);
  sarif = buildSarif({
    chain: opts.chain,
    findings: [],
    costUsd: 0,
    notifications: [{ level: 'error', message: `audit failed: ${err.message}` }],
  });
  sarif.runs[0].invocations[0].executionSuccessful = false;
}
fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
fs.writeFileSync(opts.out, `${JSON.stringify(sarif, null, 2)}\n`);
log(`wrote ${opts.out}`);
