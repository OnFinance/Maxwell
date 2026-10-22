// Pricing table access and cost arithmetic shared by session ingest and KPI computation.
import { readFileSync } from 'node:fs';

export const PRICING_PATH = '.claude/skills/kpi-extraction/references/pricing.json';

export function loadPricing(path = PRICING_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Resolves a raw model identifier (Claude Code message.model, OpenCode provider/model, aliases, "[1m]" suffix) to its
// pricing entry. Hosted providers and inference gateways report the same model under their own names, so each
// candidate below is tried in turn: the name as given, without a provider/ or ARN prefix, without a Vertex
// "@<version>" suffix, without a Bedrock "<region>.anthropic." prefix and "-v1:0" suffix, and finally without a
// trailing "-YYYYMMDD" snapshot date. Each step only removes packaging, never part of the model's own name, so
// claude-opus-5-5 can never resolve to claude-opus-5. Returns null when no candidate matches.
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
  const bedrock = /^(?:[a-z]{2,6}\.)?anthropic\./.test(name);
  name = name.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '').replace(bedrock ? /-v\d+(?::\d+)?$/ : /-v\d+:\d+$/, '');
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
