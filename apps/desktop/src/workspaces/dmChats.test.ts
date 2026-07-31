import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkedChatStore, type LinkedChatStore } from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dmChannelNameFor,
  grantDmRecipients,
  listDmRecords,
  matchDmChannelByRecipients,
  parseDmRecipients,
  peekReceivedGrantKind,
  requireShareableChatChannel,
  type ShareLogPage,
} from "./dmChats";
import type { JoinedSharedChannel } from "./registryStore";

// WS-MU-C3 — the desktop DM orchestration: role derivation (owner vs
// participant), display labels, and connected-state — all sourced from the
// local chat store plus the MU-C4 JoinedSharedChannel registry. A DM is a
// `kind:"dm"` channel; participant metadata rides the shared-channel grant.

const WS = "workspace-a";

let roots: string[] = [];
let stores: LinkedChatStore[] = [];

beforeEach(() => {
  roots = [];
  stores = [];
});

afterEach(async () => {
  for (const store of stores) await store.close();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ root: string; store: LinkedChatStore }> {
  const root = await mkdtemp(join(tmpdir(), "dohc-dm-desktop-"));
  roots.push(root);
  const store = createLinkedChatStore(root);
  stores.push(store);
  return { root, store };
}

function joined(overrides: Partial<JoinedSharedChannel> & { channelWireId: string }): JoinedSharedChannel {
  return {
    shareId: "share-1",
    access: "read-write",
    granterEmail: "alice@x.com",
    relayUrl: "http://relay.test",
    ...overrides,
    recipientUserId: overrides.recipientUserId ?? "member-1",
  };
}

describe("parseDmRecipients / dmChannelNameFor", () => {
  it("normalizes, dedupes, sorts, and validates recipient emails", () => {
    expect(parseDmRecipients(" Bob@X.com, alice@y.com  bob@x.com ")).toEqual([
      "alice@y.com",
      "bob@x.com",
    ]);
    expect(() => parseDmRecipients("not-an-email")).toThrow(/email/u);
    expect(() => parseDmRecipients("")).toThrow();
  });

  it("bounds the owner-side channel name to the 80-char cap", () => {
    const many = Array.from({ length: 6 }, (_, i) => `person-${i}@example.com`);
    expect(dmChannelNameFor(["bob@x.com"])).toBe("bob@x.com");
    expect(dmChannelNameFor(many).length).toBeLessThanOrEqual(80);
  });

  it("is PRESENTATION-ONLY: distinct recipient sets sharing a long prefix collide, so the name must never be a dedup key", () => {
    // Two genuinely different recipient sets whose derived names truncate to the
    // same 80-char string. This collision is EXPECTED and acceptable precisely
    // because DM identity is the recipient set (matchDmChannelByRecipients),
    // never this cosmetic name — the regression that fix locks in.
    const longA = `${"a".repeat(78)}1@example.com`;
    const longB = `${"a".repeat(78)}2@example.com`;
    expect(dmChannelNameFor([longA])).toBe(dmChannelNameFor([longB]));
    // The identity key (the sorted recipient set) DOES differ — see the
    // matchDmChannelByRecipients suite, which proves the two never dedupe.
    expect([longA]).not.toEqual([longB]);
  });
});

describe("matchDmChannelByRecipients", () => {
  // The DM's identity is its LIVE grant recipient set — NEVER the (truncatable,
  // collidable) display name. Two distinct recipient sets whose names collide at
  // the 80-char cap must resolve to DIFFERENT channels.
  it("reuses a DM only when its live grant recipient set EXACTLY equals the request, ignoring name collisions", () => {
    const longA = `${"a".repeat(78)}1@example.com`;
    const longB = `${"a".repeat(78)}2@example.com`;
    // Both derive the SAME 80-char-capped display name.
    expect(dmChannelNameFor([longA])).toBe(dmChannelNameFor([longB]));

    // Channel c1 is the live DM to longA (wire w1).
    const channels = [{ id: "c1", wireId: "w1" }];
    const liveGrantEmailsByWire = new Map([["w1", new Set([longA])]]);

    // The colliding request (longB) must NOT reuse c1.
    expect(
      matchDmChannelByRecipients({
        recipients: [longB],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBeNull();

    // The SAME recipient set (longA) reuses c1 (existing behaviour preserved).
    expect(
      matchDmChannelByRecipients({
        recipients: [longA],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBe("c1");
  });

  it("requires the FULL set to match — a subset or superset is a different DM", () => {
    const channels = [{ id: "c1", wireId: "w1" }];
    const liveGrantEmailsByWire = new Map([["w1", new Set(["a@x.com", "b@x.com"])]]);
    // Superset request (a,b) reuses; subset (a) or a different member (a,c) do not.
    expect(
      matchDmChannelByRecipients({
        recipients: ["a@x.com", "b@x.com"],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBe("c1");
    expect(
      matchDmChannelByRecipients({ recipients: ["a@x.com"], channels, liveGrantEmailsByWire }),
    ).toBeNull();
    expect(
      matchDmChannelByRecipients({
        recipients: ["a@x.com", "c@x.com"],
        channels,
        liveGrantEmailsByWire,
      }),
    ).toBeNull();
  });

  it("never matches a channel with no live grants (a fresh/orphaned DM) against a non-empty request", () => {
    const channels = [{ id: "c1", wireId: "w1" }];
    expect(
      matchDmChannelByRecipients({
        recipients: ["a@x.com"],
        channels,
        liveGrantEmailsByWire: new Map(),
      }),
    ).toBeNull();
  });
});

describe("grantDmRecipients", () => {
  it("grants every missing recipient and skips already-covered ones", async () => {
    const created: string[] = [];
    await grantDmRecipients({
      recipients: ["a@x.com", "b@x.com", "c@x.com"],
      covered: new Set(["b@x.com"]),
      createGrant: async (email) => {
        created.push(email);
        return `share-${email}`;
      },
      revokeGrant: async () => {
        throw new Error("must not revoke on the happy path");
      },
    });
    expect(created).toEqual(["a@x.com", "c@x.com"]);
  });

  it("rolls back THIS call's grants and rethrows when a later grant fails (no half-granted channel)", async () => {
    // Simulate the grant POST failing on the 2nd of 2 recipients.
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com", "b@x.com"],
        covered: new Set(),
        createGrant: async (email) => {
          if (email === "b@x.com") throw new Error("grant POST failed");
          return `share-${email}`;
        },
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
      }),
    ).rejects.toThrow(/grant POST failed/u);
    // The first recipient's grant was revoked → the channel has zero live grants.
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("never lets a revoke failure mask the original grant error", async () => {
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com", "b@x.com"],
        covered: new Set(),
        createGrant: async (email) => {
          if (email === "b@x.com") throw new Error("original grant error");
          return `share-${email}`;
        },
        revokeGrant: async () => {
          throw new Error("revoke also failed");
        },
      }),
    ).rejects.toThrow(/original grant error/u);
  });

  it("rolls back with the pinned grant client when the account changes", async () => {
    let current = true;
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com"],
        covered: new Set(),
        createGrant: async (email) => {
          current = false;
          return `share-${email}`;
        },
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        },
      }),
    ).rejects.toThrow("Your dohc Cloud session changed. Try again.");
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("rolls back when the session changes during post-grant preparation", async () => {
    let current = true;
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com"],
        covered: new Set(),
        createGrant: async (email) => `share-${email}`,
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Your dohc Cloud session changed. Try again.");
          }
        },
        beforeCommit: async () => {
          current = false;
        },
      }),
    ).rejects.toThrow("Your dohc Cloud session changed. Try again.");
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("rolls back when the first message mutation fails", async () => {
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com"],
        covered: new Set(),
        createGrant: async (email) => `share-${email}`,
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
        commit: async () => {
          throw new Error("journal write failed");
        },
      }),
    ).rejects.toThrow("journal write failed");
    expect(revoked).toEqual(["share-a@x.com"]);
  });

  it("treats a null shareId as a failed grant and rolls back the rest", async () => {
    // The relay accepting a grant but withholding its id leaves an untrackable
    // grant we could never revoke — so it must fail the call (and roll back the
    // grants we CAN revoke), not slip through untracked.
    const revoked: string[] = [];
    await expect(
      grantDmRecipients({
        recipients: ["a@x.com", "b@x.com"],
        covered: new Set(),
        createGrant: async (email) => (email === "b@x.com" ? null : `share-${email}`),
        revokeGrant: async (shareId) => {
          revoked.push(shareId);
        },
      }),
    ).rejects.toThrow(/no share id/u);
    expect(revoked).toEqual(["share-a@x.com"]);
  });
});

