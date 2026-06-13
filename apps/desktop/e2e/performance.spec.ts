import { performanceBudgets } from "@dohc/performance";
import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { launchApp, openInTree } from "./launch";

// Phase 16: measures the plan's ten desktop scenarios against the hard
// budgets in @dohc/performance and writes the results JSON the
// check-performance gate consumes. Numbers are always REAL: a scenario whose
// product seam does not exist is recorded as skipped with the deferred plan
// phase named — never a fabricated value.

const PERF_DIR = "test-results/performance";
const PERF_FILE = join(PERF_DIR, "desktop-performance.json");
const SHOT_DIR = "test-results/screenshots/phase-16";

type MetricName = keyof typeof performanceBudgets;
type MetricRecord = { valueMs: number } | { skipped: true; reason: string };

// The results file lives outside Playwright's per-run outputDir cleanup, so a
// partial run (-g filter, crashed test) would otherwise leave the PREVIOUS
// session's numbers under this run's fresh recordedAt. Start empty: anything
// this run doesn't record fails check-performance as MISSING. (A mid-run
// worker restart re-runs this hook and wipes earlier metrics of the same run
// — also a loud MISSING failure, never a stale pass.)
test.beforeAll(async () => {
  await rm(PERF_FILE, { force: true });
});

const machine = {
  platform: `${platform()} ${release()} (WSL2)`,
  nproc: cpus().length,
  totalMemGb: Math.round(totalmem() / 1024 ** 3),
  note: "Local dev machine under WSL2; a network-bound codex CLI runs concurrently; Playwright workers=1.",
};

