// Assemble prompts from the agent and skill files kept in this repo.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fileHints, legacyArithmetic } from './hints.mjs';
import { TAXONOMY } from './taxonomy.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function readRepoFile(rel) {
  return fs.readFileSync(`${ROOT}${rel}`, 'utf8');
}

export function loadSchema(name) {
  const schema = JSON.parse(readRepoFile(`schemas/${name}.schema.json`));
  delete schema.$schema;
  delete schema.$id;
  return schema;
}

/** Render a file with right-aligned line numbers so reviewers can cite exact lines. */
export function numbered(text) {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join('\n');
}

export function renderSources(files) {
  return files.map((f) => `===== FILE: ${f.path} (${f.lines} lines) =====\n${numbered(f.text)}`).join('\n\n');
}

export function renderHints(chain, files) {
  const parts = [];
  for (const f of files) {
    const hints = fileHints(chain, f.text);
    const grouped = new Map();
    for (const h of hints) {
      if (!grouped.has(h.label)) grouped.set(h.label, []);
      grouped.get(h.label).push(h.line);
    }
    const rows = [...grouped].map(([label, lines]) => `  - ${label}: lines ${lines.slice(0, 20).join(', ')}`);
    if (chain === 'ethereum' && legacyArithmetic(f.text)) {
      rows.unshift('  - compiler < 0.8: arithmetic wraps silently unless SafeMath (or equivalent) is used');
    }
    if (rows.length) parts.push(`${f.path}\n${rows.join('\n')}`);
  }
  return parts.join('\n') || '(none)';
}

export function reviewerSystemPrompt(chain) {
  return [
    readRepoFile(`agents/${chain}-reviewer.md`),
    '\n\n# Checklist\n\n',
    readRepoFile(`skills/${chain}-checklist.md`),
    '\n\n# Allowed categories\n\n',
    TAXONOMY[chain].join(', '),
  ].join('');
}

export function refuterSystemPrompt(chain) {
  return [
    readRepoFile('agents/refuter.md'),
    '\n\n# Checklist the reviewer used\n\n',
    readRepoFile(`skills/${chain}-checklist.md`),
    '\n\n# Allowed categories\n\n',
    TAXONOMY[chain].join(', '),
  ].join('');
}

export function reviewerPrompt(chain, files) {
  return [
    `Audit the following ${chain === 'ethereum' ? 'Solidity' : 'Solana (Rust)'} source files.`,
    'Report only vulnerabilities you can tie to concrete lines and a concrete exploit. Return an empty list if none.',
    '',
    '## Deterministic pre-analysis hints (signals, not findings)',
    renderHints(chain, files),
    '',
    '## Source',
    renderSources(files),
  ].join('\n');
}

export function refuterPrompt(chain, files, candidates) {
  const list = candidates.map((c, id) => ({
    id,
    file: c.file,
    startLine: c.startLine,
    endLine: c.endLine,
    category: c.category,
    severity: c.severity,
    title: c.title,
    description: c.description,
    exploitScenario: c.exploitScenario,
  }));
  return [
    `Try to refute each candidate ${chain} finding below. Return exactly one verdict per candidate id.`,
    '',
    '## Candidates',
    JSON.stringify(list, null, 2),
    '',
    '## Source',
    renderSources(files),
  ].join('\n');
}
