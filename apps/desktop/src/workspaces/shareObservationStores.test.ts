import { readFileSync, readdirSync, writeFileSync, openSync, writeFileSync as writeSync, fsyncSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { createRegistryStore, type RegistryEntry } from "./registryStore";
import { createShareRosterStore } from "./shareRosterStore";
import { createReceivedShareAcquisition, createReceivedShareStore, parseReceivedInventory, type ReceivedScope } from "./receivedShareStore";
import { readReceivedShareListing, reconcileRecipientSharesAfterLookup } from "./recipientShareReconciliation";
import { deferred } from "../testing/deferred";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync), renameSync: vi.fn(actual.renameSync) };
});

const workspace: RegistryEntry = { workspaceId: "w", rootPath: "/work", kind: "personal", mode: "local-first",
  remote: { serverUrl: "https://relay.test", ownerUserId: "owner" } };
const grant = { shareId: "share", generation: 1, status: "active" as const, granterUserId: "owner", granterEmail: null, subjectName: null, sharerName: null, grantId: "g", recipientUserId: "friend", recipientEmail: "friend@test.dev",
  selector: { paths: ["Notes"], versionId: null }, access: "view" as const };
const listing = { grants: [grant], links: [], formerGrants: [], endedGrants: [] };
const row = (shareId = "s") => ({ shareId, grantId: "g", granterUserId: "owner", granterEmail: "owner@test.dev",
  generation: 1, createdAtMs: 1, genericChatWritable: false,
  selector: { paths: ["Notes"], versionId: null }, access: "view" });
const inventory = () => ({ received: [row()], removed: [] });
let directory: string;

beforeEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); directory = await createTestScratch("dohc-share-observations-"); });

