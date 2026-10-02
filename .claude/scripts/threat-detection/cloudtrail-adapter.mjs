import { createHash } from 'node:crypto';

const ADMIN_POLICY = 'arn:aws:iam::aws:policy/AdministratorAccess';
const PRIVILEGE_ATTACH = new Set(['AttachUserPolicy', 'AttachRolePolicy', 'AttachGroupPolicy']);
const AUDIT_DISABLE = new Set(['StopLogging', 'DeleteTrail', 'StopEventDataStoreIngestion', 'DeleteEventDataStore']);
const hashKey = (kind, value) => `${kind}-${createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`;

function parseJson(value, label) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error(`${label} is not valid JSON`); }
}

// Accept direct CloudTrail events, EventBridge envelopes, and SNS notifications delivered to SQS.
export function unwrapCloudTrail(input) {
  let value = parseJson(input, 'input');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('input must be a JSON object');
  if (value.Type === 'Notification' && typeof value.Message === 'string') value = parseJson(value.Message, 'SNS Message');
  if (value.detail && typeof value.detail === 'object' && !Array.isArray(value.detail)) {
    return { event: value.detail, envelope: value };
  }
  return { event: value, envelope: null };
}

function identityOf(event) {
  const identity = event.userIdentity || {};
  return identity.arn
    || identity.sessionContext?.sessionIssuer?.arn
    || identity.principalId
    || [identity.type, identity.accountId].filter(Boolean).join(':')
    || 'unknown';
}

function targetOf(event) {
  const request = event.requestParameters || {};
  return request.userName || request.roleName || request.groupName || request.name
    || request.trailName || request.eventDataStore || event.resources?.[0]?.ARN || event.eventSource;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`CloudTrail event requires ${label}`);
  return value;
}

export function normalizeCloudTrail(input, { companyId, scopeId } = {}) {
  requiredString(companyId, 'configured companyId');
  const { event, envelope } = unwrapCloudTrail(input);
  const eventName = event.eventName;
  const isLogin = event.eventSource === 'signin.amazonaws.com' && eventName === 'ConsoleLogin';
  const isPrivilege = PRIVILEGE_ATTACH.has(eventName) && event.requestParameters?.policyArn === ADMIN_POLICY;
  const isAuditDisable = event.eventSource === 'cloudtrail.amazonaws.com' && AUDIT_DISABLE.has(eventName);
  if (!isLogin && !isPrivilege && !isAuditDisable) return null;

  const providerId = requiredString(event.eventID || envelope?.id, 'eventID');
  const eventTime = new Date(requiredString(event.eventTime || envelope?.time, 'eventTime')).toISOString();
  const account = event.userIdentity?.accountId || event.recipientAccountId || envelope?.account || 'unknown-account';
  const region = event.awsRegion || envelope?.region || 'global';
  const resolvedScope = scopeId || `aws-${account}-${region}`;
  const common = {
    schemaVersion: '1',
    eventId: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(providerId) ? providerId : hashKey('aws-event', providerId),
    companyId,
    scopeId: resolvedScope,
    source: 'aws-cloudtrail',
    eventTime,
    actorKey: hashKey('aws-actor', identityOf(event)),
  };

  if (isLogin) {
    return {
      ...common,
      type: 'authentication',
      outcome: event.responseElements?.ConsoleLogin === 'Success' && !event.errorCode ? 'success' : 'failure',
      sourceKey: hashKey('aws-source', event.sourceIPAddress || 'unknown'),
    };
  }
  return {
    ...common,
    type: isPrivilege ? 'privilege-grant' : 'audit-disable',
    outcome: event.errorCode ? 'failure' : 'success',
    targetKey: hashKey('aws-target', targetOf(event)),
    ...(isPrivilege ? { privileged: true } : {}),
  };
}
