import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOperationalEvidence } from '../product-lifecycle/evidence.mjs';

const revision = 'a'.repeat(40);
const scope = { environment: 'qa', revision };

test('collects bounded revision metadata from log and trace adapters', async () => {
  const result = await collectOperationalEvidence({
    scope,
    collectors: {
      logs: async () => ({
        complete: false,
        gaps: ['Only the selected bounded window was read.'],
        signals: [
          {
            id: 'log:event-1',
            at: '2026-11-24T10:00:00Z',
            type: 'error',
            revision,
            summary: 'A redacted error marker was observed.',
            body: 'must not be retained',
          },
        ],
      }),
      traces: async () => ({ complete: true, gaps: [], signals: [] }),
    },
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.collections.map((item) => item.provider), ['logs', 'traces']);
  assert.doesNotMatch(JSON.stringify(result), /must not be retained/);
});

test('provider failures and missing providers remain explicit gaps', async () => {
  const failed = await collectOperationalEvidence({
    scope,
    collectors: { sentry: async () => { throw new Error('read access unavailable'); } },
  });
  assert.match(failed.collections[0].gaps[0], /read access unavailable/);
  assert.equal(failed.complete, false);
  const missing = await collectOperationalEvidence({ scope });
  assert.equal(missing.collections[0].provider, 'none');
  assert.match(missing.collections[0].gaps[0], /No operational evidence provider/);
});

test('rejects signals not bound to the selected revision', async () => {
  const result = await collectOperationalEvidence({
    scope,
    collectors: {
      logs: async () => ({
        complete: true,
        gaps: [],
        signals: [{ id: 'log:1', at: '2026-11-24T10:00:00Z', revision: 'b'.repeat(40), summary: 'wrong release' }],
      }),
    },
  });
  assert.equal(result.complete, false);
  assert.match(result.collections[0].gaps[0], /Invalid logs evidence signal/);
});
