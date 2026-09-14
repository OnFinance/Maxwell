import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchBody, createClient, formatEnvFile, inferRegulator, isInside, jwtExpiry, maskEmail, normaliseResults,
  parseEnvFile, queryTerms, relevance, requiredMatches, resolveCredentials, DEFAULT_BASE_URL,
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

test('buildSearchBody defaults to a reranked plain query on regulatory_communication, over-fetching for filtering', () => {
  assert.deepEqual(buildSearchBody({ query: 'outsourcing' }), { collection: 'regulatory_communication', query: 'outsourcing', top_k: 30, offset: 0, rerank: false });
  assert.equal(buildSearchBody({ query: 'x', rerank: true }).rerank, true);
  assert.equal(buildSearchBody({ query: 'x', topK: 200 }).top_k, 200);
});

test('buildSearchBody maps field queries, filters, dates and projections', () => {
  const regulatorId = '689c7a9bc81134693e239f07';
  const body = buildSearchBody({ query: 'cyber incident', in: 'title', regulator: [`RBI,${regulatorId}`], docType: 'master_direction', circular: 'c1', from: '2025-01-01', to: '2026-09-14', topK: '50', offset: '10', rerank: false, latestVersion: true, fields: 'title, circular_number' });
  assert.deepEqual(body, {
    collection: 'regulatory_communication', query: [{ in: 'title', content: 'cyber incident' }], top_k: 150, offset: 10, rerank: false,
    from: '2025-01-01', to: '2026-09-14', latest_version: true,
    // Names are matched client-side; only the id reaches the server.
    self_filter: [{ field: 'regulator', values: [regulatorId] }, { field: 'doc_type', values: ['master_direction'] }],
    cross_filter: [{ collection: 'regulatory_communication', _ids: ['c1'] }],
    retrieve_fields: ['title', 'circular_number'],
  });
});

test('buildSearchBody rejects empty queries, bad page sizes and bad dates', () => {
  assert.throws(() => buildSearchBody({ query: '  ' }), { code: 'usage' });
  assert.throws(() => buildSearchBody({ query: 'x', topK: 201 }), { code: 'usage' });
  assert.throws(() => buildSearchBody({ query: 'x', from: '14/09/2026' }), { code: 'usage' });
});

// Shapes observed in live regulatory_communication documents (2026-09-14), trimmed.
const rbiKyc = {
  _id: '66a1', circular_number: 'DOR.AML.REC.No.88/14.01.002/202526', circular_title: 'Reserve Bank of India (Commercial Banks - Know Your Customer) Directions, 2025',
  regulator: '689c7a9bc81134693e239f07', doc_type: 'master_circular', circular_status: 'draft', created_at: '2025-11-28T10:00:00.000000',
  dates: [{ date_type: 'issue', date_value: '2025-11-28T00:00:00' }, { date_type: 'effective', date_value: '2025-11-28T00:00:00' }],
  notes: [{ note_content: 'Consolidated KYC directions for commercial banks.' }], circular_file_url: 's3://bucket/kyc.pdf',
  markdown_text: '# Know Your Customer Directions\n\n1. These Directions apply to all commercial banks.',
};
const sebiCscrf = (id, number) => ({
  _id: id, circular_number: number, circular_title: 'Cybersecurity and Cyber Resilience Framework (CSCRF) for SEBI Regulated Entities (REs)',
  regulator: '6895da2f2c1f8f514b53579b', doc_type: 'circular', created_at: '2025-06-30T13:54:14.507000',
});
const sebiMutualFunds = { _id: '66b1', circular_number: 'HO/(92)2026IMDPOD2/I/6961/2026', circular_title: 'Borrowing by Mutual Funds', regulator: '6895da2f2c1f8f514b53579b', doc_type: 'circular' };
const emailDraft = { _id: '66c1', circular_title: 'Request to Initiate RBI Regulatory Assessment for NBFC', doc_type: 'email_ingestion', addressees: ['someone@example.com'], email_subject: 'Request to Initiate RBI Regulatory Assessment for NBFC', regulator: null };

