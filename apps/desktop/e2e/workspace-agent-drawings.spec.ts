import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDesktopEngineHealthy, launchDesktopApp } from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;
type AgentArgs<Args> = Args extends unknown ? Omit<Args, "cwd" | "actor"> : never;
type Scene = {
  elements: { id: string; type: string; x: number; isDeleted?: boolean; text?: string }[];
};

const path = "plan.excalidraw";

async function agentCli<Verb extends CliVerb>(
  temp: TempWorkspace,
  verb: Verb,
  args: AgentArgs<Extract<CliRequestWithoutToken, { verb: Verb }>["args"]>,
): Promise<CliResultByVerb[Verb]> {
  const request = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: { cwd: temp.rootPath, actor: "agent" as const, ...args },
  } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
  return await sendCliRequest<Verb>(request, { stateDir: temp.homeDir });
}

async function sceneOnDisk(temp: TempWorkspace): Promise<Scene["elements"]> {
  const text = await readFile(join(temp.rootPath, path), "utf8").catch(() => "");
  if (!text) return [];
  return (JSON.parse(text) as Scene).elements.filter((element) => !element.isDeleted);
}

async function drawRectangle(page: Page, offset: number): Promise<void> {
  const box = await page.getByTestId("excalidraw-canvas").boundingBox();
  if (!box) throw new Error("The drawing canvas has no layout box.");
  const x = box.x + box.width / 2 + offset;
  const y = box.y + box.height / 2 + offset;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.9);
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("Escape");
}

type InvokeHandlers = Map<string, (...args: unknown[]) => unknown>;
type HeldUpdates = { __dohcReleaseCanvasUpdates?: () => void };

async function holdCanvasUpdates(desktop: Desktop): Promise<void> {
  await desktop.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: InvokeHandlers })._invokeHandlers;
    const channel = "desktop:engine-ydoc-apply-update";
    const original = handlers.get(channel);
    if (!original) throw new Error("main has no canvas update handler");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    handlers.set(channel, async (...args: unknown[]) => {
      await gate;
      return await original(...args);
    });
    (globalThis as HeldUpdates).__dohcReleaseCanvasUpdates = () => {
      handlers.set(channel, original);
      open();
    };
  });
}

async function releaseCanvasUpdates(desktop: Desktop): Promise<void> {
  await desktop.app.evaluate(() => {
    const release = (globalThis as HeldUpdates).__dohcReleaseCanvasUpdates;
    if (!release) throw new Error("canvas updates are not held");
    release();
  });
}

test("an agent creates a drawing and edits it live while the person draws", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;
  try {
    const photo = {
      id: "f",
      created: 1_700_000_000_000,
      dataURL: `data:image/png;base64,${"A".repeat(3_000_000)}`,
      mimeType: "image/png",
    };
    await writeWorkspaceFiles(temp, [
      { path: "readme.md", contents: "# Plans\n" },
      {
        path: "photo.excalidraw",
        contents: JSON.stringify({
          type: "excalidraw",
          elements: [{ id: "photo", type: "image", version: 3, x: 0, y: 0, fileId: "f" }],
          files: { f: photo },
        }),
      },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "readme.md");
    await waitForCliEndpoint(temp.homeDir);
    const closed = await agentCli(temp, "drawingRead", { path: "photo.excalidraw" });
    expect(closed).toMatchObject({
      live: false,
      elements: [{ id: "photo", type: "image", version: 3 }],
    });
    expect(
      await agentCli(temp, "drawingEdit", {
        path: "photo.excalidraw",
        update: [{ id: "photo", expectedVersion: closed.elements[0]!.version, x: 50 }],
      }),
    ).toEqual({ ok: true, path: "photo.excalidraw", elements: [{ id: "photo", version: 4 }] });
    await expect
      .poll(
        async () =>
          (
            JSON.parse(await readFile(join(temp.rootPath, "photo.excalidraw"), "utf8")) as Scene
          ).elements.find((element) => element.id === "photo")?.x,
        { timeout: 30_000 },
      )
      .toBe(50);

    const create = {
      path,
      requestId: "create-plan",
      elements: [
        { id: "agent-box", type: "rectangle" as const, x: 40, y: 160, width: 160, height: 80 },
        { type: "text" as const, x: 0, y: 0, containerId: "agent-box", text: "Agent box" },
      ],
    };
    const created = await agentCli(temp, "drawingCreate", create);
    expect(created).toMatchObject({ ok: true, path, elements: [{ id: "agent-box" }, {}] });
    expect(await agentCli(temp, "drawingCreate", create)).toEqual(created);

    await waitForWorkspaceFile(page, workspace.workspaceId, path);
    await explorerRow(page, path).click();
    await expect(page.getByTestId("view-drawing")).toBeVisible({ timeout: 60_000 });
    const canvas = page.getByTestId("excalidraw-canvas");
    await expect(canvas.locator("canvas").first()).toBeVisible({ timeout: 60_000 });

    const opened = await agentCli(temp, "drawingRead", { path });
    expect(opened).toMatchObject({ live: true });
    const box = opened.elements.find((element) => element.id === "agent-box")!;
    expect(box).toMatchObject({ type: "rectangle", boundElements: [{ type: "text" }] });

    await holdCanvasUpdates(desktop);
    await drawRectangle(page, 0);
    const move = {
      path,
      requestId: "move-box",
      update: [{ id: "agent-box", expectedVersion: box.version, x: 400 }],
    };
    const moved = await agentCli(temp, "drawingEdit", move);
    expect(moved).toMatchObject({
      ok: true,
      elements: expect.arrayContaining([{ id: "agent-box", version: box.version + 1 }]),
    });
    await releaseCanvasUpdates(desktop);

    await expect
      .poll(
        async () => {
          const elements = await sceneOnDisk(temp);
          return {
            rectangles: elements.filter((element) => element.type === "rectangle").length,
            agentX: elements.find((element) => element.id === "agent-box")?.x,
            label: elements.find((element) => element.type === "text")?.text,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ rectangles: 2, agentX: 400, label: "Agent box" });
    const live = await agentCli(temp, "drawingRead", { path });
    expect(live.elements.filter((element) => element.type === "rectangle")).toHaveLength(2);
    await expect(page.getByTestId("view-drawing")).toBeVisible();

    expect(await agentCli(temp, "drawingEdit", move)).toEqual(moved);
    expect(
      (await agentCli(temp, "drawingRead", { path })).elements.find(
        (element) => element.id === "agent-box",
      )?.version,
    ).toBe(box.version + 1);

    const stale = await agentCli(temp, "drawingEdit", {
      path,
      requestId: "stale-move",
      update: [{ id: "agent-box", expectedVersion: box.version, x: 0 }],
    });
    expect(stale).toEqual({
      ok: false,
      reason: expect.stringContaining(`agent-box is at version ${box.version + 1}`),
    });
    expect((await sceneOnDisk(temp)).find((element) => element.id === "agent-box")?.x).toBe(400);

    await test.info().attach("agent-drawing-live", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await assertDesktopEngineHealthy(desktop.logs);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
