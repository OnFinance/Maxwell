import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditExportPaths, writeAuditBundle } from '../security-audit/exports.mjs';

const source = readFileSync('.claude/workflows/execute-scr.js', 'utf8').replace(/^export const meta =/m, 'const meta =');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('args', 'agent', 'pipeline', 'parallel', 'phase', 'log', source);
const evidence = [{ type: 'workspace-file', ref: 'applications/demo/repos/api/routes.js' }];
const finding = { title: 'Cross-tenant read', description: 'Unchecked account owner', severity: 'high', confidence: 'confirmed', area: 'V8', ruleId: 'asvs-v8-idor', location: { path: 'routes.js', startLine: 10 }, dataFlow: 'request.id -> lookup', evidence, regulatoryRefs: [{ regulator: 'owasp', instrument: 'owasp-asvs-5.0', controlId: 'V8.2.2' }] };
async function run(options = {}) {
  const calls = []; const ledgers = []; let bundle; let verificationCount = 0;
  const root = await mkdtemp(path.join(tmpdir(), 'maxwell-workflow-'));
  const agent = async (prompt, opts) => {
    calls.push(opts);
    if (opts.label === 'scout') return { companyId: 'example-co', repos: [{ appId: 'demo', repoId: 'api', recordPath: 'applications/demo/repos/api.json', localCheckout: options.noSource ? undefined : 'applications/demo/repos/api', pinnedCommit: 'a'.repeat(40), exposure: 'internet', dataClassification: [] }], devEnvironments: [], policyFound: true, policySummary: '', skipped: [] };
    if (opts.agentType === 'security-recon') return { surfaces: [{ subsystem: 'api', boundary: 'tenant', attackClasses: ['authorization-object-access'], evidence: ['routes.js'] }], skipped: [] };
    if (opts.agentType === 'secure-code-reviewer') return { findings: options.clean ? [] : [structuredClone(finding)], observations: [{ title: 'Auth check', description: 'Reviewed route', area: 'V8', result: 'partial', evidence, regulatoryRefs: finding.regulatoryRefs }], skipped: options.skipped ? [{ target: 'routes', reason: 'parser unavailable' }] : [] };
    if (opts.agentType === 'refuter') return { refuted: false, reason: 'Trace checked', checked: options.noRefuterEvidence ? [] : ['routes.js:10'], unverifiable: [] };
    if (opts.agentType === 'security-record-verifier') return options.noVerifier ? null : { passed: !(options.reject || (options.conflict && ++verificationCount === 2)), reason: 'Source checked', verifier: 'fresh-agent', checked: ['routes.js:10'] };
    if (opts.agentType === 'security-coverage-critic') return options.noCritic ? null : { gaps: [] };
    if (opts.agentType === 'security-audit-state-writer') {
      bundle = JSON.parse(prompt.slice(prompt.indexOf('Bundle: ') + 8));
      if (options.exportFailure) return null;
      await writeAuditBundle(bundle, { root });
      return { written: options.wrongPaths ? ['wrong', 'paths', 'cannot', 'pass', 'validation'] : Object.values(auditExportPaths(bundle.sessionId)), validated: true };
    }
    if (opts.agentType === 'soc-ledger-keeper' && opts.label.startsWith('ledger')) {
      const data = JSON.parse(prompt.split('Candidate records (already refuted): ')[1].split('\nRules:')[0]);
      ledgers.push(data);
      return { controlsAppended: 0, observationsAppended: data.observations.length, findingsAppended: data.findings.length, observationIds: data.observations.map((_, i) => `obs_${i}`), findingIds: data.findings.map((_, i) => `fnd_${i}`), supersededFindingIds: [], skipped: [] };
    }
    if (opts.label === 'version') return { written: '' };
    if (opts.label === 'report') return { sectionsUpdated: [], sectionsSkipped: [], openFindings: 0 };
    if (['sdlc-auditor', 'devenv-auditor'].includes(opts.agentType)) return { observations: [], findings: [], skipped: [] };
    throw Error(`unexpected agent ${opts.agentType}: ${opts.label}`);
  };
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, index) => { let value = item; for (const stage of stages) value = await stage(value, item, index); return value; }));
  try {
    const result = await execute({ companyId: 'example-co', sessionId: 'test-session', runId: 'run_test', ...options.args }, agent, pipeline, (jobs) => Promise.all(jobs.map((job) => job())), () => {}, () => {});
    return { result, calls, ledgers, bundle };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('actual workflow executes recon, hunting, independent gates, critic, validated exports and ledger in order', async () => {
  const { result, calls, bundle, ledgers } = await run();
  assert.equal(result.securityAudit.complete, true);
  assert.equal(bundle.finalRecords.records[0].verdict, 'confirmed');
  assert.equal(result.scr.findings, 1);
  assert.equal(ledgers[0].findings.length, 1);
  assert.ok(calls.findIndex((c) => c.label === 'audit exports') < calls.findIndex((c) => c.label.startsWith('ledger')));
  assert.equal(bundle.run.callsUsed, result.securityAudit.callsUsed);
});

test('every small budget is respected and still funds incomplete exports and unrelated inline checks', async () => {
  for (let budget = 1; budget <= 10; budget += 1) {
    const { result, calls, bundle } = await run({ args: { securityAuditBudget: budget } });
    assert.ok(result.securityAudit.callsUsed <= budget, `budget ${budget}`);
    assert.ok(bundle, `export at budget ${budget}`);
    assert.ok(calls.some((c) => c.agentType === 'sdlc-auditor'));
    if (budget < 7) assert.equal(result.securityAudit.complete, false);
  }
});

test('missing independent evidence or failed exports never publishes a secure-code finding', async () => {
  for (const options of [{ noVerifier: true }, { noRefuterEvidence: true }, { exportFailure: true }, { wrongPaths: true }]) {
    const { result, bundle } = await run(options);
    assert.equal(result.scr.findings, 0);
    assert.equal(result.securityAudit.complete, false);
    if (!options.exportFailure && !options.wrongPaths) assert.equal(bundle.finalRecords.records[0].verdict, 'needs_validation');
  }
});

test('missing source, skipped work and missing critic cannot claim complete coverage', async () => {
  for (const options of [{ noSource: true }, { skipped: true }, { noCritic: true }]) {
    const { result, bundle } = await run(options);
    assert.equal(result.securityAudit.complete, false);
    assert.equal(bundle.run.runStatus, 'incomplete');
  }
});

test('source contradiction is rejected and retained in exports without a finding', async () => {
  const { result, bundle } = await run({ reject: true });
  assert.equal(result.scr.findings, 0);
  assert.equal(bundle.finalRecords.records[0].verdict, 'rejected');
});

test('deep executes two independent passes and deduplicates the final finding', async () => {
  const { result, calls } = await run({ args: { securityAuditProfile: 'deep' } });
  assert.equal(calls.filter((c) => c.agentType === 'secure-code-reviewer').length, 2);
  assert.equal(result.securityAudit.coverage.length, 2);
  assert.equal(result.scr.findings, 1);
});

test('dry-run cannot publish audit exports or findings or claim completion', async () => {
  const { result, bundle } = await run({ args: { dryRun: true } });
  assert.equal(bundle, undefined);
  assert.equal(result.scr.findings, 0);
  assert.equal(result.securityAudit.complete, false);
});

test('invalid profiles and budgets are rejected before any audit calls', async () => {
  await assert.rejects(run({ args: { securityAuditBudget: 0 } }), /invalid securityAuditBudget/);
  await assert.rejects(run({ args: { securityAuditProfile: 'unknown' } }), /invalid securityAuditProfile/);
});

 test('conflicting independent passes cannot publish a finding through dedup order', async () => {
  const { result, bundle } = await run({ conflict: true, args: { securityAuditProfile: 'deep' } });
  assert.equal(result.scr.findings, 0);
  assert.equal(result.securityAudit.complete, false);
  assert.equal(bundle.finalRecords.records[0].verdict, 'needs_validation');
  assert.equal(bundle.run.runStatus, 'incomplete');
});
