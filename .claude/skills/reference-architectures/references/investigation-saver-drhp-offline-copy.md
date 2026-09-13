# Offline copy: investigation-saver-drhp pipeline and harness context (snapshot 2026-09-12)

One-time extraction from the private OnFinance/investigation-saver-drhp repository (commit 81c6ed9). Maxwell does
not integrate with it; `refresh-metastore`, `runtime-probe-datapipeline`, `runtime-probe-harnesses`,
`runtime-probe-sandboxes`, `probe-cicd-env`, `probe-iac` and `probe-agent-graph` use this as the model of a
realistic regulated-fintech deployment. Names are verbatim.

## 1. Layout of a realistic deployment
- Apps: `apps/api` (Python 3.12, FastAPI, SQLAlchemy async, Alembic, 103 migrations; workers `outbox, dispatcher,
  reaper, reconciler, run_scheduler, improvement_sweeper, task_state_dispatcher, host_recycler, monitoring,
  data_retention, data_sync_scheduler, credential_cleanup`), `apps/web` (Next.js App Router with same-origin proxy
  routes), `apps/agent` (harness image catalogue: Dockerfiles `cc-core`, `cc-docs`, `cc-browser`, `oc-video`, C
  guards `process-guard.c`, `browser-exec-guard.c`), `apps/agents/{create-run-assistant, governor,
  report-generator, sbom-generator}` (TypeScript on the `eve` agent framework), `apps/ingestor` (Go; S3
  object-created events → batched entity creation), `apps/cli` (MCP servers + login).
- IaC: CloudFormation (`infra/aws/*.cloudformation.yaml`: foundation, worker-network, worker-prerequisites,
  harness-promotion, mcp-canary, waf-observability, governed-egress-private-dns, cnpg-pitr-restore-role) +
  Kustomize (`infra/k8s/production`) + Argo CD (`automated: {prune: true, selfHeal: true}`, `ServerSideApply`).
  Only production is in-repo (`namespace: investigation-saver`); dev/qa are docker-compose + CI databases.
  Secrets via External Secrets Operator (`ClusterSecretStore/aws-secrets-manager`, keys
  `investigation-saver/production/control`, `.../connector-keys`); nothing committed.
- Compose: prod-like `db (postgres:17.10-alpine), migrate, api (8001), web (3001)`; dev adds `seed` and the
  agents/workers.
- Tests: pytest with per-test cloned Postgres template, `node --test` source-contract suites that assert
  infra-manifest and runbook content, Playwright e2e, image smoke gates (`hermetic-smoke.sh`,
  `flavour-smoke.sh <variant>`), "Basecamp" canaries (`canaries/basecamp/*/{pipeline.json, expected.json,
  provenance.json}` with `fixtures[].role: "assertion_oracle"`), MCP canary unit tests, agent `eve eval`.
- Docs: ADRs 0001–0008, `docs/harness-state.json` (machine-readable "what a harness is").

## 2. Data pipeline model (for company.metastore + runtime-probe-datapipeline)
- Ingest is tenant-supplied entity files (offer documents, PDFs, audit submissions, RCM control CSVs, website
  fixtures, video/audio) by upload, URL fetch, mail connector or S3 data-connector sync. No crawler.
- Orchestration is custom: PostgreSQL transactional outbox → SQS → dispatcher → ECS `RunTask` on EC2 (one-off
  task per attempt, attempt id as idempotency token). Scheduling lives in-DB (`run_schedules`,
  `run_schedule_occurrences`, `holiday_calendar_days`).
- Stage DAG: route/ingest → entity metadata processing (`processing_status: pending → processing → processed |
  failed`) → workspace build (immutable, versioned, checksummed S3 tarball; manifest strips any value containing
  `://`) → run launch/sharding (`shard_group_id, shard_index, shard_count`; `run_multiplexing = {entities_per_run,
  max_runs}`) → execution (ECS containers `volume-permissions → workspace-init → workspace-scan (ClamAV) →
  claude-harness`) → findings ingest (`output.json` v1, `findings.json`, ≤500 findings / 8 MiB per artifact,
  webhook and artifact paths validated identically) → evaluation/judging → rollup/report/delivery → retention
  (`payload_expires_at`, `retention_hold_id`, `payload_pruned_at`).
- Storage: one PostgreSQL 17 database with three schemas `platform`, `session`, `governance`; every table must be
  classified in `SCHEMA_BY_TABLE` or import fails. No vector store, no warehouse, no Hive/Unity metastore; the
  "catalogs" are the harness catalogue and the checklist catalogue. Object storage: workspace bucket, output
  bucket, tenant connector buckets. Queues: SQS job queue + ECS state queue.
