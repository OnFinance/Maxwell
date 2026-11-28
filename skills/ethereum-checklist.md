# Ethereum / Solidity vulnerability checklist

Each section names the taxonomy category to use. "Report" lists what qualifies; "Not a finding" lists common
false alarms.

## reentrancy
- Report: an external call (`call`, `transfer` of ERC777/ERC721/ERC1155 tokens with hooks, `safeTransferFrom`,
  arbitrary `IERC20` of unknown tokens, callbacks) made before the state that it depends on is updated, with no
  reentrancy guard, letting the callee re-enter and repeat a withdrawal, mint or accounting step. Includes
  cross-function and read-only reentrancy (a view used for pricing read mid-update).
- Locate on the external call line (and the late state update if adjacent).
- Not a finding: checks-effects-interactions respected; `nonReentrant` on all affected entry points;
  `transfer`/`send` with a 2300 gas stipend to an EOA-controlled recipient where no state is reused.

## access_control
- Report: state-changing functions that should be restricted but are `public`/`external` without a modifier or
  `msg.sender` check (ownership change, mint, withdraw-all, pause, set price/oracle, `selfdestruct`); `tx.origin`
  used for authorisation; constructors misnamed in old compilers (function named like the contract in
  < 0.4.22, so anyone can call it); unprotected `initialize`; `delegatecall` to a user-supplied address;
  default `public` visibility on sensitive functions in < 0.5.
- Not a finding: an owner having powers by design.

## arithmetic
- Report: overflow/underflow in Solidity < 0.8 without SafeMath on balances, supplies, prices, lock times or
  array lengths, where the wrap benefits an attacker; any `unchecked` block whose bounds are not guaranteed;
  unsafe downcasts (`uint128(x)`) of attacker-influenced values; precision loss from division before
  multiplication that lets users extract value.
- Not a finding: 0.8+ checked arithmetic; counters that can never realistically wrap.

## unchecked_low_level_calls
- Report: `call`, `send`, `delegatecall`, `staticcall` (or `callcode`) whose boolean result is ignored, so a failed
  payment is treated as success and state proceeds (e.g. marking a payout done). Also ERC20 `transfer`/
  `transferFrom` return values ignored for tokens that return false.
- Locate on the call whose result is ignored.

## denial_of_service
- Report: loops over unbounded, user-growable arrays in functions that must succeed; a push-payment to an address
  that can revert (refund to the previous leader, batch payouts) blocking progress; reliance on
  `address(this).balance` equality that forced ether breaks; gas griefing that permanently locks funds.

## front_running
- Report: transaction-order dependence an attacker can profit from: unprotected commit-free answers or puzzles
  paid on first submission, ERC20 `approve` race only if the code uses it in a harmful way, swaps or mints
  without slippage/deadline protection, first-depositor share-inflation attacks on vaults.

## time_manipulation
- Report: `block.timestamp`/`now` used as a randomness source or with a granularity where a miner/validator
  shift of seconds changes who wins or unlocks funds early.
- Not a finding: timestamps for coarse deadlines (hours/days).

## bad_randomness
- Report: randomness derived from `block.timestamp`, `blockhash`, `block.number`, `block.difficulty`/
  `prevrandao`, `msg.sender` or other predictable state deciding a lottery, game or selection with value.

## short_addresses
- Report: functions taking `address` and an amount from raw calldata (old compilers, no length checks) where a
  truncated address shifts the amount. Rare; only when clearly applicable.

## crypto_verification
- Report: `ecrecover` without checking the result against zero or the expected signer; signatures without nonce,
  chain id, contract address or expiry (replay); malleable `s` values accepted when uniqueness matters; hash
  collisions from `abi.encodePacked` with multiple dynamic arguments used as a signed message or key; Merkle
  proofs where leaves and internal nodes can be confused.

## upgradeability
- Report: implementation contracts with unprotected `initialize` or a missing `_disableInitializers`; storage
  layout collisions between proxy and implementation; `selfdestruct`/`delegatecall` reachable in an
  implementation; UUPS `_authorizeUpgrade` without access control.

## governance
- Report: voting power measured at the current block (flash-loan voting), proposals executable without quorum or
  timelock as designed by the code, double voting via token transfer.

## accounting
- Report: incorrect bookkeeping that lets users withdraw more than deposited, share/asset conversion rounding in the
  user's favour, fee-on-transfer or rebasing tokens credited at nominal amount, reward-per-share not updated before
  balance changes, oracle prices taken from manipulable spot reserves.

## other
- Anything exploitable that fits none of the above (logic errors, locked ether with no withdrawal path that loses
  user funds, incorrect inheritance order breaking a guard).