describe("peekReceivedGrantKind", () => {
  // The share-log GET paginates RAW relay rows BEFORE the share filter, so the
  // FIRST page of a normal owner log (workspace.init THEN chat.channel.create)
  // is served EMPTY with hasMore=true. The peek must page nextCursor until the
  // first SERVED op — the create bootstrap — appears; matching the relay's real
  // {ops, nextCursor, hasMore} response shape.
  it("pages past a filtered prefix and detects kind:dm on the first served op", async () => {
    const pages = new Map<number, ShareLogPage>([
      // since=0: workspace.init is filtered out → empty page, cursor advances.
      [0, { ops: [], nextCursor: 1, hasMore: true }],
      // since=1: the chat.channel.create bootstrap is the first served op.
      [
        1,
        {
          ops: [{ opKind: "chat.channel.create", payload: { kind: "dm" } }],
          nextCursor: 2,
          hasMore: false,
        },
      ],
    ]);
    const seen: number[] = [];
    const kind = await peekReceivedGrantKind({
      fetchPage: async (since) => {
        seen.push(since);
        return pages.get(since) ?? null;
      },
    });
    expect(kind).toBe("dm");
    // It actually followed the cursor (did not stop on the empty first page).
    expect(seen).toEqual([0, 1]);
  });

  it("reports a regular kind:channel grant as a definitive not-dm (cacheable)", async () => {
    const kind = await peekReceivedGrantKind({
      fetchPage: async (since) =>
        since === 0
          ? { ops: [], nextCursor: 1, hasMore: true }
          : {
              ops: [{ opKind: "chat.channel.create", payload: { kind: "channel" } }],
              nextCursor: 2,
              hasMore: false,
            },
    });
    expect(kind).toBe("not-dm");
  });

  it("does not cache a malformed bootstrap as a definitive non-DM", async () => {
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({
          ops: [{ opKind: "chat.message.append", payload: {} }],
          nextCursor: 1,
          hasMore: false,
        }),
      }),
    ).resolves.toBe("unknown");
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({
          ops: [{ opKind: "chat.channel.create", payload: {} }],
          nextCursor: 1,
          hasMore: false,
        }),
      }),
    ).resolves.toBe("unknown");
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({
          ops: [{ opKind: "chat.channel.create", payload: { kind: "agent" } }],
          nextCursor: 1,
          hasMore: false,
        }),
      }),
    ).resolves.toBe("unknown");
  });

  it("caps pages scanned but keeps an all-filtered log retryable", async () => {
    let calls = 0;
    const kind = await peekReceivedGrantKind({
      // Every page is empty but keeps claiming hasMore with an advancing cursor.
      fetchPage: async (since) => {
        calls++;
        return { ops: [], nextCursor: since + 1, hasMore: true };
      },
      maxPages: 5,
    });
    expect(kind).toBe("unknown");
    expect(calls).toBe(5);
  });

  it("stops after one page when hasMore carries a stalled cursor", async () => {
    let calls = 0;
    const kind = await peekReceivedGrantKind({
      fetchPage: async (since) => {
        calls++;
        return { ops: [], nextCursor: since, hasMore: true };
      },
    });

    expect(kind).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("stops after one page when hasMore carries a non-numeric cursor", async () => {
    let calls = 0;
    const kind = await peekReceivedGrantKind({
      fetchPage: async () => {
        calls++;
        return { ops: [], nextCursor: "not-a-cursor", hasMore: true };
      },
    });

    expect(kind).toBe("unknown");
    expect(calls).toBe(1);
  });

  it("keeps exhausted and un-fetchable logs transient until a create is visible", async () => {
    await expect(
      peekReceivedGrantKind({
        fetchPage: async () => ({ ops: [], nextCursor: 1, hasMore: false }),
      }),
    ).resolves.toBe("unknown");
    // A page that can't be fetched (network/relay hiccup) is UNKNOWN, never
    // cached as not-dm — otherwise a transient failure would permanently block
    // a real DM from ever auto-joining.
    await expect(
      peekReceivedGrantKind({ fetchPage: async () => null }),
    ).resolves.toBe("unknown");
  });

  it("retries when a grant races ahead of owner ops and detects the DM on the next poll", async () => {
    let ownerBootstrapVisible = false;
    const fetchPage = async (): Promise<ShareLogPage> =>
      ownerBootstrapVisible
        ? {
            ops: [
              { opKind: "chat.channel.create", payload: { kind: "dm" } },
              { opKind: "chat.thread.create", payload: { threadId: "thread-1" } },
              { opKind: "chat.message.append", payload: { messageId: "message-1" } },
            ],
            nextCursor: 3,
            hasMore: false,
          }
        : { ops: [], nextCursor: 0, hasMore: false };

    // First syncDms poll: grant exists, but the owner has not pushed its
    // channel/thread/message bootstrap. UNKNOWN must not enter the non-DM cache.
    await expect(peekReceivedGrantKind({ fetchPage })).resolves.toBe("unknown");
    ownerBootstrapVisible = true;
    // Later poll sees the immutable create and proceeds to auto-join.
    await expect(peekReceivedGrantKind({ fetchPage })).resolves.toBe("dm");
  });
});

