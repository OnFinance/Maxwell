---
name: runtime-probe-rules-of-engagement
description: The binding rules for every runtime-probe-* workflow and *-prober agent that touches a live environment of a regulated Indian financial-services company - read-only command families per access method, credential locators via creds/sops.mjs, allowedWindows, rateLimitPerMinute and changeFreeze checks, prod gating on explicit args.envIds, dry-run semantics, evidence capture as evidenceRef with redacted output hashes, abort conditions and the inconclusive-observation-plus-task-request pattern when access is missing. Load before planning or executing any kubectl, docker, cloud CLI, ssh or HTTP command against a target system.
license: AGPL-3.0-only
compatibility: Requires the Maxwell workspace layout, Node 22, and read-only credentials resolved through .claude/scripts/creds/sops.mjs; kubectl, docker, aws/gcloud/az and ssh are only used with the command families listed here
metadata:
  author: OnFinance
  version: "1.0.0"
  sourceChecklist: .claude/skills/reference-architectures/references/investigation-saver-drhp-offline-copy.md#7
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(node .claude/scripts/*)
  - Bash(date -u *)
  - Bash(timeout 60 kubectl get *)
  - Bash(timeout 60 kubectl describe *)
  - Bash(timeout 60 kubectl logs *)
  - Bash(timeout 60 kubectl top *)
  - Bash(timeout 60 kubectl auth can-i *)
  - Bash(timeout 60 docker inspect *)
  - Bash(timeout 60 docker ps *)
  - Bash(timeout 60 docker images *)
  - Bash(kubectl get *)
  - Bash(kubectl describe *)
  - Bash(kubectl logs *)
  - Bash(kubectl top *)
  - Bash(kubectl auth can-i *)
  - Bash(docker inspect *)
  - Bash(docker ps *)
  - Bash(docker images *)
  - Bash(head -c *)
  - Bash(jq *)
  - Bash(sha256sum kpis/data/raw/sessions/*)
when_to_use: Whenever a workflow name starts with runtime-probe- or an agent name ends in -prober, before the first command against a target environment and again before writing any observation from probe output
user-invocable: false
x-maxwell:
  kind: convention
  workflows: [runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access]
---
# Runtime probe rules of engagement

Maxwell probes are **assessments, not changes**. A probe reads state from a live system, hashes what it saw,
and writes observations to the ledger. Nothing else. Breaking any rule below is a reportable incident for the
company being audited (SEBI CSCRF and RBI directions both treat unauthorised change to a production system as a
cyber incident), so the rules are absolute and are enforced in this order: preconditions, command allow-list,
evidence, redaction, abort.

## 1. Preconditions (check all before the first command)
Read `applications/<app_id>/env/<env_id>.json` for every environment in scope and refuse the environment when
any check fails. A refusal is not an error: it is recorded (section 8) and the workflow continues.

| Check | Rule |
|---|---|
| `probeAccess.readOnly` | must be literally `true` (the schema makes it a const, but check anyway) |
| `probeAccess.method` | `none` => no commands at all, evidence is requested from humans; `http-only` => unauthenticated GET/HEAD against `urls[]` only |
| `probeAccess.credentialKey` | required for `kubeconfig`, `ssh`, `docker-socket`, `cloud-api`; resolve with section 3 |
| `tier` vs workflow | `runtime-probe-devtest-env` => `dev|test|devtest`; `runtime-probe-qa-env` => `qa|uat|staging`; `runtime-probe-prod-env` => `prod|dr`; `runtime-probe-sandboxes` => `sandbox`; the cross-cutting probes (appcontainers, harnesses, datapipeline, network-perimeter, identity-access) inherit the tier rule of the environment they touch |
| prod gating | tier `prod` or `dr` is probed only when `args.envIds` names the environment explicitly. No wildcard, no "all environments", no inference from `appIds`. Missing `args.envIds` on a prod-tier environment means skip and record |
| `probeAccess.allowedWindows` | the current UTC weekday must be in one window's `daysOfWeek` and the time between its `startUtc` and `endUtc` (`startUtc == endUtc` is all day; `endUtc < startUtc` wraps past midnight, so `fri 22:00-02:00` also covers early Saturday). Absent means any time outside `changeFreeze[]` |
| `changeFreeze[]` | if now is inside any `[from, to)` the environment is closed to probes of every tier, read-only included; treat exactly like a closed window |
| `probeAccess.rateLimitPerMinute` | hard ceiling on commands per minute for that environment; default to 30 when absent, never exceed 60 on prod |
| credential scope | the credentials entry returned by `sops.mjs get` must have `scope: "read-only"` and list the `envId` in `envIds[]` |

Time has two separate uses; never mix them:
- **Run timestamp (go/no-go and records).** Taken from `args.now` (RFC 3339 UTC) supplied by the caller, never
  from `Date.now()`, so a resumed run makes the same decision. When `args.now` is absent the scout step runs
  `date -u +%Y-%m-%dT%H:%M:%SZ` exactly once. That one value decides whether each environment may be probed at
  all (window and freeze checks above) and is the `collectedAt` of blocked and dry-run observations (section
  8). If no timestamp can be obtained, every environment is blocked (`no run timestamp`).
- **Wall clock (mid-probe abort).** Before the first target command and again before each check group, the
  prober runs a fresh `date -u +%Y-%m-%dT%H:%M:%SZ` and re-evaluates `changeFreeze[]` and `allowedWindows`
  against it. A fresh reading outside the window or inside a freeze triggers the section 7 abort, even when
  the run timestamp said go. Executed-command `collectedAt` values come from these fresh readings (section 5).

Evaluate `changeFreeze[]` before `allowedWindows`, and record every failed check, not just the first, in the
blocker list.

## 2. Allowed and forbidden command families
Only these families may run. Anything not listed is forbidden, including "harmless" variants. Every command is
run as `timeout 60 <command>` and its output is capped with `| head -c 1048576` (after any redaction stage).

Permissions: the skill's `allowed-tools` pre-approve the `kubectl`/`docker` read families (with and without the
`timeout 60` prefix), `head -c`, `jq`, `date -u` and `sha256sum` of export files. Every other family below
(cloud CLIs, `ssh`, `curl`, `openssl`, `psql`, `crane`, `cosign`) is not pre-approved and always prompts;
`.claude/settings.json` asks for `ssh` and `curl` explicitly. An unattended run must have them granted in the
prober agent's own tool list; never widen a pattern to get past a prompt.

| Method | Allowed | Forbidden (never, even with `--dry-run=client`) |
|---|---|---|
| `kubeconfig` | `kubectl get`, `kubectl describe`, `kubectl logs --tail=<n> --since=<d>` (non-prod tiers only: on `prod`/`dr` logs carry customer PII, so evidence log shipping from DaemonSet/sidecar config and log-group retention instead), `kubectl top`, `kubectl auth can-i --list`, `kubectl version`, `kubectl api-resources`, `kubectl cluster-info`. Secrets on non-prod tiers only, names and key names only: `kubectl get secrets -n <ns> -o name` or `kubectl get secrets -n <ns> -o json \| jq '[.items[] \| {name: .metadata.name, type: .type, keys: ((.data // {}) \| keys)}]'` | `apply`, `create`, `patch`, `edit`, `delete`, `replace`, `scale`, `rollout`, `exec`, `attach`, `cp`, `port-forward`, `proxy`, `debug`, `drain`, `cordon`, `label`, `annotate`, `taint`; `kubectl get secret(s)` in any form that prints values (`-o yaml`, `-o json` without the key-only `jq` stage, `-o custom-columns=…:.data`, `-o jsonpath` touching `.data`/`.stringData`); on `prod`/`dr` no `get secret` or `describe secret` at all; `kubectl config view --raw` |
| `docker-socket` | only through a **read-only socket proxy** (for example docker-socket-proxy with `POST=0` exposing only GET on `/containers`, `/images`, `/info`, `/version`, `/networks`, `/volumes`): `docker inspect` (never bare; see section 6 for the `--format` forms), `docker ps -a`, `docker images`, `docker version`, `docker info`, `docker network ls/inspect`, `docker volume ls/inspect` | a raw daemon socket (`unix:///var/run/docker.sock`, an unset `DOCKER_HOST`, `tcp://…:2375/2376` straight to `dockerd`: root-equivalent, see section 7); `run`, `exec`, `start`, `stop`, `kill`, `rm`, `rmi`, `pull`, `push`, `build`, `commit`, `cp`, `login`, `compose up/down`; any request to test whether a write is refused |
| `cloud-api` (aws / gcloud / az / oci) | **only these read verbs** (anything else, including other `get-*`/`show`/`list-*` calls, is forbidden). AWS: `sts get-caller-identity`, `iam get-account-authorization-details`, `iam list-*`, `iam get-role`/`get-policy`/`get-policy-version`/`get-role-policy`, `iam simulate-principal-policy`, `ec2 describe-*`, `eks describe-cluster`/`list-clusters`/`list-nodegroups`/`describe-nodegroup`, `ecs describe-*`/`list-*`, `ecr describe-images`/`describe-repositories`/`describe-image-scan-findings`, `logs describe-log-groups`, `cloudtrail lookup-events`/`describe-trails`/`get-trail-status`, `rds describe-db-instances`/`describe-db-clusters`, `elbv2 describe-*`, `wafv2 list-*`/`get-web-acl`/`get-logging-configuration`, `kms describe-key`/`list-keys`/`get-key-rotation-status`, `secretsmanager describe-secret`/`list-secrets`, `ssm describe-parameters`, `lambda list-functions`/`get-function-configuration`. gcloud: `projects describe`, `container clusters describe`/`list`, `compute * describe`/`list`, `iam service-accounts list`, `projects get-iam-policy`, `logging buckets list`, `kms keys describe`/`list`, `secrets list`/`describe`. az: `account show`, `aks show`/`list`, `network * show`/`list`, `role assignment list`, `monitor log-analytics workspace show`, `keyvault show`/`list`, `keyvault secret list` (names only), `storage account show`/`list` | every write verb (`put-*`, `create-*`, `update-*`, `delete-*`, `attach-*`, `run-*`, `start-*`, `stop-*`, `invoke`, `assume-role` to a non-read-only role) and every read that **returns a secret or mints a credential**: `aws secretsmanager get-secret-value`, `aws ssm get-parameter --with-decryption`, `aws ssm get-parameters --with-decryption`, `aws ecr get-login-password`, `aws ecr get-authorization-token`, `aws sts get-session-token`, `aws sts get-federation-token`, `aws eks get-token`, `aws lambda get-function` (returns a presigned code URL), `aws iam create-access-key`; `az keyvault secret show`/`download`, `az * keys list`, `az * list-keys` (`storage account keys list`, `cosmosdb keys list`), `az aks get-credentials`, `az account get-access-token`; `gcloud * get-credentials` (writes a kubeconfig), `gcloud secrets versions access`, `gcloud auth print-access-token`/`print-identity-token` (any `gcloud auth print-*`) |
| `ssh` | `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes <host> '<cmd>'` where `<cmd>` is one of: `uname -a`, `cat /etc/os-release`, `systemctl list-units --type=service --no-pager`, `ss -tulpn`, `ps -eo pid,user,cmd --no-headers`, `df -h`, `mount`, `iptables -S` / `nft list ruleset` (read), `cat /etc/ssh/sshd_config`, `ls -la <path>`, `stat <path>`, `sha256sum <path>`, `journalctl --no-pager -n <n> -u <unit>` | any shell with `>`, `>>`, `\|` into a writer, `sudo` with a non-read command, `rm`, `mv`, `cp`, `chmod`, `chown`, `systemctl start\|stop\|restart\|enable`, package managers, editors, `crontab -e`, `scp`/`sftp` uploads, interactive sessions, `ps e`/`/proc/*/environ` (prints environment values) |
| `http-only` | `curl -sS -I` (HEAD) and `curl -sS -X GET` against `urls[]` and their well-known paths (`/.well-known/security.txt`, `/health/live`, `/health/ready`, `/robots.txt`), optionally with a single `-H 'Origin: https://maxwell-probe.invalid'` for the CORS check; TLS inspection with `openssl s_client -connect host:443 -servername host [-tls1_1\|-tls1_2\|-tls1_3] </dev/null` | POST/PUT/PATCH/DELETE, form submission, authentication attempts, fuzzing, directory brute force, `nmap`/port scans, hosts not in `urls[]`, anything that resembles a scanner |
| read-only SQL (a `database` credential behind `cloud-api` or `ssh`) | the read-only or replica role with the session forced read-only **on the server**: `PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000' psql …` (or open with `BEGIN TRANSACTION READ ONLY;` and `SET LOCAL statement_timeout = 15000;`). `psql --set`/`-v` only sets a client variable and does **not** make the session read-only. First statement: `SELECT current_user, pg_is_in_recovery(), current_setting('default_transaction_read_only'), current_setting('statement_timeout');` and abort unless read-only is `on`. Then catalog metadata (`\d <table>`, `pg_roles`, `pg_policies`, `information_schema.*`, `pg_stat_ssl`) and aggregate counts (`count(*)`, `count(*) FILTER (WHERE …)`, `max(<timestamp>)`) | `INSERT/UPDATE/DELETE/TRUNCATE`, DDL, `COPY`, `SET ROLE`, `SET default_transaction_read_only = off`, functions with side effects, and **any `SELECT` of payload columns** (message bodies, prompts, transcripts, customer fields) |
| object stores, queues, registries (via `cloud-api`) | bucket/queue/key metadata: `aws s3api get-bucket-*`, `get-public-access-block`, `get-object-lock-configuration`, `aws sqs get-queue-attributes`, `aws kms describe-key` / `get-key-rotation-status`; registry metadata and signatures: `crane digest`, `cosign tree`, `cosign verify`/`verify-attestation` | `aws s3api get-object`, `aws s3 cp/sync`, `aws s3 presign`, `aws sqs receive-message`/`purge-queue`, `kms decrypt`, `cosign sign/attest`, `docker pull` of prod images, `crane auth token` |

Compound rules:
- No command may contain `&&` or `;`. A `|` is allowed only into `jq`, `grep` or `head -c`, and a command whose
  output can carry secret or personal values (pod or task specs, `docker inspect`, logs, config dumps) must
  have its redaction stage (section 6) **inside the pipeline, before `head`**, so nothing unredacted reaches
  stdout, the Bash tool result (which becomes the transcript that ingest copies into
  `kpis/data/raw/sessions/`), a file or a hash.
- `tee`, `>`/`>>` and `sha256sum` never appear in a target-command pipeline: they would act on the raw output
  and the evidence hash must be over the redacted output. Store the redacted output in the export file first
  and hash that (section 5).
- No command may reference a secret value in its arguments, and no command may be run from inside a target
  container or host other than the ssh read list above.

## 3. Credentials
1. Never open `credentials.json` yourself (it is ciphertext) and never run `sops --decrypt` / `sops -d`; the
   decrypt commands and `credentials.dec.json` are denied in `.claude/settings.json` and `opencode.json`.
2. Run `node .claude/scripts/creds/sops.mjs get <app_id> <credentialKey>`; it prints a locator entry
   (`kind`, `provider`, `ref`, `scope`, `envIds`), never a value.
3. Resolve the locator outside the transcript: `ref` is an environment variable name (`$PROD_RO_KUBECONFIG`),
   a Vault path, a Secrets Manager ARN or a 1Password item id. Pass it to the tool by reference
   (`--kubeconfig "$PROD_RO_KUBECONFIG"`, `AWS_PROFILE=<alias>`), never by echoing it.
4. If the locator does not resolve in the current shell, that is *missing access* (section 8), not a reason to
   look for another way in.
5. Never write `KUBECONFIG` contents, tokens, session cookies, `Authorization` headers or `~/.aws` material to
   any file in the workspace; the write guard hook blocks secret-shaped strings and the probe must not try to
   get around it by splitting or encoding.

## 4. Dry run (`--dry-run` / `args.dryRun: true`)
A dry run executes **no command against any target**. It still reads every workspace file, evaluates every
precondition, may run `sops.mjs get` (it prints a locator, not a value; the locator is never used), and
produces the full plan: for each environment the ordered list of commands (verbatim, with locators shown as
`$NAME`), the control ids each command evidences, and the evidence request that a human would have to fulfil
instead. The plan is written as `observation` records with `result: "inconclusive"`, `methods:
["<workflow>"]`, `description` starting with `DRY RUN:` and no `toolOutput`; no export file is written, even
when the caller named an export path (no OCSF events with `status_id: 0`, no empty text export), and candidate
findings, risks and incidents are discarded (a plan proves nothing). Dry runs count toward coverage
KPIs only as inconclusive, so they never inflate a control's assessed status.

`--dry-run` on the OpenCode runner (`run-workflow.mjs --dry-run`) is different: it starts no agent session at
all. Probe dry runs are requested with `args.dryRun: true` (or `/<workflow> <company_id> --dry-run`).

## 5. Evidence capture
Every executed command yields exactly one `evidenceRef` object (`common.schema.json#/$defs/evidenceRef`) in the
`evidence[]` array of the observation it supports; `type` is `command-output` for CLI output, `log-excerpt` for
log lines, `url` for an HTTP probe:
```json
{ "type": "command-output",
  "ref": "timeout 60 kubectl --kubeconfig $PROD_RO_KUBECONFIG get pods -n ledger-core -o json | jq <env redaction, section 6> | head -c 1048576",
  "sha256": "<sha256 of the REDACTED output>",
  "collectedAt": "2026-09-13T17:02:11Z",
  "description": "42 pods, 0 privileged, 3 without resource limits" }
```
- `ref` is the command line as run, after replacing locators with `$NAME` and stripping tokens.
- The redacted output itself goes under `kpis/data/raw/sessions/<sessionId>/` (the only raw-output path the
  layout allows; `toolOutput.path` must match
  `^kpis/data/raw/sessions/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.export\.json$`). **When the calling workflow names
  the export path, that path wins.** Otherwise the default name is `<workflow>.<agent>.<format>.export.json`,
  e.g. `runtime-probe-appcontainers.container-prober.ocsf.export.json`, one file per agent per workflow per
  session (merge into it if it exists). `format` is `ocsf` when the prober emits OCSF events per
  `.claude/skills/ocsf-findings` (the default for every `*-prober`) and `text` for plain command output keyed by
  command. It is referenced from `observation.toolOutput {format, path, sha256}`. Files under that path are
  gitignored, so the hash on the ledger is the durable evidence.
- Hashes are taken over redacted bytes only, after they are stored: the per-command `sha256` is computed over
  the redacted output as stored in the export (for a text export keyed by command, `jq -j --arg r '<ref>'
  '.[$r].output' <export> | sha256sum`), and `toolOutput.sha256` is `sha256sum <export>` of the final file.
  Never pipe a target command into `sha256sum` or `tee` (section 2).
- One CLI invocation or one SQL statement counts as one request against `rateLimitPerMinute`; prefer
  `-o json` and list calls over per-object describes to stay under it.
- `collectedAt` is the time the command returned (a fresh `date -u`, section 1); `observation.collectedAt` is
  the last command's time. Blocked and dry-run observations use the run timestamp instead.
- `expiresAt` defaults to `collectedAt + 30 days` for prod and `+ 90 days` otherwise.

## 6. Redaction (apply before hashing, before writing, before quoting in the transcript)
Redaction happens **inside the command pipeline**, before output reaches stdout: the Bash tool result is the
transcript, and ingest copies transcripts into `kpis/data/raw/sessions/`, so redacting after the command
returns is too late. Never run a bare `kubectl get pods -o json` (literal `env[].value`), `docker inspect`
(`Config.Env`) or ECS `describe-task-definition` (`environment[].value`). Use projection or redaction stages:
```
timeout 60 kubectl --kubeconfig "$QA_RO_KUBECONFIG" get pods -n ledger-core -o json \
  | jq 'walk(if type=="object" and has("env") and (.env|type)=="array" then .env |= map(if has("value") then .value="[REDACTED:env]" else . end) else . end)' \
  | head -c 1048576
timeout 60 docker inspect --format '{{json .Config.Env}}' ledger-api | jq 'map(split("=")[0])'
timeout 60 docker inspect --format '{{json .HostConfig}}' ledger-api | jq '{Privileged, ReadonlyRootfs, CapAdd, PidMode, NetworkMode, Memory, NanoCpus}'
timeout 60 aws ecs describe-task-definition --task-definition ledger-api \
  | jq '.taskDefinition | walk(if type=="object" and has("environment") then .environment |= map({name, value: "[REDACTED:env]"}) else . end)' \
  | head -c 1048576
```
If you cannot write a redaction stage for an output format, do not run the command; request the evidence
(section 8) instead. The classes below apply to everything that survives the pipeline, before it is written
to an export or quoted.

Replace with `[REDACTED:<class>]`: bearer/basic tokens, `Authorization` and cookie headers, cloud access keys
(`AKIA…`, `ASIA…`), private keys, kubeconfig `client-key-data`/`token`, connection strings with passwords,
`Secret.data` and `stringData`, environment variables whose names match `/(PASS|SECRET|TOKEN|KEY|PRIVATE|
CREDENTIAL)/i`, PAN/Aadhaar/account-number/phone/email patterns in logs, card numbers, customer names. Keep
the *keys* of a Secret (they are evidence of what exists) and drop the values. Log lines are truncated to 200
characters after redaction. If a redaction class cannot be applied safely (binary output, unknown format), drop
the output entirely and keep only its byte length (never a hash of unredacted bytes).

## 7. Abort conditions (stop the environment, record, continue with the next)
- Any command exits with a permission error twice: abort, record `inconclusive`, do not retry a third time or
  with a different identity.
- Rate limit reached (`rateLimitPerMinute`) or a target returns 429/503 twice: back off 60 s once, then abort.
- The allowed window closes or a change freeze starts mid-probe, as seen by the fresh `date -u` taken before
  each check group (section 1; the frozen run timestamp cannot detect this): finish the running command,
  abort.
- Output contains a secret the redaction could not classify, or PII volume exceeds 50 matches: abort and raise a
  `risk` record (`rsk_`) titled "Probe exposed to unredactable sensitive data" with `severity: high`, a
  `statement`, `likelihood`, `impact`, `status: "open"` and `regulatoryRefs` (DPDP Rules 2025 security
  safeguards first for personal data, CERT-In 2022 second) — all required by the risk schema.
- The credential turns out to be read-write (`kubectl auth can-i create pods` returns yes; a `docker-socket`
  environment reaches a raw daemon socket instead of a read-only proxy, i.e. the resolved `DOCKER_HOST` is
  `unix:///var/run/docker.sock`, unset, or `tcp://…:2375/2376` straight to `dockerd`, or the credential entry's
  `notes` do not attest a read-only proxy config such as `POST=0` with GET-only `/containers`, `/images`,
  `/info`; the cloud role has non-read actions; `current_setting('default_transaction_read_only')` is `off` or
  `pg_is_in_recovery()` is false with a writable role). Never prove read-only by attempting a write yourself;
  an unattested proxy is requested from the platform team as evidence (section 8). Then:
  abort **immediately**, raise a `finding` (`source: {kind: "runtime-probe", ruleId: "ROE-RW-CREDENTIAL"}`,
  `target` = `{type: "environment", appId, envId}`, `severity: high`, `regulatoryRefs` citing SEBI CSCRF
  least privilege first, `{regulator: "SEBI", instrument: "sebi-cscrf-2024", controlId: "PR.AA.S3"}` (least
  privilege and segregation of duties), then `PR.AA.S1` (identity and credential management), then the RBI
  Cyber and Technology Directions 2026 access-control clause with the exact id the ledger control record uses
  (`PR.AA.S2` is network segmentation, not access management; never invent or guess an id), and do not use the
  credential again.
- Any evidence that the probe caused a side effect (new events in the audit log attributed to the probe
  identity other than reads): abort, raise an `incident` with `category: "unauthorised-access"` (the closed
  enum has no unauthorised-change value; say "probe side effect" in the title), `status: "detected"`,
  `severity: high`, `detectedAt`, `dedupKey: "probe-side-effect:<appId>/<envId>:<runId>"`, and name the
  company's CISO as the escalation in the workflow return value. The CERT-In 6-hour clock may apply: add
  `regulatorReportRefs` from the SLA table, never from memory.

## 8. Missing access: what to write
When a precondition fails, a locator does not resolve, or the method is `none`:
1. Append one `observation` per environment with a `title`, `result: "inconclusive"`, `controlIds` = every
   control the probe would have evidenced as instrument-qualified ledger ids (`sebi-cscrf-2024:GV.SC.S5`,
   `cert-in-directions-2022:Dir-iv`), `subjects: [{type: "environment", appId, envId}]`, `methods:
   ["<workflow>"]`, `collectedAt` = the run timestamp, and a `description` that starts `BLOCKED (<blockers>):`
   and states each blocker verbatim (`probeAccess.method is none`, `PROD_GATING: tier prod is probed only when
   args.envIds names "prod-mumbai"`, `credentialKey prod-mumbai-kubeconfig-ro not resolvable in this shell`,
   `OUTSIDE_ALLOWED_WINDOW: mon-fri 16:30-23:30Z`). No command runs and no credential is resolved in blocked mode.
2. Return an **evidence request** in the workflow result so `impl-change-management` can raise it as a task
   under the company's access initiative:
   ```json
   { "kind": "evidence-request", "appId": "trading-api", "envId": "prod-mumbai", "tier": "prod",
     "blockers": ["OUTSIDE_ALLOWED_WINDOW: mon-fri 16:30-23:30Z"],
     "controlIds": ["sebi-cscrf-2024:PR.IP.S1"],
     "requested": "CNT-03 (read-only root filesystem): redacted `kubectl get pods -n trading -o json` export (env values redacted in the pipeline) with its sha256",
     "owner": "platform-security@kalpataru.example", "dueDays": 14, "observationId": "obs_…",
     "verificationMethod": { "type": "re-probe", "workflow": "runtime-probe-prod-env",
       "description": "Re-run runtime-probe-prod-env for prod-mumbai inside the allowed window and confirm CNT-03 returns a satisfied observation" } }
   ```
   The control id must match the check: CNT-03 is a hardening check, so it cites `PR.IP.S1` (baseline
   configuration with least functionality and hardening), not an access-management control. The task copies
   `verificationMethod` as is: the task schema requires `type` and `description` always, and `workflow`
   exactly when `type` is `re-probe` (matching `^(runtime-)?probe-`), so closure is measurable by re-running
   the probe.
3. Never downgrade a control's `implementationStatus` because of missing access; inconclusive is not
   not-satisfied. A control record created for the first time from an inconclusive observation gets
   `implementationStatus: "unknown"` (satisfied -> implemented, partial -> partial, not-satisfied ->
   not-implemented, not-applicable -> not-applicable).

## 9. Per-probe checklists (derived from reference-architectures section 7)
Each item becomes one observation; cite the ledger control id that the company's catalog maps it to. The
prober agents number these as check ids (`CNT-01`.., `PIP-01`.., `NET-01`..) and put the id in
`evidence[].description`; section 7 of the reference copy lists the architecture each item is derived from.

**appcontainers** (runtime-probe-appcontainers): containers run as non-root UID (`securityContext.runAsUser`,
`runAsNonRoot`); `readOnlyRootFilesystem: true`; no `privileged`, no `hostPID/hostNetwork/hostIPC`, no
`CAP_SYS_ADMIN`; resource requests and limits set; liveness/readiness probes present; image referenced by
digest and the digest matches `applications/<app>/images/<image_id>.json`; SBOM present and non-empty for the
running digest (present-but-empty is missing, SEBI CSCRF GV.SC.S5); secrets arrive via External Secrets Operator / Secrets Store CSI from the declared `secretsBackend`, never
as literal env values or a Secret mounted as env var when a volume/CSI mount is available; `imagePullPolicy` and registry are the company's; log shipping sidecar or
agent present and retention >= 180 days in India (CERT-In 2022).

**harnesses** (runtime-probe-harnesses): every agent harness image declares its egress class (`offline |
loopback-only | governed`); non-root UID and read-only root FS, tmpfs for workspace/home/tmp, init process enabled; native web
search denied and fetches only through the governed gateway; budget ceiling, max turns and execution timeout
set on the task definition; single-use hosts or an equivalent isolation lease visible (`agent_host_leases` or
its analogue); process guards self-test recorded in the last CI run; harness snapshot on each run pins the task
definition revision and image digest; tool allow/deny list per image is enforced (browser variants forbid
shell/spawn tools); prompt and tool-content logging flags default off;
governor-style agents emit proposals, not actions, with a human apply step, and the brake flags (`*_paused`)
exist and are readable.

**sandboxes** (runtime-probe-sandboxes): sandbox tier environments are network-isolated from prod
(NetworkPolicy or security groups deny prod CIDRs); no production data classification (`pii`, `cardholder`,
`financial`) present unless masked; synthetic seed job is the only data source; credentials in the sandbox
cannot reach prod secrets backends; sandboxes expire (TTL label or lease) and expired ones are gone; ClamAV or
equivalent scan gate on uploaded workspaces; egress from sandboxes is governed or denied.

**datapipeline** (runtime-probe-datapipeline): outbox/queue messages carry idempotency keys and consumers
dedupe on them; workspace/artefact objects are versioned and checksummed (`sha256`, `version_id`) and the
bucket has versioning plus object lock or equivalent; findings/records enforce fingerprint uniqueness (unique
index visible in `\d` output or migration); retention policy version is stamped on rows and an enforcement job
ran within its schedule; lineage chain intact from record -> run -> harness snapshot -> image digest -> SBOM
attestation (break = finding); queues and buckets are in the residency countries the environment declares
(RBI localisation expects `IN` for payment data); dead-letter queue exists and is drained.

**network-perimeter** (runtime-probe-network-perimeter): ingress exposes only the `urls[]` declared; TLS >= 1.2
with a valid chain and HSTS on internet exposure; WAF attached with logging on; no wildcard CORS or hosts on
prod; NetworkPolicies default-deny with DNS-only to kube-system; egress restricted to a governed gateway or an
allow-list; security groups have no `0.0.0.0/0` on non-HTTPS ports; admin planes (kube API, SSH, DB ports) are
not internet reachable; `security.txt` and health endpoints reachable but not verbose.

**identity-access** (runtime-probe-identity-access): the probe identity itself is read-only (`kubectl auth
can-i --list`, IAM simulate/inspect); no wildcard `*` in IAM policies attached to workloads; IRSA/workload
identity in use instead of static keys; MFA enforced for humans on the console and SSO for the cluster; no
long-lived access keys older than 90 days; KMS/encryption keys on the rotation list with rotation enabled; break-glass accounts exist, are named and are monitored; service
accounts have `automountServiceAccountToken: false` unless needed; RBAC has no `cluster-admin` bound to
groups other than the platform team; secrets backend audit logging on; privileged access reviews are dated
within the last quarter (RBI IT governance and SEBI CSCRF PR.AA).

## 10. Provenance and closing
Every observation, finding, risk and incident carries `provenance` with `harness`, `sessionId`, `runId`
(`MAXWELL_RUN_ID`), `workflow` and `agent`. A probe ends with `node .claude/scripts/soc/version.mjs <company>
--session <sid> --workflow <name>` so the ledger delta is diffable, and with a one-paragraph return value that
lists environments probed, skipped (with reason), commands executed, and task requests raised.
