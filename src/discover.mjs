// Deterministic project discovery: which source files of a target are in audit scope.
import fs from 'node:fs';
import path from 'node:path';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn']);

// Directories that hold dependencies, build output, tests or tooling rather than the audited program.
const OUT_OF_SCOPE = {
  ethereum: new Set([
    'lib', 'test', 'tests', 'mocks', 'mock', 'script', 'scripts', 'out', 'cache', 'artifacts', 'typechain',
    'typechain-types', 'broadcast', 'coverage', 'deps', 'dependencies', 'certora', 'echidna', 'fuzz', 'audits', 'docs',
  ]),
  solana: new Set([
    'target', 'test', 'tests', 'migrations', 'app', 'client', 'clients', 'sdk', 'js', 'ts', 'scripts', 'benches',
    'examples', 'fuzz', '.anchor', 'docs',
  ]),
};

const EXT = { ethereum: ['.sol'], solana: ['.rs'] };

const MAX_FILE_BYTES = 400_000;

function isTestFile(chain, rel) {
  const base = path.basename(rel);
  if (chain === 'ethereum') return /\.(t|s)\.sol$/.test(base);
  return base === 'build.rs';
}

function walk(root, chain, { skipOutOfScope }) {
  const found = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.has(entry.name)) continue;
        if (skipOutOfScope && OUT_OF_SCOPE[chain].has(entry.name.toLowerCase())) continue;
        stack.push(rel);
      } else if (entry.isFile() && EXT[chain].includes(path.extname(entry.name))) {
        if (skipOutOfScope && isTestFile(chain, rel)) continue;
        found.push(rel);
      }
    }
  }
  return found.sort();
}

/** True when a Solidity file declares no contract or library, i.e. only interfaces, types or constants. */
export function isDeclarationOnlySolidity(text) {
  const code = stripComments(text);
  return !/\b(contract|library)\s+[A-Za-z_$]/.test(code) || /^\s*$/.test(code);
}

export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/**
 * Discover in-scope source files.
 * @returns {{ root: string, files: Array<{ path: string, text: string, lines: number }>, skipped: string[] }}
 * `root` is the directory that SARIF URIs are relative to; `path` uses forward slashes.
 */
export function discover(target, chain) {
  const abs = path.resolve(target);
  const stat = fs.statSync(abs);
  let root = abs;
  let rels;
  if (stat.isFile()) {
    root = path.dirname(abs);
    rels = [path.basename(abs)];
  } else {
    rels = walk(abs, chain, { skipOutOfScope: true });
    // A target made only of files that look out of scope (say, a lone `test/` folder) is still audited.
    if (rels.length === 0) rels = walk(abs, chain, { skipOutOfScope: false });
  }
  const files = [];
  const skipped = [];
  for (const rel of rels) {
    const full = path.join(root, rel);
    let text;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) {
        skipped.push(rel);
        continue;
      }
      text = fs.readFileSync(full, 'utf8');
    } catch {
      skipped.push(rel);
      continue;
    }
    if (chain === 'ethereum' && rels.length > 1 && isDeclarationOnlySolidity(text)) {
      skipped.push(rel);
      continue;
    }
    files.push({ path: rel, text, lines: text.split('\n').length });
  }
  return { root, files, skipped };
}
