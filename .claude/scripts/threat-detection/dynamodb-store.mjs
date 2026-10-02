import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const timestampKey = (time) => String(time).padStart(13, '0');
const eventSortKey = (time, eventId) => `EVENT#${timestampKey(time)}#${eventId}`;

export class DynamoDbDetectionStore {
  constructor({ tableName, region, documentClient, eventTtlSeconds = 1800, alertTtlSeconds = 15552000 } = {}) {
    if (typeof tableName !== 'string' || !tableName) throw new Error('tableName is required');
    if (!documentClient && (typeof region !== 'string' || !region)) throw new Error('region is required');
    for (const ttl of [eventTtlSeconds, alertTtlSeconds]) if (!Number.isSafeInteger(ttl) || ttl < 600) throw new Error('invalid TTL');
    this.tableName = tableName;
    this.eventTtlSeconds = eventTtlSeconds;
    this.alertTtlSeconds = alertTtlSeconds;
    this.client = documentClient || DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 5 }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async saveEvent({ scopeKey, event, time, signature, now }) {
    const pk = `SCOPE#${scopeKey}`;
    const dedupeKey = { pk, sk: `DEDUPE#${event.eventId}` };
    const expiresAt = Math.floor(now / 1000) + this.eventTtlSeconds;
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.tableName, Item: { ...dedupeKey, entityType: 'dedupe', signature, expiresAt }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: this.tableName, Item: { pk, sk: eventSortKey(time, event.eventId), entityType: 'event', time, event, expiresAt }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
      return { created: true };
    } catch (error) {
      if (error?.name !== 'TransactionCanceledException' && error?.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await this.client.send(new GetCommand({ TableName: this.tableName, Key: dedupeKey, ConsistentRead: true }));
      if (!existing.Item) throw error;
      if (existing.Item.signature !== signature) throw new Error('eventId was reused with different content');
      return { created: false };
    }
  }

  async queryEvents({ scopeKey, from, to }) {
    const records = [];
    let ExclusiveStartKey;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': `SCOPE#${scopeKey}`,
          ':from': `EVENT#${timestampKey(from)}#`,
          ':to': `EVENT#${timestampKey(to)}#\uffff`,
        },
        ConsistentRead: true,
        ExclusiveStartKey,
      }));
      for (const item of result.Items || []) records.push({ event: item.event, time: item.time });
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return records;
  }

  async saveAlert({ alert, now }) {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `ALERTS#${alert.companyId}`, sk: `ALERT#${alert.alertId}`, entityType: 'alert',
          alert, expiresAt: Math.floor(now / 1000) + this.alertTtlSeconds,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return true;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}
