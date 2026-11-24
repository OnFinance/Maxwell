import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateFindingMapping } from '../product-lifecycle/finding.mjs';

const schema = JSON.parse(await readFile('.claude/schemas/v1/soc/record.schema.json', 'utf8'));
const finding = structuredClone(schema.examples.find((item) => item.kind === 'finding'));
finding.target = { type: 'environment', appId: 'portal', envId: 'qa' };
const candidate = {
  findingId: finding.id,
  appId: 'portal',
  repoId: 'portal-api',
  envId: 'qa',
  path: 'config/security.json',
  revision: 'a'.repeat(40),
  confidence: 'confirmed',
  evidence: [
    {
      path: 'applications/portal/repos/portal-api/config/security.json',
      revision: 'a'.repeat(40),
      detail: 'The selected field configures the endpoint named by the finding.',
    },
  ],
};

test('accepts one independently confirmed revision-bound repository mapping', () => {
  const mapped = validateFindingMapping(finding, candidate);
  assert.deepEqual(mapped.target, {
    type: 'repo',
    appId: 'portal',
    repoId: 'portal-api',
    envId: 'qa',
  });
  assert.deepEqual(mapped.location, { path: 'config/security.json' });
  assert.match(mapped.findingSignature, /^[a-f0-9]{64}$/);
});

test('rejects cross-scope, ambiguous-quality and traversal candidates', () => {
  assert.throws(
    () => validateFindingMapping(finding, { ...candidate, appId: 'other' }),
    /application or environment|supported/,
  );
  assert.throws(
    () => validateFindingMapping(finding, { ...candidate, confidence: 'probable' }),
    /not supported/,
  );
  assert.throws(
    () => validateFindingMapping(finding, { ...candidate, path: '../secret' }),
    /not supported/,
  );
});
