import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub, ownerLogWaitGroup } from "./discussionActivity";
import { ReplicaWatches } from "./replicaWatches";
import type { AuthorizedShareAction } from "./shareAuthorization";

const registries: ReplicaWatches[] = [];
function registry(options: ConstructorParameters<typeof ReplicaWatches>[1] = {}) {
  const activity = new DiscussionActivityHub();
  const wake = vi.spyOn(activity, "wake");
  const watches = new ReplicaWatches(activity, options);
  registries.push(watches);
  return { watches, wake };
}
function authorized(workspaceId = "a", reader = "reader", owner = "owner", grantId = "grant"): AuthorizedShareAction {
  return {
    ok: true,
    share: { shareId: "share", workspaceId, granterUserId: owner, selectorJson: '{"paths":["/"]}', createdAtMs: 1 },
    grant: { grantId, shareId: "share", principalKind: "user", principalUserId: reader, principalEmail: null,
      access: "view", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
    effectiveSelector: { versionId: "main", paths: ["/"], access: "view" },
  };
}
// Inspect keys without exposing them in the production API or any response.
function state(watches: ReplicaWatches) {
  return (watches as unknown as { workspaces: Map<string, { holders: Map<string, unknown> }> }).workspaces;
}
afterEach(() => { vi.restoreAllMocks(); for (const watches of registries.splice(0)) watches.dispose(); vi.useRealTimers(); });

describe("replica watches", () => {
  it("expires at 35 s without traffic and refreshes without boolean flicker", async () => {
    vi.useFakeTimers();
    const { watches, wake } = registry();
    expect(watches.watched("a")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    watches.holdReader(authorized());
    await vi.advanceTimersByTimeAsync(10_000);
    watches.holdReader(authorized());
    watches.holdReader(authorized("a", "other"));
    expect(wake.mock.calls).toEqual([[ownerLogWaitGroup("a")]]);
    await vi.advanceTimersByTimeAsync(34_999);
    expect(watches.stats()).toEqual({ workspaces: 1, holders: 2 });
    await vi.advanceTimersByTimeAsync(1);
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
    expect(wake.mock.calls).toEqual([[ownerLogWaitGroup("a")], [ownerLogWaitGroup("a")]]);
    expect(vi.getTimerCount()).toBe(0);
    watches.holdReader(authorized());
    expect(watches.watched("a")).toBe(true);
  });

  it.each(["owner", "reader"] as const)("checks the %s quota before looking at the global cap", (quota) => {
    const { watches } = registry({ maxWorkspaces: 1, maxWorkspacesPerOwner: 1, maxWorkspacesPerReader: 1 });
    watches.holdReader(authorized());
    const size = vi.spyOn(state(watches), "size", "get").mockImplementation(() => { throw new Error("global cap inspected"); });
    expect(() => watches.holdReader(authorized("b", quota === "owner" ? "other" : "reader", quota === "reader" ? "other-owner" : "owner"))).not.toThrow();
    expect(size).not.toHaveBeenCalled();
    size.mockRestore();
    expect(watches.watched("b")).toBe(false);
  });

  it("refreshes a reader and owner already at their workspace limits", async () => {
    vi.useFakeTimers();
    const { watches, wake } = registry({ maxWorkspacesPerOwner: 1, maxWorkspacesPerReader: 1 });
    watches.holdReader(authorized());
    await vi.advanceTimersByTimeAsync(10_000);
    watches.holdReader(authorized());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(watches.watched("a")).toBe(true);
    expect(watches.stats()).toEqual({ workspaces: 1, holders: 1 });
    expect(wake.mock.calls).toEqual([[ownerLogWaitGroup("a")]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watches.watched("a")).toBe(false);
  });

  it("limits one reader to 16 workspaces even across owners and grants", () => {
    const { watches } = registry();
    for (let i = 0; i < 17; i++) watches.holdReader(authorized(`w${i}`, "reader", `owner${i}`, `grant${i}`));
    expect(watches.stats()).toEqual({ workspaces: 16, holders: 16 });
    expect(watches.watched("w16")).toBe(false);
    watches.holdReader(authorized("w16", "another", "owner16"));
    expect(watches.watched("w16")).toBe(true);
  });

  it("limits an owner to 32 workspaces even with different readers", () => {
    const { watches } = registry();
    for (let i = 0; i < 33; i++) watches.holdReader(authorized(`w${i}`, `reader${i}`));
    expect(watches.stats()).toEqual({ workspaces: 32, holders: 32 });
    expect(watches.watched("w32")).toBe(false);
    watches.holdReader(authorized("w32", "another", "another-owner"));
    expect(watches.watched("w32")).toBe(true);
  });

  it("keeps the default 64-holder and 1,024-workspace caps", () => {
    const { watches } = registry();
    for (let i = 0; i < 65; i++) watches.holdReader(authorized("a", `reader${i}`));
    expect(watches.stats().holders).toBe(64);
    for (let i = 1; i <= 1_024; i++) watches.holdReader(authorized(`w${i}`, `other${i}`, `owner${i}`));
    expect(watches.stats()).toEqual({ workspaces: 1_024, holders: 1_087 });
    expect(watches.watched("w1024")).toBe(false);
  });

  it("refuses global and workspace capacity without eviction, but allows refresh", async () => {
    vi.useFakeTimers();
    const { watches, wake } = registry({ maxWorkspaces: 2, maxHoldersPerWorkspace: 2 });
    watches.holdReader(authorized());
    watches.holdReader(authorized("a", "two"));
    watches.holdReader(authorized("b"));
    watches.holdReader(authorized("a", "three"));
    watches.holdReader(authorized("c"));
    await vi.advanceTimersByTimeAsync(1_000);
    watches.holdReader(authorized());
    expect(watches.stats()).toEqual({ workspaces: 2, holders: 3 });
    expect(watches.watched("c")).toBe(false);
    expect(wake).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(34_000);
    expect(watches.stats()).toEqual({ workspaces: 1, holders: 1 });
    watches.holdReader(authorized("c"));
    expect(watches.watched("c")).toBe(true);
  });

  it("hashes reader identities to fixed-length keys stable across grants and workspaces", () => {
    const { watches } = registry();
    watches.holdReader(authorized());
    const first = [...state(watches).get("a")!.holders.keys()][0];
    expect(first).toBe(createHash("sha256").update(JSON.stringify(["user", "reader"])).digest("base64url"));
    watches.holdReader(authorized("a", "reader", "owner", "another-grant"));
    expect(watches.stats().holders).toBe(1);
    watches.holdReader(authorized("a", "two"));
    watches.holdReader(authorized("b"));
    const keys = [...state(watches).values()].flatMap(w => [...w.holders.keys()]);
    expect(new Set(keys).size).toBe(2);
    expect([...state(watches).get("b")!.holders.keys()]).toEqual([first]);
    expect(keys.every(k => /^[A-Za-z0-9_-]{43}$/.test(k))).toBe(true);
    watches.holdReader(authorized("a", "reader".repeat(1_000)));
    expect([...state(watches).get("a")!.holders.keys()].every(k => k.length === 43)).toBe(true);
  });

  it("keys accountless readers by link grant, never by browser instance", () => {
    const { watches } = registry();
    const link = authorized();
    link.grant.principalKind = "link";
    link.grant.principalUserId = null;
    watches.holdReader(link);
    watches.holdReader(structuredClone(link));
    expect(watches.stats().holders).toBe(1);
    watches.holdReader({ ...link, grant: { ...link.grant, grantId: "other" } });
    expect(watches.stats().holders).toBe(2);
    const linkKey = [...state(watches).get("a")!.holders.keys()][0];
    expect(linkKey).toBe(createHash("sha256").update(JSON.stringify(["link", "grant"])).digest("base64url"));
    watches.holdReader(authorized("a", "grant"));
    expect(watches.stats().holders).toBe(3);
    expect([...state(watches).get("a")!.holders.keys()][2]).not.toBe(linkKey);
  });

  it("accepts only an authorized grant record in its type contract", () => {
    type Input = Parameters<ReplicaWatches["holdReader"]>[0];
    // @ts-expect-error The API rejects an explicit caller-selected key.
    const cannotChooseKey: Input = { ...authorized(), holderKey: "chosen" };
    // @ts-expect-error A Request cannot substitute for an authorized grant record.
    const cannotHoldRequest: Input = new Request("https://relay/read?holderKey=chosen");
    void cannotChooseKey;
    void cannotHoldRequest;
  });

  it("returns nothing on refusal or acceptance", () => {
    const { watches, wake } = registry({ maxWorkspaces: 1 });
    expect(watches.holdReader(authorized())).toBeUndefined();
    expect(watches.holdReader(authorized("b"))).toBeUndefined();
    expect(watches.watched("b")).toBe(false);
    expect(watches.stats()).toEqual({ workspaces: 1, holders: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("never counts the owner's own grant or a pending email invite", () => {
    const { watches } = registry();
    watches.holdReader(authorized("a", "owner"));
    const pending = authorized();
    pending.grant.principalKind = "email";
    pending.grant.principalUserId = null;
    pending.grant.principalEmail = "pending@example.com";
    watches.holdReader(pending);
    expect(watches.stats()).toEqual({ workspaces: 0, holders: 0 });
  });

  it("reclaims both quota indexes on TTL expiry and disposal", async () => {
    vi.useFakeTimers();
    const { watches } = registry({ maxWorkspacesPerOwner: 1, maxWorkspacesPerReader: 1 });
    watches.holdReader(authorized());
    await vi.advanceTimersByTimeAsync(35_000);
    watches.holdReader(authorized("b"));
    expect(watches.watched("b")).toBe(true);
    watches.dispose();
    expect(vi.getTimerCount()).toBe(0);
    watches.holdReader(authorized("c"));
    expect(watches.watched("c")).toBe(true);
  });
});
