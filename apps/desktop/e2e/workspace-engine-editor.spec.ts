import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  momentTextsForPath,
  replicationOpKindCount,
  replicationOpKindsMentioning,
  withEngineDb,
  ydocUpdateCount,
} from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// WS-G2-C-2 editor-on-engine round trip. A rich markdown file on an engine-
// flagged workspace edits THROUGH the engine Y.Doc provider (recordUpdate +
// debounced settle), replacing HocuspocusProvider. The load-bearing proof: a
// live edit journals ONLY as ydoc.update — NOT a duplicate moment.append that
// would collide (P0D) with the ydoc.update stream on a shared workspace — and
// the .md + engine.db reflect it, and a reopen resumes the rich content. The
// SQLite readers (withEngineDb / ydocUpdateCount / replication* / moment*) live
// in ./helpers/engineDb — shared with workspace-collab-decoupling.spec so the
// load-bearing "no double-journal" scaffolding can never drift.

async function openEngineDoc(page: import("@playwright/test").Page, path: string): Promise<void> {
  const segments = path.split("/");
  // Expand each parent folder, then open the file.
  for (let i = 0; i < segments.length - 1; i += 1) {
    await explorerRow(page, segments.slice(0, i + 1).join("/")).click();
  }
  await explorerRow(page, path).click();
  // Engine mode has no read/source Edit gate — the WYSIWYG editor is the whole
  // surface. Wait for it to take over (the local-editor Edit toggle disappears
  // once the engine session is live) so a keystroke can never land on the brief
  // pre-open local editor.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

test("rich doc edits through the engine Y.Doc: settle lands on .md + engine.db, only ydoc.update journals, reopen resumes", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Engine-journaled sentence, no double capture.";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/rich.md", contents: "# Rich\n\nBase paragraph.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;

    // No websocket may ever open — the engine provider is relay-free.
    const webSockets: string[] = [];
    page.on("websocket", (ws) => webSockets.push(ws.url()));

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/rich.md");

    await openEngineDoc(page, "notes/rich.md");

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(sentinel);

    // The debounced settle projects the edit into engine.db AND writes the .md.
    await expect
      .poll(async () => await readFile(join(temp.rootPath, "notes/rich.md"), "utf8").catch(() => ""), {
        timeout: 20_000,
      })
      .toContain(sentinel);

    // engine.db reflects it: the CRDT lineage exists (ydoc.update ops) and the
    // settle projected a history moment carrying the text.
    await expect.poll(() => ydocUpdateCount(temp.rootPath), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect
      .poll(() => momentTextsForPath(temp.rootPath, "notes/rich.md").some((t) => t.includes(sentinel)), {
        timeout: 20_000,
      })
      .toBe(true);

    // THE load-bearing assertion: the edit replicates as ydoc.update ops, and
    // the watcher's observation of the settle's own .md write was DEFERRED — so
    // the typed sentence never became a moment.append (a double-journal that on
    // a shared workspace would collide as a P0D). Since a ydoc.update payload is
    // opaque, the sentinel plaintext must appear in NO replication op at all.
    expect(replicationOpKindCount(temp.rootPath, "ydoc.update")).toBeGreaterThan(0);
    const opKindsWithSentinel = replicationOpKindsMentioning(temp.rootPath, sentinel);
    expect(opKindsWithSentinel).not.toContain("moment.append");
    expect(opKindsWithSentinel).toEqual([]);
    expect(replicationOpKindCount(temp.rootPath, "conflict.open")).toBe(0);
    expect(webSockets).toEqual([]);

    // Reopen resumes the rich content (a replicated doc never prunes; it resumes
    // from its CRDT lineage / the projected .md).
    await explorerRow(page, "notes").click();
    await openEngineDoc(page, "notes/rich.md");
    await expect(page.getByTestId("markdown-editor")).toContainText(sentinel);

    // "View markdown as source": the header toggle flips to a READ-ONLY
    // projection of the engine Y.Doc through the same yDocToMarkdown the
    // settle uses — raw markup (the `#` the editor renders as a heading) is
    // visible as text, and the surface refuses edits (the derived markdown
    // cache must never become an editable source of truth).
    await page.getByTestId("markdown-source-toggle").click();
    const sourceView = page.getByTestId("markdown-source-view");
    await expect(sourceView).toBeVisible();
    await expect(sourceView).toContainText("# Rich");
    await expect(sourceView).toContainText(sentinel);
    await expect(sourceView.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    // Toggling back restores the WYSIWYG editor with the same content.
    await page.getByTestId("markdown-source-toggle").click();
    await expect(page.getByTestId("markdown-editor")).toContainText(sentinel);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// WS-G2-C-2 gate fix 1 — a GENUINE external edit to a LIVE doc must NOT be
// silently dropped. The old blanket live-path skip discarded EVERY watcher event
// for a live path, so an agent/other editor writing the .md while the editor was
// open lost its change (the next settle overwrote it from the CRDT). Now only the
// settle's own sha-matched self-write is suppressed; a genuine external write is
// captured as a moment (on a shared workspace it would surface as a real
// conflict — correct, not silent loss). Folding it into the live doc as CRDT
// deltas is G2-C-3; here the bar is not-dropping.
test("an external edit to a LIVE engine doc is captured (moment.append), not silently dropped", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const external = "External agent wrote this straight to disk while the editor was open.";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/rich.md", contents: "# Rich\n\nBase paragraph.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/rich.md");
    // Open the doc so its engine Y.Doc session goes LIVE (the path enters the
    // live-session registry). Do NOT type: a quiescent live session issues no
    // settle, so nothing re-projects the CRDT over the external write — the
    // deterministic form of the loss the old blanket live-path skip caused.
    await openEngineDoc(page, "notes/rich.md");

    // An external writer (agent / other editor) replaces the .md while the
    // session is live. The old code dropped EVERY watcher event for a live path;
    // now this genuine edit (a sha that matches no settle self-write) is captured.
    await writeWorkspaceFiles(temp, [
      { path: "notes/rich.md", contents: `# Rich\n\n${external}\n` },
    ]);

    // Proof it was not silently dropped: the external content was captured as an
    // engine moment (its text lands in a moment blob). The old blanket live-path
    // skip discarded the watcher event outright, so this moment never existed.
    // (moment.append payloads reference the text by blob sha — never inline — so
    // the moment→blob join, not a payload_json scan, is how the content is read.)
    await expect
      .poll(() => momentTextsForPath(temp.rootPath, "notes/rich.md").some((t) => t.includes(external)), {
        timeout: 20_000,
      })
      .toBe(true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// WS-G2-C-2 gate fix 2 — a version op while a rich doc is LIVE must settle +
// close the session FIRST. Otherwise the live session keeps its old versionId
// and a later settle writes a stale projection into the now-active version
// (two-canonical / two-lineage corruption). Here a version is created through
// the product bridge while the editor is open; the fix flushes the in-flight
// edit and releases the session before materializing.
test("creating a version while a rich doc is live flushes + closes the session (no stale projection, edit preserved)", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Edit that a version op must flush before switching.";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/rich.md", contents: "# Rich\n\nBase paragraph.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/rich.md");
    await openEngineDoc(page, "notes/rich.md");

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(sentinel);

    // Create a version through the bridge while the doc is still live. The main-
    // process version op awaits settleAndCloseLiveYDocSessions FIRST — the call
    // only resolves after the live session flushed + released.
    const created = await page.evaluate(async (workspaceId) => {
      const api = (window as unknown as {
        dohcDesktop: {
          createWorkspaceVersion(p: { workspaceId: string; name: string }): Promise<unknown>;
        };
      }).dohcDesktop;
      await api.createWorkspaceVersion({ workspaceId, name: "snapshot" });
      return true;
    }, workspace.workspaceId);
    expect(created).toBe(true);

    // The in-flight edit was flushed by the forced settle-on-close (not lost to
    // the fork-from-disk), so it is a durable moment AND on disk.
    await expect
      .poll(() => momentTextsForPath(temp.rootPath, "notes/rich.md").some((t) => t.includes(sentinel)), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(await readFile(join(temp.rootPath, "notes/rich.md"), "utf8")).toContain(sentinel);

    // A second (named) version now exists — the op completed past the flush.
    expect(
      withEngineDb(temp.rootPath, (db) =>
        Number(
          (db.prepare("SELECT COUNT(*) AS n FROM versions").get() as { n: number } | undefined)?.n ?? 0,
        ),
      ),
    ).toBeGreaterThanOrEqual(2);

    // Reopening the doc works cleanly (the reservation was released — no leaked
    // single-canonical) and still shows the edit.
    await explorerRow(page, "notes").click();
    await openEngineDoc(page, "notes/rich.md");
    await expect(page.getByTestId("markdown-editor")).toContainText(sentinel);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
