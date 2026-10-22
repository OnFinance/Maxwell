import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostSetting, settingValue } from '../lib/config.mjs';
import { resolveCredentials, configPaths } from '../lib/complianceos.mjs';
import { credentialsDir } from '../lib/sandbox/credentials.mjs';
import { loadExecutor, executorSource } from '../lib/sandbox/index.mjs';
import { loadPricing, resolveModel } from '../lib/pricing.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'maxwell-config-'));
const CLI = join(WORKSPACE, '.claude/scripts/config/config.mjs');
// A clean environment: no inherited Maxwell, model or ComplianceOS variables, and a host config file in a temp dir.
const cleanEnv = (dir, extra = {}) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(MAXWELL_|ANTHROPIC_DEFAULT_)/.test(k)));
  return { ...env, HOME: dir, MAXWELL_CONFIG_FILE: join(dir, 'config.json'), ...extra };
};
const run = (env, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: WORKSPACE, encoding: 'utf8', env });
  return { status: r.status, out: r.stdout + r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
};
const EXECUTOR = {
  schemaVersion: '1', kind: 'maxwell.company.executor', companyId: 'example-co',
  static: { provider: 'docker', network: 'none' }, runtime: { provider: 'none' },
  provenance: { harness: 'script', generatedAt: '2026-10-22T00:00:00Z' },
};

