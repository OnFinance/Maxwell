import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI prepares committed input, records provenance and replays without another revision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'product-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
  git('init');
  await writeFile(join(root, 'settings.json'), '{"tls":{"verify":false}}');
  git('add', 'settings.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  // Uncommitted edits cannot alter the source evidence read from the selected commit.
  await writeFile(join(root, 'settings.json'), '{"tls":{"verify":true}}');
  const script = fileURLToPath(new URL('../product-lifecycle/run.mjs', import.meta.url));
  const args = [script, '--operation', 'prepare', '--checkout', root, '--company', 'example-co',
    '--app', 'portal', '--env', 'test', '--revision', revision, '--file', 'settings.json',
    '--field', 'tls.verify', '--expected', 'true', '--request-id', 'request-12345',
    '--state-session', 'ses_productcli123'];
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, args, { env, cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const run = JSON.parse(result.stdout);
    assert.equal(run.revision, 1);
    assert.equal(run.value.plan.before, false);
    assert.equal(run.value.verification.baseRevision, revision);
  }
});
