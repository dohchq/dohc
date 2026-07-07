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

// WS-G2-C-2 editor-on-engine round trip. A rich markdown file on an engine-
// flagged workspace edits THROUGH the engine Y.Doc provider (recordUpdate +
// debounced settle), replacing HocuspocusProvider. The load-bearing proof: a
// live edit journals ONLY as ydoc.update — NOT a duplicate moment.append that
// would collide (P0D) with the ydoc.update stream on a shared workspace — and
// the .md + engine.db reflect it, and a reopen resumes the rich content.
const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

function withEngineDb<T>(rootPath: string, fn: (db: InstanceType<typeof DatabaseSync>) => T): T | null {
  let db: InstanceType<typeof DatabaseSync> | null = null;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), { readOnly: true });
    return fn(db);
  } catch {
    // engine.db may not exist yet while the app is still opening.
    return null;
  } finally {
    db?.close();
  }
}

function ydocUpdateCount(rootPath: string): number {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM ydoc_updates").get() as
        | { n: number }
        | undefined;
      return Number(row?.n ?? 0);
    }) ?? 0
  );
}

// Replication ops that carry the sentinel PLAINTEXT, grouped by op_kind. A
// ydoc.update op's payload is opaque Yjs binary (the plaintext is not
// searchable), so the ONLY way the typed sentence lands in a replication op as
// plaintext is a moment.append — i.e. the watcher double-journaling the settle's
// own .md self-write. This list must therefore be EMPTY (no double-journal).
function replicationOpKindsMentioning(rootPath: string, needle: string): string[] {
  return (
    withEngineDb(rootPath, (db) => {
      const rows = db
        .prepare("SELECT op_kind AS opKind, payload_json AS payload FROM replication_log")
        .all() as Array<{ opKind: string; payload: string }>;
      return rows
        .filter((row) => typeof row.payload === "string" && row.payload.includes(needle))
        .map((row) => row.opKind);
    }) ?? []
  );
}

function replicationOpKindCount(rootPath: string, opKind: string): number {
  return (
    withEngineDb(rootPath, (db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM replication_log WHERE op_kind = ?")
        .get(opKind) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    }) ?? 0
  );
}

// The projected settle moments (settle points ARE engine history) — these DO
// carry the text, proving the engine.db reflects the edit, and are journaled
// through the driver's non-journaling projection write (no moment.append op).
function momentTextsForPath(rootPath: string, path: string): string[] {
  return (
    withEngineDb(rootPath, (db) => {
      return (
        db
          .prepare(
            `SELECT b.text AS text
             FROM moments m JOIN blobs b ON b.sha256 = m.payload_after_blob_sha256
             WHERE m.path = ? ORDER BY m.moment_order`,
          )
          .all(path) as Array<{ text: string }>
      ).map((row) => row.text);
    }) ?? []
  );
}

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
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0);
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
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
