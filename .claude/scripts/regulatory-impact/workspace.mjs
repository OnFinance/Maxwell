import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { latestById, readLedger } from '../lib/ledger.mjs';
import { buildAjv, getValidator } from '../lib/schemas.mjs';
import { controlWorkspace } from '../continuous-controls/workspace.mjs';
import { requireValue } from '../feature-runtime/store.mjs';
export function regulatoryWorkspace(root = '.') {
  const { ajv } = buildAjv(); const validate = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/soc/record.schema.json');
  return { publish: controlWorkspace(root).publish,
    async loadScope(companyId) {
      const base = await realpath(root); const file = await realpath(join(base, 'company-profile', companyId, 'details.json'));
      requireValue(!relative(base, file).startsWith('..'), 'unsafe company path');
      const details = JSON.parse(await readFile(file, 'utf8'));
      requireValue(details.companyId === companyId && Array.isArray(details.frameworksInScope), 'invalid company scope');
      const controls = [...latestById(readLedger(companyId, root)).values()].filter((r) => r.kind === 'control');
      requireValue(controls.every((r) => r.companyId === companyId && validate(r)), 'invalid scoped controls');
      return { instruments: [...details.frameworksInScope].sort(), controls: controls.sort((a, b) => a.id.localeCompare(b.id)) };
    },
  };
}
