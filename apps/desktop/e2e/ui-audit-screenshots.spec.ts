import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  currentUiAuditBundles,
  readUiAuditBuildProvenance,
} from "../scripts/ui-audit-build-provenance.mjs";
import { expectedUiAuditShots } from "../scripts/validate-ui-audit.mjs";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceSettings,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// UI-audit harness (@ui-audit): captures screenshots of the main surfaces in
// light + dark for design polish passes. Not a regression test — it only runs
// when UI_AUDIT_SHOT_DIR names the output directory, and is skipped otherwise
// (including CI).

const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture UI audit screenshots");
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DESKTOP_ROOT = resolve(REPO_ROOT, "apps/desktop");
const CAPTURE_MANIFEST = "ui-audit-capture.json";

type UiAuditBundles = {
  mainTreeSha256: string;
  preloadTreeSha256: string;
  rendererTreeSha256: string;
  engineSha256: string;
};

type CaptureManifest = {
  schemaVersion: 1;
  state: "in-progress" | "complete";
  commit: string;
  startedAt: string;
  completedAt: string | null;
  build: {
    schemaVersion: 1;
    commit: string;
    builtAt: string;
    bundles: UiAuditBundles;
  };
  bundles: UiAuditBundles;
  shots: Array<{ name: string; sha256: string }>;
};

let activeCapture: CaptureManifest | null = null;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

async function writeCaptureManifest(): Promise<void> {
  if (!activeCapture) throw new Error("UI audit capture is not active");
  await writeFile(
    join(SHOT_DIR, CAPTURE_MANIFEST),
    `${JSON.stringify(activeCapture, null, 2)}\n`,
    "utf8",
  );
}

const RICH_DOC = `---
status: In progress
owner: Ice
release: September launch
---

# Q3 product plan

dohc turns messy work into an inspectable workspace. This quarter we focus on
polish, collaboration, and making the editor feel effortless.

## Goals

- Ship the hybrid chats feed to beta users
- Reduce time-to-first-document under 30 seconds
- Make agent activity legible at a glance

## Workstreams

| Workstream | Owner | Status |
| --- | --- | --- |
| Editor polish | Ice | In progress |
| Sync relay | Agent | Shipping |
| Sites preview | Ice | Planned |

### Launch checklist

- [x] Draft announcement post
- [ ] Record demo walkthrough
- [ ] Invite first 20 beta users

> The magic is not hidden state. The magic is a shared text substrate that
> humans and agents can both inspect, edit, and trust.

Here is the capture hook we ship with the SDK:

\`\`\`ts
export async function capture(moment: Moment): Promise<void> {
  await engine.record(moment, { settle: "debounced" });
}
\`\`\`

See [[research/competitors]] for the landscape review and
[[notes/meeting-2026-07-08]] for the latest decisions.
`;

const MEETING_DOC = `# Weekly sync — 2026-07-08

Attendees: Ice, flagship agent

## Decisions

1. Warm paper palette ships this month
2. Slash menu gets grouped sections
3. Versions timeline moves to the right rail

## Notes

Discussed how the feed should read like a briefing, not a log. The agent
drafts, the human decides.
`;

const RESEARCH_DOC = `# Competitor landscape

## Notion

Strong template ecosystem, weak provenance. Blocks are opaque to agents.

## Obsidian

Local-first like us, but no agent affordances and no review gates.

## Linear

The taste benchmark: fast, opinionated, quietly branded.
`;

const CSV_FILE = `stage,count,conversion
Visited,4820,1.00
Signed up,1290,0.27
Created doc,860,0.18
Invited agent,340,0.07
`;

