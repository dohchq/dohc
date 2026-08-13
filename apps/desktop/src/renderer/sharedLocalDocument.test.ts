import { describe, expect, it, vi } from "vitest";
import { getSharedLocalDocument, localDocumentKey } from "./sharedLocalDocument";

describe("SharedLocalDocument", () => {
  it("shares drafts and advances one write baseline for every consumer", async () => {
    const key = localDocumentKey("ws", "notes.txt", 1);
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
      localDocumentKey("ws", "overlap.txt", 1),
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
      localDocumentKey("ws", "source-owner.txt", 1),
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
      localDocumentKey("ws", "retry-after-error.txt", 1),
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
    const key = localDocumentKey("ws", "clean.txt", 1);
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

  it("reports a dirty draft that has no write baseline", async () => {
    const buffer = getSharedLocalDocument(
      localDocumentKey("ws", "no-baseline.txt", 1),
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
    const buffer = getSharedLocalDocument(localDocumentKey("ws", "conflict.txt", 1));
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
    const buffer = getSharedLocalDocument(localDocumentKey("ws", "ordered.txt", 1));
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
      localDocumentKey("ws", "refused-newer-read.txt", 1),
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
      localDocumentKey("ws", "fallback.txt", 1),
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
    const first = getSharedLocalDocument(localDocumentKey("ws-a", "a.txt", 1));
    const otherWorkspace = getSharedLocalDocument(
      localDocumentKey("ws-b", "a.txt", 1),
    );
    const otherVersion = getSharedLocalDocument(
      localDocumentKey("ws-a", "a.txt", 2),
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
    const buffer = getSharedLocalDocument(localDocumentKey("ws", "a.md", 2));
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
