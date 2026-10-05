import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const intrinsic = (tag) => new yaml.Type(tag, { kind: 'scalar', construct: (value) => ({ tag, value }) });
const schema = yaml.Schema.create(yaml.DEFAULT_SAFE_SCHEMA, ['!Ref', '!GetAtt', '!Sub'].map(intrinsic));
const path = fileURLToPath(new URL('../../skills/threat-detection/references/aws-cloudformation.yaml', import.meta.url));
const template = yaml.safeLoad(readFileSync(path, 'utf8'), { schema });
const resources = template.Resources;

test('threat-detection stack retains and protects durable state', () => {
  assert.equal(template.Metadata.AWSToolsMetrics.AWSAgentToolkit, 'aws-cloudformation@3');
  assert.equal(resources.DetectionKey.DeletionPolicy, 'Retain');
  assert.equal(resources.DetectionKey.Properties.EnableKeyRotation, true);
  assert.equal(resources.DetectionTable.DeletionPolicy, 'Retain');
  assert.equal(resources.DetectionTable.UpdateReplacePolicy, 'Retain');
  assert.equal(resources.DetectionTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.deepEqual(resources.DetectionTable.Properties.StreamSpecification, { StreamViewType: 'NEW_IMAGE' });
  assert.deepEqual(resources.DetectionTable.Properties.TimeToLiveSpecification, { AttributeName: 'expiresAt', Enabled: true });
});

test('every queue is CMK encrypted and both processing queues have dead-letter handling', () => {
  const queueIds = ['IngestionDeadLetterQueue', 'IngestionQueue', 'AlertDeadLetterQueue', 'AlertQueue'];
  for (const id of queueIds) {
    assert.equal(resources[id].Type, 'AWS::SQS::Queue');
    assert.deepEqual(resources[id].Properties.KmsMasterKeyId, { tag: '!GetAtt', value: 'DetectionKey.Arn' });
    assert.equal(resources[id].Properties.MessageRetentionPeriod, 1209600);
  }
  for (const id of ['IngestionQueue', 'AlertQueue']) {
    assert.equal(resources[id].Properties.ReceiveMessageWaitTimeSeconds, 20);
    assert.equal(resources[id].Properties.RedrivePolicy.maxReceiveCount, 5);
  }
  const statements = resources.DetectionQueuePolicy.Properties.PolicyDocument.Statement;
  assert.ok(statements.some((item) => item.Sid === 'DenyInsecureTransport' && item.Effect === 'Deny'));
  assert.ok(statements.filter((item) => item.Principal?.Service === 'events.amazonaws.com')
    .every((item) => item.Condition.StringEquals['aws:SourceAccount']));
});

test('EventBridge rules have bounded retries and the stream pipe publishes only inserted alerts', () => {
  for (const id of ['ConsoleLoginRule', 'PrivilegeGrantRule', 'AuditDisableRule']) {
    const target = resources[id].Properties.Targets[0];
    assert.ok(target.DeadLetterConfig.Arn);
    assert.equal(target.RetryPolicy.MaximumEventAgeInSeconds, 3600);
    assert.equal(target.RetryPolicy.MaximumRetryAttempts, 10);
  }
  const pipe = resources.AlertPipe.Properties;
  assert.equal(pipe.DesiredState, 'RUNNING');
  assert.equal(pipe.SourceParameters.DynamoDBStreamParameters.StartingPosition, 'LATEST');
  const pattern = JSON.parse(pipe.SourceParameters.FilterCriteria.Filters[0].Pattern);
  assert.deepEqual(pattern.eventName, ['INSERT']);
  assert.deepEqual(pattern.dynamodb.NewImage.entityType.S, ['alert']);
});

test('investigation worker policy is limited to the alert queue and durable case table', () => {
  const statements = resources.InvestigationConsumerManagedPolicy.Properties.PolicyDocument.Statement;
  assert.deepEqual(statements[0].Resource, { tag: '!GetAtt', value: 'AlertQueue.Arn' });
  assert.ok(statements[0].Action.includes('sqs:DeleteMessage'));
  assert.deepEqual(statements[1].Resource, { tag: '!GetAtt', value: 'DetectionTable.Arn' });
  assert.ok(statements[1].Action.includes('dynamodb:TransactWriteItems'));
  assert.deepEqual(statements[2].Action, 'kms:Decrypt');
  assert.ok(!JSON.stringify(statements).includes('sqs:SendMessage'));
});
