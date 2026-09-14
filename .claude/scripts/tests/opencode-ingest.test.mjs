import test from 'node:test';
import assert from 'node:assert/strict';
import { relative, isAbsolute } from 'node:path';
import { loadPricing, providerOf } from '../lib/pricing.mjs';
import { opencodeSessionLog } from '../lib/workflow-status.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

test('session summaries name a gen_ai provider the schema accepts', () => {
  const pricing = loadPricing();
  assert.equal(providerOf(pricing, 'claude-opus-5[1m]'), 'anthropic');
  assert.equal(providerOf(pricing, 'anthropic/claude-sonnet-5'), 'anthropic');
  assert.equal(providerOf(pricing, 'cloudflare-workers-ai/@cf/zai-org/glm-5.3'), 'other', 'priced GLM keeps its pricing provider');
  assert.equal(providerOf(pricing, 'openai/gpt-unpriced-test'), 'openai', 'a well-known OpenCode provider prefix is kept');
  assert.equal(providerOf(pricing, 'some-new-host/model-x'), 'other', 'an unknown provider prefix becomes other');
});

test('the OpenCode session log lives outside the workspace', () => {
  const rel = relative(WORKSPACE, opencodeSessionLog({ HOME: '/home/someone' }));
  assert.ok(rel.startsWith('..') || isAbsolute(rel));
  assert.equal(opencodeSessionLog({ MAXWELL_OPENCODE_SESSION_LOG: '/var/tmp/sessions.log' }), '/var/tmp/sessions.log');
});
