#!/usr/bin/env node
// Adds a company's own catalog (an internal security policy, a customer contract's security schedule, a sector circular
// the shared catalogs do not carry) from a JSON spec, validated before anything is written.
// Usage: node .claude/scripts/catalogs/add-company-catalog.mjs <spec.json | -> [--dry-run] [--force] [--now <rfc3339>]
//   spec: { "companyId": "example-co",
//           "sources": [{ "id": "board", "name": "Board of directors", "type": "internal" }],          (optional)
//           "catalog": { "id": "infosec-policy", "title": "Information security policy", "sourceType": "internal-policy",
//                        "regulator": "board", "version": "v3.2", "sourceRef": "Board-approved policy, section 7",
//                        "groups": [{ "id": "Sec-7", "title": "Access control", "controls": [{ "id": "AC-7", ... }] }] } }
// Writes company-profile/<company_id>/catalogs/<id>.catalog.json (v1/company/catalog.schema.json) with instrumentId
// 'co:<company_id>:<id>', and adds the spec's sources to company-profile/<company_id>/regulators.json. Bare ids are
// namespaced to the company; an id of another company is refused. "regulator" is a shared regulator (SEBI, RBI, ...) or
// one of the company's sources. Controls take the shared catalog control shape (regulator-catalog.schema.json):
// mappings may crosswalk to shared instruments and to the company's other catalogs.
// An existing catalog is replaced only with --force, and never so that a control the company's ledger or other files
// cite disappears. Files are staged under the git-ignored .claude/worktrees/ and moved into place with a rename each.
// Exit codes: 0 done, 1 usage, 2 invalid spec or refused (nothing written).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';
import { jsonErrorWhere } from '../lib/applications.mjs';
import { planCompanyCatalog } from '../lib/company-catalogs.mjs';
import { findSecret } from '../../hooks/lib.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const source = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--now');
const fail = (code, message) => { console.error(message); process.exit(code); };
if (!source) fail(1, 'usage: add-company-catalog.mjs <spec.json | -> [--dry-run] [--force] [--now <rfc3339>]');

let text;
try { text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8'); } catch (e) { fail(2, `spec could not be read: ${e.code || 'error'}`); }
let spec;
try { spec = JSON.parse(text); } catch (e) { fail(2, `spec is not JSON: ${jsonErrorWhere(text, e)}`); }
const now = opt('--now') || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now)) fail(1, '--now must be an RFC 3339 UTC timestamp with a trailing Z');
const dryRun = flag('--dry-run');
const force = flag('--force');

const runId = process.env.MAXWELL_RUN_ID;
const provenance = { harness: 'script', generatedAt: now, ...(runId && /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(runId) ? { runId } : {}), workflow: 'add-company-catalog', agent: '.claude/scripts/catalogs/add-company-catalog.mjs' };
const { ajv } = buildAjv();
const plan = planCompanyCatalog(spec, { now, force, provenance, ajv, getValidator, formatErrors, findSecret });
if (plan.problems.length) fail(2, `nothing written; the spec has problems:\n- ${plan.problems.join('\n- ')}`);

const files = { [plan.catalogPath]: JSON.stringify(plan.catalog, null, 2) + '\n' };
if (plan.regulators && plan.sourcesAdded.length) files[plan.regulatorsPath] = JSON.stringify(plan.regulators, null, 2) + '\n';
const summary = {
  companyId: plan.companyId, instrumentId: plan.instrumentId, dryRun, replaced: plan.replaced, controls: plan.controls,
  sourcesAdded: plan.sourcesAdded, files: Object.keys(files),
  next: `Run /refresh-soc ${plan.companyId} to add the applicable controls of ${plan.instrumentId} to the ledger. Only ${plan.companyId}'s runs see this catalog.`,
};
if (dryRun) {
  console.log(JSON.stringify({ ...summary, contents: Object.fromEntries(Object.entries(files).map(([p, body]) => [p, JSON.parse(body)])) }, null, 2));
  process.exit(0);
}

// Staged under .claude/worktrees/ (git-ignored, skipped by the layout validators) on the same filesystem, so each file
// appears whole through a rename. regulators.json goes first: the catalog may name a source it adds.
mkdirSync(join('.claude', 'worktrees'), { recursive: true });
const stage = mkdtempSync(join('.claude', 'worktrees', `maxwell-catalog-${plan.companyId}-`));
const cleanup = () => { try { rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => { cleanup(); process.exit(code); });
try {
  const order = Object.keys(files).sort((a, b) => Number(b.endsWith('regulators.json')) - Number(a.endsWith('regulators.json')));
  order.forEach((p, i) => writeFileSync(join(stage, String(i)), files[p]));
  mkdirSync(join('company-profile', plan.companyId, 'catalogs'), { recursive: true });
  order.forEach((p, i) => renameSync(join(stage, String(i)), p));
} catch (e) {
  cleanup();
  fail(2, `stopped: ${e.message}`);
}
cleanup();

const check = spawnSync(process.execPath, ['.claude/scripts/validate-data.mjs', ...summary.files.filter((f) => existsSync(f))], { encoding: 'utf8', env: process.env });
console.log(JSON.stringify({ ...summary, validated: check.status === 0 }, null, 2));
// Everything was checked before it was written, so this fails only if the files changed underneath the writer.
if (check.status !== 0) fail(2, `the files are in place, but checking them again failed:\n${(check.stdout || '') + (check.stderr || '')}`);