describe("per-workspace roster storage", () => {
  it("strips unknown fields on save and rejects old file shapes, including empty rosters", () => {
    const files = createShareRosterStore(join(directory, "rosters"));
    const unsafe = { ...listing, token: "secret", grants: [{ ...grant, credentials: "secret", browserInvitationUrl: "secret", shareCode: "secret" }] };
    const saved = files.save(workspace, unsafe, false, 100);
    files.markPulled({ ...workspace, shareRoster: { ...saved, ...unsafe } });
    expect(readFileSync(files.file(workspace), "utf8")).not.toContain("secret");
    expect(createShareRosterStore(join(directory, "rosters")).read(workspace)?.grants).toEqual([grant]);
    for (const old of [listing, { ...listing, grants: [] }]) {
      writeFileSync(files.file(workspace), JSON.stringify({ ...old, version: 1, listedAtMs: 100 }));
      expect(createShareRosterStore(join(directory, "rosters")).read(workspace)).toBeUndefined();
    }
  });
  it("preserves the pull mark through metadata updates without serializing the roster", () => {
    const file = join(directory, "registry.json");
    const store = createRegistryStore(file);
    store.register(workspace);
    store.register({ ...workspace, workspaceId: "other", rootPath: "/other" });
    store.setShareRoster("w", listing, false, 123);
    store.markShareRosterPulled("w");
    store.markOpened("other", 456);
    expect(readFileSync(file, "utf8")).not.toContain('"shareRoster"');
    store.setAutomationHost("w", null);
    expect(store.find("w")?.shareRoster?.pulledAfter).toBe(true);
    expect(createRegistryStore(file).find("w")?.shareRoster?.pulledAfter).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain('"shareRoster"');
  });

  it("keeps entry identity when saving changed and unchanged rosters or marking a pull", () => {
    const store = createRegistryStore(join(directory, "registry.json"));
    store.register(workspace);
    const entry = store.find("w");
    store.setShareRoster("w", listing, false, 100);
    expect(store.find("w")).toBe(entry);
    store.setShareRoster("w", listing, false, 200);
    expect(store.find("w")).toBe(entry);
    store.markShareRosterPulled("w");
    expect(store.find("w")).toBe(entry);
    expect(entry?.shareRoster?.pulledAfter).toBe(true);
  });

  it("keeps 10,000 grants out of the registry and writes only the affected workspace", () => {
    const registry = join(directory, "workspaces.json");
    const store = createRegistryStore(registry);
    store.register(workspace);
    store.register({ ...workspace, workspaceId: "other", rootPath: "/other" });
    const before = readFileSync(registry, "utf8");
    const large = { ...listing, grants: Array.from({ length: 10_000 }, (_, i) => ({ ...grant, grantId: `g-${i}` })) };
    store.setShareRoster("w", large, false, 123);
    expect(readFileSync(registry, "utf8")).toBe(before);
    expect(createRegistryStore(registry).find("w")?.shareRoster).toMatchObject({ listedAtMs: 123, grants: large.grants });
    expect(store.find("other")?.shareRoster).toBeUndefined();
    expect(readdirSync(join(directory, "share-rosters"))).toHaveLength(1);
    vi.mocked(renameSync).mockClear();
    store.setShareRoster("w", large, false, 456);
    expect(renameSync).not.toHaveBeenCalled();
    expect(store.find("w")?.shareRoster?.listedAtMs).toBe(123);
  });

  it("partitions by owner and relay, survives re-rooting, and deletes the roster on removal", () => {
    const registry = createRegistryStore(join(directory, "workspaces.json"));
    registry.register(workspace);
    registry.setShareRoster("w", listing, false, 123);
    const files = createShareRosterStore(join(directory, "share-rosters"));
    expect(files.file({ ...workspace, rootPath: "/copy" })).toBe(files.file(workspace));
    expect(files.read({ ...workspace, rootPath: "/copy" })?.listedAtMs).toBe(123);
    expect(files.read({ ...workspace, remote: { ...workspace.remote!, ownerUserId: "another" } })).toBeUndefined();
    expect(files.read({ ...workspace, remote: { ...workspace.remote!, serverUrl: "https://elsewhere.test" } })).toBeUndefined();
    registry.remove("w");
    expect(readdirSync(join(directory, "share-rosters"))).toEqual([]);
    registry.register(workspace);
    expect(registry.find("w")?.shareRoster).toBeUndefined();
  });

  it("makes damaged copies unknown and discards obsolete inline rosters", () => {
    const registry = join(directory, "workspaces.json");
    const store = createRegistryStore(registry);
    store.register(workspace);
    store.setShareRoster("w", listing, false, 123);
    const files = createShareRosterStore(join(directory, "share-rosters"));
    writeFileSync(files.file(workspace), "{damaged");
    expect(createRegistryStore(registry).find("w")?.shareRoster).toBeUndefined();
    writeFileSync(registry, JSON.stringify({ version: 1, workspaces: [{ ...workspace, shareRoster: listing }] }));
    expect(createRegistryStore(registry).find("w")?.shareRoster).toBeUndefined();
  });

  it.each(["open", "write", "fsync", "rename"])("preserves disk and cache after a %s failure and removes its temporary file", failure => {
    const store = createRegistryStore(join(directory, "workspaces.json"));
    store.register(workspace);
    store.setShareRoster("w", listing, false, 123);
    const saved = store.find("w")?.shareRoster;
    const files = createShareRosterStore(join(directory, "share-rosters"));
    const before = readFileSync(files.file(workspace), "utf8");
    const fail = () => { throw new Error("disk failure"); };
    if (failure === "open") vi.mocked(openSync).mockImplementationOnce(fail);
    if (failure === "write") vi.mocked(writeSync).mockImplementationOnce(fail);
    if (failure === "fsync") vi.mocked(fsyncSync).mockImplementationOnce(fail);
    if (failure === "rename") vi.mocked(renameSync).mockImplementationOnce(fail);
    expect(() => store.setShareRoster("w", { ...listing, grants: [] }, false, 456)).toThrow("disk failure");
    expect(store.find("w")?.shareRoster).toEqual(saved);
    expect(readFileSync(files.file(workspace), "utf8")).toBe(before);
    expect(readdirSync(join(directory, "share-rosters")).filter(file => file.includes(".tmp-"))).toEqual([]);
    expect(vi.mocked(openSync).mock.calls.some(call => call[1] === "wx" && call[2] === 0o600)).toBe(true);
  });
});

