import { createServer } from 'node:http';
import { companyPattern } from './auth.mjs';
import { HTML, CSS, SCRIPT } from './ui.mjs';

const fields = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))) throw new Error('invalid request fields');
  return body;
};
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('invalid content type');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) throw new Error('request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid JSON'); }
}

export function createWorkbenchServer({ auth, caseStore, investigation, responseStore, responseService, confirmationForCompany }) {
  if (!auth || !caseStore || !investigation || !responseStore || !responseService || typeof confirmationForCompany !== 'function') throw new Error('workbench services required');
  // Browser host deliberately does not expose an execution route.
  return createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 15000 }, async (req, res) => {
    const send = (status, value, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(auth.origin).host || !req.url.startsWith('/') || req.url.startsWith('//')) return send(400, { error: 'Invalid host or request URL' });
      const url = new URL(req.url, auth.origin);
      if (req.method === 'GET' && ['/', '/app.js', '/app.css'].includes(url.pathname)) {
        const [data, type] = url.pathname === '/' ? [HTML, 'text/html'] : url.pathname === '/app.js' ? [SCRIPT, 'text/javascript'] : [CSS, 'text/css'];
        return send(200, data, type);
      }
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        const login = await auth.login();
        res.setHeader('Set-Cookie', login.cookie); res.writeHead(302, { Location: login.location }); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        res.setHeader('Set-Cookie', await auth.callback(req, url)); res.writeHead(302, { Location: '/' }); return res.end();
      }
      const session = auth.session(req);
      if (!session) return send(401, { error: 'Sign in to continue' });
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200, {
        subject: session.subject, actorId: session.actorId, csrf: session.csrf, expiresAt: session.expiresAt, executionEnabled: false,
        companies: [...session.access].map(([companyId, permissions]) => ({ companyId, permissions })),
      });
      if (req.method !== 'GET') auth.checkWrite(req, session);
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        res.setHeader('Set-Cookie', auth.logout(req)); return send(200, { signedOut: true });
      }
      const match = url.pathname.match(/^\/api\/companies\/([^/]+)\/(cases|responses)(?:\/([^/]+))?(?:\/(actions|decision|reconcile))?$/);
      if (!match || !companyPattern.test(match[1]) || !['GET', 'POST'].includes(req.method)) return send(404, { error: 'Not found' });
      const [, companyId, collection, id, operation] = match;
      const actor = await auth.authorize(session, companyId, collection === 'cases' ? 'case.read' : 'response.read');
      if (req.method === 'GET') {
        if (operation) return send(404, { error: 'Not found' });
        if (collection === 'responses') return send(200, id ? await responseService.read({ session, companyId, responseId: id }) : await responseStore.listPage(companyId, url.searchParams.get('after') || undefined));
        if (!id) return send(200, await caseStore.listCasesPage(companyId, url.searchParams.get('after') || undefined));
        if (!/^case_[a-f0-9]{32}$/.test(id)) return send(400, { error: 'Invalid case ID' });
        const current = await caseStore.getCase(companyId, id);
        return current && current.companyId === companyId ? send(200, current) : send(404, { error: 'Case not found' });
      }
      const input = await body(req);
      if (collection === 'cases' && operation === 'actions' && /^case_[a-f0-9]{32}$/.test(id)) {
        const allowed = { start: [], assign: ['owner'], note: ['text'], 'add-evidence': ['ref', 'sha256', 'description'], dismiss: ['reason'], close: [], confirm: ['category', 'affectedDataClassifications'] };
        if (!Object.hasOwn(allowed, input?.type)) throw new Error('invalid case action');
        fields(input, ['type', 'expectedRevision', ...allowed[input.type]]);
        await auth.authorize(session, companyId, input.type === 'confirm' ? 'case.confirm' : 'case.write');
        if (input.type === 'confirm') {
          const coordinator = await confirmationForCompany(companyId);
          return send(200, await coordinator.confirm(companyId, id, { actor: actor.id, expectedRevision: input.expectedRevision, category: input.category, affectedDataClassifications: input.affectedDataClassifications }));
        }
        return send(200, await investigation.act(companyId, id, { ...input, actor: actor.id }));
      }
      if (collection === 'responses' && !id) {
        fields(input, ['caseId', 'providerAlertId', 'machineId', 'action', 'reason', 'expiresInMs']);
        return send(201, await responseService.request({ ...input, session, companyId }));
      }
      if (collection === 'responses' && operation === 'decision') {
        fields(input, ['expectedRevision', 'digest', 'decision']);
        return send(200, await responseService.decide({ ...input, session, companyId, responseId: id }));
      }
      if (collection === 'responses' && operation === 'reconcile') {
        fields(input, ['expectedRevision', 'providerActionId']);
        return send(200, await responseService.reconcile({ ...input, session, companyId, responseId: id }));
      }
      return send(404, { error: 'Not found' });
    } catch (error) {
      // Never forward database, identity-provider, credential or evidence payloads.
      if (error.message === 'request too large') return send(413, { error: 'Request exceeds 16 KiB limit' });
      if (/not authorized|CSRF|request origin/.test(error.message)) return send(403, { error: 'Access denied or invalid request origin' });
      if (/changed|revision|conflict|cannot be|approval required/.test(error.message) || error.name === 'TransactionCanceledException') return send(409, { error: 'State changed or action unavailable; refresh and review again' });
      if (/invalid|requires|denied|requester cannot|expired|snapshot|not in case|confirmed|lifetime/.test(error.message)) return send(400, { error: 'Request rejected; check the action, evidence, permissions and current state' });
      return send(503, { error: 'Operation unavailable; refresh before retrying' });
    }
  });
}
