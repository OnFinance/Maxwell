import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { latestById, readLedger, appendRecords } from '../lib/ledger.mjs';
import { buildAjv, getValidator } from '../lib/schemas.mjs';
import { sha256 } from '../incident-investigation/core.mjs';
import { requireValue } from '../feature-runtime/store.mjs';

export function workspaceAdapters(root = '.') {
  const { ajv } = buildAjv();
  const taskValidator = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/change-management/task.schema.json');
  const recordValidator = getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/soc/record.schema.json');
  return {
    async load({ companyId, findingId, initiativeId, taskId }) {
      const finding = latestById(readLedger(companyId, root)).get(findingId);
      const base = await realpath(root); const taskFile = await realpath(join(base, 'company-profile', companyId, 'change_management/initiatives', initiativeId, 'tasks', `${taskId}.json`));
      requireValue(!relative(base, taskFile).startsWith('..'), 'unsafe task path');
      const task = JSON.parse(await readFile(taskFile, 'utf8'));
      requireValue(taskValidator(task) && recordValidator(finding), 'invalid task or finding record');
      const target = finding.target;
      requireValue(target.type === 'repo', 'initial checks support repository targets only');
      const checkout = await realpath(join(base, 'applications', target.appId, 'repos', target.repoId));
      requireValue(!relative(base, checkout).startsWith('..'), 'unsafe checkout path');
      return { finding, task, checkout };
    },
    async publish({ companyId, record, expectedSignature }) {
      const current = latestById(readLedger(companyId, root)).get(record.id);
      if (current && sha256(current) === sha256(record)) return { appended: false };
      const result = appendRecords(companyId, [record], { root, expected: { id: record.id, signature: expectedSignature } });
      requireValue(!result.problems.length, result.problems.join('; ')); return result;
    },
  };
}
