---
name: cfn-verification
description: How static probes check, run and verify CloudFormation templates with AWS's own tooling - only through node .claude/scripts/toolchain/cfn-verify.mjs, which runs cfn-lint and cfn-guard (AWS's Guard rule sets) offline, creates each template in a local AWS emulator on loopback and reads back what was created, and, only with the company's AWS read-only access key (optional), calls AWS's validate-template, describe-stacks and drift detection. Never changes a company's AWS resources or code. Load before reviewing any CloudFormation or SAM template.
license: AGPL-3.0-only
compatibility: Node 22 and the Maxwell workspace layout; a hosted run with the platform's pinned run tools (MAXWELL_PLATFORM_TOOLS=1)
metadata:
  author: OnFinance
  version: 1.0.0
  helper: .claude/scripts/toolchain/cfn-verify.mjs
allowed-tools: Read Bash(node .claude/scripts/toolchain/cfn-verify.mjs *)
when_to_use: When a checkout holds a CloudFormation template (AWSTemplateFormatVersion, or Resources with Type AWS::...); when cfn-verify exits 3 or 4
user-invocable: false
x-maxwell:
  kind: runbook
  workflows: [probe-iac, probe-cicd-env]
---
# CloudFormation verification with AWS's own tools

A template is only as good as what AWS makes of it. `cfn-verify.mjs` asks AWS's own tools, in four steps, and writes
one SARIF 2.1.0 export the probe's findings cite.

| Step | Tool | Needs | What it reports |
| --- | --- | --- | --- |
| Lint | `cfn-lint` (pinned in `scanner-toolchain`) | nothing | schema errors, bad intrinsics, invalid IAM actions, best practice (`E*`, `W*`, `I*`) |
| Rules | `cfn-guard` with AWS's Guard rule sets (`references/pins.json`: the registry's union, RBI MD-ITF, CIS level 1) | nothing | each failed rule at the line Guard names, the rule sets and controls it belongs to |
| Run | a local AWS emulator (moto; LocalStack where Docker and a token allow) on `127.0.0.1` | nothing (offline) | the stack failing to create (resource and reason), resources the emulator does not model (**not verified**), and the posture of what was created, read back: public bucket ACLs, public access block off, no default encryption, unencrypted queues and volumes, security groups open to `0.0.0.0/0` or `::/0`, IAM policies allowing `*` on `*` |
| AWS | the AWS CLI against the company's account | the company's **AWS read-only access key** (optional) | `validate-template`; for a stack named in `applications/<app>/env/*.json` (`iac[].stackName`), `describe-stacks` and drift detection |

## 1. Running it

```bash
node .claude/scripts/toolchain/cfn-verify.mjs --company <c> --app <app_id> --repo <repo_id> \
  --out kpis/data/raw/sessions/<session>/<workflow>.<app_id>.<repo_id>.cfn.export.json
```

It prints a JSON summary: `out`, `sha256`, the results per tool, which emulator ran (or why none did), whether live
AWS ran (or why not), how many resources were not verified. Exit 0: it ran; 2: usage; 3: no platform tools (not a
hosted run: review manually and say so in `skipped`); 4: a tool or rule set is not the pinned one (use nothing from it).

## 2. Citing it

- One SARIF run per tool: `cfn-lint`, `cfn-guard`, `maxwell-cfn-emulator`, `aws-cloudformation`. A finding's `tool`,
  `ruleId`, `path` and `startLine` are copied from the result; `properties.resource` names the template resource.
- Evidence: `{type: "sarif", ref: <out>, sha256: <sha256>}` on every finding raised from it.
- Severity: `properties["security-severity"]` when present (the emulator's read-back), else the catalog control, else
  the level (error=high, warning=medium, note=low), as `maxwell-conventions` section 4 says.
- `kind: "review"` (`properties.verification: "not-verified"`): the emulator could not show it. Put it in `skipped`
  with its message. **Never** a satisfied observation, never a pass.
- `kind: "pass"`: evidence for that one resource only.
- An emulator that failed on the resources' Tags is tried once more without them (`createdWithoutTags`); its results
  say so. Tags never change the posture read back.

## 3. What it never does

- It never changes the checkout and never changes a company's AWS resources. `create-stack` and `delete-stack` go only
  to the emulator, whose endpoint must be loopback (a name must resolve to loopback only) and whose credentials are
  the throwaway `test`; against real AWS only `sts get-caller-identity`, `sts assume-role` and the CloudFormation
  reads in `lib/cfn/aws.mjs` `READ_ONLY` run, and anything that starts like a change (`create-`, `update-`,
  `delete-`, `execute-`, `put-`, ...) is refused before the CLI starts.
- No real AWS call without the company's AWS read-only access key; the platform opens `amazonaws.com` to the run only
  when that credential is set.

## 4. The AWS read-only access key (for the company)

Optional. On Maxwell's Credentials page, the two fields **AWS read-only access key id (CloudFormation checks)** and
**AWS read-only secret access key (CloudFormation checks)**: an access key pair of a read-only IAM user in the
company's AWS account (the run receives them as `MAXWELL_AWS_RO_ACCESS_KEY_ID` and `MAXWELL_AWS_RO_SECRET_ACCESS_KEY`).
Give that user:

- AWS's managed **ReadOnlyAccess** policy, and
- the inline policy in `references/iam-read-only-policy.json` (CloudFormation's `ValidateTemplate` and drift detection,
  with an explicit Deny on every stack-changing action).

Without it the probe says "live AWS checks not run" and still lints, checks rules and runs the emulator offline.

**A role instead: local use only.** The hosted platform does not offer a role: its Credentials page has no role ARN or
external id field, and it holds no principal of its own to assume one with, so a company there uses the access key
above. Running Maxwell yourself, you may give a role in the company's account instead, which `cfn-verify.mjs` assumes
before any read (and uses in preference to an access key when both are set):

- `MAXWELL_AWS_RO_ROLE_ARN` and `MAXWELL_AWS_RO_EXTERNAL_ID`: the role, with the same two policies as the user above,
  and the trust policy in `references/iam-trust-policy.json` (your assuming account as the principal, your external id
  as the condition);
- `MAXWELL_AWS_ASSUMER_ACCESS_KEY_ID` and `MAXWELL_AWS_ASSUMER_SECRET_ACCESS_KEY`: the principal of yours that may
  assume it (`sts:AssumeRole` on that role only).
