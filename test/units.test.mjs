import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.mjs';
import { Budget, budgetFromEnv } from '../src/budget.mjs';
import { claudeArgs, parseEnvelope } from '../src/claude.mjs';
import { applyVerdicts, dedupeFindings, normaliseFindings, resolveFile } from '../src/findings.mjs';
import { fileHints, legacyArithmetic, riskScore } from '../src/hints.mjs';
import { batchesWithinBudget, makeBatches } from '../src/plan.mjs';
import { loadSchema, numbered, refuterSystemPrompt, reviewerPrompt, reviewerSystemPrompt } from '../src/prompts.mjs';
import { buildSarif } from '../src/sarif.mjs';
import { normaliseCategory, normaliseSeverity, sarifLevel, TAXONOMY } from '../src/taxonomy.mjs';

const files = [
  { path: 'src/A.sol', text: 'a\nb\nc\nd\ne\n', lines: 6 },
  { path: 'src/nested/B.sol', text: 'x\ny\n', lines: 3 },
];

test('parseArgs accepts the evaluation contract and rejects bad input', () => {
  assert.deepEqual(parseArgs(['--target', '/t', '--chain', 'Solana', '--out', 'o.json']), {
    target: '/t', chain: 'solana', out: 'o.json',
  });
  assert.equal(parseArgs(['--target=/t', '--chain=ethereum', '--out=o']).chain, 'ethereum');
  assert.throws(() => parseArgs(['--target', '/t', '--chain', 'bitcoin', '--out', 'o']), /chain/);
  assert.throws(() => parseArgs(['--target', '/t', '--chain', 'ethereum']), /--out/);
  assert.throws(() => parseArgs(['--target', '--chain', 'ethereum']), /missing value/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unknown/);
});

test('taxonomy normalisation and SARIF levels', () => {
  assert.equal(normaliseCategory('ethereum', 'Unchecked Low-Level Calls'), 'unchecked_low_level_calls');
  assert.equal(normaliseCategory('ethereum', 'signer_authorization'), 'other');
  assert.equal(normaliseCategory('solana', 'pda sharing'), 'pda_sharing');
  assert.equal(normaliseSeverity('HIGH'), 'high');
  assert.equal(normaliseSeverity('info'), 'informational');
  assert.equal(normaliseSeverity('bogus'), 'informational');
  assert.equal(sarifLevel('critical'), 'error');
  assert.equal(sarifLevel('medium'), 'warning');
  assert.equal(sarifLevel('low'), 'note');
});

test('budget reservations never exceed the usable total', () => {
  const b = new Budget(1);
  assert.equal(b.usable, 0.9);
  const a = b.reserve(0.6);
  const c = b.reserve(0.6);
  assert.equal(a, 0.6);
  assert.ok(Math.abs(c - 0.3) < 1e-9);
  assert.equal(b.reserve(0.5), 0);
  b.settle(a, 0.1);
  assert.ok(Math.abs(b.available - 0.5) < 1e-9);
  assert.equal(budgetFromEnv({ MAXWELL_EVAL_BUDGET_USD: '2.5' }), 2.5);
  assert.equal(budgetFromEnv({}, 7), 7);
});

test('claudeArgs passes the budget cap and disables tools', () => {
  const args = claudeArgs({ systemPrompt: 's', schema: { type: 'object' }, budgetUsd: 0.5, model: 'opus' });
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.5000');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('parseEnvelope reads structured output, cost and errors', () => {
  const ok = parseEnvelope(JSON.stringify({ total_cost_usd: 0.2, structured_output: { findings: [] } }));
  assert.deepEqual(ok, { ok: true, costUsd: 0.2, output: { findings: [] } });
  const fromText = parseEnvelope(JSON.stringify({ total_cost_usd: 0.1, result: 'here: {"findings":[]}' }));
  assert.equal(fromText.ok, true);
  const err = parseEnvelope(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.3 }));
  assert.equal(err.ok, false);
  assert.equal(err.costUsd, 0.3);
  assert.equal(parseEnvelope('garbage').ok, false);
});

test('normaliseFindings resolves files, clamps lines and drops junk', () => {
  assert.equal(resolveFile('./src/A.sol', files).path, 'src/A.sol');
  assert.equal(resolveFile('B.sol', files).path, 'src/nested/B.sol');
  assert.equal(resolveFile('C.sol', files), undefined);
  const out = normaliseFindings('ethereum', [
    { file: 'src/A.sol', startLine: 2, endLine: 99, category: 'Reentrancy', severity: 'High', title: 't' },
    { file: 'src/A.sol', startLine: 50, endLine: 51, category: 'reentrancy', severity: 'high', title: 't' },
    { file: 'missing.sol', startLine: 1, endLine: 1, title: 't' },
    { file: 'src/A.sol', startLine: 3, endLine: 1, category: 'weird', title: 'u' },
    null,
  ], files);
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].startLine, out[0].endLine, out[0].category, out[0].severity], [2, 6, 'reentrancy', 'high']);
  assert.deepEqual([out[1].endLine, out[1].category, out[1].severity], [3, 'other', 'informational']);
  assert.ok(out[0].exploitScenario && out[0].remediation);
});

