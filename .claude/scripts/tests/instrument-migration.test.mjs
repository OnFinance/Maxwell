import test from 'node:test';
import assert from 'node:assert/strict';
import { planMigration } from '../lib/instrument-migration.mjs';

const OLD = 'rbi-it-outsourcing-md-2023';
const NEW = 'rbi-outsourcing-risk-directions-2025';
const NOW = '2026-09-14T15:00:00Z';
const provenance = { harness: 'script', generatedAt: NOW, workflow: 'manual', agent: 'soc/migrate-instrument' };

const registry = { instruments: [
  { instrumentId: OLD, regulator: 'RBI', status: 'repealed', repealedOn: '2025-11-28', supersededBy: [NEW] },
  { instrumentId: NEW, regulator: 'RBI', status: 'in-force' },
  { instrumentId: 'sebi-cscrf-2024', regulator: 'SEBI' },
] };
const catalog = { instrumentId: NEW, groups: [{ id: 'g1', title: 'Agreements', controls: [
  { id: '79', title: 'Audit rights', category: 'Contract', cadence: 'annual', applicability: { entityTypes: ['nbfc'] }, mappings: [{ regulator: 'RBI', instrument: OLD, controlId: '19(e)' }, { regulator: 'ISO', instrument: 'iso-27001-2022', controlId: 'A.5.20' }] },
  { id: '84', title: 'Exit plan', cadence: 'event-driven', applicability: { entityTypes: ['nbfc'], reCategories: ['nbfc-middle-layer'] }, mappings: [{ regulator: 'RBI', instrument: OLD, controlId: '22(a)' }] },
  { id: 'UCB-1', title: 'UCB only', cadence: 'annual', applicability: { entityTypes: ['urban-cooperative-bank'] }, mappings: [{ regulator: 'RBI', instrument: OLD, controlId: '22(a)' }] },
] }] };
const details = {
  companyId: 'acme', entityTypes: ['stock-broker', 'nbfc'], regulatoryRegistrations: [{ regulator: 'RBI', category: 'nbfc-middle-layer' }],
  frameworksInScope: ['sebi-cscrf-2024', OLD, 'dpdp-rules-2025'], provenance: { harness: 'human', generatedAt: '2026-09-14T00:00:00Z' },
};
const control = (instrument, controlId, extra = {}) => ({
  schemaVersion: '1', kind: 'control', id: `${instrument}:${controlId}`, companyId: 'acme', frameworkRefs: [{ regulator: instrument.startsWith('sebi') ? 'SEBI' : 'RBI', instrument, controlId }],
  title: controlId, implementationStatus: 'unknown', effectiveness: 'not-tested', nextDueAt: '2026-12-14T09:55:06Z', recordedAt: '2026-09-14T09:55:06Z', provenance, ...extra,
});
const finding = (id, status, firstSeenAt, refs, controlIds) => ({
  schemaVersion: '1', kind: 'finding', id, companyId: 'acme', title: id, description: 'gap', status, firstSeenAt, recordedAt: firstSeenAt,
  regulatoryRefs: refs, controlIds, slaBasis: { instrument: 'sebi-cscrf-2024', days: 30 }, provenance,
});
const sebi = { regulator: 'SEBI', instrument: 'sebi-cscrf-2024', controlId: 'GV.SC.S3' };
const ledger = [
  control(OLD, '19(e)'),
  control(OLD, '16', { notes: 'seeded' }),
  control('sebi-cscrf-2024', 'GV.SC.S3', { frameworkRefs: [sebi, { regulator: 'RBI', instrument: OLD, controlId: '22(a)' }] }),
  finding('fnd_OPEN', 'open', '2026-09-14T10:46:39Z', [sebi, { regulator: 'RBI', instrument: OLD, controlId: '22(a)' }, { regulator: 'RBI', instrument: OLD, controlId: '16' }], ['sebi-cscrf-2024:GV.SC.S3', `${OLD}:22(a)`]),
  finding('fnd_OLD', 'triaged', '2025-06-01T00:00:00Z', [sebi, { regulator: 'RBI', instrument: OLD, controlId: '19(e)' }], [`${OLD}:19(e)`]),
  finding('fnd_DONE', 'resolved', '2026-09-14T10:46:39Z', [sebi, { regulator: 'RBI', instrument: OLD, controlId: '19(e)' }], []),
];
const plan = (overrides = {}) => planMigration({ companyId: 'acme', details, registry, catalog, ledger, from: OLD, to: NEW, now: NOW, provenance, catalogPath: 'catalog.json', registryPath: 'instruments.json', ...overrides });
const byId = (records, id) => records.filter((r) => r.id === id);

