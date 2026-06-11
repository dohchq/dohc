import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { launchApp } from "./launch";

// Phase E5.0 gate: workspace content search (ripgrep streamed over IPC) —
// progressive arrival, keystroke cancellation via the search-id seam, the
// case/word/regex toggles, include/exclude globs, reserved-segment exclusion
// (.dohc/.git planted matches NEVER appear), click-to-open at file+line,
// keyboard navigation, the 2000-match cap notice, and the activity-bar
// results badge. Screenshots land in test-results/screenshots/e5-0/.

const SCREENSHOT_DIR = "test-results/screenshots/e5-0";

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e5-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e5-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return { home, root };
}

async function openSeeded(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

async function openSearchView(page: Page) {
  // Standing-rule screenshot geometry; every shot in this spec inherits it.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("activity-search").click();
  await expect(page.getByTestId("search-view")).toBeVisible();
}

async function searchFor(page: Page, query: string) {
  const input = page.getByTestId("search-input");
  await input.fill(query);
  // fill dispatches ONE input event → one debounced search.
  await expect(page.getByTestId("search-view")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 30_000 },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

test("results stream in progressively; keystroke cancellation drops stale batches; cap notice at 2000", async () => {
  test.setTimeout(300_000);
  // 3,000 files (~5KB each) with one streamtoken match per file: enough that
  // the scan outlives the first rendered batch (progressive arrival) and the
  // 3,000 candidate matches overflow the 2,000-match stream cap.
  const filler = `${"prose filler line with ordinary words\n".repeat(120)}`;
  const { home, root } = await seedWorkspace("e5-stream", {});
  for (let d = 0; d < 30; d++) {
    const dir = join(root, "stream", `sub-${String(d).padStart(2, "0")}`);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(join(dir, `f-${i}.md`), `${filler}streamtoken ${d}-${i}\n`),
      ),
    );
  }
  const { app, page } = await openSeeded(home, root);
  await openSearchView(page);

  // PROGRESSIVE ARRIVAL: the first group renders while the scan is still
  // running (data-state still "searching"). rAF-polled so the transient
  // window is caught reliably.
  await page.getByTestId("search-input").fill("streamtoken");
  await page.waitForFunction(
    () => {
      const view = document.querySelector('[data-testid="search-view"]');
      return (
        view?.getAttribute("data-state") === "searching" &&
        document.querySelectorAll('[data-testid="search-result-row"]').length > 0
      );
    },
    undefined,
    { timeout: 20_000 },
  );
  const staleId = await page.getByTestId("search-view").getAttribute("data-search-id");
  expect(staleId).toBeTruthy();

  // CANCELLATION ON KEYSTROKE, driven via the search-id seam: while the
  // streamtoken search is mid-flight, type on — the new search kills the old
  // rg child and the old search's in-flight batches are dropped by id. If a
  // stale batch corrupted the new results, rows would survive below.
  await page.getByTestId("search-input").click();
  await page.keyboard.press("End");
  await page.keyboard.type("zzz", { delay: 30 });
  // The id seam: wait for the NEW search to begin (the old one may have
  // already cap-completed), then for it to finish.
  await expect(page.getByTestId("search-view")).not.toHaveAttribute(
    "data-search-id",
    staleId!,
    { timeout: 15_000 },
  );
  await expect(page.getByTestId("search-view")).toHaveAttribute(
    "data-state",
    "complete",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("search-result-row")).toHaveCount(0);
  await expect(page.getByTestId("search-empty-state")).toBeVisible();
  await shot(page, "search-no-results");

  // CAP NOTICE: the full streamtoken search has 3,000 candidates; the stream
  // cap stops at exactly 2,000 and says so.
  await searchFor(page, "streamtoken");
  await expect(page.getByTestId("search-cap-notice")).toContainText(/2000/);
  await expect(page.getByTestId("search-summary")).toContainText(/2000 results/);
  // The rail badge clamps at three glyphs ("99+"): a four-glyph pill grew to
  // ~36px of the 48px rail and visually detached from the search icon.
  await expect(page.getByTestId("activity-search-count")).toHaveText("99+");
  await shot(page, "search-results-capped");
  await app.close();
});