describe("account received observations", () => {
  function harness() {
    const store = createReceivedShareStore(join(directory, "received"));
    let scope: ReceivedScope | null = { userId: "friend", relayUrl: "https://relay.test", generation: 1 };
    let mono = 0;
    let wall = 100;
    const list = vi.fn(async (_scope: ReceivedScope): Promise<unknown> => inventory());
    const onLive = vi.fn(async () => undefined);
    const logError = vi.fn();
    const acquisition = () => createReceivedShareAcquisition({ store, scope: () => scope, list, onLive, logError,
      nowMs: () => mono, wallNowMs: () => wall });
    return { store, list, onLive, logError, acquisition,
      scope: () => scope!, switch: (next: ReceivedScope | null) => { scope = next; },
      advance: (ms: number) => { mono += ms; wall += ms; }, setWall: (ms: number) => { wall = ms; } };
  }

  it.each([null,
    { userId: "other", relayUrl: "https://relay.test", generation: 2 },
    { userId: "friend", relayUrl: "https://other.test", generation: 2 },
  ])("deletes the previous account file on sign-out or account/relay switch to %j", async next => {
    const h = harness(); const a = h.acquisition(); await a.refresh();
    const previous = h.scope();
    const response = deferred<unknown>(); h.advance(60_000);
    h.list.mockImplementationOnce(() => response.promise);
    const pending = a.refresh();
    h.switch(next); a.credentialsChanged(next);
    expect(createReceivedShareStore(join(directory, "received")).read(previous)).toBeNull();
    response.resolve(inventory()); await pending;
    expect(createReceivedShareStore(join(directory, "received")).read(previous)).toBeNull();
    expect(h.onLive).toHaveBeenCalledOnce();
    expect(a.observation().freshness).toBe("unknown");
  });

  it("retires on a credential reload placeholder without deleting the same account's observations", async () => {
    const h = harness(); const a = h.acquisition(); await a.refresh();
    const previous = h.scope();
    h.switch(null); a.credentialsChanged(null, false);
    expect(createReceivedShareStore(join(directory, "received")).read(previous)).not.toBeNull();
    const renewed = { ...previous, generation: 2 };
    h.switch(renewed); a.credentialsChanged(renewed);
    expect(a.observation().freshness).toBe("stale");
    expect(createReceivedShareStore(join(directory, "received")).read(previous)).not.toBeNull();
    h.switch(null); a.credentialsChanged(null, false); a.credentialsChanged(null);
    expect(createReceivedShareStore(join(directory, "received")).read(previous)).toBeNull();
  });

  it("coalesces acquisitions, timestamps their start and labels offline restart stale", async () => {
    const h = harness();
    const a = h.acquisition();
    const answer = deferred<unknown>();
    h.list.mockImplementationOnce(() => answer.promise);
    const first = a.refresh();
    const second = a.refresh();
    expect(h.list).toHaveBeenCalledOnce();
    h.advance(500);
    answer.resolve(inventory());
    expect(await Promise.all([first, second])).toEqual(["requested", "joined"]);
    expect(a.observation()).toMatchObject({ checkedAtMs: 100, freshness: "fresh" });
    expect(h.onLive).toHaveBeenCalledOnce();
    expect(h.store.read(h.scope())?.listedAtMs).toBe(100);
    await a.refresh();
    expect(h.list).toHaveBeenCalledOnce();
    const restarted = h.acquisition();
    expect(restarted.observation().freshness).toBe("stale");
    h.list.mockRejectedValue(new Error("offline"));
    await restarted.refresh();
    expect(restarted.observation()).toMatchObject({ freshness: "stale", inventory: inventory() });
    expect(h.onLive).toHaveBeenCalledOnce();
  });

  it("persists only changed listings and keeps unchanged checks fresh in memory", async () => {
    const h = harness(); const a = h.acquisition();
    await a.refresh(); vi.mocked(renameSync).mockClear();
    h.advance(60_000); await a.refresh();
    expect(renameSync).not.toHaveBeenCalled();
    expect(a.observation()).toMatchObject({ checkedAtMs: 60_100, freshness: "fresh" });
    expect(h.store.read(h.scope())?.listedAtMs).toBe(100);
    h.advance(600_000);
    expect(a.observation().freshness).toBe("stale");
  });

  it.each([{ ok: false, received: [], removed: [] }, { received: [] }, { received: [row()], removed: [], nextCursor: "next" }, { received: "bad", removed: [] },
    { received: [row(), row()], removed: [] }])("keeps historical facts without reconciling incomplete or unusable responses", async body => {
    const h = harness(); const a = h.acquisition(); await a.refresh();
    h.advance(60_000); h.onLive.mockClear(); h.list.mockResolvedValue(body); await a.refresh();
    expect(a.observation()).toMatchObject({ freshness: "stale", inventory: inventory() });
    expect(h.onLive).not.toHaveBeenCalled();
  });

  it("rejects an old credential generation, account or relay before saving or reconciling", async () => {
    for (const next of [{ userId: "friend", relayUrl: "https://relay.test", generation: 2 },
      { userId: "other", relayUrl: "https://relay.test", generation: 1 },
      { userId: "friend", relayUrl: "https://other.test", generation: 1 }]) {
      const h = harness(); const a = h.acquisition(); const answer = deferred<unknown>();
      h.list.mockImplementationOnce(() => answer.promise);
      const oldScope = h.scope(); const pending = a.refresh(); h.switch(next);
      answer.resolve(inventory()); await pending;
      expect(h.store.read(oldScope)).toBeNull(); expect(h.onLive).not.toHaveBeenCalled();
      expect(a.observation().freshness).toBe("unknown");
    }
  });

  it("invalidates immediately and cannot reconcile a pre-mutation listing", async () => {
    const h = harness(); const a = h.acquisition(); await a.refresh();
    a.invalidate(); expect(a.observation().freshness).toBe("stale");
    h.advance(60_000); const answer = deferred<unknown>(); h.list.mockImplementationOnce(() => answer.promise);
    const pending = a.refresh(); a.invalidate(); h.onLive.mockClear();
    answer.resolve(inventory()); await pending;
    expect(a.observation().freshness).toBe("stale"); expect(h.onLive).not.toHaveBeenCalled();
  });

  it("checks the current generation again while reconciliation is waiting", async () => {
    const h = harness();
    let current: (() => boolean) | undefined;
    const a = createReceivedShareAcquisition({ store: h.store, scope: h.scope, list: h.list,
      onLive: async (_inventory, _scope, isCurrent) => { current = isCurrent; }, logError: h.logError });
    await a.refresh(); expect(current?.()).toBe(true);
    h.switch({ ...h.scope(), generation: 2 }); expect(current?.()).toBe(false);
  });

  it("stores over 1,000 shares by share, including Groups and chats, and strips credentials and other grants", async () => {
    const h = harness(); const a = h.acquisition();
    const raw: Record<string, unknown>[] = Array.from({ length: 1_501 }, (_, i) => ({ ...row(`s-${i}`), token: "secret",
      shareCode: "secret", browserInvitationUrl: "secret", grants: [row("other")] }));
    raw[0] = { ...raw[0], selector: { kind: "group", paths: ["Group"], versionId: null, channelWireId: "wire" }, access: "read-only", fileScope: "served" };
    raw[1] = { ...raw[1], selector: { kind: "chat", channelWireId: "wire" }, access: "read-write" };
    h.list.mockResolvedValue({ received: raw, removed: [] }); await a.refresh();
    expect(a.observation().inventory?.received).toHaveLength(1_501);
    expect(a.observation().inventory?.received[0]).toHaveProperty("fileScope", "served");
    const persisted = readFileSync(h.store.file(h.scope()), "utf8");
    expect(persisted).not.toContain("secret"); expect(persisted).not.toContain('"grants"');
    expect(parseReceivedInventory({ received: [{ ...row(), selector: { paths: [".dohc/credentials"], versionId: null } }], removed: [] })).toBeNull();
    h.switch({ ...h.scope(), userId: "other" }); expect(a.observation().inventory).toBeNull();
  });

  it("labels damaged files unknown and preserves a live observation after a persistence failure", async () => {
    const h = harness(); const a = h.acquisition();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("disk full"); });
    await a.refresh(); expect(a.observation().freshness).toBe("fresh");
    expect(h.logError).toHaveBeenCalledOnce(); expect(h.store.read(h.scope())).toBeNull();
    expect(h.acquisition().observation().freshness).toBe("unknown");
  });
});