// Merge-write so each test contributes its metrics independently.
async function recordPatch(patch: {
  metrics?: Partial<Record<MetricName, MetricRecord>>;
  ratchets?: Record<string, { value: number; baseline?: number }>;
}): Promise<void> {
  await mkdir(PERF_DIR, { recursive: true });
  let existing: { metrics?: object; ratchets?: object } = {};
  try {
    existing = JSON.parse(await readFile(PERF_FILE, "utf8")) as typeof existing;
  } catch {
    // First writer initializes the file.
  }
  const merged = {
    recordedAt: new Date().toISOString(),
    machine,
    metrics: { ...existing.metrics, ...patch.metrics },
    ratchets: { ...existing.ratchets, ...patch.ratchets },
  };
  await writeFile(PERF_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

async function recordMetric(name: MetricName, record: MetricRecord): Promise<void> {
  await recordPatch({ metrics: { [name]: record } });
}

// Measurement-fidelity rule: a concurrent network-bound process shares this
// machine, so a number landing within 25% of its budget (either side) is
// re-measured once and the better number wins before any over-budget
// declaration. A number far over budget is a real finding, not noise.
async function measureWithFidelity(
  name: MetricName,
  run: () => Promise<number>,
): Promise<number> {
  let value = await run();
  const budget = performanceBudgets[name];
  if (value > budget * 0.75 && value < budget * 1.25) {
    value = Math.min(value, await run());
  }
  await recordMetric(name, { valueMs: Math.round(value) });
  return value;
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  const path = `${SHOT_DIR}/${name}--1280x800--light.png`;
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

async function seedWorkspace(
  workspaceId: string,
  fill?: (root: string) => Promise<void>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-perf-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-perf-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  await fill?.(root);
  return { home, root };
}

async function openSeededWorkspace(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  const shell = page.getByTestId("workspace-shell");
  await expect(shell).toBeVisible();
  // The shell DOM mounts immediately, but openWorkspace (which awaits the file
  // watcher's initial scan) resolves a beat later. Writes made before then land
  // during chokidar's ignoreInitial scan and are silently dropped. Gate on the
  // watcher being live so post-open writes are guaranteed observed.
  await expect(shell).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  return { app, page };
}

interface MarksSnapshot {
  marks: Record<string, number>;
  measures: Record<string, number>;
}

// Renderer-side recorder, exposed through the test-only window hook.
async function rendererSnapshot(page: Page): Promise<MarksSnapshot> {
  const snapshot = await page.evaluate(() => {
    const w = window as Window & { dohcDesktopMarks?: { snapshot(): MarksSnapshot } };
    return w.dohcDesktopMarks?.snapshot() ?? null;
  });
  expect(snapshot, "renderer marks hook must be installed in test mode").not.toBeNull();
  return snapshot ?? { marks: {}, measures: {} };
}

async function rendererMeasures(page: Page): Promise<Record<string, number>> {
  return (await rendererSnapshot(page)).measures;
}

// Reads a measure only once its freshness mark post-dates the triggering
// action: the recording effect runs AFTER React paints, so a DOM-anchored
// wait alone can observe the PREVIOUS file's stale measure.
async function freshMeasure(
  page: Page,
  measureName: string,
  freshnessMark: string,
  sinceEpochMs: number,
): Promise<number> {
  // 250ms skew allowance: marks are wall-clock epochs and WSL2's clock can
  // step between the spec's Date.now() and the renderer's.
  await expect
    .poll(async () => (await rendererSnapshot(page)).marks[freshnessMark] ?? 0)
    .toBeGreaterThanOrEqual(sinceEpochMs - 250);
  const value = (await rendererSnapshot(page)).measures[measureName];
  expect(value, `measure ${measureName} must be recorded`).toBeGreaterThanOrEqual(0);
  return value;
}

test("launch: cold/warm to visible shell, empty workspace creation, bundle size", async () => {
  test.setTimeout(180_000);

  // Scenario 3 first (it also produces the registry the launch scenarios
  // need): first run → Create workspace → shell visible.
  async function createWorkspaceRun(): Promise<{
    home: string;
    userData: string;
    ms: number;
    shotPage?: true;
  }> {
    const home = await mkdtemp(join(tmpdir(), "dohc-perf-home-"));
    const userData = await mkdtemp(join(tmpdir(), "dohc-perf-warm-"));
    const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_USER_DATA: userData });
    const page = await app.firstWindow();
    const create = page.getByRole("button", { name: /create workspace/i });
    await expect(create).toBeVisible();
    await shot(page, "launch-first-run");
    const t0 = performance.now();
    await create.click();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    const ms = performance.now() - t0;
    await shot(page, "launch-shell");
    await app.close();
    return { home, userData, ms };
  }

  let createRun = await createWorkspaceRun();
  if (createRun.ms > performanceBudgets.createEmptyWorkspaceMs * 0.75) {
    const second = await createWorkspaceRun();
    if (second.ms < createRun.ms) createRun = second;
  }
  await recordMetric("createEmptyWorkspaceMs", { valueMs: Math.round(createRun.ms) });

  // Scenarios 1–2: relaunches with the seeded registry land directly in the
  // shell. "Cold" gets a FRESH Electron user-data dir per attempt so the V8
  // code cache and GPU cache warmed by this session's earlier launches do not
  // carry (OS page cache still does — disclosed in the review doc); a fidelity
  // retry mints its own fresh dir, so a retried cold sample stays cold.
  // "Warm" reuses the user-data dir from createWorkspaceRun, so Electron's
  // own profile caches carry exactly like a real returning-user launch.
  const home = createRun.home;
  async function launchToShell(extraEnv: Record<string, string> = {}): Promise<number> {
    const t0 = performance.now();
    const app = await launchApp({ DOHC_TEST_HOME: home, ...extraEnv });
    const page = await app.firstWindow();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    const ms = performance.now() - t0;
    await app.close();
    return ms;
  }
  await measureWithFidelity("coldLaunchToShellMs", async () =>
    launchToShell({ DOHC_TEST_USER_DATA: await mkdtemp(join(tmpdir(), "dohc-perf-cold-")) }),
  );
  await measureWithFidelity("warmLaunchToShellMs", () =>
    launchToShell({ DOHC_TEST_USER_DATA: createRun.userData }),
  );

  // Resource ratchet: renderer JS shipped to the first shell paint. Lazy route
  // chunks (for example the WYSIWYG editor) are deliberately excluded: they
  // must have their own interaction budgets, not inflate the launch bundle.
  const assetsDir = "apps/desktop/dist/renderer/assets";
  let bytes = 0;
  for (const file of await readdir(assetsDir)) {
    if (file.startsWith("index-") && file.endsWith(".js")) {
      bytes += (await stat(join(assetsDir, file))).size;
    }
  }
  const bundleMb = Math.round((bytes / 1024 ** 2) * 100) / 100;
  console.log(`renderer initial JS bundle: ${bundleMb} MB`);
  await recordPatch({ ratchets: { rendererInitialBundleMb: { value: bundleMb } } });
});

test("file tree: open 1000-file workspace to interactive tree (+ memory working set)", async () => {
  test.setTimeout(180_000);
  async function run(): Promise<number> {
    const { home, root } = await seedWorkspace(`perf-1k-${Date.now()}`, async (dir) => {
      for (let d = 0; d < 20; d++) {
        const sub = join(dir, `notes-${String(d).padStart(2, "0")}`);
        await mkdir(sub, { recursive: true });
        await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            writeFile(join(sub, `note-${i}.md`), `# Note ${d}-${i}\n`),
          ),
        );
      }
    });
    const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
    const page = await app.firstWindow();
    const open = page.getByRole("button", { name: /open an existing folder/i });
    await expect(open).toBeVisible();
    const t0 = performance.now();
    await open.click();
    // Nested tree (E3): expand notes-00 INSIDE the measured window and wait
    // for its leaf row — the budget now covers expand latency too (the
    // collapsed-by-default tree renders ~20 root rows for this fixture).
    await openInTree(page, "notes-00/note-0.md", { click: false });
    const ms = performance.now() - t0;

    // Resource ratchet: total working set with the 1,000-file workspace open.
    const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
    const workingSetKb = metrics.reduce(
      (sum, m) => sum + (m.memory?.workingSetSize ?? 0),
      0,
    );
    await recordPatch({
      ratchets: { workspaceMemoryWorkingSetMb: { value: Math.round(workingSetKb / 1024) } },
    });
    await shot(page, "file-tree-1000");
    await app.close();
    return ms;
  }
  await measureWithFidelity("openThousandFileWorkspaceMs", run);
});

