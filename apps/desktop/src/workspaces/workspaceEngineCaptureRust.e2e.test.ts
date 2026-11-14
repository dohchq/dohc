import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { defaultWorkspaceMode, type WatcherEvent } from "@dohc/workspace-core";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { createWorkspaceEngineCapture as createAttachedWorkspaceEngineCapture } from "./workspaceEngineCapture";
import { startWorkspaceFileObservation } from "./workspaceFileObservation";
import { EngineFileObservation } from "@dohc/workspace-engine-client/daemon";
import {
  createRealDaemonLifecycle,
  createRealDaemonWorkspaceSessions,
} from "../testing/realDaemonWorkspaceSessions";
import { createTestScratch } from "./testTemp";
import { waitForPathMoments } from "./waitForPathMoments";
import { engine } from "./workspaceEngineCaptureRust.fixture";

it.skipIf(engine.missing).each([true])(
  "preserves hand-made Markdown opened before adoption (later edit=%s)",
  async (laterEdit) => {
    const root = await createTestScratch("dohc-open-lossless-adoption-");
    const lifecycle = createRealDaemonLifecycle({ command: engine.require(), maxRestarts: 0 });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = {
      workspaceId: "open-lossless-adoption",
      rootPath: root,
      attachmentId: Symbol("lossless"),
    };
    const errors: unknown[] = [];
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
      settleDebounceMs: 60_000,
      onError: (_context, error) => {
        errors.push(error);
      },
    });
    const original = "A setext heading\n================\n\n* first\n* second\n";
    try {
      const adapter = await sessions.run(
        workspace,
        async ({ client, workspace: handle }) =>
          new VersionedLiveAdapter(client, handle, { workspaceId: workspace.workspaceId }),
      );
      await adapter.ensureMainVersion({ workspaceId: workspace.workspaceId });
      for (const [path, text] of [
        ["tasks/collection.yaml", "fields: {}\n"],
        ["tasks/record.md", original],
      ]) {
        await adapter.writeTextFile({
          workspaceId: workspace.workspaceId,
          versionId: "main",
          path: path!,
          text: text!,
          publish: true,
          metadata: { origin: "api" },
        });
      }
      await expect
        .poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length, {
          timeout: 60_000,
        })
        .toBe(1);
      const session = await capture.openYDocSession({
        path: "tasks/record.md",
        contentKind: "richdoc",
        onRemoteUpdate: () => undefined,
      });
      if (laterEdit) {
        await session.applyDecidedLocalUpdate(
          (doc) => {
            const scratch = new Y.Doc();
            try {
              Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
              const before = Y.encodeStateVector(scratch);
              patchFrontmatter(scratch, new Map([["Name", "Edited"]]));
              return Y.encodeStateAsUpdate(scratch, before);
            } finally {
              scratch.destroy();
            }
          },
          undefined,
          { idempotencyKey: "lossless-edit" },
        );
      }
      await capture.flush();
      await expect
        .poll(async () => (await adapter.listPendingCollectionAdoptions()).adoptions.length, {
          timeout: 60_000,
        })
        .toBe(0);
      const adopted = await readFile(join(root, "tasks/record.md"), "utf8");
      if (laterEdit) {
        expect(adopted).toBe(original);
        expect(session.doc.getMap("frontmatter").get("id")).toBeUndefined();
        expect((await adapter.queryCollectionRecords({ collectionPath: "tasks" })).records).toEqual(
          [],
        );
      } else {
        expect(adopted.replace(/^---\nid: [^\n]+\n---\n\n/, "")).toBe(original);
        expect(session.doc.getMap("frontmatter").get("id")).toBeTruthy();
        await session.settleNow();
        expect(await readFile(join(root, "tasks/record.md"), "utf8")).toBe(adopted);
      }
      expect(errors).toEqual([]);
      await session.close();
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll();
      await lifecycle.stop();
    }
  },
  120_000,
);

