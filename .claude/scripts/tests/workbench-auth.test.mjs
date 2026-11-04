import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOidcProvider, WorkbenchAuth } from '../soc-workbench/auth.mjs';

const issuer = 'https://id.example.test';
const origin = 'https://soc.example.test';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('real OIDC client verifies signatures, issuer, audience, nonce, expiry, state and PKCE', async () => {
  for (const variant of ['valid', 'signature', 'issuer', 'audience', 'nonce', 'expiry', 'state']) {
    let flow;
    const provider = await createOidcProvider({ issuer, origin, clientId: 'workbench-test', clientSecret: 'test-only', fetchImpl: async (input, options) => {
      const url = String(input);
      if (url.includes('.well-known')) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] });
      if (url === `${issuer}/jwks`) return Response.json({ keys: [publicKey] });
      assert.equal(url, `${issuer}/token`);
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('code_verifier'), flow.verifier);
      assert.equal(body.get('redirect_uri'), `${origin}/auth/callback`);
      const now = Math.floor(Date.now() / 1000);
      const payload = { iss: variant === 'issuer' ? 'https://evil.test' : issuer, sub: 'analyst', aud: variant === 'audience' ? 'other-app' : 'workbench-test',
        nonce: variant === 'nonce' ? 'wrong' : flow.nonce, iat: now, exp: variant === 'expiry' ? now - 120 : now + 600 };
      const unsigned = `${encode({ alg: 'RS256', kid: 'test' })}.${encode(payload)}`;
      const signature = variant === 'signature' ? Buffer.alloc(256).toString('base64url') : sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url');
      return Response.json({ token_type: 'Bearer', access_token: 'never-store-this', expires_in: 600, id_token: `${unsigned}.${signature}` });
    } });
    flow = await provider.start();
    assert.equal(new URL(flow.url).searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(`${origin}/auth/callback?code=test&state=${variant === 'state' ? 'wrong' : flow.state}`);
    if (variant === 'valid') assert.equal((await provider.finish(callback, flow)).subject, 'analyst');
    else await assert.rejects(provider.finish(callback, flow), undefined, variant);
  }
});

test('session cookies, callback replay, CSRF, expiry and company membership fail closed', async () => {
  let now = Date.now();
  const provider = { start: async () => ({ url: `${issuer}/authorize`, state: 'expected' }), finish: async () => ({ subject: 'analyst', expiresAt: now + 3600000 }) };
  const auth = new WorkbenchAuth({ origin, provider, clock: () => now, bindings: [{ subject: 'analyst', companyId: 'example-co', roles: ['analyst'] }] });
  const login = await auth.login();
  assert.match(login.cookie, /HttpOnly; SameSite=Lax; Max-Age=300; Secure/);
  const req = { headers: { cookie: login.cookie.split(';')[0] } };
  const cookies = await auth.callback(req, new URL(`${origin}/auth/callback?state=expected&code=test`));
  await assert.rejects(auth.callback(req, new URL(`${origin}/auth/callback?state=expected&code=test`)));
  req.headers.cookie = cookies[0].split(';')[0];
  const session = auth.session(req);
  assert.equal((await auth.authorize(session, 'example-co', 'case.write')).companyId, 'example-co');
  await assert.rejects(auth.authorize(session, 'other-co', 'case.write'));
  await assert.rejects(auth.authorize(session, 'example-co', 'response.execute'));
  await assert.rejects(auth.authorize({ ...session }, 'example-co', 'case.write'));
  assert.throws(() => auth.checkWrite({ headers: { origin: 'https://evil.test', 'x-csrf-token': session.csrf } }, session));
  assert.throws(() => auth.checkWrite({ headers: { origin, 'x-csrf-token': 'wrong' } }, session));
  auth.checkWrite({ headers: { origin, 'x-csrf-token': session.csrf } }, session);
  assert.equal(auth.session({ headers: { cookie: `${req.headers.cookie}; ${req.headers.cookie}` } }), null);
  now += 900001;
  assert.equal(auth.session(req), null);
  await assert.rejects(auth.authorize(session, 'example-co', 'case.read'));
});

test('unbound identities, insecure origins and unknown roles are rejected', async () => {
  const provider = { start: async () => ({ url: issuer, state: 'expected' }), finish: async () => ({ subject: 'unbound', expiresAt: Date.now() + 100000 }) };
  const bindings = [{ subject: 'analyst', companyId: 'example-co', roles: ['viewer'] }];
  assert.throws(() => new WorkbenchAuth({ origin: 'http://soc.example.test', provider, bindings }));
  assert.throws(() => new WorkbenchAuth({ origin, provider, bindings: [{ ...bindings[0], roles: ['administrator'] }] }));
  const auth = new WorkbenchAuth({ origin, provider, bindings, capacity: 1 });
  const login = await auth.login();
  await assert.rejects(auth.login(), /capacity/);
  await assert.rejects(auth.callback({ headers: { cookie: login.cookie.split(';')[0] } }, new URL(`${origin}/auth/callback?state=expected`)));
  assert.equal(auth.sessions.size, 0);
});
