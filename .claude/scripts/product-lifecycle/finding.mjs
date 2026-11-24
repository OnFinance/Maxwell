import { digest, ensure } from './model.mjs';
import { ledgerValidator } from '../soc/artex.mjs';

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
