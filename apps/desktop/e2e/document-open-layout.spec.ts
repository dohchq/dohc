import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// While a document opens, MarkdownView draws a read body; when the engine
// session binds, the editor replaces it. Every block must already sit where
// the editor puts it, or the page jumps as the open finishes.

// Enough properties to wrap onto several lines, a table wider than the
// reading column, which scrolls in its frame, and a table with two resized
// rows, whose heights the comment above it keeps.
const WIDE_HEADER = `| ${Array.from({ length: 10 }, (_, i) => `Day ${i + 1}`).join(" | ")} |`;
const DOC = `---
status: draft
owner: Planning group
destination: Lofoten islands
season: late summer
budget: 2400 EUR
travellers: four adults
transport: ferry and rental car
lodging: rorbu cabins
priority: high
review: before booking
---

# Packing list

A paragraph under the first heading.

## Gear

- Tent
- Stove
  - Fuel

### Notes

> Pack light, then pack lighter.

\`\`\`ts
const bags = 2;
\`\`\`

| Item | Count |
| --- | --- |
| Tent | 1 |

${WIDE_HEADER}
|${" --- |".repeat(10)}
|${" Hike |".repeat(10)}

<!-- dohc:table row-heights=1:84,2:120 -->
| Leg | Hours |
| --- | --- |
| Ferry | 3 |
| Drive | 5 |

The last paragraph.
`;

type Box = { x: number; y: number; width: number; height: number };

// Main looks the handler up on each invoke, so swapping the entry holds every
// open until release (as in workspace-agent-documents.spec.ts).
type InvokeHandlers = Map<string, (...args: unknown[]) => unknown>;
type HeldOpens = { __dohcReleaseDocumentOpens?: () => void };

async function holdDocumentOpens(desktop: LaunchedDesktopApp): Promise<void> {
  await desktop.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: InvokeHandlers })._invokeHandlers;
    const channel = "desktop:engine-ydoc-open";
    const original = handlers.get(channel);
    if (!original) throw new Error("main has no document open handler");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    handlers.set(channel, async (...args: unknown[]) => {
      await gate;
      return await original(...args);
    });
    (globalThis as HeldOpens).__dohcReleaseDocumentOpens = () => {
      handlers.set(channel, original);
      open();
    };
  });
}

async function releaseDocumentOpens(desktop: LaunchedDesktopApp): Promise<void> {
  await desktop.app.evaluate(() => {
    const release = (globalThis as HeldOpens).__dohcReleaseDocumentOpens;
    if (!release) throw new Error("document opens are not held");
    release();
  });
}

// Each block's box, from the body that holds the first heading: the read body
// while opening, the editor once ready.
async function measureBlocks(page: Page): Promise<Record<string, Box | null>> {
  return page.evaluate(() => {
    const view = document.querySelector('[data-testid="view-markdown"]');
    const root = [...(view?.querySelectorAll("h1") ?? [])].find(
      (heading) => heading.textContent?.trim() === "Packing list",
    )?.parentElement;
    if (!root) throw new Error("document body not drawn");
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const round = (value: number) => Math.round(value * 10) / 10;
      return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
    };
    const paragraphs = root.querySelectorAll(":scope > p");
    const tables = root.querySelectorAll("table");
    const properties = view?.querySelectorAll('[data-testid="property-row"]') ?? [];
    const topmatter = Object.fromEntries(
      [...(view?.querySelector(".group\\/topmatter")?.children ?? [])].map((child, index) => [
        `topmatter${index}`,
        box(child),
      ]),
    );
    return {
      ...topmatter,
      h1: box(root.querySelector(":scope > h1")),
      paragraph: box(paragraphs[0]),
      h2: box(root.querySelector(":scope > h2")),
      list: box(root.querySelector(":scope > ul")),
      listItem: box(root.querySelector(":scope > ul > li")),
      nestedItem: box(root.querySelector(":scope > ul li ul > li")),
      h3: box(root.querySelector(":scope > h3")),
      quote: box(root.querySelector(":scope > blockquote")),
      code: box(root.querySelector(":scope > pre")),
      firstProperty: box(properties[0]),
      lastProperty: box(properties[properties.length - 1]),
      table: box(tables[0]),
      headerCell: box(tables[0]?.querySelector("th")),
      bodyCell: box(tables[0]?.querySelector("td")),
      wideFrame: box(tables[1]?.parentElement),
      wideTable: box(tables[1]),
      wideLastHeaderCell: box(tables[1]?.querySelector("th:last-child")),
      resizedTable: box(tables[2]),
      tallRow: box(tables[2]?.querySelectorAll("tr")[1]),
      tallerRow: box(tables[2]?.querySelectorAll("tr")[2]),
      lastParagraph: box(paragraphs[paragraphs.length - 1]),
    };
  });
}

// Measures until two reads agree, so lazy chunks have drawn.
async function settledBlocks(page: Page): Promise<Record<string, Box | null>> {
  let previous = "";
  let blocks: Record<string, Box | null> = {};
  await expect
    .poll(async () => {
      blocks = await measureBlocks(page);
      const current = JSON.stringify(blocks);
      const settled = current === previous;
      previous = current;
      return settled;
    }, { timeout: 15_000 })
    .toBe(true);
  return blocks;
}

async function shoot(page: Page, dir: string, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute("data-theme", value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, theme);
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

test("an opening document draws each block where the ready editor draws it", async () => {
  test.setTimeout(120_000);
  const shotDir = test.info().outputPath("open-layout");
  await mkdir(shotDir, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;

  try {
    await writeWorkspaceFiles(temp, [{ path: "notes/packing.md", contents: DOC }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { app, page } = desktop;
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1600, 950);
    });
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/packing.md");

    await holdDocumentOpens(desktop);
    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/packing.md").click();
    await expect(page.getByTestId("markdown-edit-toggle")).toBeDisabled({ timeout: 20_000 });
    await expect(page.getByTestId("view-markdown")).toContainText("The last paragraph.");
    await expect(page.getByTestId("property-row")).toHaveCount(10);
    const opening = await settledBlocks(page);
    await shoot(page, shotDir, "opening");

    await releaseDocumentOpens(desktop);
    await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId("markdown-editor")).toBeVisible();
    await expect(page.getByTestId("property-add")).toBeVisible();
    const ready = await settledBlocks(page);
    await shoot(page, shotDir, "ready");

    const offsets = Object.fromEntries(
      Object.keys(ready).map((key) => {
        const before = opening[key];
        const after = ready[key];
        if (!before || !after) return [key, null];
        return [key, {
          x: Math.round((after.x - before.x) * 10) / 10,
          y: Math.round((after.y - before.y) * 10) / 10,
          width: Math.round((after.width - before.width) * 10) / 10,
          height: Math.round((after.height - before.height) * 10) / 10,
        }];
      }),
    );
    console.log(`[document-open-layout] offsets ${JSON.stringify(offsets)}`);
    await writeFile(join(shotDir, "blocks.json"), JSON.stringify({ opening, ready, offsets }, null, 2));

    for (const [key, offset] of Object.entries(offsets)) {
      expect.soft(offset, `${key} draws in both states`).not.toBeNull();
      if (!offset) continue;
      for (const side of ["x", "y", "width", "height"] as const) {
        expect.soft(Math.abs(offset[side]), `${key} ${side} moves when the editor replaces the read body`).toBeLessThanOrEqual(0.5);
      }
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