test('dedupeFindings keeps the most severe of nearby duplicates', () => {
  const base = { file: 'a.sol', category: 'reentrancy', title: 't', confidence: 0.5 };
  const out = dedupeFindings([
    { ...base, startLine: 10, endLine: 10, severity: 'medium' },
    { ...base, startLine: 12, endLine: 13, severity: 'high' },
    { ...base, startLine: 40, endLine: 40, severity: 'high' },
    { ...base, category: 'arithmetic', startLine: 10, endLine: 10, severity: 'high' },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out.find((f) => f.startLine === 12).severity, 'high');
});

test('applyVerdicts keeps only confident confirmations and applies corrections', () => {
  const cands = normaliseFindings('ethereum', [
    { file: 'src/A.sol', startLine: 1, endLine: 1, category: 'reentrancy', severity: 'high', title: 'a' },
    { file: 'src/A.sol', startLine: 2, endLine: 2, category: 'reentrancy', severity: 'high', title: 'b' },
    { file: 'src/A.sol', startLine: 3, endLine: 3, category: 'reentrancy', severity: 'high', title: 'c' },
    { file: 'src/A.sol', startLine: 4, endLine: 4, category: 'reentrancy', severity: 'high', title: 'd' },
  ], files);
  const out = applyVerdicts('ethereum', cands, [
    { id: 0, verdict: 'confirmed', confidence: 0.9, severity: 'medium', category: 'access_control', startLine: 5, endLine: 5 },
    { id: 1, verdict: 'refuted', confidence: 0.9, severity: 'high' },
    { id: 2, verdict: 'confirmed', confidence: 0.3, severity: 'high' },
  ], files);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].title, out[0].severity, out[0].category, out[0].startLine], ['a', 'medium', 'access_control', 5]);
});

test('hints flag security-relevant lines and legacy compilers', () => {
  const sol = 'pragma solidity ^0.4.24;\n// tx.origin in a comment\nfunction f() { require(tx.origin == owner); msg.sender.call.value(1)(); }\n';
  const labels = fileHints('ethereum', sol).map((h) => `${h.line}:${h.label}`);
  assert.ok(labels.includes('3:tx.origin'));
  assert.ok(labels.includes('3:low-level call'));
  assert.ok(!labels.some((l) => l.startsWith('2:')));
  assert.equal(legacyArithmetic(sol), true);
  assert.equal(legacyArithmetic('pragma solidity >=0.8.0 <0.9.0;'), false);
  assert.ok(riskScore('ethereum', sol) >= 3);
  const rs = 'let a = next_account_info(iter)?; // AccountInfo\nfn f(a: AccountInfo<\'a>) { invoke(&ix, &[a])?; }';
  assert.deepEqual(fileHints('solana', rs).map((h) => h.line), [2, 2]);
});

test('makeBatches splits by size and budget limits batch count', () => {
  const big = (p, n) => ({ path: p, text: 'x'.repeat(n), lines: 1 });
  const batches = makeBatches('ethereum', [big('a/1.sol', 60), big('a/2.sol', 60), big('b/3.sol', 10)], { maxChars: 100 });
  assert.equal(batches.length, 2);
  assert.equal(batches.flatMap((b) => b.files).length, 3);
  assert.equal(batchesWithinBudget(batches, 0.5).length, 1);
  assert.equal(batchesWithinBudget(batches, 10).length, 2);
  assert.equal(batchesWithinBudget(batches, 0).length, 1, 'always attempts the riskiest batch');
});

test('prompts load repo agent and skill files and number source lines', () => {
  for (const chain of ['ethereum', 'solana']) {
    const sys = reviewerSystemPrompt(chain);
    for (const cat of TAXONOMY[chain]) assert.ok(sys.includes(cat), `${chain} prompt lists ${cat}`);
    assert.ok(refuterSystemPrompt(chain).startsWith('# Adversarial refuter'));
  }
  assert.equal(numbered('a\nb'), '1| a\n2| b');
  const p = reviewerPrompt('ethereum', [{ path: 'X.sol', text: 'pragma solidity 0.6.0;\nx.call{value: 1}("");', lines: 2 }]);
  assert.match(p, /FILE: X\.sol/);
  assert.match(p, /compiler < 0\.8/);
  assert.equal(loadSchema('findings').type, 'object');
  assert.equal(loadSchema('verdicts').$schema, undefined);
});

test('buildSarif emits a SARIF 2.1.0 log with the required result properties', () => {
  const sarif = buildSarif({
    chain: 'solana',
    costUsd: 0.1234567,
    findings: [{
      file: 'src/lib.rs', startLine: 3, endLine: 4, category: 'owner_checks', severity: 'high', title: 'T',
      description: 'D', exploitScenario: 'E', remediation: 'R', confidence: 0.8,
    }],
  });
  assert.equal(sarif.version, '2.1.0');
  const run = sarif.runs[0];
  assert.equal(run.properties.costUsd, 0.123457);
  const r = run.results[0];
  assert.equal(r.level, 'error');
  assert.equal(r.message.text, 'T: D');
  assert.equal(r.locations[0].physicalLocation.artifactLocation.uri, 'src/lib.rs');
  assert.deepEqual(r.locations[0].physicalLocation.region, { startLine: 3, endLine: 4 });
  for (const k of ['category', 'severity', 'exploitScenario', 'remediation']) assert.ok(r.properties[k]);
  assert.equal(run.tool.driver.rules[r.ruleIndex].id, 'owner_checks');
});
