# Attack classes

Seed coverage from the target's actual entry points and trust boundaries. Use these stable identifiers:

- `authentication-session`
- `authorization-object-access`
- `injection-interpreter`
- `file-path-parser`
- `ssrf-egress`
- `secrets-cryptography`
- `data-isolation-lifecycle`
- `logging-error-disclosure`
- `business-logic-race`
- `supply-chain-release`
- `cloud-deployment-identity`
- `client-side-browser`
- `protocol-messaging`
- `resource-exhaustion`
- `ai-agent-tool-boundary`
- `memory-safety-binary`

Do not seed every class mechanically. Include a class only when reconnaissance identifies a reachable surface or a
material absence that itself needs review. Record excluded classes with a reason in the architecture export.
