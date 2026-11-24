import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRecords } from '../lib/ledger.mjs';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { ProductLifecycle } from '../product-lifecycle/service.mjs';
import { productWorkspace } from '../product-lifecycle/workspace.mjs';

async function example(path, select = (schema) => schema.examples[0]) {
  return structuredClone(select(JSON.parse(await readFile(path, 'utf8'))));
}

const companyId = 'arthveda-securities';
const application = 'trading-gateway';
const repository = 'trading-gateway-api';
const environment = 'qa';
const baseRevision = 'a'.repeat(40);
const findingId = 'fnd_01J7Q3V8K2M4N6P8R0S2T4V6X9';
const initiativeId = 'init_01M0EXSEJ04P58EWQQZTMMGYWY';
const taskId = 'task_1';
const suggestionId = 'sug_01M0KTP6M0GSB53TM0315NTTZW';
const check = {
  version: 1,
  type: 'json-field-equals',
  path: 'settings.json',
  field: ['tls'],
  expected: true,
};
const files = [{ path: 'settings.json', content: '{"tls":false}' }];

async function writeJson(root, path, value) {
  const file = join(root, path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(value) + '\n');
}

async function workspaceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'maxwell-product-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [finding, initiativeMaster, task, suggestionMaster, repo, env] = await Promise.all([
    example('.claude/schemas/v1/soc/record.schema.json', (schema) =>
      schema.examples.find((item) => item.kind === 'finding'),
    ),
    example('.claude/schemas/v1/change-management/master.schema.json'),
    example('.claude/schemas/v1/change-management/task.schema.json'),
    example('.claude/schemas/v1/suggestions/master.schema.json'),
    example('.claude/schemas/v1/application/repo.schema.json'),
    example('.claude/schemas/v1/application/environment.schema.json'),
  ]);
  finding.companyId = companyId;
  finding.target = { type: 'repo', appId: application, repoId: repository, envId: environment };
  finding.location = { path: check.path };
  const initiative = initiativeMaster.initiatives[0];
  initiative.findingIds = [finding.id];
  initiative.targets = [{ type: 'repo', appId: application, repoId: repository, envId: environment }];
  task.targets = initiative.targets;
  const suggestion = suggestionMaster.suggestions[0];
  suggestion.findingIds = [finding.id];
  repo.appId = application;
  repo.repoId = repository;
  repo.localCheckout = `applications/${application}/repos/${repository}`;
  env.appId = application;
  env.envId = environment;
  env.tier = 'qa';
  env.changeFreeze = [];
  await Promise.all([
    writeJson(root, `company-profile/${companyId}/change_management/master.json`, initiativeMaster),
    writeJson(
      root,
      `company-profile/${companyId}/change_management/initiatives/${initiativeId}/tasks/${taskId}.json`,
      task,
    ),
    writeJson(root, `company-profile/${companyId}/suggestions/master.json`, suggestionMaster),
    writeJson(root, `applications/${application}/repos/${repository}.json`, repo),
    writeJson(root, `applications/${application}/env/${environment}.json`, env),
  ]);
  assert.deepEqual(appendRecords(companyId, [finding], { root }).problems, []);
  return { root, finding, initiativeMaster, task, suggestionMaster, repo, env };
}

const releaseInput = {
  companyId,
  findingId,
  initiativeId,
  taskId,
  suggestionId,
  application,
  repository,
  environment,
};

test('workspace validates relationships and freezes derived release context', async (t) => {
  const fixture = await workspaceFixture(t);
  const adapter = productWorkspace(fixture.root, () => Date.parse('2026-03-01T00:00:00Z'));
  const context = await adapter.loadReleaseContext(releaseInput);
  assert.equal(context.candidateRevision, fixture.suggestionMaster.suggestions[0].repos[0].mergeCommit);
  assert.deepEqual(context.approvedChecks, [...fixture.repo.branchProtection.statusChecks].sort());
  assert(Object.isFrozen(context));
  assert(Object.isFrozen(context.finding.target));
  assert(Object.isFrozen(context.approvedChecks));
  assert.throws(() => context.approvedChecks.push('ci/other'), TypeError);

  fixture.task.suggestionIds = [];
  await writeJson(
    fixture.root,
    `company-profile/${companyId}/change_management/initiatives/${initiativeId}/tasks/${taskId}.json`,
    fixture.task,
  );
  await assert.rejects(adapter.loadReleaseContext(releaseInput), /task does not match/);
});

test('workspace rejects active freezes and repositories without approved checks', async (t) => {
  const fixture = await workspaceFixture(t);
  fixture.env.changeFreeze = [
    {
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-02T00:00:00Z',
      reason: 'Quarter close',
    },
  ];
  await writeJson(fixture.root, `applications/${application}/env/${environment}.json`, fixture.env);
  await assert.rejects(
    productWorkspace(fixture.root, () => Date.parse('2026-03-01T12:00:00Z')).loadReleaseContext(
      releaseInput,
    ),
    /change freeze/,
  );
  fixture.env.changeFreeze = [];
  fixture.repo.branchProtection.statusChecks = [];
  await Promise.all([
    writeJson(fixture.root, `applications/${application}/env/${environment}.json`, fixture.env),
    writeJson(fixture.root, `applications/${application}/repos/${repository}.json`, fixture.repo),
  ]);
  await assert.rejects(
    productWorkspace(fixture.root).loadReleaseContext(releaseInput),
    /approved CI checks/,
  );
});

