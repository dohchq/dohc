import { describe, expect, it, vi } from "vitest";
import {
  acquireSharedLocalDocument,
  getSharedLocalDocument,
} from "./sharedLocalDocument";
import { documentVersionKey } from "./documentVersionKey";

describe("SharedLocalDocument", () => {
  it("keeps one mapped identity until an unused lazy draft finishes writing", async () => {
    const key = documentVersionKey("ws", "pending-unmount.md", 1);
    const buffer = getSharedLocalDocument(key);
    const release = buffer.retain();
    const source = {};
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.setPendingDraft({ source, materialize: () => "after" });

    release();
    const replacement = acquireSharedLocalDocument(key);

    expect(replacement.buffer).toBe(buffer);
    expect(replacement.buffer.materializePendingDraft()).toBe("after");
    const written = replacement.buffer.write({}, async () => ({
      status: "written",
      contentHash: "hash-2",
    }));
    replacement.release();
    await written;

    const afterWrite = acquireSharedLocalDocument(key);
    expect(afterWrite.buffer).not.toBe(buffer);
    afterWrite.release();
  });

  it("removes an unused clean identity after its lazy draft is cleared", () => {
    const key = documentVersionKey("ws", "cleared-unmount.md", 1);
    const buffer = getSharedLocalDocument(key);
    const release = buffer.retain();
    const source = {};
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.setPendingDraft({ source, materialize: () => "after" });

    release();
    buffer.clearPendingDraft(source);

    const replacement = acquireSharedLocalDocument(key);
    expect(replacement.buffer).not.toBe(buffer);
    replacement.release();
  });

  it("waits for the final writer before releasing an unused dirty identity", async () => {
    const key = documentVersionKey("ws", "writer-release.md", 1);
    const buffer = getSharedLocalDocument(key);
    const release = buffer.retain();
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.publishDraft("after", {});
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const writing = buffer.write({}, async () => {
      await writePending;
      return { status: "conflict", currentContentHash: "hash-2" };
    });

    release();
    buffer.releaseUnusedDraft();
    expect(getSharedLocalDocument(key)).toBe(buffer);

    finishWrite();
    await writing;
    expect(getSharedLocalDocument(key)).not.toBe(buffer);
  });

  it("does not release a dirty identity while another pane retains it", () => {
    const key = documentVersionKey("ws", "peer-retained.md", 1);
    const buffer = getSharedLocalDocument(key);
    const releaseUnmountedPane = buffer.retain();
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.publishDraft("first draft", {});
    releaseUnmountedPane();

    const peer = acquireSharedLocalDocument(key);
    buffer.releaseUnusedDraft();
    peer.buffer.publishDraft("peer draft", {});
    peer.release();

    expect(getSharedLocalDocument(key)).toBe(buffer);
  });

  it("acquires one identity while an unmounted writer settles", async () => {
    const key = documentVersionKey("ws", "acquire-race.txt", 1);
    const writingBuffer = getSharedLocalDocument(key);
    const releaseWriter = writingBuffer.retain();
    writingBuffer.initializeRead("before", "hash-1", writingBuffer.beginRead());
    writingBuffer.publishDraft("after", {});
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const writing = writingBuffer.write({}, async () => {
      await writePending;
      return { status: "written", contentHash: "hash-2" };
    });
    releaseWriter();

    const firstPane = acquireSharedLocalDocument(key);
    finishWrite();
    await writing;
    const secondPane = acquireSharedLocalDocument(key);

    expect(secondPane.buffer).toBe(firstPane.buffer);
    firstPane.release();
    secondPane.release();
  });

  it("shares drafts and advances one write baseline for every consumer", async () => {
    const key = documentVersionKey("ws", "notes.txt", 1);
    const first = getSharedLocalDocument(key);
    const second = getSharedLocalDocument(key);
    expect(second).toBe(first);

    const releaseFirst = first.retain();
    const releaseSecond = second.retain();
    first.initializeRead("before", "hash-1", first.beginRead());
    second.publishDraft("after", {});

    const writer = vi.fn().mockResolvedValue({
      status: "written" as const,
      contentHash: "hash-2",
    });
    await first.write({}, writer);

    expect(writer).toHaveBeenCalledWith("after", "hash-1");
    expect(second.getSnapshot()).toMatchObject({
      body: "after",
      contentHash: "hash-2",
      dirty: false,
      saveState: "saved",
    });
    await first.settled();
    releaseFirst();
    releaseSecond();
    expect(getSharedLocalDocument(key)).not.toBe(first);
  });

  it("serializes overlapping saves and writes the newest draft with the new hash", async () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "overlap.txt", 1),
    );
    const release = buffer.retain();
    buffer.initializeRead("zero", "hash-0", buffer.beginRead());
    buffer.publishDraft("one", {});

    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const writes: Array<[string, string]> = [];
    const writer = vi.fn(async (body: string, hash: string) => {
      writes.push([body, hash]);
      if (writes.length === 1) await firstPending;
      return { status: "written" as const, contentHash: `hash-${writes.length}` };
    });

    const first = buffer.write({}, writer);
    buffer.publishDraft("two", {});
    const second = buffer.write({}, writer);
    finishFirst();
    await Promise.all([first, second]);

    expect(writes).toEqual([
      ["one", "hash-0"],
      ["two", "hash-1"],
    ]);
    expect(buffer.getSnapshot()).toMatchObject({
      body: "two",
      contentHash: "hash-2",
      dirty: false,
    });
    release();
  });

  it("keeps a newer peer as the source when an older writer succeeds", async () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "source-owner.txt", 1),
    );
    const release = buffer.retain();
    const writerSource = {};
    const peerSource = {};
    buffer.initializeRead("zero", "hash-0", buffer.beginRead());
    buffer.publishDraft("writer", writerSource);
    let finishWrite!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const writing = buffer.write(writerSource, async () => {
      await pending;
      return { status: "written", contentHash: "hash-1" };
    });
    buffer.publishDraft("peer", peerSource);

    finishWrite();
    await writing;

    expect(buffer.getSnapshot()).toMatchObject({
      body: "peer",
      contentHash: "hash-1",
      dirty: true,
      saveState: "saving",
    });
    expect(buffer.getSnapshot().source).toBe(peerSource);
    release();
  });

  it("recovers after a writer rejects without poisoning later writes", async () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "retry-after-error.txt", 1),
    );
    const release = buffer.retain();
    const source = {};
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.publishDraft("after", source);

    const writeError = new Error("disk unavailable");
    await expect(
      buffer.write(source, vi.fn().mockRejectedValue(writeError)),
    ).rejects.toBe(writeError);
    expect(buffer.getSnapshot()).toMatchObject({
      body: "after",
      contentHash: "hash-1",
      dirty: true,
      saveState: "error",
      source,
    });

    const retryWriter = vi.fn().mockResolvedValue({
      status: "written" as const,
      contentHash: "hash-2",
    });
    await expect(buffer.write(source, retryWriter)).resolves.toMatchObject({
      status: "written",
      body: "after",
      expectedContentHash: "hash-1",
      contentHash: "hash-2",
    });
    await expect(buffer.settled()).resolves.toBeUndefined();
    expect(retryWriter).toHaveBeenCalledWith("after", "hash-1");
    expect(buffer.getSnapshot()).toMatchObject({
      body: "after",
      contentHash: "hash-2",
      dirty: false,
      saveState: "saved",
    });
    release();
  });

  it("keeps a clean buffer saved when a writer has nothing to do", async () => {
    const key = documentVersionKey("ws", "clean.txt", 1);
    const buffer = getSharedLocalDocument(key);
    const release = buffer.retain();
    buffer.initializeRead("clean", "hash-1", buffer.beginRead());
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);
    const writer = vi.fn();

    await expect(buffer.write({}, writer)).resolves.toEqual({
      status: "skipped",
      body: "clean",
      contentHash: "hash-1",
    });

    expect(writer).not.toHaveBeenCalled();
    expect(buffer.getSnapshot()).toMatchObject({
      dirty: false,
      saveState: "saved",
    });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    release();
    expect(getSharedLocalDocument(key)).not.toBe(buffer);
  });

  it("lets only the pending draft owner take its lazy text", () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "pending-owner.md", 1),
    );
    const release = buffer.retain();
    const source = {};
    const otherSource = {};
    const materialize = vi.fn(() => "lazy draft");
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);

    buffer.setPendingDraft({ source, materialize });

    expect(buffer.getPendingDraftSource()).toBe(source);
    expect(buffer.takePendingDraft(otherSource)).toBeNull();
    expect(materialize).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);

    expect(buffer.takePendingDraft(source)).toBe("lazy draft");
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(buffer.getPendingDraftSource()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(buffer.getSnapshot().body).toBe("");

    unsubscribe();
    release();
  });

  it("notifies when materializing a pending draft leaves the snapshot unchanged", () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "pending-same.md", 1),
    );
    const release = buffer.retain();
    const source = {};
    buffer.initializeRead("same", "hash-1", buffer.beginRead());
    buffer.publishDraft("same", source);
    const revision = buffer.getSnapshot().revision;
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);
    buffer.setPendingDraft({ source, materialize: () => "same" });
    listener.mockClear();

    expect(buffer.materializePendingDraft()).toBe("same");

    expect(buffer.getPendingDraftSource()).toBeNull();
    expect(buffer.getSnapshot().revision).toBe(revision);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    release();
  });

  it("refuses an external reread while a lazy draft still owns the clean baseline", () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "pending-read.md", 1),
    );
    const release = buffer.retain();
    const draftSource = {};
    const readSource = {};
    const materialize = vi.fn(() => "local draft");
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.setPendingDraft({ source: draftSource, materialize });

    expect(
      buffer.acceptRead(
        "external",
        "hash-2",
        readSource,
        false,
        buffer.beginRead(),
      ),
    ).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(buffer.getSnapshot()).toMatchObject({
      body: "before",
      contentHash: "hash-1",
      dirty: false,
    });

    expect(buffer.materializePendingDraft()).toBe("local draft");
    expect(buffer.getSnapshot()).toMatchObject({
      body: "local draft",
      contentHash: "hash-1",
      dirty: true,
    });
    release();
  });

  it("lets a forced read replace its own lazy draft without materializing it", () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "pending-own-read.md", 1),
    );
    const release = buffer.retain();
    const source = {};
    const materialize = vi.fn(() => "obsolete draft");
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.setPendingDraft({ source, materialize });
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);

    expect(
      buffer.acceptRead(
        "reconciled",
        "hash-2",
        source,
        true,
        buffer.beginRead(),
      ),
    ).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(buffer.getPendingDraftSource()).toBeNull();
    expect(buffer.getSnapshot()).toMatchObject({
      body: "reconciled",
      contentHash: "hash-2",
      dirty: false,
      saveState: "error",
      source,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    release();
  });

  it("refuses an owned pending read when a peer owns the dirty snapshot", () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "pending-peer-read.md", 1),
    );
    const release = buffer.retain();
    const pendingSource = {};
    const peerSource = {};
    const materialize = vi.fn(() => "pending draft");
    buffer.initializeRead("before", "hash-1", buffer.beginRead());
    buffer.publishDraft("peer draft", peerSource);
    buffer.setPendingDraft({ source: pendingSource, materialize });

    expect(
      buffer.acceptRead(
        "external",
        "hash-2",
        pendingSource,
        true,
        buffer.beginRead(),
      ),
    ).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
    expect(buffer.getPendingDraftSource()).toBe(pendingSource);
    expect(buffer.getSnapshot()).toMatchObject({
      body: "peer draft",
      contentHash: "hash-1",
      dirty: true,
      saveState: "error",
      source: peerSource,
    });

    release();
  });

  it("reports a dirty draft that has no write baseline", async () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "no-baseline.txt", 1),
    );
    const release = buffer.retain();
    buffer.publishDraft("unsaved", {});
    const writer = vi.fn();

    await expect(buffer.write({}, writer)).resolves.toEqual({
      status: "no-baseline",
      body: "unsaved",
    });

    expect(writer).not.toHaveBeenCalled();
    expect(buffer.getSnapshot()).toMatchObject({
      body: "unsaved",
      contentHash: null,
      dirty: true,
      saveState: "error",
    });
    release();
  });

  it("preserves a queued peer draft when a conflict reread is forced", async () => {
    const buffer = getSharedLocalDocument(documentVersionKey("ws", "conflict.txt", 1));
    const release = buffer.retain();
    const writerSource = {};
    const peer = {};
    buffer.initializeRead("disk before", "hash-1", buffer.beginRead());
    buffer.publishDraft("writer draft", writerSource);
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const writing = buffer.write(writerSource, async () => {
      await writePending;
      return { status: "conflict", currentContentHash: "hash-2" };
    });
    buffer.publishDraft("peer draft", peer);
    finishWrite();
    await writing;

    expect(
      buffer.acceptRead("disk after", "hash-2", writerSource, true),
    ).toBe(false);

    expect(buffer.getSnapshot()).toMatchObject({
      body: "peer draft",
      contentHash: "hash-1",
      dirty: true,
      saveState: "error",
    });
    release();
  });

  it("rejects an older shared read after a newer request starts", () => {
    const buffer = getSharedLocalDocument(documentVersionKey("ws", "ordered.txt", 1));
    const release = buffer.retain();
    const older = buffer.beginRead();
    const newer = buffer.beginRead();

    expect(buffer.acceptRead("newer", "hash-2", {}, false, newer)).toBe(true);
    expect(buffer.acceptRead("older", "hash-1", {}, false, older)).toBe(false);
    expect(buffer.getSnapshot()).toMatchObject({
      body: "newer",
      contentHash: "hash-2",
      dirty: false,
    });
    release();
  });

  it("rejects an older read after a newer response was refused while dirty", async () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "refused-newer-read.txt", 1),
    );
    const release = buffer.retain();
    const draftSource = {};
    buffer.reset("before", "hash-0", draftSource);
    const older = buffer.beginRead();
    const newer = buffer.beginRead();
    buffer.publishDraft("written draft", draftSource);

    expect(
      buffer.acceptRead("newer response", "hash-newer", {}, false, newer),
    ).toBe(false);
    await buffer.write(draftSource, async () => ({
      status: "written",
      contentHash: "hash-written",
    }));

    expect(
      buffer.acceptRead("older response", "hash-older", {}, false, older),
    ).toBe(false);
    expect(buffer.getSnapshot()).toMatchObject({
      body: "written draft",
      contentHash: "hash-written",
      dirty: false,
      saveState: "saved",
    });
    release();
  });

  it("initializes from an older successful read when the newer read fails", () => {
    const buffer = getSharedLocalDocument(
      documentVersionKey("ws", "fallback.txt", 1),
    );
    const release = buffer.retain();
    const older = buffer.beginRead();
    buffer.beginRead(); // The later request settles without an accepted read.

    expect(buffer.initializeRead("available", "hash-1", older)).toBe(true);
    expect(buffer.getSnapshot()).toMatchObject({
      initialized: true,
      body: "available",
      contentHash: "hash-1",
      dirty: false,
    });
    release();
  });

  it("isolates the same path across workspaces and version reopen keys", () => {
    const first = getSharedLocalDocument(documentVersionKey("ws-a", "a.txt", 1));
    const otherWorkspace = getSharedLocalDocument(
      documentVersionKey("ws-b", "a.txt", 1),
    );
    const otherVersion = getSharedLocalDocument(
      documentVersionKey("ws-a", "a.txt", 2),
    );
    const releases = [first.retain(), otherWorkspace.retain(), otherVersion.retain()];

    first.initializeRead("first", "hash-a", first.beginRead());
    otherWorkspace.initializeRead(
      "workspace",
      "hash-b",
      otherWorkspace.beginRead(),
    );
    otherVersion.initializeRead("version", "hash-c", otherVersion.beginRead());

    expect(first.getSnapshot().body).toBe("first");
    expect(otherWorkspace.getSnapshot().body).toBe("workspace");
    expect(otherVersion.getSnapshot().body).toBe("version");
    for (const release of releases) release();
  });

  it("replaces a refused switch draft with the authoritative version read", () => {
    const buffer = getSharedLocalDocument(documentVersionKey("ws", "a.md", 2));
    const release = buffer.retain();
    buffer.publishDraft("old-version edit", {});

    buffer.reset("new version", "hash-new", {});

    expect(buffer.getSnapshot()).toMatchObject({
      body: "new version",
      contentHash: "hash-new",
      dirty: false,
      saveState: "saved",
    });
    release();
  });
});
