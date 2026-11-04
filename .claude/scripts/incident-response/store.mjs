import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { sha256 } from '../incident-investigation/core.mjs';

const key = (companyId, responseId) => ({ pk: `RESPONSES#${companyId}`, sk: responseId });

// Share a configured document client with the investigation store. No TTL: response
// evidence must survive worker restarts and must not vanish while an action is unknown.
export class DynamoDbResponseStore {
  constructor({ tableName, documentClient } = {}) {
    if (!tableName || !documentClient) throw new Error('response table and document client required');
    Object.assign(this, { tableName, client: documentClient });
  }
  async get(companyId, responseId) {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: key(companyId, responseId), ConsistentRead: true }));
    return result.Item?.record || null;
  }
  async listPage(companyId, after) {
    if (after !== undefined && !/^rsp_[0-9a-f-]{36}$/.test(after)) throw new Error('invalid response cursor');
    const pk = `RESPONSES#${companyId}`;
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': 'rsp_' }, Limit: 50, ConsistentRead: true,
      ...(after ? { ExclusiveStartKey: { pk, sk: after } } : {}),
    }));
    return { items: (result.Items || []).map((item) => item.record), next: result.LastEvaluatedKey?.sk || null };
  }
  create(record, currentCase) { return this.write(null, record, currentCase); }
  change(previous, next, currentCase) { return this.write(previous, next, currentCase); }
  async write(previous, next, currentCase) {
    const companyId = next.proposal.companyId;
    const operations = [{ Put: {
      TableName: this.tableName, Item: { ...key(companyId, next.responseId), record: next, revision: next.revision, state: next.state },
      ConditionExpression: previous ? 'revision = :revision AND #state = :state' : 'attribute_not_exists(pk)',
      ...(previous ? { ExpressionAttributeNames: { '#state': 'state' }, ExpressionAttributeValues: { ':revision': previous.revision, ':state': previous.state } } : {}),
    } }, { Put: {
      TableName: this.tableName,
      Item: { pk: `RESPONSE-AUDIT#${companyId}#${next.responseId}`, sk: String(next.revision).padStart(10, '0'),
        digest: next.digest, ...next.timeline.at(-1), providerActionId: next.providerActionId || null },
      ConditionExpression: 'attribute_not_exists(pk)',
    } }];
    if (currentCase) operations.push({ ConditionCheck: {
      TableName: this.tableName, Key: { pk: `INVESTIGATIONS#${companyId}`, sk: `CASE#${currentCase.caseId}` },
      ConditionExpression: 'revision = :revision', ExpressionAttributeValues: { ':revision': currentCase.revision },
    } });
    await this.client.send(new TransactWriteCommand({ TransactItems: operations, ClientRequestToken: sha256(next).slice(0, 36) }));
  }
}
