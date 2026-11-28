import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('package.json declares an ES module package on Node >= 22', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=\s*22/);
});
