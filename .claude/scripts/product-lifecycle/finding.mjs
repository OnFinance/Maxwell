import { digest, ensure } from './model.mjs';
import { ledgerValidator } from '../soc/artex.mjs';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REVISION = /^[a-f0-9]{40}$/;

// Validate a source-backed candidate before a trusted ledger writer supersedes an
// endpoint-level ARTEX finding with a repository and file location. Ambiguity must
// be resolved outside this helper; callers pass exactly one independently reviewed candidate.
export function validateFindingMapping(finding, candidate) {
  ensure(
    ledgerValidator()(finding) &&
      finding?.kind === 'finding' &&
      ['open', 'triaged', 'remediating'].includes(finding.status),
    'Finding unavailable for mapping.',
  );
  ensure(
    candidate &&
      candidate.findingId === finding.id &&
      SLUG.test(candidate.appId ?? '') &&
      SLUG.test(candidate.repoId ?? '') &&
      SLUG.test(candidate.envId ?? '') &&
      typeof candidate.path === 'string' &&
      candidate.path.length > 0 &&
      !candidate.path.startsWith('/') &&
      !candidate.path.split('/').includes('..') &&
      REVISION.test(candidate.revision ?? '') &&
      candidate.confidence === 'confirmed' &&
      Array.isArray(candidate.evidence) &&
      candidate.evidence.length > 0 &&
      candidate.evidence.length <= 20 &&
      candidate.evidence.every(
        (item) =>
          item &&
          item.revision === candidate.revision &&
          typeof item.path === 'string' &&
          item.path.startsWith(`applications/${candidate.appId}/repos/${candidate.repoId}/`) &&
          !item.path.split('/').includes('..') &&
          typeof item.detail === 'string' &&
          item.detail.length > 0 &&
          item.detail.length <= 500,
      ) &&
      candidate.evidence.some(
        (item) =>
          item.path ===
          `applications/${candidate.appId}/repos/${candidate.repoId}/${candidate.path}`,
      ),
    'Finding mapping is not supported by revision-bound repository evidence.',
  );
  ensure(
    finding.target?.appId === candidate.appId && finding.target.envId === candidate.envId,
    'Finding mapping changes the application or environment.',
  );
  return {
    findingId: finding.id,
    findingSignature: digest(finding),
    target: {
      type: 'repo',
      appId: candidate.appId,
      repoId: candidate.repoId,
      envId: candidate.envId,
    },
    location: { path: candidate.path },
    revision: candidate.revision,
    evidence: structuredClone(candidate.evidence),
  };
}

// Validate the ledger record independently, then bind its product/repository/file scope.
export function bindFinding(finding, { companyId, application, repository, environment, check }) {
  ensure(
    ledgerValidator()(finding) &&
      finding?.kind === 'finding' &&
      finding.companyId === companyId &&
      /^fnd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(finding.id),
    'Finding unavailable.',
  );
  ensure(['open', 'triaged', 'remediating'].includes(finding.status), 'Finding is not open.');
  ensure(
    typeof repository === 'string' &&
      finding.target?.type === 'repo' &&
      finding.target.appId === application &&
      finding.target.repoId === repository &&
      (!finding.target.envId || finding.target.envId === environment),
    'Finding target does not match this repair.',
  );
  ensure(
    finding.location?.path === check.path,
    'Finding location does not match the selected file.',
  );
  return { findingId: finding.id, signature: digest(finding), repository, path: check.path };
}
