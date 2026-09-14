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
    top_k: topK,
    offset,
    // The service only runs the semantic (vector) search when rerank is true; without it the query is a regex.
    rerank: opts.rerank !== false,
  };
  if (opts.from) body.from = opts.from;
  if (opts.to) body.to = opts.to;
  if (opts.latestVersion) body.latest_version = true;
  const selfFilter = [];
  if (csv(opts.regulator).length) selfFilter.push({ field: 'regulator', values: csv(opts.regulator) });
  if (csv(opts.docType).length) selfFilter.push({ field: 'doc_type', values: csv(opts.docType) });
  if (selfFilter.length) body.self_filter = selfFilter;
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

// A stable, compact view of each hit; fields are looked up by the names the ComplianceOS collections use.
export function normaliseResults(response, { baseUrl, collection, query, retrievedAt, raw = false } = {}) {
  const data = Array.isArray(response && response.data) ? response.data : [];
  const results = data.map((doc) => {
    const hit = {
      id: first(doc, ['_id', 'id', 'document_id']),
      title: text(first(doc, ['title', 'circular_title', 'clause_title', 'requirement_title', 'policy_title', 'control_title', 'risk_title', 'audit_title', 'artifact_name']), 300),
      reference: text(first(doc, ['circular_number', 'reference_number', 'clause_number', 'order_number']), 200),
      regulator: text(first(doc, ['regulator', 'regulator_name', 'authority']), 100),
      docType: text(first(doc, ['doc_type', 'document_type', 'type']), 100),
      date: text(first(doc, ['issue_date', 'issued_date', 'circular_date', 'published_date', 'date', 'created_at']), 40),
      url: first(doc, ['pdf_url', 'source_url', 'document_url', 'url', 'link']),
      summary: text(first(doc, ['summary', 'description', 'clause_content', 'requirement_description', 'interpretation', 'content']), 800),
      score: typeof doc.score === 'number' ? doc.score : undefined,
      matchedField: doc.matched_field,
    };
    if (raw) hit.raw = doc;
    return Object.fromEntries(Object.entries(hit).filter(([, v]) => v !== undefined));
  });
  return {
    source: 'complianceos',
    baseUrl,
    collection: (response && response.collection) || collection,
    query,
    retrievedAt,
    total: response && Number.isInteger(response.total) ? response.total : results.length,
    offset: response && Number.isInteger(response.offset) ? response.offset : 0,
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
