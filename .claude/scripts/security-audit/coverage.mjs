import { contentHash, AUDIT_PROFILES, ATTACK_CLASSES, validateCoverageLedger } from './contracts.mjs';

const TRANSITIONS = Object.freeze({
  planned: new Set(['assigned', 'deferred', 'blocked', 'out_of_scope']),
  assigned: new Set(['covered', 'candidate', 'deferred', 'blocked']),
  covered: new Set(['assigned', 'candidate']),
  candidate: new Set(['covered', 'blocked']),
  deferred: new Set(['planned', 'out_of_scope']),
  blocked: new Set(['planned', 'out_of_scope']),
  out_of_scope: new Set(['planned']),
});

const slug = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

export function coverageUnitId({ repo, subsystem, boundary, attackClass }) {
  const readable = [repo, subsystem, boundary, attackClass].map(slug).join('-').slice(0, 78).replace(/-$/, '');
  return `cov_${readable}_${contentHash({ repo, subsystem, boundary, attackClass }).slice(0, 12)}`;
}

export function createCoverageUnit(input) {
  const unit = {
    id: coverageUnitId(input), repo: input.repo, subsystem: input.subsystem, boundary: input.boundary,
    attackClass: input.attackClass, state: input.state || 'planned', evidence: input.evidence || [],
  };
  if (input.priority !== undefined) unit.priority = input.priority;
  if (input.reason) unit.reason = input.reason;
  if (input.owner) unit.owner = input.owner;
  return unit;
}

export function seedCoverageUnits(repositories, { profile = 'standard', scopePaths = [] } = {}) {
  if (!AUDIT_PROFILES.includes(profile)) throw new Error(`invalid audit profile: ${profile}`);
  const units = [];
  for (const repository of repositories) {
    const repo = `${repository.appId}/${repository.repoId}`;
    const surfaces = Array.isArray(repository.surfaces) ? repository.surfaces : [];
    const scoped = !scopePaths.length || scopePaths.some((path) => path === repo || path.startsWith(`${repo}/`));
    for (const surface of surfaces) {
      const subsystem = profile === 'quick' ? 'profile/quick/all-in-scope-subsystems' : surface.subsystem;
      for (const attackClass of [...new Set(surface.attackClasses || [])].filter((x) => ATTACK_CLASSES.includes(x))) {
        units.push(createCoverageUnit({
          repo, subsystem, boundary: surface.boundary, attackClass,
          state: scoped ? 'planned' : 'out_of_scope',
          priority: Number.isFinite(surface.priority) ? surface.priority : 0,
          reason: scoped ? undefined : 'outside requested scope',
        }));
      }
    }
  }
  return [...new Map(units.map((unit) => [unit.id, unit])).values()].sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id));
}

export function transitionCoverageUnit(unit, nextState, details = {}) {
  if (!TRANSITIONS[unit.state]?.has(nextState)) throw new Error(`illegal coverage transition: ${unit.state} -> ${nextState}`);
  const next = { ...unit, ...details, state: nextState };
  if (nextState === 'assigned' && !next.owner) throw new Error('assigned coverage unit requires owner');
  if (['covered', 'candidate'].includes(nextState) && !(next.evidence || []).length) throw new Error(`${nextState} coverage unit requires evidence`);
  if (['deferred', 'blocked', 'out_of_scope'].includes(nextState) && !next.reason) throw new Error(`${nextState} coverage unit requires reason`);
  if (nextState !== 'assigned') delete next.owner;
  return next;
}

export function budgetPlan({ profile = 'standard', budget = null, unitCount, expectedCandidates = 0 }) {
  if (!AUDIT_PROFILES.includes(profile)) throw new Error(`invalid audit profile: ${profile}`);
  const reconnaissance = 4;
  const critics = profile === 'quick' ? 1 : 2;
  const verifierPerCandidate = profile === 'quick' ? 1 : 2;
  const validation = Math.max(1, expectedCandidates * verifierPerCandidate);
  const mandatory = reconnaissance + critics + validation;
  const availableForHunters = budget === null ? unitCount : Math.max(0, budget - mandatory);
  return {
    profile, budget, reconnaissance, critics, validation,
    mandatory, hunterAllowance: Math.min(unitCount, availableForHunters),
    canStart: budget === null || budget >= mandatory,
  };
}

export function buildCoverageLedger({ runId, repositories, profile, scopePaths = [], budget = null, expectedCandidates = 0 }) {
  const units = seedCoverageUnits(repositories, { profile, scopePaths });
  const ledger = {
    schemaVersion: '1', kind: 'maxwell.security-audit.coverage', runId, profile,
    budget: budgetPlan({ profile, budget, unitCount: units.filter((x) => x.state === 'planned').length, expectedCandidates }), units,
  };
  const errors = validateCoverageLedger(ledger);
  if (errors.length) throw new Error(errors.join('; '));
  return ledger;
}
