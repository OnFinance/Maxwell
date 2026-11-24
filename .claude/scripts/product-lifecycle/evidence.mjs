import { ensure } from './model.mjs';

const REVISION = /^[a-f0-9]{40}$/;
const SIGNAL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/;
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;

function normalizeCollection(provider, result, scope) {
  ensure(result && Array.isArray(result.signals) && Array.isArray(result.gaps), `Invalid ${provider} evidence result.`);
  const signals = result.signals.slice(0, 500).map((signal) => {
    ensure(
      signal &&
        SIGNAL_ID.test(signal.id ?? '') &&
        typeof signal.at === 'string' &&
        Number.isFinite(Date.parse(signal.at)) &&
        signal.revision === scope.revision &&
        typeof signal.summary === 'string' &&
        signal.summary.length > 0 &&
        signal.summary.length <= 500,
      `Invalid ${provider} evidence signal.`,
    );
    return {
      id: signal.id,
      at: signal.at,
      type: typeof signal.type === 'string' ? signal.type.slice(0, 64) : 'observation',
      revision: signal.revision,
      summary: signal.summary,
    };
  });
  return {
    provider,
    revision: scope.revision,
    signals,
    complete: result.complete === true,
    gaps: result.gaps.slice(0, 50).map((gap) => String(gap).slice(0, 500)),
  };
}

// Collectors are trusted, read-only host adapters for Sentry, logs, or traces. They
// return metadata-only signals. A failed or absent provider always remains an explicit gap.
export async function collectOperationalEvidence({ scope, collectors = {} }) {
  ensure(
    scope &&
      typeof scope.environment === 'string' &&
      REVISION.test(scope.revision ?? '') &&
      collectors && typeof collectors === 'object' &&
      Object.keys(collectors).length <= 10,
    'Invalid operational evidence scope.',
  );
  const collections = [];
  for (const [provider, collect] of Object.entries(collectors).sort(([a], [b]) => a.localeCompare(b))) {
    ensure(PROVIDER.test(provider) && typeof collect === 'function', 'Invalid operational evidence collector.');
    try {
      collections.push(normalizeCollection(provider, await collect(structuredClone(scope)), scope));
    } catch (error) {
      collections.push({
        provider,
        revision: scope.revision,
        signals: [],
        complete: false,
        gaps: [
          `Collection unavailable: ${error instanceof Error ? error.message.slice(0, 400) : 'unknown provider failure'}`,
        ],
      });
    }
  }
  if (collections.length === 0) {
    collections.push({
      provider: 'none',
      revision: scope.revision,
      signals: [],
      complete: false,
      gaps: ['No operational evidence provider was configured.'],
    });
  }
  return {
    environment: scope.environment,
    revision: scope.revision,
    collections,
    complete: collections.length > 0 && collections.every((item) => item.complete),
  };
}
