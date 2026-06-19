import {
  performanceBudgets,
  regressionRatchets,
  type BudgetName,
  type RatchetName,
} from "./budgets";
import { isSkipped, type MetricRecord, type RatchetMetric } from "./measurements";

// Loosening a budget for constrained CI hardware is an explicit, justified
// act: the multiplier comes only from PERF_BUDGET_MULTIPLIER, is capped at
// 3.0, and applies to a budget only with a written justification for THAT
// budget naming the hardware constraint.
export interface BudgetMultiplier {
  value: number;
  justifications: Partial<Record<BudgetName, string>>;
}

const HARDWARE_CONSTRAINT = /\b(cpu|core|memory|ram|disk|io|gpu|display|virtualiz\w*|wsl|hardware|runner)\b/i;

export function resolveMultiplier(
  env: { PERF_BUDGET_MULTIPLIER?: string },
  justifications: Partial<Record<BudgetName, string>> = {},
): BudgetMultiplier | null {
  const raw = env.PERF_BUDGET_MULTIPLIER;
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`PERF_BUDGET_MULTIPLIER must be a number >= 1, got "${raw}"`);
  }
  if (value > 3) {
    throw new Error(
      `PERF_BUDGET_MULTIPLIER is capped at 3.0 (got ${value}); a slower environment than 3x is not a valid measurement environment`,
    );
  }
  return { value, justifications };
}

export interface BudgetCheck {
  metric: string;
  budgetMs: number;
  effectiveBudgetMs: number;
  actualMs: number | null;
  status: "pass" | "fail" | "skipped";
  message: string;
}

// A scenario may be skipped ONLY because its product seam is deferred to a
// named plan phase ("Phase 7b"). Anything else is a missing measurement.
const DEFERRED_PHASE = /\bphase[ -]?\d+[a-z]?\b/i;

export function assertBudget(
  metric: BudgetName,
  record: MetricRecord | undefined,
  multiplier: BudgetMultiplier | null = null,
): BudgetCheck {
  const budgetMs = performanceBudgets[metric];
  if (record === undefined) {
    return {
      metric,
      budgetMs,
      effectiveBudgetMs: budgetMs,
      actualMs: null,
      status: "fail",
      message: `${metric}: MISSING measurement (budget ${budgetMs}ms) — run the desktop performance E2E to record it`,
    };
  }
  if (isSkipped(record)) {
    if (!DEFERRED_PHASE.test(record.reason)) {
      return {
        metric,
        budgetMs,
        effectiveBudgetMs: budgetMs,
        actualMs: null,
        status: "fail",
        message: `${metric}: skipped without naming a deferred plan phase ("${record.reason}") — skips are only valid for seams deferred to a named phase`,
      };
    }
    return {
      metric,
      budgetMs,
      effectiveBudgetMs: budgetMs,
      actualMs: null,
      status: "skipped",
      message: `${metric}: skipped — ${record.reason}`,
    };
  }

  let effectiveBudgetMs = budgetMs;
  if (multiplier !== null && multiplier.value > 1) {
    const justification = multiplier.justifications[metric];
    if (justification === undefined || justification.trim() === "") {
      throw new Error(
        `PERF_BUDGET_MULTIPLIER=${multiplier.value} requires a written justification for "${metric}" naming the hardware constraint; none was provided`,
      );
    }
    if (!HARDWARE_CONSTRAINT.test(justification)) {
      throw new Error(
        `Justification for "${metric}" must name the hardware constraint (cpu/memory/disk/gpu/display/...): "${justification}"`,
      );
    }
    effectiveBudgetMs = budgetMs * multiplier.value;
  }

  const actualMs = record.valueMs;
  if (actualMs <= effectiveBudgetMs) {
    return {
      metric,
      budgetMs,
      effectiveBudgetMs,
      actualMs,
      status: "pass",
      message: `${metric}: ${actualMs}ms <= ${effectiveBudgetMs}ms`,
    };
  }
  const multiplierNote =
    effectiveBudgetMs !== budgetMs ? ` (base ${budgetMs}ms x ${multiplier?.value})` : "";
  return {
    metric,
    budgetMs,
    effectiveBudgetMs,
    actualMs,
    status: "fail",
    message: `${metric} is over budget: actual ${actualMs}ms > budget ${effectiveBudgetMs}ms${multiplierNote}`,
  };
}

// Relative-regression ratchets (20% memory / 10% bundle). Environment
// multipliers NEVER apply here — the third parameter exists so call sites
// passing one cannot accidentally relax a ratchet; it is deliberately ignored.
export function assertRatchet(
  name: RatchetName,
  record: RatchetMetric | undefined,
  _ignoredMultiplier: BudgetMultiplier | null = null,
): BudgetCheck {
  const ratchet = regressionRatchets[name];
  if (record === undefined) {
    return {
      metric: name,
      budgetMs: ratchet.initialTarget,
      effectiveBudgetMs: ratchet.initialTarget,
      actualMs: null,
      status: "fail",
      message: `${name}: MISSING measurement (initial target ${ratchet.initialTarget}${ratchet.unit})`,
    };
  }
  if (record.baseline !== undefined) {
    const limit = record.baseline * ratchet.maxGrowthRatio;
    if (record.value > limit) {
      const growthPct = Math.round((record.value / record.baseline - 1) * 100);
      return {
        metric: name,
        budgetMs: limit,
        effectiveBudgetMs: limit,
        actualMs: record.value,
        status: "fail",
        message: `${name} regressed ${growthPct}% over baseline ${record.baseline}${ratchet.unit} (limit ${Math.round((ratchet.maxGrowthRatio - 1) * 100)}%) — regressions are never deferrable and multipliers never apply`,
      };
    }
    return {
      metric: name,
      budgetMs: limit,
      effectiveBudgetMs: limit,
      actualMs: record.value,
      status: "pass",
      message: `${name}: ${record.value}${ratchet.unit} within ${Math.round((ratchet.maxGrowthRatio - 1) * 100)}% of baseline ${record.baseline}${ratchet.unit}`,
    };
  }
  const targetNote =
    record.value > ratchet.initialTarget
      ? ` (over the ${ratchet.initialTarget}${ratchet.unit} initial target — recorded for investigation)`
      : ` (initial target ${ratchet.initialTarget}${ratchet.unit})`;
  return {
    metric: name,
    budgetMs: ratchet.initialTarget,
    effectiveBudgetMs: ratchet.initialTarget,
    actualMs: record.value,
    status: "pass",
    message: `${name}: ${record.value}${ratchet.unit} recorded as first baseline${targetNote}`,
  };
}
