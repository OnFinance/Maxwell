// Pricing table access and cost arithmetic shared by session ingest and KPI computation.
import { readFileSync } from 'node:fs';

export const PRICING_PATH = '.claude/skills/kpi-extraction/references/pricing.json';

export function loadPricing(path = PRICING_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
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

export function canonicalModelId(pricing, raw) {
  const m = resolveModel(pricing, raw);
  return m ? m.model : String(raw).replace(/\[1m\]$/, '').split('/').pop();
}
