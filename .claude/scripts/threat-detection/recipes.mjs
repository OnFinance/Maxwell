// Deterministic detection candidates, not confirmed incidents or regulatory findings.
export const RECIPES = Object.freeze([
  { id: 'authentication-failure-burst', version: 1, title: 'Repeated authentication failures', severity: 'medium', windowMs: 300000, threshold: 5, groupBy: 'actorKey', type: 'authentication' },
  { id: 'password-spray', version: 1, title: 'One source failing authentication for multiple identities', severity: 'high', windowMs: 300000, threshold: 5, groupBy: 'sourceKey', type: 'authentication' },
  { id: 'failure-then-success', version: 1, title: 'Successful authentication after repeated failures from the same source', severity: 'high', windowMs: 300000, threshold: 5, groupBy: 'actorSource', type: 'authentication' },
  { id: 'privileged-access-granted', version: 1, title: 'Privileged access granted successfully', severity: 'high', windowMs: 0, type: 'privilege-grant' },
  { id: 'audit-logging-disabled', version: 1, title: 'Audit logging disabled successfully', severity: 'high', windowMs: 0, type: 'audit-disable' },
].map(Object.freeze));
