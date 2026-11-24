import { readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { latestById, readLedger } from '../lib/ledger.mjs';
import { buildAjv, getValidator } from '../lib/schemas.mjs';
import { requireValue, slug } from '../feature-runtime/store.mjs';

const FINDING_ID = /^fnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const INITIATIVE_ID = /^init_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SUGGESTION_ID = /^sug_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const TASK_ID = /^task_[1-9][0-9]{0,5}$/;
const REVISION = /^[a-f0-9]{40}$/;
const NON_PRODUCTION = new Set([
  'dev',
  'test',
  'devtest',
  'sandbox',
  'preview',
  'qa',
  'uat',
  'staging',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function repoTarget(target, application, repository, environment) {
  return (
    target?.type === 'repo' &&
    target.appId === application &&
    target.repoId === repository &&
    (!target.envId || target.envId === environment)
  );
}

// Reads schema-validated workspace state and returns an immutable release snapshot.
// Deployment, CI and runtime effects remain host-owned service adapters.
export function productWorkspace(root = '.', clock = Date.now) {
  const { ajv } = buildAjv();
  const validators = {
    finding: getValidator(ajv, 'https://maxwell.onfinance.ai/schemas/v1/soc/record.schema.json'),
    initiative: getValidator(
      ajv,
      'https://maxwell.onfinance.ai/schemas/v1/change-management/master.schema.json',
    ),
    task: getValidator(
      ajv,
      'https://maxwell.onfinance.ai/schemas/v1/change-management/task.schema.json',
    ),
    suggestion: getValidator(
      ajv,
      'https://maxwell.onfinance.ai/schemas/v1/suggestions/master.schema.json',
    ),
    repository: getValidator(
      ajv,
      'https://maxwell.onfinance.ai/schemas/v1/application/repo.schema.json',
    ),
    environment: getValidator(
      ajv,
      'https://maxwell.onfinance.ai/schemas/v1/application/environment.schema.json',
    ),
  };

  async function document(base, path, validator, message) {
    const file = await realpath(join(base, path));
    const fromBase = relative(base, file);
    requireValue(fromBase && !fromBase.startsWith('..') && !fromBase.startsWith('/'), 'unsafe release context path');
    const value = JSON.parse(await readFile(file, 'utf8'));
    requireValue(validator(value), message);
    return value;
  }

  return {
    async loadReleaseContext({
      companyId,
      findingId,
      initiativeId,
      taskId,
      suggestionId,
      application,
      repository,
      environment,
    }) {
      requireValue(
        slug(companyId) &&
          slug(application) &&
          slug(repository) &&
          slug(environment) &&
          FINDING_ID.test(findingId) &&
          INITIATIVE_ID.test(initiativeId) &&
          TASK_ID.test(taskId) &&
          SUGGESTION_ID.test(suggestionId),
        'invalid release context identity',
      );
      const base = await realpath(root);
      const [initiativeMaster, task, suggestionMaster, repo, env] = await Promise.all([
        document(
          base,
          join('company-profile', companyId, 'change_management', 'master.json'),
          validators.initiative,
          'invalid initiative index',
        ),
        document(
          base,
          join(
            'company-profile',
            companyId,
            'change_management',
            'initiatives',
            initiativeId,
            'tasks',
            `${taskId}.json`,
          ),
          validators.task,
          'invalid release task',
        ),
        document(
          base,
          join('company-profile', companyId, 'suggestions', 'master.json'),
          validators.suggestion,
          'invalid suggestion index',
        ),
        document(
          base,
          join('applications', application, 'repos', `${repository}.json`),
          validators.repository,
          'invalid repository record',
        ),
        document(
          base,
          join('applications', application, 'env', `${environment}.json`),
          validators.environment,
          'invalid environment record',
        ),
      ]);
      const finding = latestById(readLedger(companyId, base)).get(findingId);
      const initiative = initiativeMaster.initiatives.find((item) => item.initiativeId === initiativeId);
      const suggestion = suggestionMaster.suggestions.find((item) => item.suggestionId === suggestionId);
      const repoChange = suggestion?.repos?.find(
        (item) => item.appId === application && item.repoId === repository,
      );

      requireValue(
        validators.finding(finding) &&
          finding.kind === 'finding' &&
          finding.companyId === companyId &&
          finding.id === findingId &&
          ['open', 'triaged', 'remediating'].includes(finding.status) &&
          repoTarget(finding.target, application, repository, environment),
        'finding is not releasable in this context',
      );
      requireValue(
        initiativeMaster.companyId === companyId &&
          initiative &&
          ['approved', 'in-progress', 'verifying', 'reopened'].includes(initiative.status) &&
          initiative.findingIds.includes(findingId) &&
          initiative.suggestionIds.includes(suggestionId) &&
          initiative.targets.some((target) =>
            repoTarget(target, application, repository, environment),
          ),
        'initiative is not approved for this release',
      );
      requireValue(
        task.companyId === companyId &&
          task.initiativeId === initiativeId &&
          task.taskId === taskId &&
          task.status === 'done' &&
          task.suggestionIds.includes(suggestionId) &&
          task.targets.some((target) => repoTarget(target, application, repository, environment)),
        'completed release task does not match the context',
      );
      requireValue(
        suggestionMaster.companyId === companyId &&
          suggestion?.status === 'merged' &&
          suggestion.initiativeId === initiativeId &&
          suggestion.findingIds.includes(findingId) &&
          repoChange &&
          REVISION.test(repoChange.mergeCommit ?? ''),
        'merged suggestion does not match the context',
      );
      requireValue(
        repo.appId === application &&
          repo.repoId === repository &&
          repo.branchProtection?.required === true &&
          Array.isArray(repo.branchProtection.statusChecks) &&
          repo.branchProtection.statusChecks.length > 0,
        'repository has no approved CI checks',
      );
      requireValue(
        env.appId === application &&
          env.envId === environment &&
          NON_PRODUCTION.has(env.tier),
        'release requires a registered non-production environment',
      );
      const now = clock();
      requireValue(Number.isSafeInteger(now) && now >= 0, 'invalid release context clock');
      requireValue(
        !(env.changeFreeze ?? []).some(
          (window) => Date.parse(window.from) <= now && now < Date.parse(window.to),
        ),
        'environment is in a change freeze',
      );

      return deepFreeze(
        structuredClone({
          finding,
          initiative,
          task,
          suggestion,
          repository: repo,
          environment: env,
          candidateRevision: repoChange.mergeCommit,
          approvedChecks: [...repo.branchProtection.statusChecks].sort(),
        }),
      );
    },
  };
}

export const workspaceAdapters = productWorkspace;
