#!/usr/bin/env node
// Runs one Maxwell workflow headlessly on a harness and ingests the session for KPIs.
// Usage: run-headless.mjs --workflow <name> --company <id> [--harness claude-code|opencode] [--model opus|provider/model]
//        [--app <id>]... [--env <id>]... [--dry-run] [--run-id run_...] [--max-turns 400] [--budget-usd <n>]
// Claude Code: claude -p --output-format json "/<workflow> <company> ..." (project settings/hooks/skills load from
//   the workspace; --bare is not used because it requires ANTHROPIC_API_KEY and skips the validation hooks).
// OpenCode: node .claude/scripts/run-workflow.mjs <workflow> --args '{...}' (headless opencode run sessions).
// Afterwards the session is ingested with --force and the harness-reported cost for the cross-check.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { ulid } from '../hooks/lib.mjs';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const multi = (f) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : []));
const workflow = opt('--workflow');
const company = opt('--company');
const harness = opt('--harness', 'claude-code');
const dryRun = argv.includes('--dry-run');
if (!workflow || !company) { console.error('usage: run-headless.mjs --workflow <name> --company <id> [--harness claude-code|opencode] [--model m] [--app id] [--env id] [--dry-run]'); process.exit(1); }
const vocab = JSON.parse(readFileSync('.claude/schemas/vocab/workflows.schema.json', 'utf8')).enum;
if (!vocab.includes(workflow)) { console.error(`unknown workflow ${workflow}`); process.exit(1); }
const runId = opt('--run-id', process.env.MAXWELL_RUN_ID || `run_${ulid()}`);
const apps = multi('--app'); const envs = multi('--env');
const started = Date.now();
const logDir = `kpis/data/raw/sessions/${harness}`;
mkdirSync(logDir, { recursive: true });
const env = { ...process.env, MAXWELL_RUN_ID: runId, MAXWELL_HARNESS: harness, MAXWELL_INVOKED_BY: process.env.MAXWELL_INVOKED_BY || '', MAXWELL_KPI_SAMPLE: '1' };

let sessionId = null; let reported = null; let outcome = 'success'; let result = null;
if (harness === 'claude-code') {
  const model = opt('--model', 'opus');
  env.MAXWELL_MODEL = model;
  const prompt = [`/${workflow}`, company, ...apps.map((a) => `--app=${a}`), ...envs.map((e) => `--env=${e}`), ...(dryRun ? ['--dry-run'] : [])].join(' ');
  const args = ['-p', '--output-format', 'json', '--model', model, '--permission-mode', opt('--permission-mode', 'auto'), '--max-turns', opt('--max-turns', '400'), '--setting-sources', 'project'];
  if (opt('--budget-usd')) args.push('--max-budget-usd', opt('--budget-usd'));
  args.push(prompt);
  console.error(`[run-headless] claude ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
  const res = spawnSync('claude', args, { encoding: 'utf8', env, maxBuffer: 1 << 28 });
  const raw = (res.stdout || '').trim();
  writeFileSync(`${logDir}/${runId}.${workflow}.export.json`, raw || res.stderr || '');
  try { result = JSON.parse(raw); } catch { result = null; }
  if (!result) { console.error(`[run-headless] claude exited ${res.status}: ${(res.stderr || '').slice(-2000)}`); process.exit(res.status || 1); }
  sessionId = result.session_id;
  reported = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  outcome = result.is_error ? (result.subtype === 'error_max_turns' ? 'max-turns' : result.subtype === 'error_max_budget_usd' ? 'max-budget' : 'error') : 'success';
  console.error(`[run-headless] session ${sessionId} turns=${result.num_turns} cost=${reported} denials=${(result.permission_denials || []).length} outcome=${outcome}`);
} else {
  const args = ['.claude/scripts/run-workflow.mjs', workflow, '--args', JSON.stringify({ companyId: company, appIds: apps, envIds: envs, dryRun, runId })];
  if (opt('--model')) args.push('--model', opt('--model'));
  if (dryRun) args.push('--dry-run');
  console.error(`[run-headless] node ${args.join(' ')}`);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
  writeFileSync(`${logDir}/${runId}.${workflow}.export.json`, res.stdout || '');
  try { result = JSON.parse(res.stdout); } catch { result = null; }
  outcome = res.status === 0 ? 'success' : 'error';
  // OpenCode sessions are ingested by the plugin (session.idle); list them from the runtime log for this run.
  const log = `${logDir}/run-workflow.log`;
  if (existsSync(log)) {
    const ids = new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.workflow === workflow && e.sessionId).map((e) => e.sessionId));
    for (const sid of ids) spawnSync(process.execPath, ['.claude/scripts/sessions/ingest.mjs', '--harness', 'opencode', '--session', sid, '--force'], { stdio: 'inherit', env });
  }
}

if (harness === 'claude-code' && sessionId) {
  const ingestArgs = ['.claude/scripts/sessions/ingest.mjs', '--harness', 'claude-code', '--session', sessionId, '--force', '--outcome', outcome];
  if (reported !== null) ingestArgs.push('--reported', String(reported));
  const ing = spawnSync(process.execPath, ingestArgs, { encoding: 'utf8', env });
  process.stderr.write(ing.stdout + ing.stderr);
}
console.log(JSON.stringify({ workflow, company, harness, runId, sessionId, reportedCostUsd: reported, outcome, durationMs: Date.now() - started, result: harness === 'claude-code' ? (result && result.result) : result }, null, 2));
process.exit(outcome === 'success' ? 0 : 1);
