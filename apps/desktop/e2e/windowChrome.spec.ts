import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

// Phase E1 gate: custom titlebar (drag region, quick-open affordance,
// relocated workspace switcher), real application menu wired to the shell's
// command registry, and window-state persistence across relaunch.

test("titlebar: drag strip with no-drag controls, quick-open affordance, switcher", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();

  // First-run is frameless too — it must carry the drag strip already.
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  const firstRunTitlebar = page.getByTestId("titlebar");
  await expect(firstRunTitlebar).toBeVisible();
  expect(
    await firstRunTitlebar.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("-webkit-app-region").trim(),
    ),
  ).toBe("drag");

  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  // Shell titlebar: drag region; EVERY interactive child opts out.
  const titlebar = page.getByTestId("titlebar");
  await expect(titlebar).toBeVisible();

  // The strip and the OS titleBarOverlay must agree on height (40px,
  // TITLEBAR_HEIGHT_PX) — and that only holds while the root font stays
  // 16px: a font-size on <html> would silently rebase every rem-derived
  // dimension in the app. Both are gated here.
  const geometry = await titlebar.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    rootFontSize: getComputedStyle(document.documentElement).fontSize,
  }));
  expect(geometry.height).toBe(40);
  expect(geometry.rootFontSize).toBe("16px");
  expect(
    await titlebar.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("-webkit-app-region").trim(),
    ),
  ).toBe("drag");
  const draggableControls = await titlebar.evaluate((el) =>
    Array.from(el.querySelectorAll("button")).filter(
      (button) =>
        getComputedStyle(button).getPropertyValue("-webkit-app-region").trim() !==
        "no-drag",
    ).length,
  );
  expect(draggableControls).toBe(0);

  // The centered quick-open affordance opens quick-open.
  await page.getByTestId("titlebar-quick-open").click();
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-open")).toHaveCount(0);

  // The workspace switcher now lives in the titlebar.
  await titlebar.getByTestId("workspace-switcher").click();
  const switcherList = page.getByRole("listbox", { name: /workspaces/i });
  await expect(switcherList.getByRole("option")).toHaveCount(1);
  await expect(switcherList).toContainText("personal");

  await app.close();
});

test("application menu: structure installed, commands route to the registry", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  // Real application menu with the full File/Edit/View/Go/Help structure.
  const menu = await app.evaluate(({ Menu }) => {
    const applicationMenu = Menu.getApplicationMenu();
    return applicationMenu?.items.map((item) => ({
      label: item.label,
      items: item.submenu?.items.map((sub) => sub.label),
    }));
  });
  expect(menu?.map((entry) => entry.label)).toEqual([
    "File",
    "Edit",
    "View",
    "Go",
    "Help",
  ]);
  expect(menu?.[0].items).toContain("New File");
  expect(menu?.[0].items).toContain("Open Recent");
  expect(menu?.[2].items).toContain("Command Palette");

  const openRecent = await app.evaluate(({ Menu }) => {
    const fileMenu = Menu.getApplicationMenu()?.items.find(
      (item) => item.label === "File",
    );
    const item = fileMenu?.submenu?.items.find((sub) => sub.label === "Open Recent");
    return item?.submenu?.items.map((sub) => ({
      label: sub.label,
      sublabel: sub.sublabel,
      enabled: sub.enabled,
    }));
  });
  expect(openRecent?.[0]).toMatchObject({
    label: "personal",
    sublabel: join(testHome, "dohc", "personal"),
    enabled: true,
  });

  // Drive menu commands exactly the way a click does (webContents.send on the
  // menu-command channel) and assert the renderer routes each through the
  // SAME registry the palette uses.
  const send = (command: string) =>
    app.evaluate(({ BrowserWindow }, cmd) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        "desktop:menu-command",
        cmd,
      );
    }, command);

  await send("command-palette");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");

  await send("quick-open");
  await expect(page.getByTestId("quick-open")).toBeVisible();
  await page.keyboard.press("Escape");

  await send("new-file");
  await expect(page.getByRole("textbox", { name: /file name/i })).toBeVisible();
  await page.keyboard.press("Escape");

  await send("toggle-sidebar");
  await expect(page.getByTestId("file-tree")).toHaveCount(0);
  await send("toggle-sidebar");
  await expect(page.getByTestId("file-tree")).toBeVisible();

  // Pin the starting scheme (the X server's preference varies), then flip.
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  await send("toggle-theme");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");

  await send("settings");
  await expect(page.getByTestId("settings-panel")).toBeVisible();

  // Smoke check: an unknown command crashes nothing and opens no surface.
  // (This does NOT prove the preload validation boundary — the shell's
  // registry lookup would no-op an unknown id anyway; the real coverage is
  // preload.ts's tuple check plus the typecheck.)
  await send("definitely-not-a-command");
  await expect(page.getByTestId("command-palette")).toHaveCount(0);
  await expect(page.getByTestId("quick-open")).toHaveCount(0);

  await app.close();
});

