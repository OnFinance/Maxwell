// A company's own catalogs and sources (the "company overlay"): company-profile/<company_id>/catalogs/<slug>.catalog.json
// (v1/company/catalog.schema.json) and company-profile/<company_id>/regulators.json (v1/company/regulators.schema.json).
// They sit beside the shared regulator catalogs and apply to their company only. Ids are namespaced
// 'co:<company_id>:<slug>' so they never collide with a shared instrument or with another company's ids, and a
// company's ledger keys their controls '<instrumentId>:<controlId>' exactly like shared controls.
//
// Used by validate-data.mjs (cross-checks after the schema pass), soc/append.mjs (refs in appended records),
// run-headless.mjs (args.companyCatalogs, passed only when the company has catalogs) and catalogs/*.mjs.
// A company without catalogs or regulators.json, and with no 'co:' id in its files, produces no problem and no args:
// everything behaves exactly as it does without this module.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CATALOG_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/company/catalog.schema.json';
export const REGULATORS_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/company/regulators.schema.json';
export const REGISTRY = '.claude/skills/regulatory-catalogs/references/instruments.json';
const SLUG_RE = '[a-z0-9][a-z0-9-]{1,62}';
export const SLUG = new RegExp(`^${SLUG_RE}$`);
// 'co:<company>:<slug>' (an instrument or source id) or 'co:<company>:<slug>:<controlId>' (a ledger control id).
const CO_ID = new RegExp(`^co:(${SLUG_RE}):(${SLUG_RE})(?::([A-Za-z0-9][A-Za-z0-9._()\\-]{0,63}))?$`);
const CO_PREFIX = /^co:([^:]*):/;
// What counts as a company id at all: 'co:', a slug-shaped company, ':' and no whitespace. Free text that merely
// starts with "co:" ("co: owned with the vendor") is not one and is left alone, as before company catalogs existed.
const CO_LIKE = /^co:[A-Za-z0-9][A-Za-z0-9_-]*:\S*$/;
export const isCoId = (s) => typeof s === 'string' && CO_LIKE.test(s);
// lstat without throwing: 'dir', 'file', 'link', or null when absent.
const kindOf = (path) => { try { const st = lstatSync(path); return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'; } catch { return null; } };

export const catalogsDir = (companyId, root = '.') => join(root, 'company-profile', companyId, 'catalogs');
export const regulatorsPath = (companyId, root = '.') => join(root, 'company-profile', companyId, 'regulators.json');
export const catalogRel = (companyId, slug) => `company-profile/${companyId}/catalogs/${slug}.catalog.json`;
export const instrumentIdFor = (companyId, slug) => `co:${companyId}:${slug}`;

// Parses a 'co:' id into { companyId, slug, controlId? }, or null when the string is not one.
export function parseCoId(s) {
  if (!isCoId(s)) return null;
  const m = CO_ID.exec(s);
  return m ? { companyId: m[1], slug: m[2], controlId: m[3] } : { companyId: (CO_PREFIX.exec(s) || [])[1] || '', slug: null, malformed: true };
}

export function hasOverlay(companyId, root = '.') {
  if (!SLUG.test(companyId || '')) return false;
  if (kindOf(regulatorsPath(companyId, root))) return true;
  const kind = kindOf(catalogsDir(companyId, root));
  if (kind !== 'dir') return kind === 'link';
  try { return readdirSync(catalogsDir(companyId, root)).some((f) => f.endsWith('.catalog.json')); } catch { return false; }
}

const readJson = (path) => { try { return { doc: JSON.parse(readFileSync(path, 'utf8')) }; } catch (e) { return { error: e.code === 'ENOENT' ? 'missing' : 'not valid JSON' }; } };

// Every control of a catalog document, in file order: [{ groupId, control }].
export function catalogControls(doc) {
  const out = [];
  for (const g of (doc && Array.isArray(doc.groups) ? doc.groups : [])) for (const c of (g && Array.isArray(g.controls) ? g.controls : [])) if (c && typeof c.id === 'string') out.push({ groupId: g.id, control: c });
  return out;
}

// Reads a company's overlay from disk. Never throws: unreadable files are listed under `unreadable`.
export function loadOverlay(companyId, root = '.') {
  const overlay = { companyId, catalogs: new Map(), sources: new Map(), regulators: null, unreadable: [] };
  if (!SLUG.test(companyId || '')) return overlay;
  const rp = regulatorsPath(companyId, root);
  const rkind = kindOf(rp);
  if (rkind && rkind !== 'file') overlay.unreadable.push(`company-profile/${companyId}/regulators.json: must be a regular file, not a ${rkind === 'link' ? 'symbolic link' : 'directory'}`);
  else if (rkind) {
    const r = readJson(rp);
    if (r.error) overlay.unreadable.push(`company-profile/${companyId}/regulators.json: ${r.error}`);
    else {
      overlay.regulators = r.doc;
      for (const s of (Array.isArray(r.doc.sources) ? r.doc.sources : [])) if (s && typeof s.id === 'string') overlay.sources.set(s.id, s);
    }
  }
  const dir = catalogsDir(companyId, root);
  const dkind = kindOf(dir);
  // A company's catalogs are its own files: a symbolic link (to another company's folder, say) is never followed.
  if (dkind && dkind !== 'dir') overlay.unreadable.push(`company-profile/${companyId}/catalogs: must be a folder, not a ${dkind === 'link' ? 'symbolic link' : 'file'}`);
  else if (dkind) {
    let names = [];
    try { names = readdirSync(dir); } catch (e) { overlay.unreadable.push(`company-profile/${companyId}/catalogs: ${e.code || 'unreadable'}`); }
    for (const f of names.filter((x) => x.endsWith('.catalog.json')).sort()) {
      const slug = f.slice(0, -'.catalog.json'.length);
      const file = catalogRel(companyId, slug);
      if (kindOf(join(dir, f)) !== 'file') { overlay.unreadable.push(`${file}: must be a regular file`); continue; }
      const r = readJson(join(dir, f));
      if (r.error) { overlay.unreadable.push(`${file}: ${r.error}`); continue; }
      const instrumentId = instrumentIdFor(companyId, slug);
      const controls = new Map(catalogControls(r.doc).map(({ control }) => [control.id, control]));
      overlay.catalogs.set(instrumentId, { instrumentId, slug, file, doc: r.doc, controls });
    }
  }
  return overlay;
}

// What run-headless passes to a workflow as args.companyCatalogs: one entry per catalog whose instrumentId matches its
// file, sorted by file. Empty for a company without catalogs, in which case the caller adds nothing to args.
export function companyCatalogArgs(companyId, root = '.') {
  const overlay = loadOverlay(companyId, root);
  const out = [];
  for (const c of overlay.catalogs.values()) {
    if (!c.doc || c.doc.instrumentId !== c.instrumentId || c.doc.companyId !== companyId) continue;
    // Only ids, the file and a count: nothing free-form from the catalog reaches the run's prompt.
    if (typeof c.doc.regulator !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:-]{0,130}$/.test(c.doc.regulator)) continue;
    out.push({ instrumentId: c.instrumentId, file: c.file, regulator: c.doc.regulator, controls: c.controls.size });
  }
  return out;
}

let registryCache = null;
// instrumentId -> { regulator, controls: Set of control ids, or null when the instrument has no catalog file }.
function registryRegulators(root) {
  if (registryCache && registryCache.root === root) return registryCache.map;
  const map = new Map();
  try {
    for (const i of JSON.parse(readFileSync(join(root, REGISTRY), 'utf8')).instruments || []) {
      let controls = null;
      if (i.catalogFile) { try { controls = new Set(catalogControls(JSON.parse(readFileSync(join(root, i.catalogFile), 'utf8'))).map(({ control }) => control.id)); } catch { controls = null; } }
      map.set(i.instrumentId, { regulator: i.regulator, controls });
    }
  } catch { /* the registry is validated on its own */ }
  registryCache = { root, map };
  return map;
}

// Walks any JSON value and calls visit(kind, value, path) for every string that starts with 'co:' ('id') and every
// object shaped like a regulatoryRef whose instrument starts with 'co:' ('ref').
export function walkCo(value, visit, path = '', key = null) {
  if (typeof value === 'string') { if (isCoId(value)) visit('id', value, path, key); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => walkCo(v, visit, `${path}/${i}`, key)); return; }
  if (!value || typeof value !== 'object') return;
  if (isCoId(value.instrument) && typeof value.controlId === 'string') visit('ref', value, path);
  for (const [k, v] of Object.entries(value)) walkCo(v, visit, `${path}/${k}`, k);
}

