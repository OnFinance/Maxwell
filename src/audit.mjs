// Audit pipeline: discover -> batch -> specialist review -> adversarial refutation -> SARIF.
import { Budget, budgetFromEnv } from './budget.mjs';
import { claudeAvailable, runClaude } from './claude.mjs';
import { discover } from './discover.mjs';
import { applyVerdicts, dedupeFindings, normaliseFindings } from './findings.mjs';
import { batchesWithinBudget, makeBatches } from './plan.mjs';
import {
  loadSchema, refuterPrompt, refuterSystemPrompt, reviewerPrompt, reviewerSystemPrompt,
} from './prompts.mjs';
import { buildSarif } from './sarif.mjs';
import { severityRank } from './taxonomy.mjs';

const DEFAULT_DEADLINE_MS = 18 * 60 * 1000;
const REVIEW_SHARE = 0.6;
const MAX_CALL_MS = 12 * 60 * 1000;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run a full audit and return a SARIF log object. Never throws for model or tool failures: those become
 * SARIF notifications and the run reports whatever survived refutation.
 * @param {object} o
 * @param {string} o.target
 * @param {'ethereum'|'solana'} o.chain
 * @param {Function} [o.runner] injectable `runClaude` replacement (tests)
 */
export async function audit({ target, chain, env = process.env, runner, log = () => {} }) {
  const started = Date.now();
  const deadline = started + (Number(env.MAXWELL_DEADLINE_MS) || DEFAULT_DEADLINE_MS);
  const budget = new Budget(budgetFromEnv(env));
  const notifications = [];
  const note = (level, message) => {
    notifications.push({ level, message });
    log(`[${level}] ${message}`);
  };
  const run = runner ?? runClaude;
  const reviewModel = env.MAXWELL_REVIEW_MODEL || 'opus';
  const refuteModel = env.MAXWELL_REFUTE_MODEL || 'opus';
  const concurrency = Math.max(1, Number(env.MAXWELL_CONCURRENCY) || 3);

  const { files, skipped } = discover(target, chain);
  const batches = makeBatches(chain, files);
  const chosen = batchesWithinBudget(batches, budget.usable);
  if (chosen.length < batches.length) {
    note('warning', `budget covers ${chosen.length} of ${batches.length} review batches; lowest-risk batches skipped`);
  }

  let available = chosen.length > 0;
  if (available && !runner) {
    available = await claudeAvailable(env);
    if (!available) note('error', 'claude CLI not found; no LLM review performed');
  }

  const reviewSchema = loadSchema('findings');
  const verdictSchema = loadSchema('verdicts');
  const reviewSystem = reviewerSystemPrompt(chain);
  const refuteSystem = refuterSystemPrompt(chain);
  const reviewCap = (budget.usable * REVIEW_SHARE) / Math.max(1, chosen.length);
  const refuteCap = (budget.usable * (1 - REVIEW_SHARE)) / Math.max(1, chosen.length);

  const timeLeft = () => deadline - Date.now();
  const call = async (label, args, want) => {
    if (timeLeft() < 45_000) {
      note('warning', `${label}: skipped, time limit reached`);
      return undefined;
    }
    const cap = budget.reserve(want);
    if (!cap) {
      note('warning', `${label}: skipped, budget exhausted`);
      return undefined;
    }
    const timeoutMs = Math.min(timeLeft() - 20_000, MAX_CALL_MS);
    const res = await run({ ...args, budgetUsd: cap, timeoutMs, env });
    budget.settle(cap, res.costUsd);
    if (!res.ok) {
      note('warning', `${label}: ${res.error}`);
      return undefined;
    }
    return res.output;
  };

  const perBatch = !available ? [] : await mapLimit(chosen, concurrency, async (batch, i) => {
    const label = `batch ${i + 1}/${chosen.length}`;
    log(`${label}: reviewing ${batch.files.length} file(s)`);
    const review = await call(`${label} review`, {
      prompt: reviewerPrompt(chain, batch.files),
      systemPrompt: reviewSystem,
      schema: reviewSchema,
      model: reviewModel,
    }, reviewCap);
    // Low and informational candidates are not worth refuting or reporting; drop them up front.
    const candidates = dedupeFindings(normaliseFindings(chain, review?.findings, batch.files))
      .filter((f) => severityRank(f.severity) >= severityRank('medium'));
    if (!candidates.length) return [];
    log(`${label}: refuting ${candidates.length} candidate(s)`);
    const refuted = await call(`${label} refutation`, {
      prompt: refuterPrompt(chain, batch.files, candidates),
      systemPrompt: refuteSystem,
      schema: verdictSchema,
      model: refuteModel,
    }, refuteCap);
    // Prefer silence to a false alarm: without a verdict nothing is reported.
    if (!refuted) return [];
    return applyVerdicts(chain, candidates, refuted.verdicts, batch.files);
  });

  const findings = dedupeFindings(perBatch.flat());
  log(`done: ${findings.length} finding(s), $${budget.spent.toFixed(4)} spent`);
  return buildSarif({
    chain,
    findings,
    costUsd: budget.spent,
    notifications,
    properties: {
      filesDiscovered: files.length,
      filesSkipped: skipped,
      batchesPlanned: batches.length,
      batchesReviewed: chosen.length,
      budgetUsd: budget.total,
      durationMs: Date.now() - started,
      reviewModel,
      refuteModel,
    },
  });
}
