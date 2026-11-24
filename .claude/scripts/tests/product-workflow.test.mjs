import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile('.claude/workflows/investigate-product.js', 'utf8');
const body = source.replace('export const meta', 'const meta');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'args',
  'agent',
  'phase',
  body,
);
test('investigation normal entry point calls source, SRE and independent reviewers without writes', async () => {
  const calls = [];
  const result = await execute(
    { companyId: 'example-co', appIds: ['portal'] },
    async (prompt, options) => {
      calls.push(options);
      return { summary: 'No telemetry supplied', claims: [], gaps: ['No telemetry supplied'] };
    },
    () => {},
  );
  assert.deepEqual(
    calls.map((c) => c.agentType),
    ['product-investigator', 'product-investigator', 'refuter'],
  );
  assert.equal(result.findings, 0);
  assert.equal(result.review.gaps[0], 'No telemetry supplied');
});
test('missing application context or unavailable analysis prevents continuation', async () => {
  await assert.rejects(
    execute(
      {},
      () => {},
      () => {},
    ),
  );
  let calls = 0;
  const result = await execute(
    { companyId: 'example-co', appIds: ['portal'] },
    async () => {
      calls++;
      return null;
    },
    () => {},
  );
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
});
test('returns one independently reviewed finding-to-source mapping and rejects ambiguity', async () => {
  const findingId = 'fnd_01J7Q3V8K2M4N6P8R0S2T4V6X9';
  const mapping = {
    findingId,
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
        detail: 'Exact configuration source.',
      },
    ],
  };
  let responseMappings = [mapping];
  const result = await execute(
    { companyId: 'example-co', appIds: ['portal'], envIds: ['qa'], findingId },
    async () => ({ summary: 'mapped', claims: [], gaps: [], mappings: responseMappings }),
    () => {},
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.mapping, mapping);

  responseMappings = [mapping, { ...mapping, repoId: 'portal-ui', evidence: [{ ...mapping.evidence[0], path: 'applications/portal/repos/portal-ui/config/security.json' }] }];
  const ambiguous = await execute(
    { companyId: 'example-co', appIds: ['portal'], envIds: ['qa'], findingId },
    async () => ({ summary: 'ambiguous', claims: [], gaps: [], mappings: responseMappings }),
    () => {},
  );
  assert.equal(ambiguous.complete, false);
  assert.match(ambiguous.gaps.at(-1), /uniquely supported/);
});

test('unsupported model conclusions and out-of-scope citations stop the workflow', async () => {
  for (const evidence of [
    [],
    [{ path: 'applications/other/server.js', revision: 'a'.repeat(40), detail: 'line 1' }],
  ]) {
    let calls = 0;
    const result = await execute(
      { companyId: 'example-co', appIds: ['portal'] },
      async () => {
        calls++;
        return {
          summary: 'claim',
          gaps: [],
          claims: [{ statement: 'Root cause', status: 'supported', evidence }],
        };
      },
      () => {},
    );
    assert.equal(calls, 1);
    assert.equal(result.complete, false);
  }
});