- Tables (platform): `tenants, application_users, tenant_memberships, platform_profile_overrides, sso_providers,
  identity_connectors, vault_keys, custom_inference_providers, mail_servers, alert_channels, data_connectors,
  pipelines, checklist_categories, checklists, checklist_drafts, entities, entity_artifacts,
  pipeline_runtime_binaries, runtime_binary_scans, entity_file_configs, entity_metadata_properties,
  entity_data_sync_settings, entity_workflow_steps, run_schedules, run_schedule_occurrences,
  holiday_calendar_days, findings, finding_evaluations, finding_feedback, finding_deliveries, reports,
  report_deliveries, cra_prompt_revisions`. (session): `investigation_runs, agent_session_attempts,
  agent_session_events, agent_steer_messages, agent_bedrock_credentials, chat_threads, chat_thread_members`.
  (governance): `pipeline_change_events, generated_judging_runs, pipeline_config_proposals,
  pipeline_governance_events, pipeline_feedback, governed_egress_invocations, agent_budget_grants,
  alert_deliveries, agent_slots, agent_host_leases, agent_provisioning_circuit, outbox_events`.
- Key columns: `findings {checklist_id, entity_id, title, category, severity, status, compliance_status, summary,
  mitigation_plan, file_decisions, evidence_refs, risk_assessment, run_id, external_id, content_fingerprint,
  source_path, assignee, generated_by}` (unique on run+external_id and run+fingerprint);
  `investigation_runs {thread_id, status (queued → completed|failed|cancelled), retention_policy_version
  "2026-08-21", payload_expires_at (+60 days), harness_snapshot (immutable resolved harness incl. numeric task
  definition revision), web_tool_policy_snapshot, attempt_count, max_attempts, workspace_* , shard_*}`;
  `entity_artifacts {file_name, media_type, byte_size, sha256, bucket, object_key, version_id, status ∈
  pending|uploaded, data_connector_id, source_url}`; `entity_file_configs {regex_pattern, folder_route,
  file_format, file_purpose, allow_manual_upload, audit_enabled, lineage_settings {source_tracking,
  transformation_tracking, destination_tracking}, provenance_settings {source_tracking, audit_trail,
  integrity_checks}, retention_period_days}`.
- Lineage is explicit per row: `findings.run_id + source_path + external_id/content_fingerprint →
  investigation_runs.harness_snapshot → task-definition revision → image digest → SBOM attestation`; artifacts
  carry `sha256`/`version_id`; `pipeline_change_events` records config deltas. Probes should look for exactly
  this chain and flag any break.

## 3. Agent harness and platform (for runtime-probe-harnesses / sandboxes / probe-agent-graph)
- Two planes: the harness (real `claude` CLI in a one-off ECS task) and platform agents (long-running `eve`
  services in Kubernetes).
- Harness invocation: `claude -p --setting-sources "" --strict-mcp-config --disable-slash-commands --no-chrome
  --tools … --allowedTools … --output-format stream-json --model … --max-turns … <prompt>`.
- Catalogue `AGENT_IMAGE_VARIANTS`: `cc-core`, `cc-docs`, `cc-browser`, `oc-video` (revision-tagged), metadata
  `label, description, capabilities (analysis, python, node, transcription, documents, ocr, pdf, browser, video,
  audio, frames), egress ∈ offline | loopback-only | governed`. Pipeline types `general-analysis, document-ocr,
  website-verification`. Trusted loopback browser egress policy id `trusted-loopback-v2`.
- Sandboxing: ECS on EC2, `networkMode: awsvpc`, `user: "10001"`, `readonlyRootFilesystem: true`, tmpfs volumes
  `workspace, agent-runtime, session-state, agent-home, tmp`, `initProcessEnabled`; ClamAV workspace scan gate;
  single-use EC2 hosts (`DRHP_AGENT_BASH_ISOLATION_MODE=single_use_ec2`, `agent_host_leases`); C process guards
  with `--self-test`; `PR_SET_DUMPABLE 0`; governed egress gateway + Kubernetes NetworkPolicy
  (`investigation-saver-controlled-egress`: DNS-only to kube-system, 80/443/5432/8001 within 10.0.0.0/16);
  admission policy. No gVisor/Firecracker.
- Tool permissions: default allowed tools `Read, Write, Edit, Glob, Grep, Bash, Task, Agent, Workflow`; browser
  image forbids `Agent, Bash, Computer, Cron*, Exec, Execute, Process, Shell, Spawn, Task*, Terminal, Workflow`;
  native `WebSearch` denied on every image; WebFetch/WebSearch only via the governed gateway or exactly one
  approved HTTPS MCP server.
