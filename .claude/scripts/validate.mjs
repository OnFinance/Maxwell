#!/usr/bin/env node
// Runs every validation stage in order and reports a single verdict. Exit 2 if any stage fails.
import { spawnSync } from 'node:child_process';

const stages = ['validate:schemas', 'validate:layout', 'validate:data', 'validate:frontmatter', 'validate:workflows', 'validate:mirror'];
const failed = [];
for (const stage of stages) {
  const res = spawnSync('npm', ['run', '--silent', stage], { stdio: 'inherit', env: process.env });
  if (res.status !== 0) failed.push(stage);
}
if (failed.length) {
  console.error(`\nvalidate FAILED: ${failed.join(', ')}`);
  process.exit(2);
}
console.log('\nvalidate OK: all stages passed');
