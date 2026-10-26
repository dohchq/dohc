import { expect, test } from "@playwright/test";
import { editorTabTestId } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles,
} from "./helpers/workspace";

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
    await expect(page.getByLabel("Page title")).toBeFocused();
    await assertNoNativeCommand();
    await page.keyboard.press(mod + "+w");
    await expect(page.getByTestId("new-page")).toHaveCount(0);

    if (process.platform === "darwin") {
      // macOS keeps Control chords for text editing, so none runs a shell command.
      await focusShell();
      for (const chord of ["Control+b", "Control+k", "Control+p", "Control+n", "Control+w", "Control+,"]) {
        await page.keyboard.press(chord);
        await assertNoNativeCommand();
      }
      await expect(page.getByTestId("side-panel")).toBeVisible();
      await expect(page.getByTestId("command-palette")).toHaveCount(0);
      await expect(page.getByTestId("quick-open")).toHaveCount(0);
      await expect(page.getByTestId("new-page")).toHaveCount(0);
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// macOS keeps ⌘H for Hide, so a document's Replace takes ⌥⌘F there.
test("opens a document's Replace with the platform's chord", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "notes.md", contents: "# Notes\n\nThe cat sat.\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");
    await explorerRow(page, "notes.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+f" : "Control+h");
    await expect(page.getByPlaceholder("Replace", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("search", { name: "find and replace" })).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// ⌃Tab works from the document and wraps. macOS adds ⇧⌘], Windows and Linux
// Ctrl+PageDown. The renderer claims each chord, so no menu item runs it a second time.
test("switches editor tabs with the platform's chords", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const files = ["one.md", "two.md", "three.md"];
    await writeWorkspaceFiles(temp, files.map((path) => ({ path, contents: `# ${path}\n\nBody.\n` })));
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    for (const path of files) {
      await waitForWorkspaceFile(page, workspace.workspaceId, path);
      await explorerRow(page, path).click();
      await expect(page.getByTestId(editorTabTestId(path))).toHaveAttribute("aria-selected", "true");
    }
    await page.evaluate(() => {
      const commands: string[] = [];
      Reflect.set(window, "shortcutNativeCommands", commands);
      window.dohcDesktop!.onMenuCommand((command) => commands.push(command));
    });
    const expectActive = async (path: string) => {
      await expect(page.getByTestId(editorTabTestId(path))).toHaveAttribute("aria-selected", "true");
      const commands = await page.evaluate(async () => {
        await window.dohcDesktop!.getUserSettings();
        return Reflect.get(window, "shortcutNativeCommands");
      });
      expect(commands).toEqual([]);
    };

    // From inside the document, where Tab indents a list item.
    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press("Control+Tab");
    await expectActive("one.md");
    await page.keyboard.press("Control+Shift+Tab");
    await expectActive("three.md");
    await page.keyboard.press("Control+Shift+Tab");
    await expectActive("two.md");
    const mac = process.platform === "darwin";
    await page.keyboard.press(mac ? "Meta+Shift+BracketRight" : "Control+PageDown");
    await expectActive("three.md");
    await page.keyboard.press(mac ? "Meta+Shift+BracketLeft" : "Control+PageUp");
    await expectActive("two.md");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Find again: ⌘G and ⇧⌘G on macOS, F3 and Shift+F3 elsewhere. They work from
// the find field and, while the bar has a query, from the document.
test("finds the next and previous match with the platform's chords", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "notes.md", contents: "# Notes\n\nOne cat, two cat, three cat.\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");
    await explorerRow(page, "notes.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    const mac = process.platform === "darwin";
    await page.keyboard.press(mac ? "Meta+f" : "Control+f");
    await page.getByPlaceholder("Find", { exact: true }).fill("cat");
    const count = page.locator(".dohc-find-replace__count");
    await expect(count).toHaveText("1/3");
    const next = mac ? "Meta+g" : "F3";
    const previous = mac ? "Meta+Shift+g" : "Shift+F3";
    await page.keyboard.press(next);
    await expect(count).toHaveText("2/3");
    await editor.getByRole("heading", { name: "Notes" }).click();
    await expect(page.getByPlaceholder("Find", { exact: true })).not.toBeFocused();
    await page.keyboard.press(next);
    await expect(count).toHaveText("3/3");
    await page.keyboard.press(next);
    await expect(count).toHaveText("1/3");
    await page.keyboard.press(previous);
    await expect(count).toHaveText("3/3");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
