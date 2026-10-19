import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRegistryStore } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { deferred } from "../testing/deferred";
import { createShareRosters, SHARE_ROSTER_FRESH_MS, SHARE_ROSTER_REFRESH_MS } from "./shareRoster";
import type { RosterAnswer } from "@dohc/automation-executor/roster-listing";

const listing = { grants: [], links: [], formerGrants: [], endedGrants: [] };
const answered: RosterAnswer = { kind: "answered", listing };
let directory: string;
let harnessId = 0;
beforeEach(async () => { directory = await createTestScratch("dohc-roster-observation-"); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

function harness() {
  const store = createRegistryStore(join(directory, String(harnessId++), "workspaces.json"));
  const entry = { workspaceId: "w", rootPath: "/work", kind: "personal" as const, mode: "local-first" as const,
    remote: { ownerUserId: "owner", serverUrl: "https://relay.test" } };
  store.register(entry);
  let mono = 0, wall = 100;
  let context: unknown = Symbol("attachment and credential session");
  const list = vi.fn(async (): Promise<RosterAnswer> => answered);
  const make = (saveRoster = store.setShareRoster) => createShareRosters({
    findWorkspace: store.find, saveRoster, markRosterPulled: store.markShareRosterPulled,
    listRoster: list, localUserId: async () => null, localPersonId: async () => null,
    syncHistory: async () => "never-synced", logError: vi.fn(),
    nowMs: () => mono, wallNowMs: () => wall, context: () => context,
  });
  return { store, entry, list, make, retire: () => { context = Symbol("new attachment or session"); },
    advance: async (ms: number) => { mono += ms; wall += ms; await vi.advanceTimersByTimeAsync(ms); } };
}

it("timestamps acquisition start, expires freshness and makes restart stale without changing reach", async () => {
  const h = harness(); const r = h.make(); const response = deferred<RosterAnswer>();
  h.list.mockImplementationOnce(() => response.promise);
  const pending = r.requestRefresh("w"); await h.advance(200); response.resolve(answered); await pending;
  expect(r.observation("w")).toEqual({ listing, checkedAtMs: 100, freshness: "fresh" });
  expect(h.store.find("w")?.shareRoster?.listedAtMs).toBe(100);
  const restart = h.make();
  expect(restart.observation("w").freshness).toBe("stale");
  expect(await restart.cached("w")).toMatchObject({ kind: "owner", grants: [] });
  await h.advance(SHARE_ROSTER_REFRESH_MS);
  expect(r.observation("w").freshness).toBe("stale");
});

it("invalidates an overlapping Access observation and immediately relists local changes for reach", async () => {
  const h = harness(); const r = h.make(); const first = deferred<RosterAnswer>(); const second = deferred<RosterAnswer>();
  h.list.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const pending = r.requestRefresh("w"); r.sharesChanged("w"); r.sharesChanged("w");
  first.resolve(answered);
  await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
  expect(r.observation("w").freshness).toBe("stale");
  second.resolve(answered); await pending;
  expect(r.observation("w").freshness).toBe("fresh");
  r.close("w");
});

it("paces Access requests without delaying local share-change relisting", async () => {
  const h = harness(); const r = h.make(); await r.requestRefresh("w");
  await r.requestRefresh("w"); await r.requestRefresh("w");
  expect(h.list).toHaveBeenCalledOnce();
  await h.advance(SHARE_ROSTER_FRESH_MS - 1); expect(h.list).toHaveBeenCalledOnce();
  await h.advance(1); await r.requestRefresh("w"); expect(h.list).toHaveBeenCalledTimes(2);
  r.sharesChanged("w"); await r.forRun("w"); expect(h.list).toHaveBeenCalledTimes(3);
  r.close("w");
});

it("discards responses after credential or attachment replacement and workspace removal", async () => {
  for (const change of ["context", "removal"] as const) {
    const h = harness(); const r = h.make(); const response = deferred<RosterAnswer>();
    h.list.mockImplementationOnce(() => response.promise);
    const pending = r.requestRefresh("w");
    if (change === "context") h.retire(); else h.store.remove("w");
    response.resolve(answered); await pending;
    expect(h.store.find("w")?.shareRoster).toBeUndefined();
    expect(r.observation("w").freshness).toBe("unknown");
  }
});

it("retains labelled historical facts after partial acquisition, denial or timeout", async () => {
  for (const answer of [
    { kind: "unanswered", next: "partial", partial: true },
    { kind: "unanswered", next: "denied", partial: false },
    { kind: "unanswered", next: "timeout", partial: false },
  ] as const) {
    const h = harness(); const r = h.make(); await r.requestRefresh("w");
    await h.advance(SHARE_ROSTER_FRESH_MS);
    h.list.mockResolvedValue(answer); await r.requestRefresh("w");
    expect(r.observation("w")).toEqual({ listing, checkedAtMs: 100, freshness: "stale" });
  }
});

it("does not refresh on routine sync and stops deferred refreshes on retirement", async () => {
  const h = harness(); const r = h.make(); r.open("w"); await r.forRun("w");
  for (let i = 0; i < 10; i++) await r.pulled("w", false);
  expect(h.list).toHaveBeenCalledOnce();
  await r.requestRefresh("w"); r.close("w");
  await h.advance(SHARE_ROSTER_REFRESH_MS * 2);
  expect(h.list).toHaveBeenCalledOnce();
});

it("discards an unsaved listing after the credential or attachment context changes", async () => {
  const h = harness(); let fail = true;
  const r = h.make((id, listing, pulledAfter, listedAtMs) => {
    if (fail) throw new Error("disk full");
    h.store.setShareRoster(id, listing, pulledAfter, listedAtMs);
  });
  await r.requestRefresh("w");
  expect(r.observation("w").freshness).toBe("fresh");
  h.retire(); fail = false;
  await r.forRun("w");
  expect(h.store.find("w")?.shareRoster).toBeUndefined();
  expect(r.observation("w").freshness).toBe("unknown");
});

it("cannot publish a listing after its roster is retired, even before replacement", async () => {
  const h = harness(); const r = h.make(); const response = deferred<RosterAnswer>();
  h.list.mockImplementationOnce(() => response.promise);
  const pending = r.requestRefresh("w"); r.close("w");
  response.resolve(answered); await pending;
  expect(h.store.find("w")?.shareRoster).toBeUndefined();
});

it("reuses the parsed observation until the underlying roster changes", async () => {
  const h = harness(); const r = h.make(); await r.requestRefresh("w");
  const first = r.observation("w").listing;
  expect(r.observation("w").listing).toBe(first);
  await r.requestRefresh("w");
  expect(r.observation("w").listing).toBe(first);
  r.close("w");
});

it.each(["missing", "local-only", "share-view"] as const)("uses listOnce's eligibility rule for a %s workspace", async kind => {
  const h = harness();
  const workspace = kind === "missing" ? null : kind === "local-only" ? { ...h.entry, remote: undefined }
    : { ...h.entry, shareView: { shareId: "share", relayUrl: "https://relay.test", recipientUserId: "friend",
      granterEmail: null, genericChatWritable: false,
      grantedSelector: { paths: ["doc.md"], versionId: null, access: "view" as const } } };
  const listRoster = vi.fn(async () => answered), saveRoster = vi.fn();
  const r = createShareRosters({ findWorkspace: () => workspace, saveRoster, markRosterPulled: vi.fn(),
    listRoster, localUserId: async () => null, localPersonId: async () => null,
    syncHistory: async () => "never-synced", logError: vi.fn() });
  try {
    expect(await r.requestRefresh("w")).toBe("unavailable");
    r.sharesChanged("w");
    await r.requestRefresh("w");
    expect(listRoster).not.toHaveBeenCalled(); expect(saveRoster).not.toHaveBeenCalled();
    expect(r.observation("w")).toMatchObject({ checkedAtMs: null, freshness: "unknown" });
  } finally { r.close("w"); }
});
