import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponsePolicy } from '../incident-response/policy.mjs';

const device = { companyId: 'example-co', tenantId: '11111111-2222-3333-4444-555555555555', machineId: 'a'.repeat(40) };
const entry = { ...device, action: 'isolate' };
const startsAt = '2026-11-04T00:00:00.000Z';
const endsAt = '2026-11-04T00:10:00.000Z';
const config = { protectedDevices: [], windows: [{ ...entry, startsAt, endsAt }] };
const context = { case: { companyId: device.companyId }, action: entry.action, target: device };

test('maintenance windows are exact-scope, start inclusive and end exclusive', async () => {
  let now = Date.parse(startsAt) - 1;
  const policy = createResponsePolicy({ targets: [entry], config, clock: () => now });
  assert.equal(await policy(context), false);
  now++;
  assert.equal((await policy(context)).validUntil, Date.parse(endsAt));
  for (const changed of [{ ...context, action: 'unisolate' }, { ...context, case: { companyId: 'other' } }, { ...context, target: { ...device, machineId: 'b'.repeat(40) } }, { ...context, target: { ...device, tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }]) assert.equal(await policy(changed), false);
  now = Date.parse(endsAt);
  assert.equal(await policy(context), false);
});

test('protected device deny overrides allowlist and windows for isolation and release', async () => {
  for (const action of ['isolate', 'unisolate']) {
    const target = { ...device, action };
    const policy = createResponsePolicy({ targets: [target], config: { protectedDevices: [device], windows: [{ ...target, startsAt, endsAt }] }, clock: () => Date.parse(startsAt) });
    assert.equal(await policy({ ...context, action }), false);
  }
  assert.equal(await createResponsePolicy()(context), false);
  assert.equal(await createResponsePolicy({ targets: [entry] })(context), false);
});

test('policy snapshots cannot be mutated by the caller and changed policy changes its digest', async () => {
  const copy = structuredClone(config);
  const policy = createResponsePolicy({ targets: [entry], config: copy, clock: () => Date.parse(startsAt) });
  const original = await policy(context);
  copy.windows[0].endsAt = '2026-11-04T00:20:00.000Z';
  assert.deepEqual(await policy(context), original);
  const changed = createResponsePolicy({ targets: [entry], config: copy, clock: () => Date.parse(startsAt) });
  assert.notEqual((await changed(context)).fingerprint, original.fingerprint);
});

test('invalid or ambiguous configuration fails closed at startup', () => {
  for (const invalid of [null, {}, { ...config, bypass: true }, { ...config, protectedDevices: [{}] }, { ...config, windows: [{ ...entry, startsAt: '2026-11-04T05:30:00+05:30', endsAt }] }, { ...config, windows: [{ ...entry, startsAt: endsAt, endsAt }] }, { ...config, windows: [{ ...entry, startsAt: '2026-02-30T00:00:00.000Z', endsAt }] }]) assert.throws(() => createResponsePolicy({ targets: [entry], config: invalid }), /invalid/);
  assert.throws(() => createResponsePolicy({ targets: [], config }), /window/);
});
