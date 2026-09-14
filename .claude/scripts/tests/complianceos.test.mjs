import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchBody, createClient, formatEnvFile, isInside, jwtExpiry, maskEmail, normaliseResults, parseEnvFile,
  resolveCredentials, DEFAULT_BASE_URL,
} from '../lib/complianceos.mjs';

// A syntactically valid JWT with only an exp claim, built at run time.
const jwt = (exp) => ['h', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 's'].join('.');
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const next = handlers[path].shift();
    return typeof next === 'function' ? next() : next;
  };
  fn.calls = calls;
  return fn;
}

function memoryStore() {
  let entry;
  return { read: () => entry, write: (e) => { entry = e; }, clear: () => { entry = undefined; } };
}

test('buildSearchBody defaults to a reranked plain query on regulatory_communication', () => {
  assert.deepEqual(buildSearchBody({ query: 'outsourcing' }), { collection: 'regulatory_communication', query: 'outsourcing', top_k: 10, offset: 0, rerank: true });
});

test('buildSearchBody maps field queries, filters, dates and projections', () => {
  const body = buildSearchBody({ query: 'cyber incident', in: 'title', regulator: ['RBI,SEBI'], docType: 'Master Direction', from: '2025-01-01', to: '2026-09-14', topK: '50', offset: '10', rerank: false, latestVersion: true, fields: 'title, pdf_url' });
  assert.deepEqual(body, {
    collection: 'regulatory_communication', query: [{ in: 'title', content: 'cyber incident' }], top_k: 50, offset: 10, rerank: false,
    from: '2025-01-01', to: '2026-09-14', latest_version: true,
    self_filter: [{ field: 'regulator', values: ['RBI', 'SEBI'] }, { field: 'doc_type', values: ['Master Direction'] }],
    retrieve_fields: ['title', 'pdf_url'],
  });
});

test('buildSearchBody rejects empty queries, bad page sizes and bad dates', () => {
  assert.throws(() => buildSearchBody({ query: '  ' }), { code: 'usage' });
  assert.throws(() => buildSearchBody({ query: 'x', topK: 201 }), { code: 'usage' });
  assert.throws(() => buildSearchBody({ query: 'x', from: '14/09/2026' }), { code: 'usage' });
});

test('normaliseResults keeps a compact, stable view of each hit', () => {
  const out = normaliseResults({ data: [{ _id: 'a1', circular_title: 'Managing Risks in Outsourcing', circular_number: 'RBI/DOR/2025-26/363', regulator: 'RBI', pdf_url: 'https://rbi.org.in/x.pdf', description: 'x'.repeat(900), score: 0.9, extra: 1 }], total: 1, collection: 'regulatory_communication' }, { baseUrl: DEFAULT_BASE_URL, query: 'outsourcing', retrievedAt: '2026-09-14T12:00:00Z' });
  assert.equal(out.source, 'complianceos');
  assert.equal(out.total, 1);
  const [hit] = out.results;
  assert.deepEqual(Object.keys(hit), ['id', 'title', 'reference', 'regulator', 'url', 'summary', 'score']);
  assert.equal(hit.reference, 'RBI/DOR/2025-26/363');
  assert.equal(hit.summary.length, 800);
  assert.equal(normaliseResults({ data: [{ _id: 'a1', extra: 1 }] }, { raw: true }).results[0].raw.extra, 1);
});

test('env file round-trips passwords with quotes, equals and hashes', () => {
  const secret = 'p"a=ss #1';
  const parsed = parseEnvFile(formatEnvFile({ baseUrl: DEFAULT_BASE_URL, email: 'bot@example.com', password: secret }));
  assert.equal(parsed.MAXWELL_COS_PASSWORD, secret);
  assert.equal(parsed.MAXWELL_COS_EMAIL, 'bot@example.com');
});

