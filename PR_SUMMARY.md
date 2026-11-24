# Product investigation and controlled repair lifecycle

This branch adds the source-first product investigation and revision-bound repair lifecycle described in the pull
request. It also removes the unsafe autonomous ARTEX claim inherited from the branch history.

The lifecycle now supports:

- bounded source discovery at an exact Git commit;
- finding-bound deterministic JSON repair preparation;
- workspace validation of the finding, approved initiative, completed task, merged suggestion, repository and
  registered non-production environment;
- CI check selection from protected-branch configuration;
- host-owned deployment of the exact merged commit;
- revision-bound runtime verification;
- verified rollback and failed-verification investigation callbacks;
- optional metadata-only Sentry, log and trace evidence with explicit coverage gaps;
- handoff to existing independent remediation verification and closure.

ARTEX remains available through offline CSV import. The new `ArtexVerificationService` persists trusted authorization
before a narrow, host-brokered verification and rejects scope drift, expiry, production environments, broader goals
and revision-mismatched results. Direct ARTEX execution and the active red-team workflow remain unavailable until a
legally approved, reproducibly pinned, per-action broker exists.

Validation commands:

```bash
npm test
npm run validate
```

No passing test in this branch claims that a live assessment, CI provider, deployment provider or production service
was exercised. Those are host integrations and need controlled operational validation.
