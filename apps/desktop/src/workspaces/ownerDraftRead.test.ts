import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it, vi } from "vitest";
import { readOwnerDraftState } from "./ownerDraftRead";

const binding = (objectId: string, currentPath: string) => ({ workspaceId: "workspace", mainVersionId: "main", objectId,
  lineageClaimId: "a".repeat(64), currentPath, selectorPaths: [currentPath], restoreFenceGeneration: 0 });
const draft = (objectId: string, currentPath: string, revision = 1, state: "active" | "quarantined" | null = "active") => ({ binding: binding(objectId, currentPath),
  relayDatabaseNamespace: "relay", revision, acceptedCursor: 0, nativeHeadSequence: 1, nativeUnsettled: true,
  outboxId: `outbox-${objectId}`, pendingBytes: 10, state });
const cursor = (objectId: string) => ({ mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64) });
const main = async () => "main";
const mismatch = () => new EngineRequestError(1, { code: "INVALID_PARAMS", message: "owner-outbox-parent-mismatch", retry: "no" });

function client(pages: ReturnType<typeof draft>[][]) {
  return {
    ownerYDocListDrafts: vi.fn(async (_request: unknown, input: { after: { objectId: string } | null }) => {
      const index = input.after === null ? 0 : pages.findIndex(page => page.at(-1)?.binding.objectId === input.after!.objectId) + 1;
      const page = pages[index]!;
      return { drafts: page, next: index + 1 < pages.length ? cursor(page.at(-1)!.binding.objectId) : null };
    }),
    ownerYDocOpenDraft: vi.fn(async (_request: unknown, input: { binding: { objectId: string }; expectedRevision: number }) => ({
      draft: draft(input.binding.objectId, "unused", input.expectedRevision),
      initialUpdate: Buffer.from(`${input.binding.objectId}@${input.expectedRevision}`),
    })),
  };
}

describe("readOwnerDraftState", () => {
  it("opens the draft at the path, on whichever page lists it", async () => {
    const engine = client([[draft("a", "a.md"), draft("b", "b.md")], [draft("plan", "notes/plan.md", 3)]]);
    const state = await readOwnerDraftState(engine as never, "handle", "notes/plan.md", main);
    expect(Buffer.from(state!).toString()).toBe("plan@3");
    expect(engine.ownerYDocListDrafts).toHaveBeenCalledTimes(2);
    expect(engine.ownerYDocOpenDraft).toHaveBeenCalledWith(expect.anything(),
      { binding: binding("plan", "notes/plan.md"), expectedRevision: 3 }, undefined);
  });

  it("answers null for a note that has no draft, without opening one", async () => {
    const engine = client([[draft("a", "a.md")]]);
    expect(await readOwnerDraftState(engine as never, "handle", "notes/plan.md", main)).toBeNull();
    expect(engine.ownerYDocOpenDraft).not.toHaveBeenCalled();
  });

  // #2705 review: each of these read from the file before, and still does.
  it("leaves the file as the text of a frozen draft, a fork, or a workspace without owner delivery", async () => {
    const frozen = client([[draft("plan", "plan.md", 1, "quarantined")]]);
    expect(await readOwnerDraftState(frozen as never, "handle", "plan.md", main)).toBeNull();
    const forked = client([[draft("plan", "plan.md")]]);
    expect(await readOwnerDraftState(forked as never, "handle", "plan.md", async () => "fork")).toBeNull();
    const offline = client([]);
    offline.ownerYDocListDrafts.mockRejectedValueOnce(new EngineRequestError(1, { code: "OVERLOADED", message: "owner delivery capacity", retry: "no" }));
    expect(await readOwnerDraftState(offline as never, "handle", "plan.md", main)).toBeNull();
    for (const engine of [frozen, forked, offline]) expect(engine.ownerYDocOpenDraft).not.toHaveBeenCalled();
  });

  it("lists again once when an edit lands between the list and the open", async () => {
    const engine = client([[draft("plan", "plan.md", 1)]]);
    engine.ownerYDocOpenDraft.mockRejectedValueOnce(mismatch());
    expect(Buffer.from((await readOwnerDraftState(engine as never, "handle", "plan.md", main))!).toString()).toBe("plan@1");
    expect(engine.ownerYDocListDrafts).toHaveBeenCalledTimes(2);

    engine.ownerYDocOpenDraft.mockRejectedValueOnce(mismatch()).mockRejectedValueOnce(mismatch());
    await expect(readOwnerDraftState(engine as never, "handle", "plan.md", main)).rejects.toThrow("owner-outbox-parent-mismatch");
    const refused = new EngineRequestError(1, { code: "INTERNAL", message: "owner-outbox-state-corrupt", retry: "no" });
    engine.ownerYDocOpenDraft.mockRejectedValueOnce(refused);
    await expect(readOwnerDraftState(engine as never, "handle", "plan.md", main)).rejects.toBe(refused);
  });
});
