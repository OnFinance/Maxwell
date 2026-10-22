import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPricing, resolveModel, canonicalModelId, providerOf, costUsd, modelNameCandidates } from '../lib/pricing.mjs';

const pricing = loadPricing();
const resolved = (raw) => (resolveModel(pricing, raw) || {}).model || null;

test('first-party ids, aliases and the [1m] suffix resolve as before', () => {
  assert.equal(resolved('claude-opus-5'), 'claude-opus-5');
  assert.equal(resolved('opus'), 'claude-opus-5');
  assert.equal(resolved('claude-fable-5-1[1m]'), 'claude-fable-5-1');
  assert.equal(resolved('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(resolved('cloudflare-workers-ai/@cf/zai-org/glm-5.3'), 'glm-5.3');
  assert.equal(resolved('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
});

test('Vertex AI model ids resolve: bare ids and @version snapshots', () => {
  assert.equal(resolved('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolved('claude-haiku-4-5@20251001'), 'claude-haiku-4-5-20251001');
  assert.equal(resolved('claude-opus-5@20260101'), 'claude-opus-5');
  assert.equal(resolved('vertex_ai/claude-sonnet-5-5'), 'claude-sonnet-5-5');
});

test('Bedrock and gateway model ids resolve: region and anthropic. prefixes, -v1:0 suffix, provider prefixes', () => {
  assert.equal(resolved('anthropic.claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolved('us.anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
  assert.equal(resolved('apac.anthropic.claude-sonnet-5-5-v1:0'), 'claude-sonnet-5-5');
  assert.equal(resolved('global.anthropic.claude-opus-5'), 'claude-opus-5');
  assert.equal(resolved('eu.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5-20251001');
  assert.equal(resolved('bedrock/us.anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
  assert.equal(resolved('arn:aws:bedrock:ap-south-1:123456789012:inference-profile/apac.anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
});

test('a trailing snapshot date is dropped only as a last resort', () => {
  assert.equal(resolved('claude-opus-5-5-20261001'), 'claude-opus-5-5');
  assert.deepEqual(modelNameCandidates('us.anthropic.claude-opus-5-5-20261001-v1:0').slice(-2), ['claude-opus-5-5-20261001', 'claude-opus-5-5']);
});

test('normalising never crosses model families or versions', () => {
  assert.notEqual(resolved('claude-opus-5-5'), 'claude-opus-5');
  assert.equal(resolved('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolved('claude-sonnet-4-5@20250929'), null);
  assert.equal(resolved('us.anthropic.claude-sonnet-4-v1:0'), null);
  assert.equal(resolved('claude-opus-5-1'), null);
  assert.equal(resolved('gpt-5'), null);
  assert.equal(resolved('openai/gpt-5@2026'), null);
  assert.equal(resolved(''), null);
  assert.deepEqual(modelNameCandidates('acme/some-model-v2'), ['acme/some-model-v2', 'some-model-v2']);
  assert.equal(resolved(undefined), null);
});

test('a session on claude-opus-5-5 through Vertex gets a non-zero cost and a canonical id', () => {
  const price = resolveModel(pricing, 'claude-opus-5-5');
  const usd = costUsd(price, { input: 142, output: 47947, cacheWrite5m: 905359, cacheWrite1h: 0, cacheRead: 5434477 });
  assert.ok(usd > 0);
  assert.equal(usd, Math.round((142 * 4 + 47947 * 20 + 905359 * 5 + 5434477 * 0.2) / 1e6 * 1e6) / 1e6);
  assert.equal(canonicalModelId(pricing, 'us.anthropic.claude-opus-5-5-v1:0'), 'claude-opus-5-5');
  assert.equal(providerOf(pricing, 'us.anthropic.claude-opus-5-5-v1:0'), 'anthropic');
});
