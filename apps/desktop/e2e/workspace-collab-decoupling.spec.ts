import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// G2-A pinning E2E (collab design, milestone G2-A): the engine flag and the
// collab stack are DECOUPLED. An engine-flagged personal/local workspace edits
// a rich doc with no Hocuspocus reachable and no cloud config — the editor
// loads, autosave works, and engine moments capture — with ZERO collab
// involvement: no WebSocket is ever opened and the collabToken IPC refuses a
// non-shared workspace. This is the "explicitly decoupled" half of the 0N-3
// audit's collab gate ("live collab (Y.Doc) re-homed on the engine or
// explicitly decoupled so the flip does not regress co-editing").
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
    close(): void;
  };
};

interface EngineMoment {
  path: string;
  operation: string;
  text: string;
}

function engineMomentsOrEmpty(rootPath: string): EngineMoment[] {
  try {
    const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
      readOnly: true,
    });
    try {
      return db
        .prepare(
          `SELECT m.path AS path, m.operation AS operation, b.text AS text
           FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
           ORDER BY m.moment_order`,
        )
        .all() as unknown as EngineMoment[];
    } finally {
      db.close();
    }
  } catch {
    // engine.db may not exist yet while the app is still opening.
    return [];
  }
}

test("engine-flagged local workspace edits a rich doc with zero Hocuspocus — editor works, autosave lands, moments capture", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

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

    // Open the rich doc and enter the rich (Tiptap WYSIWYG) editor. Opening a
    // markdown file mounts useCollabDoc, which asks main for a collab token;
    // for a personal/local workspace main answers available:false and the
    // hook never imports yjs/@hocuspocus/provider.
    await explorerRow(page, "notes").click();
    await explorerRow(page, "notes/solo.md").click();
    await page.getByTestId("markdown-edit-toggle").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();

    // Type into the live rich editor and let the 800ms autosave settle.
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Typed with no collab server anywhere.");
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 15_000 },
    );

    // Autosave landed on disk through the normal bridge.
    const onDisk = await readFile(
      join(temp.rootPath, "notes/solo.md"),
      "utf8",
    );
    expect(onDisk).toContain("Typed with no collab server anywhere.");

    // The watcher captured the settled autosave into an engine moment.
    await expect
      .poll(
        () =>
          engineMomentsOrEmpty(temp.rootPath).filter(
            (moment) =>
              moment.path === "notes/solo.md" &&
              moment.operation === "write" &&
              moment.text.includes("Typed with no collab server anywhere."),
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
    expect(collabToken.available).toBe(false);
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
