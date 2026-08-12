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
    first.initialize("before", "hash-1");
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
    buffer.initialize("zero", "hash-0");
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

  it("keeps a clean buffer saved when a writer has nothing to do", async () => {
    const key = localDocumentKey("ws", "clean.txt", 1);
    const buffer = getSharedLocalDocument(key);
    const release = buffer.retain();
    buffer.initialize("clean", "hash-1");
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

  it("isolates the same path across workspaces and version reopen keys", () => {
    const first = getSharedLocalDocument(localDocumentKey("ws-a", "a.txt", 1));
    const otherWorkspace = getSharedLocalDocument(
      localDocumentKey("ws-b", "a.txt", 1),
    );
    const otherVersion = getSharedLocalDocument(
      localDocumentKey("ws-a", "a.txt", 2),
    );
    const releases = [first.retain(), otherWorkspace.retain(), otherVersion.retain()];

    first.initialize("first", "hash-a");
    otherWorkspace.initialize("workspace", "hash-b");
    otherVersion.initialize("version", "hash-c");

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
