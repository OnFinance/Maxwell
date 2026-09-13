---
description: Summarise the workspace state for a company - open findings by severity, overdue initiatives, pending suggestions, last refresh times
argument-hint: <company_id>
allowed-tools: Bash(node .claude/scripts/*), Bash(git status *), Bash(git log *), Read
x-maxwell:
  workflow: status
  touches: []
  readsCredentials: false
---
For company `$1`, read `company-profile/$1/soc/main.jsonl`, `change_management/master.json`,
`suggestions/master.json` and `summary.md` frontmatter. Report, in this order and without editing anything:
1. Open findings by severity and the three oldest past their `slaDueAt`.
2. Initiatives that are overdue (`dueAt` in the past and status not closed/cancelled) with owner and task counts.
3. Suggestions in `proposed` or `surfaced` state older than 14 days.
4. Last `soc/versions/commit_<n>.diff` number and generation time, and the last `summary.md` `generatedAt`.
5. Applications with an environment whose `observability.logsRetentionDays` is below 180 (CERT-In).
Keep it to a screen of text.