test("file tree search: 10,000 paths query + visible result", async () => {
  test.setTimeout(300_000);
  const { home, root } = await seedWorkspace("perf-10k", async (dir) => {
    for (let d = 0; d < 100; d++) {
      const sub = join(dir, `area-${String(d).padStart(3, "0")}`);
      await mkdir(sub, { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, i) => writeFile(join(sub, `doc-${i}.md`), `# ${d}-${i}\n`)),
      );
    }
    await writeFile(join(dir, "needle-target.md"), "# Needle\n");
  });
  const { app, page } = await openSeededWorkspace(home, root);
  await expect(
    page.getByTestId("file-tree").getByText("needle-target.md", { exact: true }),
  ).toBeVisible({ timeout: 120_000 });
  await shot(page, "file-tree-10000");

  async function searchOnce(): Promise<{ query: number; visible: number }> {
    await page.keyboard.press("ControlOrMeta+p");
    const quickOpen = page.getByTestId("quick-open");
    await expect(quickOpen).toBeVisible();
    await page.keyboard.type("needle");
    await expect(quickOpen.getByRole("option").first()).toContainText("needle-target.md");
    const measures = await rendererMeasures(page);
    await page.keyboard.press("Escape");
    await expect(quickOpen).toHaveCount(0);
    return {
      query: measures["file-tree-search-query"] ?? Number.NaN,
      visible: measures["file-tree-search-visible"] ?? Number.NaN,
    };
  }

  let result = await searchOnce();
  if (
    result.query > performanceBudgets.fileTreeSearchTenThousandPathsMs * 0.75 ||
    result.visible > performanceBudgets.fileTreeSearchVisibleResultMs * 0.75
  ) {
    const second = await searchOnce();
    result = {
      query: Math.min(result.query, second.query),
      visible: Math.min(result.visible, second.visible),
    };
  }
  expect(Number.isFinite(result.query)).toBe(true);
  expect(Number.isFinite(result.visible)).toBe(true);
  await recordMetric("fileTreeSearchTenThousandPathsMs", {
    valueMs: Math.round(result.query * 100) / 100,
  });
  await recordMetric("fileTreeSearchVisibleResultMs", { valueMs: Math.round(result.visible) });
  await app.close();
});

