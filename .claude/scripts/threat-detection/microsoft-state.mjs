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
  if (!state) return { status: 'never-started', checkpoint: null, lagMs: null };
  const lagMs = Math.max(0, now - Date.parse(state.checkpoint));
  const status = state.status === 'running' ? (state.leaseUntil > now ? 'running' : 'stalled')
    : state.status === 'failed' ? 'failed'
      : !state.lastSuccessAt || now - state.lastSuccessAt > staleMs || lagMs > staleMs ? 'stale' : 'healthy';
  return { status, checkpoint: state.checkpoint, lagMs, lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt ?? null, consecutiveFailures: state.consecutiveFailures || 0,
    failureCode: state.failureCode || null, lastStats: state.lastStats || null };
}
