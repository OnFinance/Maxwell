// Test-only in-memory host. Production startup never imports this module.
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WorkbenchAuth } from '../soc-workbench/auth.mjs';
import { createWorkbenchServer } from '../soc-workbench/server.mjs';
import { normalizeDefenderAlert } from '../threat-detection/microsoft-adapter.mjs';
import { createCase } from '../incident-investigation/core.mjs';
import { InvestigationService } from '../incident-investigation/service.mjs';
import { ConfirmationCoordinator } from '../incident-investigation/confirmation.mjs';
import { ResponseService } from '../incident-response/service.mjs';
import { microsoftTargetResolver } from '../incident-response/microsoft.mjs';

export async function workbenchFixture(port = 0) {
  const companyId = 'example-co'; const tenantId = '11111111-2222-3333-4444-555555555555'; const machineId = 'a'.repeat(40);
  const now = new Date().toISOString();
  const source = { id: 'provider-alert', tenantId, serviceSource: 'microsoftDefenderForEndpoint', title: 'Suspicious process on finance workstation', severity: 'high', createdDateTime: now, lastUpdateDateTime: now,
    evidence: [{ '@odata.type': '#microsoft.graph.security.deviceEvidence', mdeDeviceId: machineId, onboardingStatus: 'onboarded' }] };
  const record = createCase(normalizeDefenderAlert(source, { companyId, tenantId }));
  const cases = new Map([[record.caseId, record]]); const responses = new Map(); const incidents = new Map();
  const caseStore = {
    getCase: async (company, id) => structuredClone(cases.get(id)?.companyId === company ? cases.get(id) : null),
    listCasesPage: async (company) => ({ items: [...cases.values()].filter((c) => c.companyId === company).map((c) => structuredClone(c)), next: null }),
    saveChange: async (previous, next) => { if (cases.get(next.caseId).revision !== previous.revision) throw new Error('case revision conflict'); cases.set(next.caseId, structuredClone(next)); return next; },
  };
  const responseStore = {
    get: async (company, id) => structuredClone(responses.get(id)?.proposal.companyId === company ? responses.get(id) : null),
    listPage: async (company) => ({ items: [...responses.values()].filter((r) => r.proposal.companyId === company).map((r) => structuredClone(r)), next: null }),
    create: async (r, current) => { if (cases.get(current.caseId).revision !== current.revision) throw new Error('case revision conflict'); responses.set(r.responseId, structuredClone(r)); },
    change: async (previous, next, current) => { if (responses.get(next.responseId).revision !== previous.revision || (current && cases.get(current.caseId).revision !== current.revision)) throw new Error('revision conflict'); responses.set(next.responseId, structuredClone(next)); },
  };
  const provider = { start: async () => { const state = randomUUID(); return { state, url: `${auth.origin}/auth/callback?state=${state}&code=analyst` }; },
    finish: async (url) => ({ subject: url.searchParams.get('code'), expiresAt: Date.now() + 3600000 }) };
  const auth = new WorkbenchAuth({ origin: 'http://127.0.0.1:8788', allowLocalHttp: true, provider, bindings: [
    { subject: 'analyst', companyId, roles: ['analyst'] }, { subject: 'approver', companyId, roles: ['approver'] },
    { subject: 'viewer', companyId, roles: ['viewer'] }, { subject: 'dual', companyId, roles: ['analyst', 'approver'] },
    { subject: 'outsider', companyId: 'other-co', roles: ['analyst'] },
  ] });
  const responseService = new ResponseService({ store: responseStore, caseStore, authorize: auth.authorize,
    resolveTarget: microsoftTargetResolver({ getToken: async () => ({ tenantId, accessToken: 'test' }), fetchImpl: async () => Response.json(source) }),
    policy: async () => true, provider: { submit: async () => { throw new Error('test host must never execute'); }, inspect: async () => { throw new Error('no provider action in fixture'); } },
  });
  const server = createWorkbenchServer({ auth, caseStore, responseStore, responseService, investigation: new InvestigationService({ store: caseStore }),
    confirmationForCompany: async () => new ConfirmationCoordinator({ store: caseStore, writer: { append: (incident) => { incidents.set(incident.id, incident); return { appended: true }; } },
      companyDetails: { frameworksInScope: ['cert-in-directions-2022'] }, slaTable: { entries: [{ instrument: 'cert-in-directions-2022', topic: 'incident-reporting', severity: 'any', hours: 6 }] } }),
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening'); auth.origin = `http://127.0.0.1:${server.address().port}`;
  return { server, auth, cases, responses, incidents, responseService, caseId: record.caseId, companyId, machineId, source,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
