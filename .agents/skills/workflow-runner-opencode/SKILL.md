---
name: workflow-runner-opencode
description: How to run any of the 25 Maxwell workflows on OpenCode with node .claude/scripts/run-workflow.mjs <name> --args '{"companyId":"…"}' [--model provider/model] [--dry-run] [--concurrency N] - what the runtime provides to the workflow script (agent, pipeline, parallel, phase, log, args, budget over headless opencode run sessions with schema-validated retries), the MAXWELL_RUN_ID / MAXWELL_OPENCODE_MODEL / MAXWELL_OPENCODE_AUTO / MAXWELL_TOKEN_BUDGET env vars, how sessions are ingested for KPIs, the limitations (no nested workflow(), agentType maps to opencode.json agents) the run-headless.mjs wrapper for CI, and provider auth via opencode auth login or ANTHROPIC_API_KEY in the host environment without storing keys in the workspace. Load when Maxwell is driven from OpenCode instead of the Claude Code Workflow tool.
license: AGPL-3.0-only
compatibility: OpenCode >= 1.18 on PATH with at least one provider authenticated, Node 22, the Maxwell workspace as the working directory, and a synced .agents mirror (npm run sync:agents)
metadata:
  author: OnFinance
  version: "1.0.0"
  runtime: .claude/scripts/run-workflow.mjs
when_to_use: The harness is OpenCode (MAXWELL_HARNESS=opencode), a /<workflow> command is requested inside OpenCode, or CI needs to run a workflow headlessly without Claude Code
user-invocable: true
argument-hint: <workflow-name> --args '{"companyId":"<company_id>"}' [--dry-run]
x-maxwell:
  kind: runbook
  workflows: [refresh-soc, refresh-ctx, refresh-vendor-ctx, refresh-metastore, probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env, runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, impl-change-management, impl-auto-improvement, report-audit-findings, report-audit-improvements]
---
# Running Maxwell workflows on OpenCode

Workflow scripts in `.claude/workflows/<name>.js` are written once for the Claude Code Workflow tool. On
OpenCode the same file is executed by `node .claude/scripts/run-workflow.mjs`, which supplies the globals the
script expects and turns every `agent()` call into one headless `opencode run` session in this workspace.
`.agents/workflows/` is a verbatim mirror (`npm run sync:agents`); the runner always reads the canonical
`.claude/` copy.

## 1. Command line
```
node .claude/scripts/run-workflow.mjs <name> [--args '<json>'] [--model provider/model] \
     [--concurrency N] [--dry-run] [--agent-type general]
```
| Flag | Meaning |
|---|---|
| `<name>` | one of the 25 names in `.claude/schemas/vocab/workflows.schema.json`; the file must exist |
| `--args` | JSON object exposed to the script as `args`; always pass `companyId`, and for probes `appIds`, `envIds`, `now` (RFC 3339 UTC, because scripts may not call `Date.now()`), `dryRun` |
| `--model` | `provider/model` for every session (`anthropic/claude-sonnet-5`, `amazon-bedrock/global.anthropic.claude-sonnet-5`); overrides `MAXWELL_OPENCODE_MODEL`; default `anthropic/claude-opus-5` when neither is set. A per-call `opts.model` in the script overrides both; the aliases `opus`, `sonnet`, `haiku`, `fable` map to `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4-5-20251001`, `anthropic/claude-fable-5-1` |
| `--concurrency` | parallel sessions cap; default `min(16, cpus - 2)`; use `1` on laptops and against rate-limited providers |
| `--dry-run` | no session is started; `agent()` returns `"[dry-run] <label>"` or `null` when a schema was requested; use it to check a script's phases and arg handling. It is **not** a probe dry run: a runtime probe's plan-only mode is `args.dryRun: true`, which still starts agent sessions that read the workspace and plan commands |
| `--agent-type` | default OpenCode agent for calls that do not set `opts.agentType`; `general` is the built-in |

