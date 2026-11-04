import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseService } from '../incident-response/service.mjs';
import { MicrosoftResponseProvider, microsoftTargetResolver } from '../incident-response/microsoft.mjs';
import { DynamoDbResponseStore } from '../incident-response/store.mjs';
import { createCase } from '../incident-investigation/core.mjs';
import { normalizeDefenderAlert } from '../threat-detection/microsoft-adapter.mjs';
import { microsoftClientCredentials } from '../threat-detection/microsoft-auth.mjs';

const companyId = 'example-co';
const tenantId = '11111111-2222-3333-4444-555555555555';
const machineId = 'a'.repeat(40);
const providerActionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const time = Date.parse('2026-11-04T00:00:00.000Z');

function setup({ executionEnabled = true } = {}) {
  const f = { now: time, failPost: false, postCount: 0, accepted: null, records: new Map(), failAfterClaim: false, policyAllowed: true };
  f.source = { id: 'provider-alert', tenantId, serviceSource: 'microsoftDefenderForEndpoint', title: 'Suspicious process', severity: 'high',
    createdDateTime: new Date(time).toISOString(), lastUpdateDateTime: new Date(time).toISOString(),
    evidence: [{ '@odata.type': '#microsoft.graph.security.deviceEvidence', mdeDeviceId: machineId, onboardingStatus: 'onboarded' }] };
  f.case = { ...createCase(normalizeDefenderAlert(f.source, { companyId, tenantId }), time), status: 'confirmed', confirmedIncidentId: 'inc_test' };
  const getToken = async ({ tenantId: requested }) => ({ tenantId: requested, accessToken: 'test-token' });
  f.fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.startsWith('https://graph.microsoft.com/')) return new Response(JSON.stringify(f.source));
    if (options.method === 'POST') {
      f.postCount++;
      const body = JSON.parse(options.body);
      f.accepted = { id: providerActionId, machineId, type: url.endsWith('/unisolate') ? 'Unisolate' : 'Isolate',
        scope: body.IsolationType, requestorComment: body.Comment, status: 'Pending' };
      if (f.failPost) throw new Error('response lost after provider accepted');
      return new Response(JSON.stringify(f.accepted), { status: 201 });
    }
    return new Response(JSON.stringify(f.accepted));
  };
  f.store = {
    create: async (r, c) => { assert.equal(c.revision, f.case.revision); f.records.set(r.responseId, structuredClone(r)); },
    get: async (c, id) => structuredClone(f.records.get(id)?.proposal.companyId === c ? f.records.get(id) : null),
    change: async (old, next, c) => {
      if (f.records.get(old.responseId).revision !== old.revision || (c && c.revision !== f.case.revision)) throw new Error('revision conflict');
      if (f.failAfterClaim && old.state === 'executing') throw new Error('database unavailable');
      f.records.set(old.responseId, structuredClone(next));
    },
  };
  const authorize = async (session, company, permission) => {
    const allowed = { requester: ['response.request', 'response.read', 'response.cancel'], approver: ['response.approve', 'response.read', 'response.cancel'], worker: ['response.execute', 'response.reconcile', 'response.read'] };
    if (company !== companyId || !allowed[session]?.includes(permission)) throw new Error('not authorized');
    return { id: session, companyId: company };
  };
  f.options = { store: f.store, caseStore: { getCase: async (c, id) => c === companyId && id === f.case.caseId ? structuredClone(f.case) : null },
    authorize, policy: async () => f.policyAllowed, resolveTarget: microsoftTargetResolver({ getToken, fetchImpl: f.fetchImpl }),
    provider: new MicrosoftResponseProvider({ getToken, fetchImpl: f.fetchImpl, clock: () => f.now }), executionEnabled, clock: () => f.now };
  f.service = new ResponseService(f.options);
  f.request = (extra = {}) => f.service.request({ session: 'requester', companyId, caseId: f.case.caseId, machineId, providerAlertId: 'provider-alert', action: 'isolate', reason: 'Confirmed compromise', ...extra });
  f.decide = (r, extra = {}) => f.service.decide({ session: 'approver', companyId, responseId: r.responseId, expectedRevision: r.revision, digest: r.digest, decision: 'approve', ...extra });
  f.execute = (r, extra = {}) => f.service.execute({ session: 'worker', companyId, responseId: r.responseId, expectedRevision: r.revision, ...extra });
  f.reconcile = (r, extra = {}) => f.service.reconcile({ session: 'worker', companyId, responseId: r.responseId, expectedRevision: r.revision, providerActionId, ...extra });
  return f;
}

