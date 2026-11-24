# ARTEX operationalization status

The earlier autonomous-execution proposal is not shipped. Its runner used an unsupported upstream CLI and bypassed
Maxwell's per-action sandbox controls. Direct execution is now disabled.

Implemented components:

- completed ARTEX CSV import and regulatory review;
- an immutable authorization and revision-bound verification service contract;
- exact non-production scope, finding fingerprint and deployed-commit binding;
- compare-and-swap execution claims and evidence digest validation;
- a fail-closed workflow entry point;
- independent product investigation, approved CI gates, host deployment adapters, rollback and re-investigation;
- optional metadata-only Sentry, log and trace collector contracts.

Still required outside this repository:

- legal approval for the chosen assessment engine;
- a reproducibly pinned engine artifact;
- a host broker that applies Maxwell policy to every target action;
- provider-specific CI, deployment, log and trace adapters;
- operational validation in a controlled non-production environment.

See `ARTEX-INTEGRATION.md` and the main README. Passing unit tests validate service contracts, not a live ARTEX run.
