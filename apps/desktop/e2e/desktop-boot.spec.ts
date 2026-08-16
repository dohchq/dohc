import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace } from "./helpers/workspace";

// #783 — the app boots, and the bridge is there.
//
// Every other spec in this directory opens with a click on a screen that only
// renders once `window.dohcDesktop` exists. When the preload fails to load,
// none of them says so: they time out waiting for a locator, and the real
// cause — Electron refusing the preload over one unresolved require — is a
// line in the renderer's console that no assertion reads.
//
// So this spec asserts the boot itself, first and cheaply. If it fails, no
// other desktop spec's failure means anything, and the message says which
// question to ask.
test("the desktop app boots with its bridge", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });

    // The preload's own health, read from the window it is supposed to have
    // furnished. `contextBridge` exposes exactly this object, so its absence
    // IS "the preload did not run".
    const bridge = await desktop.page.evaluate(
      () => typeof (window as { dohcDesktop?: unknown }).dohcDesktop,
    );
    const preloadRefusals = desktop.logs
      .filter((entry) => /Unable to load preload|module not found/iu.test(entry.text))
      .map((entry) => entry.text.trim());
    expect(
      preloadRefusals,
      "Electron refused the preload — every package the preload imports for its " +
        "values must be in preloadBundledRuntimeDeps (#783)",
    ).toEqual([]);
    expect(bridge, "the preload must expose window.dohcDesktop").toBe("object");

    // And the first thing a new user sees actually renders, which is the
    // screen every other spec in this directory starts from.
    await expect(desktop.page.getByTestId("first-run-open-share")).toBeVisible();
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});
