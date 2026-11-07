import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RemediationService } from '../remediation/service.mjs';
import { workspaceAdapters } from '../remediation/workspace.mjs';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { checkArtifact } from '../remediation/checks.mjs';
import { appendRecords, readLedger } from '../lib/ledger.mjs';
import { sha256 } from '../incident-investigation/core.mjs';
const findingExample = JSON.parse(await readFile('.claude/schemas/v1/soc/record.schema.json', 'utf8')).examples.find((x) => x.kind === 'finding');
const taskExample = JSON.parse(await readFile('.claude/schemas/v1/change-management/task.schema.json', 'utf8')).examples[0];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'maxwell-remediation-'));
  const finding = structuredClone(findingExample); const task = structuredClone(taskExample);
  finding.target = { type: 'repo', appId: 'test-app', repoId: 'test-repo' };
  const companyId = finding.companyId; task.companyId = companyId; task.targets = [finding.target];
  const checkout = join(root, 'applications', finding.target.appId, 'repos', finding.target.repoId);
  await mkdir(checkout, { recursive: true });
  const gitEnv = { ...process.env }; for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR']) delete gitEnv[key];
  const git = (...args) => execFileSync('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', ...args], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  await writeFile(join(checkout, 'settings.json'), '{"tls":{"verify":true}}'); git('add', '.'); git('commit', '-m', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const taskDir = join(root, 'company-profile', companyId, 'change_management/initiatives', task.initiativeId, 'tasks');
  await mkdir(taskDir, { recursive: true }); await writeFile(join(taskDir, `${task.taskId}.json`), JSON.stringify(task));
  assert.deepEqual(appendRecords(companyId, [finding], { root }).problems, []);
  const store = new ExportStateStore({ root, sessionId: 'ses_verification123' });
  const options = { store, ...workspaceAdapters(root), authorize: async (session, co, permission) => {
    if (co !== companyId || !['engineer', 'reviewer'].includes(session) || (permission === 'remediation.close' && session !== 'reviewer')) throw Error('not authorized');
    return { id: session, companyId: co };
  } };
  const service = new RemediationService(options);
  const request = { session: 'engineer', companyId, findingId: finding.id, initiativeId: task.initiativeId, taskId: task.taskId,
    check: { type: 'json-field-equals', version: 1, path: 'settings.json', field: ['tls', 'verify'], expected: true }, revision };
  return { root, checkout, git, service, store, options, request, companyId, task, finding };
}
test('real revision-bound check → independent closure → schema-validated superseding finding', async () => {
  const f = await setup(); try {
    const opened = await f.service.open(f.request);
    const verified = await f.service.verify({ session: 'engineer', companyId: f.companyId, id: opened.value.id, expectedRevision: 1 });
    assert.equal(verified.value.state, 'verified');
    const closed = await f.service.close({ session: 'reviewer', companyId: f.companyId, id: opened.value.id, expectedRevision: 2, criteriaHash: verified.value.criteriaHash, note: 'All acceptance criteria reviewed' });
    assert.equal(closed.value.state, 'closed');
    const ledger = readLedger(f.companyId, f.root); assert.equal(ledger.length, 2); assert.equal(ledger[1].status, 'resolved'); assert.equal(ledger[1].supersedes, f.finding.id);
    assert.equal((await new ExportStateStore({ root: f.root, sessionId: 'ses_verification123' }).get(f.companyId, opened.value.id)).revision, 4);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('dirty targets, failed assertions, stale reviewers and unauthorized actors cannot close', async () => {
  const f = await setup(); try {
    await assert.rejects(f.service.open({ ...f.request, session: 'outsider' }), /authorized/);
    const opened = await f.service.open(f.request);
    await writeFile(join(f.checkout, 'settings.json'), '{"tls":{"verify":false}}');
    const invalid = await f.service.verify({ session: 'engineer', companyId: f.companyId, id: opened.value.id, expectedRevision: 1 });
    assert.equal(invalid.value.state, 'inconclusive');
    await assert.rejects(f.service.close({ session: 'reviewer', companyId: f.companyId, id: opened.value.id, expectedRevision: 2 }), /conflict/);
    assert.equal(readLedger(f.companyId, f.root).length, 1);
    f.git('checkout', '--', 'settings.json');
    const run = await f.service.verify({ session: 'engineer', companyId: f.companyId, id: opened.value.id, expectedRevision: 2 });
    await assert.rejects(f.service.close({ session: 'engineer', companyId: f.companyId, id: opened.value.id, expectedRevision: run.revision, criteriaHash: run.value.criteriaHash, note: 'self' }), /authorized/);
    const fail = await checkArtifact({ checkout: f.checkout, revision: f.request.revision, check: { ...f.request.check, expected: false } }); assert.equal(fail.outcome, 'failed');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('journal CAS rejects concurrent writes and detects corrupt revisions', async () => {
  const f = await setup(); try {
    const result = await Promise.allSettled([f.store.change(f.companyId, 'same', null, { a: 1 }), f.store.change(f.companyId, 'same', null, { a: 2 })]);
    assert.equal(result.filter((x) => x.status === 'fulfilled').length, 1);
    const current = await f.store.get(f.companyId, 'same');
    await assert.rejects(f.store.change(f.companyId, 'same', null, {}), /conflict/);
    assert.equal(current.digest.length, 64);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('lost closure acknowledgement is reconciled without duplicate ledger records', async () => {
  const f = await setup(); try {
    const opened = await f.service.open(f.request); const v = await f.service.verify({ session: 'engineer', companyId: f.companyId, id: opened.value.id, expectedRevision: 1 });
    let lost = true; const publish = f.options.publish;
    f.service.publish = async (input) => { await publish(input); if (lost) { lost = false; throw Error('ack lost'); } };
    const input = { session: 'reviewer', companyId: f.companyId, id: opened.value.id, expectedRevision: v.revision, criteriaHash: v.value.criteriaHash, note: 'Reviewed criteria' };
    await assert.rejects(f.service.close(input), /ack lost/);
    const pending = await f.store.get(f.companyId, opened.value.id);
    assert.equal((await f.service.close({ ...input, expectedRevision: pending.revision })).value.state, 'closed');
    assert.equal(readLedger(f.companyId, f.root).length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
