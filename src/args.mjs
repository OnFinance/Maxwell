// Command-line parsing for bin/audit.mjs. Pure: no I/O.
import { CHAINS } from './taxonomy.mjs';

export const USAGE = 'usage: node bin/audit.mjs --target <dir> --chain ethereum|solana --out <file>';

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const name = { '--target': 'target', '--chain': 'chain', '--out': 'out' }[arg];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!name) throw new Error(`unknown argument: ${arg}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    }
    opts[name] = value;
  }
  for (const key of ['target', 'chain', 'out']) {
    if (!opts[key]) throw new Error(`missing required --${key}`);
  }
  opts.chain = opts.chain.toLowerCase();
  if (!CHAINS.includes(opts.chain)) throw new Error(`--chain must be one of ${CHAINS.join(', ')}`);
  return opts;
}
