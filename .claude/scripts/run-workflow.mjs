#!/usr/bin/env node
// OpenCode runtime for Maxwell workflow scripts. Executes .claude/workflows/<name>.js (the same file the
// Claude Code Workflow tool runs) by providing the documented globals — agent, pipeline, parallel, phase,
// log, args, budget, workflow — on top of headless `opencode run` sessions.
// Usage: node .claude/scripts/run-workflow.mjs <name> [--args '<json>'] [--model provider/model]
//        [--concurrency N] [--dry-run] [--agent-type general]
// Every agent() call becomes one `opencode run --format json` session in this workspace; with a schema the
// agent is asked to answer with a single JSON object which is validated (ajv) and retried up to 2 times.
import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { dirname } from 'node:path';
import { opencodeSessionLog } from './lib/workflow-status.mjs';

const argv = process.argv.slice(2);
const name = argv[0];
const opt = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };
if (!name || name.startsWith('--')) { console.error('usage: run-workflow.mjs <name> [--args json] [--model provider/model] [--concurrency N] [--dry-run]'); process.exit(1); }
const file = `.claude/workflows/${name}.js`;
if (!existsSync(file)) { console.error(`${file} not found`); process.exit(1); }
const args = JSON.parse(opt('--args', '{}'));
const model = opt('--model', process.env.MAXWELL_OPENCODE_MODEL || 'anthropic/claude-opus-5');
// Workflow scripts pin Claude aliases (opus, sonnet, haiku, fable). When the configured model is not Anthropic's,
// every pinned alias runs on the configured model instead of a provider this OpenCode may not be logged in to.
const aliasTarget = model && !model.startsWith('anthropic/') ? model : null;
const dryRun = argv.includes('--dry-run');
const maxConcurrency = Number(opt('--concurrency', process.env.MAXWELL_OPENCODE_CONCURRENCY || Math.max(1, Math.min(16, cpus().length - 2))));
const defaultAgentType = opt('--agent-type', 'general');
const runId = process.env.MAXWELL_RUN_ID;
const sessionLog = opencodeSessionLog();
mkdirSync(dirname(sessionLog), { recursive: true });

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

let running = 0; const queue = [];
const acquire = () => new Promise((res) => { const tryStart = () => { if (running < maxConcurrency) { running += 1; res(); } else queue.push(tryStart); }; tryStart(); });
const release = () => { running -= 1; const next = queue.shift(); if (next) next(); };

let agentCount = 0; let currentPhase = null; let outputTokens = 0;
const progress = (line) => process.stderr.write(`[${name}] ${line}\n`);

function runOpencode(prompt, { agentType, modelOverride, label }) {
  return new Promise((resolve) => {
    const cliArgs = ['run', '--format', 'json', '--agent', agentType, '--title', `${name}:${label}`];
    const alias = { opus: 'anthropic/claude-opus-5', sonnet: 'anthropic/claude-sonnet-5', haiku: 'anthropic/claude-haiku-4-5-20251001', fable: 'anthropic/claude-fable-5-1' };
    const pinned = modelOverride ? (alias[modelOverride] || modelOverride) : null;
    const chosen = pinned ? (aliasTarget && pinned.startsWith('anthropic/') ? aliasTarget : pinned) : model;
    if (chosen) cliArgs.push('--model', chosen);
    if (process.env.MAXWELL_OPENCODE_AUTO === '1') cliArgs.push('--auto');
    // The prompt goes in on stdin, not as an argument: a write-stage prompt carrying 30 findings exceeded the OS
    // argument limit (spawn E2BIG, GLM 5.3 e2e 2026-09-15). opencode run reads piped stdin as the message and
    // waits for it to end, so the pipe is written once and closed.
    const child = spawn('opencode', cliArgs, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MAXWELL_HARNESS: 'opencode', MAXWELL_WORKFLOW: name, ...(typeof args.companyId === 'string' ? { MAXWELL_COMPANY_ID: args.companyId } : {}), ...(runId ? { MAXWELL_RUN_ID: runId } : {}) } });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const events = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      let text = ''; let sessionId = null;
      for (const ev of events) {
        const part = ev.part || ev.properties?.part || ev;
        if (part && part.sessionID) sessionId = part.sessionID;
        if (ev.sessionID) sessionId = ev.sessionID;
        if (part && part.type === 'text' && typeof part.text === 'string') text = part.text.length >= text.length ? part.text : text;
        if (ev.type === 'text' && typeof ev.text === 'string') text = ev.text;
        if (part && part.tokens && typeof part.tokens.output === 'number') outputTokens += part.tokens.output;
      }
      if (!text) text = stdout.trim();
      appendFileSync(sessionLog, JSON.stringify({ at: new Date().toISOString(), workflow: name, ...(runId ? { runId } : {}), label, sessionId, code, events: events.length }) + '\n');
      resolve({ code, text, stderr, sessionId });
    });
  });
}

