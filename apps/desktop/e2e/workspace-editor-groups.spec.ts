import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("editor groups keep mixed surfaces visible, resize, and collapse", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "brief.md", contents: "# Brief\n\nKeep this visible.\n" },
      { path: "data.csv", contents: "name,value\nAda,1\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await explorerRow(page, "brief.md").click();
    await expect(page.getByTestId("view-markdown")).toBeVisible();
    await page.getByTestId("create-editor-group-right").click();
    await expect(page.getByRole("region", { name: "Editor group 2" })).toBeVisible();

    await explorerRow(page, "data.csv").click();
    const markdown = page
      .getByRole("region", { name: "Editor group 1" })
      .getByTestId("view-markdown");
    const csv = page
      .getByRole("region", { name: "Editor group 2" })
      .getByTestId("view-csv");
    await expect(markdown).toBeVisible();
    await expect(csv).toBeVisible();

    const markdownBox = await markdown.boundingBox();
    const csvBox = await csv.boundingBox();
    expect(markdownBox).not.toBeNull();
    expect(csvBox).not.toBeNull();
    expect(markdownBox!.x + markdownBox!.width).toBeLessThanOrEqual(csvBox!.x + 1);

    const separator = page.getByRole("separator", { name: "Resize editor groups" });
    const before = await separator.getAttribute("aria-valuenow");
    await separator.focus();
    await separator.press("ArrowRight");
    await expect(separator).not.toHaveAttribute("aria-valuenow", before ?? "50");

    await page.keyboard.press(process.platform === "darwin" ? "Meta+w" : "Control+w");
    await expect(page.getByRole("region", { name: "Editor group 2" })).toHaveCount(0);
    await expect(page.getByTestId("tab-brief.md")).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
