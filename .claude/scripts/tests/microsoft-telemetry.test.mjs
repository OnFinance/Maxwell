import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { normalizeEntraSignIn, normalizeDefenderAlert } from '../threat-detection/microsoft-adapter.mjs';
import { MicrosoftCollector } from '../threat-detection/microsoft-collector.mjs';
import { DetectionEngine } from '../threat-detection/engine.mjs';
import { InvestigationService } from '../incident-investigation/service.mjs';
import { microsoftClientCredentials } from '../threat-detection/microsoft-auth.mjs';
import { readMicrosoftJson } from '../threat-detection/microsoft-http.mjs';

const config = { companyId: 'example-co', tenantId: '11111111-2222-3333-4444-555555555555' };
const from = '2026-11-04T00:00:00.000Z';
const to = '2026-11-04T00:05:00.000Z';
const signIn = (n = 1) => ({ id: `event-${n}`, userId: 'user-1', createdDateTime: `2026-11-04T00:00:0${n}.000Z`, ipAddress: '192.0.2.1', status: { errorCode: n === 6 ? 0 : 50126 } });
const defender = () => ({ id: 'alert-1', tenantId: config.tenantId, serviceSource: 'microsoftDefenderForEndpoint',
  createdDateTime: from, lastUpdateDateTime: to, severity: 'high', title: 'Suspicious execution' });
const page = (value, next) => new Response(JSON.stringify({ value, ...(next ? { '@odata.nextLink': next } : {}) }));
const collector = (fetchImpl, extras = {}) => new MicrosoftCollector({ ...config, fetchImpl,
  getToken: async () => ({ tenantId: config.tenantId, accessToken: 'test-token' }), ...extras });

test('Entra events produce existing detections and valid investigation cases end to end', async () => {
  const engine = new DetectionEngine(config);
  const cases = new Map();
  const service = new InvestigationService({ store: { createCase: async (item) => { cases.set(item.caseId, item); return item; } }, clock: () => Date.parse(to) });
  const c = collector(async () => page(Array.from({ length: 6 }, (_, i) => signIn(i + 1)).reverse()));
  const events = [];
  await c.collect({ source: 'entra', from, to, deliver: async (event) => { events.push(event); } });
  // Graph is newest-first; the inbox orders events before feeding the in-memory engine.
  for (const event of events.sort((a, b) => a.eventTime.localeCompare(b.eventTime))) {
    for (const alert of engine.push(event, Date.parse(to))) await service.intake(alert);
  }
  assert.equal(cases.size, 2);
  assert.deepEqual([...cases.values()].map((c) => c.alert.recipeId).sort(), ['authentication-failure-burst', 'failure-then-success']);
  assert.ok([...cases.values()].every((c) => c.status === 'open' && c.companyId === config.companyId));
  assert.ok(!JSON.stringify(events).includes('192.0.2.1'));
});

test('Defender snapshots are candidates, deterministic and tenant isolated', () => {
  const record = defender();
  const alert = normalizeDefenderAlert(record, config);
  assert.equal(alert.status, 'candidate');
  assert.deepEqual(alert, normalizeDefenderAlert(record, config));
  assert.notEqual(alert.alertId, normalizeDefenderAlert(record, { ...config, companyId: 'other' }).alertId);
  assert.throws(() => normalizeDefenderAlert({ ...record, tenantId: 'other' }, config), /tenant mismatch/);
  assert.equal(normalizeDefenderAlert({ ...record, serviceSource: 'microsoftDefenderForOffice365' }, config), null);
  assert.throws(() => normalizeDefenderAlert({ ...record, severity: 'unknown' }, config), /severity/);
});

test('missing Entra outcome or identity fails closed; cross-tenant resource is legitimate', () => {
  assert.throws(() => normalizeEntraSignIn({ ...signIn(), status: {} }, config), /outcome/);
  assert.throws(() => normalizeEntraSignIn({ ...signIn(), userId: '' }, config), /user id/);
  assert.throws(() => normalizeEntraSignIn({ ...signIn(), ipAddress: '' }, config), /IP/);
  assert.throws(() => normalizeEntraSignIn({ ...signIn(), createdDateTime: '2026-02-30T00:00:00Z' }, config), /timestamp/);
  assert.equal(normalizeEntraSignIn({ ...signIn(), resourceTenantId: 'different' }, config).scopeId, config.tenantId);
});

