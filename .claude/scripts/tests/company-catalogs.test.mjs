import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { WORKSPACE } from '../lib/toolchain.mjs';
import { companyCatalogArgs, overlayChecker } from '../lib/company-catalogs.mjs';

const NOW = '2026-10-22T00:00:00Z';
const PROV = { harness: 'human', generatedAt: NOW };

// A throwaway workspace with the real schemas, skills (shared catalogs and registry), scripts and KPI registry, and
// two companies copied from example-co's required files: acme (which gets its own catalog) and beta (which does not).
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-cocat-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  for (const d of ['schemas', 'skills', 'scripts', 'hooks']) symlinkSync(join(WORKSPACE, '.claude', d), join(dir, '.claude', d));
  symlinkSync(join(WORKSPACE, 'node_modules'), join(dir, 'node_modules'));
  mkdirSync(join(dir, 'kpis'), { recursive: true });
  copyFileSync(join(WORKSPACE, 'kpis/metrics.json'), join(dir, 'kpis/metrics.json'));
  for (const c of ['acme', 'beta']) {
    const base = join(dir, 'company-profile', c);
    mkdirSync(join(base, 'soc'), { recursive: true });
    const details = JSON.parse(readFileSync(join(WORKSPACE, 'company-profile/example-co/details.json'), 'utf8'));
    details.companyId = c;
    writeFileSync(join(base, 'details.json'), JSON.stringify(details, null, 2));
    writeFileSync(join(base, 'soc/main.jsonl'), '');
  }
  return dir;
}

const control = (over = {}) => ({ id: 'AC-7', title: 'Production access reviewed every month', prose: 'Access to production systems shall be reviewed every month', mandatory: true, defaultSeverity: 'high', cadence: 'monthly', slaDays: 5, mappings: [{ regulator: 'SEBI', instrument: 'sebi-cscrf-2024', controlId: 'PR.AA.S5' }], ...over });
const spec = (over = {}, catalog = {}) => ({
  companyId: 'acme',
  sources: [{ id: 'board', name: 'Board of directors', type: 'internal' }],
  catalog: { id: 'infosec-policy', title: 'Information security policy', sourceType: 'internal-policy', regulator: 'board', version: 'v3.2', sourceRef: 'Board-approved policy, section 7', groups: [{ id: 'Sec-7', title: 'Access control', controls: [control()] }], ...catalog },
  ...over,
});
const add = (dir, s, ...flags) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/catalogs/add-company-catalog.mjs'), '-', '--now', NOW, ...flags], { cwd: dir, input: JSON.stringify(s), encoding: 'utf8', env: { ...process.env, MAXWELL_RUN_ID: '' } });
const validate = (dir, ...paths) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/validate-data.mjs'), ...paths], { cwd: dir, encoding: 'utf8' });
const append = (dir, company, record) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/soc/append.mjs'), company, '-'], { cwd: dir, input: JSON.stringify(record), encoding: 'utf8' });
const companyFiles = (dir, c) => {
  const out = [];
  const walk = (d, rel) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walk(join(d, e.name), r); else if (/\.(json|jsonl)$/.test(e.name) && e.name !== 'details.json') out.push(r.slice(1)); } };
  walk(join(dir, 'company-profile', c), `/company-profile/${c}`);
  return out;
};
const ctlRecord = (company, over = {}) => ({ schemaVersion: '1', kind: 'control', id: 'co:acme:infosec-policy:AC-7', recordedAt: NOW, companyId: company, frameworkRefs: [{ regulator: 'co:acme:board', instrument: 'co:acme:infosec-policy', controlId: 'AC-7' }, { regulator: 'SEBI', instrument: 'sebi-cscrf-2024', controlId: 'PR.AA.S5' }], title: 'Production access reviewed every month', implementationStatus: 'partial', provenance: PROV, ...over });