it("keeps every ended copy ended when a local removal supersedes live acquisition or exact confirmation", async () => {
  const credentials = { userId: "friend", email: "friend@test.dev", relayUrl: "https://relay.test", serverUrl: "https://account.test", token: "secret" };
  for (const phase of ["inventory", "exact"] as const) {
    const registry = createRegistryStore(join(directory, phase, "workspaces.json"));
    const selector = { paths: ["Notes"], versionId: null, access: "view" as const };
    registry.register({ ...workspace,
      shareView: { shareId: "s", granterEmail: null, genericChatWritable: false, relayUrl: credentials.relayUrl, grantedSelector: selector, ended: true },
      shareMounts: [{ shareId: "s", label: "Notes", granterEmail: null, recipientEmail: credentials.email, relayUrl: credentials.relayUrl, grantedSelector: selector, ended: true }],
      sharedChannels: [{ shareId: "s", channelWireId: "wire", access: "read-only", granterEmail: null, relayUrl: credentials.relayUrl, recipientUserId: "friend", ended: true }],
    });
    const listingReady = deferred<unknown>(); const exactReady = deferred<unknown>(); const lookupStarted = deferred<void>();
    const acquisition = createReceivedShareAcquisition({
      store: createReceivedShareStore(join(directory, phase, "received")), scope: () => ({ ...credentials, generation: 1 }),
      list: () => listingReady.promise, logError: vi.fn(),
      onLive: async (inventory, _scope, isCurrent) => {
        const parsed = readReceivedShareListing(inventory)!;
        await reconcileRecipientSharesAfterLookup({ listing: parsed, credentials,
          currentEntry: () => registry.find("w"), updateEntry: reconcile => registry.reconcileRecipientShares("w", reconcile),
          isCurrent, lookupShare: () => { lookupStarted.resolve(); return exactReady.promise; },
        });
      },
    });
    const pending = acquisition.refresh();
    if (phase === "inventory") acquisition.invalidate();
    listingReady.resolve(inventory());
    if (phase === "exact") {
      await lookupStarted.promise;
      acquisition.invalidate();
      registry.markShareViewEnded("w");
    }
    exactReady.resolve({ ok: true, ...row() }); await pending;
    expect(registry.find("w")?.shareView?.ended).toBe(true);
    expect(registry.find("w")?.shareMounts?.[0]?.ended).toBe(true);
    expect(registry.find("w")?.sharedChannels?.[0]?.ended).toBe(true);
  }
});

