import { describe, expect, it, vi } from "vitest";
import { ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { createReceivedShareRecord } from "./receivedShareRecordCreation";
import type { ShareViewFiles, ShareViewFilesTarget, ResolvedShareViewFilesTarget } from "./shareViewFiles";
import type { WorkspaceOperationLease } from "./workspaceAssets";

const selector = { paths: ["trip"], versionId: null, access: "edit" as const };
const id = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
function fixture() {
  const texts = new Map([["trip/Tasks/collection.yaml", "name: Tasks\nfields: {}\n"]]);
  const target: ShareViewFilesTarget = { kind: "standalone", workspaceId: "recipient" };
  const resolved: ResolvedShareViewFilesTarget = { ...target, storeWorkspaceId: "recipient", rootPath: "C:/draft",
    schedulingRootPath: "C:/draft", shareId: "share", granterEmail: "owner@test", grantedSelector: selector, ended: false };
  const read: ShareViewFiles["read"] = vi.fn(async (_target, input) => {
    const text = texts.get(input.path);
    if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { kind: "text" as const, text, truncated: false as const, contentHash: "a".repeat(64) };
  });
  const change: ShareViewFiles["change"] = vi.fn(async (_lease, _target, input) => {
    if (input.kind !== "create") throw new Error("Expected create");
    texts.set(input.path, input.initialText);
    return { status: "committed" as const, kind: "create" as const, value: input.path, projection: "current" as const };
  });
  return { texts, host: { target, resolved, collectionPath: "trip/Tasks", files: { read, change },
    checkAuthority: vi.fn<() => Promise<typeof selector | null>>(async () => selector), assertCurrent: vi.fn(),
    recordStatus: vi.fn(async (_path: string): Promise<{ state: "pending" | "accepted" | "refused"; originalRecordId?: string } | null> => null),
    withLease: <T>(work: (lease: WorkspaceOperationLease) => Promise<T>) => work({} as WorkspaceOperationLease), shareViewEdited: vi.fn() } };
}
const input = { workspaceId: "recipient", collectionPath: "trip/Tasks", name: "One", recordId: id };

describe("received-share record drafts", () => {
  it("journals a valid identity and never needs capture, disk writes, or a local author", async () => {
    const f = fixture();
    expect(await createReceivedShareRecord(input, f.host)).toEqual({ path: "trip/Tasks/One.md", recordId: id, delivery: "pending" });
    expect(f.host.files.change).toHaveBeenCalledWith({}, f.host.target, {
      kind: "create", path: "trip/Tasks/One.md", initialText: `---\nid: ${id}\n---\n`,
    });
    expect(f.host.shareViewEdited).toHaveBeenCalledOnce();
  });

  it("keeps an offline draft and retries the same journaled file after reopening", async () => {
    const f = fixture();
    f.host.checkAuthority = vi.fn(async () => null) as typeof f.host.checkAuthority;
    await createReceivedShareRecord(input, f.host);
    // A fresh handler sees the same durable canonical files after restart.
    const reopened = { ...f.host, shareViewEdited: vi.fn() };
    expect(await createReceivedShareRecord(input, reopened)).toMatchObject({ recordId: id, delivery: "pending" });
    expect(f.host.files.change).toHaveBeenCalledOnce();
    expect(reopened.shareViewEdited).toHaveBeenCalledOnce();
  });

  it("refuses ended access, live revocation, scope loss, and stale operations before staging", async () => {
    for (const refusal of ["ended", "revoked", "scope", "stale"] as const) {
      const f = fixture();
      if (refusal === "ended") f.host.resolved.ended = true;
      if (refusal === "revoked") f.host.checkAuthority.mockRejectedValue(new ShareUnavailableError());
      if (refusal === "scope") f.host.checkAuthority.mockResolvedValue({ ...selector, paths: ["private"] });
      if (refusal === "stale") f.host.assertCurrent.mockImplementation(() => { throw new Error("stale workspace"); });
      await expect(createReceivedShareRecord(input, f.host)).rejects.toThrow();
      expect(f.host.files.change).not.toHaveBeenCalled();
    }
  });

  it("refuses a name held by another identity, invalid names, and a non-document Collection", async () => {
    const f = fixture();
    f.texts.set("trip/Tasks/One.md", "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n");
    await expect(createReceivedShareRecord(input, f.host)).rejects.toThrow("already exists");
    await expect(createReceivedShareRecord({ ...input, name: "../escape" }, f.host)).rejects.toThrow("plain file name");
    f.texts.set("trip/Tasks/collection.yaml", "broken: [");
    await expect(createReceivedShareRecord({ ...input, name: "Two" }, f.host)).rejects.toThrow("document schema");
    expect(f.host.files.change).not.toHaveBeenCalled();
  });

  it("chooses a free local name for a fresh creation", async () => {
    const f = fixture();
    f.texts.set("trip/Tasks/One.md", "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n");
    expect(await createReceivedShareRecord({ ...input, recordId: undefined }, f.host)).toMatchObject({ path: "trip/Tasks/One 2.md" });
  });

  it("returns the owner's repaired identity only for this draft's original creation", async () => {
    const f = fixture(), repaired = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    f.texts.set("trip/Tasks/One.md", `---\nid: ${repaired}\n---\n`);
    f.host.recordStatus.mockResolvedValue({ state: "accepted", originalRecordId: id });
    expect(await createReceivedShareRecord(input, f.host)).toMatchObject({ recordId: repaired, delivery: "accepted" });
    expect(f.host.files.change).not.toHaveBeenCalled();
  });

  it.each(["accepted", "refused"] as const)("keeps a known %s receipt when retrying the same record", async state => {
    const f = fixture();
    await createReceivedShareRecord(input, f.host);
    f.host.recordStatus.mockResolvedValue({ state, originalRecordId: id });
    expect(await createReceivedShareRecord(input, f.host)).toMatchObject({ recordId: id, delivery: state });
    expect(f.host.files.change).toHaveBeenCalledOnce();
  });

  it("does not treat a refused creation replaced by another recipient as an owner repair", async () => {
    const f = fixture();
    f.texts.set("trip/Tasks/One.md", "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n");
    f.host.recordStatus.mockResolvedValue({ state: "refused", originalRecordId: id });
    await expect(createReceivedShareRecord(input, f.host)).rejects.toThrow("already exists");
    expect(f.host.files.change).not.toHaveBeenCalled();
  });

  it("does not mistake invalid current frontmatter for an owner repair", async () => {
    const f = fixture();
    f.texts.set("trip/Tasks/One.md", "---\nid: invalid\n---\n");
    f.host.recordStatus.mockResolvedValue({ state: "accepted", originalRecordId: id });
    await expect(createReceivedShareRecord(input, f.host)).rejects.toThrow("already exists");
  });
});
