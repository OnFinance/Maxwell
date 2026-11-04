#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDbInvestigationStore } from '../incident-investigation/dynamodb-store.mjs';
import { InvestigationService } from '../incident-investigation/service.mjs';
import { ConfirmationCoordinator, LedgerIncidentWriter, loadConfirmationContext } from '../incident-investigation/confirmation.mjs';
import { DynamoDbResponseStore } from '../incident-response/store.mjs';
import { createResponsePolicy } from '../incident-response/policy.mjs';
import { ResponseService } from '../incident-response/service.mjs';
import { MicrosoftResponseProvider, microsoftTargetResolver } from '../incident-response/microsoft.mjs';
import { microsoftClientCredentials } from '../threat-detection/microsoft-auth.mjs';
import { WorkbenchAuth, createOidcProvider } from './auth.mjs';
import { createWorkbenchServer } from './server.mjs';

async function main() {
  const { values } = parseArgs({ options: { origin: { type: 'string' }, issuer: { type: 'string' }, table: { type: 'string' }, region: { type: 'string' },
    port: { type: 'string', default: '8787' }, 'local-http': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('soc-workbench/run.mjs --origin https://soc.example.com --issuer https://login.microsoftonline.com/<tenant>/v2.0 --table <investigation-table> --region <region> [--port 8787]\nBinds 127.0.0.1 only; put behind a TLS reverse proxy preserving Host. Host env: MAXWELL_OIDC_CLIENT_ID, MAXWELL_OIDC_CLIENT_SECRET, MAXWELL_WORKBENCH_BINDINGS (JSON array), MAXWELL_WORKBENCH_TARGETS (JSON array), MAXWELL_RESPONSE_POLICY (protected devices and UTC windows). Optional Microsoft read/status credentials described in README. No execution endpoint; live response stays disabled. --local-http is restricted to a 127.0.0.1 origin for development.');
    return;
  }
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !values.table || !values.region) throw new Error('valid port, table and region required');
  const bindings = JSON.parse(process.env.MAXWELL_WORKBENCH_BINDINGS || '[]');
  const targets = JSON.parse(process.env.MAXWELL_WORKBENCH_TARGETS || '[]');
  const policy = createResponsePolicy({ targets, config: JSON.parse(process.env.MAXWELL_RESPONSE_POLICY || '{"protectedDevices":[],"windows":[]}') });
  const provider = await createOidcProvider({ issuer: values.issuer, origin: values.origin,
    clientId: process.env.MAXWELL_OIDC_CLIENT_ID, clientSecret: process.env.MAXWELL_OIDC_CLIENT_SECRET });
  const auth = new WorkbenchAuth({ origin: values.origin, provider, bindings, allowLocalHttp: values['local-http'] === true });
  const raw = new DynamoDBClient({ region: values.region, maxAttempts: 5 });
  const client = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const caseStore = new DynamoDbInvestigationStore({ tableName: values.table, documentClient: client });
  const responseStore = new DynamoDbResponseStore({ tableName: values.table, documentClient: client });
  const tokens = new Map();
  const token = (resource, prefix) => async ({ tenantId, scope }) => {
    // Provider evidence tenant must be explicitly configured by the operator.
    if (!targets.some((t) => t.tenantId === tenantId)) throw new Error('Microsoft tenant not configured');
    const key = `${resource}:${tenantId}`;
    if (!tokens.has(key)) tokens.set(key, microsoftClientCredentials({ tenantId, resource,
      clientId: process.env[`${prefix}_CLIENT_ID`], clientSecret: process.env[`${prefix}_CLIENT_SECRET`] }));
    return tokens.get(key)({ tenantId, scope });
  };
  const responses = new ResponseService({ store: responseStore, caseStore, authorize: auth.authorize,
    resolveTarget: microsoftTargetResolver({ getToken: token('https://graph.microsoft.com', 'MAXWELL_MICROSOFT') }),
    policy,
    provider: new MicrosoftResponseProvider({ getToken: token('https://api.securitycenter.microsoft.com', 'MAXWELL_DEFENDER_STATUS') }),
    executionEnabled: false,
  });
  const server = createWorkbenchServer({ auth, caseStore, responseStore, responseService: responses,
    investigation: new InvestigationService({ store: caseStore }),
    confirmationForCompany: async (companyId) => new ConfirmationCoordinator({ store: caseStore, writer: new LedgerIncidentWriter(), ...loadConfirmationContext(process.cwd(), companyId) }),
  });
  server.maxConnections = 100;
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  console.log(`Maxwell workbench listening on 127.0.0.1:${port}; public origin ${auth.origin}; execution disabled`);
  const stop = () => { server.closeAllConnections(); server.close(() => raw.destroy()); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
main().catch(() => { console.error('workbench: startup failed; verify OIDC, bindings, origin and database configuration'); process.exitCode = 2; });
