import { describe, expect, it } from "vitest";
import { assertBudget, assertRatchet, resolveMultiplier } from "./assertBudget";
import { performanceBudgets } from "./budgets";
import { parseMeasurements } from "./measurements";

describe("performanceBudgets", () => {
  // Pinned verbatim: any budget edit after first commit fails here and must be
  // named explicitly in that commit's Codex review prompt
  // ("budget X changed from A to B because C").
  it("pins the plan's budget table", () => {
    expect(performanceBudgets).toEqual({
      coldLaunchToShellMs: 2000,
      warmLaunchToShellMs: 1000,
      createEmptyWorkspaceMs: 1000,
      openThousandFileWorkspaceMs: 1500,
      fileTreeSearchTenThousandPathsMs: 100,
      fileTreeSearchVisibleResultMs: 200,
      openMarkdown250KbMs: 150,
      typingLongTaskMs: 50,
      singleFileSyncDetectMs: 2000,
      hundredFileChangeSetMs: 3000,
      warmAppOpenMs: 1000,
      appTesterSmallAppMs: 15000,
      sqliteTenThousandRowsFirstPageMs: 1000,
      csvTenThousandRowsImportMs: 5000,
      // Phase E5.0 additions (content search over the 10k-file fixture).
      contentSearchFirstResultMs: 300,
      contentSearchCompleteMs: 1500,
      searchKeystrokeLongTaskMs: 50,
    });
  });
});

describe("assertBudget", () => {
  it("passes a measurement under budget", () => {
    const check = assertBudget("coldLaunchToShellMs", { valueMs: 850 });
    expect(check.status).toBe("pass");
    expect(check.actualMs).toBe(850);
    expect(check.effectiveBudgetMs).toBe(2000);
  });

  it("fails an over-budget measurement with a message naming metric, actual, and budget", () => {
    const check = assertBudget("openMarkdown250KbMs", { valueMs: 412 });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("openMarkdown250KbMs");
    expect(check.message).toContain("412");
    expect(check.message).toContain("150");
  });

  it("fails a missing measurement", () => {
    const check = assertBudget("warmLaunchToShellMs", undefined);
    expect(check.status).toBe("fail");
    expect(check.message).toMatch(/missing/i);
    expect(check.message).toContain("warmLaunchToShellMs");
  });

  it("treats a skip naming a deferred plan phase as visible-but-not-failing", () => {
    const check = assertBudget("warmAppOpenMs", {
      skipped: true,
      reason: "In-app app runtime is deferred to plan Phase 7b",
    });
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("Phase 7b");
  });

  it("fails a skip that does not name a deferred plan phase", () => {
    const check = assertBudget("warmAppOpenMs", {
      skipped: true,
      reason: "did not feel like measuring",
    });
    expect(check.status).toBe("fail");
  });
});

describe("multipliers", () => {
  it("applies no multiplier when PERF_BUDGET_MULTIPLIER is unset", () => {
    expect(resolveMultiplier({})).toBeNull();
    // Over base budget stays a failure — there is no implicit CI loosening.
    const check = assertBudget("warmLaunchToShellMs", { valueMs: 1100 }, null);
    expect(check.status).toBe("fail");
  });

  it("relaxes a budget only with an explicit multiplier AND a per-budget hardware justification", () => {
    const multiplier = resolveMultiplier(
      { PERF_BUDGET_MULTIPLIER: "2" },
      { warmLaunchToShellMs: "CI runner is a 2-core shared VM with no GPU" },
    );
    const check = assertBudget("warmLaunchToShellMs", { valueMs: 1500 }, multiplier);
    expect(check.status).toBe("pass");
    expect(check.effectiveBudgetMs).toBe(2000);
  });

  it("caps the multiplier at 3.0", () => {
    expect(() => resolveMultiplier({ PERF_BUDGET_MULTIPLIER: "3.5" })).toThrow(/capped at 3/);
    expect(() => resolveMultiplier({ PERF_BUDGET_MULTIPLIER: "not-a-number" })).toThrow();
    expect(() => resolveMultiplier({ PERF_BUDGET_MULTIPLIER: "0.5" })).toThrow();
  });

  it("throws when a multiplier is set without a justification for that budget", () => {
    const multiplier = resolveMultiplier({ PERF_BUDGET_MULTIPLIER: "2" }, {});
    expect(() => assertBudget("warmLaunchToShellMs", { valueMs: 900 }, multiplier)).toThrow(
      /justification.*warmLaunchToShellMs/,
    );
  });

  it("throws when the justification does not name the hardware constraint", () => {
    const multiplier = resolveMultiplier(
      { PERF_BUDGET_MULTIPLIER: "2" },
      { warmLaunchToShellMs: "it was slow that day" },
    );
    expect(() => assertBudget("warmLaunchToShellMs", { valueMs: 900 }, multiplier)).toThrow(
      /hardware constraint/,
    );
  });
});