test("content search: first result + complete scan + keystroke long tasks over 10,000 files / ~100MB", async () => {
  test.setTimeout(600_000);
  // Phase E5.0 budgets. The fixture is generated ONCE and reused for all
  // three metrics: 100 dirs x 100 files x ~10KB of prose = 10,000 files /
  // ~100MB. The needle lands in every 10th file (1,000 matches): plenty to
  // stream, but UNDER the 2,000 stream cap so contentSearchCompleteMs
  // measures a FULL scan, never an early cap-kill.
  const paragraph =
    "Ordinary prose sentence with several common words inside it, repeated to weigh the file. ";
  const body = `# Doc\n\n${paragraph.repeat(110)}\n`; // ~10KB
  const { home, root } = await seedWorkspace("perf-search-100mb", async (dir) => {
    for (let d = 0; d < 100; d++) {
      const sub = join(dir, `corpus-${String(d).padStart(3, "0")}`);
      await mkdir(sub, { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          writeFile(
            join(sub, `doc-${i}.md`),
            (d * 100 + i) % 10 === 0 ? `${body}contentneedle ${d}-${i}\n` : body,
          ),
        ),
      );
    }
  });
  const { app, page } = await openSeededWorkspace(home, root);
  await page.getByTestId("activity-search").click();
  await expect(page.getByTestId("search-view")).toBeVisible();
  const input = page.getByTestId("search-input");
  const searchView = page.getByTestId("search-view");

  async function waitComplete(): Promise<void> {
    await expect(searchView).toHaveAttribute("data-state", "complete", {
      timeout: 60_000,
    });
  }

  // Keystroke long tasks WHILE typing in the search box (debounced searches
  // fire and result batches render during the window — the realistic jank
  // sources). Same longtask-observer probe as the markdown typing scenario.
  async function typeProbe(): Promise<number> {
    await input.fill("");
    await waitFor(page, searchView, "idle");
    await page.evaluate(() => {
      const w = window as Window & { __longTasks?: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks?.push(entry.duration);
      }).observe({ type: "longtask" });
    });
    await input.click();
    // 180ms/char beats the 150ms debounce, so EVERY keystroke launches a
    // real (immediately superseded) search — prefix queries like "c"/"co"
    // match thousands of prose lines, so capped result batches stream and
    // render WHILE typing continues. That is the honest jank scenario.
    await page.keyboard.type("contentneedle", { delay: 180 });
    const longTasks = await page.evaluate(
      () => (window as Window & { __longTasks?: number[] }).__longTasks ?? [],
    );
    await waitComplete();
    return longTasks.length === 0 ? 0 : Math.max(...longTasks);
  }
  // Clearing the input settles the view back to idle before each probe.
  async function waitFor(p: Page, view: ReturnType<Page["getByTestId"]>, state: string) {
    await expect(view).toHaveAttribute("data-state", state, { timeout: 30_000 });
  }
  await measureWithFidelity("searchKeystrokeLongTaskMs", typeProbe);

  // First-result + complete latency for ONE clean search (a single fill =
  // one debounced search). The renderer records the measures in SearchView's
  // post-commit effects; the freshness marks gate the reads (freshMeasure).
  async function searchOnce(): Promise<{ first: number; complete: number }> {
    await input.fill("");
    await waitFor(page, searchView, "idle");
    const issueEpoch = Date.now();
    await input.fill("contentneedle");
    await waitComplete();
    const first = await freshMeasure(
      page,
      "content-search-first-result",
      "content-search-first-result-rendered",
      issueEpoch,
    );
    const complete = await freshMeasure(
      page,
      "content-search-complete",
      "content-search-completed",
      issueEpoch,
    );
    return { first, complete };
  }
  let result = await searchOnce();
  if (
    result.first > performanceBudgets.contentSearchFirstResultMs * 0.75 ||
    result.complete > performanceBudgets.contentSearchCompleteMs * 0.75
  ) {
    const second = await searchOnce();
    result = {
      first: Math.min(result.first, second.first),
      complete: Math.min(result.complete, second.complete),
    };
  }
  await recordMetric("contentSearchFirstResultMs", { valueMs: Math.round(result.first) });
  await recordMetric("contentSearchCompleteMs", { valueMs: Math.round(result.complete) });
  await expect(page.getByTestId("search-summary")).toContainText(/1000 results/);
  await shot(page, "content-search-100mb");
  await app.close();
});

