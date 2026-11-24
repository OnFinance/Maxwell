# ARTEX integration

Maxwell supports completed ARTEX report import and a fail-closed contract for future, narrowly scoped remediation
verification. Maxwell does not currently launch upstream ARTEX.

## Supported paths

### Offline assessment import

Import a completed ARTEX CSV with `npm run import:artex`. The importer validates and normalizes candidate findings
before they enter Maxwell's append-only SOC ledger. See the main README for the current command and RBI review
worksheet.

### Revision-bound verification contract

`.claude/scripts/artex/service.mjs` exports `ArtexVerificationService` for a trusted host integration. It:

1. Resolves one existing finding and one registered non-production environment through a host scope adapter.
2. Normalizes credential-free HTTPS targets and binds them to the finding fingerprint and exact deployed commit.
3. Requires a trusted authorization adapter to return an authorization ID, approver, validity window, external
   document reference and document SHA-256 bound to the scope digest.
4. Persists that authorization in an immutable, digest-chained state journal before any external effect.
5. Claims execution with compare-and-swap and calls a host broker with an idempotent operation ID.
6. Accepts only `reproduced`, `not-reproduced`, `inconclusive`, or `blocked` results for the same finding, fingerprint
   and deployed revision. Every evidence reference needs a SHA-256.

The service never accepts credentials, stores an authorization document, launches a process or performs a network
request. `.claude/scripts/artex/run.mjs` disables direct execution. The active `runtime-probe-redteam` workflow remains
unavailable until an approved host broker exists.

## Why direct execution is disabled

The inherited integration invoked an undocumented `artex run --config` command, persisted database credentials and
ran the engine as an opaque process. That cannot satisfy Maxwell's rule that each runtime probe action pass through
its sandbox policy. The documented upstream source also needs legal review before online-system use. Maxwell must not
claim autonomous assessment or exploitability until both issues are resolved.

A production broker must provide all of these guarantees:

- legal approval for the selected engine and use case;
- reproducible source and artifact digests with self-update disabled;
- per-action authorization and target enforcement, rather than one opaque command;
- non-production-only remediation verification;
- exact deployed-revision checks before and after execution;
- bounded, redacted evidence with integrity hashes;
- idempotency by Maxwell operation ID;
- no unrelated discovery during verification mode.

## Ledger boundary

ARTEX task state stays in the immutable session state journal. The SOC ledger continues to accept only controls,
observations, findings, risks and incidents. Attack paths and ARTEX task objects are not SOC ledger record kinds.
A supported result still passes independent refutation. Finding closure continues through Maxwell's remediation
verification and an independent reviewer.

## Tests

```bash
node --test .claude/scripts/tests/artex-verification.test.mjs
npm run validate
```

The tests use injected host adapters. They do not execute ARTEX or contact a target.
