import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VERSIONED_METHOD,
  DaemonRefusalError,
  type Request,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import {
  createWorkspaceEngineCapture,
  RestoreFolderInUseError,
  RestoreHeadChangedError,
  RestoreLocalChangesError,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

import { createTestScratch } from "./testTemp";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { hasRetainedLiveDraft, preserveUnsentLiveDraft, removeLiveDraftCopies } from "./liveDraftRecovery";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, readFile: vi.fn(actual.readFile)};
});

// The person a restore names, as desktop main reads them.
const RESTORER = { kind: "human", humanId: "local-person" } as const;

// Engine history reads (active-version timeline + one-moment
// payloads), engine-routed restore (forward history, expected-event
// registration, disk materialization, undo), the stable-object-id seam for
// the linked-chat rail, and engine-coordinated renames.

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readText(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

// The loopback holds real state and real sha256, and the fake daemon in
// front of it ingests the folder on `capture.flush`, so the history these
// tests read back is recorded state rather than a canned responder. Passing
// `requests` is what lets a test prove the path it took.
function capture(
  root: string,
  loopback: VersionedLoopbackEngine,
  requests?: Request[],
  hasRetainedLiveDraft?: (path: string, objectId: string) => Promise<boolean>,
): WorkspaceEngineCapture {
  const workspaceId = "engine-restore-test";
  return createWorkspaceEngineCapture({
    workspaceId,
    rootPath: root,
    attachmentId: Symbol("test-workspace-attachment"),
    rustEngineSessions: mockDaemonSessions({ rootPath: root, workspaceId, loopback, requests }),
    hasRetainedLiveDraft,
  });
}

describe("engine history reads", () => {
  it("classifies the synced deletion refusal without writing the restored text", async () => {
    const root = await createTestScratch("dohc-engine-restore-guard-");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    try {
      await write(root, "a.md", "Paris");
      await engine.flush();
      await write(root, "a.md", "Tokyo");
      engine.observeFileEvents([{path: "a.md", operation: "update"}]);
      await engine.flush();
      const source = (await engine.listMoments()).moments[0]!;
      const send = loopback.sendRequest.bind(loopback);
      vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
        if (request.method === VERSIONED_METHOD.textWrite) throw new DaemonRefusalError({code: "INVALID_PARAMS", message: "synced-deletion-revival-refused", retry: "no"}, null);
        return send(request);
      });
      await expect(engine.restoreFileToBeforeMoment(source.id, RESTORER)).rejects.toMatchObject({
        name: "SyncedDeletionRevivalError", path: "a.md", restore: true,
      });
      expect(await readText(root, "a.md")).toBe("Tokyo");
    } finally { await engine.stop(); }
  });
  it("lists the active version's moments newest first and reads one payload", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "a.md", "first\n");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = capture(root, loopback, requests);
    engine.start();
    await engine.flush();
    await write(root, "a.md", "second\n");
    engine.observeFileEvents([{ path: "a.md", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments();
    // The chain opens the daemon workspace and asks it for the timeline; the
    // daemon, not the chain, writes the captured text into its store.
    const methods = requests.map((request) => request.method);
    expect(methods).toContain("workspace.open");
    expect(methods).not.toContain(VERSIONED_METHOD.textWrite);
    expect(methods).toContain(VERSIONED_METHOD.historyPage);
    expect(loopback.requests.map((request) => request.method)).toContain(
      VERSIONED_METHOD.textWrite,
    );
    expect(page.activeVersionId).toBe("main");
    expect(page.moments).toHaveLength(2);
    expect(page.moments[0].recordedAtMs).toBeGreaterThanOrEqual(
      page.moments[1].recordedAtMs,
    );
    expect(page.nextCursor).toBeNull();

    const detail = await engine.readMoment(page.moments[0].id);
    expect(detail?.protected).toBe(false);
    const payload = detail?.protected === false ? detail.moment.payload : undefined;
    expect(payload?.before?.text).toBe("first\n");
    expect(payload?.after.text).toBe("second\n");
    await engine.stop();
  });

  it("scopes the timeline to the active version after a switch", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "plan.md", "main body\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft body\n");
    engine.observeFileEvents([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    const draftPage = await engine.listMoments();
    expect(draftPage.activeVersionId).not.toBe("main");
    // `every` is vacuously true on an empty page, so the scoping claim below
    // means nothing without this: a starved timeline would otherwise pass.
    expect(draftPage.moments.length).toBeGreaterThan(0);
    expect(
      draftPage.moments.every((moment) => moment.versionId === draftPage.activeVersionId),
    ).toBe(true);
    await engine.stop();
  });
});

