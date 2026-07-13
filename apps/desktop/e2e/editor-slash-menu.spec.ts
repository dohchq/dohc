import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Slash-menu flicker regression (engine editor). Two failure modes are pinned:
//
// 1. Remount churn — if typing a query ever closes+reopens the menu (state
//    passing through CLOSED, plugin re-registration, editor recreation), the
//    element remounts and the dohc-pop-in entrance animation replays on every
//    keystroke: visible flicker. The MutationObserver + animationstart
//    counters must stay at exactly one mount / one entrance.
//
// 2. Above-placement detachment — a menu opened above the cursor (typing in
//    the lower part of the window) used to be TOP-anchored at
//    `cursorTop - gap - maxHeight`, assuming full maxHeight content. Filtering
//    shrinks the list, so the box hung detached above the caret and its bottom
//    edge leapt up/down (~180px) with every keystroke. It is now anchored by
//    its bottom edge, which must stay glued next to the caret at any query.

declare global {
  interface Window {
    __slashDiag?: {
      added: number;
      removed: number;
      animStarts: number;
    };
  }
}

test("@slash-menu slash menu neither remounts nor detaches while filtering", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    const longBody = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i + 1} with a fair amount of running text in it.`,
    ).join("\n\n");
    await writeWorkspaceFiles(temp, [
      { path: "notes/doc.md", contents: `# Doc\n\n${longBody}\n` },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);

    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/doc.md").click();
    // Engine mode: WYSIWYG is the whole surface, no Edit gate.
    await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, {
      timeout: 15_000,
    });
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();

    await page.evaluate(() => {
      const diag = { added: 0, removed: 0, animStarts: 0 };
      window.__slashDiag = diag;
      const isMenu = (node: Node): boolean =>
        node instanceof HTMLElement && node.classList.contains("dohc-slash-menu");
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (isMenu(node)) diag.added += 1;
          });
          mutation.removedNodes.forEach((node) => {
            if (isMenu(node)) diag.removed += 1;
          });
        }
      }).observe(document.body, { childList: true, subtree: true });
      document.addEventListener(
        "animationstart",
        (event) => {
          const target = event.target as HTMLElement;
          if (target?.classList?.contains("dohc-slash-menu")) diag.animStarts += 1;
        },
        true,
      );
    });

    // ── 1. remount churn while typing and erasing a query ──
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/", { delay: 40 });
    const menu = page.locator(".dohc-slash-menu");
    await expect(menu).toBeVisible();
    await page.keyboard.type("head", { delay: 25 });
    await expect(menu.getByRole("option", { name: /heading 1/i })).toBeVisible();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Backspace");
    }
    await expect(menu.getByRole("option", { name: /table/i })).toBeVisible();

    const diag = await page.evaluate(() => window.__slashDiag);
    expect(diag?.added).toBe(1);
    expect(diag?.removed).toBe(0);
    expect(diag?.animStarts).toBe(1);

    // ── 2. above placement stays glued to the caret while filtering ──
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    // Click at the end of a paragraph low in the viewport so the menu must
    // open above the caret.
    const target = await page.evaluate(() => {
      const paragraphs = Array.from(
        document.querySelectorAll('[data-testid="markdown-editor"] p'),
      );
      const viewportHeight = window.innerHeight;
      const candidate = paragraphs.find((p) => {
        const rect = p.getBoundingClientRect();
        return rect.top > viewportHeight * 0.65 && rect.bottom < viewportHeight - 40;
      });
      if (!candidate) return null;
      const rect = candidate.getBoundingClientRect();
      return { x: rect.right - 4, y: rect.top + rect.height / 2 };
    });
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
    await page.keyboard.press("End");
    await page.keyboard.type(" /", { delay: 40 });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-placement", "above");

    const menuBottom = async (): Promise<number> =>
      page.evaluate(() => {
        const el = document.querySelector(".dohc-slash-menu");
        if (!el) throw new Error("slash menu not open");
        return el.getBoundingClientRect().bottom;
      });

    // Entrance animation settles first (it translates the box slightly).
    await page.waitForTimeout(250);
    const anchoredBottom = await menuBottom();
    // The bottom edge sits just above the caret line the user typed on.
    expect(Math.abs(anchoredBottom - target!.y)).toBeLessThan(40);

    for (const ch of "head") {
      await page.keyboard.type(ch, { delay: 20 });
      await page.waitForTimeout(60);
      // Filtering shrinks the menu; its caret-side edge must not move.
      expect(Math.abs((await menuBottom()) - anchoredBottom)).toBeLessThan(1.5);
    }
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(60);
      expect(Math.abs((await menuBottom()) - anchoredBottom)).toBeLessThan(1.5);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