describe("assertRatchet (relative-regression ratchets)", () => {
  it("fails >20% memory growth even when a multiplier is in force (multipliers never apply)", () => {
    const multiplier = resolveMultiplier(
      { PERF_BUDGET_MULTIPLIER: "3" },
      { coldLaunchToShellMs: "cpu-starved CI runner" },
    );
    const check = assertRatchet(
      "workspaceMemoryWorkingSetMb",
      { value: 380, baseline: 300 },
      multiplier,
    );
    expect(check.status).toBe("fail");
    expect(check.message).toMatch(/never/i);
  });

  it("passes memory growth within 20%", () => {
    const check = assertRatchet("workspaceMemoryWorkingSetMb", { value: 350, baseline: 300 });
    expect(check.status).toBe("pass");
  });

  it("fails >10% bundle growth", () => {
    const check = assertRatchet("rendererInitialBundleMb", { value: 1.2, baseline: 1.0 }, null);
    expect(check.status).toBe("fail");
  });

  it("records a first measurement (no baseline) as the baseline instead of failing", () => {
    const check = assertRatchet("rendererInitialBundleMb", { value: 1.0 });
    expect(check.status).toBe("pass");
    expect(check.message).toMatch(/baseline/i);
  });

  it("fails a missing ratchet measurement", () => {
    expect(assertRatchet("workspaceMemoryWorkingSetMb", undefined).status).toBe("fail");
  });
});

describe("parseMeasurements", () => {
  const valid = {
    recordedAt: "2026-06-11T00:00:00.000Z",
    machine: { platform: "linux (WSL2)", nproc: 8, totalMemGb: 16 },
    metrics: {
      coldLaunchToShellMs: { valueMs: 900 },
      warmAppOpenMs: { skipped: true, reason: "Phase 7b" },
    },
    ratchets: { workspaceMemoryWorkingSetMb: { value: 250 } },
  };

  it("round-trips a valid file", () => {
    const parsed = parseMeasurements(JSON.stringify(valid));
    expect(parsed.metrics.coldLaunchToShellMs).toEqual({ valueMs: 900 });
  });

  it("rejects malformed files loudly", () => {
    expect(() => parseMeasurements("not json")).toThrow(/not valid JSON/);
    expect(() => parseMeasurements("{}")).toThrow(/recordedAt/);
    expect(() =>
      parseMeasurements(JSON.stringify({ ...valid, machine: { platform: "x" } })),
    ).toThrow(/machine/);
    expect(() =>
      parseMeasurements(
        JSON.stringify({ ...valid, metrics: { coldLaunchToShellMs: { valueMs: "fast" } } }),
      ),
    ).toThrow(/coldLaunchToShellMs/);
    expect(() =>
      parseMeasurements(
        JSON.stringify({ ...valid, metrics: { warmAppOpenMs: { skipped: true } } }),
      ),
    ).toThrow(/reason/);
  });
});
