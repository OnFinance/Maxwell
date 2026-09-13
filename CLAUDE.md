@AGENTS.md

## Claude Code specifics
- Hooks in `.claude/settings.json` validate every JSON/JSONL/frontmatter write and block writes outside the layout
  or containing secret-shaped strings. A blocked write returns the validator's errors; fix the content, do not
  work around the hook.
- Headless runs use `claude --bare -p --model opus "/<workflow> <company_id>"`; pass `MAXWELL_RUN_ID` to group
  sessions into one audit run for KPI attribution.
- Workflow scripts in `.claude/workflows/` are Workflow-tool scripts (`export const meta` first; only
  `agent/pipeline/parallel/phase/log/args`). Never use `Date.now()`, `Math.random()` or filesystem APIs inside them.
- Subagents in `.claude/agents/` are the only agents workflows may spawn by name; do not define ad-hoc agents.
