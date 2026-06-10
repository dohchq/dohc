#!/usr/bin/env node
// Phase 16 hard gate: every required desktop measurement must exist and be
// under its budget. Budgets live ONLY in packages/performance/src/budgets.ts;
// this script imports the TypeScript source through the repo's tsx loader —
// the table is never duplicated here.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { register } = await import("tsx/esm/api");
register();
const {
  performanceBudgets,
  regressionRatchets,
  assertBudget,
  assertRatchet,
  resolveMultiplier,
  loadMeasurements,
} = await import(pathToFileURL(join(root, "packages/performance/src/index.ts")).href);

const file = join(root, "test-results/performance/desktop-performance.json");
if (!existsSync(file)) {
  console.error(`Missing ${file}`);
  console.error(
    "Run the desktop performance E2E first: pnpm --filter @dohc/desktop build && pnpm test:desktop:e2e apps/desktop/e2e/performance.spec.ts",
  );
  process.exit(1);
}

const data = await loadMeasurements(file);
const multiplier = resolveMultiplier(process.env, data.multiplierJustifications ?? {});

const checks = [];
for (const metric of Object.keys(performanceBudgets)) {
  checks.push(assertBudget(metric, data.metrics[metric], multiplier));
}
// Relative-regression ratchets: multipliers NEVER apply (assertRatchet
// ignores its multiplier argument by contract). Baselines come from the
// COMMITTED packages/performance/baselines.json — the measurements JSON is
// gitignored and freshly written every run, so a baseline stored there would
// never survive into CI and the growth rules would be dead code. An absent
// committed entry is a true first run (establish it by committing the value).
const baselinesFile = join(root, "packages/performance/baselines.json");
const baselines = existsSync(baselinesFile)
  ? JSON.parse(await readFile(baselinesFile, "utf8"))
  : {};
for (const name of Object.keys(regressionRatchets)) {
  const measured = data.ratchets?.[name];
  const baseline = baselines[name];
  if (baseline !== undefined && (typeof baseline !== "number" || !Number.isFinite(baseline))) {
    throw new Error(`Committed baseline "${name}" is not a finite number: ${baseline}`);
  }
  checks.push(
    assertRatchet(name, measured && baseline !== undefined ? { ...measured, baseline } : measured),
  );
}

const STATUS = { pass: "PASS", fail: "FAIL", skipped: "SKIP" };
const rows = checks.map((check) => [
  check.metric,
  check.actualMs === null ? "—" : String(check.actualMs),
  String(check.effectiveBudgetMs),
  STATUS[check.status],
]);
const header = ["metric", "actual", "budget", "status"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");

console.log(`Machine: ${data.machine.platform} | nproc=${data.machine.nproc} | mem=${data.machine.totalMemGb}GB`);
if (data.machine.note) console.log(`Note:    ${data.machine.note}`);
console.log(`Recorded: ${data.recordedAt}`);
if (multiplier) console.log(`PERF_BUDGET_MULTIPLIER=${multiplier.value} (per-budget justifications required)`);
console.log();
console.log(line(header));
console.log(line(widths.map((w) => "-".repeat(w))));
for (const row of rows) console.log(line(row));
console.log();
for (const check of checks) {
  if (check.status !== "pass") console.log(`${STATUS[check.status]}: ${check.message}`);
}

const failed = checks.filter((check) => check.status === "fail");
if (failed.length > 0) {
  console.error(`\n${failed.length} performance check(s) failed.`);
  process.exit(1);
}
console.log("\nAll performance budgets satisfied.");