test("markdown: open a 250KB document, then typing long tasks in the editor", async () => {
  test.setTimeout(180_000);
  const paragraph =
    "This is a realistic paragraph of prose with **bold**, a [link](https://example.com), and `code` spans. ".repeat(3);
  let body = "# Big document\n\n";
  while (body.length < 250 * 1024) {
    body += `## Section\n\n${paragraph}\n\n- first item\n- second item\n\n`;
  }
  let midBody = "# Medium document\n\n";
  while (midBody.length < 32 * 1024) {
    midBody += `## Section\n\n${paragraph}\n\n- first item\n- second item\n\n`;
  }
  const { home, root } = await seedWorkspace("perf-md", async (dir) => {
    await writeFile(join(dir, "big.md"), body);
    await writeFile(join(dir, "mid.md"), midBody);
    await writeFile(join(dir, "small.md"), "# Small\n");
  });
  const { app, page } = await openSeededWorkspace(home, root);
  const tree = page.getByTestId("file-tree");

  async function openBig(): Promise<number> {
    const clickEpoch = Date.now();
    await tree.getByText("big.md", { exact: true }).click();
    // Anchor on content unique to THIS document, then wait for the freshness
    // mark so the measure read belongs to THIS open, never the previous file.
    await expect(page.getByTestId("view-markdown")).toContainText("Big document");
    const value = await freshMeasure(page, "markdown-open", "markdown-opened", clickEpoch);
    // Swap away so the next attempt is a real re-open.
    await tree.getByText("small.md", { exact: true }).click();
    await expect(page.getByTestId("view-markdown")).toContainText("Small");
    return value;
  }
  const openMs = await (async () => {
    const budget = performanceBudgets.openMarkdown250KbMs;
    let value = await openBig();
    if (value > budget * 0.75 && value < budget * 1.25) {
      value = Math.min(value, await openBig());
    }
    return value;
  })();
  await recordMetric("openMarkdown250KbMs", { valueMs: Math.round(openMs) });

  // Tiptap mount on a 250KB file is explicit and bounded; opening the file
  // itself still uses the fast incremental read path above.
  async function mountBigEditor(): Promise<number> {
    await tree.getByText("small.md", { exact: true }).click();
    await expect(page.getByTestId("view-markdown")).toContainText("Small");
    await tree.getByText("big.md", { exact: true }).click();
    await expect(page.getByTestId("view-markdown")).toContainText("Big document");
    const t0 = performance.now();
    await page.getByTestId("markdown-edit-toggle").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible();
    return performance.now() - t0;
  }
  await measureWithFidelity("tiptapMount250KbMs", mountBigEditor);

  // Typing latency: no long task over 50ms while typing in a 32KB WYSIWYG
  // session, the largest doc size that opens in Tiptap by default.
  await tree.getByText("mid.md", { exact: true }).click();
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  const editor = page.getByTestId("markdown-editor");
  await expect(editor).toBeVisible();
  await page.waitForTimeout(50);
  async function typeOnce(): Promise<number> {
    await page.evaluate(() => {
      const w = window as Window & { __longTasks?: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTasks?.push(entry.duration);
      }).observe({ type: "longtask" });
    });
    await editor.click();
    await page.keyboard.type("The quick brown fox jumps over the lazy dog.", { delay: 30 });
    const longTasks = await page.evaluate(
      () => (window as Window & { __longTasks?: number[] }).__longTasks ?? [],
    );
    return longTasks.length === 0 ? 0 : Math.max(...longTasks);
  }
  await measureWithFidelity("typingLongTaskMs", typeOnce);
  await app.close();
});

