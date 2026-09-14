# Maxwell — operating instructions for agents

Maxwell is a self-hostable workspace agent for regulated financial-services companies. It runs headlessly on
Claude Code and OpenCode and executes cybersecurity and compliance workflows against a company's applications,
recording everything as schema-validated JSON in this workspace. Read this file fully before writing anything.

## 1. The layout is law
The only directories and files that may exist are those listed in `.claude/schemas/layout.json`. Never create
another folder, scratch file, notes file or README anywhere else. If you need somewhere to put something and no
rule matches, you are about to make a mistake: stop and use the closest sanctioned artefact (a `soc` observation,
a task's `evidence`, a `summary.md` section) instead.

```
Maxwell/
├── .agents/                              # generated OpenCode mirror of .claude/ (never edit by hand)
│   ├── agents/
│   ├── commands/
│   ├── hooks/
│   ├── schemas -> ../.claude/schemas
│   ├── scripts -> ../.claude/scripts
│   ├── skills/
│   └── workflows/
├── .claude/                              # canonical harness assets
│   ├── agents/
│   ├── commands/
│   ├── hooks/
│   ├── schemas/
│   ├── scripts/
│   ├── skills/
│   ├── workflows/
│   └── settings.json
├── .github/
│   └── workflows/
│       └── validate.yml
├── applications/
│   └── <app_id>/
│       ├── env/
│       │   └── <env_id>.json
│       ├── images/
│       │   ├── <image_id>.cdx.json       # CycloneDX SBOM
│       │   └── <image_id>.json
│       ├── repos/
│       │   ├── <repo_id>/                # gitignored checkout
│       │   └── <repo_id>.json
│       ├── README.md
│       └── credentials.json              # sops/age-encrypted references, never values
├── company-profile/
│   └── <company_id>/
│       ├── change_management/
│       │   ├── initiatives/
│       │   │   └── <init_id>/
│       │   │       ├── tasks/
│       │   │       │   └── task_<n>.json
│       │   │       └── timeline.json
│       │   └── master.json
│       ├── sdlc/
│       │   ├── metastore.json
│       │   └── policy.json
│       ├── soc/
│       │   ├── versions/
│       │   │   └── commit_<n>.diff
│       │   └── main.jsonl                # append-only state-of-controls ledger
│       ├── suggestions/
│       │   ├── suggestions/
│       │   │   └── <sug_id>/
│       │   │       └── <repo_id>/
│       │   │           └── <name>.diff
│       │   └── master.json
│       ├── vendors/
│       │   └── <vendor_id>.json
│       ├── details.json
│       └── summary.md
├── cves/
│   ├── data/
│   │   └── <vuln_id>.json
│   └── search/
│       └── <q_id>.json
├── kpis/
│   ├── data/
│   │   ├── <kpi_id>/
│   │   │   └── series.jsonl
│   │   └── raw/
│   │       ├── pagerduty/
│   │       └── sessions/
│   │           ├── claude-code/
│   │           └── opencode/
│   ├── measurement/
│   │   ├── <kpi_id>.md
│   │   └── runs.jsonl
│   └── metrics.json
├── .editorconfig
├── .gitignore
├── AGENTS.md
├── CLAUDE.md
├── LICENSE
├── README.md
├── opencode.json
├── package-lock.json
└── package.json
```

## 2. Every file is validated, every write is checked
- Schemas live in `.claude/schemas/v1/**.schema.json` (draft 2020-12). `layout.json` maps each path to its schema.
- After writing or editing any JSON, JSONL or frontmatter file run `npm run validate:data -- <path>`; before you
  finish a task run `npm run validate`. A non-zero exit means your output is wrong, not the schema.
- Do not invent keys. If the schema lacks a field you need, record the need as an observation with
  `kind: "observation"` and `methods: ["manual"]` in the soc ledger and continue without the field.
- Do not edit schemas during workflows. Schema changes are a separate human-reviewed change (`MAXWELL_SCHEMA_EDIT=1`).
- Shared definitions (`common.schema.json`): `schemaVersion` is always `"1"`; every document has a `kind` const
  and a `provenance` block; ids are slugs for human-named things (`companyId`, `appId`, `vendorId`, `repoId`,
  `imageId`, `envId`, `kpiId`) and prefixed ULIDs for generated things (`init_`, `sug_`, `fnd_`, `obs_`, `rsk_`,
  `inc_`, `q_`, `run_`); tasks are `task_<n>`; timestamps are RFC 3339 UTC with a trailing `Z`.
- Closed vocabularies: regulators, instruments, workflows, entity types and statuses live in
  `.claude/schemas/vocab/`. Severity is `critical|high|medium|low|info`.

## 3. Writing to the state-of-controls ledger (`soc/main.jsonl`)
The ledger is append-only. One JSON object per line, `kind` in `control|observation|finding|risk|incident`.
Never rewrite or delete lines; supersede by appending a new record that references the old id. Use the helper
`node .claude/scripts/soc/append.mjs <company_id> <record.json | records.jsonl>` which validates and appends
atomically (a JSONL batch all-or-nothing), and
`node .claude/scripts/soc/version.mjs <company_id>` at the end of a refresh workflow to write
`versions/commit_<n>.diff`. Findings carry a stable `fingerprint` so re-runs update rather than duplicate.

## 4. Provenance and KPIs
Set `provenance.harness`, `sessionId`, `runId` (from `MAXWELL_RUN_ID`), `workflow` and `agent` on everything you
generate. Session transcripts are ingested into `kpis/data/raw/sessions/` by hooks; the cost of audit, change
management, suggestion acceptance and incident KPIs are computed from those files and from the ledger, so
missing provenance silently corrupts KPIs.

## 5. Secrets
`applications/<app_id>/credentials.json` is sops/age encrypted and contains references (env var names, vault
paths, 1Password items), never values. Never write a secret value into any file in this workspace, never print
decrypted credentials into a transcript, and never commit `*.dec.json`. Hooks block secret-shaped strings.

## 6. Regulator-first
Every finding, risk and initiative must cite at least one `regulatoryRef` from the vocab. Prefer the most
specific Indian instrument that applies to the company's `entityTypes` (SEBI CSCRF, RBI Directions 2026, IRDAI
2023, CERT-In 2022, DPDP Rules 2025) and add global mappings second. Severity and SLA due dates come from
`.claude/skills/regulatory-catalogs/references/sla-table.json`, not from intuition.