describe("requireShareableChatChannel", () => {
  it("rejects a crafted generic-share request for a DM at runtime", async () => {
    const { store } = await makeStore();
    const dm = await store.createChannel({ workspaceId: WS, name: "bob@x.com", kind: "dm" });

    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: dm.id, store }),
    ).rejects.toThrow(/Direct messages can't be shared as channels/u);

    const ordinary = await store.createChannel({ workspaceId: WS, name: "Project room" });
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: ordinary.id, store }),
    ).resolves.toBeUndefined();

    const agent = await store.ensureAgentChannel({ workspaceId: WS });
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: agent.id, store }),
    ).rejects.toThrow(/Only ordinary channels can be shared/u);
    await expect(
      requireShareableChatChannel({ workspaceId: WS, channelId: "missing-channel", store }),
    ).rejects.toThrow(/no longer exists/u);
  });
});

describe("listDmRecords", () => {
  it("derives owner role from wire id == channel id and labels it by the recipient set", async () => {
    const { store } = await makeStore();
    const channel = await store.createChannel({ workspaceId: WS, name: "bob@x.com", kind: "dm" });
    const started = await store.startChannelThread({
      workspaceId: WS,
      channelId: channel.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "user-alice",
      body: "hello",
    });
    // A PLAIN channel never appears in the DM list.
    await store.createChannel({ workspaceId: WS, name: "general-ish" });

    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: [] });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      channelId: channel.id,
      channelWireId: channel.id,
      role: "owner",
      peerLabel: "bob@x.com",
      threadId: started.thread.id,
      shareId: null,
      connected: true,
    });
  });

  it("hides an OWNER DM with no thread (aborted/rolled-back start) but keeps a committed owner DM", async () => {
    const { store } = await makeStore();
    // An aborted start: the channel was created but grants failed → rolled back
    // before the first message, so there is no thread.
    await store.createChannel({ workspaceId: WS, name: "aborted@x.com", kind: "dm" });
    expect(await listDmRecords({ workspaceId: WS, store, sharedChannels: [] })).toHaveLength(0);

    // A committed owner DM (first message sent → a thread exists) still shows.
    const live = await store.createChannel({ workspaceId: WS, name: "bob@x.com", kind: "dm" });
    await store.startChannelThread({
      workspaceId: WS,
      channelId: live.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "user-alice",
      body: "hi",
    });
    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: [] });
    expect(dms.map((d) => d.channelId)).toEqual([live.id]);
  });

  it("keeps a PARTICIPANT DM with no thread yet visible (a real pending conversation)", async () => {
    const { store } = await makeStore();
    // A replayed DM whose owner granted before sending — channel.create only,
    // no thread.create yet. It must remain visible (not treated as an orphan).
    await store.applyReplicationOp({
      workspaceId: WS,
      originId: "origin-owner",
      originSeq: 0,
      opKind: "chat.channel.create",
      payload: {
        channelId: "owner-channel-1",
        name: "bob@x.com",
        slug: "bob-x-com",
        kind: "dm",
        createdAtMs: 1,
        wireId: "owner-channel-1",
      },
      recordedAtMs: 1,
    });
    const registry = [joined({ shareId: "share-1", channelWireId: "owner-channel-1" })];
    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: registry });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      role: "participant",
      channelWireId: "owner-channel-1",
      threadId: null,
      connected: true,
    });
  });

  it("derives participant role from a replayed channel and labels it by the GRANTER, not the replicated name", async () => {
    const { store } = await makeStore();
    // A replayed DM: the wire id is the OWNER's channel id; the local channel
    // id is minted fresh — exactly what pullSharedChannel's applyReplicationOp
    // produces for a joined channel.
    await store.applyReplicationOp({
      workspaceId: WS,
      originId: "origin-owner",
      originSeq: 0,
      opKind: "chat.channel.create",
      payload: {
        channelId: "owner-channel-1",
        // The owner's recipient list — i.e. THIS participant's own address.
        name: "bob@x.com",
        slug: "bob-x-com",
        kind: "dm",
        createdAtMs: 1,
        wireId: "owner-channel-1",
      },
      recordedAtMs: 1,
    });
    await store.applyReplicationOp({
      workspaceId: WS,
      originId: "origin-owner",
      originSeq: 1,
      opKind: "chat.thread.create",
      payload: {
        threadId: "thread-dm",
        title: "",
        createdAtMs: 2,
        channelSlug: "bob-x-com",
        channelWireId: "owner-channel-1",
      },
      recordedAtMs: 2,
    });

    const registry = [joined({ shareId: "share-1", channelWireId: "owner-channel-1" })];
    const dms = await listDmRecords({ workspaceId: WS, store, sharedChannels: registry });
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatchObject({
      channelWireId: "owner-channel-1",
      role: "participant",
      // Labelled by the GRANTER — the replicated name is the participant's own
      // address and would otherwise read as a DM with themselves.
      peerLabel: "alice@x.com",
      shareId: "share-1",
      threadId: "thread-dm",
      connected: true,
    });

    // The grant ends (revoked / owner gone): reading stays, sending closes.
    const ended = await listDmRecords({
      workspaceId: WS,
      store,
      sharedChannels: [joined({ shareId: "share-1", channelWireId: "owner-channel-1", ended: true })],
    });
    expect(ended[0]).toMatchObject({ role: "participant", connected: false });

    // No matching grant at all (the honest end-of-share): still a participant,
    // still readable, disconnected — and the replicated name is the fallback.
    const orphaned = await listDmRecords({ workspaceId: WS, store, sharedChannels: [] });
    expect(orphaned[0]).toMatchObject({
      role: "participant",
      connected: false,
      shareId: null,
      peerLabel: "bob@x.com",
    });
  });
});