test('the writer namespaces ids to the company, writes the catalog and its sources, and validate accepts them', () => {
  const dir = workspace();
  try {
    const dry = add(dir, spec(), '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!existsSync(join(dir, 'company-profile/acme/catalogs')), 'a dry run writes nothing');
    const r = add(dir, spec());
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.validated, true);
    assert.equal(out.instrumentId, 'co:acme:infosec-policy');
    assert.deepEqual(out.files, ['company-profile/acme/catalogs/infosec-policy.catalog.json', 'company-profile/acme/regulators.json']);
    const cat = JSON.parse(readFileSync(join(dir, 'company-profile/acme/catalogs/infosec-policy.catalog.json'), 'utf8'));
    assert.equal(cat.regulator, 'co:acme:board');
    assert.equal(cat.kind, 'maxwell.catalog.company');
    assert.deepEqual(cat.provenance, { harness: 'script', generatedAt: NOW, workflow: 'add-company-catalog', agent: '.claude/scripts/catalogs/add-company-catalog.mjs' });
    const regs = JSON.parse(readFileSync(join(dir, 'company-profile/acme/regulators.json'), 'utf8'));
    assert.deepEqual(regs.sources.map((s) => s.id), ['co:acme:board']);
    assert.ok(!existsSync(join(dir, '.claude/worktrees')), 'the staging directory is gone');
    assert.deepEqual(companyCatalogArgs('acme', dir), [{ instrumentId: 'co:acme:infosec-policy', file: 'company-profile/acme/catalogs/infosec-policy.catalog.json', regulator: 'co:acme:board', controls: 1 }]);
    assert.deepEqual(companyCatalogArgs('beta', dir), [], 'the overlay is loaded only for its own company');
    // A second catalog of the same company may crosswalk to the first.
    const second = add(dir, spec({ sources: [{ id: 'customer-a', name: 'Customer A', type: 'customer' }] }, { id: 'customer-a-schedule', sourceType: 'customer-contract', regulator: 'customer-a', groups: [{ id: 'S', title: 'Security schedule', controls: [control({ id: 'S-4', mappings: [{ regulator: 'co:acme:board', instrument: 'co:acme:infosec-policy', controlId: 'AC-7' }] })] }] }));
    assert.equal(second.status, 0, second.stderr);
    const v = validate(dir, ...companyFiles(dir, 'acme'));
    assert.equal(v.status, 0, v.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the writer refuses another company\'s ids, unknown regulators, duplicate ids, secrets and silent replacement', () => {
  const dir = workspace();
  try {
    const refused = (s, re, ...flags) => { const r = add(dir, s, ...flags); assert.equal(r.status, 2, r.stdout); assert.match(r.stderr, re); };
    refused(spec({}, { id: 'co:beta:infosec-policy' }), /belongs to company beta/);
    refused(spec({ sources: [{ id: 'co:beta:board', name: 'B', type: 'internal' }] }), /belongs to company beta/);
    refused(spec({}, { id: 'sebi-cscrf-2024.x' }), /must be a lower-case slug/);
    refused(spec({ sources: [] }), /regulator co:acme:board is not a source/);
    refused(spec({}, { regulator: 'FBI' }), /FBI|regulator/);
    refused(spec({}, { groups: [{ id: 'A', title: 'A', controls: [control(), control({ title: 'again' })] }] }), /AC-7 appears more than once/);
    refused(spec({}, { groups: [{ id: 'A', title: 'A', controls: [control({ mappings: [{ regulator: 'co:beta:board', instrument: 'co:beta:policy', controlId: 'X' }] })] }] }), /belongs to company beta/);
    refused(spec({}, { groups: [{ id: 'A', title: 'A', controls: [control({ mappings: [{ regulator: 'RBI', instrument: 'sebi-cscrf-2024', controlId: 'PR.AA.S5' }] })] }] }), /registry names SEBI/);
    refused(spec({}, { sourceRef: 'key ghp_' + 'a'.repeat(36) }), /secret/);
    refused(spec({ companyId: 'nobody' }), /does not exist/);
    assert.ok(!existsSync(join(dir, 'company-profile/acme/catalogs')), 'nothing was written');
    assert.equal(add(dir, spec()).status, 0);
    refused(spec(), /already exists; nothing written/);
    // --force may replace the catalog, but never drop a control the company's ledger cites.
    assert.equal(append(dir, 'acme', ctlRecord('acme')).status, 0);
    refused(spec({}, { groups: [{ id: 'A', title: 'A', controls: [control({ id: 'AC-8' })] }] }), /AC-7 is not in .*keep the control in the catalog/, '--force');
    assert.equal(add(dir, spec({}, { version: 'v3.3' }), '--force').status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validate refuses collisions, wrong names and any company id used outside its own company', () => {
  const dir = workspace();
  try {
    assert.equal(add(dir, spec()).status, 0);
    const file = join(dir, 'company-profile/acme/catalogs/infosec-policy.catalog.json');
    const good = readFileSync(file, 'utf8');
    const edit = (f) => { const d = JSON.parse(good); f(d); writeFileSync(file, JSON.stringify(d)); };
    const fails = (re, paths = companyFiles(dir, 'acme')) => { const v = validate(dir, ...paths); assert.equal(v.status, 2, v.stdout); assert.match(v.stderr, re); };
    edit((d) => { d.instrumentId = 'sebi-cscrf-2024'; });
    fails(/does not match/);
    edit((d) => { d.instrumentId = 'co:acme:other-name'; });
    fails(/must be co:acme:infosec-policy/);
    edit((d) => { d.instrumentId = 'co:beta:infosec-policy'; });
    fails(/belongs to company beta/);
    edit((d) => { d.companyId = 'beta'; });
    fails(/companyId beta must be acme/);
    edit((d) => { d.regulator = 'co:acme:nobody'; });
    fails(/not a source/);
    edit((d) => { d.groups.push({ id: 'B', title: 'B', controls: [{ ...d.groups[0].controls[0], title: 'dup' }] }); });
    fails(/AC-7 appears more than once/);
    edit((d) => { d.groups[0].controls[0].mappings = [{ regulator: 'co:acme:board', instrument: 'co:acme:infosec-policy', controlId: 'AC-7' }]; });
    fails(/maps to its own catalog/);
    writeFileSync(file, good);
    // The company's ledger may cite its own controls, which must exist; another company's ledger may not cite them.
    writeFileSync(join(dir, 'company-profile/acme/soc/main.jsonl'), JSON.stringify(ctlRecord('acme')) + '\n');
    assert.equal(validate(dir, ...companyFiles(dir, 'acme')).status, 0);
    writeFileSync(join(dir, 'company-profile/acme/soc/main.jsonl'), JSON.stringify(ctlRecord('acme', { id: 'co:acme:infosec-policy:AC-9', frameworkRefs: [{ regulator: 'co:acme:board', instrument: 'co:acme:infosec-policy', controlId: 'AC-9' }] })) + '\n');
    fails(/AC-9 is not in company-profile\/acme\/catalogs\/infosec-policy.catalog.json/);
    writeFileSync(join(dir, 'company-profile/acme/soc/main.jsonl'), JSON.stringify(ctlRecord('acme', { frameworkRefs: [{ regulator: 'SEBI', instrument: 'co:acme:infosec-policy', controlId: 'AC-7' }] })) + '\n');
    fails(/must be co:acme:board, the catalog's regulator/);
    writeFileSync(join(dir, 'company-profile/acme/soc/main.jsonl'), '');
    writeFileSync(join(dir, 'company-profile/beta/soc/main.jsonl'), JSON.stringify(ctlRecord('beta')) + '\n');
    fails(/belongs to company acme; a company's catalogs and sources may be cited only in its own files/, ['company-profile/beta/soc/main.jsonl']);
    // Shared data (catalogs, registry, applications) may cite no company id at all.
    const checker = overlayChecker({ root: dir });
    checker.note('.claude/skills/regulatory-catalogs/references/catalogs/x.catalog.json', { groups: [{ controls: [{ mappings: [{ regulator: 'co:acme:board', instrument: 'co:acme:infosec-policy', controlId: 'AC-7' }] }] }] });
    checker.note('applications/payments-api/repos/payments.json', { notes: 'co:acme:infosec-policy' });
    checker.note('company-profile/acme/soc/main.jsonl', ctlRecord('acme'), ' line 1');
    const problems = checker.problems();
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.ok(problems.every((p) => /never in shared ones/.test(p)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the ledger writer refuses records citing another company\'s or a missing company control', () => {
  const dir = workspace();
  try {
    assert.equal(add(dir, spec()).status, 0);
    const r1 = append(dir, 'beta', ctlRecord('beta'));
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /belongs to company acme/);
    const r2 = append(dir, 'acme', ctlRecord('acme', { id: 'co:acme:infosec-policy:AC-7', frameworkRefs: [{ regulator: 'SEBI', instrument: 'sebi-cscrf-2024', controlId: 'PR.AA.S5' }] }));
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /must equal frameworkRefs\[0\]/);
    const r3 = append(dir, 'acme', ctlRecord('acme'));
    assert.equal(r3.status, 0, r3.stderr);
    assert.equal(readFileSync(join(dir, 'company-profile/beta/soc/main.jsonl'), 'utf8'), '', 'beta\'s ledger is untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the controls listing and the coverage KPI label the company\'s controls, for that company only', () => {
  const dir = workspace();
  try {
    assert.equal(add(dir, spec()).status, 0);
    const list = (c) => JSON.parse(spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/catalogs/company.mjs'), 'controls', c], { cwd: dir, encoding: 'utf8' }).stdout);
    const acme = list('acme'); const beta = list('beta');
    assert.deepEqual(acme.controls.filter((c) => c.scope === 'company').map((c) => [c.key, c.label]), [['co:acme:infosec-policy:AC-7', 'company-specific']]);
    assert.equal(beta.controls.filter((c) => c.scope === 'company').length, 0);
    assert.deepEqual(acme.controls.filter((c) => c.scope === 'shared'), beta.controls.filter((c) => c.scope === 'shared'), 'both see the same shared library');
    const obs = { schemaVersion: '1', kind: 'observation', id: 'obs_01M2H3CT0PWMZKGHPNW9DXZ58Z', recordedAt: NOW, collectedAt: NOW, companyId: 'acme', controlIds: ['co:acme:infosec-policy:AC-7'], title: 'Access reviews run monthly', description: 'Sign-offs exist for the last three months', methods: ['manual'], result: 'satisfied', provenance: PROV };
    writeFileSync(join(dir, 'company-profile/acme/soc/main.jsonl'), [ctlRecord('acme'), obs].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const k = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/kpis/compute.mjs'), '--kpi', 'cm_coverage', '--until', '2026-10-23'], { cwd: dir, encoding: 'utf8' });
    assert.equal(k.status, 0, k.stderr + k.stdout);
    const points = readFileSync(join(dir, 'kpis/data/cm_coverage/series.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const own = points.filter((p) => p.series === 'company-specific-controls');
    assert.deepEqual(own.map((p) => [p.dimensions.companyId, p.value, p.numerator, p.denominator]), [['acme', 100, 1, 1]]);
    assert.deepEqual(points.filter((p) => p.series === 'raw').map((p) => p.dimensions.companyId).sort(), ['acme', 'beta']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Runs a workflow script with stand-in globals (no model) and returns the prompts its agents would get. Agents answer
// with the smallest object their schema allows, so each workflow runs as far as an empty scout lets it.
async function prompts(file, args) {
  const sent = [];
  const fake = (s, key = '') => {
    if (!s || typeof s !== 'object') return null;
    if (s.const !== undefined) return s.const;
    if (s.enum) return s.enum[0];
    const t = Array.isArray(s.type) ? s.type[0] : s.type;
    if (t === 'object' || s.properties) return Object.fromEntries((s.required || []).map((k) => [k, fake((s.properties || {})[k] || {}, k)]));
    if (t === 'array') return [];
    if (t === 'boolean') return false;
    if (t === 'integer' || t === 'number') return 0;
    return /now|At$/.test(key) ? NOW : 'x';
  };
  const agent = async (prompt, opts = {}) => { sent.push(prompt); return opts.schema ? fake(opts.schema) : 'ok'; };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { let v = item; for (const s of stages) { try { v = await s(v, item, i); } catch { return null; } } return v; }));
  const src = readFileSync(file, 'utf8').replace(/^\s*export\s+const\s+meta\s*=/m, 'const meta =');
  const body = vm.runInThisContext(`(async function (agent, pipeline, parallel, phase, log, args, budget, workflow) {\n${src}\n})`);
  await body(agent, pipeline, parallel, () => {}, () => {}, args, { total: null, spent: () => 0, remaining: () => Infinity }, async () => null).catch(() => null);
  return sent;
}

test('workflows give a company\'s agents its own catalogs and nothing else; without them every prompt is unchanged', async () => {
  const base = { companyId: 'acme', appIds: [], envIds: [], dryRun: true, now: NOW, runId: 'run_01M2H3CT0PWMZKGHPNW9DXZ58Z' };
  const own = { instrumentId: 'co:acme:infosec-policy', file: 'company-profile/acme/catalogs/infosec-policy.catalog.json', regulator: 'co:acme:board', title: 'Information security policy', controls: 1 };
  const foreign = [{ ...own, instrumentId: 'co:beta:infosec-policy', file: 'company-profile/beta/catalogs/infosec-policy.catalog.json' },
    { ...own, file: 'company-profile/acme/catalogs/../../beta/catalogs/x.catalog.json' }, { ...own, instrumentId: 'co:acme:infosec-policy:AC-7' }, null, 'co:acme:x'];
  const dir = join(WORKSPACE, '.claude/workflows');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const without = await prompts(join(dir, f), base);
    assert.ok(without.length > 0, `${f} sends at least one prompt`);
    assert.deepEqual(await prompts(join(dir, f), { ...base, companyCatalogs: [] }), without, `${f}: an empty list changes nothing`);
    assert.deepEqual(await prompts(join(dir, f), { ...base, companyCatalogs: foreign }), without, `${f}: another company's or malformed entries are ignored`);
    assert.ok(without.every((p) => typeof p !== 'string' || !p.includes('Company catalogs:')), `${f}: no overlay text without catalogs`);
    const withOwn = await prompts(join(dir, f), { ...base, companyCatalogs: [own, ...foreign] });
    assert.equal(withOwn.length, without.length, f);
    withOwn.forEach((p, i) => {
      assert.ok(p.startsWith(without[i]), `${f}: prompt ${i + 1} keeps its text`);
      const extra = p.slice(without[i].length);
      assert.match(extra, /^\n\nCompany catalogs: .*co:acme:infosec-policy \(company-profile\/acme\/catalogs\/infosec-policy\.catalog\.json\)/, `${f}: prompt ${i + 1} names the company's catalog`);
      assert.doesNotMatch(extra, /co:beta|\.\.\//, `${f}: no other company's catalog`);
    });
  }
});

test('review follow-ups: free text, stray files, symlinks, single-file checks, id kinds, secrets and error text', async () => {
  const dir = workspace();
  try {
    // Free text that merely starts with "co:" is not a company id, as before company catalogs existed.
    const finding = JSON.parse(readFileSync(join(WORKSPACE, 'company-profile/example-co/soc/main.jsonl'), 'utf8').split('\n').find((l) => l.includes('"kind":"finding"')));
    const free = { ...finding, companyId: 'beta', title: 'co: owned with the vendor' };
    delete free.supersedes;
    const r = append(dir, 'beta', free);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(validate(dir, 'company-profile/beta/soc/main.jsonl').status, 0);
    // A stray file named catalogs is reported, not a crash, and gives a run no catalogs.
    writeFileSync(join(dir, 'company-profile/beta/catalogs'), 'x');
    const v = validate(dir, 'company-profile/beta/catalogs');
    assert.equal(v.status, 2);
    assert.doesNotMatch(v.stderr, /at .*\.mjs:\d+/, 'no stack trace');
    assert.deepEqual(companyCatalogArgs('beta', dir), []);
    rmSync(join(dir, 'company-profile/beta/catalogs'));
    // A catalogs folder that links to another company's is never followed.
    assert.equal(add(dir, spec()).status, 0);
    symlinkSync('../acme/catalogs', join(dir, 'company-profile/beta/catalogs'));
    assert.deepEqual(companyCatalogArgs('beta', dir), []);
    const listed = JSON.parse(spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/catalogs/company.mjs'), 'list', 'beta'], { cwd: dir, encoding: 'utf8' }).stdout);
    assert.deepEqual(listed.catalogs, []);
    assert.match(listed.unreadable.join(), /not a symbolic link/);
    assert.match(add(dir, spec({ companyId: 'beta' })).stderr, /symbolic link/);
    rmSync(join(dir, 'company-profile/beta/catalogs'));
    // Checking only the catalog still finds a control it dropped that the ledger cites.
    assert.equal(append(dir, 'acme', ctlRecord('acme')).status, 0);
    const file = join(dir, 'company-profile/acme/catalogs/infosec-policy.catalog.json');
    const cat = JSON.parse(readFileSync(file, 'utf8'));
    const good = JSON.stringify(cat);
    cat.groups[0].controls[0].id = 'AC-8';
    writeFileSync(file, JSON.stringify(cat));
    const one = validate(dir, 'company-profile/acme/catalogs/infosec-policy.catalog.json');
    assert.equal(one.status, 2);
    assert.match(one.stderr, /main\.jsonl line 1: .*AC-7/);
    writeFileSync(file, good);
    // Ids are checked for their kind, and crosswalks to shared catalogs for the control.
    const wrongKind = ctlRecord('acme', { id: 'co:acme:infosec-policy:AC-7', frameworkRefs: [{ regulator: 'co:acme:infosec-policy', instrument: 'co:acme:infosec-policy', controlId: 'AC-7' }] });
    assert.match(append(dir, 'acme', { ...wrongKind, supersedes: wrongKind.id }).stderr, /is not a source/);
    const noShared = add(dir, spec({}, { id: 'other', groups: [{ id: 'A', title: 'A', controls: [control({ mappings: [{ regulator: 'SEBI', instrument: 'sebi-cscrf-2024', controlId: 'NOPE-999' }] })] }] }));
    assert.match(noShared.stderr, /NOPE-999, which is not in that instrument's catalog/);
    // A secret-shaped value is never repeated back.
    const secret = add(dir, spec({}, { id: 'ghp_' + 'a'.repeat(36) }));
    assert.equal(secret.status, 2);
    assert.doesNotMatch(secret.stderr, /ghp_a/);
    // Errors for shared data read as before: no extra line from the company-id branch.
    const { buildAjv, getValidator, formatErrors } = await import('../lib/schemas.mjs');
    const val = getValidator(buildAjv({ root: join(WORKSPACE, '.claude/schemas') }).ajv, 'https://maxwell.onfinance.ai/schemas/v1/soc/record.schema.json');
    const bad = { ...finding, regulatoryRefs: [{ ...finding.regulatoryRefs[0], instrument: 'sebi-cscrf-2025' }] };
    assert.equal(val(bad), false);
    const text = formatErrors(val.errors, 100);
    assert.match(text, /\/regulatoryRefs\/0\/instrument must be equal to one of the allowed values/);
    assert.doesNotMatch(text, /"else"|\^co:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