test('normaliseResults drops padding the service returns for queries with no real match', () => {
  const out = normaliseResults({ data: [sebiMutualFunds, rbiKyc] }, { query: 'Reserve Bank of India Know Your Customer', limit: 10 });
  assert.deepEqual(out.results.map((r) => r.id), ['66a1']);
  assert.equal(out.dropped.unmatched, 1);
  assert.equal(normaliseResults({ data: [sebiMutualFunds] }, { query: 'Reserve Bank of India Know Your Customer', keepUnmatched: true }).returned, 1);
});

test('normaliseResults infers regulators, reads dates and notes, hides private links and filters by regulator name', () => {
  const out = normaliseResults({ data: [rbiKyc, sebiCscrf('66d1', 'SEBI/HO/ITD-1/ITD_CSC_EXT/P/CIR/2024/113'), sebiMutualFunds] }, { query: [{ in: '', content: '' }], limit: 10 });
  assert.deepEqual(out.results.map((r) => r.regulator), ['RBI', 'SEBI', 'SEBI']);
  const [kyc] = out.results;
  assert.deepEqual([kyc.issuedOn, kyc.effectiveOn, kyc.regulatorId, kyc.summary, kyc.url], ['2025-11-28', '2025-11-28', '689c7a9bc81134693e239f07', 'Consolidated KYC directions for commercial banks.', undefined]);
  const rbiOnly = normaliseResults({ data: [rbiKyc, sebiMutualFunds] }, { query: '', regulators: ['rbi'] });
  assert.deepEqual([rbiOnly.returned, rbiOnly.dropped.regulator], [1, 1]);
});

test('normaliseResults drops email-ingested items and duplicate copies of a circular', () => {
  const out = normaliseResults({ data: [emailDraft, sebiCscrf('66d1', 'SEBI/HO/ ITD-1/ITD_CSC_EXT/P/CIR/2024/113'), sebiCscrf('66d2', 'SEBI/HO/ITD-1/ITD_CSC_EXT/P/CIR/2024/113')] }, { query: 'Cybersecurity Resilience Framework' });
  assert.deepEqual(out.results.map((r) => r.id), ['66d1']);
  assert.deepEqual(out.dropped, { email: 1, unmatched: 0, regulator: 0, duplicate: 1 });
  assert.equal(normaliseResults({ data: [emailDraft] }, { query: 'RBI Regulatory Assessment', includeEmail: true }).returned, 1);
});

test('normaliseResults adds truncated full text on request and never leaks email fields in raw output', () => {
  const [hit] = normaliseResults({ data: [{ ...rbiKyc, email_subject: 'x', addressees: ['a@example.com'] }] }, { query: 'Know Your Customer', fullText: 20, raw: true, includeEmail: true }).results;
  assert.equal(hit.text.length, 20);
  assert.equal(hit.raw.circular_number, rbiKyc.circular_number);
  assert.equal(['email_subject', 'addressees', 'markdown_text'].some((k) => k in hit.raw), false);
});

test('relevance helpers: terms, plural-insensitive prefix matching, required matches', () => {
  assert.deepEqual(queryTerms('Managing Risks in Outsourcing of IT services'), ['managing', 'risks', 'outsourcing', 'services']);
  assert.deepEqual(relevance({ circular_title: 'Managing Risk in Outsourcing' }, ['managing', 'risks', 'outsourcing']), { matched: 3, of: 3 });
  assert.deepEqual([requiredMatches(1), requiredMatches(2), requiredMatches(3), requiredMatches(6)], [1, 2, 3, 5]);
  assert.equal(inferRegulator({ circular_title: 'SECURITIES AND EXCHANGE BOARD OF INDIA NOTIFICATION' }), 'SEBI');
  assert.equal(inferRegulator({ circular_title: 'Operating Circular: Reserve Bank incident response' }), undefined);
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
