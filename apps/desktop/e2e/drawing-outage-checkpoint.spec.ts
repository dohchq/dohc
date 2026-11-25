import { expect, test, type Page } from "@playwright/test";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { engineDaemonPids, hardKillPid } from "./helpers/daemonKill";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const path = "plan.excalidraw";
const emptyScene = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [],
  appState: {},
  files: {},
});

type Scene = { elements: { type: string; isDeleted?: boolean }[] };
const rectangles = (scene: Scene) =>
  scene.elements.filter((element) => element.type === "rectangle" && !element.isDeleted).length;

async function rectanglesOnDisk(rootPath: string): Promise<number> {
  return rectangles(JSON.parse(await readFile(join(rootPath, path), "utf8")) as Scene);
}

async function checkpointRectangles(home: string): Promise<number[]> {
  const directory = join(home, "live-draft-recovery");
  const names = (await readdir(directory).catch(() => [])).filter((n) => n.endsWith(".json"));
  const counts = [];
  for (const name of names) {
    const record = JSON.parse(await readFile(join(directory, name), "utf8")) as {
      path?: string;
      text?: string;
    };
    if (record.path === path && record.text) counts.push(rectangles(JSON.parse(record.text)));
  }
  return counts;
}

async function openDrawing(page: Page): Promise<void> {
  await explorerRow(page, path).click();
  await expect(page.getByTestId("view-drawing")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("excalidraw-canvas").locator("canvas").first()).toBeVisible({
    timeout: 60_000,
  });
}

async function drawRectangle(page: Page, offset: number): Promise<void> {
  const box = await page.getByTestId("excalidraw-canvas").boundingBox();
  if (!box) throw new Error("The drawing canvas has no layout box.");
  const x = box.x + box.width / 3 + offset;
  const y = box.y + box.height / 3 + offset;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.6);
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

test("drawing changes made while the engine is gone come back after a quit", async () => {
  test.setTimeout(150_000);
  const temp = await createTempWorkspace();
  const gate = join(temp.baseDir, "publication.gate");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path, contents: emptyScene }]);
    await writeFile(gate, "gate");
    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_TEST_ENGINE_PUBLICATION_GATE: gate },
    });
    const { page, app } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, path);
    await openDrawing(page);

    await drawRectangle(page, 0);
    await expect.poll(() => rectanglesOnDisk(temp.rootPath), { timeout: 30_000 }).toBe(1);

    const pids = await engineDaemonPids(app.process().pid!);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) await hardKillPid(pid);
    await expect
      .poll(() =>
        access(gate + ".waiting").then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);

    await drawRectangle(page, 90);
    await expect.poll(() => checkpointRectangles(temp.homeDir), { timeout: 30_000 }).toEqual([2]);
    await test.info().attach("drawing-outage", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    page.on("dialog", () => undefined);
    const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
    await app.evaluate(({ app }) => app.quit());
    await exited;
    await desktop.close();
    desktop = null;
    expect(await rectanglesOnDisk(temp.rootPath)).toBe(1);
    expect(await checkpointRectangles(temp.homeDir)).toEqual([2]);
    await rm(gate, { force: true });

    desktop = await launchDesktopApp({ workspace: temp });
    const reopened = await openWorkspaceFromFirstRun(desktop.page, temp);
    await waitForWorkspaceFile(desktop.page, reopened.workspaceId, path);
    await expect.poll(() => checkpointRectangles(temp.homeDir), { timeout: 60_000 }).toEqual([]);
    await openDrawing(desktop.page);
    await expect.poll(() => rectanglesOnDisk(temp.rootPath), { timeout: 60_000 }).toBe(2);
    await test.info().attach("drawing-recovered", {
      body: await desktop.page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await rm(gate, { force: true });
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
