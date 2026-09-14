import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// soc record ids embed the instrument id in a regex alternation that JSON Schema cannot derive from the vocab, so it
// drifts when an instrument is added (rbi-outsourcing-risk-directions-2025 was missing, 2026-09-14).
test('the qualifiedControlId instrument alternation equals vocab/instruments', () => {
  const vocab = JSON.parse(readFileSync('.claude/schemas/vocab/instruments.schema.json', 'utf8')).enum;
  const pattern = JSON.parse(readFileSync('.claude/schemas/v1/soc/record.schema.json', 'utf8')).$defs.qualifiedControlId.pattern;
  const alternation = /^\^\(([^)]+)\):/.exec(pattern)[1].split('|').map((s) => s.replace(/\\\./g, '.'));
  assert.ok(Array.isArray(vocab) && vocab.length > 0, 'vocab/instruments has an enum');
  assert.deepEqual([...alternation].sort(), [...vocab].sort());
});
