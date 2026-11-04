import { microsoftScope } from './microsoft-adapter.mjs';
import { readMicrosoftJson } from './microsoft-http.mjs';

// Credentials are supplied by the host; never persist or log token responses.
export function microsoftClientCredentials({ tenantId, clientId, clientSecret, fetchImpl = fetch, clock = Date.now } = {}) {
  const tenant = microsoftScope({ companyId: 'auth', tenantId }).tenantId;
  if (!/^[0-9a-f-]{36}$/i.test(clientId || '') || typeof clientSecret !== 'string' || !clientSecret) throw new Error('Microsoft client credentials are required');
  let cached;
  return async ({ tenantId: requestedTenant, scope }) => {
    if (requestedTenant !== tenant || scope !== 'https://graph.microsoft.com/.default') throw new Error('Microsoft credential scope mismatch');
    if (cached && cached.expiresAt > clock() + 60000) return { tenantId: tenant, accessToken: cached.accessToken };
    const started = clock();
    let response;
    try {
      response = await fetchImpl(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope, grant_type: 'client_credentials' }),
      });
    } catch { throw new Error('Microsoft authentication transport failed'); }
    if (!response.ok) throw new Error(`Microsoft authentication HTTP ${response.status}`);
    const result = await readMicrosoftJson(response, 65536);
    if (typeof result?.token_type !== 'string' || result.token_type.toLowerCase() !== 'bearer' || typeof result.access_token !== 'string' || !result.access_token
      || !Number.isSafeInteger(result.expires_in) || result.expires_in <= 60) throw new Error('invalid Microsoft token response');
    cached = { accessToken: result.access_token, expiresAt: started + result.expires_in * 1000 };
    return { tenantId: tenant, accessToken: cached.accessToken };
  };
}
