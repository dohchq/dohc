import { expect, test } from "@playwright/test";
import { cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
} from "./helpers/workspace";

// The t3-code end-to-end proof: install the real plugin through the real
// pipeline (real registry fetch of the pinned t3@0.0.33), spawn the real
// server through the real broker as a utilityProcess, reach readiness, pair
// the hardened guest view, then tear everything down through uninstall.
//
// It needs the network and about 600 MB of scratch, so it runs only when
// DOHC_REQUIRE_T3_E2E=1 — and then a missing precondition is a failure,
// never a skip (the repo's anti-skip pattern).
const REQUIRE_T3_E2E = process.env.DOHC_REQUIRE_T3_E2E === "1";

const pluginSourceRoot = fileURLToPath(
  new URL("../plugins/t3-code/", import.meta.url),
);
const pluginRoot = "plugins/t3-code";
const T3_CHILD_SERVICE_NAME = "dohc.plugin.t3-code.child";

interface PluginBridge {
  installPlugin(payload: { workspaceId: string; pluginId: string }): Promise<{
    ok: boolean;
    error?: { message: string } | null;
    plugin?: { warnings: string[] } | null;
  }>;
  openPluginWebApp(payload: {
    workspaceId: string;
    pluginRoot: string;
    pluginId: string;
    webAppId: string;
  }): Promise<{ pluginId: string; webAppId: string }>;
  pluginUninstallPreflight(payload: {
    workspaceId: string;
    pluginId: string;
  }): Promise<{
    ok: boolean;
    confirmationToken?: string;
    preflight?: {
      stateData: { path: string; fileCount: number; totalBytes: number } | null;
      warning: { details: string[]; summary: string } | null;
    };
  }>;
  uninstallPlugin(payload: {
    workspaceId: string;
    pluginId: string;
    confirmationToken: string;
  }): Promise<{ ok: boolean; error?: { message: string } | null }>;
}

