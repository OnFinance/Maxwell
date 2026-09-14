// ComplianceOS search client: the primary research source for regulator circulars, directions and clauses.
// Login is a user account (POST /api/login -> JWT, at most 2 h); search is POST /api/new_search/search with a
// bearer token. Credentials live OUTSIDE the workspace (~/.config/maxwell/complianceos.env, mode 0600) or in the
// host environment; the token cache lives in ~/.cache/maxwell. Nothing here ever prints a password or token.
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';

export const DEFAULT_BASE_URL = 'https://complianceos-prod.onfinance.ai';
export const DEFAULT_COLLECTION = 'regulatory_communication';
export const COLLECTIONS = ['regulatory_communication', 'clause_content', 'compliance_requirements', 'orders', 'policies', 'controls', 'risks', 'audit', 'artifact', 'reporting_and_disclosure'];
export const MAX_TOP_K = 200;
const OVERFETCH = 3;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
// Refresh this long before the JWT's own expiry so a long search never starts with a dying token.
const EXPIRY_MARGIN_S = 300;
const FALLBACK_TOKEN_TTL_S = 2 * 3600;

export class ComplianceOsError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

export function configPaths(env = process.env) {
  const home = env.HOME || homedir();
  return {
    credentials: env.MAXWELL_COS_CREDENTIALS_FILE || join(home, '.config', 'maxwell', 'complianceos.env'),
    token: env.MAXWELL_COS_TOKEN_FILE || join(home, '.cache', 'maxwell', 'complianceos-token.json'),
  };
}

export function isInside(dir, path) {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// KEY=VALUE lines; a value that starts with a double quote is a JSON string (so any character survives).
export function parseEnvFile(text) {
  const out = {};
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { continue; } }
    out[key] = value;
  }
  return out;
}

export function formatEnvFile({ baseUrl, email, password }) {
  return [
    '# Maxwell ComplianceOS login. Keep this file outside the workspace, mode 0600. Never commit it.',
    `MAXWELL_COS_BASE_URL=${JSON.stringify(baseUrl)}`,
    `MAXWELL_COS_EMAIL=${JSON.stringify(email)}`,
    `MAXWELL_COS_PASSWORD=${JSON.stringify(password)}`,
    '',
  ].join('\n');
}

