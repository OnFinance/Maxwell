#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DynamoDbInvestigationStore } from './dynamodb-store.mjs';
import { InvestigationService } from './service.mjs';

const { values } = parseArgs({ options: {
  company: { type: 'string' }, region: { type: 'string' }, table: { type: 'string' }, action: { type: 'string' },
  case: { type: 'string' }, actor: { type: 'string' }, revision: { type: 'string' }, owner: { type: 'string' },
  text: { type: 'string' }, reason: { type: 'string' }, ref: { type: 'string' }, sha256: { type: 'string' },
  description: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('npm run investigate -- --company <id> --region <region> --table <name> --action list|show|start|assign|note|add-evidence|dismiss|close [options]');
  process.exit(0);
}
for (const field of ['company', 'region', 'table', 'action']) if (!values[field]) throw new Error(`--${field} is required`);
const store = new DynamoDbInvestigationStore({ tableName: values.table, region: values.region });
if (values.action === 'list') console.log(JSON.stringify(await store.listCases(values.company), null, 2));
else if (values.action === 'show') {
  if (!values.case) throw new Error('--case is required');
  const record = await store.getCase(values.company, values.case);
  if (!record) throw new Error('case not found');
  console.log(JSON.stringify(record, null, 2));
} else {
  for (const field of ['case', 'actor', 'revision']) if (!values[field]) throw new Error(`--${field} is required`);
  const action = { type: values.action, actor: values.actor, expectedRevision: Number(values.revision) };
  for (const field of ['owner', 'text', 'reason', 'ref', 'sha256', 'description']) if (values[field] !== undefined) action[field] = values[field];
  const service = new InvestigationService({ store });
  console.log(JSON.stringify(await service.act(values.company, values.case, action), null, 2));
}

