// Shared schema loader: builds one Ajv 2020-12 instance with every Maxwell schema registered by $id.
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SCHEMA_ROOT = '.claude/schemas';
export const ID_PREFIX = 'https://maxwell.onfinance.ai/schemas/';

export function listSchemaFiles(root = SCHEMA_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith('.schema.json')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function buildAjv({ root = SCHEMA_ROOT } = {}) {
  const ajv = new Ajv2020({
    strict: true,
    strictSchema: true,
    strictTypes: 'log',
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
    validateFormats: true,
    $data: false,
  });
  addFormats(ajv);
  // Maxwell extension keywords: annotations only, tolerated by strict mode.
  for (const kw of ['x-maxwell-owner', 'x-maxwell-since', 'x-maxwell-notes', 'x-lint-exclude', 'x-format-assertion']) {
    ajv.addKeyword({ keyword: kw });
  }
  const ids = [];
  for (const file of listSchemaFiles(root)) {
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    if (!schema.$id || !schema.$id.startsWith(ID_PREFIX)) {
      throw new Error(`${file}: $id must start with ${ID_PREFIX}`);
    }
    const expected = ID_PREFIX + relative(root, file).split('\\').join('/');
    if (schema.$id !== expected) {
      throw new Error(`${file}: $id ${schema.$id} does not match path-derived id ${expected}`);
    }
    ajv.addSchema(schema, schema.$id);
    ids.push(schema.$id);
  }
  return { ajv, ids };
}

export function getValidator(ajv, id) {
  const v = ajv.getSchema(id);
  if (!v) throw new Error(`schema not registered: ${id}`);
  return v;
}

export function formatErrors(errors, limit = 20) {
  if (!errors || errors.length === 0) return '';
  return errors
    .slice(0, limit)
    .map((e) => {
      const extra = e.params && e.params.additionalProperty ? ` (unexpected key '${e.params.additionalProperty}')` : '';
      const allowed = e.params && e.params.allowedValues ? ` allowed: ${JSON.stringify(e.params.allowedValues)}` : '';
      return `  ${e.instancePath || '/'} ${e.message}${extra}${allowed}`;
    })
    .join('\n') + (errors.length > limit ? `\n  ... ${errors.length - limit} more` : '');
}
