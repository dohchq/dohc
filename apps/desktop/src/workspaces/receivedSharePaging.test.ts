import { expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createReceivedShareAcquisition, createReceivedShareStore, listReceivedInventory } from "./receivedShareStore";
import { createTestScratch } from "./testTemp";

const row = (shareId: string) => ({ shareId, grantId: `grant-${shareId}`, granterUserId: "owner", granterEmail: "owner@test.dev",
  generation: 1, createdAtMs: 1, genericChatWritable: false, selector: { paths: ["Notes"], versionId: null }, access: "view" as const });
const empty = { ok: true, received: [], removed: [] };

it("assembles over 1,000 shares and removals, schema-parsing away secrets on every page", async () => {
  const get = vi.fn(async (path: string) => path.includes("cursor=")
    ? { ok: true, received: [{ ...row("s-1000"), bearerUrl: "secret" }],
      removed: [{ shareId: "s-1001", grantId: "ended", removedAtMs: 2, message: "Removed", credentials: "secret" }] }
    : { ok: true, received: Array.from({ length: 1000 }, (_, i) => ({ ...row(`s-${String(i).padStart(4, "0")}`), token: "secret" })), removed: [], nextCursor: "c 1" });
  const current = vi.fn();
  const result = await listReceivedInventory(get, current);
  expect(result.received).toHaveLength(1001);
  expect(result.removed).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(get.mock.calls.map(([path]) => path)).toEqual(["/sync/shares?received=true", "/sync/shares?received=true&cursor=c%201"]);
  expect(current).toHaveBeenCalledTimes(4);
});

it.each(["offline", "denied", "malformed", "loop", "overlap"])("never publishes partial pages after %s", async failure => {
  const directory = await createTestScratch("received-paging-");
  const scope = { userId: "recipient", relayUrl: "https://relay.test", generation: 1 };
  const store = createReceivedShareStore(directory);
  const historical = { received: [row("historical")], removed: [] };
  store.save(scope, historical, 1);
  let calls = 0;
  const get = vi.fn(async () => {
    if (++calls === 1) return { ...empty, received: [row("s-0000")], nextCursor: "next" };
    if (failure === "offline") throw new Error("offline");
    if (failure === "denied") return { ok: false, code: "denied" };
    if (failure === "malformed") return { ...empty, nextCursor: null };
    if (failure === "loop") return { ...empty, nextCursor: "next" };
    return { ...empty, received: [row("s-0000")] };
  });
  const onLive = vi.fn();
  const acquisition = createReceivedShareAcquisition({ store, scope: () => scope,
    list: () => listReceivedInventory(get, () => {}), onLive, logError: vi.fn() });
  await acquisition.refresh();
  expect(acquisition.observation()).toMatchObject({ inventory: historical, freshness: "stale", checkedAtMs: 1 });
  expect(onLive).not.toHaveBeenCalled();
  expect(store.read(scope)?.inventory).toEqual(historical);
});

it("stops paging when the credential generation or account changes while a response is pending", async () => {
  for (const change of ["generation", "account"]) {
    const pending = deferred<unknown>();
    const entered = deferred<void>();
    let current = true;
    const get = vi.fn(async () => { entered.resolve(); return pending.promise; });
    const directory = await createTestScratch("received-account-paging-");
    const store = createReceivedShareStore(directory);
    const previous = { userId: "recipient", relayUrl: "https://relay.test", generation: 1 };
    let scope = previous;
    const onLive = vi.fn();
    const acquisition = createReceivedShareAcquisition({ store, scope: () => scope, onLive, logError: vi.fn(),
      list: () => listReceivedInventory(get, () => { if (!current) throw new Error("Session changed"); }) });
    const refresh = acquisition.refresh();
    await entered.promise;
    current = false;
    scope = { ...previous, generation: 2, ...(change === "account" ? { userId: "other" } : {}) };
    acquisition.credentialsChanged(scope);
    pending.resolve({ ...empty, received: [row("s")], nextCursor: "next" });
    await refresh;
    expect(get).toHaveBeenCalledOnce();
    expect(onLive).not.toHaveBeenCalled();
    expect(store.read(previous)).toBeNull();
    expect(acquisition.observation().freshness).toBe("unknown");
  }
});

it("bounds a listing that never finishes", async () => {
  let page = 0;
  const get = vi.fn(async () => ({ ...empty, nextCursor: `cursor-${++page}` }));
  await expect(listReceivedInventory(get, () => {})).rejects.toThrow("did not finish");
  expect(get).toHaveBeenCalledTimes(50);
});
