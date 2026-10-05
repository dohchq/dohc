import { join } from "node:path";
import { createRegistryStore } from "./registryStore";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import { describe, expect, it, vi } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import {
  exactReceivedShareIsActive,
  reconcileRecipientSharesAfterLookup,
  recipientShareNeedsRecheck,
  readReceivedShareListing,
  reconcileRecipientShares,
  type ReceivedShareListing,
} from "./recipientShareReconciliation";
import type { JoinedSharedChannel, RegistryEntry, ShareMountRecord } from "./registryStore";

const credentials: CloudCredentials = {
  serverUrl: "https://account.test", relayUrl: "https://relay.test",
  token: "token", userId: "member", email: "member@test.example",
};
const selector = { paths: ["docs"], versionId: null, access: "view" as const };

function mount(shareId: string, overrides: Partial<ShareMountRecord> = {}): ShareMountRecord {
  return {
    shareId, label: shareId, granterEmail: "owner@test.example", relayUrl: credentials.relayUrl!,
    recipientEmail: credentials.email, grantedSelector: selector, ...overrides,
  };
}

function channel(shareId: string, overrides: Partial<JoinedSharedChannel> = {}): JoinedSharedChannel {
  return {
    shareId, channelWireId: `wire-${shareId}`, access: "read-write",
    granterEmail: "owner@test.example", relayUrl: credentials.relayUrl!,
    recipientUserId: credentials.userId, ...overrides,
  };
}

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return { workspaceId: "ws", rootPath: "/ws", kind: "personal", mode: "local-first", ...overrides };
}

function listing(received: string[], removed: Array<[string, number]> = []): ReceivedShareListing {
  return {
    received: new Set(received),
    removed: removed.map(([shareId, removedAtMs]) => ({ shareId, removedAtMs })),
  };
}

describe("readReceivedShareListing", () => {
  it("reads the active ids and the removed rows, and refuses a lane that is not an array", () => {
    expect(readReceivedShareListing({
      received: [{ shareId: "a" }, { shareId: 7 }, null],
      removed: [{ shareId: "b", removedAtMs: 5, message: "The owner removed your access." }, { shareId: "c" }],
    })).toEqual({ received: new Set(["a"]), removed: [{ shareId: "b", removedAtMs: 5 }] });
    expect(readReceivedShareListing({})).toEqual({ received: new Set(), removed: [] });
    expect(readReceivedShareListing({ received: "a" })).toBeNull();
    expect(readReceivedShareListing({ removed: {} })).toBeNull();
    expect(readReceivedShareListing(null)).toBeNull();
  });
});

