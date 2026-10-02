#!/usr/bin/env node
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { DeleteMessageBatchCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { normalizeCloudTrail } from './cloudtrail-adapter.mjs';
import { DurableDetectionEngine } from './durable-engine.mjs';
import { DynamoDbDetectionStore } from './dynamodb-store.mjs';

const writeJson = async (stream, value) => {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain');
};

export async function processMessages({ messages, companyId, scopeId, detector, onAlert = (alert) => writeJson(process.stdout, alert), onError = (value) => writeJson(process.stderr, value) }) {
  const acknowledged = [];
  const stats = { received: messages.length, ignored: 0, processed: 0, alerts: 0, failed: 0 };
  for (const message of messages) {
    try {
      const event = normalizeCloudTrail(message.Body, { companyId, scopeId });
      if (!event) stats.ignored++;
      else {
        const alerts = await detector.push(event);
        for (const alert of alerts) await onAlert(alert);
        stats.processed++;
        stats.alerts += alerts.length;
      }
      acknowledged.push({ Id: message.MessageId, ReceiptHandle: message.ReceiptHandle });
    } catch (error) {
      stats.failed++;
      await onError({ level: 'error', operation: 'process-message', messageId: message.MessageId, receiveCount: message.Attributes?.ApproximateReceiveCount, error: error.message });
    }
  }
  return { acknowledged, stats };
}

export async function pollOnce({ sqs, queueUrl, companyId, scopeId, detector, signal, onAlert, onError }) {
  const received = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 120,
    MessageSystemAttributeNames: ['ApproximateReceiveCount', 'AWSTraceHeader'],
  }), { abortSignal: signal });
  const messages = received.Messages || [];
  const result = await processMessages({ messages, companyId, scopeId, detector, onAlert, onError });
  if (result.acknowledged.length) {
    const deleted = await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: queueUrl, Entries: result.acknowledged }), { abortSignal: signal });
    if (deleted.Failed?.length) {
      result.stats.deleteFailed = deleted.Failed.length;
      for (const failure of deleted.Failed) await (onError || ((value) => writeJson(process.stderr, value)))({
        level: 'error', operation: 'delete-message', messageId: failure.Id, error: failure.Message || failure.Code,
      });
    }
  }
  return result.stats;
}

async function main() {
  const { values } = parseArgs({ options: {
    company: { type: 'string' }, scope: { type: 'string' }, region: { type: 'string' },
    queue: { type: 'string' }, table: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run detect:cloudtrail:sqs -- --company <id> --region <region> --queue <url> --table <name> [--scope <id>] [--once]');
    return;
  }
  for (const field of ['company', 'region', 'queue', 'table']) if (!values[field]) throw new Error(`--${field} is required`);
  const sqs = new SQSClient({ region: values.region, maxAttempts: 5 });
  const store = new DynamoDbDetectionStore({ tableName: values.table, region: values.region });
  const detector = new DurableDetectionEngine({ companyId: values.company, store });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const totals = { polls: 0, received: 0, ignored: 0, processed: 0, alerts: 0, failed: 0, deleteFailed: 0 };
  try {
    do {
      const stats = await pollOnce({ sqs, queueUrl: values.queue, companyId: values.company, scopeId: values.scope, detector, signal: controller.signal });
      totals.polls++;
      for (const field of ['received', 'ignored', 'processed', 'alerts', 'failed', 'deleteFailed']) totals[field] += stats[field] || 0;
    } while (!values.once && !controller.signal.aborted);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    sqs.destroy();
  }
  await writeJson(process.stderr, { mode: 'sqs', ...totals });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(`cloudtrail-sqs-detection: ${error.message}`); process.exitCode = 2; });
}
