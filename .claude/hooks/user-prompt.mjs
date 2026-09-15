#!/usr/bin/env node
// UserPromptSubmit hook: when the prompt invokes "/<workflow> <company_id> [--app=.. --env=.. --dry-run]",
// records the workflow and target in the session meta file so KPIs can attribute cost per workflow/company.
import { readStdinJson, workspaceRoot, readJsonIfExists, writeJson, parseWorkflowInvocation } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = readStdinJson();
const root = workspaceRoot(input);
const harness = process.env.MAXWELL_HARNESS || 'claude-code';
const sessionId = input.session_id || process.env.MAXWELL_SESSION_ID;
if (!sessionId) process.exit(0);
// Messages the harness injects (a background workflow's <task-notification>, reminders) are not invocations: they
// quote workflow output, and its first /<name> mention once relabelled probe-schemas as connect-sandbox and
// report-audit-improvements as kpis, corrupting cost per workflow.
if (typeof input.prompt !== 'string' || /^\s*</.test(input.prompt)) process.exit(0);
const workflows = JSON.parse(readFileSync(resolve(root, '.claude/schemas/vocab/workflows.schema.json'), 'utf8')).enum;
const inv = parseWorkflowInvocation(input.prompt, workflows);
if (!inv) process.exit(0);

const metaPath = resolve(root, `kpis/data/raw/sessions/${harness}/${sessionId}.meta.json`);
const meta = readJsonIfExists(metaPath);
if (!meta) process.exit(0);
// The headless runner names the workflow it launched; a session keeps the first real workflow it was given.
const runnerWorkflow = workflows.includes(process.env.MAXWELL_WORKFLOW) ? process.env.MAXWELL_WORKFLOW : null;
if (runnerWorkflow && inv.workflow !== runnerWorkflow) process.exit(0);
if (meta.workflow && meta.workflow !== 'manual' && meta.workflow !== inv.workflow) process.exit(0);
meta.workflow = inv.workflow;
if (inv.companyId) meta.companyId = inv.companyId;
meta.args = inv.args;
writeJson(metaPath, meta);
process.exit(0);