test("filters: case/word/regex toggles, include/exclude globs, planted .dohc/.git matches never appear", async () => {
  test.setTimeout(120_000);
  const { home, root } = await seedWorkspace("e5-filters", {
    "toggles.md": "Case CASE case\nword words sword\nfoo1 foo2\n",
    "notes/inc.md": "globtoken in markdown\n",
    "docs/exc.txt": "globtoken in text\n",
    "real.md": "plantedneedle in a real file\n",
  });
  // Plant matches INSIDE the reserved segments — they must never surface.
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".dohc", "planted.md"), "plantedneedle inside dohc\n");
  await writeFile(join(root, ".git", "planted.md"), "plantedneedle inside git\n");
  const { app, page } = await openSeeded(home, root);
  await openSearchView(page);
  const rows = page.getByTestId("search-result-row");

  // Reserved segments: exactly ONE result — the real file.
  await searchFor(page, "plantedneedle");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-path", "real.md");

  // Case toggle: insensitive finds all three spellings; sensitive only one.
  await searchFor(page, "case");
  await expect(page.getByTestId("search-group-count")).toHaveText("3");
  const caseToggle = page.getByTestId("search-toggle-case");
  await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("search-view")).toHaveAttribute("data-state", "complete");
  await expect(page.getByTestId("search-group-count")).toHaveText("1");
  // The pressed on-state (tinted fill + match border) ships REVIEWED: shoot
  // it light AND dark while the case toggle is on.
  await shot(page, "search-toggle-pressed");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  await shot(page, "search-toggle-pressed");
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  await caseToggle.click();

  // Whole-word toggle: "word" stops matching "words"/"sword".
  await searchFor(page, "word");
  await expect(page.getByTestId("search-group-count")).toHaveText("3");
  const wordToggle = page.getByTestId("search-toggle-word");
  await wordToggle.click();
  await expect(wordToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("search-group-count")).toHaveText("1");
  await wordToggle.click();

  // Regex toggle: fixed-string "foo\d" finds nothing; as a regex it finds 2.
  await searchFor(page, "foo\\d");
  await expect(page.getByTestId("search-empty-state")).toBeVisible();
  const regexToggle = page.getByTestId("search-toggle-regex");
  await regexToggle.click();
  await expect(regexToggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("search-group-count")).toHaveText("2");
  await regexToggle.click();

  // Include/exclude globs (collapsed behind the filter toggle).
  await searchFor(page, "globtoken");
  await expect(rows).toHaveCount(2);
  await page.getByTestId("search-filter-toggle").click();
  await page.getByTestId("search-include").fill("*.md");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-path", "notes/inc.md");
  await page.getByTestId("search-include").fill("");
  await expect(rows).toHaveCount(2);
  await page.getByTestId("search-exclude").fill("docs/**");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-path", "notes/inc.md");
  // Screenshot with BOTH boxes filled — the persistent include/exclude
  // labels are what tells two filled glob inputs apart.
  await page.getByTestId("search-include").fill("*.md");
  await expect(rows).toHaveCount(1);
  await shot(page, "search-filters");
  await app.close();
});

