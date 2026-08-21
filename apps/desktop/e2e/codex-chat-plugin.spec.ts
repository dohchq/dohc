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
  title: string;
  text: string;
}

interface GuestCredentials {
  origin: string;
  token: string;
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

    // Registered before the guest ever opens: the token now travels only in
    // the URL fragment the host navigates the guest to, and chat.js strips
    // it right back out (history.replaceState) as its first act -- by the
    // time anything below could poll for it, it would already be gone from
    // the guest's own current URL. did-navigate fires with the fragment
    // still attached (a later history.replaceState fires a *different*
    // event, did-navigate-in-page, which this ignores), so it is the only
    // reliable place left to observe it.
    await desktop.app.evaluate(({ app, webContents }) => {
      const target = globalThis as { __codexChatUrls?: string[] };
      target.__codexChatUrls = target.__codexChatUrls || [];
      const track = (contents: Electron.WebContents) => {
        contents.on("did-navigate", (_event, url) => {
          if (url.startsWith("http://127.0.0.1")) target.__codexChatUrls?.push(url);
        });
      };
      webContents.getAllWebContents().forEach(track);
      app.on("web-contents-created", (_event, contents) => track(contents));
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
          if (!contents.getURL().startsWith("http://127.0.0.1")) continue;
          const title = (await contents.executeJavaScript("document.title")) as string;
          if (title !== "Codex Chat") continue;
          const text = (await contents.executeJavaScript(
            "document.body ? document.body.innerText : ''",
          )) as string;
          return { title, text };
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

    // Round-7 fix 1's proof: a reload re-requests the guest's own URL,
    // which chat.js already stripped its token fragment from on first
    // load -- without sessionStorage recovery this bricks instead of
    // reattaching. Click the reloaded page's own Stop button (rather than
    // sending another message -- the "no-turn" fake driver never completes
    // a turn, so a second message would 409 regardless of the token) to
    // prove its own JS recovered a real, working token, not just that the
    // page loaded: the click fires an authenticated fetch straight from
    // the reloaded script.
    await desktop.app.evaluate(async ({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith("http://127.0.0.1")) continue;
        const title = (await contents.executeJavaScript("document.title")) as string;
        if (title !== "Codex Chat") continue;
        contents.reload();
        return;
      }
      throw new Error("The Codex chat guest did not open.");
    });

    await expect
      .poll(async () => (await readGuest())?.title ?? "", { timeout: 60_000 })
      .toBe("Codex Chat");

    await desktop.app.evaluate(async ({ webContents }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith("http://127.0.0.1")) continue;
        const title = (await contents.executeJavaScript("document.title")) as string;
        if (title !== "Codex Chat") continue;
        await contents.executeJavaScript("document.querySelector('#stop').click();");
        return;
      }
      throw new Error("The Codex chat guest did not open.");
    });

    await expect
      .poll(async () => (await readGuest())?.text ?? "", { timeout: 60_000 })
      .toContain("Stopped");

    // Fix 1's proof against the real server, not the fake driver: a direct,
    // unauthenticated cross-origin-shaped POST (what a hostile local page
    // sends -- Node's fetch has no CORS of its own to stop it either) must
    // not reach the session, and the real, page-issued token must. The
    // token itself comes from the captured did-navigate URL above -- the
    // guest's own current URL no longer carries it by this point.
    const credentials = await desktop.app.evaluate(() => {
      const urls = (globalThis as { __codexChatUrls?: string[] }).__codexChatUrls ?? [];
      const withToken = urls.find((candidate) => candidate.includes("#token="));
      if (!withToken) return null;
      const url = new URL(withToken);
      const token = new URLSearchParams(url.hash.slice(1)).get("token");
      if (!token) return null;
      return { origin: url.origin, token };
    });
    if (!credentials) throw new Error("The Codex chat guest did not open.");

    const unauthorized = await fetch(credentials.origin + "/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(credentials.origin + "/stop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + credentials.token,
      },
    });
    expect(authorized.status).toBe(204);

    // The page itself never carries the token: a local process that only
    // fetches "/" (or a rebound page reading its own same-origin response)
    // must learn nothing. (The Host-header anti-rebinding check itself is
    // proven in the unit suite -- fetch() forbids overriding Host, so it
    // cannot be exercised from here.)
    const rootResponse = await fetch(credentials.origin + "/");
    const html = await rootResponse.text();
    expect(html).not.toContain(credentials.token);
    expect(html).not.toContain("chat-token");
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
