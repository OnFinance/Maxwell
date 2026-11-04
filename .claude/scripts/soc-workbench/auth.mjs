import { randomBytes, createHash } from 'node:crypto';
import * as oidc from 'openid-client';

const random = () => randomBytes(32).toString('base64url');
export const ROLES = Object.freeze({
  viewer: ['case.read', 'response.read'],
  analyst: ['case.read', 'case.write', 'case.confirm', 'response.read', 'response.request', 'response.cancel', 'response.reconcile'],
  approver: ['case.read', 'response.read', 'response.approve', 'response.cancel'],
});
export const companyPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function createOidcProvider({ issuer, clientId, clientSecret, origin, fetchImpl }) {
  const server = new URL(issuer);
  if (server.protocol !== 'https:' || !clientId || !clientSecret) throw new Error('HTTPS issuer and OIDC client credentials required');
  const config = await oidc.discovery(server, clientId, clientSecret, undefined, {
    execute: [oidc.enableNonRepudiationChecks], ...(fetchImpl ? { [oidc.customFetch]: fetchImpl } : {}),
  });
  const redirect = `${origin}/auth/callback`;
  return {
    async start() {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirect, scope: 'openid profile', response_type: 'code',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
      return { url: url.href, verifier, state, nonce };
    },
    async finish(url, flow) {
      const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims || claims.iss !== issuer || typeof claims.sub !== 'string' || !Number.isFinite(claims.exp)) throw new Error('invalid OIDC identity');
      return { subject: claims.sub, expiresAt: claims.exp * 1000 };
    },
  };
}

export class WorkbenchAuth {
  constructor({ origin, provider, bindings, clock = Date.now, allowLocalHttp = false, capacity = 1000 }) {
    const url = new URL(origin);
    if (url.origin !== origin || (url.protocol !== 'https:' && !(allowLocalHttp && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('canonical HTTPS workbench origin required');
    if (!provider || !Array.isArray(bindings) || !bindings.length || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('OIDC provider and bindings required');
    this.bindings = new Map();
    for (const binding of bindings) {
      if (typeof binding.subject !== 'string' || !/^[A-Za-z0-9_.:@/-]{1,255}$/.test(binding.subject) || !companyPattern.test(binding.companyId)
        || !Array.isArray(binding.roles) || !binding.roles.length || binding.roles.some((r) => !Object.hasOwn(ROLES, r))) throw new Error('invalid OIDC role binding');
      const companies = this.bindings.get(binding.subject) || new Map();
      if (companies.has(binding.companyId)) throw new Error('duplicate OIDC company binding');
      companies.set(binding.companyId, [...new Set(binding.roles.flatMap((r) => ROLES[r]))]);
      this.bindings.set(binding.subject, companies);
    }
    Object.assign(this, { origin, provider, clock, capacity });
    this.secure = url.protocol === 'https:';
    this.sessionCookie = this.secure ? '__Host-maxwell_session' : 'maxwell_session';
    this.loginCookie = this.secure ? '__Host-maxwell_login' : 'maxwell_login';
    this.sessions = new Map(); this.flows = new Map();
  }
  cookie(name, value, seconds) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${this.secure ? '; Secure' : ''}`; }
  cookieValue(req, name) {
    const values = (req.headers.cookie || '').split(';').map((v) => v.trim()).filter((v) => v.startsWith(`${name}=`));
    if (values.length !== 1) return null;
    const value = values[0].slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }
  sweep() {
    for (const map of [this.sessions, this.flows]) for (const [key, value] of map) if (value.expiresAt <= this.clock()) map.delete(key);
  }
  async login() {
    this.sweep();
    if (this.flows.size >= this.capacity) throw new Error('login capacity exceeded');
    const id = random();
    this.flows.set(id, { expiresAt: this.clock() + 300000 });
    let flow;
    try { flow = await this.provider.start(); }
    catch (error) { this.flows.delete(id); throw error; }
    this.flows.set(id, { ...flow, expiresAt: this.clock() + 300000 });
    return { location: flow.url, cookie: this.cookie(this.loginCookie, id, 300) };
  }
  async callback(req, url) {
    this.sweep();
    const id = this.cookieValue(req, this.loginCookie);
    const flow = this.flows.get(id);
    this.flows.delete(id); // Consume before token exchange; a callback cannot be replayed.
    if (!flow || url.searchParams.get('state') !== flow.state || this.sessions.size >= this.capacity) throw new Error('invalid login transaction');
    const identity = await this.provider.finish(url, flow);
    const access = this.bindings.get(identity.subject);
    if (!access || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= this.clock() || this.sessions.size >= this.capacity) throw new Error('identity has no workbench access');
    this.sessions.delete(this.cookieValue(req, this.sessionCookie));
    const sessionId = random();
    const expiresAt = Math.min(this.clock() + 900000, identity.expiresAt);
    const actorId = `oidc:${createHash('sha256').update(identity.subject).digest('hex')}`;
    this.sessions.set(sessionId, { subject: identity.subject, actorId, access, csrf: random(), expiresAt });
    return [this.cookie(this.sessionCookie, sessionId, Math.floor((expiresAt - this.clock()) / 1000)), this.cookie(this.loginCookie, '', 0)];
  }
  session(req) { this.sweep(); return this.sessions.get(this.cookieValue(req, this.sessionCookie)) || null; }
  authorize = async (session, companyId, permission) => {
    if (!session || session.expiresAt <= this.clock() || ![...this.sessions.values()].includes(session)
      || !session.access.get(companyId)?.includes(permission)) throw new Error('not authorized');
    return { id: session.actorId, companyId };
  };
  checkWrite(req, session) {
    if (req.headers.origin !== this.origin || req.headers['x-csrf-token'] !== session.csrf) throw new Error('invalid request origin or CSRF token');
  }
  logout(req) { this.sessions.delete(this.cookieValue(req, this.sessionCookie)); return this.cookie(this.sessionCookie, '', 0); }
}
