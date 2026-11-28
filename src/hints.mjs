// Deterministic pre-analysis: cheap lexical signals that point reviewers at security-relevant lines.
// Hints are never reported as findings on their own; they only steer the specialist reviewers and rank files.
import { stripComments } from './discover.mjs';

const PATTERNS = {
  ethereum: [
    ['low-level call', /\.call\s*[({]|\.call\.value\s*\(/],
    ['delegatecall', /\bdelegatecall\b/],
    ['send/transfer of ether', /\.(send|transfer)\s*\(/],
    ['tx.origin', /\btx\.origin\b/],
    ['block timestamp', /\bblock\.timestamp\b|\bnow\b/],
    ['block-derived randomness', /\bblockhash\b|\bblock\.(difficulty|prevrandao|number|coinbase)\b/],
    ['selfdestruct', /\b(selfdestruct|suicide)\s*\(/],
    ['signature recovery', /\becrecover\b|\bECDSA\.|\bSignatureChecker\b/],
    ['unchecked arithmetic block', /\bunchecked\s*\{/],
    ['inline assembly', /\bassembly\s*(\(|\{|")/],
    ['initializer', /\binitiali[sz]e\w*\s*\(|\binitializer\b/],
    ['payable entry point', /\bpayable\b/],
  ],
  solana: [
    ['unchecked account (no type validation)', /\bAccountInfo\s*<|\bUncheckedAccount\s*</],
    ['cross-program invocation', /\binvoke(_signed)?\s*\(|\bCpiContext::/],
    ['PDA derivation', /\bcreate_program_address\b|\bfind_program_address\b|\bbump\b/],
    ['manual deserialisation', /\btry_from_slice\b|\bdeserialize\s*\(|\bunpack(_unchecked)?\s*\(/],
    ['signer check', /\bis_signer\b|\bSigner\s*</],
    ['owner check', /\.owner\b/],
    ['account closing', /\bclose\s*=|\blamports\.borrow_mut\(\)|\*\*.*lamports/],
    ['sysvar access', /\bsysvar\b|\bSysvar\b|\bfrom_account_info\b/],
    ['mutable account', /#\[account\([^)]*\bmut\b|\bis_writable\b/],
    ['initialisation', /\binit(_if_needed)?\b|\bis_initialized\b/],
  ],
};

/** Return [{ line, label }] for one file (1-based lines). */
export function fileHints(chain, text) {
  const out = [];
  const lines = stripComments(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const [label, re] of PATTERNS[chain] ?? []) {
      if (re.test(lines[i])) out.push({ line: i + 1, label });
    }
  }
  return out;
}

/** Solidity pragma below 0.8 means arithmetic wraps silently unless SafeMath is used. */
export function legacyArithmetic(text) {
  const m = /pragma\s+solidity\s+([^;]+);/.exec(text);
  if (!m) return false;
  const v = /0\.(\d+)/.exec(m[1]);
  return Boolean(v) && Number(v[1]) < 8;
}

/** Rank score: how many distinct signal kinds a file has (used to order work under a tight budget). */
export function riskScore(chain, text) {
  const kinds = new Set(fileHints(chain, text).map((h) => h.label));
  let score = kinds.size;
  if (chain === 'ethereum' && legacyArithmetic(text)) score += 1;
  return score;
}
