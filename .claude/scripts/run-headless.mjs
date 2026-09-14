#!/usr/bin/env node
// Runs one Maxwell workflow headlessly on a harness and ingests the session for KPIs.
// Usage: run-headless.mjs --workflow <name> --company <id> [--harness claude-code|opencode] [--model opus|provider/model]
//        [--fallback-model <m>] [--app <id>]... [--env <id>]... [--dry-run] [--run-id run_...] [--max-turns 400] [--budget-usd <n>]
// Model policy: default --model opus. When another model is requested (e.g. fable) Claude Code is given
// --fallback-model opus so a usage limit or overload on that model continues on Opus instead of failing.
// OpenCode defaults to anthropic/claude-opus-5 (override with --model or MAXWELL_OPENCODE_MODEL).
// Claude Code: claude -p --output-format json "/<workflow> <company> ..." (project settings/hooks/skills load from
//   the workspace; --bare is not used because it requires ANTHROPIC_API_KEY and skips the validation hooks).
// OpenCode: node .claude/scripts/run-workflow.mjs <workflow> --args '{...}' (headless opencode run sessions).
// Afterwards the session is ingested with --force and the harness-reported cost for the cross-check.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ulid } from '../hooks/lib.mjs';
import { ACCOUNT_LIMIT, opencodeSessionLog, parseLimitReset, workflowStatus } from './lib/workflow-status.mjs';

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
// claude -p waits for a background workflow only CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS of idle time (10 min by
// default), then stops it and drops its result while still reporting success. Maxwell workflows fan out to many
// agents, so allow 4 hours; completion is verified from the transcript below either way.
if (!env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = String(4 * 60 * 60 * 1000);

let sessionId = null; let reported = null; let outcome = 'success'; let result = null;
// Workflows are deterministic scripts: they cannot read the clock, so the run timestamp is taken once here.
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const workflowArgs = { companyId: company, appIds: apps, envIds: envs, dryRun, now, runId };
const utility = new Set(['validate', 'kpis', 'seed-company', 'status', 'connect-sandbox', 'manual']);
// report-audit-improvements renders KPI series but no roster agent may run `npm run kpis`, so compute them first.
if (workflow === 'report-audit-improvements') {
  const k = spawnSync(process.execPath, ['.claude/scripts/kpis/compute.mjs', '--company', company], { encoding: 'utf8', env });
  process.stderr.write(`[run-headless] kpis computed before report (exit ${k.status})\n${(k.stdout || '') + (k.stderr || '')}`);
}
if (harness === 'claude-code') {
  const model = opt('--model', process.env.MAXWELL_MODEL || 'opus');
  const fallback = opt('--fallback-model', process.env.MAXWELL_FALLBACK_MODEL || (/^(opus|claude-opus)/.test(model) ? '' : 'opus'));
  env.MAXWELL_MODEL = model;
  // Utility commands take the shorthand form; saved workflows get a structured args object (Claude passes it to
  // the Workflow tool as data, see code.claude.com/docs/en/workflows "Pass input to a saved workflow").
  const promptFor = (sid) => (utility.has(workflow)
    ? [`/${workflow}`, company, ...apps.map((a) => `--app=${a}`), ...envs.map((e) => `--env=${e}`), ...(dryRun ? ['--dry-run'] : [])].join(' ')
    : `Run /${workflow} with exactly this args object, passed as structured data (not a string), and report its result: ${JSON.stringify({ ...workflowArgs, sessionId: sid })}`);
  // A usage limit on the requested model comes back as a 429 api_error result, which --fallback-model does not
  // cover (it only handles overload). Retry the whole invocation on the fallback model in that case.
  const isLimit = (r) => !!r && r.is_error && (r.api_error_status === 429 || /reached your .* limit|usage limit|rate limit/i.test(String(r.result || '')));
  const attempts = [model, ...(fallback && fallback !== model ? [fallback] : [])];
  // An account-wide session limit stops every model, so wait for its reset and run the workflow again (probes are
  // idempotent through finding fingerprints). The limit message carries the reset time.
  const maxLimitWaits = Number(opt('--limit-waits', process.env.MAXWELL_LIMIT_WAITS || '3'));
  let limitWaits = 0;
  const sleepUntil = (at) => {
    const ms = Math.max(0, at.getTime() - Date.now());
    console.error(`[run-headless] account limit: waiting ${Math.round(ms / 60000)} min until ${at.toISOString()}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };
  for (let i = 0; i < attempts.length; i += 1) {
    const m = attempts[i];
    env.MAXWELL_MODEL = m;
    const sid = randomUUID();
    const prompt = promptFor(sid);
    const args = ['-p', '--output-format', 'json', '--session-id', sid, '--model', m, '--permission-mode', opt('--permission-mode', 'auto'), '--max-turns', opt('--max-turns', '400'), '--setting-sources', 'project'];
    if (i === 0 && fallback) args.push('--fallback-model', fallback);
    if (opt('--budget-usd')) args.push('--max-budget-usd', opt('--budget-usd'));
    args.push(prompt);
    console.error(`[run-headless] claude ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
    const res = spawnSync('claude', args, { encoding: 'utf8', env, maxBuffer: 1 << 28 });
    const raw = (res.stdout || '').trim();
    writeFileSync(`${logDir}/${runId}.${workflow}${i ? '.' + m : ''}.export.json`, raw || res.stderr || '');
    try { result = JSON.parse(raw); } catch { result = null; }
    if (!result) { console.error(`[run-headless] claude exited ${res.status}: ${(res.stderr || '').slice(-2000)}`); process.exit(res.status || 1); }
    sessionId = result.session_id;
    reported = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
    outcome = result.is_error ? (result.subtype === 'error_max_turns' ? 'max-turns' : result.subtype === 'error_max_budget_usd' ? 'max-budget' : 'error') : 'success';
    console.error(`[run-headless] model=${m} session ${sessionId} turns=${result.num_turns} cost=${reported} denials=${(result.permission_denials || []).length} outcome=${outcome}`);
    const limitMessages = ACCOUNT_LIMIT.test(String(result.result || '')) ? [String(result.result)] : [];
    let finished = outcome === 'success';
    if (!utility.has(workflow)) {
      const wf = workflowStatus(sessionId);
      for (const e of wf.errors) if (ACCOUNT_LIMIT.test(e.error)) limitMessages.push(e.error);
      finished = wf.launched && wf.status === 'completed' && wf.failedAgents === 0;
      if (finished) {
        // Every agent finished; a limit that only cut off the session's closing report does not fail the run.
        if (outcome === 'error' && ACCOUNT_LIMIT.test(String(result.result || ''))) outcome = 'success';
        console.error(`[run-headless] ${workflow} completed (task-notification status ${wf.status}, no failed agents)`);
      } else {
        if (outcome === 'success') outcome = 'error';
        console.error(`[run-headless] ${workflow} did not complete: launched=${wf.launched} status=${wf.status || 'none'} failedAgents=${wf.failedAgents} (transcript ${wf.transcript || 'not found'})`);
      }
    }
    if (!finished && limitMessages.length && limitWaits < maxLimitWaits) {
      spawnSync(process.execPath, ['.claude/scripts/sessions/ingest.mjs', '--harness', 'claude-code', '--session', sessionId, '--force', '--outcome', 'error'], { encoding: 'utf8', env });
      const at = parseLimitReset(limitMessages[0]) || new Date(Date.now() + 30 * 60000);
      sleepUntil(new Date(at.getTime() + 2 * 60000));
      limitWaits += 1;
      console.error(`[run-headless] retrying ${workflow} on ${m} after the account limit reset (${limitWaits}/${maxLimitWaits})`);
      i -= 1;
      continue;
    }
    if (isLimit(result) && !ACCOUNT_LIMIT.test(String(result.result || '')) && i + 1 < attempts.length) {
      console.error(`[run-headless] ${m} hit a usage limit; retrying on ${attempts[i + 1]}`);
      spawnSync(process.execPath, ['.claude/scripts/sessions/ingest.mjs', '--harness', 'claude-code', '--session', sessionId, '--force', '--outcome', 'error'], { encoding: 'utf8', env });
      continue;
    }
    break;
  }
} else {
  const args = ['.claude/scripts/run-workflow.mjs', workflow, '--args', JSON.stringify(workflowArgs)];
  args.push('--model', opt('--model', process.env.MAXWELL_OPENCODE_MODEL || 'anthropic/claude-opus-5'));
  if (dryRun) args.push('--dry-run');
  console.error(`[run-headless] node ${args.join(' ')}`);
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
  writeFileSync(`${logDir}/${runId}.${workflow}.export.json`, res.stdout || '');
  try { result = JSON.parse(res.stdout); } catch { result = null; }
  outcome = res.status === 0 ? 'success' : 'error';
  // OpenCode sessions are ingested by the plugin (session.idle); list this run's from the session log run-workflow.mjs
  // keeps outside the workspace. Ingest output goes to stderr so stdout stays the one JSON result.
  const log = opencodeSessionLog();
  if (existsSync(log)) {
    const ids = new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && e.workflow === workflow && e.sessionId && (!e.runId || e.runId === runId)).map((e) => e.sessionId));
    for (const sid of ids) spawnSync(process.execPath, ['.claude/scripts/sessions/ingest.mjs', '--harness', 'opencode', '--session', sid, '--force'], { stdio: ['ignore', 2, 2], env: { ...env, MAXWELL_WORKFLOW: workflow, MAXWELL_COMPANY_ID: company } });
  }
}

if (harness === 'claude-code' && sessionId) {
  const ingestArgs = ['.claude/scripts/sessions/ingest.mjs', '--harness', 'claude-code', '--session', sessionId, '--force', '--outcome', outcome];
  if (reported !== null) ingestArgs.push('--reported', String(reported));
  const ing = spawnSync(process.execPath, ingestArgs, { encoding: 'utf8', env: { ...env, MAXWELL_WORKFLOW: workflow, MAXWELL_COMPANY_ID: company } });
  process.stderr.write(ing.stdout + ing.stderr);
}
console.log(JSON.stringify({ workflow, company, harness, runId, sessionId, reportedCostUsd: reported, outcome, durationMs: Date.now() - started, result: harness === 'claude-code' ? (result && result.result) : result }, null, 2));
process.exit(outcome === 'success' ? 0 : 1);
