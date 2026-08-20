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
