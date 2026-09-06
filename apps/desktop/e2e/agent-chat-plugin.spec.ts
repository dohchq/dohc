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

const pluginSource = fileURLToPath(new URL("../plugins/agent-chat/", import.meta.url));
const fakeClaude = fileURLToPath(
  new URL("../plugins/agent-chat/test/fakeClaudeCli.mjs", import.meta.url),
);
const fakeCodex = fileURLToPath(
  new URL("../plugins/agent-chat/test/fakeCodexAppServer.mjs", import.meta.url),
);

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

/**
 * Finds the chat guest's WebContentsView by its title and runs `script`
 * against it via executeJavaScript, returning the script's completion value
 * -- or null when no guest with that title has opened yet. The one loop
 * every guest interaction below needs (find the 127.0.0.1 WebContentsView
 * with the right title) lives here once.
 */
async function evalInChatGuest<T>(desktop: Desktop, title: string, script: string): Promise<T | null> {
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
    { title, script },
  );
}

/** Runs an action script in the chat guest; the script must end `true;`. */
async function runInChatGuest(desktop: Desktop, title: string, script: string): Promise<void> {
  const ran = await evalInChatGuest<true>(desktop, title, script);
  if (ran !== true) throw new Error("The " + title + " guest did not open.");
}

async function readGuestText(desktop: Desktop, title: string): Promise<string> {
  return (
    (await evalInChatGuest<string>(
      desktop,
      title,
      "(document.body ? document.body.innerText : '')",
    )) ?? ""
  );
}

/** Reloads the chat guest's own WebContentsView (not the desktop's page). */
async function reloadChatGuest(desktop: Desktop, title: string): Promise<void> {
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
    title,
  );
  if (!reloaded) throw new Error("The " + title + " guest did not open.");
}

async function guestTitle(desktop: Desktop, title: string): Promise<string> {
  return (await evalInChatGuest<string>(desktop, title, "(document.title)")) ?? "";
}

async function submitMessage(desktop: Desktop, title: string, prompt: string): Promise<void> {
  await runInChatGuest(
    desktop,
    title,
    "document.querySelector('#message').value = " +
      JSON.stringify(prompt) +
      "; document.querySelector('#composer').requestSubmit(); true;",
  );
}

/**
 * Seeds the plugin, installs it from the Plugins view, opens the named chat
 * in a tab, and returns once the guest page has that title. Registers a
 * did-navigate tracker first: the token travels only in the URL fragment
 * the host navigates the guest to, and chat.js strips it right back out
 * (history.replaceState) as its first act -- by the time anything below
 * could poll for it, it would already be gone from the guest's own current
 * URL. did-navigate fires with the fragment still attached (a later
 * history.replaceState fires a *different* event, did-navigate-in-page,
 * which this ignores), so it is the only reliable place left to observe it.
 */
async function openChat(
  temp: Awaited<ReturnType<typeof createTempWorkspace>>,
  env: Record<string, string>,
  webAppId: string,
  title: string,
): Promise<Desktop> {
  await seedWorkspaceManifest(temp, "agent-chat-plugin-e2e");
  await seedWorkspaceSettings(temp, {
    experimental: { workspaceEngineAlpha: true },
  });
  await seedPluginSource(temp, { fixtureRoot: pluginSource, pluginId: "agent-chat" });

  const desktop = await launchDesktopApp({ workspace: temp, env });
  const page = desktop.page;
  await openWorkspaceFromFirstRun(page, temp);

  await page.getByTestId("activity-plugins").click();
  const pluginRow = page.locator('[data-testid="plugin-row"]', {
    has: page.getByText("Agent chat", { exact: true }),
  });
  await expect(pluginRow).toBeVisible({ timeout: 60_000 });
  await pluginRow.getByTestId("plugin-install").click();
  await expect(pluginRow.getByTestId("plugin-action-error")).toHaveCount(0, {
    timeout: 180_000,
  });

  await desktop.app.evaluate(({ app, webContents }) => {
    const target = globalThis as { __chatUrls?: string[] };
    target.__chatUrls = target.__chatUrls || [];
    const track = (contents: Electron.WebContents) => {
      contents.on("did-navigate", (_event, url) => {
        if (url.startsWith("http://127.0.0.1")) target.__chatUrls?.push(url);
      });
    };
    webContents.getAllWebContents().forEach(track);
    app.on("web-contents-created", (_event, contents) => track(contents));
  });

  await pluginRow.click();
  const open = page.getByTestId("plugin-open-web-app").and(
    page.locator(`[data-web-app-id="${webAppId}"]`),
  );
  await expect(open).toHaveText("Open " + title, { timeout: 120_000 });
  await open.click();

  const tab = page.getByTestId("tab-dohc://plugin-web/agent-chat/" + webAppId);
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await expect(tab).toHaveAttribute("data-active", "true");

  await expect
    .poll(async () => guestTitle(desktop, title), { timeout: 60_000 })
    .toBe(title);
  return desktop;
}