test('environment variables win over the credentials file', () => {
  const file = formatEnvFile({ baseUrl: 'https://file.example.com/', email: 'file@example.com', password: 'from-file' });
  const fromFile = resolveCredentials({}, file);
  assert.deepEqual([fromFile.baseUrl, fromFile.email, fromFile.source], ['https://file.example.com', 'file@example.com', 'file']);
  const fromEnv = resolveCredentials({ MAXWELL_COS_EMAIL: 'env@example.com' }, file);
  assert.deepEqual([fromEnv.email, fromEnv.password, fromEnv.source], ['env@example.com', 'from-file', 'env']);
  assert.equal(resolveCredentials({}, undefined).baseUrl, DEFAULT_BASE_URL);
});

test('helpers: jwt expiry, email masking, path containment', () => {
  assert.equal(jwtExpiry(jwt(1790000000)), 1790000000);
  assert.equal(jwtExpiry('not-a-jwt'), null);
  assert.equal(maskEmail('compliance-bot@onfinance.ai'), 'c***@onfinance.ai');
  assert.equal(isInside('/w', '/w/.config/x'), true);
  assert.equal(isInside('/w', '/home/u/.config/maxwell/complianceos.env'), false);
});

test('client logs in once, reuses the cached token and sends it as a bearer', async () => {
  const token = jwt(10_000);
  const fetchImpl = fakeFetch({ '/api/login': [reply(200, { token })], '/api/new_search/search': [reply(200, { data: [] }), reply(200, { data: [] })] });
  const client = createClient({ baseUrl: DEFAULT_BASE_URL, email: 'bot@example.com', password: 'pw-test', fetchImpl, tokenStore: memoryStore(), now: () => 1000 });
  await client.search({ query: 'a' });
  await client.search({ query: 'b' });
  assert.deepEqual(fetchImpl.calls.map((c) => c.path), ['/api/login', '/api/new_search/search', '/api/new_search/search']);
  assert.equal(fetchImpl.calls[1].headers.Authorization, `Bearer ${token}`);
});

test('client logs in again once when a cached token is rejected', async () => {
  const store = memoryStore();
  store.write({ baseUrl: DEFAULT_BASE_URL, email: 'bot@example.com', token: jwt(10_000), expiresAt: 10_000 });
  const fetchImpl = fakeFetch({ '/api/login': [reply(200, { token: jwt(20_000) })], '/api/new_search/search': [reply(401, { error: 'Unauthorized' }), reply(200, { data: [{ _id: 'x' }], total: 1 })] });
  const client = createClient({ baseUrl: DEFAULT_BASE_URL, email: 'bot@example.com', password: 'pw-test', fetchImpl, tokenStore: store, now: () => 1000 });
  const { response } = await client.search({ query: 'a' });
  assert.equal(response.total, 1);
  assert.equal(store.read().expiresAt, 20_000);
});

test('client surfaces CAPTCHA, bad credentials and missing configuration as distinct codes', async () => {
  const captcha = createClient({ baseUrl: DEFAULT_BASE_URL, email: 'bot@example.com', password: 'pw-test', fetchImpl: fakeFetch({ '/api/login': [reply(400, { detail: 'CAPTCHA verification required' })] }) });
  await assert.rejects(captcha.login(), { code: 'captcha-required' });
  const wrong = createClient({ baseUrl: DEFAULT_BASE_URL, email: 'bot@example.com', password: 'pw-test', fetchImpl: fakeFetch({ '/api/login': [reply(401, { detail: 'Invalid credentials' })] }) });
  await assert.rejects(wrong.login(), { code: 'auth-failed' });
  await assert.rejects(createClient({ baseUrl: DEFAULT_BASE_URL }).login(), { code: 'not-configured' });
});

test('a pasted MAXWELL_COS_TOKEN is used as is and never renewed', async () => {
  const fetchImpl = fakeFetch({ '/api/new_search/search': [reply(401, { error: 'Unauthorized' })] });
  const client = createClient({ baseUrl: DEFAULT_BASE_URL, token: jwt(5), fetchImpl, tokenStore: memoryStore() });
  await assert.rejects(client.search({ query: 'a' }), { code: 'auth-failed' });
  assert.deepEqual(fetchImpl.calls.map((c) => c.path), ['/api/new_search/search']);
});
