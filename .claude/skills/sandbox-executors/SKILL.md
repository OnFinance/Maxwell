---
name: sandbox-executors
description: Where Maxwell runs pinned scanners and read-only runtime probe commands - company-profile/<company_id>/sdlc/executor.json set by /connect-sandbox (Kubernetes, Docker or Podman, E2B, Daytona, Modal, Vercel Sandbox or this machine), and node .claude/scripts/sandbox/exec.mjs, the only way a runtime probe runs a command. Load before any runtime probe command, and when scan.mjs or exec.mjs report no executor, a blocked environment or missing access.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; kubectl and jq come from the pinned toolchain; docker or podman for the docker executor
metadata:
  author: OnFinance
  version: 1.0.0
  helper: .claude/scripts/sandbox/exec.mjs
allowed-tools: Read Bash(node .claude/scripts/sandbox/exec.mjs *) Bash(node .claude/scripts/sandbox/connect.mjs status *)
when_to_use: Before any kubectl, docker, aws, gcloud, az, crane, cosign, curl, openssl or ssh command in a runtime probe; when exec.mjs or scan.mjs exit 3
user-invocable: false
x-maxwell:
  kind: runbook
  workflows: [runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-harnesses, runtime-probe-sandboxes, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr]
---
# Sandbox executors

`company-profile/<company_id>/sdlc/executor.json` records two choices the user made in `/connect-sandbox`. It holds
no secret: provider credentials live in `~/.config/maxwell/sandbox/<provider>.env`, outside the workspace, and agents
never read that directory.

| Scope | Providers | Notes |
| --- | --- | --- |
| `static`: scanners over checkouts (`toolchain/scan.mjs`) | `kubernetes`, `docker`, `e2b`, `daytona`, `modal`, `vercel`, `host`, `none` | Hosted sandboxes get only the checkout and the pinned tool. Modal `ap-south` and Vercel `bom1` run in Mumbai |
| `runtime`: commands against live environments (`sandbox/exec.mjs`) | `kubernetes`, `docker`, `host`, `none` | Never hosted: these commands carry the target's credentials. `none` makes runtime probes plan-only |

Every executor runs the pinned build from the `scanner-toolchain` skill: image digests in containers, checksum-verified
binaries elsewhere, and the printed version is checked before any output is trusted.

## 1. Running a runtime probe command

```bash
node .claude/scripts/sandbox/exec.mjs --company <c> --app <app_id> --env <env_id> -- \
  kubectl get pods -A -o json --pipe jq '[.items[] | {ns: .metadata.namespace, name: .metadata.name}]' --pipe head -c 1048576
```

- Write the command as plain arguments; there is no shell. Chain filters with `--pipe`, which accepts only `jq`,
  `grep` and `head -c` over the previous output.
- Never pass credentials, kubeconfigs, profiles, tokens or endpoints (`--kubeconfig`, `--profile`, `-H`,
  `--endpoint-url`): `exec.mjs` resolves the environment's `probeAccess.credentialKey` locator itself and hands the
  credential to the executor as a file or variable.
- Put flags after the command words (`aws ec2 describe-instances --region ap-south-1`).
- `exec.mjs` checks, before anything runs: `probeAccess.readOnly`, the access method, change freezes, allowed windows
  on a fresh clock, the per-minute rate limit, and the command allow-list in
  `runtime-probe-rules-of-engagement/references/command-allowlist.json` (with the hard rules: no secret-returning or
  credential-minting verb, no write verb, no logs and no secrets at all on `prod` or `dr`, secrets elsewhere only as
  names or key names).
- `--dry-run` runs every check and prints the plan without executing, for plan-only runs.

The JSON it prints carries `collectedAt`, `exitCode`, `stdout` (redacted, capped at 1 MiB), `stdoutSha256`,
`truncated`, `redactions` and `executor` provenance. Use `collectedAt` and `stdoutSha256` for the evidence reference.

## 2. Exit codes

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | the command ran; its own exit code is in the JSON | record the evidence |
| 2 | refused by the allow-list or the rules, or bad usage | do not rephrase the command to get past the rule; choose an allowed command or record the check as inconclusive |
| 3 | environment blocked, missing access, or no runtime executor | record it as blocked or missing access (rules of engagement section 8), or write a DRY RUN observation (section 4). In an interactive session, mention `/connect-sandbox` when the executor is missing |
| 5 | executor failure | retry once, then record the command as not run |

## 3. What agents never do

- Run `kubectl`, `aws`, `gcloud`, `az`, `docker`, `curl`, `openssl`, `ssh` or a scanner directly.
- Read `~/.config/maxwell/`, `~/.cache/maxwell/` or `executor.json` secrets (there are none to read).
- Edit `executor.json`; only `/connect-sandbox` changes it.
