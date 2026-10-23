import { DOCUMENT_END } from "../helpers/keys";
import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLiveDaemonWorkspace } from "../helpers/daemonSeed";
import { launchDesktopApp } from "../helpers/desktopApp";
import { withEngineDb } from "../helpers/engineDb";
import { spawnSyncRelay } from "../helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  waitForWorkspaceFile,
  waitForWorkspaceReady,
  writeWorkspaceFiles,
} from "../helpers/workspace";
import { createWorkspaceEngineCapture } from "../../src/workspaces/workspaceEngineCapture";
import { waitForPathMoments } from "../../src/workspaces/waitForPathMoments";
import { startCdpCapture } from "./cdpCapture";

// #2496: a large note in a workspace that syncs keeps its live record, so it
// skips the 64 KiB cutoff and opens in the rich editor at any size. Measure
// that open on this machine.

const OUT = process.env.LARGE_SYNC_OUT ?? join(tmpdir(), "large-synced-note");
const TARGET_BYTES = Number(process.env.LARGE_SYNC_BYTES ?? 245 * 1024);

function largeNote(): string {
  const shape = process.env.LARGE_SYNC_SHAPE ?? "mixed";
  if (shape === "tiny") return "# A long synced note\n\nStarts small.\n\nOne more line.\n";
  if (shape === "tiny-nested") return "# A long synced note\n\n- one\n  - two\n";
  if (shape === "edit-beside-nested") return "# A long synced note\n\nStarts small, edited outside.\n\n- one\n  - two\n";
  const blocks: Record<string, (index: number) => string> = {
    paragraphs: (index) => `Plain paragraph ${index} with ordinary words that run on for a while so the line wraps.\n`,
    bold: (index) => `Paragraph ${index} has **bold** words and a [link](https://example.com/${index}).\n\n- an item with **bold** in it\n- an item with a [link](https://example.com/${index})\n`,
    link: (index) => `Paragraph ${index} has a [link](https://example.com/${index}) in it.\n`,
    headings: (index) => `## Section ${index}\n`,
    list: (index) => `- one item in ${index}\n- another item\n`,
    "mixed-flat": (index) => `## Section ${index}\n\nParagraph ${index} has **bold**, a [link](https://example.com/${index}), and plain words that run on for a while so the line wraps.\n\nAnother paragraph in section ${index} with more ordinary words in it.\n\n- one item in ${index}\n- another item\n`,
    nested: (index) => `- one item in ${index}\n- another item\n  - a nested item\n`,
  };
  const block = blocks[shape];
  if (block) {
    const parts = ["# A long synced note\n"];
    for (let index = 0; Buffer.byteLength(parts.join("\n"), "utf8") < TARGET_BYTES; index += 1) parts.push(block(index));
    return parts.join("\n");
  }
  const parts = ["# A long synced note\n"];
  for (let section = 0; Buffer.byteLength(parts.join("\n"), "utf8") < TARGET_BYTES; section += 1) {
    parts.push(`## Section ${section}\n`);
    for (let paragraph = 0; paragraph < 6; paragraph += 1) {
      parts.push(`Paragraph ${paragraph} of section ${section} has **bold**, a [link](https://example.com/${section}), and plain words that run on for a while so the line wraps.\n`);
    }
    parts.push(`- one item in ${section}\n- another item\n  - a nested item\n`);
  }
  return parts.join("\n");
}

// Records gaps between 20 ms ticks, so a freeze shows as one long gap.
async function startGapRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { last: performance.now(), gaps: [] as Array<{ at: number; ms: number }> };
    (window as unknown as { __gaps: typeof state }).__gaps = state;
    setInterval(() => {
      const now = performance.now();
      if (now - state.last > 100) state.gaps.push({ at: Math.round(state.last), ms: Math.round(now - state.last) });
      state.last = now;
    }, 20);
  });
}