test("cold Open with dohc activates the requested workspace, not registry[0]", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-open-with-"));
  const alpha = join(testHome, "alpha");
  const beta = join(testHome, "beta");
  const workspaces = [
    {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      rootPath: alpha,
      kind: "personal" as const,
      mode: "local-first" as const,
    },
    {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      rootPath: beta,
      kind: "personal" as const,
      mode: "local-first" as const,
    },
  ];
  for (const workspace of workspaces) {
    await mkdir(join(workspace.rootPath, ".dohc"), { recursive: true });
    await writeFile(
      join(workspace.rootPath, ".dohc", "manifest.json"),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.workspaceId,
        kind: workspace.kind,
        mode: workspace.mode,
      }),
    );
  }
  await writeFile(
    join(testHome, "dohc-workspaces.json"),
    JSON.stringify({ version: 1, workspaces }, null, 2),
  );

  const app = await launchApp(
    { DOHC_TEST_HOME: testHome },
    ["--open-workspace", beta],
  );
  const page = await app.firstWindow();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-switcher")).toContainText("beta");

  await app.close();
});

test("malformed registry entries are surfaced, not silently hidden", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-bad-registry-"));
  await writeFile(
    join(testHome, "dohc-workspaces.json"),
    JSON.stringify(
      {
        version: 1,
        workspaces: [{ workspaceId: "bad-workspace-entry" }],
      },
      null,
      2,
    ),
  );

  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();

  await expect(
    page.getByText("dohc couldn't read its workspace registry"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /create workspace/i })).toHaveCount(0);

  await app.close();
});

test("window state: bounds persist and restore across relaunch", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /create workspace/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  const bounds = { x: 24, y: 16, width: 1180, height: 760 };
  await app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(next);
  }, bounds);

  // Debounced save lands in stateDir (the hermetic test home).
  const stateFile = join(testHome, "dohc-window-state.json");
  await expect.poll(() => existsSync(stateFile), { timeout: 5000 }).toBe(true);
  await expect
    .poll(
      () =>
        JSON.parse(readFileSync(stateFile, "utf8")) as {
          bounds?: { width: number };
        },
      { timeout: 5000 },
    )
    .toMatchObject({ bounds, isMaximized: false });

  await app.close();

  // Relaunch with the same home: the window restores the saved geometry.
  const second = await launchApp({ DOHC_TEST_HOME: testHome });
  const page2 = await second.firstWindow();
  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
  const restored = await second.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getNormalBounds(),
  );
  expect(restored?.width).toBe(bounds.width);
  expect(restored?.height).toBe(bounds.height);
  // Position can shift by window-manager decoration under xvfb; stay honest
  // but tolerant.
  expect(Math.abs((restored?.x ?? 0) - bounds.x)).toBeLessThanOrEqual(10);
  expect(Math.abs((restored?.y ?? 0) - bounds.y)).toBeLessThanOrEqual(10);
  await second.close();
});

test("a saved position off every display resets to the centered default", async () => {
  const testHome = await mkdtemp(join(tmpdir(), "dohc-e2e-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(testHome, "dohc-window-state.json"),
    JSON.stringify({
      bounds: { x: 90000, y: 90000, width: 1180, height: 760 },
      isMaximized: false,
    }),
  );
  const app = await launchApp({ DOHC_TEST_HOME: testHome });
  const page = await app.firstWindow();
  await expect(page.getByRole("heading", { name: /dohc/i })).toBeVisible();
  const bounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getNormalBounds(),
  );
  // Default size, on-screen position (not the unreachable saved one).
  expect(bounds?.width).toBe(1280);
  expect(bounds?.height).toBe(800);
  expect(bounds?.x).toBeLessThan(10000);
  expect(bounds?.y).toBeLessThan(10000);
  await app.close();
});

test("the single-instance lock quits a second launch on the same profile", async () => {
  // launch.ts gives every harness launch a fresh user-data dir for isolation,
  // which stopped exercising the production lock — this test pins it
  // deliberately: same profile, second instance must exit; first stays alive.
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const electronBinary = createRequire(import.meta.url)("electron") as string;

  const testHome = await mkdtemp(join(tmpdir(), "dohc-lock-home-"));
  const profile = await mkdtemp(join(tmpdir(), "dohc-lock-profile-"));
  const app = await launchApp({
    DOHC_TEST_HOME: testHome,
    DOHC_TEST_USER_DATA: profile,
  });
  await app.firstWindow();

  const args = ["apps/desktop/dist/main/main.js", `--user-data-dir=${profile}`];
  if (process.env.DOHC_E2E_NO_CHROMIUM_SANDBOX === "1") args.push("--no-sandbox");
  const second = spawn(electronBinary, args, {
    cwd: process.cwd(),
    env: { ...process.env, DOHC_DESKTOP_TEST: "1", DOHC_TEST_HOME: testHome },
    stdio: "ignore",
  });
  const exitCode = await new Promise<number | null>((resolve) => {
    const timeout = setTimeout(() => {
      second.kill("SIGTERM");
      resolve(null);
    }, 15_000);
    second.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  // The lock refused the second instance (clean exit, no second window)…
  expect(exitCode).not.toBeNull();
  // …and the FIRST instance is still alive and serving its window.
  const windowCount = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().length,
  );
  expect(windowCount).toBe(1);
  await app.close();
});
