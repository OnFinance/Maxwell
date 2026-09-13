#!/usr/bin/env node
// SessionEnd hook: ingests the harness transcript for KPI extraction according to the sampling policy in
// kpis/metrics.json, then computes the session summary. Never blocks the harness (always exits 0).
import { readStdinJson, workspaceRoot } from './lib.mjs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const input = readStdinJson();
const root = workspaceRoot(input);
const harness = process.env.MAXWELL_HARNESS || 'claude-code';
const sessionId = input.session_id || process.env.MAXWELL_SESSION_ID;
if (!sessionId) process.exit(0);

const args = [resolve(root, '.claude/scripts/sessions/ingest.mjs'), '--harness', harness, '--session', sessionId];
if (input.transcript_path) args.push('--transcript', input.transcript_path);
const res = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env });
if (res.status !== 0) process.stderr.write(`[maxwell] session ingest failed (non-blocking):\n${res.stderr}\n`);
process.exit(0);
