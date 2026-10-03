#!/usr/bin/env node
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDbInvestigationStore } from './dynamodb-store.mjs';
import { InvestigationService } from './service.mjs';

const writeJson = async (stream, value) => {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain');
};

function decodeAttribute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid DynamoDB attribute');
  if (Object.hasOwn(value, 'S')) return value.S;
  if (Object.hasOwn(value, 'N')) {
    const number = Number(value.N);
    if (!Number.isFinite(number)) throw new Error('invalid DynamoDB number');
    return number;
  }
  if (Object.hasOwn(value, 'BOOL')) return value.BOOL;
  if (Object.hasOwn(value, 'NULL')) return null;
  if (Object.hasOwn(value, 'L')) return value.L.map(decodeAttribute);
  if (Object.hasOwn(value, 'M')) return Object.fromEntries(Object.entries(value.M).map(([key, item]) => [key, decodeAttribute(item)]));
  throw new Error('unsupported DynamoDB attribute');
}

export function parseAlertMessage(body, expectedCompanyId) {
  let event;
  try { event = JSON.parse(body); } catch { throw new Error('message body is not valid JSON'); }
  if (event.eventName !== 'INSERT' || event.dynamodb?.NewImage?.entityType?.S !== 'alert') return null;
  const alertValue = event.dynamodb.NewImage.alert;
  if (!alertValue?.M) throw new Error('inserted alert record has no alert document');
  const alert = decodeAttribute(alertValue);
  if (alert.companyId !== expectedCompanyId) throw new Error('alert company does not match worker company');
  return alert;
}

export async function processMessages({ messages, companyId, service, onCase = (value) => writeJson(process.stdout, value), onError = (value) => writeJson(process.stderr, value) }) {
  const acknowledged = [];
  const stats = { received: messages.length, ignored: 0, created: 0, duplicates: 0, failed: 0 };
  for (const message of messages) {
    try {
      const alert = parseAlertMessage(message.Body, companyId);
      if (!alert) stats.ignored++;
      else {
        const result = await service.intake(alert);
        stats[result.created ? 'created' : 'duplicates']++;
        await onCase({ caseId: result.case.caseId, companyId: result.case.companyId, status: result.case.status, created: result.created });
      }
      acknowledged.push({ Id: message.MessageId, ReceiptHandle: message.ReceiptHandle });
    } catch (error) {
      stats.failed++;
      await onError({ level: 'error', operation: 'investigation-intake', messageId: message.MessageId, receiveCount: message.Attributes?.ApproximateReceiveCount, error: error.message });
    }
  }
  return { acknowledged, stats };
}

export async function pollOnce({ sqs, queueUrl, companyId, service, signal, onCase, onError }) {
  const received = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 120,
    MessageSystemAttributeNames: ['ApproximateReceiveCount', 'AWSTraceHeader'],
  }), { abortSignal: signal });
  const result = await processMessages({ messages: received.Messages || [], companyId, service, onCase, onError });
  if (result.acknowledged.length) {
    const deleted = await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: result.acknowledged }), { abortSignal: signal });
    if (deleted.Failed?.length) {
      result.stats.deleteFailed = deleted.Failed.length;
      for (const failure of deleted.Failed) await (onError || ((value) => writeJson(process.stderr, value)))({
        level: 'error', operation: 'delete-investigation-message', messageId: failure.Id, error: failure.Message || failure.Code,
      });
    }
  }
  return result.stats;
}

async function main() {
  const { values } = parseArgs({ options: {
    company: { type: 'string' }, region: { type: 'string' }, queue: { type: 'string' }, table: { type: 'string' },
    once: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run investigate:aws:intake -- --company <id> --region <region> --queue <alert-queue-url> --table <name> [--once]');
    return;
  }
  for (const field of ['company', 'region', 'queue', 'table']) if (!values[field]) throw new Error(`--${field} is required`);
  const sqs = new SQSClient({ region: values.region, maxAttempts: 5 });
  const store = new DynamoDbInvestigationStore({ tableName: values.table, region: values.region });
  const service = new InvestigationService({ store });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const totals = { polls: 0, received: 0, ignored: 0, created: 0, duplicates: 0, failed: 0, deleteFailed: 0 };
  try {
    do {
      const stats = await pollOnce({ sqs, queueUrl: values.queue, companyId: values.company, service, signal: controller.signal });
      totals.polls++;
      for (const field of ['received', 'ignored', 'created', 'duplicates', 'failed', 'deleteFailed']) totals[field] += stats[field] || 0;
    } while (!values.once && !controller.signal.aborted);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { sqs.destroy(); }
  await writeJson(process.stderr, { mode: 'investigation-intake', ...totals });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(`investigation-intake: ${error.message}`); process.exitCode = 2; });
}

