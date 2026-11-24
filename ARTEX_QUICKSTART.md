# ARTEX integration quick start

Direct ARTEX execution is disabled. Do not install an ARTEX binary, configure PostgreSQL credentials, or invoke a
network target from this repository.

## Validate the safe integration boundary

```bash
npm ci
node --test .claude/scripts/tests/artex-verification.test.mjs
npm run validate
```

The focused tests construct `ArtexVerificationService` with in-memory host adapters and verify that:

- authorization is trusted, scope-bound and persisted before execution;
- only one existing finding in one registered non-production environment is selected;
- the selected environment uses credential-free HTTPS URLs;
- authorization expiry or scope drift stops before the broker call;
- the result matches the original finding fingerprint and exact deployed revision;
- compare-and-swap prevents duplicate concurrent execution;
- direct `.claude/scripts/artex/run.mjs` execution stays disabled.

## Host integration

A hosted system may import `ArtexVerificationService` from `.claude/scripts/artex/service.mjs` and provide:

- `authorize`: authenticates the operator for `artex.authorize`, `artex.read`, and `artex.execute`;
- `loadScope`: resolves the current registered environment, HTTPS URLs, original finding and deployed commit;
- `verifyAuthorization`: checks the external approval and returns only its reference, digest and validity metadata;
- `executor`: invokes a legally approved per-action broker, deduplicated by `operationId`.

The repository does not provide that broker. The active `runtime-probe-redteam` workflow therefore returns
`status: "unavailable"`. Completed ARTEX CSV reports can still be imported using the command documented in README.

See `ARTEX-INTEGRATION.md` for the full contract and safety rationale.
