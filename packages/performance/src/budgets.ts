// Hard millisecond budgets for the desktop native-speed gate. Values are
// verbatim from the plan's Performance Budgets section (Phase 16 Step 1).
//
// Editing ANY value after its first commit must be named explicitly in that
// commit's Codex review prompt ("budget X changed from A to B because C").
// assertBudget.test.ts pins this table so a silent edit fails tests.
export const performanceBudgets = {
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
  // Phase E5.0 content search (ADDITIVE rows, named in the phase's codex
  // review per the budget-edit rule): ripgrep over a generated 10,000-file /
  // ~100MB workspace fixture. First streamed batch rendered, full scan
  // complete, and typing in the search box never janks the renderer.
  contentSearchFirstResultMs: 300,
  contentSearchCompleteMs: 1500,
  searchKeystrokeLongTaskMs: 50,
} as const;

export type BudgetName = keyof typeof performanceBudgets;

// Relative-regression ratchets (resource budgets). These are RATIOS against a
// previously recorded baseline, so they are environment-independent:
// PERF_BUDGET_MULTIPLIER NEVER applies to them (assertRatchet ignores it).
// initialTarget is the plan's stated first target, recorded for visibility;
// the hard rule is the growth ratio once a baseline exists.
export const regressionRatchets = {
  // Working set after opening a 1,000-file workspace; >20% growth fails.
  workspaceMemoryWorkingSetMb: { initialTarget: 400, maxGrowthRatio: 1.2, unit: "MB" },
  // Renderer JS loaded before first shell paint; >10% growth fails.
  rendererInitialBundleMb: { initialTarget: 3, maxGrowthRatio: 1.1, unit: "MB" },
} as const;

export type RatchetName = keyof typeof regressionRatchets;
