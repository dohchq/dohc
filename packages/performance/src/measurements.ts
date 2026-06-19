import { readFile } from "node:fs/promises";
import type { BudgetName, RatchetName } from "./budgets";

// The on-disk shape of test-results/performance/desktop-performance.json,
// written by apps/desktop/e2e/performance.spec.ts and consumed by
// scripts/check-performance.mjs.

export interface MeasuredMetric {
  valueMs: number;
}

// A scenario whose product seam does not exist yet. NEVER a faked number:
// the reason must name the deferred plan phase, or the check fails.
export interface SkippedMetric {
  skipped: true;
  reason: string;
}

export type MetricRecord = MeasuredMetric | SkippedMetric;

// Resource ratchet sample: the current value plus the previously recorded
// baseline (absent on the first ever measurement, which establishes it).
export interface RatchetMetric {
  value: number;
  baseline?: number;
}

export interface MachineContext {
  platform: string;
  nproc: number;
  totalMemGb: number;
  note?: string;
}

export interface MeasurementsFile {
  recordedAt: string;
  machine: MachineContext;
  metrics: Partial<Record<BudgetName, MetricRecord>>;
  ratchets?: Partial<Record<RatchetName, RatchetMetric>>;
  // Per-budget written justification required to apply PERF_BUDGET_MULTIPLIER
  // to that budget; each must name the hardware constraint.
  multiplierJustifications?: Partial<Record<BudgetName, string>>;
}

export function isSkipped(record: MetricRecord): record is SkippedMetric {
  return "skipped" in record && record.skipped === true;
}

function fail(detail: string): never {
  throw new Error(`Invalid performance measurements file: ${detail}`);
}

// Strict parse: a malformed results file must fail the gate loudly, never
// read as "all metrics missing" or silently pass.
export function parseMeasurements(text: string): MeasurementsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    fail(`not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  if (typeof raw !== "object" || raw === null) fail("top level is not an object");
  const file = raw as Record<string, unknown>;
  if (typeof file.recordedAt !== "string") fail("missing recordedAt");
  const machine = file.machine as Record<string, unknown> | undefined;
  if (
    typeof machine !== "object" ||
    machine === null ||
    typeof machine.platform !== "string" ||
    typeof machine.nproc !== "number" ||
    typeof machine.totalMemGb !== "number"
  ) {
    fail("machine context must record platform, nproc, and totalMemGb");
  }
  const metrics = file.metrics as Record<string, unknown> | undefined;
  if (typeof metrics !== "object" || metrics === null) fail("missing metrics object");
  for (const [name, record] of Object.entries(metrics)) {
    if (typeof record !== "object" || record === null) fail(`metric "${name}" is not an object`);
    const m = record as Record<string, unknown>;
    if (m.skipped === true) {
      if (typeof m.reason !== "string" || m.reason.trim() === "") {
        fail(`skipped metric "${name}" has no reason`);
      }
    } else if (typeof m.valueMs !== "number" || !Number.isFinite(m.valueMs) || m.valueMs < 0) {
      fail(`metric "${name}" has no finite non-negative valueMs`);
    }
  }
  if (file.ratchets !== undefined) {
    if (typeof file.ratchets !== "object" || file.ratchets === null) fail("ratchets is not an object");
    for (const [name, record] of Object.entries(file.ratchets as Record<string, unknown>)) {
      const r = record as Record<string, unknown> | null;
      if (
        typeof r !== "object" ||
        r === null ||
        typeof r.value !== "number" ||
        !Number.isFinite(r.value) ||
        r.value < 0
      ) {
        fail(`ratchet "${name}" has no finite non-negative value`);
      }
      if (
        r.baseline !== undefined &&
        (typeof r.baseline !== "number" || !Number.isFinite(r.baseline) || r.baseline <= 0)
      ) {
        fail(`ratchet "${name}" baseline is not a finite positive number`);
      }
    }
  }
  if (file.multiplierJustifications !== undefined) {
    if (
      typeof file.multiplierJustifications !== "object" ||
      file.multiplierJustifications === null ||
      Array.isArray(file.multiplierJustifications)
    ) {
      fail("multiplierJustifications is not an object");
    }
    for (const [name, justification] of Object.entries(
      file.multiplierJustifications as Record<string, unknown>,
    )) {
      if (typeof justification !== "string" || justification.trim() === "") {
        fail(`multiplier justification "${name}" must be a non-empty string`);
      }
    }
  }
  return file as unknown as MeasurementsFile;
}

export async function loadMeasurements(path: string): Promise<MeasurementsFile> {
  return parseMeasurements(await readFile(path, "utf8"));
}
