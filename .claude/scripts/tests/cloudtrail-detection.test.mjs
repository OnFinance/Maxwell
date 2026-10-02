import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { normalizeCloudTrail, unwrapCloudTrail } from '../threat-detection/cloudtrail-adapter.mjs';
import { DetectionEngine } from '../threat-detection/engine.mjs';

const time = '2026-10-03T10:00:00Z';
const cloudTrail = (n, overrides = {}) => ({
  version: '0', id: `envelope-${n}`, account: '123456789012', region: 'ap-south-1', time,
  detail: {
    eventID: `event-${n}`, eventTime: time, awsRegion: 'ap-south-1', recipientAccountId: '123456789012',
    eventSource: 'signin.amazonaws.com', eventName: 'ConsoleLogin', sourceIPAddress: '203.0.113.8',
    userIdentity: { type: 'IAMUser', accountId: '123456789012', arn: `arn:aws:iam::123456789012:user/user-${n}` },
    responseElements: { ConsoleLogin: 'Failure' }, ...overrides,
  },
});
const options = { companyId: 'example-co', scopeId: 'aws-prod' };

test('normalizes console logins while pseudonymizing principals and source addresses', () => {
  const raw = cloudTrail(1);
  const normalized = normalizeCloudTrail(raw, options);
  assert.equal(normalized.type, 'authentication');
  assert.equal(normalized.outcome, 'failure');
  assert.match(normalized.actorKey, /^aws-actor-[0-9a-f]{32}$/);
  assert.match(normalized.sourceKey, /^aws-source-[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(normalized).includes('203.0.113.8'));
  assert.ok(!JSON.stringify(normalized).includes('arn:aws:iam'));
  assert.equal(normalized.eventTime, '2026-10-03T10:00:00.000Z');
});

test('five failed logins followed by success flow through the existing detector', () => {
  const engine = new DetectionEngine({ companyId: 'example-co' });
  const actor = { type: 'IAMUser', accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/alice' };
  const alerts = [];
  for (let n = 1; n <= 6; n++) {
    const eventTime = new Date(Date.parse(time) + n * 1000).toISOString();
    const responseElements = { ConsoleLogin: n === 6 ? 'Success' : 'Failure' };
    const normalized = normalizeCloudTrail(cloudTrail(n, { eventTime, userIdentity: actor, responseElements }), options);
    alerts.push(...engine.push(normalized, Date.parse(time) + 30000));
  }
  assert.deepEqual(alerts.map((alert) => alert.recipeId), ['authentication-failure-burst', 'failure-then-success']);
});

test('maps only confirmed AdministratorAccess attachments as privilege grants', () => {
  const admin = cloudTrail(1, { eventSource: 'iam.amazonaws.com', eventName: 'AttachRolePolicy', responseElements: null, requestParameters: { roleName: 'security-admin', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' } });
  const readonly = cloudTrail(2, { eventSource: 'iam.amazonaws.com', eventName: 'AttachRolePolicy', responseElements: null, requestParameters: { roleName: 'auditor', policyArn: 'arn:aws:iam::aws:policy/ReadOnlyAccess' } });
  assert.deepEqual({ ...normalizeCloudTrail(admin, options), eventTime: undefined, eventId: undefined, actorKey: undefined, targetKey: undefined }, {
    schemaVersion: '1', eventId: undefined, companyId: 'example-co', scopeId: 'aws-prod', source: 'aws-cloudtrail', eventTime: undefined,
    actorKey: undefined, type: 'privilege-grant', outcome: 'success', targetKey: undefined, privileged: true,
  });
  assert.equal(normalizeCloudTrail(readonly, options), null);
});

test('maps successful CloudTrail shutdown operations and preserves failed attempts as non-alerting events', () => {
  const stopped = cloudTrail(1, { eventSource: 'cloudtrail.amazonaws.com', eventName: 'StopLogging', responseElements: null, requestParameters: { name: 'organization-trail' } });
  const denied = cloudTrail(2, { eventSource: 'cloudtrail.amazonaws.com', eventName: 'DeleteTrail', responseElements: null, requestParameters: { name: 'organization-trail' }, errorCode: 'AccessDenied' });
  assert.equal(normalizeCloudTrail(stopped, options).outcome, 'success');
  assert.equal(normalizeCloudTrail(denied, options).outcome, 'failure');
});

test('unwraps SNS notifications and ignores unrelated CloudTrail activity', () => {
  const wrapped = { Type: 'Notification', Message: JSON.stringify(cloudTrail(1)) };
  assert.equal(unwrapCloudTrail(wrapped).event.eventName, 'ConsoleLogin');
  assert.equal(normalizeCloudTrail(cloudTrail(2, { eventSource: 's3.amazonaws.com', eventName: 'GetObject' }), options), null);
  assert.throws(() => unwrapCloudTrail('{bad'), /not valid JSON/);
});

test('the CloudTrail CLI normalizes a JSONL stream without AWS credentials', () => {
  const input = JSON.stringify(cloudTrail(1)) + '\n';
  const result = spawnSync(process.execPath, [
    '.claude/scripts/threat-detection/cloudtrail-run.mjs', '--company', 'example-co', '--scope', 'aws-prod', '--mode', 'normalize',
  ], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).source, 'aws-cloudtrail');
  assert.match(result.stderr, /"received":1,"ignored":0,"normalized":1/);
});
