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
  writeWorkspaceFiles,
} from "./helpers/workspace";

// The plugin under test is dohc's own, straight out of the repo — not a
// fixture written for the test. What this spec proves is what a user gets.
const pluginSource = fileURLToPath(new URL("../plugins/sites/", import.meta.url));

const VIEW_BUTTON = "activity-plugin-view:sites/list";
const MARKER = "Sites plugin served this page";

/** The guest showing a preview, read from the main process. */
interface GuestReport {
  url: string;
  text: string;
}

// Installing a plugin runs a real dependency install and an esbuild bundle
// before the view can appear, so this spec needs longer than the default.
test.setTimeout(300_000);

test("the sites plugin lists a workspace's sites and serves one in its own tab", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "sites-plugin-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      {
        path: "marketing/index.html",
        contents: `<!doctype html><html><head><link rel="stylesheet" href="./assets/site.css"></head><body><h1>${MARKER}</h1></body></html>`,
      },
      { path: "marketing/assets/site.css", contents: "h1{color:rebeccapurple}" },
      // Inside the served directory, so refusing it can only come from the
      // reserved-path rule and never from the file being absent.
      { path: "marketing/.dohc/note.txt", contents: "reserved workspace bytes" },
      { path: "notes/today.md", contents: "Not a site.\n" },
    ]);
    await seedPluginSource(temp, { fixtureRoot: pluginSource, pluginId: "sites" });

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // Installing is the user's own action: dohc never runs plugin source this
    // device has not approved. Everything after this is the sites plugin's own
    // behavior.
    await page.getByTestId("activity-plugins").click();
    const pluginRow = page.locator('[data-testid="plugin-row"]', {
      has: page.getByText("Sites", { exact: true }),
    });
    await expect(pluginRow).toBeVisible({ timeout: 60_000 });
    await pluginRow.getByTestId("plugin-install").click();
    await expect(pluginRow.getByTestId("plugin-action-error")).toHaveCount(0, {
      timeout: 180_000,
    });

    // KNOWN DEFECT, not this plugin's: the activity bar does not pick up a
    // plugin installed in this session until the window reloads. The pipeline
    // does emit the final status carrying the approval, so something between
    // it and the rail's catalog drops it; the cause is not isolated. Filed
    // separately. The reload stands in for the refresh that should happen on
    // its own.
    await page.reload();
    await page.getByTestId("workspace-shell").waitFor();

    // The rail button only exists once the plugin was discovered, installed,
    // built, approved on this device, and activated — and only because its
    // manifest asks for a view rather than a tab.
    const viewButton = page.getByTestId(VIEW_BUTTON);
    await expect(viewButton).toBeVisible({ timeout: 120_000 });
    await viewButton.click();

    const panel = page.frameLocator('[data-testid="plugin-panel-frame"]');
    const row = panel.locator('[data-testid="sites-row"][data-root="marketing"]');
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(panel.getByTestId("sites-count")).toHaveText("1 site");
    // The panel read the workspace itself, through the plugin's own authority.
    await expect(panel.getByTestId("sites-error")).toBeHidden();

    await row.click();

    // One tab per site, keyed by what the plugin named the instance.
    // The instance key is encoded into the tab path like every other segment,
    // so "auto:marketing" is one segment and stays one tab.
    const tab = page.getByTestId("tab-dohc://plugin-web/sites/preview/auto%3Amarketing");
    await expect(tab).toBeVisible({ timeout: 60_000 });
    await expect(tab).toHaveAttribute("data-active", "true");
    await expect(tab).toContainText("Marketing (static)");

    // The tab's contents are a main-process guest, so the renderer cannot see
    // them. Read the guest itself: this is the proof that the plugin's own
    // server answered with the site's bytes on its own loopback origin.
    const readGuest = async (): Promise<GuestReport | null> =>
      desktop!.app.evaluate(async ({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) {
          const url = contents.getURL();
          if (!url.startsWith("http://127.0.0.1")) continue;
          const text = (await contents.executeJavaScript(
            "document.body ? document.body.innerText : ''",
          )) as string;
          return { url, text };
        }
        return null;
      });

    await expect
      .poll(async () => (await readGuest())?.text ?? "", { timeout: 60_000 })
      .toContain(MARKER);

    const guest = await readGuest();
    expect(guest?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // The same origin, asked directly: it serves the site's own assets, and
    // refuses to reach past the site into the rest of the workspace.
    const origin = new URL(guest?.url ?? "http://127.0.0.1");
    const asset = await fetch(new URL("assets/site.css", origin));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("rebeccapurple");

    const escape = await fetch(new URL("..%2fnotes/today.md", origin));
    expect(escape.status).toBe(400);
    expect(await escape.text()).not.toContain("Not a site.");

    const reserved = await fetch(new URL(".dohc/note.txt", origin));
    expect(reserved.status).toBe(403);
    expect(await reserved.text()).not.toContain("reserved workspace bytes");
  } catch (error) {
    // The plugin pipeline reports install and build failures to the main
    // process log, and nothing in the renderer shows them. Without this the
    // only symptom is a rail button that never arrives.
    for (const entry of desktop?.logs ?? []) {
      if (/plugin|sites/i.test(entry.text)) {
        console.log(`[${entry.source}:${entry.level}] ${entry.text}`);
      }
    }
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