## 7. Workflows, agents, skills
- The 26 workflows are `.claude/workflows/<name>.js`; invoke them as `/<name> <company_id> [flags]`. They fan out
  to the specialist subagents in `.claude/agents/` and rely on the skills in `.claude/skills/`.
- Runtime probes (`runtime-probe-*`) are read-only against target systems, obey
  `.claude/skills/runtime-probe-rules-of-engagement`, and honour `--dry-run` by planning and requesting evidence
  instead of executing.
- Reports are written to `summary.md` sections and `soc` observations, never to new files.
- Utility commands: `/validate`, `/kpis`, `/seed-company`, `/status`.

## 8. Finishing a task
1. `npm run validate` is green. 2. Every generated record has provenance. 3. The ledger, master indexes and
timelines agree with each other. 4. You did not create any file outside the layout. Report what changed by path.

## 9. Running headless
- Claude Code: `node .claude/scripts/run-headless.mjs --workflow <name> --company <company_id> [--app <id>] [--env <id>] [--dry-run]`.
  Default model is Opus (`--model opus`). If another model is requested and it hits a usage limit (HTTP 429), the
  runner retries the whole invocation on `--fallback-model` (default `opus`). Every session is ingested for KPIs.
- OpenCode: add `--harness opencode`. Default model `anthropic/claude-opus-5` (override with `--model` or
  `MAXWELL_OPENCODE_MODEL`). OpenCode authenticates from `ANTHROPIC_API_KEY` in the environment, so no interactive
  `opencode auth login` is needed on headless hosts. Keep the key in the host environment or a secret manager,
  never in this workspace.

## 10. Research sources
- Look up regulator material (RBI, SEBI, IRDAI, NHB, MCA, exchanges, depositories) in ComplianceOS first:
  `node .claude/scripts/cos/search.mjs search --query "<text>" [--regulator RBI] [--collection clause_content]`.
  Quote paragraph text only from the official document a hit links to. See skill `complianceos-search`.
- Use public WebSearch/WebFetch only when ComplianceOS has nothing relevant, fails (exit 3, 4 or 5), or does not
  cover the source (CERT-In, MeitY, DPDP, CVE databases, vendor portals), and say so in the evidence.
- If the helper exits 3 (not configured) and a human is chatting with you, ask them in chat for their ComplianceOS
  email and password and pipe them as JSON to `node .claude/scripts/cos/search.mjs set-credentials`; a user without
  an account can request a read-only one from team@onfinance.in. Never ask in headless runs, never write the login
  into this workspace, and never read `~/.config/maxwell/` or `~/.cache/maxwell/`.
