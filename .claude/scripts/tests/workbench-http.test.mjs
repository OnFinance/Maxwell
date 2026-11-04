import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchFixture } from './workbench-fixture.mjs';
import { DynamoDbInvestigationStore } from '../incident-investigation/dynamodb-store.mjs';
import { DynamoDbResponseStore } from '../incident-response/store.mjs';

async function login(f, subject) {
  const start = await fetch(`${f.auth.origin}/auth/login`, { redirect: 'manual' });
  const url = new URL(start.headers.get('location')); url.searchParams.set('code', subject);
  const callback = await fetch(url, { redirect: 'manual', headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] } });
  assert.equal(callback.status, 302);
  const cookie = callback.headers.getSetCookie()[0].split(';')[0];
  const session = await (await fetch(`${f.auth.origin}/api/session`, { headers: { Cookie: cookie } })).json();
  return { cookie, ...session };
}
async function api(f, user, path, input, extra = {}) {
  const response = await fetch(`${f.auth.origin}${path}`, { headers: { Cookie: user.cookie, Origin: f.auth.origin,
    'X-CSRF-Token': user.csrf, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
  return { status: response.status, data: await response.json() };
}
async function confirm(f, user) {
  const path = `/api/companies/example-co/cases/${f.caseId}/actions`;
  for (const action of [{ type: 'start' }, { type: 'assign', owner: 'analyst' }, { type: 'add-evidence', ref: 'defender:review', sha256: 'b'.repeat(64), description: 'Analyst reviewed endpoint evidence' }, { type: 'confirm', category: 'malware', affectedDataClassifications: [] }]) {
    const result = await api(f, user, path, { ...action, expectedRevision: f.cases.get(f.caseId).revision });
    assert.equal(result.status, 200, JSON.stringify(result));
  }
}

test('HTTP sign-in → triage → evidence → ledger confirmation → independent response approval', async () => {
  const f = await workbenchFixture();
  try {
    const analyst = await login(f, 'analyst'); const approver = await login(f, 'approver');
    const list = await api(f, analyst, '/api/companies/example-co/cases');
    assert.equal(list.status, 200); assert.equal(list.data.items.length, 1);
    await confirm(f, analyst);
    assert.equal(f.incidents.size, 1); assert.equal(f.cases.get(f.caseId).status, 'confirmed');
    assert.ok(f.cases.get(f.caseId).timeline.slice(1).every((entry) => entry.actor === analyst.actorId));
    const requested = await api(f, analyst, '/api/companies/example-co/responses', { caseId: f.caseId, providerAlertId: 'provider-alert', machineId: f.machineId, action: 'isolate', reason: 'Confirmed compromise' });
    assert.equal(requested.status, 201);
    const r = requested.data;
    const approved = await api(f, approver, `/api/companies/example-co/responses/${r.responseId}/decision`, { expectedRevision: r.revision, digest: r.digest, decision: 'approve' });
    assert.equal(approved.status, 200); assert.equal(approved.data.state, 'approved');
    assert.equal(approved.data.approval.actor, approver.actorId);
    assert.equal((await api(f, analyst, `/api/companies/example-co/responses/${r.responseId}/execute`, { expectedRevision: 2 })).status, 404);
    assert.equal(analyst.executionEnabled, false);
  } finally { await f.close(); }
});

test('HTTP rejects missing sessions, tenant crossing, forged actor/roles, CSRF and viewer writes', async () => {
  const f = await workbenchFixture();
  try {
    assert.equal((await fetch(`${f.auth.origin}/api/companies/example-co/cases`)).status, 401);
    const analyst = await login(f, 'analyst'); const viewer = await login(f, 'viewer'); const outsider = await login(f, 'outsider');
    assert.equal((await api(f, outsider, `/api/companies/example-co/cases/${f.caseId}`)).status, 403);
    const path = `/api/companies/example-co/cases/${f.caseId}/actions`; const note = { type: 'note', expectedRevision: 1, text: 'Review' };
    assert.equal((await api(f, viewer, path, note)).status, 403);
    assert.equal((await api(f, analyst, path, { ...note, actor: 'admin' })).status, 400);
    assert.equal((await api(f, analyst, path, note, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await api(f, analyst, path, note, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await api(f, analyst, path, { ...note, type: 'complete-confirmation' })).status, 400);
    assert.equal(f.cases.get(f.caseId).revision, 1);
  } finally { await f.close(); }
});

test('HTTP handles stale revisions, input limits and logout without exposing backend errors', async () => {
  const f = await workbenchFixture();
  try {
    const user = await login(f, 'analyst'); const path = `/api/companies/example-co/cases/${f.caseId}/actions`;
    assert.equal((await api(f, user, path, { type: 'note', expectedRevision: 0, text: 'stale' })).status, 409);
    assert.equal((await api(f, user, path, { type: 'note', expectedRevision: 1, text: 'x'.repeat(17000) })).status, 413);
    assert.equal((await api(f, user, '/auth/logout', {})).status, 200);
    assert.equal((await api(f, user, '/api/session')).status, 401);
  } finally { await f.close(); }
});

test('HTTP refuses self-approval even when one person has both roles', async () => {
  const f = await workbenchFixture();
  try {
    const user = await login(f, 'dual'); await confirm(f, user);
    const { data: r } = await api(f, user, '/api/companies/example-co/responses', { caseId: f.caseId, providerAlertId: 'provider-alert', machineId: f.machineId, action: 'isolate', reason: 'Confirmed compromise' });
    assert.equal((await api(f, user, `/api/companies/example-co/responses/${r.responseId}/decision`, { expectedRevision: 1, digest: r.digest, decision: 'approve' })).status, 400);
    assert.equal(f.responses.get(r.responseId).state, 'requested');
  } finally { await f.close(); }
});

test('workbench assets have CSP, no caching and no inline scripts or data interpolation', async () => {
  const f = await workbenchFixture();
  try {
    const response = await fetch(f.auth.origin);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await response.text();
    assert.match(html, /script src="\/app.js" defer/);
    const script = await (await fetch(`${f.auth.origin}/app.js`)).text();
    assert.ok(!script.includes('innerHTML')); assert.ok(!script.includes('localStorage'));
    assert.ok(script.includes('textContent'));
  } finally { await f.close(); }
});

test('DynamoDB paginated listings keep cursors tenant-scoped and bounded', async () => {
  const calls = [];
  const client = { send: async (command) => { calls.push(command.input); return { Items: [] }; } };
  const cases = new DynamoDbInvestigationStore({ tableName: 'test', documentClient: client });
  const responses = new DynamoDbResponseStore({ tableName: 'test', documentClient: client });
  await cases.listCasesPage('example-co', `case_${'a'.repeat(32)}`);
  await responses.listPage('example-co', 'rsp_11111111-2222-3333-4444-555555555555');
  assert.equal(calls[0].Limit, 50); assert.equal(calls[0].ExclusiveStartKey.pk, 'INVESTIGATIONS#example-co');
  assert.equal(calls[1].Limit, 50); assert.equal(calls[1].ExclusiveStartKey.pk, 'RESPONSES#example-co');
  await assert.rejects(cases.listCasesPage('example-co', 'other-co#case_x'));
  await assert.rejects(responses.listPage('example-co', 'other-co#rsp_x'));
});
