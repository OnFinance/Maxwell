#!/usr/bin/env node
// Shows the controls library one company sees: the shared regulator catalogs plus the company's own catalogs.
// Usage: node .claude/scripts/catalogs/company.mjs <list|args|controls> <company_id>
//   list      the company's own catalogs (company-profile/<company_id>/catalogs/) and sources (regulators.json)
//   args      the JSON array a workflow takes as args.companyCatalogs (run-headless passes it itself; pass it when you
//             start a workflow from chat for a company that has its own catalogs). Prints [] when it has none.
//   controls  every control the company is assessed against: shared catalogs of the instruments in its frameworksInScope
//             (registry status in force, narrowed by each control's applicability as in the regulatory-catalogs skill,
//             section 1 rules 3 and 7) and its own catalogs, each labelled scope "shared" or "company".
// Reads only shared reference data and the named company's files; never another company's. Exit 0, 1 usage, 2 unknown company.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY, SLUG, catalogControls, companyCatalogArgs, loadOverlay } from '../lib/company-catalogs.mjs';

const [cmd, companyId] = process.argv.slice(2);
const fail = (code, message) => { console.error(message); process.exit(code); };
if (!['list', 'args', 'controls'].includes(cmd) || !companyId) fail(1, 'usage: company.mjs <list|args|controls> <company_id>');
if (!SLUG.test(companyId) || !existsSync(join('company-profile', companyId, 'details.json'))) fail(2, `no company ${companyId} (company-profile/<company_id>/details.json)`);
const print = (o) => console.log(JSON.stringify(o, null, 2));

if (cmd === 'args') { print(companyCatalogArgs(companyId)); process.exit(0); }

const overlay = loadOverlay(companyId);
const own = [...overlay.catalogs.values()].map((c) => ({ instrumentId: c.instrumentId, file: c.file, regulator: c.doc.regulator, title: c.doc.title, sourceType: c.doc.sourceType, version: c.doc.version, controls: c.controls.size }));
if (cmd === 'list') {
  print({ companyId, catalogs: own, sources: [...overlay.sources.values()], ...(overlay.unreadable.length ? { unreadable: overlay.unreadable } : {}) });
  process.exit(0);
}

const details = JSON.parse(readFileSync(join('company-profile', companyId, 'details.json'), 'utf8'));
const entityTypes = new Set(details.entityTypes || []);
const categories = new Set((details.regulatoryRegistrations || []).filter((r) => !r.status || r.status === 'active').map((r) => r.category).filter(Boolean));
const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')).instruments || [];
const applies = (control, familyCategories) => {
  const a = control.applicability || {};
  if ((a.entityTypes || []).length && !a.entityTypes.some((t) => entityTypes.has(t))) return false;
  // A category filter excludes only when the company has a category of the instrument's family (rule 3).
  const mine = [...categories].filter((c) => familyCategories.has(c));
  if ((a.reCategories || []).length && mine.length && !a.reCategories.some((c) => mine.includes(c))) return false;
  return true;
};
const row = (scope, instrumentId, regulator, control) => ({
  key: `${instrumentId}:${control.id}`, scope, instrumentId, regulator, controlId: control.id, title: control.title,
  mandatory: control.mandatory, ...(control.defaultSeverity ? { defaultSeverity: control.defaultSeverity } : {}),
  ...(control.slaDays !== undefined ? { slaDays: control.slaDays } : {}), ...(control.mappings ? { mappings: control.mappings } : {}),
});
const controls = []; const shared = []; const skipped = [];
for (const id of details.frameworksInScope || []) {
  const entry = registry.find((i) => i.instrumentId === id);
  if (!entry) { skipped.push(`${id}: not in the registry`); continue; }
  if (['repealed', 'superseded'].includes(entry.status)) { skipped.push(`${id}: ${entry.status}`); continue; }
  if (!entry.catalogFile || !existsSync(entry.catalogFile)) { skipped.push(`${id}: no catalog file`); continue; }
  const doc = JSON.parse(readFileSync(entry.catalogFile, 'utf8'));
  const family = new Set((entry.applicability && entry.applicability.categories) || []);
  const rows = catalogControls(doc).map(({ control }) => control).filter((c) => applies(c, family)).map((c) => row('shared', id, entry.regulator, c));
  shared.push({ instrumentId: id, regulator: entry.regulator, controls: rows.length });
  controls.push(...rows);
}
for (const c of overlay.catalogs.values()) {
  const rows = catalogControls(c.doc).map(({ control }) => control).filter((x) => applies(x, new Set())).map((x) => ({ ...row('company', c.instrumentId, c.doc.regulator, x), label: 'company-specific' }));
  controls.push(...rows);
}
print({ companyId, shared, company: own, skipped, controls });
