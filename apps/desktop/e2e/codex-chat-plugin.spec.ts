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

const pluginSource = fileURLToPath(new URL("../plugins/codex/", import.meta.url));
const fakeCodex = fileURLToPath(
  new URL("../plugins/codex/test/fakeCodexAppServer.mjs", import.meta.url),
);
const prompt = "Echo this Codex chat e2e marker.";
const echoedPrompt = '"text":"' + prompt + '"';

interface GuestReport {
  url: string;
  title: string;
  text: string;
}

test.setTimeout(300_000);

test("the Codex plugin serves its chat and sends a message to Codex", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, "codex-chat-plugin-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await seedPluginSource(temp, { fixtureRoot: pluginSource, pluginId: "codex" });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_AGENT_CODEX_COMMAND: process.execPath,
        DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify([fakeCodex, "no-turn"]),
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-plugins").click();
    const pluginRow = page.locator('[data-testid="plugin-row"]', {
      has: page.getByText("Codex", { exact: true }),
    });
    await expect(pluginRow).toBeVisible({ timeout: 60_000 });
    await pluginRow.getByTestId("plugin-install").click();
    await expect(pluginRow.getByTestId("plugin-action-error")).toHaveCount(0, {
      timeout: 180_000,
    });

    await pluginRow.click();
    const open = page.getByTestId("plugin-open-web-app");
    await expect(open).toHaveText("Open Codex Chat", { timeout: 120_000 });
    await open.click();

    const tab = page.getByTestId("tab-dohc://plugin-web/codex/chat");
    await expect(tab).toBeVisible({ timeout: 60_000 });
    await expect(tab).toHaveAttribute("data-active", "true");

    const readGuest = async (): Promise<GuestReport | null> =>
      desktop!.app.evaluate(async ({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) {
          const url = contents.getURL();
          if (!url.startsWith("http://127.0.0.1")) continue;
          const title = (await contents.executeJavaScript("document.title")) as string;
          if (title !== "Codex Chat") continue;
          const text = (await contents.executeJavaScript(
            "document.body ? document.body.innerText : ''",
          )) as string;
          return { url, title, text };
        }
        return null;
      });

    await expect
      .poll(async () => (await readGuest())?.title ?? "", { timeout: 60_000 })
      .toBe("Codex Chat");

    await desktop.app.evaluate(async ({ webContents }, message) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith("http://127.0.0.1")) continue;
        const title = (await contents.executeJavaScript("document.title")) as string;
        if (title !== "Codex Chat") continue;
        await contents.executeJavaScript(
          "document.querySelector('#message').value = " +
            JSON.stringify(message) +
            "; document.querySelector('#composer').requestSubmit();",
        );
        return;
      }
      throw new Error("The Codex chat guest did not open.");
    }, prompt);

    await expect
      .poll(async () => (await readGuest())?.text ?? "", { timeout: 60_000 })
      .toContain(echoedPrompt);
  } catch (error) {
    for (const entry of desktop?.logs ?? []) {
      if (/plugin|codex/i.test(entry.text)) {
        console.log("[" + entry.source + ":" + entry.level + "] " + entry.text);
      }
    }
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
