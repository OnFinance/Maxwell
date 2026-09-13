#!/usr/bin/env node
// Ingests one harness session for KPI extraction.
// Usage: ingest.mjs --harness claude-code|opencode --session <sid> [--transcript <path>] [--reported <usd>]
//        [--outcome success|error|max-turns|max-budget|aborted] [--force]
// --reported passes the harness-reported cost (claude -p --output-format json total_cost_usd) for the cross-check.
// 1. Applies the sampling policy from kpis/metrics.json and updates <sid>.meta.json (sampled, samplingReason, endedAt).
// 2. For sampled sessions copies the transcript (Claude Code JSONL + subagent files, or `opencode export` JSON) into
//    kpis/data/raw/sessions/<harness>/ (gitignored) and writes <sid>.summary.json validated against the schema.
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';
import { loadPricing, resolveModel, costUsd, canonicalModelId } from '../lib/pricing.mjs';
import { parseClaudeTranscript, parseClaudeSubagents, parseOpencodeExport, newStats } from '../lib/transcript.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const harness = opt('--harness', process.env.MAXWELL_HARNESS || 'claude-code');
const sessionId = opt('--session');
const force = argv.includes('--force') || process.env.MAXWELL_KPI_SAMPLE === '1';
if (!sessionId) { console.error('usage: ingest.mjs --harness <h> --session <sid> [--transcript <path>] [--outcome <o>] [--force]'); process.exit(1); }

const root = process.cwd();
const dir = `kpis/data/raw/sessions/${harness}`;
mkdirSync(dir, { recursive: true });
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const semver = (v) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? `${m[1]}.${m[2]}.${m[3]}` : '0.0.0'; };
const registry = JSON.parse(readFileSync('kpis/metrics.json', 'utf8'));
const metaPath = `${dir}/${sessionId}.meta.json`;
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {
  schemaVersion: '1', kind: 'maxwell.session.meta', sessionId, harness, workflow: 'manual',
  args: { appIds: [], envIds: [], dryRun: false }, startedAt: now(), cwd: root,
  transcriptPath: `${dir}/${sessionId}.jsonl`, sampled: false, samplingReason: 'pending', model: process.env.MAXWELL_MODEL || 'unknown',
  invokedBy: { type: 'script', id: 'headless' }, provenance: { harness: 'script', generatedAt: now(), sessionId, agent: '.claude/scripts/sessions/ingest.mjs' },
};
if (process.env.MAXWELL_RUN_ID && !meta.runId) meta.runId = process.env.MAXWELL_RUN_ID;

// ---- sampling -------------------------------------------------------------------------------------------
function decideSampling() {
  const s = registry.sampling || { mode: 'all' };
  if (force) return { sampled: true, reason: 'forced' };
  if (s.mode === 'all') return { sampled: true, reason: 'all' };
  if (s.mode === 'stochastic') {
    const h = createHash('sha256').update(`${s.seed || ''}:${sessionId}`).digest();
    const x = h.readUInt32BE(0) / 0xffffffff;
    return { sampled: x < (s.rate ?? 1), reason: 'stochastic' };
  }
  // bundle: the first bundleSize sessions of a run (by startedAt) are sampled; sessions without a run form one bundle per day.
  const bundleKey = meta.runId || (meta.startedAt || '').slice(0, 10);
  const siblings = readdirSync(dir).filter((f) => f.endsWith('.meta.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((m) => (m.runId || (m.startedAt || '').slice(0, 10)) === bundleKey && m.sessionId !== sessionId && m.sampled === true);
  return { sampled: siblings.length < (s.bundleSize ?? 10), reason: 'bundle' };
}
const decision = decideSampling();
meta.sampled = decision.sampled;
meta.samplingReason = decision.reason;
meta.endedAt = meta.endedAt || now();

// ---- locate + copy transcript -----------------------------------------------------------------------------
function findClaudeTranscript() {
  const given = opt('--transcript');
  if (given && existsSync(given)) return given;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  if (!existsSync(projects)) return null;
  for (const p of readdirSync(projects)) {
    const cand = join(projects, p, `${sessionId}.jsonl`);
    if (existsSync(cand)) return cand;
  }
  return null;
}

function collectSubagentFiles(transcriptPath) {
  const out = [];
  const base = join(resolve(transcriptPath, '..'), sessionId, 'subagents');
  const walk = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (e.endsWith('.jsonl') && e.startsWith('agent-')) out.push(p); } };
  walk(base);
  return out;
}

