import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

// Physical keys go through Electron's accelerator handling, unlike jsdom's
// key events. Windows does not register these menu keys, so this observes
// shell actions and absent native messages, not prevention of native execution.
// Run on macOS to check its native unhandled fallback; that runtime is unverified.
test("shell shortcut ownership runs actions without native menu messages", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await page.evaluate(() => {
      const commands: string[] = [];
      Reflect.set(window, "shortcutNativeCommands", commands);
      const bridge = window.dohcDesktop;
      if (!bridge) throw new Error("Desktop bridge is unavailable.");
      bridge.onMenuCommand((command) => commands.push(command));
    });
    const assertNoNativeCommand = async () => {
      // An IPC round trip lets main finish processing the physical key before
      // checking the native-command observer. No timer guesses about delivery.
      const commands = await page.evaluate(async () => {
        const bridge = window.dohcDesktop;
        if (!bridge) throw new Error("Desktop bridge is unavailable.");
        await bridge.getUserSettings();
        return Reflect.get(window, "shortcutNativeCommands");
      });
      expect(commands).toEqual([]);
    };
    const focusShell = () => page.getByTestId("titlebar-quick-open").focus();
    await expect(page.getByTestId("side-panel")).toBeVisible();
    await focusShell();
    await page.keyboard.press(mod + "+b");
    await expect(page.getByTestId("side-panel")).toHaveCount(0);
    await assertNoNativeCommand();
    await page.keyboard.press(mod + "+b");
    await expect(page.getByTestId("side-panel")).toBeVisible();
    await assertNoNativeCommand();

    for (const [chord, surface] of [
      [mod + "+k", "command-palette"],
      [mod + "+Shift+p", "command-palette"],
      [mod + "+p", "quick-open"],
    ] as const) {
      await focusShell();
      await page.keyboard.press(chord);
      await expect(page.getByTestId(surface)).toBeVisible();
      await assertNoNativeCommand();
      await page.keyboard.press(chord!);
      await expect(page.getByTestId(surface!)).toHaveCount(0);
      await assertNoNativeCommand();
    }

    await focusShell();
    await page.keyboard.press(mod + "+n");
    await expect(page.getByRole("textbox", { name: "File name" })).toBeVisible();
    await assertNoNativeCommand();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "File name" })).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
