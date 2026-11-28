// Category taxonomy and severity model shared by prompts, normalisation and SARIF output.

export const CHAINS = Object.freeze(['ethereum', 'solana']);

export const TAXONOMY = Object.freeze({
  ethereum: Object.freeze([
    'access_control', 'arithmetic', 'bad_randomness', 'denial_of_service', 'front_running', 'reentrancy',
    'short_addresses', 'time_manipulation', 'unchecked_low_level_calls', 'crypto_verification', 'upgradeability',
    'governance', 'accounting', 'other',
  ]),
  solana: Object.freeze([
    'signer_authorization', 'account_data_matching', 'owner_checks', 'type_cosplay', 'initialization',
    'arbitrary_cpi', 'duplicate_mutable_accounts', 'bump_seed_canonicalization', 'pda_sharing', 'closing_accounts',
    'sysvar_address_checking', 'other',
  ]),
});

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'informational']);

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, informational: 0 };

export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? -1;
}

/** SARIF `level` for a Maxwell severity. */
export function sarifLevel(severity) {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    default:
      return 'note';
  }
}

/** Map a free-form category string onto the chain taxonomy; unknown values become `other`. */
export function normaliseCategory(chain, raw) {
  const allowed = TAXONOMY[chain];
  if (!allowed || typeof raw !== 'string') return 'other';
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.includes(key) ? key : 'other';
}

export function normaliseSeverity(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (key === 'info') return 'informational';
  return SEVERITIES.includes(key) ? key : 'informational';
}