describe("engine restore", () => {
  it("restores after the unseen main draft is reviewed and does not block a new object at its path", async () => {
    const root = await createTestScratch("dohc-engine-leftover-draft-");
    const recovery = await createTestScratch("dohc-live-draft-recovery-");
    const workspaceId = "engine-restore-test";
    await write(root, "a.txt", "saved original\n");
    const engine = capture(root, new VersionedLoopbackEngine(), undefined,
      (path, objectId) => hasRetainedLiveDraft(recovery, workspaceId, path, objectId));
    const seen = new Y.Doc(), unseen = new Y.Doc();
    engine.start();
    try {
      await engine.flush();
      await write(root, "a.txt", "saved revision\n");
      engine.observeFileEvents([{path: "a.txt", operation: "update"}]);
      await engine.flush();
      const edit = (await engine.listMoments()).moments[0]!;
      if (!edit.objectId) throw new Error("Expected a file object");
      seen.getText("plainText").insert(0, "renderer copy");
      unseen.getText("plainText").insert(0, "unseen main copy");
      for (const doc of [seen, unseen]) {
        await preserveUnsentLiveDraft(recovery, workspaceId, {path: "a.txt", objectId: edit.objectId, contentKind: "plaintext", doc});
      }
      const remaining = await removeLiveDraftCopies(recovery, workspaceId, edit.objectId,
        createHash("sha256").update(Y.encodeStateAsUpdate(seen)).digest("hex"), Date.now(), "a.txt");
      await expect(engine.restoreFileToBeforeMoment(edit.id, RESTORER, {expectedHeadMomentId: edit.id})).rejects.toThrow("Changed on this device since the last saved version");
      expect(remaining).toEqual([expect.objectContaining({text: "unseen main copy"})]);
      await removeLiveDraftCopies(recovery, workspaceId, edit.objectId,
        createHash("sha256").update(Y.encodeStateAsUpdate(unseen)).digest("hex"), Date.now(), "a.txt", remaining[0]!.recordId);
      await engine.restoreFileToBeforeMoment(edit.id, RESTORER, {expectedHeadMomentId: edit.id});
      expect(await readText(root, "a.txt")).toBe("saved original\n");
      await rm(join(root, "a.txt"));
      engine.observeFileEvents([{path: "a.txt", operation: "delete"}]);
      await engine.flush();
      await write(root, "a.txt", "new file\n");
      engine.observeFileEvents([{path: "a.txt", operation: "update"}]);
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      if (!created.objectId) throw new Error("Expected a new file object");
      expect(created.objectId).not.toBe(edit.objectId);
      expect(await hasRetainedLiveDraft(recovery, workspaceId, "a.txt", created.objectId)).toBe(false);
      await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, {expectedHeadMomentId: created.id})).resolves.toMatchObject({restored: "deleted"});
      expect(existsSync(join(root, "a.txt"))).toBe(false);
    } finally { seen.destroy(); unseen.destroy(); await engine.stop(); }
  });

  it.each([
    ["symlink-target", "dohc could not remove this file because its path contains a link. Check the file's path."],
    ["recovery-unavailable", "dohc could not remove this file. Check folder access, then try again."],
    ["file-locked", "dohc could not remove this file. It may be open in another app."],
    ["materialize-io", "dohc could not remove this file."],
  ])("reports the %s reason when a guarded delete fails", async (code, message) => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "new.md", "recipient text\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    try {
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      const send = loopback.sendRequest.bind(loopback);
      vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
        if (request.method === VERSIONED_METHOD.textDelete) {
          throw { wireError: { code: code === "file-locked" ? "OVERLOADED" : "INTERNAL", message: code, retry: code === "file-locked" ? "afterBackoff" : "no" } };
        }
        return send(request);
      });
      await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id }))
        .rejects.toMatchObject({ name: "RestoreLocalChangesError", message });
      expect(await readText(root, "new.md")).toBe("recipient text\n");
      expect((await engine.listMoments()).moments.some(moment => moment.operation === "delete")).toBe(false);
    } finally { await engine.stop(); }
  });

  it("guarded Undo recreates a removed record with its original identity and History", async () => {
    const root = await createTestScratch("dohc-engine-undo-");
    await write(root, "new.md", "recipient text\n");
    const requests: Request[] = [];
    const engine = capture(root, new VersionedLoopbackEngine(), requests);
    engine.start();
    try {
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      const removed = await engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id });
      expect(existsSync(join(root, "new.md"))).toBe(false);
      const undone = await engine.restoreFileToBeforeMoment(removed.restoredMomentId, RESTORER, { expectedHeadMomentId: removed.restoredMomentId });
      expect(await readText(root, "new.md")).toBe("recipient text\n");
      const moments = (await engine.listMoments()).moments;
      expect(moments).toHaveLength(3);
      expect(moments[0]).toMatchObject({ id: undone.restoredMomentId, objectId: created.objectId, operation: "write", authors: [RESTORER] });
      expect(requests.filter(request => request.method === VERSIONED_METHOD.textWrite).at(-1)?.params)
        .toMatchObject({ createOnly: true, restoreBeforeMomentId: removed.restoredMomentId, publish: true });
    } finally { await engine.stop(); }
  });

  it("Undo recreates a removed record only while the path is still absent", async () => {
    const root = await createTestScratch("dohc-engine-undo-");
    await write(root, "new.md", "recipient text\n");
    const engine = capture(root, new VersionedLoopbackEngine());
    engine.start();
    try {
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      const removed = await engine.restoreFileToBeforeMoment(created.id, RESTORER, {expectedHeadMomentId: created.id});
      await write(root, "new.md", "Owner text KEEP\n");
      await expect(engine.restoreFileToBeforeMoment(removed.restoredMomentId, RESTORER, {expectedHeadMomentId: removed.restoredMomentId})).rejects.toThrow(RestoreLocalChangesError);
      expect(await readText(root, "new.md")).toBe("Owner text KEEP\n");
    } finally {await engine.stop();}
  });

  it("reports a moved History head before attributing disk differences to this device", async () => {
    const root = await createTestScratch("dohc-engine-head-");
    await write(root, "new.md", "recipient text\n");
    const engine = capture(root, new VersionedLoopbackEngine());
    engine.start();
    try {
      await engine.flush();
      const head = (await engine.listMoments()).moments[0]!;
      await write(root, "new.md", "sync revision\n");
      engine.observeFileEvents([{path: "new.md", operation: "update"}]);
      await engine.flush();
      await expect(engine.restoreFileToBeforeMoment(head.id, RESTORER, {expectedHeadMomentId: head.id})).rejects.toThrow(RestoreHeadChangedError);
      expect(await readText(root, "new.md")).toBe("sync revision\n");
    } finally {await engine.stop();}
  });

  it.each(["created", "edited"] as const)("keeps current disk content that differs from the planned %s head", async kind => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "new.md", "recipient text\n");
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback, requests);
    engine.start();
    try {
      await engine.flush();
      if (kind === "edited") {
        await write(root, "new.md", "recipient revision\n");
        engine.observeFileEvents([{ path: "new.md", operation: "update" }]);
        await engine.flush();
      }
      const head = (await engine.listMoments()).moments[0]!;
      const send = loopback.sendRequest.bind(loopback);
      vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
        if (request.method === VERSIONED_METHOD.momentsGet) await write(root, "new.md", "Owner text KEEP\n");
        return send(request);
      });
      const before = requests.length;
      await expect(engine.restoreFileToBeforeMoment(head.id, RESTORER, { expectedHeadMomentId: head.id }))
        .rejects.toThrow(RestoreLocalChangesError);
      expect(await readText(root, "new.md")).toBe("Owner text KEEP\n");
      expect(requests.slice(before).some(request => request.method === VERSIONED_METHOD.textDelete || request.method === VERSIONED_METHOD.textWrite)).toBe(false);
    } finally { await engine.stop(); }
  });

  it.each(["EBUSY", "EACCES", "EMFILE"])("keeps a file for review when retained draft recovery has a %s read failure", async code => {
    const root = await createTestScratch("dohc-engine-restore-");
    const recovery = await createTestScratch("dohc-engine-recovery-");
    await write(root, "new.md", "recipient text\n");
    const engine = capture(root, new VersionedLoopbackEngine(), undefined,
      (path, objectId) => hasRetainedLiveDraft(recovery, "engine-restore-test", path, objectId));
    const doc = new Y.Doc();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    engine.start();
    try {
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      if (!created.objectId) throw new Error("Expected a file object");
      doc.getText("plainText").insert(0, "unseen typing");
      await preserveUnsentLiveDraft(recovery, "engine-restore-test", {path: "new.md", objectId: created.objectId, contentKind: "plaintext", doc});
      vi.mocked(readFile).mockImplementation((async (path, options) => {
        if (String(path).startsWith(recovery)) throw Object.assign(new Error("temporary recovery read failure"), {code});
        return actual.readFile(path, options);
      }) as typeof readFile);
      await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id }))
        .rejects.toThrow("Could not check saved drafts on this device. Try again.");
      expect(await readText(root, "new.md")).toBe("recipient text\n");
    } finally {vi.mocked(readFile).mockImplementation(actual.readFile); doc.destroy(); await engine.stop();}
  });

  it("keeps a recipient-created file with a retained live draft outside History", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "new.md", "recipient text\n");
    const requests: Request[] = [];
    const draft = vi.fn(async () => true);
    const engine = capture(root, new VersionedLoopbackEngine(), requests, draft);
    engine.start();
    try {
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id }))
        .rejects.toThrow("Changed on this device since the last saved version");
      expect(await readText(root, "new.md")).toBe("recipient text\n");
      expect(requests.some(request => request.method === VERSIONED_METHOD.textDelete)).toBe(false);
    } finally { await engine.stop(); }
  });

  it("refuses deletion when current bytes change after the History check", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "new.md", "recipient text\n");
    const loopback = new VersionedLoopbackEngine();
    const sessions = mockDaemonSessions({ rootPath: root, workspaceId: "engine-restore-test", loopback,
      beforeRequest: async request => {
        if (request.method === VERSIONED_METHOD.textDelete) await write(root, "new.md", "Owner text KEEP\n");
      },
    });
    const engine = createWorkspaceEngineCapture({ workspaceId: "engine-restore-test", rootPath: root,
      attachmentId: Symbol("test"), rustEngineSessions: sessions });
    engine.start();
    try {
      await engine.flush();
      const created = (await engine.listMoments()).moments[0]!;
      await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id }))
        .rejects.toThrow("Changed on this device since the last saved version");
      expect(await readText(root, "new.md")).toBe("Owner text KEEP\n");
      expect((await engine.listMoments()).moments.some(moment => moment.operation === "delete")).toBe(false);
    } finally { await engine.stop(); }
  });

  it("restores a file to before a moment: forward moment, disk write, no re-capture", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "original\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments();
    const editMoment = page.moments[0];
    const result = await engine.restoreFileToBeforeMoment(editMoment.id, RESTORER);
    expect(result.restored).toBe("text");
    expect(result.path).toBe("doc.md");
    expect(await readText(root, "doc.md")).toBe("original\n");

    // Forward history: the restore is a new moment on top, nothing rewritten.
    const after = await engine.listMoments();
    expect(after.moments.length).toBe(page.moments.length + 1);
    expect(after.moments[0].id).toBe(result.restoredMomentId);
    expect(after.moments[0].metadata.summary).toBe("Restored doc.md");
    expect(after.moments[0].metadata.origin).toBe("restore");
    // The restore names who made it; the edit it undid stays outside capture's.
    expect(after.moments[0].authors).toEqual([RESTORER]);
    expect(after.moments[1].authors).toBeUndefined();

    // The watcher's observation of our own materialized write consumes the
    // registered expected event instead of re-capturing a duplicate moment.
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    expect((await engine.listMoments()).moments.length).toBe(after.moments.length);
    await engine.stop();
  });

  it("captures an unsaved disk edit before restoring so nothing is lost", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "original\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const editMomentId = (await engine.listMoments()).moments[0].id;

    // A newer edit is still inside the settle window (never captured).
    await write(root, "doc.md", "uncaptured newest\n");
    await engine.restoreFileToBeforeMoment(editMomentId, RESTORER);

    expect(await readText(root, "doc.md")).toBe("original\n");
    const moments = (await engine.listMoments()).moments;
    // Newest first: the restore moment, then the daemon's capture of the
    // unsaved edit, which the restore flushed before it read the file.
    expect(moments[0].metadata.summary).toBe("Restored doc.md");
    expect(moments[0].metadata.origin).toBe("restore");
    // The daemon does not group this capture with the restore. A shared
    // correlationId and a "Saved latest edits" summary were the deleted JS
    // path's own minting.
    expect(moments[1].metadata.origin).toBe("local-file");
    const saved = await engine.readMoment(moments[1].id);
    const savedPayload = saved?.protected === false ? saved.moment.payload : undefined;
    expect(savedPayload?.after.text).toBe("uncaptured newest\n");
    await engine.stop();
  });

  it("does not record a delete when a replace empties the name as the restore reads it", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "original\n");
    const loopback = new VersionedLoopbackEngine();
    const hidden = join(root, ".dohc", "engine", "displaced", "646f63.0");
    await mkdir(dirname(hidden), { recursive: true });
    let armed = false;
    const engine = createWorkspaceEngineCapture({
      workspaceId: "engine-restore-test",
      rootPath: root,
      attachmentId: Symbol("test-workspace-attachment"),
      rustEngineSessions: mockDaemonSessions({
        rootPath: root,
        workspaceId: "engine-restore-test",
        loopback,
        // The restore's own flush sees the file; right after it, the engine
        // moves it aside to replace it, so the restore reads an empty name.
        afterRequest: async (request) => {
          if (armed && request.method === "capture.flush") {
            armed = false;
            await rename(join(root, "doc.md"), hidden);
          }
        },
        // By the time the delete reaches the engine, the replace is done.
        beforeRequest: async (request) => {
          const params = request.params as { onlyIfAbsentOnDisk?: boolean } | undefined;
          if (request.method === VERSIONED_METHOD.textDelete && params?.onlyIfAbsentOnDisk) {
            await writeFile(join(root, "doc.md"), "replaced\n");
          }
        },
      }),
    });
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const editMomentId = (await engine.listMoments()).moments[0].id;

    armed = true;
    await engine.restoreFileToBeforeMoment(editMomentId, RESTORER);

    expect(await readText(root, "doc.md")).toBe("original\n");
    const moments = (await engine.listMoments()).moments;
    expect(moments.map((moment) => moment.operation)).not.toContain("delete");
    const saved = await engine.readMoment(moments[1].id);
    const savedPayload = saved?.protected === false ? saved.moment.payload : undefined;
    expect(savedPayload?.after.text).toBe("replaced\n");
    await engine.stop();
  });

  it("restoring to before a create removes the file; undo brings it back", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "new.md", "created\n");
    engine.observeFileEvents([{ path: "new.md", operation: "update" }]);
    await engine.flush();
    const createMomentId = (await engine.listMoments()).moments[0].id;

    const restore = await engine.restoreFileToBeforeMoment(createMomentId, RESTORER);
    expect(restore.restored).toBe("deleted");
    expect(existsSync(join(root, "new.md"))).toBe(false);
    const authorsOf = async (momentId: string) =>
      (await engine.listMoments()).moments.find((moment) => moment.id === momentId)?.authors;
    expect(await authorsOf(restore.restoredMomentId)).toEqual([RESTORER]);

    // Undo = restore to before the restore moment (forward again).
    const undo = await engine.restoreFileToBeforeMoment(restore.restoredMomentId, RESTORER);
    expect(undo.restored).toBe("text");
    expect(await readText(root, "new.md")).toBe("created\n");
    expect(await authorsOf(undo.restoredMomentId)).toEqual([RESTORER]);
    await engine.stop();
  });

  it("lists a file's moments after one, and restores only while the expected moment is newest", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "original\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const edit = (await engine.listMoments()).moments[0]!;
    const objectId = (await engine.fileObjectIdForPath("doc.md"))!;
    await expect(engine.listObjectMomentsAfter(objectId, edit.id)).resolves.toEqual([]);

    // A change on disk the engine has not recorded yet is recorded first,
    // and then the file is no longer at the expected moment.
    await write(root, "doc.md", "someone else\n");
    await expect(engine.restoreFileToBeforeMoment(edit.id, RESTORER, { expectedHeadMomentId: edit.id }))
      .rejects.toBeInstanceOf(RestoreHeadChangedError);
    expect(await readText(root, "doc.md")).toBe("someone else\n");
    const after = await engine.listObjectMomentsAfter(objectId, edit.id);
    expect(after).toHaveLength(1);

    const restore = await engine.restoreFileToBeforeMoment(edit.id, RESTORER, { expectedHeadMomentId: after[0]! });
    expect(await readText(root, "doc.md")).toBe("original\n");
    await expect(engine.listObjectMomentsAfter(objectId, edit.id)).resolves.toEqual([restore.restoredMomentId, after[0]]);
    await engine.stop();
  });

  it("checks the History head even when an exported settlement leaves the snapshot unchanged", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "original\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const edit = (await engine.listMoments()).moments[0]!;

    const send = loopback.sendRequest.bind(loopback);
    let exportId = "exported-settlement";
    vi.spyOn(loopback, "sendRequest").mockImplementation(async request => {
      const params = request.params;
      if (request.method === VERSIONED_METHOD.momentsGet && params && typeof params === "object" && !Array.isArray(params)
        && params.momentId === exportId) {
        const response = await send({ ...request, params: { ...params, momentId: edit.id } });
        const result = response.result;
        if (result && typeof result === "object" && !Array.isArray(result)) {
          return { ...response, result: { ...result, momentId: exportId, syncRecordOnly: true } };
        }
        return response;
      }
      const response = await send(request);
      if (request.method !== VERSIONED_METHOD.momentsList) return response;
      const page = response.result;
      if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.moments)) {
        throw new Error("Expected a moments page");
      }
      const newest = page.moments[0];
      if (!newest || typeof newest !== "object" || Array.isArray(newest)) {
        throw new Error("Expected a History moment");
      }
      return { ...response, result: { ...page, moments: [{ ...newest, momentId: exportId, syncRecordOnly: true }] } };
    });

    await expect(engine.restoreFileToBeforeMoment(edit.id, RESTORER, { expectedHeadMomentId: edit.id }))
      .rejects.toBeInstanceOf(RestoreHeadChangedError);
    expect(await readText(root, "doc.md")).toBe("edited\n");
    exportId = "later-persons-settlement";
    await expect(engine.restoreFileToBeforeMoment(edit.id, RESTORER, { expectedHeadMomentId: "exported-settlement" }))
      .rejects.toBeInstanceOf(RestoreHeadChangedError);
    await engine.restoreFileToBeforeMoment(edit.id, RESTORER, { expectedHeadMomentId: exportId });
    expect(await readText(root, "doc.md")).toBe("original\n");
    await engine.stop();
  });

  it("removes a created file only while nothing else is in its folder, checked in the queue", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "keep.md", "keep\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "ideas/collection.yaml", "name: Ideas\n");
    engine.observeFileEvents([{ path: "ideas/collection.yaml", operation: "update" }]);
    await engine.flush();
    const created = (await engine.listMoments()).moments[0]!;

    await write(root, "ideas/other.md", "someone else\n");
    await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id, aloneInFolder: true }))
      .rejects.toBeInstanceOf(RestoreFolderInUseError);
    expect(await readText(root, "ideas/collection.yaml")).toBe("name: Ideas\n");

    await rm(join(root, "ideas/other.md"));
    await expect(engine.restoreFileToBeforeMoment(created.id, RESTORER, { expectedHeadMomentId: created.id, aloneInFolder: true }))
      .resolves.toMatchObject({ restored: "deleted" });
    expect(existsSync(join(root, "ideas/collection.yaml"))).toBe(false);
    await engine.stop();
  });

  it("undo of a text restore returns the file to its pre-restore content", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "original\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.observeFileEvents([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const editMomentId = (await engine.listMoments()).moments[0].id;

    const restore = await engine.restoreFileToBeforeMoment(editMomentId, RESTORER);
    expect(await readText(root, "doc.md")).toBe("original\n");
    const undo = await engine.restoreFileToBeforeMoment(restore.restoredMomentId, RESTORER);
    expect(undo.restored).toBe("text");
    expect(await readText(root, "doc.md")).toBe("edited\n");
    await engine.stop();
  });

  it("rejects restoring a moment that belongs to another version", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "plan.md", "main body\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    const mainMomentId = (await engine.listMoments()).moments[0].id;
    await engine.createVersion("Draft");

    await expect(engine.restoreFileToBeforeMoment(mainMomentId, RESTORER)).rejects.toThrow(
      /different version/i,
    );
    await engine.stop();
  });

  it("rejects unknown moments", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    await expect(
      engine.restoreFileToBeforeMoment("moment_does_not_exist", RESTORER),
    ).rejects.toThrow(/no longer available/i);
    await engine.stop();
  });
});

