// Split discovered files into review batches and decide how many fit in the budget.
import { riskScore } from './hints.mjs';

export const DEFAULT_BATCH_CHARS = 90_000;

/**
 * Group files into batches of at most `maxChars` source characters, keeping files from the same directory
 * together so reviewers see related contracts side by side. Batches are ordered by descending risk.
 */
export function makeBatches(chain, files, { maxChars = DEFAULT_BATCH_CHARS } = {}) {
  const byDir = new Map();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  const batches = [];
  let current = { files: [], chars: 0, risk: 0 };
  const flush = () => {
    if (current.files.length) batches.push(current);
    current = { files: [], chars: 0, risk: 0 };
  };
  for (const dir of [...byDir.keys()].sort()) {
    for (const f of byDir.get(dir)) {
      if (current.chars + f.text.length > maxChars && current.files.length) flush();
      current.files.push(f);
      current.chars += f.text.length;
      current.risk += riskScore(chain, f.text);
    }
  }
  flush();
  return batches
    .map((b, i) => ({ ...b, index: i }))
    .sort((a, b) => b.risk / Math.max(1, b.files.length) - a.risk / Math.max(1, a.files.length) || a.index - b.index);
}

/**
 * How many batches the budget can cover. Each batch needs roughly one reviewer and one refuter run; the
 * per-batch estimate scales with its size (about $1 per 100k characters, never below `minPerBatch`).
 */
export function batchesWithinBudget(batches, budgetUsd, { minPerBatch = 0.4 } = {}) {
  const chosen = [];
  let planned = 0;
  for (const b of batches) {
    const estimate = Math.max(minPerBatch, (b.chars / 100_000) * 1.0);
    if (chosen.length && planned + estimate > budgetUsd) continue;
    chosen.push(b);
    planned += estimate;
  }
  return chosen;
}