test('confirmed case → independent approval → submission → provider success, with separate release approval', async () => {
  const f = setup();
  const requested = await f.request();
  assert.equal(f.postCount, 0);
  const approved = await f.decide(requested);
  const submitted = await f.execute(approved);
  assert.equal(submitted.state, 'submitted');
  assert.equal(f.postCount, 1);
  f.accepted.status = 'Succeeded';
  const done = await f.reconcile(submitted);
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.timeline.map((e) => e.state), ['requested', 'approved', 'executing', 'submitted', 'succeeded']);
  const release = await f.request({ action: 'unisolate', reason: 'Remediation verified' });
  await assert.rejects(f.execute(release), /approval/);
  assert.equal((await f.execute(await f.decide(release))).state, 'submitted');
  assert.equal(f.accepted.type, 'Unisolate');
  assert.equal(f.postCount, 2);
});

test('authorization fails closed and caller cannot supply their own roles or another company', async () => {
  const f = setup();
  await assert.rejects(f.request({ session: { id: 'admin', roles: ['response.request'] } }), /authorized/);
  await assert.rejects(f.request({ companyId: 'other' }), /authorized/);
  const r = await f.request();
  await assert.rejects(f.decide(r, { session: 'requester' }), /authorized/);
  await assert.rejects(f.execute(r, { session: 'approver' }), /authorized/);
  assert.equal(f.postCount, 0);
});

test('same person with both permissions cannot approve own request', async () => {
  const f = setup();
  f.service = new ResponseService({ ...f.options, authorize: async () => ({ companyId, id: 'same-person' }) });
  const r = await f.request();
  await assert.rejects(f.decide(r), /requester cannot/i);
});

test('review digest, case revision, provider evidence and policy must still match', async () => {
  const f = setup();
  const r = await f.request();
  await assert.rejects(f.decide(r, { digest: 'b'.repeat(64) }), /changed/);
  f.case.revision++;
  await assert.rejects(f.decide(r), /case changed/);
  f.case.revision--;
  f.source.lastUpdateDateTime = '2026-11-04T00:01:00.000Z';
  await assert.rejects(f.decide(r), /snapshot/);
  f.source.lastUpdateDateTime = new Date(time).toISOString();
  f.policyAllowed = false;
  await assert.rejects(f.decide(r), /policy denied/);
  assert.equal(f.postCount, 0);
});

test('unconfirmed cases and devices outside provider evidence cannot request actions', async () => {
  const f = setup();
  f.case.status = 'open';
  await assert.rejects(f.request(), /confirmed/);
  f.case.status = 'confirmed';
  await assert.rejects(f.request({ machineId: 'b'.repeat(40) }), /not in case evidence/);
  await assert.rejects(f.request({ action: 'run-script' }), /action/);
});

test('expiry, cancellation, denial and default execution disablement prevent POST', async () => {
  const f = setup({ executionEnabled: false });
  const approved = await f.decide(await f.request());
  await assert.rejects(f.execute(approved), /disabled/);
  f.service = new ResponseService({ ...f.options, executionEnabled: true });
  f.now += 900001;
  assert.equal((await f.execute(approved)).state, 'expired');
  const cancelled = await f.decide(await f.request(), { decision: 'cancel' });
  await assert.rejects(f.execute(cancelled), /approval/);
  const denied = await f.decide(await f.request(), { decision: 'deny' });
  await assert.rejects(f.execute(denied), /approval/);
  assert.equal(f.postCount, 0);
});

