import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeTranscript, parseOpencodeExport } from '../lib/transcript.mjs';
import { resolveModel, costUsd } from '../lib/pricing.mjs';

// Shapes copied from a real Claude Code 2.1.270 transcript (fields trimmed).
const assistant = (requestId, out, extra = {}) => JSON.stringify({
  type: 'assistant', requestId, uuid: `u-${requestId}-${out}`, timestamp: '2026-09-13T17:49:22.059Z', isSidechain: false, version: '2.1.270',
  message: { id: `msg_${requestId}`, model: 'claude-fable-5-1', role: 'assistant', usage: {
    input_tokens: 2, cache_creation_input_tokens: 10768, cache_read_input_tokens: 30516, output_tokens: out,
    output_tokens_details: { thinking_tokens: 133 }, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    cache_creation: { ephemeral_1h_input_tokens: 10768, ephemeral_5m_input_tokens: 0 },
  }, content: extra.content || [{ type: 'text', text: 'hi' }] },
});
const pricing = { asOf: '2026-09-13', models: [{ model: 'claude-fable-5-1', aliases: ['fable', 'claude-fable-5-1[1m]'], inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 0.25, webSearchPerKRequests: 10 }] };

test('claude transcript dedups streamed records per requestId keeping the largest', () => {
  const lines = [
    assistant('req1', 50), assistant('req1', 289, { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'company-profile/x/details.json' } }] }),
    assistant('req2', 10),
    JSON.stringify({ type: 'cost-state', totalCostUSD: 1.23, totalLinesAdded: 4, totalLinesRemoved: 1, totalAPIDuration: 900 }),
    JSON.stringify({ type: 'user', toolDenialKind: 'permission_denied', message: { content: [{ type: 'tool_result', tool_use_id: 't9' }] } }),
  ];
  const s = parseClaudeTranscript(lines);
  assert.equal(s.duplicatesDropped, 1);
  assert.equal(s.turns, 2);
  const m = s.models.get('claude-fable-5-1');
  assert.equal(m.tokens.output, 299);
  assert.equal(m.tokens.cacheWrite1h, 21536);
  assert.equal(m.tokens.cacheWrite5m, 0);
  assert.equal(m.tokens.thinking, 266);
  assert.equal(m.webSearchRequests, 2);
  assert.equal(s.toolCalls.byTool.Write, 1);
  assert.deepEqual([...s.filesWritten], ['company-profile/x/details.json']);
  assert.equal(s.reportedCostUsd, 1.23);
  assert.equal(s.linesAdded, 4);
  assert.equal(s.permissionDenials.length, 1);
  assert.equal(s.formatVersion, '2.1.270');
});

test('cost uses the five price buckets including the 1h cache write rate', () => {
  const price = resolveModel(pricing, 'claude-fable-5-1[1m]');
  const usd = costUsd(price, { input: 1e6, output: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 }, 1000);
  assert.equal(usd, 10 + 50 + 12.5 + 20 + 0.25 + 10);
  assert.equal(resolveModel(pricing, 'anthropic/claude-fable-5-1').model, 'claude-fable-5-1');
  assert.equal(resolveModel(pricing, 'gpt-5'), null);
});

test('opencode export walker finds assistant tokens, tool parts and ignores stored cost for computation', () => {
  const doc = { info: { id: 'ses_abc', version: '1.18.30' }, messages: [
    { info: { id: 'm1', role: 'user', time: { created: 1789317442027 } }, parts: [{ type: 'text', text: 'hello' }] },
    { info: { id: 'm2', role: 'assistant', model: { providerID: 'anthropic', id: 'claude-opus-5' }, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 400, write: 50 } }, cost: 0, time: { created: 1789317442027, completed: 1789317452027 } },
      parts: [{ type: 'tool', tool: 'write', state: { status: 'completed', input: { filePath: 'kpis/metrics.json' } } }, { type: 'text', text: 'done' }] },
  ] };
  const s = parseOpencodeExport(doc);
  const m = s.models.get('anthropic/claude-opus-5');
  assert.equal(m.tokens.input, 100);
  assert.equal(m.tokens.cacheRead, 400);
  assert.equal(m.tokens.cacheWrite5m, 50);
  assert.equal(m.tokens.thinking, 5);
  assert.equal(s.toolCalls.byTool.write, 1);
  assert.deepEqual([...s.filesWritten], ['kpis/metrics.json']);
  assert.equal(s.reportedCostUsd, 0);
  assert.equal(s.startedAt, '2026-09-13T16:37:22Z');
});
