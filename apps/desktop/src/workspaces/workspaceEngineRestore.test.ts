import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "./testTemp";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";

// PR 0M-5: engine history reads (active-version timeline + one-moment
// payloads), engine-routed restore (forward history, expected-event
// registration, disk materialization, undo), the stable-object-id seam for
// the linked-chat rail, and engine-coordinated renames.

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-restore-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function write(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readText(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

function capture(root: string): WorkspaceEngineCapture {
  return createWorkspaceEngineCapture({
    workspaceId: "engine-restore-test",
    rootPath: root,
  });
}

describe("engine history reads", () => {
  it("lists the active version's moments newest first and reads one payload", async () => {
    const root = await tempRoot();
    await write(root, "a.md", "first\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await write(root, "a.md", "second\n");
    engine.captureBatch([{ path: "a.md", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments();
    expect(page.activeVersionId).toBe("main");
    expect(page.moments).toHaveLength(2);
    expect(page.moments[0].recordedAtMs).toBeGreaterThanOrEqual(
      page.moments[1].recordedAtMs,
    );
    expect(page.nextBeforeMomentOrder).toBeNull();

    const detail = await engine.readMoment(page.moments[0].id);
    expect(detail?.payload.before?.text).toBe("first\n");
    expect(detail?.payload.after.text).toBe("second\n");
    await engine.stop();
  });

  it("scopes the timeline to the active version after a switch", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "main body\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await engine.createVersion("Draft");
    await write(root, "plan.md", "draft body\n");
    engine.captureBatch([{ path: "plan.md", operation: "update" }]);
    await engine.flush();

    const draftPage = await engine.listMoments();
    expect(draftPage.activeVersionId).not.toBe("main");
    expect(
      draftPage.moments.every((moment) => moment.versionId === draftPage.activeVersionId),
    ).toBe(true);
    await engine.stop();
  });
});

describe("engine restore", () => {
  it("restores a file to before a moment: forward moment, disk write, no re-capture", async () => {
    const root = await tempRoot();
    await write(root, "doc.md", "original\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.captureBatch([{ path: "doc.md", operation: "update" }]);
    await engine.flush();

    const page = await engine.listMoments();
    const editMoment = page.moments[0];
    const result = await engine.restoreFileToBeforeMoment(editMoment.id);
    expect(result.restored).toBe("text");
    expect(result.path).toBe("doc.md");
    expect(await readText(root, "doc.md")).toBe("original\n");

    // Forward history: the restore is a NEW moment on top, nothing rewritten.
    const after = await engine.listMoments();
    expect(after.moments.length).toBe(page.moments.length + 1);
    expect(after.moments[0].id).toBe(result.restoredMomentId);
    expect(after.moments[0].metadata.summary).toBe("Restored doc.md");
    expect(after.moments[0].metadata.origin).toBe("restore");

    // The watcher's observation of our own materialized write consumes the
    // registered expected event instead of re-capturing a duplicate moment.
    engine.captureBatch([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    expect((await engine.listMoments()).moments.length).toBe(after.moments.length);
    await engine.stop();
  });

  it("captures an unsaved disk edit before restoring so nothing is lost", async () => {
    const root = await tempRoot();
    await write(root, "doc.md", "original\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.captureBatch([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const editMomentId = (await engine.listMoments()).moments[0].id;

    // A newer edit is still inside the settle window (never captured).
    await write(root, "doc.md", "uncaptured newest\n");
    await engine.restoreFileToBeforeMoment(editMomentId);

    expect(await readText(root, "doc.md")).toBe("original\n");
    const moments = (await engine.listMoments()).moments;
    // Newest first: restore moment, then the pre-restore save.
    expect(moments[0].metadata.summary).toBe("Restored doc.md");
    expect(moments[1].metadata.summary).toBe("Saved latest edits");
    expect(moments[0].metadata.correlationId).toBe(moments[1].metadata.correlationId);
    const saved = await engine.readMoment(moments[1].id);
    expect(saved?.payload.after.text).toBe("uncaptured newest\n");
    await engine.stop();
  });

  it("restoring to before a create removes the file; undo brings it back", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await write(root, "new.md", "created\n");
    engine.captureBatch([{ path: "new.md", operation: "update" }]);
    await engine.flush();
    const createMomentId = (await engine.listMoments()).moments[0].id;

    const restore = await engine.restoreFileToBeforeMoment(createMomentId);
    expect(restore.restored).toBe("deleted");
    expect(existsSync(join(root, "new.md"))).toBe(false);

    // Undo = restore to before the restore moment (forward again).
    const undo = await engine.restoreFileToBeforeMoment(restore.restoredMomentId);
    expect(undo.restored).toBe("text");
    expect(await readText(root, "new.md")).toBe("created\n");
    await engine.stop();
  });

  it("undo of a text restore returns the file to its pre-restore content", async () => {
    const root = await tempRoot();
    await write(root, "doc.md", "original\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await write(root, "doc.md", "edited\n");
    engine.captureBatch([{ path: "doc.md", operation: "update" }]);
    await engine.flush();
    const editMomentId = (await engine.listMoments()).moments[0].id;

    const restore = await engine.restoreFileToBeforeMoment(editMomentId);
    expect(await readText(root, "doc.md")).toBe("original\n");
    const undo = await engine.restoreFileToBeforeMoment(restore.restoredMomentId);
    expect(undo.restored).toBe("text");
    expect(await readText(root, "doc.md")).toBe("edited\n");
    await engine.stop();
  });

  it("rejects restoring a moment that belongs to another version", async () => {
    const root = await tempRoot();
    await write(root, "plan.md", "main body\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    const mainMomentId = (await engine.listMoments()).moments[0].id;
    await engine.createVersion("Draft");

    await expect(engine.restoreFileToBeforeMoment(mainMomentId)).rejects.toThrow(
      /different version/i,
    );
    await engine.stop();
  });

  it("rejects unknown moments", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    engine.start();
    await engine.flush();
    await expect(
      engine.restoreFileToBeforeMoment("moment_does_not_exist"),
    ).rejects.toThrow(/no longer available/i);
    await engine.stop();
  });
});

describe("stable object ids for the linked-chat rail", () => {
  it("resolves a path to its engine object id and null for untracked paths", async () => {
    const root = await tempRoot();
    await write(root, "doc.md", "body\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();

    const objectId = await engine.fileObjectIdForPath("doc.md");
    expect(objectId).not.toBeNull();
    expect(await engine.fileObjectIdForPath("missing.md")).toBeNull();
    await engine.stop();
  });

  it("preserves the object id across an engine-coordinated rename", async () => {
    const root = await tempRoot();
    await write(root, "before.md", "body\n");
    const engine = capture(root);
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
    engine.captureBatch([
      { path: "before.md", operation: "delete" },
      { path: "after.md", operation: "update" },
    ]);
    await engine.flush();
    expect((await engine.listMoments()).moments.length).toBe(before);
    expect(await engine.fileObjectIdForPath("after.md")).toBe(objectId);
    await engine.stop();
  });

  it("rolls the engine rename back when the disk move fails", async () => {
    const root = await tempRoot();
    await write(root, "before.md", "body\n");
    const engine = capture(root);
    engine.start();
    await engine.flush();
    const objectId = await engine.fileObjectIdForPath("before.md");

    const finish = await engine.beginFileRename("before.md", "after.md");
    // Disk move failed; roll back.
    await finish(false);

    expect(await engine.fileObjectIdForPath("before.md")).toBe(objectId);
    expect(await engine.fileObjectIdForPath("after.md")).toBeNull();
    await engine.stop();
  });

  it("returns a no-op finisher for non-engine-owned renames", async () => {
    const root = await tempRoot();
    const engine = capture(root);
    engine.start();
    await engine.flush();

    // Never tracked (no such engine file): nothing to coordinate.
    const finish = await engine.beginFileRename("nope.md", "still-nope.md");
    await finish(true);
    expect((await engine.listMoments()).moments).toHaveLength(0);

    // Secret destination: the engine never records a rename into it.
    await write(root, "tracked.md", "body\n");
    engine.captureBatch([{ path: "tracked.md", operation: "update" }]);
    await engine.flush();
    const before = (await engine.listMoments()).moments.length;
    const finishSecret = await engine.beginFileRename("tracked.md", ".env");
    await finishSecret(true);
    expect((await engine.listMoments()).moments.length).toBe(before);
    await engine.stop();
  });
});
