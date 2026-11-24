import { actor, requireValue, timestamp, token } from '../feature-runtime/store.mjs';
import { digest } from '../product-lifecycle/model.mjs';

const REVISION = /^[a-f0-9]{40}$/;
const FINDING_ID = /^fnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NON_PRODUCTION = new Set(['dev', 'test', 'devtest', 'sandbox', 'preview', 'qa', 'uat', 'staging']);

function normalizedUrls(urls) {
  requireValue(Array.isArray(urls) && urls.length > 0 && urls.length <= 50, 'invalid ARTEX URL scope');
  const values = urls.map((value) => {
    const url = new URL(value);
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'ARTEX scope requires credential-free HTTPS URLs');
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  });
  requireValue(new Set(values).size === values.length, 'duplicate ARTEX URL scope');
  return values.sort();
}

export function normalizeVerificationScope(scope) {
  requireValue(
    scope &&
      ['companyId', 'application', 'environment'].every((field) =>
        typeof scope[field] === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(scope[field]),
      ) &&
      FINDING_ID.test(scope.findingId ?? '') &&
      typeof scope.fingerprint === 'string' && scope.fingerprint.length >= 8 && scope.fingerprint.length <= 200 &&
      REVISION.test(scope.expectedRevision ?? '') &&
      typeof scope.goal === 'string' && scope.goal.trim().length > 0 && scope.goal.length <= 1000,
    'invalid ARTEX verification scope',
  );
  requireValue(NON_PRODUCTION.has(scope.tier), 'ARTEX verification requires a registered non-production environment');
  return {
    companyId: scope.companyId,
    application: scope.application,
    environment: scope.environment,
    tier: scope.tier,
    findingId: scope.findingId,
    fingerprint: scope.fingerprint,
    expectedRevision: scope.expectedRevision,
    goal: scope.goal.trim(),
    urls: normalizedUrls(scope.urls),
    mode: 'verification-only',
  };
}

function validAuthorization(authorization, scopeHash, now) {
  return (
    authorization &&
    token(authorization.id) &&
    token(authorization.approvedBy) &&
    typeof authorization.authorizedAt === 'string' &&
    Number.isFinite(Date.parse(authorization.authorizedAt)) &&
    Date.parse(authorization.authorizedAt) <= now &&
    typeof authorization.validUntil === 'string' &&
    Number.isFinite(Date.parse(authorization.validUntil)) &&
    now < Date.parse(authorization.validUntil) &&
    token(authorization.documentRef) &&
    SHA256.test(authorization.documentSha256 ?? '') &&
    authorization.scopeSha256 === scopeHash
  );
}

function validResult(result, scope) {
  return (
    result &&
    ['not-reproduced', 'reproduced', 'inconclusive', 'blocked'].includes(result.outcome) &&
    result.findingId === scope.findingId &&
    result.fingerprint === scope.fingerprint &&
    result.revision === scope.expectedRevision &&
    Array.isArray(result.evidence) &&
    result.evidence.length <= 100 &&
    result.evidence.every(
      (item) =>
        item && token(item.ref) && SHA256.test(item.sha256 ?? '') &&
        typeof item.summary === 'string' && item.summary.length > 0 && item.summary.length <= 500,
    )
  );
}

// Host-owned authorization, scope, and executor adapters are mandatory. The executor must
// broker a legally approved engine and serialize effects by operationId. This service never
// launches ARTEX, accepts credentials, or turns broad discoveries into verification results.
export class ArtexVerificationService {
  constructor({ store, authorize, loadScope, verifyAuthorization, executor, clock = Date.now }) {
    requireValue(store && authorize && loadScope && verifyAuthorization && executor, 'ARTEX host adapters are required');
    Object.assign(this, { store, authorize, loadScope, verifyAuthorization, executor, clock });
  }

