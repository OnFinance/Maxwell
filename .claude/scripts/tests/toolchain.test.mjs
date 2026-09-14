import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  TOOLCHAIN_DIR, cacheRoot, checkVersion, ensureArtifact, getTool, hostPlatform, imageRef, loadToolchain, sha256File, WORKSPACE,
} from '../lib/toolchain.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const withDir = async (fn) => { const d = mkdtempSync(join(tmpdir(), 'maxwell-toolchain-')); try { return await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };
const fakeFetch = (buf) => { const fn = async () => { fn.calls += 1; return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }; }; fn.calls = 0; return fn; };
const script = (version) => Buffer.from(`#!/bin/sh\necho "faketool ${version}"\n`);

test('the committed manifest pins every tool exactly and every Python lock matches its hash', () => {
  const m = loadToolchain();
  const names = new Set();
  for (const t of m.tools) {
    assert.ok(!names.has(t.name), `duplicate ${t.name}`); names.add(t.name);
    assert.equal(t.versionCheck.expect, t.version, t.name);
    assert.ok(t.artifacts || t.image || t.python, `${t.name} has no install source`);
    for (const a of Object.values(t.artifacts || {})) assert.match(a.sha256, /^[a-f0-9]{64}$/);
    if (t.image) assert.match(t.image.digest, /^sha256:[a-f0-9]{64}$/);
    if (t.python) assert.equal(sha256File(join(TOOLCHAIN_DIR, t.python.lock)), t.python.lockSha256, t.python.lock);
  }
  for (const n of ['gitleaks', 'trivy', 'semgrep', 'checkov', 'uv', 'jq', 'kubectl', 'aws']) assert.ok(names.has(n), n);
  // Every scanner an agent may run must be reachable through a container or a verified host install.
  for (const t of m.tools.filter((x) => x.category === 'scanner')) assert.ok(t.image || (t.artifacts && t.artifacts['linux-amd64']) || t.python, t.name);
});

test('platform names, cache location and image references', () => {
  assert.equal(hostPlatform('linux', 'x64'), 'linux-amd64');
  assert.equal(hostPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(hostPlatform('win32', 'x64'), null);
  assert.throws(() => cacheRoot({ MAXWELL_TOOLCHAIN_CACHE: join(WORKSPACE, 'kpis', 'cache') }), { code: 'cache-in-workspace' });
  assert.equal(imageRef({ ref: 'docker.io/aquasec/trivy:0.74.0', digest: `sha256:${'a'.repeat(64)}` }), `docker.io/aquasec/trivy:0.74.0@sha256:${'a'.repeat(64)}`);
  assert.throws(() => getTool({ tools: [] }, 'tfsec'), { code: 'not-pinned' });
});

test('a bare binary is verified, cached and re-used; a tampered cache is replaced', () => withDir(async (root) => {
  const body = script('1.2.3');
  const tool = { name: 'faketool', version: '1.2.3', versionCheck: { args: [], expect: '1.2.3' }, artifacts: { 'linux-amd64': { url: 'https://example.com/faketool', sha256: sha(body), sha256Source: 'computed-at-pin', archive: 'none' } } };
  const fetchImpl = fakeFetch(body);
  const bin = await ensureArtifact(tool, { platform: 'linux-amd64', root, fetchImpl });
  assert.equal(readFileSync(bin, 'utf8'), body.toString());
  await ensureArtifact(tool, { platform: 'linux-amd64', root, fetchImpl });
  assert.equal(fetchImpl.calls, 1, 'second call uses the verified cache');
  writeFileSync(bin, '#!/bin/sh\necho pwned\n');
  await ensureArtifact(tool, { platform: 'linux-amd64', root, fetchImpl });
  assert.equal(fetchImpl.calls, 2, 'a modified binary is downloaded again');
  assert.equal(readFileSync(bin, 'utf8'), body.toString());
  assert.equal(checkVersion(tool, bin), 'faketool 1.2.3');
  assert.throws(() => checkVersion({ ...tool, versionCheck: { args: [], expect: '9.9.9' } }, bin), { code: 'version-mismatch' });
}));

test('a checksum mismatch installs nothing', () => withDir(async (root) => {
  const tool = { name: 'faketool', version: '1.2.3', versionCheck: { args: [], expect: '1.2.3' }, artifacts: { 'linux-amd64': { url: 'https://example.com/faketool', sha256: 'f'.repeat(64), sha256Source: 'upstream-checksums', archive: 'none' } } };
  await assert.rejects(ensureArtifact(tool, { platform: 'linux-amd64', root, fetchImpl: fakeFetch(script('1.2.3')) }), { code: 'checksum-mismatch' });
  assert.equal(existsSync(join(root, 'faketool', '1.2.3', 'linux-amd64', 'faketool')), false);
  await assert.rejects(ensureArtifact(tool, { platform: 'darwin-arm64', root, fetchImpl: fakeFetch(script('1.2.3')) }), { code: 'no-artifact' });
}));

test('the binary named in a tar.gz is unpacked', () => withDir(async (root) => {
  const src = join(root, 'src'); mkdirSync(join(src, 'bin'), { recursive: true });
  writeFileSync(join(src, 'bin', 'faketool'), script('2.0.0'));
  writeFileSync(join(src, 'README'), 'not the binary');
  const archive = join(root, 'a.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', src, 'bin/faketool', 'README']).status, 0);
  const body = readFileSync(archive);
  const tool = { name: 'faketool', version: '2.0.0', versionCheck: { args: [], expect: '2.0.0' }, artifacts: { 'linux-amd64': { url: 'https://example.com/a.tar.gz', sha256: sha(body), sha256Source: 'upstream-checksums', archive: 'tar.gz', binaryPath: 'bin/faketool' } } };
  const bin = await ensureArtifact(tool, { platform: 'linux-amd64', root: join(root, 'cache'), fetchImpl: fakeFetch(body) });
  assert.equal(checkVersion(tool, bin), 'faketool 2.0.0');
}));