test("t3-code installs, serves its paired web app in a hardened guest, and uninstalls cleanly", async () => {
  test.skip(!REQUIRE_T3_E2E, "Set DOHC_REQUIRE_T3_E2E=1 to run the real t3 proof.");
  test.setTimeout(420_000);

  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "t3-plugin-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await cp(pluginSourceRoot, join(temp.rootPath, pluginRoot), {
      recursive: true,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // 1. The real pipeline: snapshot, registry install of the committed
    // lockfile, lifecycle scan against allowSkippedScripts, esbuild bundle.
    const installed = await page.evaluate(
      ({ workspaceId }) =>
        (window as unknown as { dohcDesktop: PluginBridge }).dohcDesktop
          .installPlugin({ workspaceId, pluginId: "t3-code" }),
      { workspaceId: workspace.workspaceId },
    );
    expect(
      installed.ok,
      `install failed: ${installed.error?.message ?? "unknown"}`,
    ).toBe(true);

    // 2. Open the web app: activates the plugin, spawns the pinned t3 server
    // through the broker, polls readiness, and navigates the guest to the
    // pairing URL — none of which ever reaches this renderer page.
    await page.evaluate(
      ({ workspaceId, root }) =>
        (window as unknown as { dohcDesktop: PluginBridge }).dohcDesktop
          .openPluginWebApp({
            workspaceId,
            pluginRoot: root,
            pluginId: "t3-code",
            webAppId: "app",
          }),
      { workspaceId: workspace.workspaceId, root: pluginRoot },
    );

    const tab = page.getByTestId("tab-dohc://plugin-web/t3-code/app");
    await expect(tab).toBeVisible();
    await expect(page.getByTestId("plugin-web-app-frame")).toBeVisible({
      timeout: 180_000,
    });

    // 3. The server runs as a broker-owned utilityProcess.
    await expect
      .poll(() =>
        desktop!.app.evaluate(
          ({ app }, serviceName) =>
            app.getAppMetrics().some((metric) => metric.name === serviceName),
          T3_CHILD_SERVICE_NAME,
        ),
      )
      .toBe(true);

    // 4. Exactly one guest WebContents on a loopback origin, and the SPA
    // strips the pairing credential from its own URL once it exchanges it.
    const loopbackUrls = () =>
      desktop!.app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .map((contents) => contents.getURL())
          .filter((url) => url.startsWith("http://127.0.0.1:")),
      );
    await expect.poll(async () => (await loopbackUrls()).length).toBe(1);
    const origin = new URL((await loopbackUrls()).at(0) ?? "").origin;
    await expect
      .poll(async () => (await loopbackUrls()).every((url) => !url.includes("#token=")))
      .toBe(true);

    // 5. The real t3 answers readiness from the test process too, and the
    // guest actually rendered its UI.
    const environment = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(environment.status).toBe(200);
    const descriptor = (await environment.json()) as { serverVersion: string };
    expect(descriptor.serverVersion).toBe("0.0.33");

    await expect
      .poll(() =>
        desktop!.app.evaluate(async ({ webContents }) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith("http://127.0.0.1:"));
          if (!guest) return null;
          return guest.executeJavaScript("document.title") as Promise<string>;
        }),
      )
      .toContain("T3 Code");

    // 6. Closing the tab destroys the guest view; the pairing credential
    // never surfaced in any app log either.
    // The tab carries the manifest's title, which the app's own start
    // reported — the close control is named from it.
    await expect(tab).toContainText("T3 Code");
    await tab.getByRole("button", { name: "Close T3 Code" }).click();
    await expect.poll(async () => (await loopbackUrls()).length).toBe(0);
    // Both forms the access block prints the credential in: the pairing URL's
    // fragment and the bare `Token:` line. A chunk boundary can split either.
    const credentialInLog = /#token=(?!\[redacted\])|Token:\s*(?!\[redacted\])\S/;
    const leakedLog = desktop.logs.find((entry) => credentialInLog.test(entry.text));
    expect(
      leakedLog ? leakedLog.text.slice(0, 40) : undefined,
      "a log line carried the pairing credential",
    ).toBeUndefined();

    // 7. Uninstall: the preflight names the server's stored state as
    // permanently deleted, and the delete plus the broker's tree teardown
    // actually happen.
    const preflight = await page.evaluate(
      ({ workspaceId }) =>
        (window as unknown as { dohcDesktop: PluginBridge }).dohcDesktop
          .pluginUninstallPreflight({ workspaceId, pluginId: "t3-code" }),
      { workspaceId: workspace.workspaceId },
    );
    expect(preflight.ok).toBe(true);
    const stateData = preflight.preflight?.stateData;
    expect(stateData, "t3 wrote no state under the plugin state root").not.toBeNull();
    expect(stateData!.fileCount).toBeGreaterThan(0);
    expect(existsSync(stateData!.path)).toBe(true);
    expect(
      preflight.preflight?.warning?.details.join("\n") ?? "",
    ).toContain("stored data");

    const uninstalled = await page.evaluate(
      ({ workspaceId, confirmationToken }) =>
        (window as unknown as { dohcDesktop: PluginBridge }).dohcDesktop
          .uninstallPlugin({
            workspaceId,
            pluginId: "t3-code",
            confirmationToken,
          }),
      {
        workspaceId: workspace.workspaceId,
        confirmationToken: preflight.confirmationToken!,
      },
    );
    expect(
      uninstalled.ok,
      `uninstall failed: ${uninstalled.error?.message ?? "unknown"}`,
    ).toBe(true);

    await expect
      .poll(() =>
        desktop!.app.evaluate(
          ({ app }, serviceName) =>
            app.getAppMetrics().some((metric) => metric.name === serviceName),
          T3_CHILD_SERVICE_NAME,
        ),
      )
      .toBe(false);
    await expect.poll(() => existsSync(stateData!.path)).toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