Examples:
```
MAXWELL_RUN_ID=run_01J9Z6X3F8N2Q4R5S6T7V8W9XE node .claude/scripts/run-workflow.mjs refresh-soc \
  --args '{"companyId":"kalpataru-securities","now":"2026-09-13T17:00:00Z"}' --model anthropic/claude-sonnet-5
node .claude/scripts/run-workflow.mjs runtime-probe-prod-env \
  --args '{"companyId":"kalpataru-securities","appIds":["trading-api"],"envIds":["prod-mumbai"],"now":"2026-09-13T17:00:00Z","dryRun":true}' --concurrency 1
node .claude/scripts/run-workflow.mjs report-audit-findings --args '{"companyId":"kalpataru-securities"}' --dry-run
```
The runner prints progress to stderr (`[<name>] == phase ==`, `[<name>] ▸ phase / label`, `[<name>] ✗ error`)
and a single JSON object to stdout: `{workflow, runId, agents, result}` where `result` is the script's return
value. Exit code is 0 unless the script throws. The second example starts real sessions that plan the prod probe
without touching the target (`args.dryRun`); the third starts no session at all and only exercises the script.

Wrapper for scheduled or CI runs: `node .claude/scripts/run-headless.mjs --workflow <name> --company <id>
--harness opencode [--app <id>]... [--env <id>]... [--model provider/model] [--run-id run_…] [--dry-run]`. It
mints `MAXWELL_RUN_ID` when absent, sets `MAXWELL_KPI_SAMPLE=1`, calls `run-workflow.mjs` with `--args
{companyId, appIds, envIds, dryRun, runId}`, saves stdout to `kpis/data/raw/sessions/opencode/<runId>.<workflow>.export.json`
and then force-ingests **every session logged in `run-workflow.log` under that workflow name**, including
sessions from earlier runs of the same workflow (the log records no `runId`, so it cannot filter to this run).
Re-ingesting is idempotent, so this costs time, not correctness. The wrapper never passes `args.now`, so a
probe started through it always falls back to a `date -u` taken inside the run (see
`.claude/skills/runtime-probe-rules-of-engagement` section 1); when you need a resume-stable time, call
`run-workflow.mjs` directly with `now` in `--args`. Its `--dry-run` is forwarded as both `args.dryRun` and the
runner's `--dry-run`, so no session starts; use `run-workflow.mjs` directly when you want the probe plan from
real sessions.

## 2. What the runtime provides
| Global | Behaviour on OpenCode |
|---|---|
| `agent(prompt, opts)` | one `opencode run --format json --agent <agentType> --title "<name>:<label>" [--model …] <prompt>`; returns the final text, or the parsed object when `opts.schema` is set. `opts`: `label`, `phase`, `agentType`, `model`, `effort` (appended as a note), `schema` (JSON Schema draft 2020-12) |
| schema retries | with `opts.schema` the prompt ends with "Respond with ONLY a single JSON object…"; the answer is extracted (`{…}`), parsed and validated with ajv; on failure the prompt is re-sent with the error text (session title `<label>#2`, `#3`), up to 3 attempts, then `null` is returned and `✗ never produced schema-valid output` logged. A session that exits non-zero with no text returns `null` immediately, without retry. Scripts must handle `null` |
| `parallel([...thunks])` | `Promise.all` with per-thunk error capture (`null` on throw); concurrency is still bounded by `--concurrency` |
| `pipeline(items, ...stages)` | runs the stages per item in order; an item whose stage throws becomes `null` and the rest continue |
| `phase(title)` | sets the current phase shown in progress lines; the runner does not check it, but `npm run validate` (validate-workflows) rejects a `phase('<title>')` with no matching `meta.phases[].title` |
| `log(msg)` | stderr progress line |
| `args` | the parsed `--args` object |
| `budget` | `{total, spent(), remaining()}`; `total` from `MAXWELL_TOKEN_BUDGET` (output tokens), else unlimited; `spent()` sums output tokens the JSON events report. Scripts should stop launching agents when `budget.remaining() < 20000` |
| `workflow()` | **not supported**: throws `nested workflow() is not supported by the OpenCode runtime` |
| cap | 1000 `agent()` calls per run |