let stats = newStats();
let harnessVersion = meta.harnessVersion;
if (meta.sampled) {
  if (harness === 'claude-code') {
    const src = findClaudeTranscript();
    if (!src) { console.error(`transcript for ${sessionId} not found; pass --transcript`); meta.sampled = false; meta.samplingReason = 'pending'; }
    else {
      const dest = `${dir}/${sessionId}.jsonl`;
      copyFileSync(src, dest);
      meta.transcriptPath = dest;
      stats = parseClaudeTranscript(readFileSync(src, 'utf8').split('\n'));
      const subs = collectSubagentFiles(src);
      parseClaudeSubagents(subs.map((f) => readFileSync(f, 'utf8').split('\n')), stats);
      if (!harnessVersion) harnessVersion = stats.formatVersion;
    }
  } else {
    const dest = `${dir}/${sessionId}.export.json`;
    let doc = null;
    const given = opt('--transcript');
    if (given && existsSync(given)) doc = JSON.parse(readFileSync(given, 'utf8'));
    else {
      const res = spawnSync('opencode', ['export', sessionId], { encoding: 'utf8', cwd: root, maxBuffer: 1 << 28 });
      if (res.status === 0) { try { doc = JSON.parse(res.stdout); } catch { doc = null; } }
    }
    if (!doc) { console.error(`opencode export ${sessionId} failed; pass --transcript <export.json>`); meta.sampled = false; meta.samplingReason = 'pending'; }
    else {
      writeFileSync(dest, JSON.stringify(doc));
      meta.exportPath = dest;
      stats = parseOpencodeExport(doc);
      if (!harnessVersion) {
        const v = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
        harnessVersion = v.status === 0 ? v.stdout.trim() : (stats.formatVersion || '0.0.0');
      }
    }
  }
}
meta.harnessVersion = semver(harnessVersion || meta.harnessVersion || '0.0.0');

const { ajv } = buildAjv();
const validateMeta = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/session/meta.schema.json');
if (!validateMeta(meta)) { console.error(`meta invalid:\n${formatErrors(validateMeta.errors)}`); process.exit(2); }
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
if (!meta.sampled) { console.log(`session ${sessionId} not sampled (${meta.samplingReason}); meta updated`); process.exit(0); }

// ---- summary --------------------------------------------------------------------------------------------
const pricing = loadPricing();
const models = [];
let computed = 0;
for (const [raw, entry] of stats.models) {
  const price = resolveModel(pricing, raw);
  const usd = costUsd(price, entry.tokens, entry.webSearchRequests);
  if (usd !== null) computed += usd;
  models.push({
    model: canonicalModelId(pricing, raw),
    provider: raw.includes('/') ? raw.split('/')[0].replace('anthropic', 'anthropic') : 'anthropic',
    tokens: { input: entry.tokens.input, output: entry.tokens.output, cacheWrite5m: entry.tokens.cacheWrite5m, cacheWrite1h: entry.tokens.cacheWrite1h, cacheRead: entry.tokens.cacheRead, thinking: entry.tokens.thinking || null },
    webSearchRequests: entry.webSearchRequests,
    webFetchRequests: entry.webFetchRequests,
    costUsd: usd ?? 0,
  });
}
if (models.length === 0) models.push({ model: meta.model && meta.model !== 'unknown' ? meta.model : 'claude-opus-5', provider: 'anthropic', tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, thinking: null }, webSearchRequests: 0, webFetchRequests: 0, costUsd: 0 });
computed = Math.round(computed * 1e6) / 1e6;
const reportedArg = opt('--reported');
const reportedRaw = reportedArg !== undefined ? Number(reportedArg) : stats.reportedCostUsd;
const reported = typeof reportedRaw === 'number' && Number.isFinite(reportedRaw) ? Math.round(reportedRaw * 1e6) / 1e6 : null;
const deltaPct = reported ? Math.round(((computed - reported) / reported) * 10000) / 100 : null;
const startedAt = stats.startedAt || meta.startedAt;
const endedAt = stats.endedAt || meta.endedAt;
const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
const filesWritten = [...stats.filesWritten].map((p) => (p.startsWith('/') ? relative(root, p) : p)).filter((p) => p && !p.startsWith('..')).sort();
const outcome = opt('--outcome', stats.errors.length ? 'error' : 'success');

const summary = {
  schemaVersion: '1', kind: 'maxwell.session.summary', sessionId, harness,
  harnessVersion: meta.harnessVersion,
  ...(meta.runId ? { runId: meta.runId } : {}),
  workflow: meta.workflow, ...(meta.companyId ? { companyId: meta.companyId } : {}),
  startedAt, endedAt, durationMs, ...(stats.apiDurationMs !== null ? { apiDurationMs: stats.apiDurationMs } : {}),
  turns: stats.turns, inferenceCalls: stats.inferenceCalls, toolCalls: stats.toolCalls, subagentSessions: stats.subagentFiles,
  permissionDenials: stats.permissionDenials, models,
  costUsd: { computed, reported, deltaPct },
  pricingVersion: pricing.asOf,
  dedup: { strategy: 'requestId-max-total-tokens', duplicatesDropped: stats.duplicatesDropped },
  filesWritten, linesAdded: stats.linesAdded, linesRemoved: stats.linesRemoved, outcome,
  transcriptFormatVersion: semver(stats.formatVersion || meta.harnessVersion),
  provenance: { harness: 'script', generatedAt: now(), sessionId, ...(meta.runId ? { runId: meta.runId } : {}), workflow: meta.workflow, agent: '.claude/scripts/sessions/ingest.mjs' },
};
const validateSummary = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/session/summary.schema.json');
if (!validateSummary(summary)) { console.error(`summary invalid:\n${formatErrors(validateSummary.errors)}`); process.exit(2); }
writeFileSync(`${dir}/${sessionId}.summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(`session ${sessionId}: ${basename(dir)} sampled=${meta.sampled} cost=${computed} USD (reported ${reported}) turns=${stats.turns} tools=${stats.toolCalls.total} subagents=${stats.subagentFiles}`);
