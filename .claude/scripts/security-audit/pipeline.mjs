import { buildCoverageLedger } from './coverage.mjs';
import { applyCriticResult, applyHunterResult, planHunterAssignments } from './hunting.mjs';
import { decideCandidate, partitionVerdicts, verifyFinalRecord } from './verification.mjs';
import { mapVerdictsToSoc } from './exports.mjs';
import { mergeCurrentAndPriorUnits, reconcilePriorRun } from './reconcile.mjs';

export function runSecurityAuditPipeline(input) {
  const { metadata, architecture, repositories, hunterResults = [], criticResults = [], candidateVerdicts = {}, finalVerdicts = {}, priorRecords = [], currentSources = {} } = input;
  let coverage = buildCoverageLedger({
    runId: metadata.runId, repositories, profile: metadata.profile,
    scopePaths: metadata.scopePaths, budget: metadata.budget, expectedCandidates: input.expectedCandidates || 0,
  });
  const prior = reconcilePriorRun({ priorRecords, currentSources, profile: metadata.profile });
  coverage.units = mergeCurrentAndPriorUnits(coverage.units, prior);
  const plan = planHunterAssignments(coverage.units, { allowance: coverage.budget.hunterAllowance, wave: 1 });
  coverage.units = plan.units;
  for (const result of hunterResults) coverage.units = applyHunterResult(coverage.units, result);
  for (const result of criticResults) coverage.units = applyCriticResult(coverage.units, result, { profile: metadata.profile });

  const rawCandidates = [...hunterResults.flatMap((result) => result.candidates || []), ...prior.carriedCandidates];
  const candidateRecords = rawCandidates.map((candidate) => decideCandidate(candidate, candidateVerdicts[candidate.fingerprint] || { passed: false, blocker: 'independent candidate verification missing', validationPlan: 'assign a fresh verifier' }));
  const finalRecords = candidateRecords.map((record) => verifyFinalRecord(record, finalVerdicts[record.fingerprint] || (record.verdict === 'confirmed' ? { passed: false, blocker: 'final-record verification missing', validationPlan: 'assign a fresh final-record verifier' } : {})));
  const verdicts = partitionVerdicts(finalRecords);
  const soc = mapVerdictsToSoc(finalRecords, { collectedAt: metadata.createdAt });
  return {
    assignments: plan.assignments,
    prior,
    bundle: {
      sessionId: metadata.sessionId,
      run: metadata,
      architecture,
      coverage,
      candidates: { schemaVersion: '1', kind: 'maxwell.security-audit.candidates', runId: metadata.runId, records: candidateRecords },
      finalRecords: { schemaVersion: '1', kind: 'maxwell.security-audit.final-records', runId: metadata.runId, records: finalRecords },
    },
    verdicts,
    soc,
    complete: coverage.units.every((unit) => ['covered', 'candidate', 'out_of_scope'].includes(unit.state)) && verdicts.needs_validation.length === 0,
  };
}