// Problems with the 'co:' ids and refs inside `value`, a document or record held in company `companyId`'s files.
// overlay: loadOverlay(companyId). Ids of another company are refused outright; the company's own ids must exist.
export function refProblems(companyId, value, overlay) {
  const out = [];
  walkCo(value, (kind, v, path, key) => {
    const at = path || '/';
    if (kind === 'ref') {
      const cat = overlay.catalogs.get(v.instrument);
      const p = parseCoId(v.instrument);
      if (!p || p.malformed || p.controlId) return; // the id walk reports it
      if (p.companyId !== companyId) return; // reported by the id walk
      if (!cat) { out.push(`${at}: cites ${v.instrument}, which is not one of ${companyId}'s catalogs (company-profile/${companyId}/catalogs/)`); return; }
      if (!cat.controls.has(v.controlId)) out.push(`${at}: control ${v.controlId} is not in ${cat.file}`);
      if (cat.doc && typeof cat.doc.regulator === 'string' && v.regulator !== cat.doc.regulator) out.push(`${at}: regulator ${v.regulator} for ${v.instrument} must be ${cat.doc.regulator}, the catalog's regulator`);
      return;
    }
    const p = parseCoId(v);
    if (!p) return;
    if (p.companyId !== companyId) { out.push(`${at}: ${v} belongs to ${p.companyId ? `company ${p.companyId}` : 'no company'}; a company's catalogs and sources may be cited only in its own files (company-profile/${p.companyId || '<company_id>'}/)`); return; }
    if (p.malformed) { out.push(`${at}: ${v} is not a company id ('co:${companyId}:<slug>' or 'co:${companyId}:<slug>:<controlId>')`); return; }
    const id = instrumentIdFor(companyId, p.slug);
    if (p.controlId) {
      const cat = overlay.catalogs.get(id);
      if (!cat) out.push(`${at}: ${v} names catalog ${id}, which ${companyId} does not have`);
      else if (!cat.controls.has(p.controlId)) out.push(`${at}: ${v} names control ${p.controlId}, which is not in ${cat.file}`);
      return;
    }
    // A field says which kind of id it holds: regulators are sources (or shared), instruments are catalogs.
    if (key === 'regulator' && !overlay.sources.has(v)) { out.push(`${at}: ${v} is not a source in company-profile/${companyId}/regulators.json`); return; }
    if (key === 'instrument' && !overlay.catalogs.has(id)) { out.push(`${at}: ${v} is not a catalog in company-profile/${companyId}/catalogs/`); return; }
    if (!overlay.catalogs.has(id) && !overlay.sources.has(v)) out.push(`${at}: ${v} is neither a catalog in company-profile/${companyId}/catalogs/ nor a source in company-profile/${companyId}/regulators.json`);
  });
  return out;
}

