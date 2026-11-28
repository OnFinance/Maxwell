import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { audit } from '../src/audit.mjs';
import { discover, isDeclarationOnlySolidity } from '../src/discover.mjs';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const bin = path.join(here, '..', 'bin', 'audit.mjs');
const fake = path.join(fixtures, 'fake-claude.mjs');

test('discover keeps program sources and skips tests, interfaces and dependencies', () => {
  const eth = discover(path.join(fixtures, 'ethereum/vulnerable'), 'ethereum');
  assert.deepEqual(eth.files.map((f) => f.path), ['Vault.sol']);
  assert.deepEqual(eth.skipped, ['interfaces/IVault.sol']);
  const sol = discover(path.join(fixtures, 'solana/vulnerable'), 'solana');
  assert.deepEqual(sol.files.map((f) => f.path), ['src/lib.rs']);
  const single = discover(path.join(fixtures, 'ethereum/vulnerable/Vault.sol'), 'ethereum');
  assert.equal(single.root, path.join(fixtures, 'ethereum/vulnerable'));
  assert.deepEqual(single.files.map((f) => f.path), ['Vault.sol']);
  // A tree whose only sources live under an out-of-scope folder is still audited.
  const onlyTests = discover(path.join(fixtures, 'ethereum/vulnerable/test'), 'ethereum');
  assert.deepEqual(onlyTests.files.map((f) => f.path), ['Vault.t.sol']);
  assert.equal(isDeclarationOnlySolidity('interface I { function f() external; }'), true);
  assert.equal(isDeclarationOnlySolidity('// contract X\nlibrary L { }'), false);
});

const fakeRunner = (calls, { refute = false } = {}) => async (args) => {
  calls.push(args);
  if (args.systemPrompt.startsWith('# Adversarial refuter')) {
    return { ok: true, costUsd: 0.02, output: { verdicts: [{ id: 0, verdict: refute ? 'refuted' : 'confirmed', confidence: 0.9, severity: 'high', reason: 'r' }] } };
  }
  return {
    ok: true,
    costUsd: 0.05,
    output: {
      findings: [{
        file: 'Vault.sol', startLine: 15, endLine: 15, category: 'reentrancy', severity: 'high', title: 'Reentrancy',
        description: 'd', exploitScenario: 'e', remediation: 'r', confidence: 0.9,
      }],
    },
  };
};

test('audit reviews, refutes and reports confirmed findings within budget', async () => {
  const calls = [];
  const sarif = await audit({
    target: path.join(fixtures, 'ethereum/vulnerable'),
    chain: 'ethereum',
    env: { MAXWELL_EVAL_BUDGET_USD: '2' },
    runner: fakeRunner(calls),
  });
  assert.equal(calls.length, 2);
  const caps = calls.reduce((s, c) => s + c.budgetUsd, 0);
  assert.ok(caps <= 2, `sum of caps ${caps} within budget`);
  const run = sarif.runs[0];
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].properties.category, 'reentrancy');
  assert.ok(Math.abs(run.properties.costUsd - 0.07) < 1e-9);
});

test('audit reports nothing when the refuter refutes or fails', async () => {
  const refuted = await audit({
    target: path.join(fixtures, 'ethereum/vulnerable'), chain: 'ethereum', env: {}, runner: fakeRunner([], { refute: true }),
  });
  assert.equal(refuted.runs[0].results.length, 0);
  const failing = async (args) => (args.systemPrompt.startsWith('# Adversarial')
    ? { ok: false, costUsd: 0.01, error: 'boom' }
    : fakeRunner([])(args));
  const failed = await audit({ target: path.join(fixtures, 'ethereum/vulnerable'), chain: 'ethereum', env: {}, runner: failing });
  assert.equal(failed.runs[0].results.length, 0);
  assert.ok(failed.runs[0].invocations[0].toolExecutionNotifications.some((n) => /boom/.test(n.message.text)));
});

test('bin/audit.mjs writes SARIF end to end with a stand-in claude CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxwell-web3-test-'));
  const env = { ...process.env, MAXWELL_CLAUDE_BIN: fake, MAXWELL_EVAL_BUDGET_USD: '1' };
  try {
    for (const [chain, target, category, line] of [
      ['ethereum', 'ethereum/vulnerable', 'reentrancy', 15],
      ['solana', 'solana/vulnerable', 'signer_authorization', 15],
    ]) {
      const out = path.join(dir, `${chain}.sarif`);
      await exec(process.execPath, [bin, '--target', path.join(fixtures, target), '--chain', chain, '--out', out], { env });
      const sarif = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(sarif.version, '2.1.0');
      const results = sarif.runs[0].results;
      assert.equal(results.length, 1, `${chain}: low-severity candidate dropped, high one confirmed`);
      assert.equal(results[0].properties.category, category);
      assert.equal(results[0].locations[0].physicalLocation.region.startLine, line);
      assert.ok(sarif.runs[0].properties.costUsd > 0);
    }
    // Refuter rejects everything: success with no findings.
    const out = path.join(dir, 'clean.sarif');
    await exec(process.execPath, [bin, '--target', path.join(fixtures, 'ethereum/vulnerable'), '--chain', 'ethereum', '--out', out], {
      env: { ...env, FAKE_CLAUDE_MODE: 'refute-all' },
    });
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).runs[0].results.length, 0);
    // Missing CLI: still exit 0 with an empty, valid log.
    const none = path.join(dir, 'none.sarif');
    await exec(process.execPath, [bin, '--target', path.join(fixtures, 'solana/vulnerable'), '--chain', 'solana', '--out', none], {
      env: { ...env, MAXWELL_CLAUDE_BIN: path.join(dir, 'no-such-claude') },
    });
    const empty = JSON.parse(fs.readFileSync(none, 'utf8'));
    assert.equal(empty.runs[0].results.length, 0);
    assert.equal(empty.runs[0].properties.costUsd, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bin/audit.mjs exits 2 on bad arguments', async () => {
  await assert.rejects(exec(process.execPath, [bin, '--chain', 'ethereum']), (err) => err.code === 2);
});
