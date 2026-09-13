#!/usr/bin/env node
// SessionStart hook: records session metadata for KPI attribution and injects run context.
// Writes kpis/data/raw/sessions/<harness>/<sessionId>.meta.json (workflow defaults to "manual" until a
// /<workflow> prompt is seen by user-prompt.mjs). Prints additionalContext JSON for the harness.
import { readStdinJson, workspaceRoot, writeJson, readJsonIfExists, ulid } from './lib.mjs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const input = readStdinJson();
const root = workspaceRoot(input);
const harness = process.env.MAXWELL_HARNESS || 'claude-code';
const sessionId = input.session_id || process.env.MAXWELL_SESSION_ID;
if (!sessionId) process.exit(0);

const runId = process.env.MAXWELL_RUN_ID || `run_${ulid()}`;
const metaPath = resolve(root, `kpis/data/raw/sessions/${harness}/${sessionId}.meta.json`);
const existing = readJsonIfExists(metaPath);
const git = (args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : undefined; };
const version = harness === 'claude-code'
  ? (spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout || '').trim().split(' ')[0] || 'unknown'
  : (process.env.MAXWELL_HARNESS_VERSION || 'unknown');

const meta = existing || {
  schemaVersion: '1',
  kind: 'maxwell.session.meta',
  sessionId,
  harness,
  harnessVersion: version,
  runId,
  workflow: 'manual',
  args: { appIds: [], envIds: [], dryRun: false },
  startedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  cwd: root,
  gitBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  gitCommit: git(['rev-parse', 'HEAD']),
  transcriptPath: `kpis/data/raw/sessions/${harness}/${sessionId}.jsonl`,
  sampled: false,
  samplingReason: 'all',
  model: process.env.MAXWELL_MODEL || 'unknown',
  invokedBy: { type: process.env.MAXWELL_INVOKED_BY ? 'human' : 'script', id: process.env.MAXWELL_INVOKED_BY || 'headless' },
  provenance: { harness: 'script', generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), sessionId, runId, agent: 'hooks/session-start' },
};
if (!existing) writeJson(metaPath, meta);

const context = `Maxwell session ${sessionId} (run ${runId}). Workspace: ${root}. Read AGENTS.md before writing. Run \`npm run validate\` before finishing.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