// A ledger control record of a company catalog is keyed by its first frameworkRef, like a shared control.
export function controlKeyProblem(record) {
  if (!record || record.kind !== 'control' || typeof record.id !== 'string' || !record.id.startsWith('co:')) return null;
  const first = Array.isArray(record.frameworkRefs) ? record.frameworkRefs[0] : null;
  const expected = first && first.instrument && first.controlId ? `${first.instrument}:${first.controlId}` : null;
  return expected === record.id ? null : `control id ${record.id} must equal frameworkRefs[0] '<instrument>:<controlId>'${expected ? ` (${expected})` : ''}`;
}

// Cross-checks of the overlay files themselves (after each passed its schema): namespacing, file names, unique ids,
// regulators that exist, crosswalks to existing controls of shared or same-company catalogs only.
export function overlayFileProblems(companyId, overlay, root = '.') {
  const out = [...overlay.unreadable];
  const regs = overlay.regulators;
  const rfile = `company-profile/${companyId}/regulators.json`;
  if (regs) {
    if (regs.companyId !== companyId) out.push(`${rfile}: companyId ${regs.companyId} must be ${companyId}`);
    const seen = new Set();
    for (const s of (Array.isArray(regs.sources) ? regs.sources : [])) {
      if (!s || typeof s.id !== 'string') continue;
      const p = parseCoId(s.id);
      if (!p || p.malformed || p.controlId || p.companyId !== companyId) out.push(`${rfile}: source id ${s.id} must be 'co:${companyId}:<slug>'`);
      if (seen.has(s.id)) out.push(`${rfile}: source id ${s.id} is listed twice`);
      seen.add(s.id);
      if (overlay.catalogs.has(s.id)) out.push(`${rfile}: source id ${s.id} is also a catalog id; use different slugs`);
    }
  }
  const shared = registryRegulators(root);
  for (const cat of overlay.catalogs.values()) {
    const { doc, file } = cat;
    if (!SLUG.test(cat.slug)) out.push(`${file}: the file name must be <slug>.catalog.json with a lower-case slug`);
    if (doc.companyId !== companyId) out.push(`${file}: companyId ${doc.companyId} must be ${companyId}`);
    if (doc.instrumentId !== cat.instrumentId) out.push(`${file}: instrumentId ${doc.instrumentId} must be ${cat.instrumentId} (co:<company_id>:<file slug>)`);
    if (typeof doc.regulator === 'string' && doc.regulator.startsWith('co:')) {
      const p = parseCoId(doc.regulator);
      if (p && p.companyId === companyId && !overlay.sources.has(doc.regulator)) out.push(`${file}: regulator ${doc.regulator} is not a source in ${rfile}`);
    }
    const ids = new Set();
    for (const { control } of catalogControls(doc)) {
      if (ids.has(control.id)) out.push(`${file}: control id ${control.id} appears more than once; ids must be unique across the catalog`);
      ids.add(control.id);
      for (const m of (Array.isArray(control.mappings) ? control.mappings : [])) {
        if (!m || typeof m.instrument !== 'string') continue;
        if (m.instrument === cat.instrumentId) out.push(`${file}: control ${control.id} maps to its own catalog; crosswalks name another instrument`);
        else if (!m.instrument.startsWith('co:') && shared.has(m.instrument)) {
          const entry = shared.get(m.instrument);
          if (entry.regulator !== m.regulator) out.push(`${file}: control ${control.id} maps to ${m.instrument} with regulator ${m.regulator}; the registry names ${entry.regulator}`);
          if (entry.controls && !entry.controls.has(m.controlId)) out.push(`${file}: control ${control.id} maps to ${m.instrument} ${m.controlId}, which is not in that instrument's catalog`);
        }
      }
    }
    for (const p of refProblems(companyId, doc, overlay)) out.push(`${file}: ${p}`);
  }
  if (regs) for (const p of refProblems(companyId, regs, overlay)) out.push(`${rfile}: ${p}`);
  return out;
}