async function shot(page: Page, name: string): Promise<void> {
  if (!activeCapture) throw new Error("UI audit capture is not active");
  const fileName = `${name}.png`;
  if (activeCapture.shots.some((shot) => shot.name === fileName)) {
    throw new Error(`duplicate UI audit screenshot: ${fileName}`);
  }
  const bytes = await page.screenshot({ path: join(SHOT_DIR, fileName) });
  activeCapture.shots.push({
    name: fileName,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  await writeCaptureManifest();
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    // Force a style flush and wait two frames so the screenshot can't capture
    // stale compositor tiles of the (heavy) document pane — under xvfb
    // software rendering a blind timeout races the repaint and intermittently
    // yields a light-themed editor inside dark chrome.
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, theme);
  await page.waitForTimeout(150);
}

test("@ui-audit capture baseline screenshots", async () => {
  test.setTimeout(240_000);
  const captureCommit = git(["rev-parse", "HEAD"]);
  if (git(["status", "--porcelain"]) !== "") {
    throw new Error("commit the worktree before capturing UI audit evidence");
  }
  await mkdir(SHOT_DIR, { recursive: true });
  if ((await readdir(SHOT_DIR)).length !== 0) {
    throw new Error("UI_AUDIT_SHOT_DIR must be empty before capture");
  }
  const bundles = currentUiAuditBundles(DESKTOP_ROOT);
  const build = readUiAuditBuildProvenance(
    DESKTOP_ROOT,
    captureCommit,
    bundles,
  );
  activeCapture = {
    schemaVersion: 1,
    state: "in-progress",
    commit: captureCommit,
    startedAt: new Date().toISOString(),
    completedAt: null,
    build,
    bundles,
    shots: [],
  };
  await writeCaptureManifest();
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp);
    await writeWorkspaceFiles(temp, [
      { path: "README.md", contents: "# workspace\n\nWelcome to dohc.\n" },
      { path: "notes/product-plan.md", contents: RICH_DOC },
      { path: "notes/meeting-2026-07-08.md", contents: MEETING_DOC },
      { path: "research/competitors.md", contents: RESEARCH_DOC },
      { path: "data/funnel.csv", contents: CSV_FILE },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;

    // 01 — first-run surface (before opening the workspace)
    const openFolder = page.getByRole("button", {
      name: /open an existing folder as a workspace/i,
    });
    await openFolder.waitFor({ state: "visible", timeout: 8_000 });
    await shot(page, "01-first-run-light");
    await setTheme(page, "dark");
    await shot(page, "01-first-run-dark");
    await setTheme(page, "light");
    await openWorkspaceFromFirstRun(page, temp);

    // 02 — shell + explorer (workspace open, nothing focused)
    await expect(explorerRow(page, "notes")).toBeVisible();
    await shot(page, "02-shell-explorer-light");

    // 03 — rich markdown doc in the WYSIWYG editor
    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/product-plan.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(800);
    await shot(page, "03-editor-doc-light");

    // 04 — editor dark
    await setTheme(page, "dark");
    await shot(page, "04-editor-doc-dark");
    await setTheme(page, "light");

    // 05 — bubble menu (select a paragraph)
    const editor = page.getByTestId("markdown-editor");
    const paragraph = editor.getByText("dohc turns messy work", { exact: false });
    await paragraph.click({ clickCount: 3 });
    await page.waitForTimeout(400);
    await shot(page, "05-editor-bubble-menu-light");

    // 06 — slash menu (new line + "/")
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/", { delay: 50 });
    await page.waitForTimeout(400);
    await shot(page, "06-editor-slash-menu-light");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");

    // 07 — search view with results
    await page.getByTestId("activity-search").click();
    const searchInput = page
      .locator('input[type="search"], input[placeholder*="earch"]')
      .first();
    await searchInput.waitFor({ state: "visible", timeout: 5_000 });
    await searchInput.fill("agent");
    await page.waitForTimeout(1_200);
    await shot(page, "07-search-light");

    // 08 — chats panel (right-hand secondary sidebar)
    await page.getByTestId("titlebar-chats-sidebar").click();
    await page.waitForTimeout(800);
    await shot(page, "08-chats-light");
    await setTheme(page, "dark");
    await shot(page, "08-chats-dark");
    await setTheme(page, "light");
    // Close the panel so later shots keep their pre-panel composition.
    await page.getByTestId("chats-panel-collapse").click();

    // 09 — graph view
    await page.getByTestId("activity-graph").click();
    await page.waitForTimeout(1_000);
    await shot(page, "09-graph-light");

    // 10 — history view
    await page.getByTestId("activity-history").click();
    await page.waitForTimeout(800);
    await shot(page, "10-history-light");

    // (11 was the built-in Sites view and 12 the retired Agent panel; both
    // slots stay vacant so later shot names keep matching earlier audit runs.)

    // 13 — command palette
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(400);
    await shot(page, "13-command-palette-light");
    await page.keyboard.press("Escape");

    // 14 — quick open
    await page.keyboard.press("Control+p");
    await page.waitForTimeout(400);
    await shot(page, "14-quick-open-light");
    await page.keyboard.press("Escape");

    // 15 — settings dialog
    await page.getByTestId("activity-settings").click();
    await page.waitForTimeout(600);
    await shot(page, "15-settings-light");
    await setTheme(page, "dark");
    await shot(page, "15-settings-dark");
    await setTheme(page, "light");
    await page.keyboard.press("Escape");

    // 16 — CSV table view
    await page.getByTestId("activity-explorer").click();
    await explorerRow(page, "data").click();
    await explorerRow(page, "data/funnel.csv").click();
    await page.waitForTimeout(1_000);
    await shot(page, "16-csv-light");

    // 17 — dark shell overview (explorer + editor)
    await explorerRow(page, "notes/product-plan.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(500);
    await setTheme(page, "dark");
    await shot(page, "17-shell-dark");
    await setTheme(page, "light");

    // 18 — new file dialog
    await page.keyboard.press("Control+n");
    await page.waitForTimeout(400);
    await shot(page, "18-new-file-dialog-light");
    await page.keyboard.press("Escape");

    // 19 — settings: appearance section
    await page.getByTestId("activity-settings").click();
    await page.waitForTimeout(500);
    const appearanceNav = page.getByRole("button", { name: /appearance/i }).first();
    await appearanceNav.waitFor({ state: "visible", timeout: 3_000 });
    await appearanceNav.click();
    await page.waitForTimeout(400);
    await shot(page, "19-settings-appearance-light");
    await page.keyboard.press("Escape");

    // 20 — inline properties under the title. They render in the document
    // flow now (no toggle), so just open the doc and capture.
    if (!(await explorerRow(page, "notes").isVisible().catch(() => false))) {
      await page.getByTestId("activity-explorer").click();
    }
    await revealExplorerPath(page, "notes/product-plan.md");
    await explorerRow(page, "notes/product-plan.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByTestId("properties-panel")
      .waitFor({ state: "visible", timeout: 5_000 });
    const propertyKeys = page.getByTestId("property-key");
    await expect(propertyKeys).toHaveCount(3);
    const propertyNames = await propertyKeys.evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    );
    const statusIndex = propertyNames.indexOf("status");
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId("property-value").nth(statusIndex)).toHaveValue(
      "In progress",
    );
    await page.waitForTimeout(500);
    await shot(page, "20-properties-panel-light");
    if (
      git(["rev-parse", "HEAD"]) !== captureCommit ||
      git(["status", "--porcelain"]) !== ""
    ) {
      throw new Error("the worktree changed during the UI audit capture");
    }
    const capturedShots = activeCapture.shots.map((entry) => entry.name).sort();
    const expectedShots = [...expectedUiAuditShots].sort();
    if (
      capturedShots.length !== expectedShots.length ||
      capturedShots.some((name, index) => name !== expectedShots[index])
    ) {
      throw new Error("the UI audit capture did not produce every required screenshot");
    }
    activeCapture.state = "complete";
    activeCapture.completedAt = new Date().toISOString();
    await writeCaptureManifest();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
    activeCapture = null;
  }
});