  async prepare({ session, companyId, requestId, authorizationRef, ...selected }) {
    const by = await actor(this.authorize, session, companyId, 'artex.authorize');
    requireValue(token(requestId) && token(authorizationRef), 'invalid ARTEX request identity');
    const key = `artex-verification:${requestId}`;
    const requested = { companyId, ...selected };
    const scope = normalizeVerificationScope(await this.loadScope(requested));
    requireValue(
      ['application', 'environment', 'findingId', 'fingerprint', 'expectedRevision'].every(
        (field) => scope[field] === requested[field],
      ),
      'registered ARTEX scope does not match the request',
    );
    const requestHash = digest({ scope, authorizationRef });
    const existing = await this.store.get(companyId, key);
    if (existing) {
      requireValue(existing.value.requestHash === requestHash, 'ARTEX request ID was reused');
      return existing;
    }
    const scopeSha256 = digest(scope);
    const authorization = await this.verifyAuthorization({
      session,
      companyId,
      authorizationRef,
      scope: structuredClone(scope),
      scopeSha256,
    });
    const now = this.clock();
    requireValue(Number.isSafeInteger(now) && validAuthorization(authorization, scopeSha256, now), 'ARTEX authorization is invalid, expired, or outside scope');
    return this.store.change(
      companyId,
      key,
      null,
      {
        kind: 'maxwell.artex.verification',
        state: 'authorized',
        requestHash,
        scope,
        authorization: {
          id: authorization.id,
          approvedBy: authorization.approvedBy,
          authorizedAt: authorization.authorizedAt,
          validUntil: authorization.validUntil,
          documentRef: authorization.documentRef,
          documentSha256: authorization.documentSha256,
          scopeSha256,
        },
        history: [{ state: 'authorized', actor: by, at: timestamp(now) }],
      },
      now,
    );
  }

  async read({ session, companyId, id }) {
    await actor(this.authorize, session, companyId, 'artex.read');
    const current = await this.store.get(companyId, id);
    requireValue(current?.value?.kind === 'maxwell.artex.verification', 'ARTEX verification unavailable');
    return current;
  }

  async execute({ session, companyId, id, expectedRevision }) {
    const by = await actor(this.authorize, session, companyId, 'artex.execute');
    let current = await this.store.get(companyId, id);
    requireValue(current?.revision === expectedRevision, 'ARTEX state revision conflict');
    requireValue(current.value.state === 'authorized', 'ARTEX verification is not executable');
    const scope = normalizeVerificationScope(await this.loadScope(structuredClone(current.value.scope)));
    const scopeSha256 = digest(scope);
    const now = this.clock();
    requireValue(
      scopeSha256 === current.value.authorization.scopeSha256 &&
        validAuthorization(current.value.authorization, scopeSha256, now),
      'ARTEX authorization expired or registered scope changed',
    );
    current = await this.store.change(
      companyId,
      id,
      current,
      {
        ...current.value,
        state: 'running',
        operationId: digest({ companyId, id, revision: current.revision + 1 }),
        history: [...current.value.history, { state: 'running', actor: by, at: timestamp(now) }],
      },
      now,
    );
    let result;
    try {
      result = await this.executor({
        operationId: current.value.operationId,
        scope: structuredClone(scope),
        authorization: structuredClone(current.value.authorization),
      });
      requireValue(validResult(result, scope), 'ARTEX verification result is not revision-bound');
    } catch {
      return this.store.change(
        companyId,
        id,
        current,
        {
          ...current.value,
          state: 'failed',
          result: { reason: 'ARTEX broker failed or returned invalid revision-bound evidence.' },
          history: [...current.value.history, { state: 'failed', actor: by, at: timestamp(this.clock()) }],
        },
        this.clock(),
      );
    }
    return this.store.change(
      companyId,
      id,
      current,
      {
        ...current.value,
        state: 'completed',
        result: structuredClone(result),
        history: [...current.value.history, { state: 'completed', actor: by, at: timestamp(this.clock()) }],
      },
      this.clock(),
    );
  }
}