// Collects the 'co:' ids every validated file holds and reports the cross-file problems at the end. Files under
// company-profile/<c>/ may cite only <c>'s ids, and those must exist; shared files (regulator catalogs, the registry,
// applications, cves, kpis) may cite none. Schema test fixtures and raw session exports are not data and are skipped.
export function overlayChecker({ root = '.', allCompanies = false } = {}) {
  const found = new Map(); // relPath -> [{ value, where }]
  const companies = new Set();
  const overlays = new Map();
  const overlayOf = (c) => { if (!overlays.has(c)) overlays.set(c, loadOverlay(c, root)); return overlays.get(c); };
  const companyOf = (rel) => (/^company-profile\/([^/]+)\//.exec(rel) || [])[1] || null;
  const skipped = (rel) => rel.startsWith('.claude/schemas/') || rel.startsWith('.agents/') || rel.startsWith('kpis/data/raw/');
  return {
    note(rel, value, where = '') {
      if (skipped(rel)) return;
      const c = companyOf(rel);
      if (c) companies.add(c);
      let any = false;
      walkCo(value, () => { any = true; });
      if (any || (c && /\/(catalogs\/[^/]+\.catalog\.json|regulators\.json)$/.test(rel))) {
        if (!found.has(rel)) found.set(rel, []);
        found.get(rel).push({ value, where });
      }
    },
    problems() {
      const out = [];
      if (allCompanies && existsSync(join(root, 'company-profile'))) for (const c of readdirSync(join(root, 'company-profile'))) if (SLUG.test(c)) companies.add(c);
      for (const c of [...companies].sort()) {
        if (hasOverlay(c, root)) for (const p of overlayFileProblems(c, overlayOf(c), root)) out.push(p);
        // Checking only a company's catalog (an edit hook, a pre-commit on one file) still checks what cites it.
        if (!allCompanies && [...found.keys()].some((rel) => rel.startsWith(`company-profile/${c}/`) && /\/(catalogs\/[^/]+\.catalog\.json|regulators\.json)$/.test(rel))) {
          const noted = new Set(found.keys());
          for (const p of companyFileProblems(c, overlayOf(c), root)) if (!noted.has(p.split(/:| line /)[0])) out.push(p);
        }
      }
      for (const [rel, items] of found) {
        const c = companyOf(rel);
        if (c && /\/(catalogs\/[^/]+\.catalog\.json|regulators\.json)$/.test(rel)) continue; // checked with the overlay files
        for (const { value, where } of items) {
          if (!c) {
            const ids = new Set();
            walkCo(value, (kind, v) => { if (kind === 'id') ids.add(v); });
            if (ids.size) out.push(`${rel}${where}: cites ${[...ids].join(', ')}; a company's own catalogs and sources may be cited only in that company's files, never in shared ones`);
            continue;
          }
          const overlay = overlayOf(c);
          for (const p of refProblems(c, value, overlay)) out.push(`${rel}${where}: ${p}`);
          const key = controlKeyProblem(value);
          if (key) out.push(`${rel}${where}: ${key}`);
        }
      }
      return out;
    },
  };
}

// Problems the company's other files (ledger, change management, vendors, context, summary data) would have against
// `overlay`: refs to catalogs, controls or sources it does not hold, and control records keyed against their first ref.
export function companyFileProblems(companyId, overlay, root = '.') {
  const out = [];
  const base = join(root, 'company-profile', companyId);
  const walk = (dir, rel) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(join(dir, e.name), r); continue; }
      if (r === 'regulators.json' || /^catalogs\/[^/]+\.catalog\.json$/.test(r)) continue;
      const file = `company-profile/${companyId}/${r}`;
      let text;
      if (e.name.endsWith('.jsonl') || e.name.endsWith('.json')) { try { text = readFileSync(join(dir, e.name), 'utf8'); } catch { continue; } } else continue;
      if (!text.includes('"co:')) continue;
      if (kindOf(join(dir, e.name)) !== 'file') continue;
      const docs = e.name.endsWith('.jsonl')
        ? text.split('\n').map((l, i) => [l, ` line ${i + 1}`]).filter(([l]) => l.trim())
        : [[text, '']];
      for (const [t, where] of docs) {
        let v; try { v = JSON.parse(t); } catch { continue; }
        for (const p of refProblems(companyId, v, overlay)) out.push(`${file}${where}: ${p}`);
        const key = controlKeyProblem(v);
        if (key) out.push(`${file}${where}: ${key}`);
      }
    }
  };
  walk(base, '');
  return out;
}

