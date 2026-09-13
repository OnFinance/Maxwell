#!/usr/bin/env node
// Fails (exit 2) when .agents/ is out of sync with .claude/. Fix with `npm run sync:agents`.
import { diffMirror } from './sync-agents-mirror.mjs';

const stale = diffMirror();
if (stale.length) {
  console.error(`validate:mirror FAILED (${stale.length}) — run \`npm run sync:agents\``);
  for (const s of stale) console.error('- ' + s);
  process.exit(2);
}
console.log('validate:mirror OK');
