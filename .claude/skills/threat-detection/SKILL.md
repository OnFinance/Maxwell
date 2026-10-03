---
name: threat-detection
description: Deploy and operate Maxwell's AWS real-time threat detection path from CloudTrail through EventBridge and SQS to durable DynamoDB correlation and the alert handoff queue. Use when deploying, running, troubleshooting, or extending live detection.
license: AGPL-3.0-only
compatibility: Requires Node.js 22, AWS credentials, CloudTrail management events, and permission to deploy the included CloudFormation template.
metadata:
  author: OnFinance
  version: 1.0.0
allowed-tools: Read Grep Bash(npm run detect:cloudtrail:sqs *)
x-maxwell:
  kind: runbook
---
# AWS real-time threat detection

The deployment in `references/aws-cloudformation.yaml` creates the live event and state path:

`CloudTrail -> EventBridge rules -> encrypted ingestion SQS -> Maxwell worker -> encrypted DynamoDB -> DynamoDB Stream/Pipe -> encrypted alert SQS`

The input queue and alert queue each have a dead-letter queue. DynamoDB stores short-lived normalized events and
deduplication markers plus longer-lived candidate alerts. The pipe publishes only newly inserted alert records, so
an investigation or case-management consumer can process candidates independently from detection.

## Deploy

Validate the template locally and with the account's CloudFormation pre-deployment checks, then deploy it with an
environment and company identifier. Do not put credentials or company secrets in parameters. CloudTrail management
events must already be enabled for the account or organization.

After deployment, attach the output `ConsumerManagedPolicyArn` to the role used by the Maxwell worker. The policy is
deliberately unattached so the stack does not decide which compute service runs Maxwell.

## Run the worker

Use the stack outputs as arguments. AWS SDK v3 uses the normal credential provider chain; do not pass credentials on
the command line.

```bash
npm run detect:cloudtrail:sqs -- \
  --company example-co \
  --region ap-south-1 \
  --queue <IngestionQueueUrl> \
  --table <DetectionTableName>
```

Add `--once` for a single long poll. Add `--scope <opaque-scope-id>` only when all received events must share an
explicit scope; otherwise the adapter derives one from AWS account and Region.

Run one or more worker processes under a supervisor. SQS delivery is at least once. A message is deleted only after
normalization, correlation, and alert persistence succeed. Poison messages remain visible for retry and move to the
ingestion dead-letter queue after five receives. Duplicate event and alert writes are idempotent.

## Consume alert candidates

Read `AlertQueueUrl` with a separate investigation service. Each message is a DynamoDB stream record whose
`dynamodb.NewImage.alert.M` field is the persisted `maxwell.detection.alert`. Treat it as a candidate: enrich it,
collect supporting evidence, and require the existing incident workflow to confirm it before writing an incident to
the state-of-controls ledger. Delete the queue message only after that downstream system persists its own handoff.

## Operate

- Alarm on visible messages, oldest message age, and dead-letter queue depth for both queue pairs.
- Alarm on worker exits and throttled DynamoDB or KMS calls.
- Review ingestion dead-letter messages without logging their bodies; replay after fixing the parser or dependency.
- Keep the KMS key and DynamoDB table retained during stack replacement or deletion.
- Change recipe versions when detection semantics change. Alert identifiers include recipe version and time bucket.