test('oversized and malformed response bodies fail without exposing data', async () => {
  await assert.rejects(readMicrosoftJson(new Response('"private-content"'), 4), /oversized Microsoft/);
  await assert.rejects(readMicrosoftJson(new Response('private-content')), /invalid or oversized Microsoft/);
  await assert.rejects(collector(async () => new Response('null')).collect({ source: 'entra', from, to, deliver: async () => {} }), /collection response/);
});

test('pagination and throttling deliver all pages before returning checkpoint', async () => {
  let calls = 0;
  const waits = [];
  const delivered = [];
  const next = 'https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=next';
  const c = collector(async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    calls++;
    if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '1' } });
    return calls === 2 ? page([signIn()], next) : page([signIn(2)]);
  }, { sleep: async (ms) => { waits.push(ms); } });
  const result = await c.collect({ source: 'entra', from, to, deliver: async (r) => delivered.push(r) });
  assert.equal(result.checkpoint, to);
  assert.equal(result.pages, 2);
  assert.equal(delivered.length, 2);
  assert.deepEqual(waits, [1000]);
});

test('host/path injection and cycles never send bearer tokens to nextLink', async () => {
  for (const next of ['https://evil.example/steal', 'https://graph.microsoft.com/v1.0/users', 'https://user@graph.microsoft.com/v1.0/auditLogs/signIns']) {
    let calls = 0;
    const c = collector(async () => { calls++; return page([], next); });
    await assert.rejects(c.collect({ source: 'entra', from, to, deliver: async () => {} }), /unsafe/);
    assert.equal(calls, 1);
  }
  const c = collector(async (url) => page([], url));
  await assert.rejects(c.collect({ source: 'entra', from, to, deliver: async () => {} }), /cycle/);
});

test('delivery failure, invalid data, limits, auth failure never return checkpoint', async () => {
  for (const [c, deliver, pattern] of [
    [collector(async () => page([signIn()])), async () => { throw new Error('inbox unavailable'); }, /inbox/],
    [collector(async () => page([{}])), async () => {}, /sign-in id/],
    [collector(async () => page([signIn(), signIn(2)]), { maxRecords: 1 }), async () => {}, /limit/],
    [collector(async () => new Response('sensitive body', { status: 403 })), async () => {}, /HTTP 403/],
    [collector(async () => page([]), { getToken: async () => ({ tenantId: 'wrong', accessToken: 'secret' }) }), async () => {}, /credential/],
  ]) await assert.rejects(c.collect({ source: 'entra', from, to, deliver }), pattern);
});

test('CLI replay emits detection JSONL, rejects invalid input without leaking it', () => {
  const args = ['.claude/scripts/threat-detection/microsoft-run.mjs', '--company', config.companyId, '--tenant', config.tenantId,
    '--source', 'entra', '--mode', 'detect', '--replay-now', to];
  const result = spawnSync(process.execPath, args, { input: Array.from({ length: 6 }, (_, i) => JSON.stringify(signIn(i + 1))).join('\n'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').map(JSON.parse).length, 2);
  const invalid = spawnSync(process.execPath, args, { input: 'private-invalid-payload', encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.ok(!invalid.stderr.includes('private-invalid-payload'));
});

test('client credentials bind token acquisition to tenant and cache until renewal', async () => {
  let calls = 0;
  let now = 0;
  const getToken = microsoftClientCredentials({ tenantId: config.tenantId, clientId: config.tenantId,
    clientSecret: 'test-only', clock: () => now, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.body.get('scope'), 'https://graph.microsoft.com/.default');
      return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'opaque', expires_in: 120 }));
    } });
  const request = { tenantId: config.tenantId, scope: 'https://graph.microsoft.com/.default' };
  await getToken(request);
  await getToken(request);
  assert.equal(calls, 1);
  now = 61000;
  await getToken(request);
  assert.equal(calls, 2);
  await assert.rejects(getToken({ ...request, tenantId: 'other' }), /scope mismatch/);
  await assert.rejects(getToken({ ...request, scope: 'https://evil.example/.default' }), /scope mismatch/);
});
