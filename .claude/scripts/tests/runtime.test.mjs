import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFreeze, credentialMaterial, environmentBlockers, grepStage, headStage, inWindows, rateLimit, resolveLocator } from '../lib/sandbox/runtime.mjs';
import { redactSecrets } from '../lib/sandbox/redact.mjs';

const at = (s) => new Date(s);

test('allowed windows: same-day, whole-day and past-midnight windows', () => {
  const weekdays = [{ daysOfWeek: ['mon', 'tue', 'wed', 'thu', 'fri'], startUtc: '16:30', endUtc: '23:30' }];
  assert.equal(inWindows(weekdays, at('2026-09-14T17:00:00Z')), true);
  assert.equal(inWindows(weekdays, at('2026-09-14T15:00:00Z')), false);
  assert.equal(inWindows(weekdays, at('2026-09-13T17:00:00Z')), false, 'Sunday');
  assert.equal(inWindows([{ daysOfWeek: ['fri'], startUtc: '22:00', endUtc: '02:00' }], at('2026-09-19T01:30:00Z')), true, 'early Saturday inside a Friday window');
  assert.equal(inWindows([{ daysOfWeek: ['sat'], startUtc: '00:00', endUtc: '00:00' }], at('2026-09-19T12:00:00Z')), true);
  assert.equal(inWindows(undefined, at('2026-09-19T12:00:00Z')), true);
});

test('environment blockers list every failed check', () => {
  const env = { tier: 'prod', probeAccess: { method: 'kubeconfig', readOnly: true, allowedWindows: [{ daysOfWeek: ['mon'], startUtc: '10:00', endUtc: '11:00' }] }, changeFreeze: [{ from: '2026-09-14T00:00:00Z', to: '2026-09-15T00:00:00Z', reason: 'quarter close' }] };
  const blockers = environmentBlockers(env, at('2026-09-14T17:00:00Z'));
  assert.equal(blockers.length, 3);
  assert.match(blockers.join('\n'), /change freeze/);
  assert.match(blockers.join('\n'), /allowedWindows/);
  assert.match(blockers.join('\n'), /credentialKey/);
  assert.deepEqual(environmentBlockers({ probeAccess: { method: 'http-only', readOnly: true } }, at('2026-09-14T17:00:00Z')), []);
  assert.match(environmentBlockers({ probeAccess: { method: 'none', readOnly: true } }, at('2026-09-14T17:00:00Z'))[0], /none/);
  assert.equal(activeFreeze([{ from: '2026-09-14T00:00:00Z', to: '2026-09-15T00:00:00Z', reason: 'x' }], at('2026-09-15T00:00:00Z')), null, 'freeze end is exclusive');
});

test('rate limit: rolling minute, prod capped at 60', () => {
  const now = 1_000_000;
  const full = Array.from({ length: 30 }, (_, i) => now - 1000 * i);
  assert.equal(rateLimit(full, { limit: 30, tier: 'qa', at: now }).ok, false);
  assert.equal(rateLimit(full, { limit: 30, tier: 'qa', at: now + 60000 }).ok, true);
  assert.equal(rateLimit([], { limit: 500, tier: 'prod', at: now }).cap, 60);
});

test('credential locators: read-only, scoped to the environment, env or file providers only', () => {
  const entry = { key: 'prod-kubeconfig-ro', provider: 'env', ref: 'PROD_RO_KUBECONFIG', scope: 'read-only', envIds: ['prod'] };
  assert.equal(resolveLocator(entry, { envId: 'prod', workspace: '/w', env: { PROD_RO_KUBECONFIG: '/secure/kubeconfig' } }), '/secure/kubeconfig');
  assert.throws(() => resolveLocator(entry, { envId: 'qa', workspace: '/w', env: { PROD_RO_KUBECONFIG: '/k' } }), /not granted/);
  assert.throws(() => resolveLocator({ ...entry, scope: 'read-write' }, { envId: 'prod', workspace: '/w', env: {} }), /read-only/);
  assert.throws(() => resolveLocator(entry, { envId: 'prod', workspace: '/w', env: {} }), /not set/);
  assert.throws(() => resolveLocator({ ...entry, provider: 'file', ref: '/w/kpis/kubeconfig' }, { envId: 'prod', workspace: '/w' }), /outside the workspace/);
  assert.throws(() => resolveLocator({ ...entry, provider: 'vault', ref: 'kv/x' }, { envId: 'prod', workspace: '/w' }), /secret manager/);
});

test('credential material: files in containers, paths on the host, never a raw docker socket', () => {
  const readFile = () => 'apiVersion: v1';
  assert.deepEqual(credentialMaterial({ method: 'kubeconfig', value: '/secure/k', executor: 'docker', readFile }), { env: { KUBECONFIG: '/run/maxwell/kubeconfig' }, files: { kubeconfig: 'apiVersion: v1' } });
  assert.deepEqual(credentialMaterial({ method: 'kubeconfig', value: '/secure/k', executor: 'host', readFile }), { env: { KUBECONFIG: '/secure/k' }, files: {} });
  assert.throws(() => credentialMaterial({ method: 'docker-socket', value: 'unix:///var/run/docker.sock', executor: 'host' }), /socket proxy/);
  assert.throws(() => credentialMaterial({ method: 'docker-socket', value: 'tcp://10.0.0.5:2375', executor: 'host' }), /socket proxy/);
  assert.deepEqual(credentialMaterial({ method: 'docker-socket', value: 'tcp://proxy.internal:2385', executor: 'docker' }), { env: { DOCKER_HOST: 'tcp://proxy.internal:2385' }, files: {} });
  assert.throws(() => credentialMaterial({ method: 'cloud-api', binary: 'az', value: '/secure/az', executor: 'kubernetes' }), /host executor/);
  assert.equal(credentialMaterial({ method: 'cloud-api', binary: 'aws', value: '/secure/aws', executor: 'kubernetes', readFile }).env.AWS_SHARED_CREDENTIALS_FILE, '/run/maxwell/aws-credentials');
});

test('pipe stages run without a shell and output is redacted', () => {
  assert.equal(grepStage(['grep', '-i', 'error'], 'ok\nERROR one\nfine\nerror two\n'), 'ERROR one\nerror two\n');
  assert.equal(grepStage(['grep', '-c', '-v', 'x'], 'x\ny\nz\n'), '2\n');
  assert.equal(grepStage(['grep', '-F', 'a.b'], 'aXb\na.b\n'), 'a.b\n');
  assert.equal(headStage(['head', '-c', '5'], 'abcdefgh'), 'abcde');
  const r = redactSecrets('{"password": "hunter2hunter2", "user": "x"} token eyJhbGciOiJIUzI1NiJ9abcdefghij.eyJzdWIiOiIxMjM0NTY3ODkwIn0abc.SflKxwRJSMeKKF2QT4fwpM');
  assert.equal(r.count, 2);
  assert.ok(!r.text.includes('hunter2'));
  assert.ok(r.text.includes('"password": "[REDACTED]"'));
});
