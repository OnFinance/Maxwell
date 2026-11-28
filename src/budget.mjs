// Spend tracker for nested `claude -p` runs. Every run gets a hard cap (`--max-budget-usd`) carved out of what is
// left, so the sum of caps never exceeds the total even when runs execute concurrently.
export class Budget {
  constructor(totalUsd, { safety = 0.9 } = {}) {
    this.total = Math.max(0, totalUsd);
    this.usable = this.total * safety;
    this.spent = 0;
    this.reserved = 0;
  }

  get available() {
    return Math.max(0, this.usable - this.spent - this.reserved);
  }

  /** Reserve up to `want` dollars; returns the granted cap (0 when below `min`). */
  reserve(want, min = 0.02) {
    const cap = Math.min(want, this.available);
    if (cap < min) return 0;
    this.reserved += cap;
    return cap;
  }

  /** Release a reservation and record what the run actually cost. */
  settle(cap, actual) {
    this.reserved = Math.max(0, this.reserved - cap);
    this.spent += Math.max(0, Number(actual) || 0);
  }
}

/** Total budget in USD from the environment (MAXWELL_EVAL_BUDGET_USD wins), falling back to `fallback`. */
export function budgetFromEnv(env = process.env, fallback = 5) {
  for (const key of ['MAXWELL_EVAL_BUDGET_USD', 'MAXWELL_BUDGET_USD']) {
    const n = Number.parseFloat(env[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}
