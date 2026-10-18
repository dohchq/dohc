import { expect, test } from "@playwright/test";
import { chmod, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A person chose "Don't Allow" for the folder that holds a workspace. macOS
// enforces that in the kernel's sandbox and fails every call on the folder
// with EPERM. sandbox-exec applies a sandbox profile from the same kernel
// sandbox to dohc and its engine, so these runs meet a real EPERM. It cannot
// say which calls a privacy refusal covers, so each run refuses one set:
// "all" refuses metadata too, so the root's realpath fails; "data" leaves
// metadata, so the root resolves and its listing fails.
const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as string;

for (const refusal of [
  { name: "all", operations: "file-read* file-write*" },
  { name: "data", operations: "file-read-data file-write*" },
]) {
  test(`a workspace folder macOS refuses stops with the way to allow it (${refusal.name})`, async () => {
    test.skip(process.platform !== "darwin", "sandbox-exec is macOS only");
    test.setTimeout(180_000);
    const temp = await createTempWorkspace();
    let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
    try {
      await writeWorkspaceFiles(temp, [{ path: "notes.md", contents: "# Notes\n" }]);
      desktop = await launchDesktopApp({ workspace: temp });
      const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
      await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "notes.md");
      await desktop.close();
      desktop = null;

      const root = await realpath(temp.rootPath);
      const sandboxed = join(temp.baseDir, "sandboxed-electron.sh");
      const profile = `(version 1)(allow default)(deny ${refusal.operations} (subpath "${root}"))`;
      await writeFile(sandboxed, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p '${profile}' '${electronExecutable}' "$@"\n`);
      await chmod(sandboxed, 0o755);
      // Chromium cannot start its own sandbox inside another one.
      desktop = await launchDesktopApp({ workspace: temp, executablePath: sandboxed, switches: ["--no-sandbox"] });
      const { app, page } = desktop;

      const stopped = page.getByTestId("workspace-open-failed");
      await expect(stopped).toContainText("Couldn’t open this workspace");
      await expect(stopped).toContainText(
        "macOS blocked dohc from this folder. Allow dohc in System Settings › Privacy & Security › Files & Folders.",
      );
      await expect(page.getByTestId("workspace-shell-error")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`privacy-denied-${refusal.name}.png`) });

      await app.evaluate(({ shell }) => {
        const opened: string[] = [];
        Reflect.set(globalThis, "openedExternally", opened);
        shell.openExternal = async (url: string) => { opened.push(url); };
      });
      await stopped.getByRole("button", { name: "Open System Settings" }).click();
      await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "openedExternally") as string[]))
        .toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"]);
      await expect(stopped.getByRole("button", { name: "Try again" })).toBeVisible();
    } finally {
      if (desktop) await cleanupDesktopWorkspace(desktop, temp);
      else await temp.cleanup();
    }
  });
}
