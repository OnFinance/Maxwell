// Pricing table access and cost arithmetic shared by session ingest and KPI computation.
import { readFileSync } from 'node:fs';
import { settingValue } from './config.mjs';
import { buildAjv, getValidator, formatErrors } from './schemas.mjs';

export const PRICING_PATH = '.claude/skills/kpi-extraction/references/pricing.json';
const PRICING_SCHEMA = 'https://maxwell.onfinance.ai/schemas/vocab/pricing.schema.json';

// The built-in table, extended by the host setting pricing.file (MAXWELL_PRICING_FILE) when set: a table of the same
// shape whose entries replace built-in entries with the same model id and are matched first, so a host can price the
// model names or list prices of the provider it runs on. asOf (session pricingVersion) is the later of the two dates.
export function loadPricing(path = PRICING_PATH, env = process.env) {
  const base = JSON.parse(readFileSync(path, 'utf8'));
  const extra = settingValue('pricing.file', env);
  if (!extra) return base;
  // A broken extra table must not cost a session its summary: warn and use the built-in table.
  let doc;
  try {
    try { doc = JSON.parse(readFileSync(extra, 'utf8')); } catch { throw new Error('is not valid JSON'); }
    const check = getValidator(buildAjv().ajv, PRICING_SCHEMA);
    if (!check(doc)) throw new Error(`does not match the pricing schema:\n${formatErrors(check.errors)}`);
  } catch (err) {
    process.stderr.write(`[maxwell] pricing.file ${extra} ignored: ${err.message}\n`);
    return base;
  }
  // An entry for a built-in model replaces its prices and adds its aliases to the built-in ones.
  const builtIn = new Map(base.models.map((m) => [m.model, m]));
  const merged = doc.models.map((m) => (builtIn.has(m.model) ? { ...m, aliases: [...new Set([...(m.aliases || []), ...(builtIn.get(m.model).aliases || [])])] } : m));
  const replaced = new Set(doc.models.map((m) => m.model));
  return { ...base, asOf: doc.asOf > base.asOf ? doc.asOf : base.asOf, models: [...merged, ...base.models.filter((m) => !replaced.has(m.model))] };
}

// Resolves a raw model identifier (Claude Code message.model, OpenCode provider/model, aliases, "[1m]" suffix) to its
// pricing entry. Hosted providers and inference gateways report the same model under their own names, so each
// candidate below is tried in turn: the name as given, without a provider/ or ARN prefix, without a Vertex
// "@<version>" suffix, without a Bedrock "<region>.anthropic." prefix and "-v1:0" suffix, and finally without a
// trailing "-YYYYMMDD" snapshot date. Each step only removes packaging, never part of the model's own name, so
// claude-opus-5-5 can never resolve to claude-opus-5. Returns null when no candidate matches.
// "us.", "apac.", "us-gov.", "global." ... then "anthropic."
const BEDROCK_PREFIX = /^(?:[a-z-]{2,10}\.)?anthropic\./;

export function modelNameCandidates(raw) {
  const out = [];
  const add = (n) => { if (n && !out.includes(n)) out.push(n); };
  let name = String(raw).replace(/\[1m\]$/, '');
  add(name);
  name = name.split('/').pop();
  add(name);
  name = name.replace(/@[A-Za-z0-9._-]+$/, '');
  add(name);
  // Bedrock: "<region>.anthropic.<id>-v1:0". The version suffix is dropped only with the prefix or its ":<n>" form,
  // so another vendor's "-v2" model name is left alone.
  const bedrock = BEDROCK_PREFIX.test(name);
  name = name.replace(BEDROCK_PREFIX, '').replace(bedrock ? /-v\d+(?::\d+)?$/ : /-v\d+:\d+$/, '');
  add(name);
  add(name.replace(/-\d{8}$/, ''));
  return out;
}

export function resolveModel(pricing, raw) {
  if (!raw) return null;
  const matches = (m, n) => m.model === n || (m.aliases || []).includes(n);
  for (const m of pricing.models) if ((m.aliases || []).includes(String(raw))) return m;
  for (const name of modelNameCandidates(raw)) {
    for (const m of pricing.models) if (matches(m, name)) return m;
  }
  return null;
}

// tokens: {input, output, cacheWrite5m, cacheWrite1h, cacheRead}; returns USD rounded to 6 decimals.
export function costUsd(price, tokens, webSearchRequests = 0) {
  if (!price) return null;
  const t = tokens;
  const usd = (t.input * price.inputPerMTok + t.output * price.outputPerMTok + t.cacheWrite5m * price.cacheWrite5mPerMTok
    + t.cacheWrite1h * price.cacheWrite1hPerMTok + t.cacheRead * price.cacheReadPerMTok) / 1e6
    + (webSearchRequests * (price.webSearchPerKRequests || 0)) / 1000;
  return Math.round(usd * 1e6) / 1e6;
}

// The gen_ai provider of a model for session summaries. Where the call was served matters more than whose model it
// is, so packaging is read first: a Bedrock id ("<region>.anthropic.", "anthropic.", an arn:aws:bedrock ARN or a
// bedrock/ or amazon-bedrock/ prefix) is aws.bedrock and a Vertex id (a claude-*@<version> id or a vertex_ai/ or
// google-vertex*/ prefix) is gcp.vertex_ai. A bare Claude Code id is aws.bedrock or gcp.vertex_ai when the session ran
// with CLAUDE_CODE_USE_BEDROCK or CLAUDE_CODE_USE_VERTEX (Claude Code records Vertex models under their bare id).
// Otherwise: the pricing entry's provider, else the OpenCode provider prefix when it is a well-known name in
// common.schema.json genAiProvider, else "other" (unprefixed ids are Claude Code models).
const on = (v) => /^(1|true|yes)$/i.test(String(v || ''));
export function providerOf(pricing, raw, schemaPath = '.claude/schemas/v1/common.schema.json', env = process.env) {
  const name = String(raw || '');
  const last = name.replace(/\[1m\]$/, '').split('/').pop();
  if (/^arn:aws:bedrock:/.test(name) || /^(?:amazon-bedrock|bedrock)\//.test(name) || BEDROCK_PREFIX.test(last)) return 'aws.bedrock';
  if (/^(?:google-vertex[\w-]*|vertex_ai)\//.test(name) || /^claude-[\w.-]*@[A-Za-z0-9._-]+$/.test(last)) return 'gcp.vertex_ai';
  if (!name.includes('/') && on(env.CLAUDE_CODE_USE_BEDROCK)) return 'aws.bedrock';
  if (!name.includes('/') && on(env.CLAUDE_CODE_USE_VERTEX)) return 'gcp.vertex_ai';
  const price = resolveModel(pricing, raw);
  if (price && price.provider) return price.provider;
  if (!name.includes('/')) return 'anthropic';
  const known = JSON.parse(readFileSync(schemaPath, 'utf8')).$defs.genAiProvider.enum;
  const prefix = name.split('/')[0];
  return known.includes(prefix) ? prefix : 'other';
}

export function canonicalModelId(pricing, raw) {
  const m = resolveModel(pricing, raw);
  return m ? m.model : String(raw).replace(/\[1m\]$/, '').split('/').pop();
}