describe("reconcileRecipientShares", () => {
  it.each(["mount", "view", "channel"])("does not resume an ended %s from an inventory alone", (kind) => {
    const before = entry({
      ...(kind === "mount" ? { shareMounts: [mount("share", { ended: true })] } : {}),
      ...(kind === "view" ? { shareView: {
        shareId: "share", granterEmail: null, genericChatWritable: false,
        grantedSelector: selector, relayUrl: credentials.relayUrl!, ended: true,
      } } : {}),
      ...(kind === "channel" ? { sharedChannels: [channel("share", { ended: true })] } : {}),
      confirmedRemovedShares: [{ shareId: "share", removedAtMs: 10 }],
    });
    expect(reconcileRecipientShares(before, listing(["share"]), credentials, new Set())).toBeNull();
  });

  it("resumes an ended mount, view and channel whose share is active again, keeping their pins", () => {
    const before = entry({
      shareView: { shareId: "view", granterEmail: null, genericChatWritable: false, grantedSelector: selector, ended: true, relayUrl: credentials.relayUrl! },
      shareMounts: [mount("mount", { ended: true })],
      sharedChannels: [channel("chat", { ended: true })],
      confirmedRemovedShares: [{ shareId: "mount", removedAtMs: 1 }],
    });
    const after = reconcileRecipientShares(before, listing(["view", "mount", "chat"]), credentials, new Set(["view", "mount", "chat"]));
    expect(after).toEqual(entry({
      shareView: { shareId: "view", granterEmail: null, genericChatWritable: false, grantedSelector: selector, relayUrl: credentials.relayUrl! },
      shareMounts: [mount("mount")],
      sharedChannels: [channel("chat")],
    }));
    expect(after?.shareMounts?.[0]?.grantedSelector).toBe(selector);
  });

  it("leaves a channel the person left alone even though its grant is active", () => {
    const before = entry({ sharedChannels: [channel("chat", { ended: true, left: true })] });
    expect(reconcileRecipientShares(before, listing(["chat"]), credentials, new Set(["chat"]))).toBeNull();
  });

  it("does not speak for records pinned to another relay or account", () => {
    const before = entry({
      shareMounts: [
        mount("other-relay", { ended: true, relayUrl: "https://elsewhere.test" }),
        mount("other-account", { ended: true, recipientEmail: "someone@test.example" }),
      ],
      sharedChannels: [channel("other-user", { ended: true, recipientUserId: "someone" })],
      confirmedRemovedShares: [{ shareId: "other-relay", removedAtMs: 1 }],
    });
    expect(reconcileRecipientShares(
      before, listing(["other-relay", "other-account", "other-user"], [["other-user", 2]]), credentials, new Set(["other-relay", "other-account", "other-user"]),
    )).toBeNull();
  });

  it("records the owner's confirmed removals for shares this entry holds, and drops them once active again", () => {
    const before = entry({
      shareMounts: [mount("mount", { ended: true })],
      sharedChannels: [channel("chat", { ended: true }), channel("live")],
    });
    const removed = reconcileRecipientShares(
      before, listing(["live"], [["mount", 10], ["chat", 11], ["not-held", 12]]), credentials, new Set(),
    );
    expect(removed?.confirmedRemovedShares).toEqual([
      { shareId: "mount", removedAtMs: 10 }, { shareId: "chat", removedAtMs: 11 },
    ]);
    expect(removed?.shareMounts?.[0]?.ended).toBe(true);
    expect(reconcileRecipientShares(removed!, listing(["live"], [["mount", 10], ["chat", 11]]), credentials, new Set())).toBeNull();

    const restored = reconcileRecipientShares(removed!, listing(["live", "mount", "chat"]), credentials, new Set(["live", "mount", "chat"]));
    expect(restored?.confirmedRemovedShares).toBeUndefined();
    expect(restored?.shareMounts?.[0]?.ended).toBeUndefined();
    expect(restored?.sharedChannels?.map((row) => row.ended)).toEqual([undefined, undefined]);
  });

  it("keeps confirmed removal evidence when it falls outside the capped history listing", () => {
    const before = entry({
      shareMounts: [mount("old", { ended: true })],
      confirmedRemovedShares: [{ shareId: "old", removedAtMs: 1 }],
    });
    expect(reconcileRecipientShares(before, listing([]), credentials, new Set())).toBeNull();
  });

  it("does not resume a record the listing lists as removed, only one it lists as active", () => {
    const before = entry({ shareMounts: [mount("mount", { ended: true })] });
    const after = reconcileRecipientShares(before, listing([], [["mount", 10]]), credentials, new Set());
    expect(after?.shareMounts?.[0]?.ended).toBe(true);
  });
});

describe("recipientShareNeedsRecheck", () => {
  it("rechecks ended copies even without removal evidence or after an offline Undo", () => {
    expect(recipientShareNeedsRecheck(entry({ shareMounts: [mount("mount", { ended: true })] }))).toBe(true);
    expect(recipientShareNeedsRecheck(entry({
      sharedChannels: [channel("chat", { ended: true })],
      confirmedRemovedShares: [{ shareId: "chat", removedAtMs: 1 }],
    }))).toBe(true);
  });
  it("does not recheck active copies or groups the recipient chose to leave", () => {
    expect(recipientShareNeedsRecheck(entry({ sharedChannels: [channel("chat", { ended: true, left: true })] }))).toBe(false);
    expect(recipientShareNeedsRecheck(entry({ shareMounts: [mount("mount")] }))).toBe(false);
  });
});

function exactShare(shareId: string) {
  return { ok: true, shareId, selector: { paths: ["docs"], versionId: null }, access: "view" };
}

async function lookupHarness(before: RegistryEntry) {
  const scratch = await createTestScratch("dohc-share-reconcile-");
  const store = createRegistryStore(join(scratch, "registry.json"));
  store.register(before);
  const session = { current: true };
  const lookupShare = vi.fn(async (shareId: string): Promise<unknown> => exactShare(shareId));
  const run = (received: ReceivedShareListing) => reconcileRecipientSharesAfterLookup({
    listing: received, credentials,
    currentEntry: () => store.find(before.workspaceId),
    updateEntry: reconcile => store.reconcileRecipientShares(before.workspaceId, reconcile),
    isCurrent: () => session.current,
    lookupShare,
  });
  return { store, session, lookupShare, run, current: () => store.find(before.workspaceId)! };
}

