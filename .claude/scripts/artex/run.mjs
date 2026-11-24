#!/usr/bin/env node
// Safe ARTEX boundary. Actual assessment execution is host-owned because upstream ARTEX
// cannot be launched as an opaque command without bypassing Maxwell's sandbox policy.
import { parseArgs } from 'node:util';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { ArtexVerificationService, normalizeVerificationScope } from './service.mjs';

export class ArtexRunnerError extends Error {
  constructor(message, code = 'ARTEX_UNAVAILABLE') {
    super(message);
    this.code = code;
  }
}

export function validateConfig(config) {
  try {
    return normalizeVerificationScope(config);
  } catch (error) {
    throw new ArtexRunnerError(error.message, 'INVALID_SCOPE');
  }
}

export function prepareArtexConfig(config) {
  const scope = validateConfig(config);
  return {
    mode: 'verification-only',
    companyId: scope.companyId,
    application: scope.application,
    environment: scope.environment,
    findingId: scope.findingId,
    fingerprint: scope.fingerprint,
    expectedRevision: scope.expectedRevision,
    goal: scope.goal,
    allowedUrls: scope.urls,
  };
}

export async function runArtex() {
  throw new ArtexRunnerError(
    'Direct ARTEX execution is disabled. A host must construct ArtexVerificationService with trusted authorization, scope, and broker adapters.',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { values } = parseArgs({
      options: {
        operation: { type: 'string' },
        company: { type: 'string' },
        id: { type: 'string' },
        'state-session': { type: 'string' },
      },
    });
    if (values.operation !== 'read') {
      throw new ArtexRunnerError(
        'This local CLI is read-only. Authorization and execution require trusted host adapters.',
      );
    }
    const service = new ArtexVerificationService({
      store: new ExportStateStore({ sessionId: values['state-session'] }),
      authorize: async (_session, companyId) => ({ companyId, id: `host:${process.getuid()}` }),
      loadScope: async () => {
        throw new ArtexRunnerError('Scope adapter unavailable.');
      },
      verifyAuthorization: async () => {
        throw new ArtexRunnerError('Authorization adapter unavailable.');
      },
      executor: async () => {
        throw new ArtexRunnerError('ARTEX broker unavailable.');
      },
    });
    const result = await service.read({
      session: 'local',
      companyId: values.company,
      id: values.id,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === 'ARTEX_UNAVAILABLE' ? 3 : 2;
  }
}

export { ArtexVerificationService };