- Budgets and limits: `agent_budget_grants`, budget ceiling USD 500, increase options 10/20/40, max turns 400,
  execution timeout 10800 s, concurrency slots ≤10, ≤5 concurrent runs per pipeline, provisioning circuit
  breaker, error codes `egress_approval_required` (approval pause) and budget-stop codes.
- Audit trail: `agent_session_events, pipeline_governance_events, pipeline_change_events,
  governed_egress_invocations, alert_deliveries, outbox_events` + CloudWatch log streams per container.
- Governor agent: ground-truth labels (`is_gold`, `human_label ∈ pass|flag`), LLM-as-judge (verdict, rationale,
  confidence 0–1), composite gate; tools `get_governance, set_governance, get_eval_summary,
  list_eval_findings, get_finding_for_judging, record_judge_results, record_human_labels, set_gold_flags,
  list_feedback, record_feedback, list_config_proposals, propose_config_change, propose_checklist_update`; brakes
  `improvement_paused` / `measurement_paused` (HTTP 409); it proposes, a human applies.
- Report agent: pinned to one report by the outbox worker via bearer + trusted headers
  (`x-drhp-tenant-id, x-drhp-pipeline-id, x-drhp-report-id`; principal type `service`); spec `{report_type,
  data_source, scope, resolved_sections[{heading, guidance, min_chars, requires_table}], findings_in_scope,
  unprocessed_count, format_instructions}`; inline citations `[finding:<id>]`.
- Platform agents: `defineAgent({ model: bedrock("global.anthropic.claude-sonnet-5"), modelContextWindowTokens:
  200000, limits: { maxInputTokensPerSession: 2000000, maxOutputTokensPerSession: 100000 } })`,
  `defineSandbox({ backend: justbash() })`.

## 4. SBOM and supply chain (for probe-cicd-env, app.image, sbom-ref)
- Images: ECR repos `investigation-new-platform` (tags `api-<sha>, web-<sha>, agent-create-run-<sha>,
  agent-governor-<sha>, agent-report-<sha>, agent-sbom-<sha>`) and `investigation-new-harness-catalog`
  (`cc-core-<sha>, cc-docs-<sha>, cc-browser-<sha>, oc-video-<sha>`); `image_tag` must equal the git SHA;
  Kubernetes references images by digest.
- CI publishes SBOMs per component with `syft <ref> -o spdx-json=<component>-sbom.spdx.json`, then `cosign sign
  --yes` and `cosign attest --yes --type spdxjson --predicate …`; artifacts retained 90 days. Runtime-binary
  scans emit `sbom.spdx.json` + `sbom.cdx.json` and feed `trivy sbom`; results stored with
  `scanner_versions {syft, trivy, vulnerability_db, scanned_at}`.
- The ten root `*-sbom.spdx.json` files in the clone are empty placeholders (`{}`): a probe must treat an SBOM
  that is present-but-empty as MISSING (SEBI CSCRF GV.SC.S5).
- In-repo SBOM document shape: `{format: "investigation-sbom/1.0", variant, task_definition_family,
  generated_at, component_count, scope{summary, excluded}, components[{name, version, ecosystem, license}]}`.

## 5. CI/CD and release controls (for probe-cicd-env, probe-sdlc)
- Workflows: `ci.yml` (jobs `changes, web, agents (matrix), agent-evals (dispatch only), api, e2e, containers,
  policy`), `aws-images.yml` (build/scan/push/sign, region ap-south-1), `promote-harness-catalog.yml`
  (environment-gated, modes `plan|register|canary`, explicit acknowledgement strings for digest-pinned task
  definition registration), `publish-cli.yml`. All actions SHA-pinned.
- Scanners: Trivy (`severity: CRITICAL,HIGH`, `exit-code: 1`, `ignore-unfixed: true`) per image; Syft; Cosign;
  cfn-lint + Checkov (`--framework cloudformation|kubernetes|dockerfile`, documented skips); `.trivyignore`;
  `verify-argocd-only.sh`.
- Release pinning: `release/pin-<sha>` branches merged to `main`; GitOps-only reconcile;
  `verify-production-release-pins.sh` requires `DRHP_RELEASE_*_IMAGE` (`image@sha256:…`) and
  `DRHP_RELEASE_*_TASK_DEFINITION` (`family:revision`), plus required check names; sibling verifiers for
  activation pins, EC2 evidence, task-role deny, database grants.

