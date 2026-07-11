import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
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

const RICH_DOC = `# Q3 product plan

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
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) });
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-theme", value);
  }, theme);
  await page.waitForTimeout(150);
}

test("@ui-audit capture baseline screenshots", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
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
    const sawFirstRun = await openFolder
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (sawFirstRun) {
      await shot(page, "01-first-run-light");
      await setTheme(page, "dark");
      await shot(page, "01-first-run-dark");
      await setTheme(page, "light");
    }
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

    // 08 — chats view
    await page.getByTestId("activity-chats").click();
    await page.waitForTimeout(800);
    await shot(page, "08-chats-light");
    await setTheme(page, "dark");
    await shot(page, "08-chats-dark");
    await setTheme(page, "light");

    // 09 — graph view
    await page.getByTestId("activity-graph").click();
    await page.waitForTimeout(1_000);
    await shot(page, "09-graph-light");

    // 10 — history view
    await page.getByTestId("activity-history").click();
    await page.waitForTimeout(800);
    await shot(page, "10-history-light");

    // 11 — sites view
    await page.getByTestId("activity-sites").click();
    await page.waitForTimeout(600);
    await shot(page, "11-sites-light");

    // 12 — agent view
    await page.getByTestId("activity-agent").click();
    await page.waitForTimeout(600);
    await shot(page, "12-agent-light");

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
    const hasAppearance = await appearanceNav
      .waitFor({ state: "visible", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (hasAppearance) {
      await appearanceNav.click();
      await page.waitForTimeout(400);
      await shot(page, "19-settings-appearance-light");
    }
    await page.keyboard.press("Escape");

    // 20 — properties panel open on the document. Clicking the ACTIVE rail
    // item toggles the panel closed, so only click when the tree is hidden.
    if (!(await explorerRow(page, "notes").isVisible().catch(() => false))) {
      await page.getByTestId("activity-explorer").click();
    }
    await revealExplorerPath(page, "notes/product-plan.md");
    await explorerRow(page, "notes/product-plan.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({
      timeout: 20_000,
    });
    const propsToggle = page.getByTestId("markdown-properties-toggle");
    if (await propsToggle.isVisible().catch(() => false)) {
      await propsToggle.click();
      await page.waitForTimeout(500);
      await shot(page, "20-properties-panel-light");
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
