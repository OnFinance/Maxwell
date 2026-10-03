import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const caseKey = (companyId, caseId) => ({ pk: `INVESTIGATIONS#${companyId}`, sk: `CASE#${caseId}` });

export class DynamoDbInvestigationStore {
  constructor({ tableName, region, documentClient, retentionSeconds = 31536000 } = {}) {
    if (typeof tableName !== 'string' || !tableName) throw new Error('tableName is required');
    if (!documentClient && (typeof region !== 'string' || !region)) throw new Error('region is required');
    if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 86400) throw new Error('invalid retention');
    this.tableName = tableName;
    this.retentionSeconds = retentionSeconds;
    this.client = documentClient || DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 5 }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async createCase(record, now = Date.now()) {
    const key = caseKey(record.companyId, record.caseId);
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...key, entityType: 'investigation-case', case: record, alertSignature: record.alertSignature, revision: record.revision, expiresAt: Math.floor(now / 1000) + this.retentionSeconds },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return { created: true, case: record };
    } catch (error) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
      if (!existing.Item) throw error;
      if (existing.Item.alertSignature !== record.alertSignature) throw new Error('alertId was reused with different content');
      return { created: false, case: existing.Item.case };
    }
  }

  async getCase(companyId, caseId) {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: caseKey(companyId, caseId), ConsistentRead: true }));
    return result.Item?.case || null;
  }

  async listCases(companyId) {
    const cases = [];
    let ExclusiveStartKey;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `INVESTIGATIONS#${companyId}`, ':prefix': 'CASE#' },
        ConsistentRead: true, ExclusiveStartKey,
      }));
      for (const item of result.Items || []) cases.push(item.case);
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return cases;
  }

  async saveChange(previous, next, action, now = Date.now()) {
    const key = caseKey(next.companyId, next.caseId);
    const activityKey = { pk: `CASE#${next.caseId}`, sk: `ACTIVITY#${String(now).padStart(13, '0')}#${next.revision}` };
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: {
          TableName: this.tableName,
          Item: { ...key, entityType: 'investigation-case', case: next, alertSignature: next.alertSignature, revision: next.revision, expiresAt: Math.floor(now / 1000) + this.retentionSeconds },
          ConditionExpression: 'revision = :previous', ExpressionAttributeValues: { ':previous': previous.revision },
        } },
        { Put: {
          TableName: this.tableName,
          Item: { ...activityKey, entityType: 'investigation-activity', caseId: next.caseId, companyId: next.companyId, action, revision: next.revision, at: next.updatedAt, expiresAt: Math.floor(now / 1000) + this.retentionSeconds },
          ConditionExpression: 'attribute_not_exists(pk)',
        } },
      ] }));
      return next;
    } catch (error) {
      if (error?.name === 'TransactionCanceledException' || error?.name === 'ConditionalCheckFailedException') throw new Error('case revision conflict');
      throw error;
    }
  }
}

