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
// These specs own (b) end to end, and the "editor went dead" half of (a). The
// EPIPE half is not reproducible here (see the note in killDaemonMidTyping).
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
  input: {
    docPath: string;
    preKill: string;
    postKill: string;
    // Delays the supervisor's relaunch so the outage outlives the transport
    // retry window and the session is genuinely stranded dead.
    restartBackoffMs?: number;
  },
): Promise<KilledSession> {
  const desktop = await launchDesktopApp({
    workspace: temp,
    ...(input.restartBackoffMs !== undefined
      ? {
          env: {
            DOHC_TEST_ENGINE_RESTART_BACKOFF_MS: String(input.restartBackoffMs),
          },
        }
      : {}),
  });
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

  const replacement = await waitForFreshEngineDaemon(
    appPid,
    victims,
    (input.restartBackoffMs ?? 0) + 30_000,
  );
  expect(victims).not.toContain(replacement);

  // A daemon death must never become a user-facing main-process crash. This
  // cannot observe the journey's EPIPE class — Playwright keeps a reader on the
  // app's stdio, so the pipe never breaks and this assertion holds on unfixed
  // main too. The EPIPE fix is covered by stdioResilience.test.ts and by the
  // throwing-sink test in workspaceEngineYDocRestart.test.ts; this guards the
  // rest of the uncaught-exception class.
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

// D1's end-to-end discrimination. A production restart lands in ~100ms, well
// inside the transport retry window, so the rebind normally absorbs a kill and
// the session is never stranded dead. Delaying the supervisor's relaunch past
// that window (DOHC_TEST_ENGINE_RESTART_BACKOFF_MS, a DOHC_DESKTOP_TEST-only
// seam) reaches the state the journey ended in: a dead session whose text lives
// only in the canonical doc, and a user who quits without typing again.
test("an outage longer than the retry window still persists the text at quit", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const preKill = "KILLREC_PRE_2b4d6f";
  const postKill = "KILLREC_POST_8a0c2e";
  const docPath = "abuse/kill.md";
  // Longer than the ~2.5s transport retry ladder, so the rebind gives up and
  // the session is marked dead — but back before the quit, so recovery can run.
  const restartBackoffMs = 4_000;

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
      restartBackoffMs,
    });
    desktop = killed.desktop;

    // The session went dead during the outage: main reported the refused edits.
    // Precondition, not decoration: the outage really did outlive the retry
    // ladder, so the rebind was EXHAUSTED and the session marked dead. Without
    // this the spec could silently degrade into the fast-restart case it exists
    // to go beyond. Deliberately keyed on the rebind's own error type rather
    // than on how many failures recovery goes on to log, so the precondition
    // cannot shift meaning under a mutation of the recovery code.
    const refusedEdits = desktop.logs.filter(
      (entry) =>
        entry.source === "main" &&
        /Y\.Doc local update of .* failed/.test(entry.text),
    );
    expect(refusedEdits.length).toBeGreaterThan(0);
    expect(refusedEdits[0]?.text).toContain("EngineWorkspaceRebindError");

    // Quit with no further typing. Only the settling close can save this text.
    await desktop.close();
    desktop = null;

    const onDisk = await readFile(join(temp.rootPath, docPath), "utf8");
    expect(onDisk).toContain(preKill);
    expect(onDisk).toContain(postKill);
    expect(onDisk.match(/Anchor paragraph\./g)).toHaveLength(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
