import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import { convertAgent } from '../sync-agents-mirror.mjs';

// Claude Code (2.1.316) refuses a subagent's Write when the file name matches this pattern, before any permission
// mode or rule is consulted, with "Subagents should return findings as text, not write report files". Edit is not
// guarded. report-writer is always a subagent and summary.md matches, so every change to summary.md goes through Edit.
const CLAUDE_CODE_SUBAGENT_REPORT_GUARD = /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i;

test('summary.md is a name Claude Code refuses to a subagent Write', () => {
  assert.ok(CLAUDE_CODE_SUBAGENT_REPORT_GUARD.test('summary.md'));
});

test('report-writer changes summary.md with Edit only and keeps its tools (and the OpenCode mirror) as they were', () => {
  const src = readFileSync('.claude/agents/report-writer.md', 'utf8');
  const { data, content } = matter(src);
  assert.ok(data.tools.includes('Edit'), 'report-writer needs Edit');
  assert.ok(data.tools.includes('Write'), 'Write stays in tools so the OpenCode mirror (write: allow) is unchanged');
  assert.match(content, /## Changing summary\.md: Edit only, never Write/);
  assert.match(content, /Never call Write on `summary\.md`/);
  assert.match(content, /`old_string` is\s+empty/, 'an absent summary.md is created with Edit');
  const perm = convertAgent(src, { bashAllow: [], bashDeny: [] }).config.permission;
  assert.equal(perm.edit, 'allow');
  assert.equal(perm.write, 'allow');
});

test('report-templates procedure applies the sections with Edit, not Write', () => {
  const skill = readFileSync('.claude/skills/report-templates/SKILL.md', 'utf8');
  assert.doesNotMatch(skill, /4\. Write the file with the merged sections/);
  assert.match(skill, /4\. Apply the merged sections[^]*with Edit/);
});

// Runs the workflow body with stub globals the way the Workflow tool and run-workflow.mjs do, and returns every
// prompt sent to an agent, keyed by label.
async function runWorkflow(name) {
  const source = readFileSync(`.claude/workflows/${name}.js`, 'utf8').replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =');
  const prompts = {};
  const agent = async (prompt, opts = {}) => {
    prompts[opts.label] = { prompt: String(prompt), agentType: opts.agentType };
    const label = opts.label || '';
    if (label.startsWith('scout')) {
      return { now: '2026-11-01T09:13:33Z', inputsHash: 'a'.repeat(64), adjustedInputsHash: 'b'.repeat(64), currentInputsHash: 'c'.repeat(64),
        currentVersion: '3.2.0', currentWorkflow: 'probe-agent-graph', currentGeneratedAt: '2026-11-01T09:00:00Z', currentSections: ['overview'],
        newerLedgerLines: 1, newerApplicationRecords: 0, lastOwnReportResult: '', facts: {}, skipped: [],
        initiatives: { total: 0 }, suggestions: { total: 0 }, kpiRows: [] };
    }
    if (label.startsWith('render') || label.startsWith('repair')) {
      return { written: false, sectionsRewritten: ['overview'], sectionsOmitted: [], markdown: '## overview\nApproved text.\n', counts: {}, notes: '' };
    }
    if (label.startsWith('check')) return { refuted: false, confidence: 'high', lens: 'x', reason: '', checked: [], unverifiable: [], discrepancies: [] };
    if (label.startsWith('write')) return { written: true, sectionsWritten: ['overview'], version: '4.0.0', inputsHash: 'a'.repeat(64), notes: '' };
    if (label.startsWith('validate')) return { validationGreen: true, sectionsMatchApproved: true, failuresInFile: [], failuresElsewhere: [], fixed: [], schemaIssues: [] };
    return { observationIds: [], skipped: [] };
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => { let v = item; for (const s of stages) v = await s(v, item, i); return v; }));
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const body = new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', 'budget', 'workflow', source);
  const result = await body(agent, pipeline, parallel, () => {}, () => {}, { companyId: 'acme', now: '2026-11-01T09:13:33Z' }, budget, async () => null);
  return { prompts, result };
}

for (const name of ['report-audit-findings', 'report-audit-improvements']) {
  test(`${name}: the write step tells report-writer to splice summary.md with Edit, never Write`, async () => {
    const { prompts } = await runWorkflow(name);
    const write = prompts['write sections'];
    assert.ok(write, 'the write step ran');
    assert.equal(write.agentType, 'report-writer');
    assert.match(write.prompt, /Splice the APPROVED sections below into company-profile\/acme\/summary\.md with Edit/);
    assert.match(write.prompt, /with the Edit tool only, never Write/);
    assert.match(write.prompt, /empty old_string/);
    assert.doesNotMatch(write.prompt, /Write the APPROVED sections/);
    for (const [label, p] of Object.entries(prompts)) {
      if (p.agentType === 'report-writer') assert.doesNotMatch(p.prompt, /with the Write tool/, label);
    }
  });
}