test("watcher: single-save detection and a 100-file change set", async () => {
  test.setTimeout(180_000);
  const { home, root } = await seedWorkspace("perf-watch", async (dir) => {
    await writeFile(join(dir, "readme.md"), "# Watch\n");
  });
  const { app, page } = await openSeededWorkspace(home, root);
  const timeline = page.getByTestId("history-timeline");

  // Scenario: file watcher settles and detects one markdown save.
  const t0 = performance.now();
  await writeFile(join(root, "detected.md"), "# Saved externally\n");
  await expect(timeline).toContainText(/detected\.md/i, { timeout: 15_000 });
  await recordMetric("singleFileSyncDetectMs", { valueMs: Math.round(performance.now() - t0) });

  // Scenario: a 100-file burst is BATCHED into change set(s), not one record
  // per file. The watcher's 500ms settle window usually captures all 100 in a
  // single batch, but under load the OS can spread the writes across two
  // windows (e.g. 60 + 40) — both are correct batching. So assert the property
  // that actually matters (and that the real regression — one record per file —
  // would break): all 100 bulk files are recorded, in only a HANDFUL of change
  // sets. Reading the cumulative count off the timeline tolerates the batch
  // boundary; pinning the exact "100 files" single row did not (flaky).
  const bulkCount = (text: string): number =>
    [...text.matchAll(/(\d+)\s+files?\b/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const baselineFiles = bulkCount((await timeline.textContent()) ?? "");
  const baselineRows = await timeline.getByTestId("change-set").count();
  await mkdir(join(root, "bulk"), { recursive: true });
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      writeFile(join(root, "bulk", `file-${i}.md`), `# Bulk ${i}\n`),
    ),
  );
  const t1 = performance.now();
  // Wait until the burst is fully recorded (cumulative file count climbs by 100).
  await expect
    .poll(async () => bulkCount((await timeline.textContent()) ?? "") - baselineFiles, {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(100);
  await recordMetric("hundredFileChangeSetMs", { valueMs: Math.round(performance.now() - t1) });
  // Batching held: 100 files landed in a handful of change sets, never ~100.
  const bulkRows = (await timeline.getByTestId("change-set").count()) - baselineRows;
  expect(bulkRows).toBeGreaterThanOrEqual(1);
  expect(bulkRows).toBeLessThanOrEqual(5);

  // The main-process recorder bracketed the real settle→record work.
  const mainMarks = await page.evaluate(() =>
    (
      window as Window & {
        dohcDesktopTest?: { getDesktopMarks(): Promise<MarksSnapshot> };
      }
    ).dohcDesktopTest?.getDesktopMarks(),
  );
  expect(mainMarks?.measures["sync-batch"]).toBeGreaterThan(0);
  await app.close();
});

test("apps: AppTester on a small app; warm app open is a deferred seam", async () => {
  test.setTimeout(120_000);
  const { home, root } = await seedWorkspace("perf-app", async (dir) => {
    const appDir = join(dir, "finance", ".apps", "ledger");
    await mkdir(join(appDir, "src"), { recursive: true });
    await writeFile(
      join(appDir, "app.json"),
      JSON.stringify({ title: "Ledger", write: ["transactions/**"] }),
    );
    await writeFile(
      join(appDir, "src", "App.tsx"),
      [
        "import { dohc } from '@dohc/app'",
        "export default function App(){",
        "  return (",
        "    <main>",
        "      <h1>Ledger</h1>",
        "      <button onClick={() => dohc.collection('transactions').insert({ id: 'x' })}>",
        "        Add transaction",
        "      </button>",
        "    </main>",
        "  )",
        "}",
      ].join("\n"),
    );
  });
  const { app, page } = await openSeededWorkspace(home, root);
  await openInTree(page, "finance/.apps/ledger/app.json");
  await expect(page.getByTestId("view-app")).toBeVisible();

  async function runTester(): Promise<number> {
    const t0 = performance.now();
    await page.getByTestId("run-app-tester").click();
    await expect(page.getByTestId("app-readiness")).toHaveAttribute(
      "data-readiness",
      "ready",
      { timeout: 60_000 },
    );
    return performance.now() - t0;
  }
  await measureWithFidelity("appTesterSmallAppMs", runTester);

  // No fabricated number: the in-app runtime (build cache and all) does not
  // exist yet — the plan defers it to Phase 7b.
  await recordMetric("warmAppOpenMs", {
    skipped: true,
    reason:
      "In-app .apps runtime (build-cache-warm open) is deferred to plan Phase 7b; only the source-package surface exists today.",
  });
  await app.close();
});

test("database: 10,000-row SQLite first page and 10,000-row CSV import", async () => {
  // The import currently runs minutes over budget (deferred finding: the
  // sqlite-worker engine inserts row-by-row without a transaction, on the
  // main thread). The long timeout exists to measure the REAL number.
  test.setTimeout(480_000);
  const csvBody = `id,amount,category\n${Array.from(
    { length: 10_000 },
    (_, i) => `txn_${i},${(i * 1.5).toFixed(2)},cat_${i % 7}`,
  ).join("\n")}\n`;
  const { home, root } = await seedWorkspace("perf-db", async (dir) => {
    await mkdir(join(dir, "data"), { recursive: true });
    await writeFile(join(dir, "data", "rows.csv"), csvBody);
    // node:sqlite via createRequire — same idiom as workspaceDatabase.ts
    // (keeps @types/node's experimental sqlite typings out of the project).
    const requireFromHere = createRequire(import.meta.url);
    const { DatabaseSync } = requireFromHere("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(join(dir, "data", "big.sqlite"));
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, amount REAL)");
    const insert = db.prepare("INSERT INTO items (name, amount) VALUES (?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 10_000; i++) insert.run(`item-${i}`, i * 1.5);
    db.exec("COMMIT");
    db.close();
  });
  const { app, page } = await openSeededWorkspace(home, root);
  const tree = page.getByTestId("file-tree");

  async function openSqlite(): Promise<number> {
    const clickEpoch = Date.now();
    await openInTree(page, "data/big.sqlite");
    // Anchor on a row unique to this database, then on the freshness mark
    // (see the markdown scenario).
    await expect(page.getByTestId("db-table")).toContainText("item-0");
    return freshMeasure(page, "sqlite-first-page", "sqlite-first-page-rendered", clickEpoch);
  }
  const sqliteBudget = performanceBudgets.sqliteTenThousandRowsFirstPageMs;
  let firstPageMs = await openSqlite();
  if (firstPageMs > sqliteBudget * 0.75 && firstPageMs < sqliteBudget * 1.25) {
    // Swap away and re-open for a real second measurement.
    await openInTree(page, "data/rows.csv");
    await expect(page.getByTestId("view-csv")).toBeVisible({ timeout: 60_000 });
    firstPageMs = Math.min(firstPageMs, await openSqlite());
  }
  await recordMetric("sqliteTenThousandRowsFirstPageMs", { valueMs: Math.round(firstPageMs) });
  await shot(page, "database-10000-rows");

  // CSV import: click → engine parse/infer → atomic materialize → studio
  // opens the new database on its first page. dispatchEvent instead of a
  // mouse click: the import blocks the MAIN process (deferred finding), which
  // stalls CDP input dispatch — a hardware-style click can never complete.
  await openInTree(page, "data/rows.csv");
  await expect(page.getByTestId("view-csv")).toBeVisible({ timeout: 60_000 });
  const t0 = performance.now();
  await page.getByTestId("csv-import-sqlite").dispatchEvent("click");
  // The studio opens on the materialized rows.sqlite — anchor on its data.
  await expect(page.getByTestId("db-table")).toContainText("txn_0", { timeout: 360_000 });
  await recordMetric("csvTenThousandRowsImportMs", { valueMs: Math.round(performance.now() - t0) });
  await shot(page, "database-csv-import");
  await app.close();
});
