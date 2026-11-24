import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { ArtexVerificationService, normalizeVerificationScope } from '../artex/service.mjs';
import { runArtex } from '../artex/run.mjs';

const companyId = 'example-co';
const findingId = 'fnd_01J7Q3V8K2M4N6P8R0S2T4V6X9';
const revision = 'a'.repeat(40);
const scope = {
  companyId,
  application: 'portal',
  environment: 'qa',
  tier: 'qa',
  findingId,
  fingerprint: 'artex:portal:missing-auth',
  expectedRevision: revision,
  goal: 'Verify the original finding no longer reproduces.',
  urls: ['https://qa.example.test/'],
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maxwell-artex-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-11-24T10:00:00Z');
  let currentScope = structuredClone(scope);
  let executions = 0;
  let release;
  const wait = options.wait
    ? new Promise((resolve) => {
        release = resolve;
      })
    : null;
  const service = new ArtexVerificationService({
    store: new ExportStateStore({ root, sessionId: 'ses_artexverify1' }),
    authorize: async (_session, selectedCompany) => ({ id: 'host:ciso', companyId: selectedCompany }),
    loadScope: async () => structuredClone(currentScope),
    verifyAuthorization: async ({ scopeSha256 }) => ({
      id: 'auth:ticket-42',
      approvedBy: 'ciso@example.test',
      authorizedAt: '2026-11-24T09:00:00.000Z',
      validUntil: options.expired ? '2026-11-24T09:30:00.000Z' : '2026-11-24T12:00:00.000Z',
      documentRef: 'ticket:SEC-42',
      documentSha256: 'b'.repeat(64),
      scopeSha256,
    }),
    executor: async ({ scope: selected }) => {
      executions++;
      if (wait) await wait;
      return {
        outcome: options.outcome ?? 'not-reproduced',
        findingId: selected.findingId,
        fingerprint: selected.fingerprint,
        revision: options.wrongRevision ? 'c'.repeat(40) : selected.expectedRevision,
        evidence: [
          { ref: 'evidence:artex-result', sha256: 'd'.repeat(64), summary: 'Bounded verification result.' },
        ],
      };
    },
    clock: () => now,
  });
  return {
    service,
    executions: () => executions,
    expire: () => {
      now = Date.parse('2026-11-24T13:00:00Z');
    },
    changeScope: () => {
      currentScope.urls = ['https://other.example.test/'];
    },
    release: () => release?.(),
  };
}

const request = {
  session: 'ciso',
  companyId,
  requestId: 'verify-42',
  authorizationRef: 'ticket:SEC-42',
  application: scope.application,
  environment: scope.environment,
  findingId,
  fingerprint: scope.fingerprint,
  expectedRevision: revision,
};

test('persists trusted authorization before one revision-bound verification', async (t) => {
  const f = await fixture(t);
  const prepared = await f.service.prepare(request);
  assert.equal(prepared.value.state, 'authorized');
  assert.equal(prepared.value.scope.mode, 'verification-only');
  assert.equal(prepared.value.authorization.documentSha256, 'b'.repeat(64));
  assert.equal(JSON.stringify(prepared).includes('password'), false);
  const done = await f.service.execute({
    session: 'operator',
    companyId,
    id: prepared.key,
    expectedRevision: prepared.revision,
  });
  assert.equal(done.value.state, 'completed');
  assert.equal(done.value.result.outcome, 'not-reproduced');
  assert.equal(f.executions(), 1);
  await assert.rejects(
    f.service.execute({ session: 'operator', companyId, id: prepared.key, expectedRevision: done.revision }),
    /not executable/,
  );
  assert.equal(f.executions(), 1);
});

test('expiry and scope drift fail before the broker executes', async (t) => {
  for (const change of ['expire', 'changeScope']) {
    const f = await fixture(t);
    const prepared = await f.service.prepare({ ...request, requestId: `verify-${change}` });
    f[change]();
    await assert.rejects(
      f.service.execute({ session: 'operator', companyId, id: prepared.key, expectedRevision: 1 }),
      /expired|scope changed/,
    );
    assert.equal(f.executions(), 0);
  }
  const expired = await fixture(t, { expired: true });
  await assert.rejects(expired.service.prepare(request), /invalid, expired, or outside scope/);
});

test('invalid broker output is recorded as failure and concurrent claims execute once', async (t) => {
  const invalid = await fixture(t, { wrongRevision: true });
  const prepared = await invalid.service.prepare(request);
  const failed = await invalid.service.execute({ session: 'operator', companyId, id: prepared.key, expectedRevision: 1 });
  assert.equal(failed.value.state, 'failed');
  assert.match(failed.value.result.reason, /revision-bound/);

  const concurrent = await fixture(t, { wait: true });
  const ready = await concurrent.service.prepare({ ...request, requestId: 'verify-concurrent' });
  const first = concurrent.service.execute({ session: 'operator', companyId, id: ready.key, expectedRevision: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    concurrent.service.execute({ session: 'operator', companyId, id: ready.key, expectedRevision: 1 }),
    /revision conflict/,
  );
  concurrent.release();
  await first;
  assert.equal(concurrent.executions(), 1);
});

test('scope is HTTPS, non-production and verification-only; direct runner stays disabled', async () => {
  assert.equal(normalizeVerificationScope(scope).mode, 'verification-only');
  assert.throws(() => normalizeVerificationScope({ ...scope, tier: 'prod' }), /non-production/);
  assert.throws(() => normalizeVerificationScope({ ...scope, urls: ['http://qa.example.test'] }), /HTTPS/);
  await assert.rejects(runArtex({}), /Direct ARTEX execution is disabled/);
});