test('the profile lists the successor in place of the repealed instrument', () => {
  const p = plan();
  assert.equal(p.detailsChanged, true);
  assert.deepEqual(p.details.frameworksInScope, ['sebi-cscrf-2024', NEW, 'dpdp-rules-2025']);
  assert.deepEqual(p.details.provenance, provenance);
});

test('applicable successor controls are added with catalog mappings and cadence-based due dates', () => {
  const { records, summary } = plan();
  assert.equal(summary.added, 2);
  const [c79] = byId(records, `${NEW}:79`);
  assert.deepEqual(c79.frameworkRefs.map((r) => `${r.instrument}:${r.controlId}`), [`${NEW}:79`, `${OLD}:19(e)`, 'iso-27001-2022:A.5.20']);
  assert.deepEqual([c79.implementationStatus, c79.effectiveness, c79.nextDueAt, c79.category], ['unknown', 'not-tested', '2027-09-14T15:00:00Z', 'Contract']);
  assert.match(c79.notes, /Successor of rbi-it-outsourcing-md-2023:19\(e\)/);
  assert.equal(byId(records, `${NEW}:84`)[0].nextDueAt, '2026-12-14T15:00:00Z');
  assert.equal(byId(records, `${NEW}:84`)[0].category, 'Agreements');
  assert.equal(byId(records, `${NEW}:UCB-1`).length, 0);
});

test('controls of the repealed instrument become not-applicable and name their successors', () => {
  const { records, summary } = plan();
  const [r19] = byId(records, `${OLD}:19(e)`);
  assert.deepEqual([r19.implementationStatus, r19.supersedes, 'nextDueAt' in r19], ['not-applicable', `${OLD}:19(e)`, false]);
  assert.match(r19.notes, new RegExp(`Successor controls: ${NEW}:79`));
  assert.ok(r19.evidence.some((e) => e.ref === 'instruments.json'));
  const [r16] = byId(records, `${OLD}:16`);
  assert.match(r16.notes, /^seeded\nNot applicable from 2025-11-28/);
  assert.deepEqual(summary.retiredWithoutSuccessor, [`${OLD}:16`]);
  assert.equal(byId(records, 'sebi-cscrf-2024:GV.SC.S3').length, 0, 'a catalog mapping to the old instrument is left alone');
});

test('open findings cite successors; the old ref stays only on records first seen before the repeal', () => {
  const { records } = plan();
  const [open] = byId(records, 'fnd_OPEN');
  assert.deepEqual(open.regulatoryRefs.map((r) => `${r.instrument}:${r.controlId}`), ['sebi-cscrf-2024:GV.SC.S3', `${NEW}:84`]);
  assert.deepEqual(open.controlIds, ['sebi-cscrf-2024:GV.SC.S3', `${NEW}:84`]);
  assert.match(open.description, /^gap\nRe-mapped on 2026-09-14 .*22\(a\) -> 84; 16 -> no applicable successor/);
  const [historical] = byId(records, 'fnd_OLD');
  assert.deepEqual(historical.regulatoryRefs.map((r) => `${r.instrument}:${r.controlId}`), ['sebi-cscrf-2024:GV.SC.S3', `${NEW}:79`, `${OLD}:19(e)`]);
  assert.deepEqual(historical.controlIds, [`${NEW}:79`, `${OLD}:19(e)`]);
  assert.equal(byId(records, 'fnd_DONE').length, 0, 'resolved findings are history');
});

test('a second run over the migrated ledger changes nothing', () => {
  const first = plan();
  const again = plan({ ledger: [...ledger, ...first.records], details: first.details });
  assert.equal(again.records.length, 0);
  assert.equal(again.detailsChanged, false);
});

test('only a repealed instrument can be migrated, and only to a registered successor', () => {
  assert.throws(() => plan({ from: 'sebi-cscrf-2024' }), /not repealed or superseded/);
  assert.throws(() => plan({ to: 'sebi-cscrf-2024' }), /not listed in the supersededBy/);
  assert.throws(() => plan({ catalog: { ...catalog, instrumentId: 'other' } }), /not the rbi-outsourcing-risk-directions-2025 catalog/);
});