async function agent(prompt, opts = {}) {
  agentCount += 1;
  if (agentCount > 1000) throw new Error('agent cap (1000) reached');
  const label = opts.label || `agent-${agentCount}`;
  const phaseName = opts.phase || currentPhase;
  const agentType = opts.agentType || defaultAgentType;
  progress(`▸ ${phaseName ? phaseName + ' / ' : ''}${label}`);
  if (dryRun) return opts.schema ? null : `[dry-run] ${label}`;
  await acquire();
  try {
    const schemaNote = opts.schema ? `\n\nRespond with ONLY a single JSON object (no prose, no code fence) that validates against this JSON Schema:\n${JSON.stringify(opts.schema)}` : '';
    const effortNote = opts.effort ? `\n\n(Reasoning effort requested: ${opts.effort}.)` : '';
    let last = null;
    for (let attempt = 0; attempt < (opts.schema ? 3 : 1); attempt += 1) {
      const retryNote = attempt ? `\n\nYour previous answer was not valid JSON for the schema (${last && last.error}). Return only the JSON object.` : '';
      const res = await runOpencode(prompt + effortNote + schemaNote + retryNote, { agentType, modelOverride: opts.model, label: attempt ? `${label}#${attempt + 1}` : label });
      if (res.code !== 0 && !res.text) { progress(`✗ ${label} exited ${res.code}: ${res.stderr.slice(-300)}`); return null; }
      if (!opts.schema) return res.text;
      const m = /\{[\s\S]*\}/.exec(res.text);
      try {
        const obj = JSON.parse(m ? m[0] : res.text);
        const validate = ajv.compile(opts.schema);
        if (validate(obj)) return obj;
        last = { error: ajv.errorsText(validate.errors) };
      } catch (e) { last = { error: e.message }; }
    }
    progress(`✗ ${label} never produced schema-valid output`);
    return null;
  } finally { release(); }
}

async function parallel(thunks) {
  return Promise.all(thunks.map((t) => Promise.resolve().then(t).catch((e) => { progress(`✗ ${e.message}`); return null; })));
}

async function pipeline(items, ...stages) {
  return Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const stage of stages) {
      try { value = await stage(value, item, index); } catch (e) { progress(`✗ pipeline item ${index}: ${e.message}`); return null; }
    }
    return value;
  }));
}

const phase = (title) => { currentPhase = title; progress(`== ${title} ==`); };
const log = (m) => progress(m);
const budget = { total: process.env.MAXWELL_TOKEN_BUDGET ? Number(process.env.MAXWELL_TOKEN_BUDGET) : null, spent: () => outputTokens, remaining: () => (budget.total ? Math.max(0, budget.total - outputTokens) : Infinity) };
const workflow = async () => { throw new Error('nested workflow() is not supported by the OpenCode runtime'); };

const source = readFileSync(file, 'utf8').replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const body = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', 'budget', 'workflow', source);
const result = await body(agent, pipeline, parallel, phase, log, args, budget, workflow);
process.stdout.write(JSON.stringify({ workflow: name, runId: runId || null, agents: agentCount, result }, null, 2) + '\n');
