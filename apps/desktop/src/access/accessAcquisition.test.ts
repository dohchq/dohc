import { afterEach, expect, it, vi } from "vitest";
import { createAccessAcquisition, createAccessOwner } from "./accessOwner";
import { createShareRosters } from "../automations/shareRoster";
import { createReceivedShareAcquisition, type ReceivedInventory, type ReceivedScope } from "../workspaces/receivedShareStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { RosterAnswer } from "@dohc/automation-executor/roster-listing";
import { deferred } from "../testing/deferred";

afterEach(() => vi.useRealTimers());
const grant = { shareId: "share", grantId: "grant", granterUserId: "owner", granterEmail: null, recipientUserId: "recipient", recipientEmail: null,
  subjectName: null, sharerName: null, generation: 1, status: "active" as const, selector: { paths: ["Notes"], versionId: null }, access: "view" as const };
const listing = { grants: [grant], links: [], formerGrants: [], endedGrants: [] };
const inventory = { received: [{ ...grant, createdAtMs: 1, genericChatWritable: false }], removed: [] };
function harness() {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  let context = {};
  const workspace = { workspaceId: "w", rootPath: "/w", remote: { ownerUserId: "owner", serverUrl: "relay" } } as RegistryEntry;
  const listRoster = vi.fn(async (): Promise<RosterAnswer> => ({ kind: "answered", listing }));
  const rosters = createShareRosters({ findWorkspace: () => workspace, saveRoster: (_id, listing, _pulled, listedAtMs) => {
    workspace.shareRoster = { ...listing, version: 1, listedAtMs };
  }, markRosterPulled: () => undefined, listRoster, localUserId: async () => "owner", localPersonId: async () => null,
    syncHistory: async () => "synced", logError: vi.fn(), nowMs: Date.now, wallNowMs: Date.now, context: () => context });
  let saved: { inventory: ReceivedInventory; listedAtMs: number } | null = null;
  let scope: ReceivedScope = { userId: "recipient", relayUrl: "relay", generation: 1 };
  const store = { read: () => saved, save: (_scope: ReceivedScope, inventory: ReceivedInventory, listedAtMs: number) => { saved = { inventory, listedAtMs }; },
    remove: () => { saved = null; }, file: () => "/unused" };
  const listReceived = vi.fn(async (): Promise<unknown> => inventory), onLive = vi.fn(async () => undefined);
  const received = createReceivedShareAcquisition({ store, scope: () => scope, list: listReceived, onLive, logError: vi.fn(), nowMs: Date.now, wallNowMs: Date.now });
  const acquisition = createAccessAcquisition({ roster: id => rosters.requestRefresh(id), received: () => received.refresh() });
  const owner = createAccessOwner({ resolve: async (_w: string, ref) => ({ ref, visibility: "visible" }), roster: () => rosters.observation("w"),
    received: () => received.observation(), account: () => ({ userId: scope.userId, email: "recipient@test.dev", relayUrl: scope.relayUrl, generation: scope.generation }), scope: () => scope.userId,
    assertCurrent: () => undefined, permissions: async () => { throw Error("unused"); }, refresh: () => acquisition.request("w") });
  return { owner, rosters, received, acquisition, listRoster, listReceived, onLive, store,
    switchAccount() { scope = { ...scope, userId: "other", generation: 2 }; context = {}; received.credentialsChanged(scope); } };
}
it("feeds both observations once, preserves cached reads, and paces repeated surface requests", async () => {
  const h = harness();
  try {
    await Promise.all([h.owner.refresh("w"), h.owner.refresh("w")]);
    for (const lane of ["granted", "received"] as const) expect(h.owner.sharing("w", { lane })).toMatchObject({ freshness: "fresh", checkedAtMs: 100_000 });
    await h.owner.refresh("w");
    expect(h.listRoster).toHaveBeenCalledOnce(); expect(h.listReceived).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.owner.refresh("w");
    expect(h.listRoster).toHaveBeenCalledTimes(2); expect(h.listReceived).toHaveBeenCalledTimes(2);
  } finally { h.rosters.close("w"); }
});
it("labels failed and partial refreshes historical and keeps restart observations stale", async () => {
  const h = harness();
  try {
    await h.owner.refresh("w");
    h.listRoster.mockResolvedValue({ kind: "unanswered", partial: true, next: "offline" });
    h.listReceived.mockRejectedValue(Error("page cursor failed"));
    vi.setSystemTime(160_000); await h.owner.refresh("w");
    for (const lane of ["granted", "received"] as const) expect(h.owner.sharing("w", { lane })).toMatchObject({ freshness: "stale", checkedAtMs: 100_000, rows: [{ shareId: "share" }] });
    expect(h.onLive).toHaveBeenCalledOnce();
    h.received.retire();
    expect(h.owner.sharing("w", { lane: "received" }).freshness).toBe("stale");
  } finally { h.rosters.close("w"); }
});
it("rejects account-superseded publication and keeps local mutations stale during acquisition", async () => {
  const h = harness(), waiting = deferred<unknown>();
  try {
    await h.owner.refresh("w");
    vi.setSystemTime(160_000); h.listReceived.mockReturnValue(waiting.promise);
    const refresh = h.owner.refresh("w");
    h.received.invalidate();
    waiting.resolve(inventory); await refresh;
    expect(h.owner.sharing("w", { lane: "received" }).freshness).toBe("stale");
    expect(h.onLive).toHaveBeenCalledOnce();
    h.switchAccount();
    expect(h.owner.sharing("w", { lane: "received" })).toMatchObject({ rows: [], freshness: "unknown" });
  } finally { h.rosters.close("w"); }
});
