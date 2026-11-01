import { expect, test } from "@playwright/test";
import { editorTabTestId } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Chromium blurs a focused element, with the page already active, before it
// detaches it. Closing the focused tab from the keyboard or with its close
// button must still leave focus on the tab that takes its place.
test("@focus-removal a closed tab hands focus to the next tab after a key or a click", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const names = ["a.md", "b.md", "c.md"];
    await writeWorkspaceFiles(temp, names.map((path) => ({ path, contents: `# ${path}\n` })));
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    for (const name of names) {
      await explorerRow(page, name).click();
      await expect(page.getByTestId(editorTabTestId(name))).toHaveAttribute("aria-selected", "true");
    }
    const strip = page.getByTestId("editor-tabs");
    const selected = strip.getByRole("tab", { selected: true });

    const keyed = page.getByTestId(editorTabTestId("c.md"));
    await keyed.focus();
    await page.keyboard.press("Delete");
    await expect(keyed).toHaveCount(0);
    await expect(selected).toBeFocused();

    const clicked = page.getByTestId((await selected.getAttribute("data-testid"))!);
    const close = clicked.getByRole("button", { name: /^Close / });
    const box = (await close.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(close).toBeFocused();
    await page.mouse.up();
    await expect(clicked).toHaveCount(0);
    await expect(strip.getByRole("tab")).toHaveCount(1);
    await expect(selected).toBeFocused();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