const VOCAB_REGULATORS = '.claude/schemas/vocab/regulators.schema.json';
const SPEC_KEYS = new Set(['companyId', 'catalog', 'sources']);
const CATALOG_KEYS = ['id', 'title', 'sourceType', 'regulator', 'version', 'sourceUrl', 'sourceRef', 'effectiveFrom', 'retrievedAt', 'groups'];
const SOURCE_KEYS = new Set(['id', 'name', 'type', 'url', 'notes']);

// Full 'co:<company>:<slug>' id from a bare slug or a full id; { id } or { problem }.
function ownId(companyId, value, what) {
  if (typeof value !== 'string' || !value) return { problem: `${what} is required` };
  if (SLUG.test(value)) return { id: instrumentIdFor(companyId, value) };
  const p = parseCoId(value);
  if (!p || p.malformed || p.controlId) return { problem: `${what} ${JSON.stringify(value).slice(0, 80)} must be a lower-case slug (or 'co:${companyId}:<slug>')` };
  if (p.companyId !== companyId) return { problem: `${what} ${value} belongs to company ${p.companyId}; a company may only add its own catalogs and sources` };
  return { id: value };
}

// Builds the catalog document and the merged regulators.json for add-company-catalog.mjs from a spec, and checks the
// result as validate would: schemas, namespacing, crosswalks, and the company's existing files against the new state.
// spec: { companyId, sources?: [{ id, name, type, url?, notes? }], catalog: { id, title, sourceType, regulator, version,
//         sourceUrl?, sourceRef?, effectiveFrom?, retrievedAt?, groups } }. Ids may be bare slugs; they are namespaced.
// Returns { problems, companyId, instrumentId, catalogPath, catalog, regulatorsPath, regulators, sourcesAdded, replaced }.
export function planCompanyCatalog(spec, { now, root = '.', force = false, provenance, ajv, getValidator, formatErrors, findSecret }) {
  const problems = [];
  const fail = (p) => ({ problems: [...problems, p] });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return fail('the spec must be a JSON object');
  // Checked before anything else so that no message ever repeats a secret-shaped value.
  const secret = findSecret(JSON.stringify(spec));
  if (secret) return fail(`the spec looks like it contains a secret (${secret}); catalogs hold control text, never credentials`);
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) problems.push(`unknown spec key '${k}' (allowed: ${[...SPEC_KEYS].join(', ')})`);
  const companyId = spec.companyId;
  if (typeof companyId !== 'string' || !SLUG.test(companyId)) return fail('companyId must be a company slug');
  if (!existsSync(join(root, 'company-profile', companyId, 'details.json'))) return fail(`company-profile/${companyId}/ does not exist; create the company first (/seed-company ${companyId})`);
  const c = spec.catalog;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return fail('catalog must be an object');
  for (const k of Object.keys(c)) if (!CATALOG_KEYS.includes(k)) problems.push(`unknown catalog key '${k}' (allowed: ${CATALOG_KEYS.join(', ')})`);
  const inst = ownId(companyId, c.id, 'catalog.id');
  if (inst.problem) return fail(inst.problem);
  const instrumentId = inst.id;
  const slug = instrumentId.slice(companyId.length + 4);

  const overlay = loadOverlay(companyId, root);
  if (overlay.unreadable.length) return fail(`the company's catalogs cannot be read: ${overlay.unreadable.join('; ')}`);
  const existing = overlay.catalogs.get(instrumentId);
  if (existing && !force) return fail(`${existing.file} already exists; nothing written. Pass --force to replace it.`);

  // Sources: existing ones kept, the spec's added; a changed source needs --force.
  const sources = new Map(overlay.sources);
  const sourcesAdded = [];
  const specSources = spec.sources === undefined ? [] : spec.sources;
  if (!Array.isArray(specSources)) problems.push('sources must be an array');
  for (const [i, s] of (Array.isArray(specSources) ? specSources : []).entries()) {
    if (!s || typeof s !== 'object') { problems.push(`sources[${i}] must be an object`); continue; }
    for (const k of Object.keys(s)) if (!SOURCE_KEYS.has(k)) problems.push(`sources[${i}]: unknown key '${k}'`);
    const sid = ownId(companyId, s.id, `sources[${i}].id`);
    if (sid.problem) { problems.push(sid.problem); continue; }
    const doc = { ...s, id: sid.id };
    const prev = sources.get(sid.id);
    if (prev && JSON.stringify(prev) !== JSON.stringify(doc) && !force) problems.push(`source ${sid.id} already exists with other details; pass --force to change it`);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(doc)) sourcesAdded.push(sid.id);
    sources.set(sid.id, doc);
  }

  // Regulator: a shared regulator, or one of the company's sources (bare slug or full id).
  const vocabRegulators = JSON.parse(readFileSync(join(root, VOCAB_REGULATORS), 'utf8')).enum;
  let regulator = c.regulator;
  if (typeof regulator === 'string' && !vocabRegulators.includes(regulator)) {
    const r = ownId(companyId, regulator, 'catalog.regulator');
    if (r.problem) problems.push(`${r.problem}; use a shared regulator (${vocabRegulators.slice(0, 6).join(', ')}, ...) or one of the company's sources`);
    else regulator = r.id;
  }

  const catalog = { schemaVersion: '1', kind: 'maxwell.catalog.company', companyId, instrumentId, regulator };
  for (const k of ['title', 'sourceType', 'version', 'sourceUrl', 'sourceRef', 'effectiveFrom', 'retrievedAt', 'groups']) if (c[k] !== undefined) catalog[k] = c[k];
  catalog.provenance = provenance;
  const regulators = sources.size ? { schemaVersion: '1', kind: 'maxwell.company.regulators', companyId, sources: [...sources.values()], provenance: sourcesAdded.length || !overlay.regulators ? provenance : overlay.regulators.provenance } : null;

  const v = getValidator(ajv, CATALOG_SCHEMA);
  if (!v(catalog)) problems.push(`the catalog does not match v1/company/catalog.schema.json:\n${formatErrors(v.errors)}`);
  if (regulators) {
    const vr = getValidator(ajv, REGULATORS_SCHEMA);
    if (!vr(regulators)) problems.push(`regulators.json would not match v1/company/regulators.schema.json:\n${formatErrors(vr.errors)}`);
  }
  if (problems.length) return { problems };

  // The state after the write, checked like validate would check it.
  const next = { ...overlay, catalogs: new Map(overlay.catalogs), sources, regulators, unreadable: [] };
  next.catalogs.set(instrumentId, { instrumentId, slug, file: catalogRel(companyId, slug), doc: catalog, controls: new Map(catalogControls(catalog).map(({ control }) => [control.id, control])) });
  for (const p of overlayFileProblems(companyId, next, root)) problems.push(p);
  // As with shared catalogs (skill section 6, "apply without deleting"), a control id the append-only ledger has cited
  // stays: to retire a clause keep the control (reword it, set mandatory false) and supersede its ledger control as
  // not-applicable.
  for (const p of companyFileProblems(companyId, next, root)) problems.push(`${p} (the company's files cite it: keep the control in the catalog; to retire it, reword it, set mandatory false and supersede its ledger control as not-applicable)`);
  return { problems, companyId, instrumentId, catalogPath: catalogRel(companyId, slug), catalog, regulatorsPath: `company-profile/${companyId}/regulators.json`, regulators, sourcesAdded, replaced: !!existing, controls: next.catalogs.get(instrumentId).controls.size, now };
}
