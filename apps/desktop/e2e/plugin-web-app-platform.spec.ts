import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedPluginSource,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
} from "./helpers/workspace";

const fixtureRoot = fileURLToPath(
  new URL("./fixtures/hello-plugin/", import.meta.url),
);
const VIEW_BUTTON =
  "activity-plugin-view:hello-plugin/hello-view";
const MARKER = "Hello plugin served this preview";

interface GuestReport {
  url: string;
  text: string;
}

test.setTimeout(300_000);

test("an installed plugin opens a contained instanced web app from its rail view", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "plugin-web-app-platform-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await seedPluginSource(temp, {
      fixtureRoot,
      pluginId: "hello-plugin",
    });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_PLUGIN_FIXTURE_MODE: "instanced-static-web-app" },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-plugins").click();
    const pluginRow = page.locator('[data-testid="plugin-row"]', {
      has: page.getByText("Hello Plugin", { exact: true }),
    });
    await expect(pluginRow).toBeVisible({ timeout: 60_000 });
    await pluginRow.getByTestId("plugin-install").click();
    await expect(pluginRow.getByTestId("plugin-action-error")).toHaveCount(0, {
      timeout: 180_000,
    });

    const viewButton = page.getByTestId(VIEW_BUTTON);
    await expect(viewButton).toBeVisible({ timeout: 120_000 });
    await viewButton.click();

    const view = page.frameLocator('[data-testid="plugin-panel-frame"]');
    const openPreview = view.getByTestId("hello-view-open-preview");
    await expect(openPreview).toBeVisible({ timeout: 60_000 });
    await openPreview.click();

    const tab = page.getByTestId(
      "tab-dohc://plugin-web/hello-plugin/preview/demo",
    );
    await expect(tab).toBeVisible({ timeout: 60_000 });
    await expect(tab).toHaveAttribute("data-active", "true");
    await expect(tab).toContainText("Preview demo");

    const readGuests = async (): Promise<GuestReport[]> =>
      desktop!.app.evaluate(async ({ webContents }) => {
        const guests: GuestReport[] = [];
        for (const contents of webContents.getAllWebContents()) {
          const url = contents.getURL();
          if (!url.startsWith("http://127.0.0.1")) continue;
          const text = (await contents.executeJavaScript(
            "document.body ? document.body.innerText : ''",
          )) as string;
          guests.push({ url, text });
        }
        return guests;
      });

    await expect
      .poll(async () => JSON.stringify(await readGuests()), { timeout: 60_000 })
      .toContain(MARKER);

    const guest =
      (await readGuests()).find(({ text }) => text.includes(MARKER)) ?? null;
    expect(guest?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const origin = new URL(guest?.url ?? "http://127.0.0.1");
    const asset = await fetch(new URL("assets/style.css", origin));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("h1{color:mediumseagreen}\n");
  } catch (error) {
    for (const entry of desktop?.logs ?? []) {
      if (/plugin|preview/i.test(entry.text)) {
        console.log(`[${entry.source}:${entry.level}] ${entry.text}`);
      }
    }
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