it("retires an in-flight received listing before deletion and cannot recreate the account file", async () => {
  const scope = { userId: "friend", relayUrl: "https://relay.test", generation: 1 };
  const store = createReceivedShareStore(join(directory, "received"));
  store.save(scope, parseReceivedInventory(inventory())!, 100);
  const response = deferred<unknown>(); const onLive = vi.fn(async () => undefined);
  const acquisition = createReceivedShareAcquisition({ store, scope: () => scope, list: () => response.promise, onLive, logError: vi.fn() });
  const pending = acquisition.refresh(); acquisition.retire(); store.remove(scope);
  response.resolve(inventory()); await pending;
  expect(store.read(scope)).toBeNull(); expect(onLive).not.toHaveBeenCalled();
  expect(acquisition.observation().freshness).toBe("unknown");
});

it("does not load rosters when listing workspaces or writing unrelated registry metadata", () => {
  const file = join(directory, "workspaces.json");
  const first = createRegistryStore(file); first.register(workspace); first.setShareRoster("w", listing, false, 100);
  vi.mocked(readFileSync).mockClear();
  const reopened = createRegistryStore(file);
  reopened.list(); reopened.markOpened("w", 200);
  expect(vi.mocked(readFileSync).mock.calls.map(([path]) => path)).toEqual([file]);
  expect(reopened.find("w")?.shareRoster?.listedAtMs).toBe(100);
  expect(vi.mocked(readFileSync).mock.calls).toHaveLength(2);
});

it("keeps authorization modules independent of received observations and Access freshness", () => {
  for (const path of [
    "services/sync-relay/src/shareAuthorization.ts", "services/sync-relay/src/shareFilter.ts",
    "apps/desktop/src/workspaces/localDatasetHost.ts", "apps/desktop/src/workspaces/remoteDataset.ts",
  ]) {
    const source = readFileSync(resolve(import.meta.dirname, "../../../..", path), "utf8");
    expect(source, path).not.toMatch(/receivedShareStore|RosterObservation|\.observation\(/);
  }
});

it("leaves received Access refreshes to Sharing opening and Access expansion", () => {
  const main = readFileSync(resolve(import.meta.dirname, "../main.ts"), "utf8");
  const rosterStart = main.indexOf("const shareRosters =");
  const roster = main.slice(rosterStart, main.indexOf("\n});", rosterStart));
  const openStart = main.indexOf("async function openWorkspaceActivityForOperation(");
  const open = main.slice(openStart, main.indexOf("\nasync function ", openStart + 1));
  expect(rosterStart).toBeGreaterThan(0); expect(openStart).toBeGreaterThan(0);
  expect(roster).not.toContain("receivedShareAcquisition.refresh()");
  expect(open).not.toContain("receivedShareAcquisition.refresh()");
});
