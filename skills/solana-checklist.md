# Solana vulnerability checklist (native and Anchor)

Each section names the taxonomy category to use. "Report" lists what qualifies; "Not a finding" lists common
false alarms.

## signer_authorization
- Report: an authority/owner/admin account that authorises a state change or transfer but is never checked to
  have signed: native `AccountInfo` without `if !acct.is_signer { return Err(..) }`; Anchor `AccountInfo` or
  `UncheckedAccount` where `Signer<'info>` is needed.
- Not a finding: `Signer<'info>` or a `signer` constraint is present.

## account_data_matching
- Report: an account's stored fields are trusted without checking they relate to the other accounts passed: a
  token account whose `owner`/`mint` is not compared with the expected authority/mint, a config account whose
  `authority` is not compared with the signer (missing `has_one` or `constraint = a.key() == b.authority`).

## owner_checks
- Report: native code deserialising account data (`try_from_slice`, `unpack`) without verifying
  `account.owner == program_id` (or the SPL token program for token accounts), so an attacker can pass a fake
  account they own with crafted data. Anchor: deserialising from `AccountInfo`/`UncheckedAccount` manually.
- Not a finding: `Account<'info, T>` (Anchor checks the owner).

## type_cosplay
- Report: two account types with compatible layouts and no discriminator check, so one can be passed as the
  other (native Borsh structs without a type tag checked on load; Anchor `#[account(zero_copy)]`/manual
  deserialisation bypassing the discriminator).

## initialization
- Report: an initialise instruction that can be called again on an initialised account (no
  `is_initialized` flag checked, or `init_if_needed` without guarding re-initialisation), letting an attacker
  overwrite the authority.
- Not a finding: Anchor `init` (fails when the account exists).

## arbitrary_cpi
- Report: `invoke`/`invoke_signed`/`CpiContext` where the target program account is taken from the caller and its
  key is never compared with the expected program id (e.g. the SPL token program), so an attacker substitutes
  their own program.
- Not a finding: `Program<'info, Token>` or an explicit `program.key == &spl_token::ID` check.

## duplicate_mutable_accounts
- Report: an instruction taking two mutable accounts of the same type (from/to, a/b) with no check that they are
  different, where passing the same account twice yields value (double credit, bypassed debit).

## bump_seed_canonicalization
- Report: `create_program_address` or a `seeds` + user-supplied `bump` that is not the canonical bump from
  `find_program_address`/Anchor `bump` (stored canonical bump not enforced), letting multiple valid PDAs exist.

## pda_sharing
- Report: a PDA whose seeds do not include a user- or pool-specific key (e.g. only the mint), so one PDA signs for
  several users' or pools' assets and a user can withdraw another's funds.

## closing_accounts
- Report: closing by draining lamports without zeroing data and setting the closed-account discriminator, or
  without assigning to the system program, so the account can be revived in the same transaction; also missing
  a check that the account is not already closed when it is reused.
- Not a finding: Anchor `close = destination`.

## sysvar_address_checking
- Report: a sysvar (rent, clock, instructions, ...) read from an `AccountInfo` without checking its key against the
  sysvar id, so an attacker can pass a fake sysvar account.
- Not a finding: `Sysvar<'info, T>`, `Clock::get()`, `Rent::get()`.

## other
- Anything exploitable that fits none of the above (arithmetic that mints value, missing slippage checks, logic
  errors in pricing or rewards).
