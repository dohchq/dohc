import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  engineDaemonPids,
  hardKillPid,
  waitForFreshEngineDaemon,
} from "./helpers/daemonKill";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// AUDIT-KILLREC. The dogfood journey hard-killed the engine daemon
// (`taskkill /F`) three times while the user was typing. Two things broke:
//
//  (a) the FIRST kill surfaced an Electron "A JavaScript error occurred in the
//      main process" dialog (uncaught EPIPE from the capture's console.error
//      failure logger) and the editor went dead afterwards, and
//  (b) text typed just BEFORE a kill was ultimately lost from BOTH the app and
//      the .md on disk.
//
// The daemon dying is an EXPECTED, recoverable event — EngineDaemonLifecycle
// exists precisely to restart it. These specs drive the real app against a real
// daemon and hard-kill the real process, because that is the layer that broke;
// a mocked lifecycle cannot observe a torn transport mid-write.

async function openEngineDoc(page: Page, path: string): Promise<void> {
  // revealExplorerPath is expansion-idempotent: a relaunch restores the tree
  // already expanded, and a blind folder click would collapse it instead.
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click();
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

function mainProcessCrashText(
  logs: ReadonlyArray<{ source: string; level: string; text: string }>,
): string[] {
  return logs
    .filter((entry) => entry.source === "main")
    .map((entry) => entry.text)
    .filter(
      (text) =>
        /Uncaught Exception/i.test(text) ||
        /A JavaScript error occurred in the main process/i.test(text) ||
        /EPIPE/.test(text),
    );
}

interface KilledSession {
  desktop: Awaited<ReturnType<typeof launchDesktopApp>>;
  editor: ReturnType<Page["getByTestId"]>;
}

// Launches the app, warms a settled edit, types `preKill`, hard-kills the real
// daemon before the debounced settle can run, keeps typing through the outage,
// and waits for the supervisor's replacement. Returns with the app still open.
async function killDaemonMidTyping(
  temp: Awaited<ReturnType<typeof createTempWorkspace>>,
  input: { docPath: string; preKill: string; postKill: string },
): Promise<KilledSession> {
  const desktop = await launchDesktopApp({ workspace: temp });
  const { page, app } = desktop;
  const appPid = app.process().pid;
  if (appPid === undefined) throw new Error("Electron app has no pid.");

  const workspace = await openWorkspaceFromFirstRun(page, temp);
  await waitForWorkspaceFile(page, workspace.workspaceId, input.docPath);
  await openEngineDoc(page, input.docPath);

  const editor = page.getByTestId("markdown-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");

  // A first settled edit proves the session is genuinely live before the kill,
  // so a later missing sentinel cannot be blamed on a doc that never worked.
  await page.keyboard.type(" WARMUP_KILLREC");
  await expect
    .poll(
      async () =>
        await readFile(join(temp.rootPath, input.docPath), "utf8").catch(
          () => "",
        ),
      { timeout: 20_000 },
    )
    .toContain("WARMUP_KILLREC");

  const victims = await engineDaemonPids(appPid);
  expect(victims.length).toBeGreaterThan(0);

  // The must-survive sentinel, then an immediate kill — before the debounced
  // settle can project it. This is the only window in which the renderer and
  // the canonical doc are the sole holders of the text.
  await page.keyboard.type(` ${input.preKill}`);
  for (const pid of victims) await hardKillPid(pid);

  // Keep typing through the outage, exactly like the journey's user did.
  await page.keyboard.type(` ${input.postKill}`);

  const replacement = await waitForFreshEngineDaemon(appPid, victims);
  expect(victims).not.toContain(replacement);

  // (a) The daemon dying must never become a user-facing main-process crash.
  expect(mainProcessCrashText(desktop.logs)).toEqual([]);

  return { desktop, editor };
}

// THE journey's scenario. Its user stopped typing before the app went away, so
// recovery that only runs on the next keystroke never runs at all: nothing is
// typed here between the daemon's return and the quit.
test("a hard daemon kill keeps the outage text when the user never types again", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const preKill = "KILLREC_PRE_a1b2c3";
  const postKill = "KILLREC_POST_d4e5f6";
  const docPath = "abuse/kill.md";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: docPath, contents: "# Kill\n\nAnchor paragraph.\n" },
    ]);

    const killed = await killDaemonMidTyping(temp, {
      docPath,
      preKill,
      postKill,
    });
    desktop = killed.desktop;

    // Quit with no further typing — the app's settling close is the last chance
    // to persist what the canonical doc has been holding since the kill.
    await desktop.close();
    desktop = null;

    const onDisk = await readFile(join(temp.rootPath, docPath), "utf8");
    expect(onDisk).toContain(preKill);
    expect(onDisk).toContain(postKill);
    // The document must be recovered, not duplicated.
    expect(onDisk.match(/Anchor paragraph\./g)).toHaveLength(1);
    expect(onDisk.match(new RegExp(preKill, "g"))).toHaveLength(1);

    desktop = await launchDesktopApp({ workspace: temp });
    const relaunched = desktop.page;
    const reopened = await openWorkspaceFromFirstRun(relaunched, temp);
    await waitForWorkspaceFile(relaunched, reopened.workspaceId, docPath);
    await openEngineDoc(relaunched, docPath);
    await expect(relaunched.getByTestId("markdown-editor")).toContainText(
      preKill,
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a hard daemon kill leaves the editor writable and lands the outage text", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const preKill = "KILLREC_PRE_9f8e7d";
  const postKill = "KILLREC_POST_6c5b4a";
  const docPath = "abuse/kill.md";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: docPath, contents: "# Kill\n\nAnchor paragraph.\n" },
    ]);

    const killed = await killDaemonMidTyping(temp, {
      docPath,
      preKill,
      postKill,
    });
    desktop = killed.desktop;

    // (a) The editor must still accept input after the restart, not sit dead.
    await desktop.page.keyboard.type(" KILLREC_AFTER_RESTART");
    await expect(killed.editor).toContainText("KILLREC_AFTER_RESTART");

    // (b) And the keystroke path persists everything through the replacement.
    await expect
      .poll(
        async () =>
          await readFile(join(temp.rootPath, docPath), "utf8").catch(() => ""),
        { timeout: 30_000 },
      )
      .toContain(preKill);
    const onDisk = await readFile(join(temp.rootPath, docPath), "utf8");
    expect(onDisk).toContain(postKill);
    expect(onDisk).toContain("KILLREC_AFTER_RESTART");
    expect(onDisk.match(/Anchor paragraph\./g)).toHaveLength(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