// The engine's Markdown settlement rewrote unedited files on close —
// mangling CRLF and trailing newlines, churning mtimes, and feeding the
// watcher a settled write for content nobody changed. The engine now proves
// the session held nothing beyond the declared seed and skips the write. This
// drives the full desktop feed — real daemon, real capture, real fs watcher —
// and pins both halves: no edit means no watcher event; a real edit still
// produces one.
it.skipIf(engine.missing)(
  "a no-edit open and close of a README feeds the watcher nothing; a real edit still does",
  async () => {
    const root = await createTestScratch("dohc-capture-rust-815-");
    const lifecycle = createRealDaemonLifecycle({
      command: engine.require(),
      maxRestarts: 0,
    });
    await lifecycle.start();
    const sessions = createRealDaemonWorkspaceSessions(lifecycle);
    const workspace = {
      workspaceId: "capture-rust-815",
      rootPath: root,
      attachmentId: Symbol("capture-rust-815"),
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    } as const;
    const capture = createAttachedWorkspaceEngineCapture({
      ...workspace,
      rustEngineSessions: sessions,
    });
    const readmePath = "notes/sample/README.md";
    // Both normalization victims at once: CRLF line endings and no trailing
    // newline. Any settle write would change these bytes.
    const readme = "# Sample\r\n\r\nOpened, never edited";
    const batches: WatcherEvent[][] = [];
    const readmeEvents = () => batches.flat().filter((event) => event.path === readmePath);
    try {
      await mkdir(join(root, "notes", "sample"), { recursive: true });
      await writeFile(join(root, readmePath), readme, "utf8");
      await waitForPathMoments(capture, readmePath, 1);
      const watch = startWorkspaceFileObservation(workspace, sessions, lifecycle, {
        facts(facts) {
          const events: WatcherEvent[] = facts.map((fact) => ({
            path: fact.path,
            operation: fact.kind === "disappeared" ? "delete" : "update",
          }));
          capture.observeFileEvents(events);
          batches.push(events);
        },
        resync: () => capture.resyncFileObservation(),
        captured() {},
        pulled() {},
        degraded() {},
      });
      await watch.ready;
      try {
        const before = await stat(join(root, readmePath));
        const session = await capture.openYDocSession({
          path: readmePath,
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        await session.close();
        // A full settle window plus slack: any write the close made would
        // surface here.
        await sessions.run(workspace, async (binding) => {
          await new EngineFileObservation(binding.client, binding.workspace).drain();
        });
        await watch.pulledPaths([]);
        expect(readmeEvents()).toEqual([]);
        expect(await readFile(join(root, readmePath), "utf8")).toBe(readme);
        const after = await stat(join(root, readmePath));
        expect(after.mtimeMs).toBe(before.mtimeMs);

        // The control half: a real edit must reach the feed exactly as
        // before the skip existed.
        const edited = await capture.openYDocSession({
          path: readmePath,
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        const editor = new Y.Doc();
        Y.applyUpdate(editor, edited.initialUpdate);
        const vector = Y.encodeStateVector(editor);
        const body = editor.getXmlFragment("body");
        const paragraph = new Y.XmlElement("paragraph");
        paragraph.insert(0, [new Y.XmlText("A real edit.")]);
        body.insert(body.length, [paragraph]);
        await edited.applyLocalUpdate(Y.encodeStateAsUpdate(editor, vector));
        await edited.close();
        await expect.poll(() => readmeEvents().length, { timeout: 60_000 }).toBeGreaterThan(0);
        expect(readmeEvents().length).toBeGreaterThan(0);
        expect(await readFile(join(root, readmePath), "utf8")).toContain("A real edit.");
      } finally {
        await watch.stop().catch(() => undefined);
      }
    } finally {
      await capture.stop().catch(() => undefined);
      await sessions.closeAll().catch(() => undefined);
      await lifecycle.stop().catch(() => undefined);
    }
  },
  60_000,
);
