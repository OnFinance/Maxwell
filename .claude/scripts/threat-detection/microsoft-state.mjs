import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { microsoftScope } from './microsoft-adapter.mjs';

export function connectorKey(config) {
  const { companyId, tenantId } = microsoftScope(config);
  if (!['entra', 'defender'].includes(config.source)) throw new Error('invalid connector source');
  return { pk: `CONNECTOR#${companyId}#${tenantId}`, sk: `MICROSOFT#${config.source}` };
}

// No TTL on checkpoints: an expired cursor must never silently reset the ingestion history.
export class MicrosoftStateStore {
  constructor({ tableName, region, documentClient } = {}) {
    if (!tableName || (!region && !documentClient)) throw new Error('table and region are required');
    this.tableName = tableName;
    this.rawClient = documentClient ? null : new DynamoDBClient({ region, maxAttempts: 5 });
    this.client = documentClient || DynamoDBDocumentClient.from(this.rawClient, { marshallOptions: { removeUndefinedValues: true } });
  }
  destroy() { this.rawClient?.destroy(); }
  async read(config) {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: connectorKey(config), ConsistentRead: true }));
    return result.Item || null;
  }
  async acquire(config, { owner, now, leaseMs, initialFrom }) {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tableName, Key: connectorKey(config),
        ConditionExpression: 'attribute_not_exists(leaseUntil) OR leaseUntil <= :now',
        UpdateExpression: 'SET leaseOwner = :owner, leaseUntil = :until, checkpoint = if_not_exists(checkpoint, :initial), initialFrom = if_not_exists(initialFrom, :initial), #status = :running, lastAttemptAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':owner': owner, ':now': now, ':until': now + leaseMs, ':initial': initialFrom, ':running': 'running' },
        ReturnValues: 'ALL_NEW',
      }));
      return result.Attributes;
    } catch (error) { if (error.name === 'ConditionalCheckFailedException') return null; throw error; }
  }
  async renew(config, { owner, now, leaseMs }) {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName, Key: connectorKey(config),
      ConditionExpression: 'leaseOwner = :owner AND leaseUntil > :now',
      UpdateExpression: 'SET leaseUntil = :until',
      ExpressionAttributeValues: { ':owner': owner, ':now': now, ':until': now + leaseMs },
    }));
  }
  async complete(config, { owner, now, checkpoint, stats }) {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName, Key: connectorKey(config),
      ConditionExpression: 'leaseOwner = :owner AND leaseUntil > :now AND checkpoint <= :checkpoint',
      UpdateExpression: 'SET checkpoint = :checkpoint, #status = :healthy, lastSuccessAt = :now, consecutiveFailures = :zero, lastStats = :stats REMOVE leaseOwner, leaseUntil, failureCode',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':owner': owner, ':now': now, ':checkpoint': checkpoint, ':healthy': 'healthy', ':zero': 0, ':stats': stats },
    }));
  }
  async fail(config, { owner, now, failureCode }) {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName, Key: connectorKey(config),
      ConditionExpression: 'leaseOwner = :owner AND leaseUntil > :now',
      UpdateExpression: 'SET #status = :failed, lastFailureAt = :now, failureCode = :code, consecutiveFailures = if_not_exists(consecutiveFailures, :zero) + :one REMOVE leaseOwner, leaseUntil',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':owner': owner, ':now': now, ':failed': 'failed', ':code': failureCode, ':zero': 0, ':one': 1 },
    }));
  }
}

export function connectorHealth(state, now = Date.now(), staleMs = 900000) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(staleMs) || staleMs < 1) throw new Error('invalid health timing');
  if (!state) return { status: 'never-started', ready: false, checkpoint: null, lagMs: null };
  const checkpointMs = Date.parse(state.checkpoint);
  const validCheckpoint = typeof state.checkpoint === 'string' && Number.isFinite(checkpointMs)
    && new Date(checkpointMs).toISOString() === state.checkpoint && checkpointMs <= now;
  const validSuccess = Number.isSafeInteger(state.lastSuccessAt) && state.lastSuccessAt <= now && state.lastSuccessAt >= 0;
  const lagMs = validCheckpoint ? now - checkpointMs : null;
  const successAgeMs = validSuccess ? now - state.lastSuccessAt : null;
  const status = !validCheckpoint || (state.lastSuccessAt !== undefined && !validSuccess) || !['running', 'healthy', 'failed'].includes(state.status) ? 'invalid'
    : state.status === 'failed' ? 'failed'
      : state.status === 'running' && (!Number.isSafeInteger(state.leaseUntil) || state.leaseUntil <= now) ? 'stalled'
        : lagMs > staleMs || (validSuccess && successAgeMs > staleMs) ? 'stale'
          : !validSuccess ? (state.status === 'running' ? 'starting' : 'invalid')
            : state.status === 'running' ? 'running' : 'healthy';
  const codes = ['interrupted', 'replay-horizon-exceeded', 'poll-failed', 'authentication-failed', 'permission-denied', 'throttled', 'provider-unavailable'];
  const lastStats = state.lastStats && ['received', 'delivered', 'pages'].every((k) => Number.isSafeInteger(state.lastStats[k]) && state.lastStats[k] >= 0)
    ? Object.fromEntries(['received', 'delivered', 'pages'].map((k) => [k, state.lastStats[k]])) : null;
  return { status, ready: ['healthy', 'running'].includes(status), checkpoint: validCheckpoint ? state.checkpoint : null, lagMs, successAgeMs,
    lastSuccessAt: validSuccess ? state.lastSuccessAt : null,
    consecutiveFailures: Number.isSafeInteger(state.consecutiveFailures) && state.consecutiveFailures >= 0 ? state.consecutiveFailures : 0,
    failureCode: state.failureCode ? (codes.includes(state.failureCode) ? state.failureCode : 'poll-failed') : null, lastStats };
}
