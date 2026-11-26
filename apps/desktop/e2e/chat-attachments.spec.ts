import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import type { ElectronApplication } from "playwright";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openChatsView,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
} from "./helpers/workspace";
import { cleanupTestScratch, createTestScratch } from "../src/workspaces/testTemp";

function pictureBase64(): string {
  const picture = new PNG({ width: 480, height: 300 });
  for (let y = 0; y < picture.height; y++) {
    for (let x = 0; x < picture.width; x++) {
      const at = (y * picture.width + x) * 4;
      const sea = y > 180;
      picture.data[at] = sea ? 40 : 250 - y / 2;
      picture.data[at + 1] = sea ? 120 + (x % 40) : 180 - y / 3;
      picture.data[at + 2] = sea ? 190 : 90 + y / 2;
      picture.data[at + 3] = 255;
    }
  }
  return PNG.sync.write(picture).toString("base64");
}

test.afterEach(async () => {
  await cleanupTestScratch();
});

async function pasteImage(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((box, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "image.png", { type: "image/png" }));
    box.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, pictureBase64());
}

async function dropFile(
  app: ElectronApplication,
  page: Page,
  testId: string,
  filePath: string,
): Promise<void> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no bounding box`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const cdp = await app.context().newCDPSession(page);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
  await cdp.detach();
}

test("a Group chat takes pasted, dropped and picked files, and shows a sent picture", async () => {
  const temp = await createTempWorkspace();
  const outside = await createTestScratch("dohc-chat-files-");
  const clip = join(outside, "Beach clip.mp4");
  const report = join(outside, "Budget.pdf");
  await writeFile(clip, Buffer.from("not really a video"));
  await writeFile(report, Buffer.from("%PDF-1.4\n"));
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_TEST_IMPORT_PATHS: JSON.stringify([report]) },
    });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);

    await openChatsView(page);
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Trip plan");
    await page.getByTestId("chats-new-channel-type-both").click();
    await page.getByTestId("chats-new-channel-submit").click();
    const channelView = page.locator('[data-testid="chats-channel-view"][data-variant="page"]');
    await expect(channelView.getByTestId("chats-channel-title")).toHaveText("Trip plan");
    await waitForWorkspaceFile(page, workspace.workspaceId, "trip-plan");
    await channelView.getByTestId("chats-group-lane-chat").click();

    const composer = channelView.getByTestId("chats-lane-composer");
    await composer.fill("Here are the photos");
    await pasteImage(page, "chats-lane-composer");
    await expect(composer).toHaveValue(
      /^Here are the photos @\[trip-plan\/image-[0-9a-z]+\.png\] $/u,
    );

    await dropFile(desktop.app, page, "chats-lane-composer", clip);
    await expect(composer).toHaveValue(/@\[trip-plan\/Beach clip\.mp4\] $/u);

    await channelView.getByTestId("chats-lane-add").click();
    await page.getByTestId("chats-lane-add-files").click();
    await expect(composer).toHaveValue(/@\[trip-plan\/Budget\.pdf\] $/u);
    await page.screenshot({ path: test.info().outputPath("composer.png") });

    await composer.press("Enter");
    const body = channelView.getByTestId("chats-lane-message-body").last();
    await expect(body).toContainText("Here are the photos");
    const picture = body.locator("img");
    await expect(picture).toHaveCount(1);
    await expect
      .poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(body).toContainText("Beach clip.mp4");
    await expect(body).toContainText("Budget.pdf");
    await page.screenshot({ path: test.info().outputPath("sent.png") });

    const saved = await readdir(join(temp.rootPath, "trip-plan"));
    expect(saved).toEqual(
      expect.arrayContaining([
        "Beach clip.mp4",
        "Budget.pdf",
        expect.stringMatching(/^image-[0-9a-z]+\.png$/u),
      ]),
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
