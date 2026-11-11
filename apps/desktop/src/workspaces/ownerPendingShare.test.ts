import { describe, expect, it, vi } from "vitest";
import { createOwnerPendingShare, listOwnerPendingSharePaths } from "./ownerPendingShare";

const draft = (objectId: string, currentPath: string, state: "active" | "quarantined" | null = "active", mainVersionId = "main") => ({
  binding: { workspaceId: "workspace", mainVersionId, objectId, lineageClaimId: "a".repeat(64), currentPath, selectorPaths: [currentPath], restoreFenceGeneration: 0 },
  relayDatabaseNamespace: "relay", revision: 1, acceptedCursor: 0, nativeHeadSequence: 1, nativeUnsettled: true,
  outboxId: `outbox-${objectId}`, pendingBytes: 10, state,
});
const cursor = (objectId: string) => ({ mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64) });

function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("listOwnerPendingSharePaths", () => {
  it("lists pending drafts on every page, leaving out frozen drafts and other versions", async () => {
    const pages = [[draft("b", "b.md"), draft("frozen", "frozen.md", "quarantined")], [draft("a", "notes/a.md"), draft("fork", "fork.md", "active", "fork")]];
    const ownerYDocListDrafts = vi.fn(async (_request: unknown, input: { after: unknown; pendingOnly?: boolean }) => {
      const index = input.after === null ? 0 : 1;
      return { drafts: pages[index]!, next: index === 0 ? cursor("frozen") : null };
    });
    expect(await listOwnerPendingSharePaths({ ownerYDocListDrafts } as never, "handle", "main")).toEqual(["b.md", "notes/a.md"]);
    expect(ownerYDocListDrafts.mock.calls.map(call => call[1])).toEqual([
      { after: null, limit: 64, pendingOnly: true }, { after: cursor("frozen"), limit: 64, pendingOnly: true }]);
  });
});

describe("createOwnerPendingShare", () => {
  it("answers lookups from its last read, and reads only when asked to refresh", async () => {
    const read = vi.fn(async () => ["plan.md"]), onChange = vi.fn();
    const pending = createOwnerPendingShare({ read, onChange });
    expect(pending.paths("workspace")).toEqual([]);
    pending.refresh("workspace");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith("workspace"));
    for (let lookup = 0; lookup < 5; lookup++) expect(pending.paths("workspace")).toEqual(["plan.md"]);
    expect(pending.paths("other")).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads once more after a read that changes arrived during, and tells only of a changed answer", async () => {
    const answers = [deferred<string[]>(), deferred<string[]>(), deferred<string[]>()];
    answers[2]!.resolve(["plan.md"]);
    const read = vi.fn(() => answers[read.mock.calls.length - 1]!.promise), onChange = vi.fn();
    const pending = createOwnerPendingShare({ read, onChange });
    pending.refresh("workspace");
    pending.refresh("workspace");
    pending.refresh("workspace");
    answers[0]!.resolve(["plan.md"]);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    answers[1]!.resolve(["plan.md"]);
    await vi.waitFor(() => expect(pending.paths("workspace")).toEqual(["plan.md"]));
    pending.refresh("workspace");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the last answer when a read fails", async () => {
    const read = vi.fn().mockResolvedValueOnce(["plan.md"]).mockRejectedValueOnce(new Error("engine restarting")).mockResolvedValueOnce([]);
    const onChange = vi.fn(), error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pending = createOwnerPendingShare({ read, onChange });
    pending.refresh("workspace");
    await vi.waitFor(() => expect(pending.paths("workspace")).toEqual(["plan.md"]));
    pending.refresh("workspace");
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(pending.paths("workspace")).toEqual(["plan.md"]);
    pending.refresh("workspace");
    await vi.waitFor(() => expect(pending.paths("workspace")).toEqual([]));
    expect(onChange).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
