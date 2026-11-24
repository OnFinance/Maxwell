import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSentry } from '../product-lifecycle/sentry.mjs';
test('Sentry collector bounds scope and exports only matching revision metadata', async () => {
  const revision = 'a'.repeat(40);
  const event = {
    eventID: 'b'.repeat(32),
    dateCreated: '2026-11-24T00:00:00Z',
    message: 'secret body',
    tags: [
      { key: 'environment', value: 'preview' },
      { key: 'release', value: revision },
    ],
  };
  const result = await collectSentry({
    organization: 'test',
    project: 'portal',
    environment: 'preview',
    revision,
    token: 'fixture',
    fetcher: async (url, options) => {
      assert.equal(url.origin, 'https://sentry.io');
      assert.equal(options.redirect, 'error');
      return new Response(
        JSON.stringify([event, { ...event, tags: [{ key: 'environment', value: 'production' }] }]),
      );
    },
  });
  assert.equal(result.signals.length, 1);
  assert.equal(result.complete, false);
  assert.doesNotMatch(JSON.stringify(result), /secret body/);
  await assert.rejects(collectSentry({ organization: '../other' }));
});