function endedEntry(kind: string): RegistryEntry {
  return entry({
    ...(kind === "mount" ? { shareMounts: [mount("share", { ended: true })] } : {}),
    ...(kind === "view" ? { shareView: {
      shareId: "share", granterEmail: null, genericChatWritable: false,
      grantedSelector: selector, relayUrl: credentials.relayUrl!, ended: true,
    } } : {}),
    ...(kind === "channel" ? { sharedChannels: [channel("share", { ended: true })] } : {}),
    confirmedRemovedShares: [{ shareId: "share", removedAtMs: 10 }],
  });
}

function observeEnded(store: ReturnType<typeof createRegistryStore>, kind: string) {
  const current = store.find("ws")!;
  if (kind === "view") store.markShareViewEnded("ws");
  if (kind === "mount") store.setShareMounts("ws", current.shareMounts!.map(row => ({ ...row, ended: true })));
  if (kind === "channel") store.setSharedChannels("ws", current.sharedChannels!.map(row => ({ ...row, ended: true })));
}

function hasEnded(current: RegistryEntry, kind: string) {
  return kind === "view" ? current.shareView?.ended : kind === "mount"
    ? current.shareMounts?.[0]?.ended : current.sharedChannels?.[0]?.ended;
}

describe("reconcileRecipientSharesAfterLookup", () => {
  it.each(["mount", "view", "channel"])("confirms an ended %s after the last removal and keeps its pinned scope", async kind => {
    const before = endedEntry(kind);
    const h = await lookupHarness(before);
    observeEnded(h.store, kind);
    const snapshot = h.current();
    h.lookupShare.mockImplementation(async shareId => {
      expect(h.current()).toBe(snapshot);
      expect(hasEnded(h.current(), kind)).toBe(true);
      return exactShare(shareId);
    });
    expect(await h.run(listing(["share"]))).toBe(true);
    expect(h.lookupShare).toHaveBeenCalledExactlyOnceWith("share");
    expect(hasEnded(h.current(), kind)).toBeUndefined();
    expect(h.current().confirmedRemovedShares).toBeUndefined();
    if (kind === "mount") expect(h.current().shareMounts?.[0]?.grantedSelector).toBe(selector);
    if (kind === "view") expect(h.current().shareView?.grantedSelector).toBe(selector);
  });

  it.each(["mount", "view", "channel"])("rejects an exact reply superseded by another %s end observation", async kind => {
    const h = await lookupHarness(endedEntry(kind));
    const started = deferred();
    const reply = deferred<unknown>();
    h.lookupShare.mockImplementation(() => { started.resolve(); return reply.promise; });
    const pending = h.run(listing(["share"]));
    await started.promise;
    // Repeat the same marker. Comparing serialized contents would miss this observation.
    observeEnded(h.store, kind);
    reply.resolve(exactShare("share"));
    expect(await pending).toBe(false);
    expect(hasEnded(h.current(), kind)).toBe(true);
    expect(h.current().confirmedRemovedShares).toEqual([{ shareId: "share", removedAtMs: 10 }]);
    h.lookupShare.mockResolvedValue(exactShare("share"));
    expect(await h.run(listing(["share"]))).toBe(true);
  });

  it("keeps newer removal evidence when another acquisition finishes during the exact read", async () => {
    const h = await lookupHarness(endedEntry("mount"));
    const started = deferred();
    const reply = deferred<unknown>();
    h.lookupShare.mockImplementation(() => { started.resolve(); return reply.promise; });
    const pending = h.run(listing(["share"]));
    await started.promise;
    expect(await h.run(listing([], [["share", 20]]))).toBe(true);
    reply.resolve(exactShare("share"));
    expect(await pending).toBe(false);
    expect(h.current().shareMounts?.[0]?.ended).toBe(true);
    expect(h.current().confirmedRemovedShares).toEqual([{ shareId: "share", removedAtMs: 20 }]);
  });

  it.each(["credentials", "workspace"])("rejects a reply after the %s changes", async kind => {
    const h = await lookupHarness(endedEntry("mount"));
    const started = deferred();
    const reply = deferred<unknown>();
    h.lookupShare.mockImplementation(() => { started.resolve(); return reply.promise; });
    const pending = h.run(listing(["share"]));
    await started.promise;
    if (kind === "credentials") h.session.current = false;
    else h.store.remove("ws");
    reply.resolve(exactShare("share"));
    expect(await pending).toBe(false);
    if (kind === "credentials") expect(h.current().shareMounts?.[0]?.ended).toBe(true);
    else expect(h.store.find("ws")).toBeNull();
  });

  it.each([null, {}, { ok: true, shareId: "other", selector: {}, access: "view" },
    { ...exactShare("share"), selector: null, damaged: true },
    { ...exactShare("share"), ok: false }, { ...exactShare("share"), access: "unknown" },
  ])("keeps ended records and removal evidence after an unusable lookup %j", async body => {
    const h = await lookupHarness(endedEntry("mount"));
    h.lookupShare.mockResolvedValue(body);
    expect(await h.run(listing(["share"]))).toBe(false);
    expect(h.current()).toEqual(endedEntry("mount"));
  });

  it("isolates denied, offline and timed-out lookups from a usable restored share", async () => {
    const h = await lookupHarness(entry({ shareMounts: [
      mount("denied", { ended: true }), mount("offline", { ended: true }),
      mount("timeout", { ended: true }), mount("restored", { ended: true }),
    ] }));
    h.lookupShare.mockImplementation(async shareId => {
      if (shareId !== "restored") throw new Error(shareId);
      return exactShare(shareId);
    });
    expect(await h.run(listing(["denied", "offline", "timeout", "restored"]))).toBe(true);
    expect(h.current().shareMounts?.map(row => row.ended)).toEqual([true, true, true, undefined]);
  });

  it("deduplicates a Group's folder and channel into one exact lookup", async () => {
    const h = await lookupHarness(entry({
      shareMounts: [mount("group", { ended: true })],
      sharedChannels: [channel("group", { ended: true })],
    }));
    h.lookupShare.mockResolvedValue({ ok: true, shareId: "group", access: "read-write",
      selector: { kind: "group", channelWireId: "wire-group", paths: ["docs"], versionId: null } });
    expect(await h.run(listing(["group"]))).toBe(true);
    expect(h.lookupShare).toHaveBeenCalledExactlyOnceWith("group");
    expect(h.current().shareMounts?.[0]?.ended).toBeUndefined();
    expect(h.current().sharedChannels?.[0]?.ended).toBeUndefined();
  });

  it("does not look up active, removed, left, or other-account and other-relay records", async () => {
    const before = entry({
      shareView: { ...endedEntry("view").shareView!, relayUrl: "https://other.test" },
      shareMounts: [mount("live"), mount("removed", { ended: true }),
        mount("other", { ended: true, recipientEmail: "other@test.example" })],
      sharedChannels: [channel("left", { ended: true, left: true }),
        channel("other-user", { ended: true, recipientUserId: "other" })],
    });
    const h = await lookupHarness(before);
    expect(await h.run(listing(["share", "live", "left", "other", "other-user"]))).toBe(false);
    expect(h.lookupShare).not.toHaveBeenCalled();
    expect(h.current()).toEqual(before);
  });

  it("requires confirmation before clearing removal evidence even without an end marker", async () => {
    const before = entry({ shareMounts: [mount("share")],
      confirmedRemovedShares: [{ shareId: "share", removedAtMs: 10 }] });
    const h = await lookupHarness(before);
    h.lookupShare.mockResolvedValue(null);
    expect(await h.run(listing(["share"]))).toBe(false);
    expect(h.current()).toEqual(before);
    h.lookupShare.mockResolvedValue(exactShare("share"));
    expect(await h.run(listing(["share"]))).toBe(true);
    expect(h.current().confirmedRemovedShares).toBeUndefined();
  });

  it("keeps a removal when a contradictory inventory also reports the share active", async () => {
    const h = await lookupHarness(endedEntry("mount"));
    expect(await h.run(listing(["share"], [["share", 20]]))).toBe(true);
    expect(h.lookupShare).not.toHaveBeenCalled();
    expect(h.current().shareMounts?.[0]?.ended).toBe(true);
    expect(h.current().confirmedRemovedShares).toEqual([{ shareId: "share", removedAtMs: 20 }]);
  });
});

describe("exactReceivedShareIsActive", () => {
  it("accepts file, chat and Group confirmations and refuses missing or damaged authority", () => {
    expect(exactReceivedShareIsActive(exactShare("share"), "share")).toBe(true);
    for (const kind of ["chat", "group"]) {
      expect(exactReceivedShareIsActive({ ok: true, shareId: "share", access: "read-only",
        selector: { kind, channelWireId: "wire" } }, "share")).toBe(true);
      expect(exactReceivedShareIsActive({ ok: true, shareId: "share", access: "edit",
        selector: { kind, channelWireId: "wire" } }, "share")).toBe(false);
    }
    expect(exactReceivedShareIsActive({ ...exactShare("share"),
      selector: { paths: [], versionId: null } }, "share")).toBe(false);
  });
});