test("click-to-open lands at file+line, keyboard nav opens results, badge counts, light+dark screenshots", async () => {
  test.setTimeout(120_000);
  const lines = Array.from({ length: 9 }, (_, i) => `line number ${i + 1}`);
  lines[4] = "line number 5 carries the jumptargettoken here";
  const { home, root } = await seedWorkspace("e5-open", {
    "click/target.md": `${lines.join("\n")}\n`,
    // A deep-column match (~84 chars in): without lead-trimming, CSS
    // end-truncation clipped the mark off the right edge entirely.
    "click/deep.md": `${"filler ".repeat(12)}deepcolumntoken near the end of a long prose line\n`,
    "nav/n1.md": "navtoken first\n",
    "nav/n2.md": "filler\nnavtoken second\n",
  });
  const { app, page } = await openSeeded(home, root);
  await openSearchView(page);

  // One match → the activity-bar Search icon carries a results-count badge.
  await searchFor(page, "jumptargettoken");
  const rows = page.getByTestId("search-result-row");
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("activity-search-count")).toHaveText("1");
  // The highlighted span inside the preview is the match itself — and it is
  // GEOMETRICALLY visible. The match starts at column 27, past the ~28-char
  // visible row width, so the row lead-trims ("…" prefix) instead of letting
  // CSS end-truncation clip the mark off the right edge (codex P1).
  await expect(rows.first().locator("mark")).toHaveText("jumptargettoken");
  await expect(rows.first()).toContainText("…");
  const rowBox = (await rows.first().boundingBox())!;
  const markBox = (await rows.first().locator("mark").boundingBox())!;
  expect(markBox.x).toBeGreaterThanOrEqual(rowBox.x);
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  await shot(page, "search-results");

  // Same guarantee much deeper into the line (column ~85).
  await searchFor(page, "deepcolumntoken");
  await expect(rows).toHaveCount(1);
  const deepMark = rows.first().locator("mark");
  await expect(deepMark).toHaveText("deepcolumntoken");
  await expect(rows.first()).toContainText("…");
  const deepRowBox = (await rows.first().boundingBox())!;
  const deepMarkBox = (await deepMark.boundingBox())!;
  expect(deepMarkBox.x).toBeGreaterThanOrEqual(deepRowBox.x);
  expect(deepMarkBox.x + deepMarkBox.width).toBeLessThanOrEqual(
    deepRowBox.x + deepRowBox.width + 1,
  );
  await shot(page, "search-long-line");

  // Back to the click target for the open-at-line flow below. The path
  // assertion waits out the debounce window — right after fill, the view
  // still shows the PREVIOUS search's complete state and rows.
  await searchFor(page, "jumptargettoken");
  await expect(rows.first()).toHaveAttribute("data-path", "click/target.md");
  await expect(rows).toHaveCount(1);

  // Click lands in the editor at the right file AND line: this phase opens
  // SOURCE mode with the matched line selected (E4's WYSIWYG editor takes
  // over the scroll-to seam).
  await rows.first().click();
  const editor = page.getByTestId("markdown-editor");
  await expect(editor).toBeVisible();
  await expect(page.getByTestId("tab-click/target.md")).toHaveAttribute(
    "data-active",
    "true",
  );
  const selection = await editor.evaluate((el) => {
    const area = el as HTMLTextAreaElement;
    return {
      line: area.value.slice(0, area.selectionStart).split("\n").length,
      text: area.value.slice(area.selectionStart, area.selectionEnd),
    };
  });
  expect(selection.line).toBe(5);
  expect(selection.text).toBe("line number 5 carries the jumptargettoken here");
  await shot(page, "search-opened-at-line");

  // Keyboard nav: results keep showing while the editor is open; arrow keys
  // walk the flat order and Enter opens the selected row. Group ARRIVAL
  // order is whatever rg's parallel scan produced, so the assertion is
  // order-independent: two ArrowDowns select the second row (a different
  // file from the first), and Enter opens exactly that file.
  await searchFor(page, "navtoken");
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("activity-search-count")).toHaveText("2");
  await page.getByTestId("search-input").click();
  const selectedRow = page.locator(
    '[data-testid="search-result-row"][data-selected="true"]',
  );
  await page.keyboard.press("ArrowDown");
  await expect(selectedRow).toHaveCount(1);
  const firstPath = await selectedRow.getAttribute("data-path");
  await page.keyboard.press("ArrowDown");
  await expect(selectedRow).not.toHaveAttribute("data-path", firstPath!);
  const secondPath = await selectedRow.getAttribute("data-path");
  expect(["nav/n1.md", "nav/n2.md"]).toContain(secondPath);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`tab-${secondPath}`)).toHaveAttribute(
    "data-active",
    "true",
  );

  // Standing-rule screenshot matrix over the populated workbench (results
  // panel + editor landed at the match): both gate sizes, light AND dark.
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ] as const) {
    await page.setViewportSize(size);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(scheme);
      await shot(page, "search-open-at-line");
    }
  }
  await app.close();
});