async function readGaps(page: Page): Promise<Array<{ at: number; ms: number }>> {
  return page.evaluate(() => (window as unknown as { __gaps: { gaps: Array<{ at: number; ms: number }> } }).__gaps.gaps.splice(0));
}

async function editable(page: Page): Promise<void> {
  await expect(page.getByTestId("markdown-source-toggle")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("markdown-open-state")).toHaveCount(0, { timeout: 180_000 });
  await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true", { timeout: 180_000 });
}

function mark(step: string): void {
  console.log(`[mark] ${new Date().toISOString()} ${step}`);
}

test("opens a large note in a workspace that syncs", async () => {
  test.setTimeout(9 * 60_000);
  await mkdir(OUT, { recursive: true });
  const temp = await createTempWorkspace();
  const workspaceId = "large-synced-note";
  const local = process.env.LARGE_SYNC_LOCAL === "1";
  const relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    if (local) {
      await writeWorkspaceFiles(temp, [
        { path: "notes/long.md", contents: process.env.LARGE_SYNC_INITIAL_NESTED === "1" ? "# A long synced note\n\nStarts small.\n\n- one\n  - two\n" : "# A long synced note\n\nStarts small.\n" },
        { path: "notes/other.md", contents: "# Other\n\nA small note.\n" },
      ]);
      const owner = process.env.LARGE_SYNC_OWNER === "1";
      if (owner) await seedCloudCredentials(temp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId: "e2e-user" });
      desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" } });
      const opened = await openWorkspaceFromFirstRun(desktop.page, temp);
      await waitForWorkspaceFile(desktop.page, opened.workspaceId, "notes/long.md");
      if (owner) {
        await desktop.page.evaluate(async (workspaceId) => {
          await (window as unknown as { dohcDesktop: { cloudEnableSync(payload: { workspaceId: string }): Promise<unknown> } }).dohcDesktop.cloudEnableSync({ workspaceId });
        }, opened.workspaceId);
        mark("sync on");
      }
    } else {
    const seedRoot = join(temp.baseDir, "seed");
    await mkdir(join(seedRoot, "notes"), { recursive: true });
    const source = await openLiveDaemonWorkspace({ workspaceId, rootPath: seedRoot });
    const capture = createWorkspaceEngineCapture({ ...source.workspace, rustEngineSessions: source.sessions });
    try {
      const remote = source.relay.bind({ ...source.workspace, relay: { baseUrl: relay.baseUrl, token: "test:e2e-user" } });
      await remote.claim();
      await writeFile(join(seedRoot, "notes/long.md"), "# A long synced note\n\nStarts small.\n");
      await writeFile(join(seedRoot, "notes/other.md"), "# Other\n\nA small note.\n");
      await waitForPathMoments(capture, "notes/long.md", 1);
      await waitForPathMoments(capture, "notes/other.md", 1);
      expect((await remote.push()).pushed).toBeGreaterThan(0);
    } finally {
      try { await capture.stop(); } finally { await source.close(); }
    }
    await seedCloudCredentials(temp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId: "e2e-user" });

    desktop = await launchDesktopApp({ workspace: temp, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" } });
    const page = desktop.page;
    // The join handler doesn't wait for the engine yet; a join before the handshake fails.
    // A status request for a workspace waits for the engine, then refuses the unknown one.
    await page.evaluate(async () => {
      const api = (window as unknown as { dohcDesktop: { cloudStatus(payload: { workspaceId: string }): Promise<unknown> } }).dohcDesktop;
      await api.cloudStatus({ workspaceId: "engine-ready-probe" }).catch(() => undefined);
    });
    await page.getByTestId("first-run-join-synced").click();
    await page.getByTestId("join-sync-code").fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    await waitForWorkspaceFile(page, workspaceId, "notes/long.md");
    await waitForWorkspaceFile(page, workspaceId, "notes/other.md");
    }
    const page = desktop.page;

    await explorerRow(page, "notes").click();
    mark("open small");
    await explorerRow(page, "notes/long.md").click();
    await editable(page);
    await expect(page.getByTestId("markdown-editor")).toContainText("Starts small.");
    mark("small open live");
    await startGapRecorder(page);

    // The note grows on disk while it is open, as another app's write would.
    const note = largeNote();
    const lastLine = "Last line of the long note.";
    const results: Record<string, unknown> = { bytes: Buffer.byteLength(note, "utf8") };
    let profile = await startCdpCapture(desktop.app, page);
    let started = performance.now();
    if (process.env.LARGE_SYNC_CLOSED === "1") {
      await explorerRow(page, "notes/other.md").click();
      await expect(page.getByTestId("markdown-editor")).toContainText("A small note.");
    }
    mark("write large");
    await writeWorkspaceFiles(temp, [{ path: "notes/long.md", contents: `${note}\n${lastLine}\n` }]);
    if (process.env.LARGE_SYNC_CLOSED === "1") {
      await expect.poll(() => withEngineDb(temp.rootPath, (db) => db.prepare("SELECT count(*) AS n FROM capture_file_holds").get()), { timeout: 15_000 }).toEqual({ n: 0 });
      await explorerRow(page, "notes/long.md").click();
      await editable(page);
    }
    await expect(page.getByTestId("markdown-editor")).toContainText(lastLine, { timeout: Number(process.env.LARGE_SYNC_SHOWN_MS ?? 180_000) });
    results.outsideWriteShownMs = Math.round(performance.now() - started);
    results.editorHtmlHead = (await page.getByTestId("markdown-editor").innerHTML()).slice(0, 1500);
    if (process.env.LARGE_SYNC_TYPE_AFTER === "1") {
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
      const typed = "Typed in dohc after the outside edit.";
      await page.getByTestId("markdown-editor").click();
      await page.keyboard.press(DOCUMENT_END);
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(typed);
      await expect.poll(() => readFile(join(temp.rootPath, "notes/long.md"), "utf8"), { timeout: 60_000 }).toContain(typed);
      results.fileAfterTyping = await readFile(join(temp.rootPath, "notes/long.md"), "utf8");
    }
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", { timeout: 180_000 });
    results.outsideWriteSettledMs = Math.round(performance.now() - started);
    let captured = await profile.stop();
    await writeFile(join(OUT, "outside-write.cpuprofile"), JSON.stringify(captured.cpuProfile));
    results.outsideWriteGaps = await readGaps(page);

    await explorerRow(page, "notes/other.md").click();
    await expect(page.getByTestId("markdown-editor")).toContainText("A small note.");
    await readGaps(page);

    profile = await startCdpCapture(desktop.app, page);
    started = performance.now();
    await explorerRow(page, "notes/long.md").click();
    await editable(page);
    await expect(page.getByTestId("markdown-editor")).toContainText(lastLine, { timeout: 180_000 });
    results.reopenEditableMs = Math.round(performance.now() - started);
    // A probe answers only when the renderer's main thread is free.
    const probeStarted = performance.now();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
    results.reopenFirstFrameAfterEditableMs = Math.round(performance.now() - probeStarted);
    await page.waitForTimeout(5_000);
    captured = await profile.stop();
    await writeFile(join(OUT, "reopen.cpuprofile"), JSON.stringify(captured.cpuProfile));
    results.reopenGaps = await readGaps(page);
    results.reopenLongTasks = captured.longTasks.entries.map((entry) => Math.round(entry.duration));
    results.openRefusals = desktop.logs.filter((entry) => entry.text.includes("open refused")).map((entry) => entry.text);

    await writeFile(join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    mark("failed");
    console.log("holds", JSON.stringify(withEngineDb(temp.rootPath, (db) => db.prepare("SELECT path, reason, observed_size, attempt_count FROM capture_file_holds").all())));
    throw error;
  } finally {
    await cleanupDesktopWorkspace(desktop, { cleanup: async () => { await relay.stop(); await temp.cleanup(); } });
  }
});
