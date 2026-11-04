import { microsoftScope, normalizeEntraSignIn, normalizeDefenderAlert } from './microsoft-adapter.mjs';
import { readMicrosoftJson } from './microsoft-http.mjs';

const ORIGIN = 'https://graph.microsoft.com';
const PATHS = { entra: '/v1.0/auditLogs/signIns', defender: '/v1.0/security/alerts_v2' };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// getToken MUST return a token acquired for the requested tenant, with admin-consented
// read permissions. Tenant credentials belong in the host secret manager, not the repo.
export class MicrosoftCollector {
  constructor({ companyId, tenantId, getToken, fetchImpl = fetch, sleep = delay, maxPages = 100, maxRecords = 100000 } = {}) {
    Object.assign(this, microsoftScope({ companyId, tenantId }));
    if (typeof getToken !== 'function') throw new Error('tenant-bound getToken is required');
    if (![maxPages, maxRecords].every((v) => Number.isSafeInteger(v) && v > 0)) throw new Error('invalid collection limits');
    Object.assign(this, { getToken, fetchImpl, sleep, maxPages, maxRecords });
  }

  async collect({ source, from, to, deliver } = {}) {
    if (!PATHS[source] || !iso(from) || !iso(to) || from >= to || typeof deliver !== 'function') throw new Error('invalid collection range/source/deliver');
    const field = source === 'entra' ? 'createdDateTime' : 'lastUpdateDateTime';
    let url = new URL(PATHS[source], ORIGIN);
    url.searchParams.set('$filter', `${field} ge ${from} and ${field} le ${to}${source === 'defender' ? " and serviceSource eq 'microsoftDefenderForEndpoint'" : ''}`);
    url.searchParams.set('$top', '1000');
    const visited = new Set();
    let received = 0;
    let delivered = 0;
    while (url) {
      // Never send bearer tokens to a server-selected host, path, or redirect.
      if (url.origin !== ORIGIN || url.pathname !== PATHS[source] || url.username || url.password || url.hash) throw new Error('unsafe Microsoft pagination URL');
      if (visited.has(url.href)) throw new Error('Microsoft pagination cycle');
      if (visited.size >= this.maxPages) throw new Error('Microsoft page limit exceeded; checkpoint unchanged');
      visited.add(url.href);
      let response;
      for (let attempt = 0; attempt < 4; attempt++) {
        const credential = await this.getToken({ tenantId: this.tenantId, scope: `${ORIGIN}/.default` });
        if (credential?.tenantId?.toLowerCase() !== this.tenantId || typeof credential.accessToken !== 'string' || !credential.accessToken || /[\r\n]/.test(credential.accessToken)) throw new Error('invalid tenant-bound Microsoft credential');
        try {
          response = await this.fetchImpl(url.href, { method: 'GET', redirect: 'error',
            headers: { Authorization: `Bearer ${credential.accessToken}` }, signal: AbortSignal.timeout(30000) });
        } catch { throw new Error('Microsoft collection transport failed; checkpoint unchanged'); }
        if (![429, 503].includes(response.status) || attempt === 3) break;
        const retry = response.headers.get('retry-after');
        const ms = retry === null ? 1000 * 2 ** attempt : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        if (!Number.isFinite(ms) || ms > 60000) throw new Error('Microsoft retry deferred; checkpoint unchanged');
        await response.body?.cancel();
        await this.sleep(Math.max(0, ms));
      }
      if (!response.ok) throw new Error(`Microsoft collection HTTP ${response.status}; checkpoint unchanged`);
      const page = await readMicrosoftJson(response);
      if (!page || typeof page !== 'object') throw new Error('invalid Microsoft collection response');
      if (!Array.isArray(page.value)) throw new Error('invalid Microsoft collection response');
      for (const record of page.value) {
        if (++received > this.maxRecords) throw new Error('Microsoft record limit exceeded; checkpoint unchanged');
        const normalized = source === 'entra' ? normalizeEntraSignIn(record, this) : normalizeDefenderAlert(record, this);
        if (!normalized) continue;
        const at = source === 'entra' ? normalized.eventTime : normalized.detectedAt;
        if (at < from || at > to) throw new Error('Microsoft record outside requested range');
        // Delivery must persist to a durable inbox/outbox idempotently. No checkpoint
        // is returned until every page and every delivery has succeeded.
        await deliver(normalized);
        delivered++;
      }
      const next = page['@odata.nextLink'];
      if (next !== undefined && (typeof next !== 'string' || !next)) throw new Error('invalid Microsoft nextLink');
      try { url = next ? new URL(next) : null; } catch { throw new Error('invalid Microsoft nextLink'); }
    }
    return { companyId: this.companyId, tenantId: this.tenantId, source, from, checkpoint: to, received, delivered, pages: visited.size };
  }
}
