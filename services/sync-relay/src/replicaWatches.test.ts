import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscussionActivityHub, ownerLogWaitGroup } from "./discussionActivity";
import { ReplicaWatches } from "./replicaWatches";
import type { AuthorizedShareAction } from "./shareAuthorization";

const key = "test-relay-watch-secret";
const registries: ReplicaWatches[] = [];
function registry(options: ConstructorParameters<typeof ReplicaWatches>[1] = {}) {
  const activity = new DiscussionActivityHub();
  const wake = vi.spyOn(activity, "wake");
  const watches = new ReplicaWatches(activity, { key, ...options });
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

  it("uses fixed-length HMACs stable across grants and different across principals, workspaces, and secrets", () => {
    const { watches } = registry();
    watches.holdReader(authorized());
    const first = [...state(watches).get("a")!.holders.keys()][0];
    expect(first).toBe(createHmac("sha256", key).update(JSON.stringify(["replica-watch-holder-v1", "user", "reader", "a"])).digest("base64url"));
    watches.holdReader(authorized("a", "reader", "owner", "another-grant"));
    expect(watches.stats().holders).toBe(1);
    watches.holdReader(authorized("a", "two"));
    watches.holdReader(authorized("b"));
    const keys = [...state(watches).values()].flatMap(w => [...w.holders.keys()]);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every(k => /^[A-Za-z0-9_-]{43}$/.test(k))).toBe(true);
    const other = registry({ key: "another-secret" }).watches;
    other.holdReader(authorized());
    expect([...state(other).get("a")!.holders.keys()][0]).not.toBe(first);
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
    expect([...state(watches).get("a")!.holders.keys()][0]).toBe(createHmac("sha256", key)
      .update(JSON.stringify(["replica-watch-holder-v1", "link", "grant", "a"])).digest("base64url"));
  });

  it("has no request-selected key, workspace, owner, quota identity, TTL, or leave", () => {
    const { watches } = registry();
    const incoming = { key: "chosen", holderKey: "chosen", workspaceId: "fake", owner: "fake", reader: "fake", ttlMs: 1 };
    watches.holdReader({ ...authorized(), ...incoming });
    // @ts-expect-error The API rejects an explicit caller-selected key.
    watches.holdReader({ ...authorized(), ...incoming, holderKey: "another" });
    expect(watches.stats()).toEqual({ workspaces: 1, holders: 1 });
    expect(watches.watched("fake")).toBe(false);
    expect(state(watches).get("a")!.holders.has("chosen")).toBe(false);
    expect(watches).not.toHaveProperty("release");
    // @ts-expect-error A Request cannot substitute for an authorized grant record.
    const cannotHoldRequest: Parameters<ReplicaWatches["holdReader"]>[0] = new Request("https://relay/read?holderKey=chosen");
    void cannotHoldRequest;
  });

  it("leaves the read's status, headers, bytes and completion deadline unchanged on refusal", async () => {
    vi.useFakeTimers();
    const { watches } = registry({ maxWorkspaces: 1 });
    watches.holdReader(authorized());
    const read = (workspaceId: string) => {
      watches.holdReader(authorized(workspaceId));
      return new Promise<Response>(resolve => setTimeout(() => resolve(new Response("unchanged", { status: 206, headers: { "x-read": "same" } })), 100));
    };
    const results: Response[] = [];
    const reads = [read("a"), read("b")].map(p => p.then(r => { results.push(r); return r; }));
    await vi.advanceTimersByTimeAsync(99);
    expect(results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toHaveLength(2);
    for (const response of await Promise.all(reads)) {
      expect(response.status).toBe(206);
      expect([...response.headers]).toEqual([["content-type", "text/plain;charset=UTF-8"], ["x-read", "same"]]);
      expect(await response.text()).toBe("unchanged");
    }
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
