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
  const doc = JSON.parse(readFileSync(extra, 'utf8'));
  const check = getValidator(buildAjv().ajv, PRICING_SCHEMA);
  if (!check(doc)) throw new Error(`${extra} does not match the pricing schema:\n${formatErrors(check.errors)}`);
  const replaced = new Set(doc.models.map((m) => m.model));
  return { ...base, asOf: doc.asOf > base.asOf ? doc.asOf : base.asOf, models: [...doc.models, ...base.models.filter((m) => !replaced.has(m.model))] };
}

// Resolves a raw model identifier (Claude Code message.model, OpenCode provider/model, aliases, "[1m]" suffix).
export function resolveModel(pricing, raw) {
  if (!raw) return null;
  const name = String(raw).replace(/\[1m\]$/, '');
  for (const m of pricing.models) {
    if (m.model === name || (m.aliases || []).includes(name) || (m.aliases || []).includes(raw)) return m;
  }
  const short = name.split('/').pop();
  for (const m of pricing.models) if (m.model === short || (m.aliases || []).includes(short)) return m;
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

// The gen_ai provider of a model for session summaries: the pricing entry's provider, else the OpenCode provider prefix
// when it is a well-known name in common.schema.json genAiProvider, else "other" (unprefixed ids are Claude Code models).
export function providerOf(pricing, raw, schemaPath = '.claude/schemas/v1/common.schema.json') {
  const price = resolveModel(pricing, raw);
  if (price && price.provider) return price.provider;
  const name = String(raw || '');
  if (!name.includes('/')) return 'anthropic';
  const known = JSON.parse(readFileSync(schemaPath, 'utf8')).$defs.genAiProvider.enum;
  const prefix = name.split('/')[0];
  return known.includes(prefix) ? prefix : 'other';
}

export function canonicalModelId(pricing, raw) {
  const m = resolveModel(pricing, raw);
  return m ? m.model : String(raw).replace(/\[1m\]$/, '').split('/').pop();
}
