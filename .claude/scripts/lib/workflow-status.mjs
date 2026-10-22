// Decides whether a headless Claude Code session actually finished the workflow it launched.
// `claude -p` waits for a background workflow only up to CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS of idle time
// (10 minutes by default) and then stops it and drops its result, while still reporting the session as a
// success. The reliable signal is the <task-notification> the harness delivers into the transcript when the
// workflow ends: its <status> is "completed" only for a workflow that ran to its return statement.
// "completed" is still not enough: when the account hits a session limit mid-run, the agents that were running
// fail, the script carries on with empty results and returns normally. The workflow's output file lists every
// agent with its state, so failed agents (and the limit message) are read from there.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Where run-workflow.mjs records the OpenCode sessions each agent call started, so run-headless.mjs can ingest them.
// Outside the workspace: it is runtime state, not a sanctioned artefact.
export const opencodeSessionLog = (env = process.env) => env.MAXWELL_OPENCODE_SESSION_LOG || join(env.HOME || homedir(), '.cache', 'maxwell', 'opencode', 'sessions.log');

// Account-wide limits: every model is affected, so the only remedy is to wait for the reset.
export const ACCOUNT_LIMIT = /hit your (?:session|weekly|usage|daily)[\w -]* limit/i;

export function findTranscript(sessionId, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const p of readdirSync(projects)) {
    const f = join(projects, p, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

// lines: transcript JSONL lines. Returns { launched, workflowName, status, outputFile } where status is the last
// task-notification status seen for a dynamic workflow ("completed", "failed", "killed", ...) or null.
export function workflowStatusFromTranscript(lines) {
  let launched = false; let workflowName = null; let status = null; let outputFile = null;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec.message && Array.isArray(rec.message.content) ? rec.message.content : [];
    for (const block of content) {
      if (block && block.type === 'tool_use' && block.name === 'Workflow') {
        launched = true;
        workflowName = (block.input && block.input.name) || workflowName;
      }
    }
    if (!line.includes('task-notification')) continue;
    const text = line.replace(/\\n/g, '\n');
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = m[1];
      const summary = (/<summary>([\s\S]*?)<\/summary>/.exec(body) || [])[1] || '';
      const st = (/<status>(\w+)<\/status>/.exec(body) || [])[1] || null;
      if (st && /workflow/i.test(summary)) {
        status = st;
        outputFile = (/<output-file>([^<]+)<\/output-file>/.exec(body) || [])[1] || outputFile;
      }
    }
  }
  return { launched, workflowName, status, outputFile };
}

// text: the workflow output file. Returns { failedAgents, errors } for agents whose state is "error".
export function agentFailures(text) {
  const errors = [];
  let doc = null;
  try { doc = JSON.parse(text); } catch { doc = null; }
  const visit = (v) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    if (v.type === 'workflow_agent' && v.state === 'error') errors.push({ label: v.label || v.agentId || 'agent', error: String(v.error || '') });
    Object.values(v).forEach(visit);
  };
  if (doc) visit(doc);
  else {
    // Unparsable (truncated) output: fall back to the per-agent error strings.
    for (const m of String(text || '').matchAll(/"state":\s*"error"[\s\S]{0,4000}?"error":\s*"((?:[^"\\]|\\.)*)"/g)) errors.push({ label: 'agent', error: m[1] });
  }
  return { failedAgents: errors.length, errors };
}

