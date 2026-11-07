import { realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { latestById, readLedger, appendRecords } from '../lib/ledger.mjs';
import { requireValue, slug } from '../feature-runtime/store.mjs';
import { sha256 } from '../incident-investigation/core.mjs';
export function controlWorkspace(root = '.') {
  return {
    async loadControl(companyId, id) { return latestById(readLedger(companyId, root)).get(id); },
    async resolveCheckout(_companyId, target) {
      requireValue(target?.type === 'repo' && slug(target.appId) && slug(target.repoId), 'repository target required');
      const base = await realpath(root); const directory = await realpath(join(base, 'applications', target.appId, 'repos', target.repoId));
      requireValue(!relative(base, directory).startsWith('..'), 'unsafe checkout'); return directory;
    },
    async publish(companyId, observation) {
      const existing = latestById(readLedger(companyId, root)).get(observation.id);
      if (existing) { requireValue(sha256(existing) === sha256(observation), 'observation identity conflict'); return; }
      const result = appendRecords(companyId, [observation], { root });
      if (result.problems.length) {
        const current = latestById(readLedger(companyId, root)).get(observation.id);
        requireValue(current && sha256(current) === sha256(observation), result.problems.join('; '));
      }
    },
  };
}