async function serviceFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maxwell-product-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const finding = await example('.claude/schemas/v1/soc/record.schema.json', (schema) =>
    schema.examples.find((item) => item.kind === 'finding'),
  );
  finding.companyId = companyId;
  finding.target = { type: 'repo', appId: application, repoId: repository, envId: environment };
  finding.location = { path: check.path };
  const candidateRevision = 'b'.repeat(40);
  const trace = [];
  const context = {
    finding: { id: finding.id },
    initiative: { initiativeId },
    task: { taskId },
    suggestion: { suggestionId },
    repository: { appId: application, repoId: repository },
    environment: { appId: application, envId: environment, tier: 'qa' },
    candidateRevision,
    approvedChecks: ['ci/build', 'ci/test'],
  };
  const service = new ProductLifecycle({
    store: new ExportStateStore({ root, sessionId: 'ses_productrelease' }),
    authorize: async (_session, selectedCompany) => ({ id: 'engineer', companyId: selectedCompany }),
    load: async () => structuredClone(files),
    loadFinding: async () => structuredClone(finding),
    loadReleaseContext: async () => structuredClone(context),
    verifyChecks: async (operation) => {
      trace.push(['checks', operation.candidateRevision, operation.checks]);
      return {
        revision: options.failChecks ? 'c'.repeat(40) : candidateRevision,
        checks: operation.checks.map((name) => ({ name, outcome: 'passed' })),
      };
    },
    verifyRuntime: async (operation) => {
      trace.push([`verify-${operation.phase}`, operation.candidateRevision]);
      return operation.phase === 'before'
        ? { outcome: 'reproduced', revision: baseRevision }
        : {
            outcome: options.failVerification ? 'failed' : 'passed',
            revision: candidateRevision,
            candidateSha256: operation.plan.candidateSha256,
          };
    },
    deploy: async (operation) => {
      trace.push(['deploy', operation.candidateRevision]);
      return { revision: candidateRevision, candidateSha256: operation.plan.candidateSha256 };
    },
    recover: async (operation) => {
      trace.push(['rollback', operation.baseRevision]);
      return { outcome: 'restored', revision: baseRevision };
    },
    investigate: async (operation) => {
      trace.push(['investigate', operation.candidateRevision, operation.outcome]);
    },
    ...(options.collectEvidence
      ? {
          collectEvidence: async (selected) => {
            trace.push([`evidence-${selected.phase}`, selected.revision]);
            return {
              environment: selected.environment,
              revision: selected.revision,
              complete: false,
              collections: [
                {
                  provider: 'logs',
                  revision: selected.revision,
                  complete: false,
                  signals: [],
                  gaps: ['Bounded test fixture.'],
                },
              ],
            };
          },
        }
      : {}),
  });
  const prepared = await service.start({
    session: 'engineer',
    companyId,
    application,
    repository,
    environment,
    revision: baseRevision,
    check,
    requestId: options.requestId ?? 'release-0001',
    findingId: finding.id,
  });
  return { service, prepared, trace, candidateRevision };
}

const serviceReleaseInput = {
  session: 'engineer',
  companyId,
  initiativeId,
  taskId,
  suggestionId,
};

test('managed release gates and verifies the exact merged revision', async (t) => {
  const fixture = await serviceFixture(t);
  const released = await fixture.service.release({
    ...serviceReleaseInput,
    id: fixture.prepared.key,
    expectedRevision: fixture.prepared.revision,
  });
  assert.equal(released.value.state, 'recovered');
  assert.equal(released.value.releaseContext.candidateRevision, fixture.candidateRevision);
  assert.deepEqual(
    fixture.trace.map((item) => item[0]),
    ['checks', 'verify-before', 'deploy', 'verify-after'],
  );
  assert.equal(released.value.result.deployment.revision, fixture.candidateRevision);
  assert.equal(released.value.result.recovery.revision, fixture.candidateRevision);
});

test('managed release records optional evidence for the base and candidate revisions', async (t) => {
  const fixture = await serviceFixture(t, { collectEvidence: true, requestId: 'release-evidence' });
  const released = await fixture.service.release({
    ...serviceReleaseInput,
    id: fixture.prepared.key,
    expectedRevision: fixture.prepared.revision,
  });
  assert.deepEqual(
    fixture.trace.filter((item) => item[0].startsWith('evidence-')),
    [
      ['evidence-before', baseRevision],
      ['evidence-after', fixture.candidateRevision],
    ],
  );
  assert.deepEqual(released.value.result.evidence.map((item) => item.phase), ['before', 'after']);
});

test('failed checks block deployment; failed revision-bound verification rolls back and investigates', async (t) => {
  const blocked = await serviceFixture(t, { failChecks: true, requestId: 'release-0002' });
  const blockedResult = await blocked.service.release({
    ...serviceReleaseInput,
    id: blocked.prepared.key,
    expectedRevision: blocked.prepared.revision,
  });
  assert.equal(blockedResult.value.state, 'blocked');
  assert.deepEqual(blocked.trace.map((item) => item[0]), ['checks']);

  const failed = await serviceFixture(t, { failVerification: true, requestId: 'release-0003' });
  const failedResult = await failed.service.release({
    ...serviceReleaseInput,
    id: failed.prepared.key,
    expectedRevision: failed.prepared.revision,
  });
  assert.equal(failedResult.value.state, 'rolled-back');
  assert.deepEqual(
    failed.trace.map((item) => item[0]),
    ['checks', 'verify-before', 'deploy', 'verify-after', 'rollback', 'investigate'],
  );
  assert.deepEqual(failedResult.value.result.investigation, {
    requested: true,
    acknowledged: true,
  });
});
