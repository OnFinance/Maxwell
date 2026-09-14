#!/usr/bin/env node
// Validates .claude/workflows/*.js against the Workflow-tool contract and the Maxwell workflow vocabulary:
// meta literal first, name == file, phases match phase() calls, no non-deterministic or IO APIs, valid syntax.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const problems = [];
const WF_DIR = '.claude/workflows';
const vocab = JSON.parse(readFileSync('.claude/schemas/vocab/workflows.schema.json', 'utf8')).enum;
const utility = new Set(['validate', 'kpis', 'seed-company', 'status', 'manual']);
const expected = vocab.filter((n) => !utility.has(n));

const BANNED = [
  [/\bDate\.now\s*\(/, 'Date.now() breaks resume; pass timestamps via args'],
  [/\bMath\.random\s*\(/, 'Math.random() breaks resume; vary prompts by index'],
  [/\bnew\s+Date\s*\(\s*\)/, 'argless new Date() breaks resume'],
  [/\bimport\s*\(/, 'dynamic import() is not available in workflow scripts'],
  [/\brequire\s*\(/, 'require() is not available in workflow scripts'],
  [/\bprocess\./, 'process is not available in workflow scripts'],
  [/\bfs\./, 'filesystem access is not available in workflow scripts'],
];

export function extractMeta(source) {
  const stripped = source.replace(/^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/, '');
  const m = /^export\s+const\s+meta\s*=\s*\{/.exec(stripped);
  if (!m) throw new Error('first statement must be `export const meta = {...}`');
  const start = stripped.indexOf('{', m.index);
  let depth = 0; let end = -1; let inStr = null;
  for (let i = start; i < stripped.length; i += 1) {
    const c = stripped[i];
    if (inStr) { if (c === '\\') { i += 1; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth += 1;
    if (c === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('unbalanced meta literal');
  const literal = stripped.slice(start, end + 1);
  if (/\$\{|\.\.\.|\bthis\b|=>|\bfunction\b|\(/.test(literal.replace(/'[^']*'|"[^"]*"/g, ''))) throw new Error('meta must be a pure object literal (no calls, spreads, functions or template interpolation)');
  return vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 100 });
}

const files = existsSync(WF_DIR) ? readdirSync(WF_DIR).filter((f) => f.endsWith('.js')).sort() : [];
const present = new Set(files.map((f) => f.replace(/\.js$/, '')));
for (const name of expected) if (!present.has(name)) problems.push(`${WF_DIR}/${name}.js is missing (listed in vocab/workflows.schema.json)`);
for (const name of present) if (!expected.includes(name)) problems.push(`${WF_DIR}/${name}.js is not in vocab/workflows.schema.json`);

for (const f of files) {
  const file = `${WF_DIR}/${f}`;
  const src = readFileSync(file, 'utf8');
  // Both runtimes (the Claude Code Workflow tool and run-workflow.mjs) execute the script as the body of an async
  // function with the documented globals, so a top-level `return` is legal there; syntax-check the same shape.
  const wrapped = '(async function workflowBody(agent, pipeline, parallel, phase, log, args, budget, workflow) {\n'
    + src.replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =') + '\n});\n';
  const check = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: wrapped, encoding: 'utf8' });
  if (check.status !== 0) { problems.push(`${file}: syntax error\n${check.stderr.trim()}`); continue; }
  let meta;
  try { meta = extractMeta(src); } catch (e) { problems.push(`${file}: ${e.message}`); continue; }
  const base = f.replace(/\.js$/, '');
  if (meta.name !== base) problems.push(`${file}: meta.name '${meta.name}' must equal '${base}'`);
  if (typeof meta.description !== 'string' || meta.description.length < 10 || meta.description.length > 200) problems.push(`${file}: meta.description must be a 10-200 char string`);
  const titles = Array.isArray(meta.phases) ? meta.phases.map((p) => p && p.title) : [];
  if (new Set(titles).size !== titles.length) problems.push(`${file}: duplicate phase titles in meta.phases`);
  const called = [...src.matchAll(/\bphase\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  for (const t of called) if (!titles.includes(t)) problems.push(`${file}: phase('${t}') has no matching meta.phases entry`);
  for (const [re, why] of BANNED) if (re.test(src)) problems.push(`${file}: ${why}`);
  if (!/\bagent\s*\(/.test(src)) problems.push(`${file}: workflow never calls agent()`);
  if (!/\breturn\b/.test(src)) problems.push(`${file}: workflow must return a result object`);
}

if (problems.length) {
  console.error(`validate:workflows FAILED (${problems.length})`);
  for (const p of problems) console.error('- ' + p);
  process.exit(2);
}
console.log(`validate:workflows OK (${files.length} workflows)`);
