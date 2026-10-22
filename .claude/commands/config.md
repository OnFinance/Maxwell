---
description: Show or change Maxwell's settings - models and model aliases, the price table, where scanners run (executor), the sandbox credentials folder and the ComplianceOS login - through the config tool, never by editing files
argument-hint: '[get|set|unset] [key] [value] [--company <company_id>]'
allowed-tools: AskUserQuestion, Read, Bash(node .claude/scripts/config/config.mjs *)
x-maxwell:
  workflow: config
  touches: [company-profile/*/sdlc/executor.json]
  readsCredentials: false
---
Show or change a Maxwell setting for this request: `$ARGUMENTS`.
Every read and write goes through `node .claude/scripts/config/config.mjs`. Never edit `~/.config/maxwell/`, the file
in `MAXWELL_CONFIG_FILE` or `company-profile/*/sdlc/executor.json` with file tools, and never write a setting into
any other file.

1. Run `node .claude/scripts/config/config.mjs keys` to see every setting, its environment variable and whether it
   carries a secret. Map the request onto one key ("run sonnet agents on claude-opus-5-5" is `models.map.sonnet`,
   "keep sandbox keys in /run/maxwell/sandbox" is `sandbox.credentialsDir`, "where scans run" is `executor`). If no
   key fits, say so and stop.

2. **Show.** `node .claude/scripts/config/config.mjs get [<key>] [--company <company_id>]`. Report each value and
   where it comes from (`env`, `file` or `default`). A value from `env` is set by whoever started Maxwell and wins
   over the file: say that changing the file will not take effect until that variable is removed.

3. **Change a plain setting.** `node .claude/scripts/config/config.mjs set <key> <value> --by <who>`, where `<who>`
   is a short id for the person (not an email address) if you know it. Claude Code and OpenCode ask the person to
   approve each `set` and `unset`. Confirm the key and value with the person first when the request was
   ambiguous.

4. **Secrets.** Settings marked `secret` (`complianceos.emailRef`, `complianceos.passwordRef`,
   `complianceos.tokenRef`) store only the NAME of an environment variable that holds the secret:
   `node .claude/scripts/config/config.mjs set complianceos.passwordRef --ref <ENV_NAME>` (the name starts with
   `MAXWELL_`, `COS_` or `COMPLIANCEOS_`). Never ask for a secret
   value for this command, never put one on a command line, and never repeat one back. If the person wants to type
   their ComplianceOS login into chat instead, use the `complianceos-search` skill's `set-credentials` step, which
   stores it outside the workspace.

5. **Where scans run.** For a company's executor, run `/connect-sandbox <company_id>`, which asks the questions and
   tests the connection. Use `config.mjs set executor --company <company_id> --from-file <path>` only when the
   person hands you a complete executor document outside the workspace; it applies the same data-residency rule.

6. Show the result with `get <key>` and say what it changes, in one or two sentences. Exit code 2 means the tool
   refused the change: report its message as is and do not work around it.