## 6. Environment conventions (for app.environment and probe-dev-env)
- Env prefix `DRHP_` (~90 names; values never committed). Groups: database (`DRHP_DATABASE_URL` must be
  `postgresql+asyncpg://…`, pool settings), app (`DRHP_ENVIRONMENT`, `DRHP_HOST`, `DRHP_PORT`,
  `DRHP_LOG_LEVEL`, `DRHP_CORS_ORIGINS`, `DRHP_ALLOWED_HOSTS` — JSON arrays, prod rejects wildcards), agent plane
  (`DRHP_AGENT_EXECUTION_ENABLED, _RUNTIME, _MODEL, _MAX_TURNS, _MAX_BUDGET_USD, _BUDGET_CEILING_USD,
  _ALLOWED_TOOLS, _CONCURRENCY_LIMIT, _MAX_CONCURRENT_RUNS_PER_PIPELINE, _MAX_ATTEMPTS, _HEARTBEAT_*, _LEASE_SECONDS,
  _INTERNAL_TOKEN, _CONTROL_URL, _WORKSPACE_ROOT, _WORKSPACE_MAX_BYTES, _SESSION_STATE_DIR, _RUNTIME_DIR,
  _BASH_ISOLATION_MODE, _IMAGE_VARIANT_REVISIONS`), AWS (`DRHP_AWS_REGION, _ECS_*, _SQS_QUEUE_URL,
  _WORKSPACE_BUCKET, _OUTPUT_BUCKET, DRHP_BEDROCK_SECRET_ARN, DRHP_AWS_BEDROCK_CREDENTIAL_BOUNDARY_ARN`), auth
  (`DRHP_AUTH_ENABLED, _ALB_SIGNER_ARN, _ALB_CLIENT_ID, _TENANT_CLAIM, _DEFAULT_TENANT_ID, _ALLOWED_EMAIL_DOMAINS,
  _IDP_LOGOUT_URL, _CLI_ENABLED, _COGNITO_*`), crypto (`DRHP_CONNECTOR_ENCRYPTION_KEYS`: ordered array, first
  encrypts, all decrypt). Non-prefixed: `API_URL`, `AGENT_PROXY_TOKEN`, `AGENT_CREATE_RUN_URL`, `AGENT_EVALS_URL`,
  `POSTGRES_{USER,PASSWORD,DB}`.
- Feature flags: `DRHP_AGENT_EXECUTION_ENABLED, DRHP_AUTH_CLI_ENABLED, DRHP_SEED_DEMO_DATA,
  DRHP_DATABASE_AUTO_CREATE`, per-pipeline `auto_resume_enabled, investigation_enabled,
  entity_auto_process_enabled, improvement_paused, measurement_paused`, build-time `NEXT_PUBLIC_*`.
- Environment differences: prod = `DRHP_ENVIRONMENT: production`, seed off, auto-create off, auth on,
  digest-pinned images, ESO secrets, Argo-only; dev = compose, `DRHP_AGENT_RUNTIME=docker`, seed job, `~/.aws`
  bind-mounted read-only; CI/test = `DRHP_ENVIRONMENT: test`, DBs `investigation_test` / `investigation_e2e`.
- Observability: self-hosted Langfuse (native Claude Code OTel traces; `DRHP_LANGFUSE_{ENABLED, BASE_URL,
  PUBLIC_KEY, SECRET_KEY, ENVIRONMENT, LOG_PROMPTS, LOG_TOOL_DETAILS, LOG_TOOL_CONTENT}`, content flags default
  false); health `/health/live`, `/health/ready`; retention: run payloads 60 days, Playwright reports 7 days,
  SBOM/promotion artifacts 90 days, ESO refresh 1h; nightly detectors with Slack formatting.

## 7. Probe checklist derived from this architecture
1. Data pipeline: outbox/queue idempotency keys present; workspace tarballs checksummed and versioned; artifact
   sha256 recorded; findings fingerprint uniqueness; retention policy versioned and enforced; lineage chain
   intact (finding → run → harness snapshot → image digest → SBOM attestation).
2. Harness: read-only root FS, non-root UID, tmpfs volumes, init process, egress class declared per image,
   WebSearch denied, governed gateway for fetches, budget ceiling and max turns set, single-use hosts or
   equivalent isolation, process guards self-test in CI.
3. Agent graph: every tool listed with allow/deny per image; forbidden tool list enforced for browser variants;
   proposals-not-actions for governor-style agents; human apply step; brakes (`*_paused`) exist.
4. CI/CD: SHA-pinned actions, Trivy blocking on CRITICAL/HIGH, SBOM generated and non-empty, cosign
   sign+attest, IaC linting (cfn-lint/Checkov) with documented skips, release pins verified, GitOps-only deploys.
5. Environment: no wildcard CORS/hosts in prod, secrets via ESO/Secrets Manager only, encryption key rotation
   list, log retention ≥180 days in India for CERT-In, prompt/tool content logging off by default.
