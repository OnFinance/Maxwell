// The git pre-commit hook run by /bin/bash (bash 3.2 on macOS): which validators it starts, and with which
// arguments, for what is staged. node and npm are stubs that log their arguments, so only the shell is tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';

const HOOK = join(WORKSPACE, '.claude/hooks/git/pre-commit');
const BASH = '/bin/bash';
const skip = existsSync(BASH) ? false : 'no /bin/bash here';

// One line per call: the program, then each argument, tab-separated. A stub exits 1 when FAIL_ON is one of its arguments.
const stub = (name) => `#!/bin/sh
{ printf '%s' '${name}'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$HOOK_LOG"
for a in "$@"; do if [ -n "$FAIL_ON" ] && [ "$a" = "$FAIL_ON" ]; then exit 1; fi; done
exit 0
`;
// The hook may run inside a git hook itself (pre-push runs npm test): GIT_DIR, GIT_INDEX_FILE and the rest must
// not point the throwaway repo's git at this repository.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function world(files) {
  const d = mkdtempSync(join(tmpdir(), 'maxwell-pre-commit-'));
  const bin = join(d, 'bin'); const repo = join(d, 'repo'); const log = join(d, 'calls.log');
  mkdirSync(bin); mkdirSync(repo);
  for (const n of ['node', 'npm']) { writeFileSync(join(bin, n), stub(n)); chmodSync(join(bin, n), 0o755); }
  const git = (...args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanEnv() }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), body); }
  if (Object.keys(files).length) git('add', '--', ...Object.keys(files));
  const run = (env = {}) => {
    const r = spawnSync(BASH, [HOOK], { cwd: repo, encoding: 'utf8', env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, HOOK_LOG: log, ...env } });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
    return { status: r.status, stderr: r.stderr, calls };
  };
  return { run, cleanup: () => rmSync(d, { recursive: true, force: true }) };
}

const LAYOUT = ['node', '.claude/scripts/validate-layout.mjs'];
const MIRROR = ['node', '.claude/scripts/validate-mirror.mjs'];

test('pre-commit, nothing staged: exits 0 and runs no validator', { skip }, () => {
  const w = world({});
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, []);
  } finally { w.cleanup(); }
});

test('pre-commit, no data file staged: no validate-data call (empty array under set -u), layout and mirror still run', { skip }, () => {
  const w = world({ 'run.sh': 'echo hi\n' });
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [LAYOUT, MIRROR]);
  } finally { w.cleanup(); }
});

test('pre-commit, mixed commit: a schema runs validate:schemas, each data file is one argument with its spaces kept', { skip }, () => {
  const w = world({
    ' lead.json': '{}\n', '.claude/schemas/x y.schema.json': '{}\n', 'dir with space/a b.json': '{}\n',
    'plain.jsonl': '{}\n', 'run.sh': 'echo hi\n', 'two  spaces.md': 'x\n',
  });
  try {
    const r = w.run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
      ['npm', 'run', '--silent', 'validate:schemas'],
      ['node', '.claude/scripts/validate-data.mjs', ' lead.json', '.claude/schemas/x y.schema.json', 'dir with space/a b.json', 'plain.jsonl', 'two  spaces.md'],
      LAYOUT, MIRROR,
    ]);
  } finally { w.cleanup(); }
});

test('pre-commit, a failing validator fails the hook and stops it', { skip }, () => {
  const w = world({ 'a.json': '{}\n' });
  try {
    const r = w.run({ FAIL_ON: '.claude/scripts/validate-data.mjs' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.calls, [['node', '.claude/scripts/validate-data.mjs', 'a.json']]);
  } finally { w.cleanup(); }
});
