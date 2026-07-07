import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { engineMomentsOrEmpty, ydocUpdateCount } from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// WS-G2-C-2 pinning E2E: the desktop editor is DECOUPLED from Hocuspocus. An
// engine-flagged personal/local workspace edits a rich doc THROUGH the engine
// Y.Doc provider (recordUpdate + debounced settle) with no relay — the editor
// loads, editing lands on the .md and in engine.db as ydoc.update ops, with ZERO
// collab-server involvement: no WebSocket is ever opened and the collabToken IPC
// refuses a non-shared workspace. The former HocuspocusProvider path is no
// longer instantiated by the editor (G2-C-3 removes its remaining code). The
// engine.db SQLite readers (engineMomentsOrEmpty / ydocUpdateCount) are shared
// with workspace-engine-editor.spec via ./helpers/engineDb — one source of truth
// for the load-bearing "no double-journal" scaffolding.

test("engine-flagged local workspace edits a rich doc through the engine provider — no Hocuspocus, editing lands", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Typed with no collab server anywhere.";

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/solo.md", contents: "# Solo\n\nStart here.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;

    // Record every WebSocket the renderer opens for the whole session. Solo
    // rich-doc editing must never open one (Hocuspocus is WebSocket-only).
    const webSockets: string[] = [];
    page.on("websocket", (ws) => {
      webSockets.push(ws.url());
    });

    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/solo.md");

    // Open the rich doc: useEngineDoc opens an engine Y.Doc session over IPC and
    // binds the Tiptap Collaboration extension to the mirror doc. There is no
    // read/source Edit gate in engine mode — the WYSIWYG editor is the whole
    // surface, so the local-editor Edit toggle is absent once the engine session
    // is live.
    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/solo.md").click();
    // Gated on the engine Y.Doc session going live (async IPC round-trip through
    // main), so give it the same 15s slack as the surrounding settle assertions
    // rather than the 5s default (which flakes under load/xvfb).
    await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, {
      timeout: 15_000,
    });
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();

    // Type into the live rich editor and let the debounced settle land.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(sentinel);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 15_000 },
    );

    // The settle projected the edit onto disk through the engine (not a bridge
    // text write).
    await expect
      .poll(async () => await readFile(join(temp.rootPath, "notes/solo.md"), "utf8").catch(() => ""), {
        timeout: 30_000,
      })
      .toContain(sentinel);

    // The edit went through the engine Y.Doc provider: it journaled ydoc.update
    // CRDT ops (the old path would have produced only ordinary moment.append
    // captures with no ydoc_updates rows at all).
    await expect
      .poll(() => ydocUpdateCount(temp.rootPath), { timeout: 30_000 })
      .toBeGreaterThan(0);
    // The settle projected a history moment carrying the text (settle points are
    // engine history).
    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              moment.path === "notes/solo.md" &&
              moment.operation === "write" &&
              moment.text.includes(sentinel),
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // The explicit decoupling pins: collab is REFUSED for this workspace (the
    // fail-closed collabToken IPC), and no WebSocket was ever opened.
    const collabToken = await page.evaluate(
      async (payload) => {
        const api = (window as unknown as {
          dohcDesktop: {
            collabToken(input: {
              workspaceId: string;
              relativePath: string;
            }): Promise<{ available: boolean }>;
          };
        }).dohcDesktop;
        return api.collabToken(payload);
      },
      { workspaceId: workspace.workspaceId, relativePath: "notes/solo.md" },
    );
    // Exact-shape refusal: available:false and NOTHING else — a token, url,
    // or partial credential leaking alongside the refusal would defeat the
    // decoupling this spec pins.
    expect(collabToken).toEqual({ available: false });
    expect(webSockets).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("collab-style materializations (bridge text writes) on an engine-flagged workspace produce engine moments", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/shared-doc.md", contents: "# Shared doc\n\nBase text.\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/shared-doc.md");

    // Coexistence rule 2 (collab design): during a live session the Y.Doc is
    // canonical and the engine records its settle-point MATERIALIZATIONS as
    // ordinary moments. A materialization is exactly a writeWorkspaceText
    // bridge call (useCollabDoc.writeAndRecord) — drive that same seam and pin
    // that the engine captures it. Engine history of a live-session doc is the
    // history of settle points, not keystrokes — documented, not a bug.
    const materialized = "# Shared doc\n\nBase text.\n\nSettled from a live CRDT session.\n";
    await page.evaluate(
      async (input) => {
        const api = (window as unknown as {
          dohcDesktop: {
            writeWorkspaceText(payload: {
              workspaceId: string;
              relativePath: string;
              text: string;
            }): Promise<unknown>;
          };
        }).dohcDesktop;
        await api.writeWorkspaceText({
          workspaceId: input.workspaceId,
          relativePath: "notes/shared-doc.md",
          text: input.text,
        });
      },
      { workspaceId: workspace.workspaceId, text: materialized },
    );

    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              moment.path === "notes/shared-doc.md" &&
              moment.operation === "write" &&
              moment.text === materialized,
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