describe("stable object ids for the linked-chat rail", () => {
  it("resolves object ids from metadata without reading file bodies", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "one.md", "one body\n");
    await write(root, "two.md", "two body\n");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    const engine = capture(root, loopback, requests);
    engine.start();
    await engine.flush();

    const objectId = await engine.fileObjectIdForPath("two.md");
    if (objectId === null) throw new Error("Expected a captured object id.");
    requests.length = 0;

    expect(await engine.filePathForObjectId(objectId)).toBe("two.md");
    expect(await engine.filePathForObjectId("missing-object-id")).toBeNull();
    expect(requests.map((request) => request.method)).toContain("files.resolve");
    expect(requests.map((request) => request.method)).not.toContain(
      VERSIONED_METHOD.textList,
    );
    expect(requests.map((request) => request.method)).not.toContain(
      VERSIONED_METHOD.textRead,
    );
    await engine.stop();
  });

  it("resolves a path to its engine object id and null for untracked paths", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "doc.md", "body\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();

    const objectId = await engine.fileObjectIdForPath("doc.md");
    expect(objectId).not.toBeNull();
    expect(await engine.fileObjectIdForPath("missing.md")).toBeNull();
    await engine.stop();
  });

  it("preserves the object id across an engine-coordinated rename", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "before.md", "body\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    const objectId = await engine.fileObjectIdForPath("before.md");
    expect(objectId).not.toBeNull();

    const finish = await engine.beginFileRename("before.md", "after.md");
    await rename(join(root, "before.md"), join(root, "after.md"));
    await finish(true);

    expect(await engine.fileObjectIdForPath("after.md")).toBe(objectId);
    expect(await engine.fileObjectIdForPath("before.md")).toBeNull();

    // The watcher's observation of the move consumes the registered expected
    // events instead of retiring the object and creating a fresh one.
    const before = (await engine.listMoments()).moments.length;
    engine.observeFileEvents([
      { path: "before.md", operation: "delete" },
      { path: "after.md", operation: "update" },
    ]);
    await engine.flush();
    expect((await engine.listMoments()).moments.length).toBe(before);
    expect(await engine.fileObjectIdForPath("after.md")).toBe(objectId);
    await engine.stop();
  });

  it("rolls the engine rename back when the disk move fails", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    await write(root, "before.md", "body\n");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();
    const objectId = await engine.fileObjectIdForPath("before.md");
    // Without this, the rollback claim below reduces to null === null on a
    // starved store — the same vacuity the sibling rename test avoids.
    expect(objectId).not.toBeNull();

    const finish = await engine.beginFileRename("before.md", "after.md");
    // Disk move failed; roll back.
    await finish(false);

    expect(await engine.fileObjectIdForPath("before.md")).toBe(objectId);
    expect(await engine.fileObjectIdForPath("after.md")).toBeNull();
    await engine.stop();
  });

  it("returns a no-op finisher for non-engine-owned renames", async () => {
    const root = await createTestScratch("dohc-engine-restore-");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, loopback);
    engine.start();
    await engine.flush();

    // Never tracked (no such engine file): nothing to coordinate.
    const finish = await engine.beginFileRename("nope.md", "still-nope.md");
    await finish(true);
    expect((await engine.listMoments()).moments).toHaveLength(0);

    // Secret destination: the engine never records a rename into it.
    await write(root, "tracked.md", "body\n");
    engine.observeFileEvents([{ path: "tracked.md", operation: "update" }]);
    await engine.flush();
    const before = (await engine.listMoments()).moments.length;
    const finishSecret = await engine.beginFileRename("tracked.md", ".env");
    await finishSecret(true);
    expect((await engine.listMoments()).moments.length).toBe(before);
    await engine.stop();
  });
});
