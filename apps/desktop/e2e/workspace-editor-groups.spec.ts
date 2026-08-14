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
    const leftGroup = page.getByRole("region", { name: "Editor group 1" });
    const rightGroup = page.getByRole("region", { name: "Editor group 2" });
    await expect(rightGroup).toBeVisible();
    await expect(leftGroup.getByTestId("tab-brief.md")).toBeVisible();
    await expect(rightGroup.getByTestId("tab-brief.md")).toBeVisible();
    await expect(leftGroup.getByTestId("view-markdown")).toBeVisible();
    await expect(rightGroup.getByTestId("view-markdown")).toBeVisible();

    await explorerRow(page, "data.csv").click();
    const markdown = leftGroup.getByTestId("view-markdown");
    const csv = rightGroup.getByTestId("view-csv");
    await expect(markdown).toBeVisible();
    await expect(csv).toBeVisible();

    const markdownBox = await markdown.boundingBox();
    const csvBox = await csv.boundingBox();
    expect(markdownBox).not.toBeNull();
    expect(csvBox).not.toBeNull();
    expect(markdownBox!.x + markdownBox!.width).toBeLessThanOrEqual(csvBox!.x + 1);

    const separator = page.getByRole("separator", { name: "Resize editor groups" });
    const before = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await separator.press("ArrowRight");
    await expect
      .poll(async () => Number(await separator.getAttribute("aria-valuenow")))
      .toBeGreaterThan(before);

    const csvTabBox = await rightGroup.getByTestId("tab-data.csv").boundingBox();
    const leftBox = await leftGroup.boundingBox();
    expect(csvTabBox).not.toBeNull();
    expect(leftBox).not.toBeNull();
    await page.mouse.move(
      csvTabBox!.x + csvTabBox!.width / 2,
      csvTabBox!.y + csvTabBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(leftBox!.x + leftBox!.width / 2, leftBox!.y + 60, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(leftGroup.getByTestId("tab-data.csv")).toBeVisible();
    await expect(rightGroup.getByTestId("tab-data.csv")).toHaveCount(0);

    await rightGroup.click({ position: { x: 20, y: 60 } });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+w" : "Control+w");
    await expect(rightGroup).toHaveCount(0);
    await expect(page.getByTestId("tab-brief.md")).toBeVisible();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
