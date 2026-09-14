---
name: credentials-sops
description: How applications/<app_id>/credentials.json works - a sops/age-encrypted document of credential REFERENCES (env var names, vault paths, item ids) that runtime probes resolve at execution time; never values. Use when onboarding an application, granting probe access to an environment, or rotating recipients.
license: AGPL-3.0-only
metadata:
  helper: .claude/scripts/creds/sops.mjs
x-maxwell:
  kind: runbook
  workflows: [refresh-ctx, runtime-probe-appcontainers, runtime-probe-devtest-env, runtime-probe-qa-env, runtime-probe-prod-env, runtime-probe-datapipeline, runtime-probe-network-perimeter, runtime-probe-identity-access, refresh-apps]
---
# Credentials (sops/age)

## Model
- `credentials.json` validates, after decryption, against `v1/application/credentials.schema.json`: `entries[]`
  of `{key, kind, provider, ref, scope: read-only, envIds[], owner, rotation}`. `ref` is a locator (an environment
  variable name, a Vault path, an AWS Secrets Manager ARN, a 1Password item id), never a value; the schema and
  the write-guard hook reject secret-shaped strings.
- The file at rest is sops-encrypted to the age recipients listed in `sopsRecipients[]`. Decryption needs
  `SOPS_AGE_KEY_FILE`; hooks and permissions deny `sops --decrypt` from agent shells, so agents only ever call
  `node .claude/scripts/creds/sops.mjs get <app_id> <key>` to learn *where* a credential lives, and probe scripts
  resolve the locator themselves at run time.

## Commands
```
node .claude/scripts/creds/sops.mjs encrypt <app_id> <decrypted.json>   # validate + encrypt + write
node .claude/scripts/creds/sops.mjs get <app_id> <key>                   # one entry (reference only)
node .claude/scripts/creds/sops.mjs recipients <app_id>                  # who can decrypt
```
Set `SOPS_AGE_RECIPIENTS=age1...,age1...` (or `sopsRecipients` in the document) before `encrypt`.

## Demo key (fixture only)
`references/example-co.demo.age-key.txt` is the private key for the `example-co` fixture so CI can decrypt and
validate it. It protects nothing real. Never reuse it for a real company; generate keys with `age-keygen -o
<file>` outside the repository and keep only the public recipient in the workspace.

## Onboarding an environment for probes
1. Add the environment file `applications/<app>/env/<env>.json` with `probeAccess.credentialKey`.
2. Add a matching entry (`kind: kubeconfig|cloud-role|ssh-key|...`, `scope: read-only`, `envIds`) to the
   decrypted document and re-encrypt.
3. Probes refuse credentials whose `scope` is not `read-only` and environments whose `probeAccess.readOnly` is
   not `true`.
