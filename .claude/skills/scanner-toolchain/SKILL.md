---
name: scanner-toolchain
description: How static probes run security scanners - only through node .claude/scripts/toolchain/scan.mjs, which runs the version pinned in references/toolchain.json (exact version, per-platform sha256, image digest or hash-locked Python lock) inside the company's configured sandbox, checks the printed version, redacts secrets and stamps SARIF with the pin. Load before running semgrep, trivy, checkov, gitleaks, trufflehog, kube-linter, kubeconform, kubescape, hadolint, actionlint, zizmor, spectral, sqlfluff, squawk, buf, gosec, bandit, syft, grype or cosign over a checkout.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; a scanner executor set by /connect-sandbox (docker, kubernetes, e2b, daytona, modal, vercel or host)
metadata:
  author: OnFinance
  version: 1.0.0
  helper: .claude/scripts/toolchain/scan.mjs
allowed-tools: Read Bash(node .claude/scripts/toolchain/scan.mjs *)
when_to_use: Before any scanner runs over applications/<app_id>/repos/<repo_id>; when scan.mjs exits 2, 3, 4 or 5
user-invocable: false
x-maxwell:
  kind: runbook
  workflows: [probe-iac, probe-app-chart, probe-schemas, probe-cicd-env, probe-agent-graph, execute-scr, probe-sdlc, probe-dev-env]
---
# Pinned scanner toolchain

Findings are only reproducible when the scanner is the same build every time. `references/toolchain.json` pins
every tool Maxwell may run:

- **Exact version** and the text its version command must print.
- **Release artifacts** per platform with a sha256 taken from the project's checksum file and re-computed from the
  download (`upstream-checksums-verified`), or recorded at pin time when the project publishes none
  (`computed-at-pin`).
- **An OCI image pinned by digest** for container sandboxes, and the binary to run inside it.
- **Python tools** (semgrep, checkov, sqlfluff, bandit) as a hash-locked requirements file under `references/locks/`,
  installed with the pinned `uv`.

Never run a scanner binary directly, never install one another way, and never pass a floating tag or registry rule
pack. The pins change only in a reviewed commit that re-verifies every checksum and version.

## 1. Running a scanner

```bash
node .claude/scripts/toolchain/scan.mjs --company <c> --app <app_id> --repo <repo_id> --tool <name> \
  --out kpis/data/raw/sessions/<session>/<workflow>.<app_id>.<repo_id>.<tool>.export.json -- <arguments>
```

In the arguments, `{src}` is the checkout (mounted read-only) and `{result}` is the one file the scanner writes.
Tools that print results instead take `--from-stdout` and no `{result}`. Paths outside `{src}`, `..`, registry rule
packs and flags that upload results are refused.

| Tool | Typical arguments |
| --- | --- |
| trivy | `config --format sarif --output {result} {src}` or `fs --offline-scan --skip-db-update --format sarif --output {result} {src}` |
| checkov | `-d {src} -o sarif --output-file-path {result}` |
| semgrep | `--config {src}/.semgrep.yml --sarif -o {result} {src}` (rules must live in the checkout) |
| gitleaks | `detect --no-git --redact --source {src} -f sarif -r {result}` (`--redact` is required) |
| trufflehog | `filesystem --no-verification --json {src}` with `--from-stdout` (verification is never allowed) |
| kube-linter, kubeconform, hadolint, actionlint, buf, squawk | their SARIF or JSON output flag, with `--from-stdout` |
| zizmor | `--format sarif {src}/.github/workflows` with `--from-stdout` |
| spectral | `lint -f sarif -o {result} {src}/openapi.yaml` |
| gosec | `-fmt sarif -out {result} {src}/...` |
| bandit | `-r {src} -f json -o {result}` (bandit has no SARIF formatter; write the SARIF log from its JSON) |
| cfn-lint, ansible-lint | `-f sarif --output-file {result} {src}/template.yaml` and `-f sarif --sarif-file {result} {src}/playbooks` |
| helm, kustomize (renderers) | `template {src}/<chart> -f {src}/<chart>/values.yaml` and `build {src}/<overlay>`, with `--from-stdout` |
| syft, grype | `dir:{src} -o cyclonedx-json={result}` and `dir:{src} -o sarif --file {result}` |

## 2. What you get

`scan.mjs` prints one JSON summary: `tool`, `version`, the scanner's own `exitCode`, `out`, `sha256`, `format`
(`sarif`, `json` or `text`), `sarifResults`, `redactions` and `provenance` (provider, isolation, network, region,
image digest, artifact or lock sha256, and the version line the tool printed).

- A SARIF result keeps the scanner's runs; each run gets `properties["maxwell:toolchain"]` with the pin.
- Any other output is wrapped as `{"maxwell:toolchain": {...}, "format", "exitCode", "content"}`; write the SARIF
  log yourself from it (sarif-findings skill) and cite the wrapper as evidence.
- Cite the export with its `sha256` in `toolOutput` or `evidence`, exactly as for any SARIF export.
- Many scanners exit non-zero when they find something. A non-zero `exitCode` with a written result is a normal run.

## 3. Errors

| Exit | Meaning | What to do |
| --- | --- | --- |
| 2 | usage or policy refusal | fix the arguments; never work around a refusal |
| 3 | no scanner executor configured | interactive session: ask the user to run `/connect-sandbox`. Headless run: review the checkout manually and list `scanner not run: no executor configured` in `skipped` |
| 4 | pin, checksum, lock or version mismatch | do not use any output from that tool; record the check as `inconclusive` and say which pin failed |
| 5 | executor failure (sandbox, network, timeout) | retry once; then record the tool as not run in `skipped` with the message |
