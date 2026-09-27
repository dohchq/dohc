import { describe, expect, it } from "vitest";
import type { CloudCredentials } from "./cloudCredentialStore";
import {
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
  it("resumes an ended mount, view and channel whose share is active again, keeping their pins", () => {
    const before = entry({
      shareView: { shareId: "view", granterEmail: null, genericChatWritable: false, grantedSelector: selector, ended: true, relayUrl: credentials.relayUrl! },
      shareMounts: [mount("mount", { ended: true })],
      sharedChannels: [channel("chat", { ended: true })],
      confirmedRemovedShares: [{ shareId: "mount", removedAtMs: 1 }],
    });
    const after = reconcileRecipientShares(before, listing(["view", "mount", "chat"]), credentials);
    expect(after).toEqual(entry({
      shareView: { shareId: "view", granterEmail: null, genericChatWritable: false, grantedSelector: selector, relayUrl: credentials.relayUrl! },
      shareMounts: [mount("mount")],
      sharedChannels: [channel("chat")],
    }));
    expect(after?.shareMounts?.[0]?.grantedSelector).toBe(selector);
  });

  it("leaves a channel the person left alone even though its grant is active", () => {
    const before = entry({ sharedChannels: [channel("chat", { ended: true, left: true })] });
    expect(reconcileRecipientShares(before, listing(["chat"]), credentials)).toBeNull();
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
      before, listing(["other-relay", "other-account", "other-user"], [["other-user", 2]]), credentials,
    )).toBeNull();
  });

  it("records the owner's confirmed removals for shares this entry holds, and drops them once active again", () => {
    const before = entry({
      shareMounts: [mount("mount", { ended: true })],
      sharedChannels: [channel("chat", { ended: true }), channel("live")],
    });
    const removed = reconcileRecipientShares(
      before, listing(["live"], [["mount", 10], ["chat", 11], ["not-held", 12]]), credentials,
    );
    expect(removed?.confirmedRemovedShares).toEqual([
      { shareId: "mount", removedAtMs: 10 }, { shareId: "chat", removedAtMs: 11 },
    ]);
    expect(removed?.shareMounts?.[0]?.ended).toBe(true);
    expect(reconcileRecipientShares(removed!, listing(["live"], [["mount", 10], ["chat", 11]]), credentials)).toBeNull();

    const restored = reconcileRecipientShares(removed!, listing(["live", "mount", "chat"]), credentials);
    expect(restored?.confirmedRemovedShares).toBeUndefined();
    expect(restored?.shareMounts?.[0]?.ended).toBeUndefined();
    expect(restored?.sharedChannels?.map((row) => row.ended)).toEqual([undefined, undefined]);
  });

  it("keeps confirmed removal evidence when it falls outside the capped history listing", () => {
    const before = entry({
      shareMounts: [mount("old", { ended: true })],
      confirmedRemovedShares: [{ shareId: "old", removedAtMs: 1 }],
    });
    expect(reconcileRecipientShares(before, listing([]), credentials)).toBeNull();
  });

  it("does not resume a record the listing lists as removed, only one it lists as active", () => {
    const before = entry({ shareMounts: [mount("mount", { ended: true })] });
    const after = reconcileRecipientShares(before, listing([], [["mount", 10]]), credentials);
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