test('a host setting round-trips through set and get and records who set it', () => {
  const dir = tmp();
  try {
    const env = cleanEnv(dir);
    const set = run(env, 'set', 'models.map.sonnet', 'claude-opus-5-5', '--by', 'ops@example.com');
    assert.equal(set.status, 0, set.out);
    assert.equal(set.json.value, 'claude-opus-5-5');
    const get = run(env, 'get', 'models.map.sonnet');
    assert.deepEqual(get.json, { key: 'models.map.sonnet', value: 'claude-opus-5-5', source: 'file', env: 'ANTHROPIC_DEFAULT_SONNET_MODEL' });
    const file = join(dir, 'config.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(doc.updated['models.map.sonnet'].by, 'ops@example.com');
    assert.match(doc.updated['models.map.sonnet'].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const unset = run(env, 'unset', 'models.map.sonnet');
    assert.equal(unset.status, 0, unset.out);
    assert.equal(run(env, 'get', 'models.map.sonnet').json.source, 'unset');
    assert.equal(run(env, 'get', 'models.default').json.value, 'opus');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown keys and values that fail the schema are refused and leave the file untouched', () => {
  const dir = tmp();
  try {
    const env = cleanEnv(dir);
    assert.equal(run(env, 'set', 'models.map.sonnet', 'claude-sonnet-5').status, 0);
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    const refuse = (args, re) => { const r = run(env, ...args); assert.equal(r.status, 2, r.out); assert.match(r.json.message, re); };
    refuse(['set', 'models.map.gpt', 'x'], /unknown setting/);
    refuse(['set', 'models.map.sonnet', 'not a model id!'], /schema/);
    refuse(['set', 'pricing.file', 'relative/prices.json'], /absolute path/);
    refuse(['set', 'sandbox.credentialsDir', join(WORKSPACE, 'kpis')], /outside the workspace/);
    refuse(['set', 'complianceos.baseUrl', 'http://insecure.example'], /schema/);
    refuse(['set', 'models.default', '--ref', 'SOME_VAR'], /not a secret reference/);
    refuse(['set', 'models.default', 'opus', '--ref', 'SOME_VAR'], /exactly one/);
    refuse(['set', 'models.default'], /exactly one/);
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
    writeFileSync(join(dir, 'config.json'), '{ not json');
    assert.equal(run(env, 'set', 'models.default', 'opus').status, 2, 'a malformed file is reported, not replaced');
    assert.match(run(env, 'get').json.fileProblem, /not valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('secret-bearing settings take only a variable name, and no output ever shows the secret', () => {
  const dir = tmp();
  try {
    const secret = 'pw-7f3a9c1e-never-print';
    const env = cleanEnv(dir, { COS_LOGIN_PASSWORD: secret, COS_LOGIN_EMAIL: 'analyst@example.com' });
    const raw = run(env, 'set', 'complianceos.passwordRef', secret);
    assert.equal(raw.status, 2);
    assert.equal(raw.json.error, 'secret-value');
    assert.ok(!raw.out.includes(secret), 'a refused secret is not echoed');
    assert.ok(!existsSync(join(dir, 'config.json')), 'nothing was written');
    assert.equal(run(env, 'set', 'complianceos.passwordRef', '--ref', 'COS_LOGIN_PASSWORD').status, 0);
    assert.equal(run(env, 'set', 'complianceos.emailRef', '--ref', 'COS_LOGIN_EMAIL').status, 0);
    assert.equal(run(env, 'set', 'complianceos.passwordRef', '--ref', 'not-a-name').status, 2);
    const all = run(env, 'get');
    assert.equal(all.status, 0, all.out);
    assert.ok(!all.out.includes(secret), 'get shows no secret value');
    assert.ok(!readFileSync(join(dir, 'config.json'), 'utf8').includes(secret), 'the file holds no secret value');
    const pw = all.json.settings.find((s) => s.key === 'complianceos.passwordRef');
    assert.deepEqual(pw, { key: 'complianceos.passwordRef', ref: 'COS_LOGIN_PASSWORD', set: true, source: 'file', env: 'MAXWELL_COS_PASSWORD' });
    // The ComplianceOS client resolves the referenced variables in-process.
    const creds = resolveCredentials(env, undefined);
    assert.equal(creds.password, secret);
    assert.equal(creds.email, 'analyst@example.com');
    assert.equal(creds.source, 'env');
    // MAXWELL_COS_* set directly still win over a reference.
    assert.equal(resolveCredentials({ ...env, MAXWELL_COS_PASSWORD: 'direct' }, undefined).password, 'direct');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an environment variable wins over the host config file, which wins over the default', () => {
  const dir = tmp();
  try {
    const env = cleanEnv(dir);
    assert.equal(run(env, 'set', 'models.map.sonnet', 'claude-opus-5-5').status, 0);
    assert.equal(run(env, 'set', 'sandbox.credentialsDir', join(dir, 'sandbox')).status, 0);
    assert.equal(run(env, 'set', 'complianceos.credentialsFile', join(dir, 'cos.env')).status, 0);
    assert.equal(settingValue('models.map.sonnet', env), 'claude-opus-5-5');
    const over = { ...env, ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5', MAXWELL_SANDBOX_CREDENTIALS_DIR: join(dir, 'other') };
    assert.deepEqual(hostSetting('models.map.sonnet', over), { key: 'models.map.sonnet', value: 'claude-sonnet-5-5', source: 'env' });
    assert.equal(run(over, 'get', 'models.map.sonnet').json.source, 'env');
    assert.equal(credentialsDir(env), join(dir, 'sandbox'));
    assert.equal(credentialsDir(over), join(dir, 'other'));
    assert.equal(configPaths(env).credentials, join(dir, 'cos.env'));
    assert.equal(hostSetting('models.default', env).source, 'default');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('executor.file supplies a company executor from outside the workspace and must name the same company', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'executor.json');
    writeFileSync(file, JSON.stringify(EXECUTOR));
    const env = cleanEnv(dir, { MAXWELL_EXECUTOR_FILE: file });
    assert.deepEqual(executorSource('example-co', { root: WORKSPACE, env }), { path: file, override: true, source: 'env' });
    assert.equal(loadExecutor('example-co', { root: WORKSPACE, env }).static.provider, 'docker');
    assert.throws(() => loadExecutor('hdfc-amc', { root: WORKSPACE, env }), /is for company example-co/);
    assert.throws(() => loadExecutor('example-co', { root: WORKSPACE, env: { ...env, MAXWELL_EXECUTOR_FILE: join(dir, 'missing.json') } }), /does not exist/);
    assert.equal(executorSource('example-co', { root: WORKSPACE, env: cleanEnv(dir) }).override, false);
    const get = run(env, 'get', 'executor', '--company', 'example-co');
    assert.equal(get.json.source, 'executor.file (env)');
    const set = run(env, 'set', 'executor', '--company', 'example-co', '--from-file', file);
    assert.equal(set.status, 2, 'the company file is not written while an override supplies the executor');
    assert.equal(set.json.error, 'overridden');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('set executor validates the document and writes the company file atomically', () => {
  const dir = tmp();
  const target = join(WORKSPACE, 'company-profile', 'example-co', 'sdlc', 'executor.json');
  const existed = existsSync(target);
  const saved = existed ? readFileSync(target, 'utf8') : null;
  try {
    const env = cleanEnv(dir);
    const wrong = join(dir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ ...EXECUTOR, companyId: 'hdfc-amc' }));
    assert.equal(run(env, 'set', 'executor', '--company', 'example-co', '--from-file', wrong).json.error, 'invalid-value');
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ ...EXECUTOR, static: { provider: 'nowhere' } }));
    const r = run(env, 'set', 'executor', '--company', 'example-co', '--from-file', bad);
    assert.equal(r.status, 2);
    assert.match(r.json.message, /schema/);
    assert.equal(existsSync(target), existed, 'a refused executor writes nothing');
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(EXECUTOR));
    const ok = run(env, 'set', 'executor', '--company', 'example-co', '--from-file', good, '--by', 'ops');
    assert.equal(ok.status, 0, ok.out);
    const written = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(written.provenance.workflow, 'config');
    assert.match(written.provenance.agent, /\(ops\)$/);
    const v = spawnSync(process.execPath, ['.claude/scripts/validate-data.mjs', 'company-profile/example-co/sdlc/executor.json'], { cwd: WORKSPACE, encoding: 'utf8' });
    assert.equal(v.status, 0, v.stdout + v.stderr);
  } finally {
    if (existed) writeFileSync(target, saved); else rmSync(target, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pricing.file adds provider entries ahead of the built-in table', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'prices.json');
    writeFileSync(file, JSON.stringify({
      schemaVersion: '1', kind: 'maxwell.vocab.pricing', asOf: '2099-01-01', source: 'https://example.com/prices',
      models: [{ model: 'claude-opus-5', aliases: ['gateway-opus'], provider: 'anthropic', inputPerMTok: 1, outputPerMTok: 2, cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 1, cacheReadPerMTok: 0.1 }],
    }));
    const env = cleanEnv(dir, { MAXWELL_PRICING_FILE: file });
    const pricing = loadPricing(undefined, env);
    assert.equal(pricing.asOf, '2099-01-01');
    assert.equal(resolveModel(pricing, 'gateway-opus').inputPerMTok, 1);
    assert.equal(pricing.models.filter((m) => m.model === 'claude-opus-5').length, 1, 'the override replaces the built-in entry');
    assert.ok(resolveModel(pricing, 'haiku'), 'other built-in entries remain');
    writeFileSync(file, JSON.stringify({ models: [] }));
    assert.throws(() => loadPricing(undefined, env), /pricing schema/);
    assert.equal(loadPricing(undefined, cleanEnv(dir)).asOf, JSON.parse(readFileSync(join(WORKSPACE, '.claude/skills/kpi-extraction/references/pricing.json'), 'utf8')).asOf);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
