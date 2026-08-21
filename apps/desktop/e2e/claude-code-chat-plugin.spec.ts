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

const pluginSource = fileURLToPath(new URL("../plugins/claude-code/", import.meta.url));
const fakeClaude = fileURLToPath(
  new URL("../plugins/claude-code/test/fakeClaudeCli.mjs", import.meta.url),
);
const prompt = "Write the fake Claude note.";
const CHAT_TITLE = "Claude Code Chat";

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

/**
 * Finds the chat guest's WebContentsView by its title and runs `script`
 * against it via executeJavaScript, returning the script's completion value
 * -- or null when no guest with that title has opened yet. The one loop
 * every guest interaction below needs (find the 127.0.0.1 WebContentsView
 * with the right title) lives here once.
 */
async function evalInChatGuest<T>(desktop: Desktop, script: string): Promise<T | null> {
  return desktop.app.evaluate(
    async ({ webContents }, { title, script }) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith("http://127.0.0.1")) continue;
        const pageTitle = (await contents.executeJavaScript("document.title")) as string;
        if (pageTitle !== title) continue;
        return (await contents.executeJavaScript(script)) as T;
      }
      return null;
    },
    { title: CHAT_TITLE, script },
  );
}

/** Runs an action script in the chat guest; the script must end `true;`. */
async function runInChatGuest(desktop: Desktop, script: string): Promise<void> {
  const ran = await evalInChatGuest<true>(desktop, script);
  if (ran !== true) throw new Error("The Claude Code chat guest did not open.");
}

async function readGuestText(desktop: Desktop): Promise<string> {
  return (await evalInChatGuest<string>(desktop, "(document.body ? document.body.innerText : '')")) ?? "";
}

/** Reloads the chat guest's own WebContentsView (not the desktop's page). */
async function reloadChatGuest(desktop: Desktop): Promise<void> {
  const reloaded = await desktop.app.evaluate(
    async ({ webContents }, title) => {
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.getURL().startsWith("http://127.0.0.1")) continue;
        const pageTitle = (await contents.executeJavaScript("document.title")) as string;
        if (pageTitle !== title) continue;
        contents.reload();
        return true;
      }
      return false;
    },
    CHAT_TITLE,
  );
  if (!reloaded) throw new Error("The Claude Code chat guest did not open.");
}

test.setTimeout(300_000);

test("the Claude Code plugin serves its chat and answers a tool permission", async () => {
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;

  try {
    await seedWorkspaceManifest(temp, "claude-code-chat-plugin-e2e");
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await seedPluginSource(temp, { fixtureRoot: pluginSource, pluginId: "claude-code" });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_AGENT_CLAUDE_CODE_COMMAND: process.execPath,
        DOHC_AGENT_CLAUDE_CODE_ARGS_JSON: JSON.stringify([fakeClaude, "ok"]),
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-plugins").click();
    const pluginRow = page.locator('[data-testid="plugin-row"]', {
      has: page.getByText("Claude Code", { exact: true }),
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
      const target = globalThis as { __claudeChatUrls?: string[] };
      target.__claudeChatUrls = target.__claudeChatUrls || [];
      const track = (contents: Electron.WebContents) => {
        contents.on("did-navigate", (_event, url) => {
          if (url.startsWith("http://127.0.0.1")) target.__claudeChatUrls?.push(url);
        });
      };
      webContents.getAllWebContents().forEach(track);
      app.on("web-contents-created", (_event, contents) => track(contents));
    });

    await pluginRow.click();
    const open = page.getByTestId("plugin-open-web-app");
    await expect(open).toHaveText("Open Claude Code Chat", { timeout: 120_000 });
    await open.click();

    const tab = page.getByTestId("tab-dohc://plugin-web/claude-code/chat");
    await expect(tab).toBeVisible({ timeout: 60_000 });
    await expect(tab).toHaveAttribute("data-active", "true");

    await expect
      .poll(async () => (await evalInChatGuest<string>(desktop!, "(document.title)")) ?? "", {
        timeout: 60_000,
      })
      .toBe(CHAT_TITLE);

    await runInChatGuest(
      desktop,
      "document.querySelector('#message').value = " +
        JSON.stringify(prompt) +
        "; document.querySelector('#composer').requestSubmit(); true;",
    );

    await expect
      .poll(async () => readGuestText(desktop!), { timeout: 60_000 })
      .toContain("Writing the note now.");

    await runInChatGuest(
      desktop,
      "const button = [...document.querySelectorAll('button')].find(" +
        "(element) => element.textContent === 'Allow once');" +
        "if (!button) throw new Error('The permission button did not appear.');" +
        "button.click(); true;",
    );

    await expect
      .poll(async () => readGuestText(desktop!), { timeout: 60_000 })
      .toContain('"behavior":"allow"');

    // Round-7 fix 1's proof: a reload re-requests the guest's own URL,
    // which chat.js already stripped its token fragment from on first
    // load -- without sessionStorage recovery this bricks instead of
    // reattaching. Click the reloaded page's own Stop button to prove its
    // own JS recovered a real, working token, not just that the page
    // loaded: the click fires an authenticated fetch straight from the
    // reloaded script.
    await reloadChatGuest(desktop);

    await expect
      .poll(async () => (await evalInChatGuest<string>(desktop!, "(document.title)")) ?? "", {
        timeout: 60_000,
      })
      .toBe(CHAT_TITLE);

    await runInChatGuest(desktop, "document.querySelector('#stop').click(); true;");

    // Round-8 fix 1's semantics: Stop now cancels the turn instead of
    // ending the session, so it no longer renders a "Stopped" card. The
    // visible proof is Stop re-enabling itself once its own fetch resolves
    // (chat.js's fix for the case where nothing was left to interrupt) and
    // no failure notice appearing.
    await expect
      .poll(
        async () =>
          evalInChatGuest<boolean>(desktop!, "(document.querySelector('#stop').disabled)"),
        { timeout: 60_000 },
      )
      .toBe(false);
    expect(await readGuestText(desktop)).not.toContain("dohc could not stop this session.");

    // Fix 1's proof against the real server, not the fake driver: a direct,
    // unauthenticated cross-origin-shaped POST (what a hostile local page
    // sends -- Node's fetch has no CORS of its own to stop it either) must
    // not reach the session, and the real, page-issued token must. The
    // token itself comes from the captured did-navigate URL above -- the
    // guest's own current URL no longer carries it by this point.
    const credentials = await desktop.app.evaluate(() => {
      const urls = (globalThis as { __claudeChatUrls?: string[] }).__claudeChatUrls ?? [];
      const withToken = urls.find((candidate) => candidate.includes("#token="));
      if (!withToken) return null;
      const url = new URL(withToken);
      const token = new URLSearchParams(url.hash.slice(1)).get("token");
      if (!token) return null;
      return { origin: url.origin, token };
    });
    if (!credentials) throw new Error("The Claude Code chat guest did not open.");

    const unauthorized = await fetch(credentials.origin + "/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(credentials.origin + "/stop", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + credentials.token },
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
      if (/plugin|claude/i.test(entry.text)) {
        console.log("[" + entry.source + ":" + entry.level + "] " + entry.text);
      }
    }
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