test('concurrent execution uses one durable claim and only one POST', async () => {
  const f = setup();
  const approved = await f.decide(await f.request());
  const results = await Promise.allSettled([f.execute(approved), f.execute(approved)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.postCount, 1);
});

test('lost provider response never retries POST and can reconcile by correlated action ID', async () => {
  const f = setup();
  f.failPost = true;
  const unknown = await f.execute(await f.decide(await f.request()));
  assert.equal(unknown.state, 'unknown');
  await assert.rejects(f.execute(unknown), /approval/);
  f.accepted.status = 'Succeeded';
  assert.equal((await f.reconcile(unknown)).state, 'succeeded');
  assert.equal(f.postCount, 1);
});

test('lost post-submission database write survives service restart without repeating action', async () => {
  const f = setup();
  const approved = await f.decide(await f.request());
  f.failAfterClaim = true;
  await assert.rejects(f.execute(approved), /database/);
  f.service = new ResponseService(f.options);
  const stranded = await f.service.read({ session: 'worker', companyId, responseId: approved.responseId });
  assert.equal(stranded.state, 'executing');
  await assert.rejects(f.execute(stranded), /approval/);
  f.failAfterClaim = false;
  assert.equal((await f.reconcile(stranded)).state, 'submitted');
  assert.equal(f.postCount, 1);
});

test('reconciliation rejects unrelated provider action, device and comment', async () => {
  const f = setup();
  const submitted = await f.execute(await f.decide(await f.request()));
  for (const field of ['machineId', 'requestorComment', 'type']) {
    const saved = f.accepted[field]; f.accepted[field] = 'unrelated';
    await assert.rejects(f.reconcile(submitted), /does not match/);
    f.accepted[field] = saved;
  }
  assert.equal(f.postCount, 1);
});

test('DynamoDB response state and immutable audit are transactional and guard case revision', async () => {
  const f = setup();
  const record = await f.request();
  const commands = [];
  const store = new DynamoDbResponseStore({ tableName: 'test', documentClient: { send: async (cmd) => { commands.push(cmd.input); return {}; } } });
  await store.create(record, f.case);
  const tx = commands[0].TransactItems;
  assert.equal(tx.length, 3);
  assert.match(tx[0].Put.ConditionExpression, /attribute_not_exists/);
  assert.match(tx[1].Put.ConditionExpression, /attribute_not_exists/);
  assert.equal(tx[2].ConditionCheck.ExpressionAttributeValues[':revision'], f.case.revision);
  await store.change(record, { ...record, revision: 2, state: 'approved' }, f.case);
  assert.match(commands[1].TransactItems[0].Put.ConditionExpression, /revision = :revision AND #state = :state/);
  assert.equal(commands[1].TransactItems[0].Put.ExpressionAttributeValues[':state'], 'requested');
  assert.equal(tx[0].Put.Item.expiresAt, undefined);
  assert.equal(tx[1].Put.Item.expiresAt, undefined);
});

test('lost execution claim acknowledgment never sends a POST', async () => {
  const f = setup();
  const approved = await f.decide(await f.request());
  const change = f.store.change;
  f.store.change = async (...args) => { await change(...args); throw new Error('claim acknowledgment lost'); };
  await assert.rejects(f.execute(approved), /acknowledgment/);
  assert.equal(f.records.get(approved.responseId).state, 'executing');
  assert.equal(f.postCount, 0);
});

test('provider 429 is unknown, never automatically retried', async () => {
  const f = setup();
  let posts = 0;
  const provider = new MicrosoftResponseProvider({ clock: () => f.now,
    getToken: async () => ({ tenantId, accessToken: 'test' }), fetchImpl: async () => { posts++; return new Response('', { status: 429 }); } });
  f.service = new ResponseService({ ...f.options, provider });
  const unknown = await f.execute(await f.decide(await f.request()));
  assert.equal(unknown.state, 'unknown');
  await assert.rejects(f.execute(unknown));
  assert.equal(posts, 1);
});

test('response credential is bound to tenant and expiry is rechecked after token acquisition', async () => {
  const f = setup();
  let posts = 0;
  const provider = new MicrosoftResponseProvider({ clock: () => f.now,
    getToken: async () => { f.now += 900001; return { tenantId, accessToken: 'test' }; },
    fetchImpl: async () => { posts++; throw new Error('must not execute'); } });
  f.service = new ResponseService({ ...f.options, provider });
  assert.equal((await f.execute(await f.decide(await f.request()))).state, 'unknown');
  assert.equal(posts, 0);
  const other = setup();
  other.service = new ResponseService({ ...other.options, provider: new MicrosoftResponseProvider({ clock: () => other.now,
    getToken: async () => ({ tenantId: 'other-tenant', accessToken: 'test' }),
    fetchImpl: async () => { posts++; throw new Error('must not execute'); } }) });
  assert.equal((await other.execute(await other.decide(await other.request()))).state, 'unknown');
  assert.equal(posts, 0);
});

test('Defender action audience uses securitycenter while calls use security.microsoft.com', async () => {
  const f = setup();
  const getToken = microsoftClientCredentials({ tenantId, clientId: tenantId, clientSecret: 'test', resource: 'https://api.securitycenter.microsoft.com',
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('scope'), 'https://api.securitycenter.microsoft.com/.default');
      return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'test', expires_in: 3600 }));
    } });
  f.service = new ResponseService({ ...f.options, provider: new MicrosoftResponseProvider({ getToken, clock: () => f.now, fetchImpl: f.fetchImpl }) });
  assert.equal((await f.execute(await f.decide(await f.request()))).state, 'submitted');
  await assert.rejects(getToken({ tenantId, scope: 'https://graph.microsoft.com/.default' }), /scope mismatch/);
});
