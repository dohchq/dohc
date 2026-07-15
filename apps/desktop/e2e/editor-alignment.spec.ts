import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Left-alignment audit for the WYSIWYG editor: the TEXT of every top-level
// block type must share one left content edge — a straight vertical line down
// the gutter touches all of it. Decorations (list markers, task checkboxes,
// the quote bar) hang LEFT of that edge, and framed blocks (code, tables,
// callouts) extend --dohc-editor-block-inset past the column so their inner
// padding lands their text back on the edge. This spec measures the first
// text glyph of each block against a plain paragraph's.

const ALIGNMENT_DOC = `# Heading one

A plain paragraph that defines the shared content edge.

## Heading two

### Heading three

- Bullet item text
  - Nested bullet text

1. Ordered item text

- [ ] Task item text
- [x] Done task text

> A quoted line whose accent bar hangs in the gutter.

> [!tip] Callout title
> Callout body text on the edge.

\`\`\`ts
const code = "on the edge";
\`\`\`

| Alpha | Beta |
| --- | --- |
| Cell text | More |

---

Closing paragraph after the rule.
`;

interface BlockEdges {
  paneWidth: number;
  edges: Record<string, number | null>;
  boxes: Record<string, { left: number; right: number } | null>;
}

async function measure(page: import("@playwright/test").Page): Promise<BlockEdges> {
  return page.evaluate(() => {
    const editor = document.querySelector(".dohc-notion-editor");
    if (!editor) throw new Error("editor not mounted");

    const firstTextLeft = (el: Element | null): number | null => {
      if (!el) return null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.textContent && node.textContent.trim().length > 0
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
      });
      const node = walker.nextNode();
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getClientRects()[0];
      return rect ? rect.left : null;
    };

    const q = (selector: string): Element | null => editor.querySelector(selector);
    const box = (el: Element | null) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    };

    const taskItems = editor.querySelectorAll(
      ':scope > ul[data-type="taskList"] > li, :scope > ul > li[data-checked]',
    );

    return {
      paneWidth: editor.getBoundingClientRect().width,
      edges: {
        paragraph: firstTextLeft(q(":scope > p")),
        h1: firstTextLeft(q(":scope > h1")),
        h2: firstTextLeft(q(":scope > h2")),
        h3: firstTextLeft(q(":scope > h3")),
        bullet: firstTextLeft(q(":scope > ul:not([data-type='taskList']) > li")),
        nestedBullet: firstTextLeft(q(":scope > ul li ul > li")),
        ordered: firstTextLeft(q(":scope > ol > li")),
        task: firstTextLeft(taskItems[0]?.querySelector("div") ?? null),
        blockquote: firstTextLeft(q(":scope > blockquote")),
        callout: firstTextLeft(q(".dohc-callout-body > p")),
        code: firstTextLeft(q(":scope > pre code")),
        // Resizable tables render inside a .tableWrapper nodeview div.
        tableCell: firstTextLeft(q("table th:first-child")),
      },
      boxes: {
        hr: box(q(":scope > hr")),
        pre: box(q(":scope > pre")),
        table: box(q("table")),
        callout: box(q(".dohc-callout")),
        checkbox: box(taskItems[0]?.querySelector("input[type='checkbox']") ?? null),
      },
    };
  });
}

test("every block type's text sits on one shared left content edge", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [{ path: "notes/alignment.md", contents: ALIGNMENT_DOC }]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { app, page } = desktop;

    // Wide enough that the editor pane (window minus explorer + history rails)
    // clears measure + 2 insets + padding, so the framed-block overhang is
    // actually in effect.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1800, 950);
    });

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/alignment.md");
    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/alignment.md").click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".dohc-callout")).toBeVisible({ timeout: 10_000 });

    const { paneWidth, edges, boxes } = await measure(page);
    expect(paneWidth).toBeGreaterThan(864); // measure(720) + 2*inset(16) + 2*pad(56)

    const edge = edges.paragraph;
    expect(edge).not.toBeNull();

    // Text-bearing blocks: first glyph on the shared edge (subpixel slack).
    for (const key of [
      "h1",
      "h2",
      "h3",
      "bullet",
      "ordered",
      "task",
      "blockquote",
      "callout",
      "code",
      "tableCell",
    ] as const) {
      expect(edges[key], `${key} must render text`).not.toBeNull();
      expect
        .soft(Math.abs(edges[key]! - edge!), `${key} text must sit on the content edge`)
        .toBeLessThanOrEqual(1.5);
    }

    // Nested list items keep their 24px relative indent off the edge.
    expect(edges.nestedBullet).not.toBeNull();
    expect(Math.abs(edges.nestedBullet! - edge! - 24)).toBeLessThanOrEqual(1.5);

    // The horizontal rule spans from the edge.
    expect(boxes.hr).not.toBeNull();
    expect(Math.abs(boxes.hr!.left - edge!)).toBeLessThanOrEqual(1.5);

    // Task checkboxes hang fully left of the edge (decoration, not content).
    expect(boxes.checkbox).not.toBeNull();
    expect(boxes.checkbox!.right).toBeLessThan(edge!);

    // Framed blocks extend one block inset (16px) into both gutters.
    for (const key of ["pre", "table", "callout"] as const) {
      expect(boxes[key], `${key} frame must render`).not.toBeNull();
      expect
        .soft(Math.abs(edge! - 16 - boxes[key]!.left), `${key} frame overhangs the left gutter`)
        .toBeLessThanOrEqual(1.5);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
