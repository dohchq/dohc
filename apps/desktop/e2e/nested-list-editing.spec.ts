import { expect, test, type Locator } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRichdocMarkdown } from "@dohc/ydoc-projection";
import { launchDesktopApp } from "./helpers/desktopApp";
import { DOCUMENT_END, LINE_START } from "./helpers/keys";
import {
  cleanupDesktopWorkspace, createTempWorkspace, explorerRow,
  openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles,
} from "./helpers/workspace";

async function editorItems(editor: Locator) {
  return editor.evaluate(root => [...root.querySelectorAll("li")].map(item => {
    let depth = 0;
    for (let parent = item.parentElement; parent; parent = parent.parentElement) {
      if (parent.tagName === "LI") depth++;
    }
    return {
      text: item.querySelector(":scope > p, :scope > div > p")?.textContent,
      kind: item.parentElement?.getAttribute("data-type") === "taskList" ? "taskList"
        : item.parentElement?.tagName === "OL" ? "orderedList" : "bulletList",
      depth,
      list: [...root.querySelectorAll("ul, ol")].indexOf(item.parentElement!),
    };
  }));
}

function markdownItems(markdown: string) {
  const items: { text: string; kind: string; depth: number; list: number }[] = [];
  let nextList = 0;
  const walk = (node: ReturnType<typeof parseRichdocMarkdown>, depth = -1, kind = "", list = -1) => {
    if (["bulletList", "orderedList", "taskList"].includes(node.type ?? "")) { kind = node.type!; list = nextList++; }
    if (["listItem", "taskItem"].includes(node.type ?? "")) {
      depth++;
      const text = (node.content?.[0]?.content ?? []).map(child => child.text ?? "").join("");
      items.push({ text, kind, depth, list });
    }
    node.content?.forEach(child => walk(child, depth, kind, list));
  };
  walk(parseRichdocMarkdown(markdown));
  return items;
}

test("@nested-list-editing typed nested lists survive reopen and restart", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [
      { path: "nested.md", contents: "" }, { path: "other.md", contents: "Other document.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace });
    let page = desktop.page;
    const opened = await openWorkspaceFromFirstRun(page, workspace);
    await waitForWorkspaceFile(page, opened.workspaceId, "nested.md");
    await explorerRow(page, "nested.md").click();
    let editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("- parent");
    await page.keyboard.press("Enter");
    await page.keyboard.type("child");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.type("grandchild");
    await page.keyboard.press("Tab");
    await expect(editor.locator("li li li")).toHaveText("grandchild");

    // Convert the typed child through the slash menu.
    await editor.locator("p").filter({ hasText: /^child$/ }).click();
    await page.keyboard.press(LINE_START);
    await page.keyboard.type("/todo");
    await page.getByRole("option", { name: /Todo list/ }).click();
    await expect(editor.locator('li li input[type="checkbox"]')).toHaveCount(1);

    // Paste at a new textblock, then convert beside an existing checklist.
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.press("Enter");
    const inList = () => page.evaluate(() => {
      const anchor = window.getSelection()?.anchorNode;
      const element = anchor instanceof Element ? anchor : anchor?.parentElement;
      return !!element?.closest("li");
    });
    for (let i = 0; i < 4 && await inList(); i++) await page.keyboard.press("Enter");
    expect(await inList()).toBe(false);
    await page.keyboard.type("Pasted section");
    await page.keyboard.press("Enter");
    const pasted = "- pasted parent\n  - [ ] a\n  - pasted child\n    - pasted grandchild";
    await desktop.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasted);
    await page.keyboard.press("ControlOrMeta+V");
    await expect(editor.locator("li").filter({ hasText: /^pasted grandchild$/ })).toHaveCount(1);
    await editor.locator("p").filter({ hasText: /^pasted child$/ }).click();
    await page.keyboard.press(LINE_START);
    await page.keyboard.type("/todo");
    await page.getByRole("option", { name: /Todo list/ }).click();
    const pastedParent = editor.locator("li").filter({ has: page.locator("p", { hasText: /^pasted parent$/ }) }).first();
    await expect(pastedParent.locator('ul[data-type="taskList"]')).toHaveCount(1);
    const structure = await editorItems(editor);
    expect(structure.map(item => item.text)).toEqual([
      "parent", "child", "grandchild", "pasted parent", "a", "pasted child", "pasted grandchild",
    ]);
    expect(structure.map(item => item.depth)).toEqual([0, 1, 2, 0, 1, 1, 2]);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(async () => markdownItems(await readFile(join(workspace.rootPath, "nested.md"), "utf8"))).toEqual(structure);

    // Close the tab so reopen cannot reuse its mounted editor.
    const tab = page.getByRole("tab", { name: /nested/ });
    await tab.getByRole("button", { name: /close/i }).click();
    await explorerRow(page, "other.md").click();
    await expect(page.getByTestId("markdown-editor")).toContainText("Other document.");
    await explorerRow(page, "nested.md").click();
    editor = page.getByTestId("markdown-editor");
    await expect.poll(() => editorItems(editor)).toEqual(structure);
    expect(markdownItems(await readFile(join(workspace.rootPath, "nested.md"), "utf8"))).toEqual(structure);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await expect.poll(() => editorItems(editor)).toEqual(structure);
      const indent = await editor.evaluate(root => {
        const rows = [...root.querySelectorAll("li > p, li > div > p")].map(node => node.getBoundingClientRect().left);
        return rows[1]! > rows[0]! && rows[2]! > rows[1]!;
      });
      expect(indent).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`nested-list-${theme}-reduced-motion.png`) });
    }
    await desktop.close(); desktop = null;
    desktop = await launchDesktopApp({ workspace }); page = desktop.page;
    await openWorkspaceFromFirstRun(page, workspace);
    await waitForWorkspaceFile(page, opened.workspaceId, "nested.md");
    await explorerRow(page, "nested.md").click();
    await expect.poll(() => editorItems(page.getByTestId("markdown-editor"))).toEqual(structure);
    expect(markdownItems(await readFile(join(workspace.rootPath, "nested.md"), "utf8"))).toEqual(structure);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