/**
 * Round-7 fix 1's proof: a reload re-requests the guest's own URL, which
 * chat.js already stripped its token fragment from on first load -- without
 * sessionStorage recovery this bricks instead of reattaching. Click the
 * reloaded page's own Stop button to prove its own JS recovered a real,
 * working token, not just that the page loaded: the click fires an
 * authenticated fetch straight from the reloaded script.
 *
 * Round-8 fix 1's semantics: Stop cancels the turn instead of ending the
 * session, so it no longer renders a "Stopped" card. The visible proof is
 * Stop re-enabling itself once its own fetch resolves (chat.js's fix for the
 * case where nothing was left to interrupt) and no failure notice appearing.
 */
async function reloadAndStop(desktop: Desktop, title: string): Promise<void> {
  await reloadChatGuest(desktop, title);
  await expect
    .poll(async () => guestTitle(desktop, title), { timeout: 60_000 })
    .toBe(title);

  await runInChatGuest(desktop, title, "document.querySelector('#stop').click(); true;");

  await expect
    .poll(
      async () =>
        evalInChatGuest<boolean>(desktop, title, "(document.querySelector('#stop').disabled)"),
      { timeout: 60_000 },
    )
    .toBe(false);
  expect(await readGuestText(desktop, title)).not.toContain("dohc could not stop this session.");
}

/**
 * Fix 1's proof against the real server, not the fake driver: a direct,
 * unauthenticated cross-origin-shaped POST (what a hostile local page sends
 * -- Node's fetch has no CORS of its own to stop it either) must not reach
 * the session, and the real, page-issued token must. The token itself comes
 * from the captured did-navigate URL above -- the guest's own current URL
 * no longer carries it by this point.
 */
async function proveTokenGate(desktop: Desktop, title: string): Promise<void> {
  const credentials = await desktop.app.evaluate(() => {
    const urls = (globalThis as { __chatUrls?: string[] }).__chatUrls ?? [];
    const withToken = urls.find((candidate) => candidate.includes("#token="));
    if (!withToken) return null;
    const url = new URL(withToken);
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    if (!token) return null;
    return { origin: url.origin, token };
  });
  if (!credentials) throw new Error("The " + title + " guest did not open.");

  const unauthorized = await fetch(credentials.origin + "/stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  expect(unauthorized.status).toBe(401);

  const authorized = await fetch(credentials.origin + "/stop", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + credentials.token },
  });
  expect(authorized.status).toBe(200);

  // The page itself never carries the token: a local process that only
  // fetches "/" (or a rebound page reading its own same-origin response)
  // must learn nothing. (The Host-header anti-rebinding check itself is
  // proven in the unit suite -- fetch() forbids overriding Host, so it
  // cannot be exercised from here.)
  const rootResponse = await fetch(credentials.origin + "/");
  const html = await rootResponse.text();
  expect(html).not.toContain(credentials.token);
  expect(html).not.toContain("chat-token");
}

function logPluginLines(desktop: Desktop | null, pattern: RegExp): void {
  for (const entry of desktop?.logs ?? []) {
    if (pattern.test(entry.text)) {
      console.log("[" + entry.source + ":" + entry.level + "] " + entry.text);
    }
  }
}

test.setTimeout(300_000);

test("the agent-chat plugin serves the Claude Code chat and answers a tool permission", async () => {
  const temp = await createTempWorkspace();
  const title = "Claude Code Chat";
  let desktop: Desktop | null = null;

  try {
    desktop = await openChat(
      temp,
      {
        DOHC_AGENT_CLAUDE_CODE_COMMAND: process.execPath,
        DOHC_AGENT_CLAUDE_CODE_ARGS_JSON: JSON.stringify([fakeClaude, "ok"]),
      },
      "claude-code-chat",
      title,
    );

    await submitMessage(desktop, title, "Write the fake Claude note.");

    await expect
      .poll(async () => readGuestText(desktop!, title), { timeout: 60_000 })
      .toContain("Writing the note now.");

    await runInChatGuest(
      desktop,
      title,
      "const button = [...document.querySelectorAll('button')].find(" +
        "(element) => element.textContent === 'Allow once');" +
        "if (!button) throw new Error('The permission button did not appear.');" +
        "button.click(); true;",
    );

    await expect
      .poll(async () => readGuestText(desktop!, title), { timeout: 60_000 })
      .toContain('"behavior":"allow"');

    await reloadAndStop(desktop, title);
    await proveTokenGate(desktop, title);
  } catch (error) {
    logPluginLines(desktop, /plugin|claude/i);
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("the agent-chat plugin serves the Codex chat and sends a message to Codex", async () => {
  const temp = await createTempWorkspace();
  const title = "Codex Chat";
  const prompt = "Echo this Codex chat e2e marker.";
  let desktop: Desktop | null = null;

  try {
    desktop = await openChat(
      temp,
      {
        DOHC_AGENT_CODEX_COMMAND: process.execPath,
        // "no-turn" never completes a turn, so the reload proof below clicks
        // Stop rather than sending a second message, which would 409
        // regardless of the token.
        DOHC_AGENT_CODEX_ARGS_JSON: JSON.stringify([fakeCodex, "no-turn"]),
      },
      "codex-chat",
      title,
    );

    await submitMessage(desktop, title, prompt);

    await expect
      .poll(async () => readGuestText(desktop!, title), { timeout: 60_000 })
      .toContain('"text":"' + prompt + '"');

    await reloadAndStop(desktop, title);
    await proveTokenGate(desktop, title);
  } catch (error) {
    logPluginLines(desktop, /plugin|codex/i);
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