// Environment variables win over the file, field by field.
export function resolveCredentials(env = process.env, fileText) {
  const file = parseEnvFile(fileText);
  const pick = (k) => env[k] || file[k] || undefined;
  const email = pick('MAXWELL_COS_EMAIL');
  const password = pick('MAXWELL_COS_PASSWORD');
  const token = env.MAXWELL_COS_TOKEN || undefined;
  const source = env.MAXWELL_COS_EMAIL || env.MAXWELL_COS_TOKEN ? 'env' : file.MAXWELL_COS_EMAIL ? 'file' : null;
  return { baseUrl: (pick('MAXWELL_COS_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, ''), email, password, token, source };
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return email ? '***' : undefined;
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

// Expiry (epoch seconds) from the JWT payload; null when the token is not a readable JWT.
export function jwtExpiry(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : undefined;
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp : null;
  } catch { return null; }
}

const csv = (v) => [].concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);

export function buildSearchBody(opts = {}) {
  const collection = opts.collection || DEFAULT_COLLECTION;
  if (!opts.query || !String(opts.query).trim()) throw new ComplianceOsError('usage', 'a non-empty --query is required');
  const topK = opts.topK === undefined ? 10 : Number(opts.topK);
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) throw new ComplianceOsError('usage', `--top-k must be an integer from 1 to ${MAX_TOP_K}`);
  const offset = opts.offset === undefined ? 0 : Number(opts.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new ComplianceOsError('usage', '--offset must be a non-negative integer');
  for (const [flag, value] of [['--from', opts.from], ['--to', opts.to]]) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ComplianceOsError('usage', `${flag} must be YYYY-MM-DD`);
  }
  const body = {
    collection,
    query: opts.in ? [{ in: opts.in, content: String(opts.query) }] : String(opts.query),
    // Hits are filtered client-side (relevance, regulator, email, duplicates), so ask for more than will be shown.
    top_k: Math.min(MAX_TOP_K, topK * OVERFETCH),
    offset,
    // Semantic rerank is opt-in: live, it returned nothing for queries the plain text search answers (2026-09-14).
    rerank: opts.rerank === true,
  };
  if (opts.from) body.from = opts.from;
  if (opts.to) body.to = opts.to;
  if (opts.latestVersion) body.latest_version = true;
  const selfFilter = [];
  // The regulator field holds a tenant-specific id: ids go to the server, names (RBI, SEBI) are matched client-side.
  const regulatorIds = csv(opts.regulator).filter((r) => OBJECT_ID.test(r));
  if (regulatorIds.length) selfFilter.push({ field: 'regulator', values: regulatorIds });
  if (csv(opts.docType).length) selfFilter.push({ field: 'doc_type', values: csv(opts.docType) });
  if (selfFilter.length) body.self_filter = selfFilter;
  if (csv(opts.circular).length) body.cross_filter = [{ collection: 'regulatory_communication', _ids: csv(opts.circular) }];
  if (csv(opts.fields).length) body.retrieve_fields = csv(opts.fields);
  return body;
}

const first = (doc, keys) => {
  for (const k of keys) {
    const v = doc[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
const text = (v, max) => {
  if (v === undefined) return undefined;
  const s = (typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const day = (v) => (v ? String(v).slice(0, 10) : undefined);
const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Circular numbers identify the issuer reliably; titles and the document head are the fallback.
const REGULATORS = [
  { name: 'RBI', number: /^(?:RBI|DOR|DBR|DNBR|DNBS|DOS|DPSS|DCM|FMRD|FED|FIDD|DCBR|UBD|RPCD|DBS|DBOD|CEPD|DGBA|IDMD|DEPR|DSIM|CO\.DPSS)\b/i, text: /RESERVE BANK OF INDIA/i },
  { name: 'SEBI', number: /^(?:SEBI\b|HO\/|IMD\b|MRD\b|CFD\b|MIRSD\b|ITD\b|DDHS\b|AFD\b)/i, text: /SECURITIES AND EXCHANGE BOARD OF INDIA/i },
  { name: 'IRDAI', number: /^IRDAI\b/i, text: /INSURANCE REGULATORY AND DEVELOPMENT AUTHORITY/i },
  { name: 'CERT-In', number: /^CERT-IN\b/i, text: /INDIAN COMPUTER EMERGENCY RESPONSE TEAM/i },
  { name: 'NHB', number: /^NHB\b/i, text: /NATIONAL HOUSING BANK/i },
  { name: 'IFSCA', number: /^IFSCA\b/i, text: /INTERNATIONAL FINANCIAL SERVICES CENTRES AUTHORITY/i },
  { name: 'MCA', number: /^MCA\b/i, text: /MINISTRY OF CORPORATE AFFAIRS/i },
];

export function inferRegulator(doc) {
  const number = String(doc.circular_number || doc.reference_number || '').trim();
  if (number) for (const r of REGULATORS) if (r.number.test(number)) return r.name;
  for (const head of [doc.circular_title || doc.title, String(doc.markdown_text || '').slice(0, 600)]) {
    if (head) for (const r of REGULATORS) if (r.text.test(head)) return r.name;
  }
  return undefined;
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'under', 'within', 'shall', 'its', 'are', 'was', 'were', 'has', 'have', 'any', 'all', 'not', 'per', 'via']);

export function queryTerms(query) {
  const source = Array.isArray(query) ? query.map((q) => q && q.content).join(' ') : String(query || '');
  const terms = new Set();
  for (const t of source.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!t || STOPWORDS.has(t) || (t.length < 3 && !/^\d+$/.test(t))) continue;
    terms.add(t);
  }
  return [...terms];
}

// How many query terms occur (as word prefixes, plural-insensitive) in the document's own text. The service pads
// a query with no real match with recent documents and still labels them matched, so this is the only guard.
export function relevance(doc, terms) {
  const notes = Array.isArray(doc.notes) ? doc.notes.map((n) => n && n.note_content).join(' ') : '';
  const fields = [doc.title, doc.circular_title, doc.circular_number, doc.common_tag, notes, doc.summary, doc.description, doc.clause_title, doc.clause_content, doc.clause_hierarchy, doc.interpretation, doc.requirement_title, doc.requirement_description, String(doc.markdown_text || '').slice(0, 200000)];
  const hay = ` ${fields.filter((v) => typeof v === 'string').join(' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const stem = (t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t);
  return { matched: terms.filter((t) => hay.includes(` ${stem(t)}`)).length, of: terms.length };
}

export const requiredMatches = (n) => (n <= 2 ? n : Math.ceil(n * 0.75));

export function isEmailIngested(doc) {
  return doc.doc_type === 'email_ingestion' || doc.source_channel === 'email' || Object.keys(doc).some((k) => k.startsWith('email_'));
}

// A stable, compact view of each relevant hit; fields are looked up by the names the ComplianceOS collections use.
export function normaliseResults(response, { baseUrl, collection, query, retrievedAt, raw = false, limit, regulators, includeEmail = false, keepUnmatched = false, fullText = 0 } = {}) {
  const data = Array.isArray(response && response.data) ? response.data : [];
  const terms = queryTerms(query);
  const wanted = csv(regulators).filter((r) => !OBJECT_ID.test(r)).map((r) => r.toUpperCase());
  const dropped = { email: 0, unmatched: 0, regulator: 0, duplicate: 0 };
  const seen = new Set();
  const results = [];
  for (const doc of data) {
    if (limit && results.length >= limit) break;
    // Email-ingested items are a tenant's private mail, not regulator publications, and carry personal data.
    if (!includeEmail && isEmailIngested(doc)) { dropped.email++; continue; }
    const rel = relevance(doc, terms);
    if (!keepUnmatched && rel.matched < requiredMatches(rel.of)) { dropped.unmatched++; continue; }
    const regulator = inferRegulator(doc);
    if (wanted.length && !(regulator && wanted.includes(regulator.toUpperCase()))) { dropped.regulator++; continue; }
    const dates = Array.isArray(doc.dates) ? doc.dates : [];
    const dateOf = (type) => day((dates.find((d) => d && d.date_type === type && d.date_value) || {}).date_value);
    const notes = Array.isArray(doc.notes) ? doc.notes.map((n) => n && n.note_content).filter(Boolean) : [];
    const hit = {
      id: first(doc, ['_id', 'id', 'document_id']),
      title: text(first(doc, ['title', 'circular_title', 'clause_title', 'requirement_title', 'policy_title', 'control_title', 'risk_title', 'audit_title', 'artifact_name']), 300),
      reference: text(first(doc, ['circular_number', 'reference_number', 'clause_number', 'order_number']), 200),
      regulator,
      regulatorId: typeof doc.regulator === 'string' && OBJECT_ID.test(doc.regulator) ? doc.regulator : undefined,
      docType: text(first(doc, ['doc_type', 'document_type']), 100),
      issuedOn: dateOf('issue') || day(first(doc, ['issue_date', 'issued_date', 'circular_date', 'published_date'])),
      effectiveOn: dateOf('effective'),
      ingestedAt: text(first(doc, ['created_at']), 40),
      // Only public links; ComplianceOS file links are private s3:// paths.
      url: ['regulator_website_url', 'source_url', 'pdf_url', 'document_url', 'url', 'link'].map((k) => doc[k]).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)),
      summary: text(notes[0] || first(doc, ['summary', 'description', 'clause_content', 'requirement_description', 'interpretation', 'content']), 800),
      relevance: rel.of ? Math.round((rel.matched / rel.of) * 100) / 100 : undefined,
      score: typeof doc.score === 'number' ? doc.score : undefined,
    };
    const key = squash(hit.reference) || squash(hit.title) ? `${squash(hit.reference)}|${squash(hit.title)}` : String(hit.id);
    if (seen.has(key)) { dropped.duplicate++; continue; }
    seen.add(key);
    if (fullText) {
      const full = first(doc, ['markdown_text', 'clause_content', 'content']);
      if (typeof full === 'string') hit.text = full.length > fullText ? `${full.slice(0, fullText - 1)}…` : full;
    }
    if (raw) hit.raw = Object.fromEntries(Object.entries(doc).filter(([k]) => !/^(email_|addressees$|markdown_text$)/.test(k)));
    results.push(Object.fromEntries(Object.entries(hit).filter(([, v]) => v !== undefined)));
  }
  return {
    source: 'complianceos',
    baseUrl,
    collection: (response && response.collection) || collection,
    query,
    retrievedAt,
    offset: response && Number.isInteger(response.offset) ? response.offset : 0,
    fetched: data.length,
    returned: results.length,
    dropped,
    results,
  };
}

async function readJsonBody(res) {
  const body = await res.text();
  try { return JSON.parse(body); } catch { return { message: body.slice(0, 300) }; }
}

function describeError(json) {
  if (!json) return '';
  if (typeof json.detail === 'string') return json.detail;
  if (Array.isArray(json.detail)) return json.detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
  return json.message || json.error || '';
}

// tokenStore: { read() -> {baseUrl, email, token, expiresAt} | undefined, write(entry), clear() }.
export function createClient({ baseUrl, email, password, token, fetchImpl = globalThis.fetch, tokenStore, now = () => Math.floor(Date.now() / 1000), timeoutMs = 60000 }) {
  const call = (path, init) => fetchImpl(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch((err) => {
    throw new ComplianceOsError('unreachable', `ComplianceOS at ${baseUrl} is unreachable: ${err.message}`);
  });

  async function login() {
    if (!email || !password) throw new ComplianceOsError('not-configured', 'ComplianceOS credentials are not configured');
    const res = await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, password }) });
    const json = await readJsonBody(res);
    if (!res.ok || !json.token) {
      const detail = describeError(json);
      if (/captcha/i.test(detail)) throw new ComplianceOsError('captcha-required', `login needs a CAPTCHA on ${baseUrl}: ask the ComplianceOS admins to add the domain to CAPTCHA_DISABLED_DOMAINS or use MAXWELL_COS_TOKEN`, res.status);
      if (res.status >= 500) throw new ComplianceOsError('unreachable', `login failed with HTTP ${res.status}`, res.status);
      throw new ComplianceOsError('auth-failed', `login rejected with HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }
    const expiresAt = jwtExpiry(json.token) || now() + FALLBACK_TOKEN_TTL_S;
    const entry = { baseUrl, email, token: json.token, expiresAt };
    if (tokenStore) tokenStore.write(entry);
    return entry;
  }

  async function bearer({ forceLogin = false } = {}) {
    if (token) return { token, expiresAt: jwtExpiry(token) };
    if (!forceLogin && tokenStore) {
      const cached = tokenStore.read();
      if (cached && cached.baseUrl === baseUrl && cached.email === email && cached.token && cached.expiresAt - EXPIRY_MARGIN_S > now()) return cached;
    }
    return login();
  }

  async function search(opts) {
    const body = buildSearchBody(opts);
    const send = async (auth) => call('/api/new_search/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${auth.token}` }, body: JSON.stringify(body) });
    let res = await send(await bearer());
    // A cached token can be revoked before it expires: log in again once. A pasted MAXWELL_COS_TOKEN cannot be renewed.
    if (res.status === 401 && !token) {
      if (tokenStore) tokenStore.clear();
      res = await send(await bearer({ forceLogin: true }));
    }
    const json = await readJsonBody(res);
    if (res.status === 401 || res.status === 403) throw new ComplianceOsError('auth-failed', `search rejected with HTTP ${res.status}${describeError(json) ? `: ${describeError(json)}` : ''}`, res.status);
    if (res.status === 400) throw new ComplianceOsError('usage', `search rejected the request: ${describeError(json)}`, res.status);
    if (res.status === 429) throw new ComplianceOsError('rate-limited', 'ComplianceOS rate limit reached; wait a minute and retry', res.status);
    if (!res.ok) throw new ComplianceOsError('unreachable', `search failed with HTTP ${res.status}`, res.status);
    return { body, response: json };
  }

  return { login, bearer, search };
}
