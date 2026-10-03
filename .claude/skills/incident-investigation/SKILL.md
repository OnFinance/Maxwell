---
name: incident-investigation
description: Operate Maxwell's durable AWS alert investigation queue, triage cases, attach hashed evidence, and explicitly confirm reviewed candidates as OCSF 2005 and SOC ledger incidents.
license: AGPL-3.0-only
compatibility: Requires Node.js 22, the AWS threat-detection stack, AWS credentials for queue and case operations, and a Maxwell company profile for confirmation.
metadata:
  author: OnFinance
  version: 1.0.0
allowed-tools: Read Grep Bash(npm run investigate *) Bash(npm run investigate:aws:intake *)
x-maxwell:
  kind: runbook
---
# Incident investigation

Maxwell consumes candidate alerts through the AWS threat-detection stack's encrypted alert queue. The investigation
worker persists each case and audit action in the stack's DynamoDB table before deleting the SQS message. Candidate
alerts never become incidents automatically.

## Run intake

Attach the CloudFormation output `InvestigationConsumerManagedPolicyArn` to the investigation worker identity, then
run the consumer under a process supervisor:

```bash
npm run investigate:aws:intake -- \
  --company example-co --region ap-south-1 \
  --queue <AlertQueueUrl> --table <DetectionTableName>
```

Use `--once` for one long poll. Successful, duplicate and irrelevant records are acknowledged. Invalid records are
left for retry and move to the alert dead-letter queue after the configured receive limit. Do not log message bodies
when reviewing failures.

## Triage

List and inspect cases first. Every mutation includes the revision returned by the preceding command; a stale
revision fails instead of overwriting another analyst's work.

```bash
npm run investigate -- --company example-co --region ap-south-1 --table <DetectionTableName> --action list
npm run investigate -- --company example-co --region ap-south-1 --table <DetectionTableName> --action show --case <case-id>
npm run investigate -- --company example-co --region ap-south-1 --table <DetectionTableName> --action assign \
  --case <case-id> --actor lead@example.com --revision 1 --owner analyst@example.com
npm run investigate -- --company example-co --region ap-south-1 --table <DetectionTableName> --action add-evidence \
  --case <case-id> --actor analyst@example.com --revision 2 --ref cloudtrail:event/<event-id> \
  --sha256 <64-lowercase-hex> --description "Redacted supporting evidence"
```

Evidence stores a stable reference, SHA-256, and a short redacted description. Do not place raw logs, credentials,
tokens, customer addresses, or personal data in case notes or evidence descriptions.

Dismiss false positives with `--action dismiss --reason "..."`. Confirmation requires an assigned owner and at
least one evidence item:

```bash
npm run investigate -- --company example-co --region ap-south-1 --table <DetectionTableName> --action confirm \
  --case <case-id> --actor analyst@example.com --revision 3 --category unauthorised-access \
  --classifications pii,financial
```

Confirmation derives applicable CERT-In, SEBI, RBI, and DPDP reporting clocks from company `details.json` and the
regulatory SLA table. It creates an OCSF 1.9 Incident Finding (class 2005), appends the validated incident through
the SOC ledger helper, and then marks the case confirmed. A deterministic incident ID and the pending state make a
retry safe if the process stops between these steps.

## Quality checks

Run focused tests during changes and the full gate before release:

```bash
node --test ".claude/scripts/tests/incident-investigation*.test.mjs"
npm test
npm run validate
```

The end-to-end test covers alert queue decoding, durable intake, analyst assignment, hashed evidence, explicit
confirmation, OCSF conversion, schema-validated ledger append, regulatory clocks, duplicate replay, and recovery
from a failed ledger publication.
