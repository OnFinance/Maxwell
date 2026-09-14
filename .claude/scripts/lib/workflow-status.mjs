// Decides whether a headless Claude Code session actually finished the workflow it launched.
// `claude -p` waits for a background workflow only up to CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS of idle time
// (10 minutes by default) and then stops it and drops its result, while still reporting the session as a
// success. The reliable signal is the <task-notification> the harness delivers into the transcript when the
// workflow ends: its <status> is "completed" only for a workflow that ran to its return statement.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function findTranscript(sessionId, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  const projects = join(configDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const p of readdirSync(projects)) {
    const f = join(projects, p, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

// lines: transcript JSONL lines. Returns { launched, workflowName, status } where status is the last
// task-notification status seen for a dynamic workflow ("completed", "failed", "killed", ...) or null.
export function workflowStatusFromTranscript(lines) {
  let launched = false; let workflowName = null; let status = null;
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
      if (st && /workflow/i.test(summary)) status = st;
    }
  }
  return { launched, workflowName, status };
}

export function workflowStatus(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return { launched: false, workflowName: null, status: null, transcript: null };
  return { ...workflowStatusFromTranscript(readFileSync(file, 'utf8').split('\n')), transcript: file };
}