// "You've hit your session limit · resets 1:10pm (UTC)" (optionally "resets Sep 15, 1:10pm (UTC)") -> Date of
// the next such moment after `now`, or null when no reset time can be read.
export function parseLimitReset(text, now = new Date()) {
  const m = /resets\s+(?:([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(String(text || ''));
  if (!m) return null;
  let hour = Number(m[3]) % 12;
  if (/pm/i.test(m[5])) hour += 12;
  const at = new Date(now.getTime());
  at.setUTCSeconds(0, 0);
  at.setUTCHours(hour, Number(m[4] || 0));
  if (m[1]) {
    const month = new Date(`${m[1]} 1, 2000 00:00:00 UTC`).getUTCMonth();
    if (!Number.isNaN(month)) at.setUTCMonth(month, Number(m[2]));
    if (at <= now) at.setUTCFullYear(at.getUTCFullYear() + 1);
  } else if (at <= now) {
    at.setUTCDate(at.getUTCDate() + 1);
  }
  return at;
}

export function workflowStatus(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return { launched: false, workflowName: null, status: null, outputFile: null, failedAgents: 0, errors: [], transcript: null };
  const st = workflowStatusFromTranscript(readFileSync(file, 'utf8').split('\n'));
  const failures = st.outputFile && existsSync(st.outputFile) ? agentFailures(readFileSync(st.outputFile, 'utf8')) : { failedAgents: 0, errors: [] };
  return { ...st, ...failures, transcript: file };
}

// The true outcome of one headless Claude Code invocation that ran a saved workflow. `claude -p` can report success
// while the workflow it launched never finished: the budget ran out while the workflow ran in the background, the
// idle ceiling dropped it, an agent failed, or it was never launched. Pure: every input is passed in.
//   result: the parsed `claude -p --output-format json` object; wf: workflowStatus(); budgetUsd: --budget-usd or null.
// Returns { outcome, finished, reason } with outcome in success|error|max-turns|max-budget (the session summary vocabulary)
// and reason a plain sentence (null on success) that never quotes the session's own text.
export function classifyWorkflowRun({ result, wf, budgetUsd = null }) {
  const r = result || {};
  const reported = typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null;
  const budget = budgetUsd === null || budgetUsd === undefined || budgetUsd === '' ? null : Number(budgetUsd);
  const subtype = r.is_error ? (r.subtype === 'error_max_turns' ? 'max-turns' : r.subtype === 'error_max_budget_usd' ? 'max-budget' : 'error') : 'success';
  const w = wf || { launched: false, status: null, failedAgents: 0, errors: [] };
  const finished = Boolean(w.launched && w.status === 'completed' && (w.failedAgents || 0) === 0);
  if (finished) {
    // Every agent finished; a limit that only cut off the session's closing report does not fail the run.
    if (subtype === 'error' && ACCOUNT_LIMIT.test(String(r.result || ''))) return { outcome: 'success', finished, reason: null };
    return { outcome: subtype, finished, reason: subtype === 'success' ? null : `the workflow completed but the session ended with ${r.subtype || 'an error'}` };
  }
  const budgetHit = subtype === 'max-budget' || (budget !== null && Number.isFinite(budget) && reported !== null && reported >= budget);
  const where = !w.launched ? 'before the workflow was launched'
    : w.status === null ? 'while the workflow was still running in the background, so its result was dropped'
      : w.status === 'completed' ? `after the workflow completed with ${w.failedAgents} failed agent${w.failedAgents === 1 ? '' : 's'}`
        : `after the workflow ended with status ${w.status}`;
  if (budgetHit) return { outcome: 'max-budget', finished, reason: `the budget${budget !== null ? ` of ${budget} USD` : ''} was reached${reported !== null ? ` (reported ${Math.round(reported * 100) / 100} USD)` : ''} ${where}` };
  if (subtype === 'max-turns') return { outcome: 'max-turns', finished, reason: `the turn limit was reached ${where}` };
  if (!w.launched) return { outcome: 'error', finished, reason: r.is_error ? 'the session failed before the workflow was launched (see result)' : 'the session ended without launching the workflow' };
  if (w.status === null) return { outcome: 'error', finished, reason: 'the session ended while the workflow was still running in the background, so its result was dropped' };
  if (w.status === 'completed') {
    const labels = (w.errors || []).map((e) => e.label).filter(Boolean).slice(0, 5);
    return { outcome: 'error', finished, reason: `${w.failedAgents} agent${w.failedAgents === 1 ? '' : 's'} failed${labels.length ? ` (${labels.join(', ')})` : ''}` };
  }
  return { outcome: 'error', finished, reason: `the workflow ended with status ${w.status}` };
}