The script file is loaded as an async function body; `export const meta = {…}` is rewritten to a `const`, so
the same file runs unmodified on both harnesses. Anything the workflow validator bans (`Date.now()`,
argless `new Date()`, `Math.random()`, `process.`, `fs.`, `import()`, `require()`) must not be used even though
some of them happen to be reachable inside the runner's function body: they break resume on Claude Code and
fail `npm run validate`. Timestamps come in through `args.now`.

## 3. Environment variables
| Variable | Effect |
|---|---|
| `MAXWELL_RUN_ID` | the `run_` ULID stamped into every session's environment and into `provenance.runId` of everything the agents write; generate one per invocation (`run_` + 26 Crockford base32) and export it before running. Without it `session-start.mjs` mints a fresh `run_` per session, so one workflow run is split into as many "runs" as it had agents and cost of audit per run is meaningless |
| `MAXWELL_OPENCODE_MODEL` | default `provider/model` when `--model` is absent |
| `MAXWELL_OPENCODE_AUTO` | `1` passes `--auto` to `opencode run`, which **approves every permission that is not explicitly denied** (every `ask` becomes allow; only `deny` rules and the plugin's write guard still block). Needed for unattended CI because a headless session cannot answer a prompt; set it only after reviewing the `deny` rules in `opencode.json` and the per-agent permissions, and leave it unset when a human is watching |
| `MAXWELL_TOKEN_BUDGET` | output-token ceiling exposed as `budget.total` |
| `MAXWELL_HARNESS` | set to `opencode` by the runner for every child session so hooks and provenance name the right harness |
| `MAXWELL_MODEL` | model recorded in a session meta file when the transcript does not name one |
| `MAXWELL_KPI_SAMPLE` | `1` makes ingest treat every session as sampled (same as `ingest.mjs --force`); `run-headless.mjs` sets it |

## 4. Agents and permissions
`opts.agentType` in a script names an OpenCode agent: a key of `agent` in `opencode.json`, which
`sync-agents-mirror.mjs` regenerates from `.claude/agents/<name>.md` (mode `subagent`, `prompt:
{file:./.agents/agents/<name>.prompt.md}`, tools mapped to OpenCode `permission`). A Claude Code `tools`
allow-list becomes deny-by-default with the listed tools allowed; `disallowedTools` become denies. So
`agent(prompt, {agentType: "iac-auditor"})` on OpenCode runs the same prompt and tool policy as the Claude
Code subagent. Unknown agent types fail the session; after adding an agent, run `npm run sync:agents` and
`npm run validate:mirror`. The global `permission` block of `opencode.json` allows file edits (`edit: allow`;
every write is still checked by the plugin's guard-write and validate-write hooks, which block paths outside
the layout, writes into target checkouts and secret-shaped strings), allows `npm run *`, `node
.claude/scripts/*` and read-only git (`git status`, `git diff`, `git log`), asks for every other bash command and
for `webfetch`, and denies `sops --decrypt`/`sops -d`, `rm -rf` and force pushes; the plugin `.agents/hooks/maxwell.plugin.mjs` runs the same guard-write, validate-write,
session-start, user-prompt and session-end hooks as Claude Code.

## 5. How sessions become KPIs
1. Each `opencode run` triggers `session.created` in the plugin, which runs `session-start.mjs` and writes
   `kpis/data/raw/sessions/opencode/<ses_…>.meta.json` (`harness: opencode`, `runId` from `MAXWELL_RUN_ID` or a freshly
   minted one, `workflow: manual`). Every `chat.message` goes through `user-prompt.mjs`, which parses
   `/<workflow> <company_id> [--app=.. --env=.. --dry-run]` from the prompt and sets `workflow`, `companyId`
   and `args` on the same meta file.
2. The runner appends `{at, workflow, label, sessionId, code, events}` per session to
   `kpis/data/raw/sessions/opencode/run-workflow.log` for reconciliation.
3. When the session goes idle the plugin runs `session-end.mjs`, which calls `node
   .claude/scripts/sessions/ingest.mjs --harness opencode --session <ses_…>`; the ingest applies the sampling
   policy in `kpis/metrics.json`, exports the transcript (`<ses_…>.export.json`, gitignored) and writes
   `<ses_…>.summary.json` with OTel GenAI token buckets. OpenCode's own `cost` field is ignored; cost is
   recomputed from tokens with `.claude/skills/kpi-extraction/references/pricing.json`.
4. `npm run kpis -- --company <id>` aggregates summaries by `runId` into `kpis/data/<kpi>/series.jsonl`.
   If `session.idle` never fired (killed process, CI timeout), ingest by hand: `node
   .claude/scripts/sessions/ingest.mjs --harness opencode --session <ses_…> --force`, taking the ids from
   `run-workflow.log`.
To make a workflow's prompts attributable, scripts should start every `agent()` prompt with the workflow and
company: `/<name> <companyId>` on the first line.

## 6. Limitations
- No nested `workflow()`: compose by running workflows sequentially from a shell script or CI job.
- Resume is not implemented; a failed run is re-run from the start, which is safe because every write is
  idempotent (ledger fingerprints, master indexes keyed by id).
- Progress and logs are per process; there is no Workflow tool UI. Use `--concurrency 1` to read them in order.
- The runner extracts the *longest* text part of the JSON events as the answer; scripts that need structure
  should always pass `opts.schema`.
- Token accounting counts output tokens reported in events only; cache and input tokens come from the
  ingest summary later.
- `opencode run` inherits the working directory, so run from the workspace root or the hooks will not find
  `.claude/`.
- `opts.effort` is only a sentence appended to the prompt; the runner does not pass `--variant`.
- OpenCode 1.18 does not auto-discover agents or commands from `.agents/` (skills it does), so a stale
  `opencode.json` `agent` map means "unknown agent" failures: `npm run sync:agents` fixes it.

## 7. Provider authentication (never keys in the workspace)
```
opencode auth login              # interactive: pick provider (anthropic, amazon-bedrock, google-vertex, ...) and paste the key
opencode auth list               # verify
```
Credentials are stored by OpenCode in its own data directory (`~/.local/share/opencode/auth.json` on Linux),
outside the workspace; nothing in `opencode.json`, `.agents/` or `.claude/` may contain a key. On headless
hosts `opencode auth login` is not needed: OpenCode reads `ANTHROPIC_API_KEY` from the process environment,
so keep the key in the host environment or the CI secret store and never in a workspace file, a `--args`
payload or a prompt. For Bedrock use
an AWS profile or role (`AWS_PROFILE`, IRSA) and `--model amazon-bedrock/<model id>`; for CI, inject the
provider key as a secret environment variable (`ANTHROPIC_API_KEY`) at job level and never echo it. For an
MCP server in `opencode.json`, every `environment` value and any header named auth/api-key/token/secret/cookie
must be an `{env:NAME}` reference; the config schema rejects literals there. Run
`npm run validate` after any config change: it checks `opencode.json`, the mirror and every skill.

## 8. Checklist before an unattended run
1. `npm run validate` green and `npm run validate:mirror` OK.
2. `opencode auth list` shows the provider or `ANTHROPIC_API_KEY` is present in the job environment; `--model`
   or `MAXWELL_OPENCODE_MODEL` set if the Opus default is not wanted.
3. `MAXWELL_RUN_ID` exported; `MAXWELL_OPENCODE_AUTO=1` only if the permission rules were reviewed.
4. `args.dryRun: true` first for probes against prod-tier environments, with `envIds` naming each one
   (`.claude/skills/runtime-probe-rules-of-engagement` applies on OpenCode exactly as on Claude Code).
5. After the run: `npm run kpis -- --company <id>` and check `kpis/data/raw/sessions/opencode/` has a
   `.summary.json` per session in `run-workflow.log`.
