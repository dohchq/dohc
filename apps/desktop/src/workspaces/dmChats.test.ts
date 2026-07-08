import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkedChatStore, type LinkedChatStore } from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dmChannelNameFor, listDmRecords, parseDmRecipients } from "./dmChats";
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
