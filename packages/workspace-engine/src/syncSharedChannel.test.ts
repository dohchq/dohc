import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceId } from "@dohc/workspace-contracts/engine";
import {
  ShareUnavailableError,
  SharedChannelReadOnlyError,
} from "@dohc/workspace-contracts/relay";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createLinkedChatStore } from "./linkedChatStore";
import { VERSIONED_TEXT_STORE_RELATIVE_PATH } from "./versionedTextStore";
import {
  fetchSharedChannelInfo,
  pullSharedChannel,
  pushSharedChannel,
} from "./syncSharedChannel";

// MU-C4 member-side unit tests against a HAND-ROLLED relay double. The double
// exists to simulate what the REAL relay must never do (serve another
// channel's ops, serve non-chat ops) and to capture exactly what the client
// pushes — the honest end-to-end convergence proof over the real relay lives
// in services/sync-relay main.integration.test.ts.

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): { changes: number };
    };
    close(): void;
  };
};

const WORKSPACE = "shared-channel-member-ws" as WorkspaceId;
const SHARE_ID = "share-chan-1";
const TOKEN = "token-member";
const WIRE = "wire-team";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-shared-channel-"));
  roots.push(root);
  return root;
}

interface FakeOp {
  relaySeq: number;
  originId: string;
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
  recordedAtMs: number;
}

class FakeChannelRelay {
  ops: FakeOp[] = [];
  ended = false;
  readOnly = false;
  appends: Array<{ originId: string; ops: Array<Record<string, unknown>> }> = [];
  private nextSeq = 1;
  private originSeqs = new Map<string, number>();

  addOp(originId: string, opKind: string, payload: Record<string, unknown>): void {
    const originSeq = this.originSeqs.get(originId) ?? 0;
    this.originSeqs.set(originId, originSeq + 1);
    this.ops.push({
      relaySeq: this.nextSeq++,
      originId,
      originSeq,
      opKind,
      payload,
      recordedAtMs: 1000 + this.nextSeq,
    });
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const parsed = new URL(href);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const notFound = () =>
      Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 });
    if (this.ended) return notFound();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sync" || parts[1] !== "shares" || parts[2] !== SHARE_ID) return notFound();
    if (parts.length === 3) {
      return Response.json({
        ok: true,
        shareId: SHARE_ID,
        granterUserId: "granter",
        granterEmail: "granter@dohc.test",
        selector: {
          kind: "chat-channel",
          channelWireId: WIRE,
          access: this.readOnly ? "read-only" : "read-write",
        },
        createdAtMs: 42,
      });
    }
    if (parts.length === 4 && parts[3] === "log" && (init?.method ?? "GET") === "POST") {
      if (this.readOnly) {
        return Response.json(
          { ok: false, error: "read only", code: "share_read_only" },
          { status: 403 },
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        originId: string;
        ops: Array<Record<string, unknown>>;
      };
      this.appends.push(body);
      // Mirror the real relay: appended ops re-enter the served log under the
      // share-namespaced origin.
      for (const op of body.ops) {
        this.ops.push({
          relaySeq: this.nextSeq++,
          originId: `share:${SHARE_ID}:${body.originId}`,
          originSeq: Number(op.originSeq),
          opKind: String(op.opKind),
          payload: op.payload as Record<string, unknown>,
          recordedAtMs: Number(op.recordedAtMs),
        });
      }
      return Response.json({
        ok: true,
        accepted: body.ops.length,
        inserted: body.ops.length,
        skipped: 0,
        currentMaxOriginSeq: body.ops.length - 1,
      });
    }
    if (parts.length === 4 && parts[3] === "log") {
      const since = Number(parsed.searchParams.get("since") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 100);
      const rows = this.ops.filter((op) => op.relaySeq > since).slice(0, limit);
      const last = rows[rows.length - 1];
      return Response.json({
        ok: true,
        ops: rows,
        nextCursor: last?.relaySeq ?? since,
        hasMore: rows.length === limit && this.ops.some((op) => op.relaySeq > (last?.relaySeq ?? since)),
      });
    }
    return notFound();
  };
}

function relayFor(fake: FakeChannelRelay) {
  return { baseUrl: "http://relay.test", token: TOKEN, fetch: fake.fetch };
}

function seedGrantedChannel(fake: FakeChannelRelay): void {
  fake.addOp("origin-owner", "chat.channel.create", {
    channelId: "chan-owner",
    name: "team",
    slug: "team",
    kind: "channel",
    createdAtMs: 1,
    wireId: WIRE,
  });
  fake.addOp("origin-owner", "chat.thread.create", {
    threadId: "thread-team-1",
    title: "",
    createdAtMs: 1,
    channelSlug: "team",
    channelWireId: WIRE,
  });
  fake.addOp("origin-owner", "chat.message.append", {
    messageId: "msg-owner-1",
    threadId: "thread-team-1",
    authorKind: "human",
    authorDisplayName: "Owner",
    authorUserId: "granter",
    body: "welcome",
    createdAtMs: 1,
  });
}

async function teamMessages(root: string): Promise<string[]> {
  const chats = createLinkedChatStore(root);
  try {
    const channels = await chats.listChannels({ workspaceId: WORKSPACE });
    const team = channels.find((channel) => channel.slug === "team");
    if (!team) return [];
    const threads = await chats.listChannelThreads({ workspaceId: WORKSPACE, channelId: team.id });
    const rows: string[] = [];
    for (const summary of threads) {
      const messages = await chats.listMessages({ workspaceId: WORKSPACE, threadId: summary.thread.id });
      rows.push(...messages.map((message) => `${message.id}:${message.body}`));
    }
    return rows.sort();
  } finally {
    await chats.close();
  }
}

describe("pullSharedChannel", () => {
  it("replays the granted channel and fails closed on everything a honest relay would never serve", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    // A HOSTILE/BUGGY relay slipping foreign content into the share stream:
    // another channel, a foreign thread, a foreign-thread message, a file op,
    // an unknown kind. The client-side scope gate must drop every one.
    fake.addOp("origin-owner", "chat.channel.create", {
      channelId: "chan-leak",
      name: "SENTINEL-other-channel",
      slug: "other",
      kind: "channel",
      createdAtMs: 1,
      wireId: "wire-other",
    });
    fake.addOp("origin-owner", "chat.thread.create", {
      threadId: "thread-leak-1",
      title: "SENTINEL-other-thread",
      createdAtMs: 1,
      channelSlug: "other",
      channelWireId: "wire-other",
    });
    fake.addOp("origin-owner", "chat.message.append", {
      messageId: "msg-leak-1",
      threadId: "thread-leak-1",
      authorKind: "human",
      authorDisplayName: "Owner",
      body: "SENTINEL-other-message",
      createdAtMs: 1,
    });
    fake.addOp("origin-owner", "moment.append", {
      versionId: "main",
      path: "docs/SENTINEL-file.md",
      operation: "write",
    });
    fake.addOp("origin-owner", "made.up.kind", { threadId: "thread-team-1" });

    const root = await tempRoot();
    const info = await fetchSharedChannelInfo({ relay: relayFor(fake), shareId: SHARE_ID });
    expect(info).toMatchObject({ channelWireId: WIRE, access: "read-write" });
    const result = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay: relayFor(fake),
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(5);

    expect(await teamMessages(root)).toEqual(["msg-owner-1:welcome"]);
    const chats = createLinkedChatStore(root);
    try {
      const channels = await chats.listChannels({ workspaceId: WORKSPACE });
      expect(channels.map((channel) => channel.slug)).toEqual(["team"]);
      const threads = await chats.listThreads({ workspaceId: WORKSPACE });
      expect(threads.map((thread) => thread.id)).toEqual(["thread-team-1"]);
    } finally {
      await chats.close();
    }
  });

  it("replays a kind:\"dm\" channel byte-identically and still drops a foreign-channel injection (WS-MU-C3)", async () => {
    // A DM rides the SAME shared-channel lane as a regular channel — the only
    // difference on the wire is `kind:"dm"` on the channel.create. The
    // participant-side scope gate (opBelongsToChannel) must replay the DM and
    // drop anything a hostile/buggy relay slips in, exactly as for a channel.
    const fake = new FakeChannelRelay();
    fake.addOp("origin-owner", "chat.channel.create", {
      channelId: "chan-dm-owner",
      name: "bob@dohc.test",
      slug: "bob-dohc-test",
      kind: "dm",
      createdAtMs: 1,
      wireId: WIRE,
    });
    fake.addOp("origin-owner", "chat.thread.create", {
      threadId: "thread-dm-1",
      title: "",
      createdAtMs: 1,
      channelSlug: "bob-dohc-test",
      channelWireId: WIRE,
    });
    fake.addOp("origin-owner", "chat.message.append", {
      messageId: "msg-dm-1",
      threadId: "thread-dm-1",
      authorKind: "human",
      authorDisplayName: "Alice",
      authorUserId: "granter",
      body: "hello bob",
      createdAtMs: 1,
    });
    // Injection: another channel's thread + message, and a message into an
    // unknown thread. Both must be dropped on the participant's pull.
    fake.addOp("origin-owner", "chat.thread.create", {
      threadId: "thread-other-1",
      title: "SENTINEL-other-thread",
      createdAtMs: 1,
      channelSlug: "other",
      channelWireId: "wire-other",
    });
    fake.addOp("origin-owner", "chat.message.append", {
      messageId: "msg-inject-1",
      threadId: "thread-nowhere",
      authorKind: "human",
      authorDisplayName: "Alice",
      body: "SENTINEL-injected",
      createdAtMs: 1,
    });

    const root = await tempRoot();
    const info = await fetchSharedChannelInfo({ relay: relayFor(fake), shareId: SHARE_ID });
    expect(info).toMatchObject({ channelWireId: WIRE, access: "read-write" });
    const result = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay: relayFor(fake),
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    // The 3 DM ops applied; the 2 injected ops skipped.
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(2);

    const chats = createLinkedChatStore(root);
    try {
      const channels = await chats.listChannels({ workspaceId: WORKSPACE });
      // The channel materialized as a DM — kind preserved across the share —
      // and no foreign channel leaked in.
      expect(channels).toHaveLength(1);
      expect(channels[0]!.kind).toBe("dm");
      const messages = await chats.listMessages({ workspaceId: WORKSPACE, threadId: "thread-dm-1" });
      expect(messages.map((m) => m.body)).toEqual(["hello bob"]);
      const serialized = JSON.stringify(await chats.listThreads({ workspaceId: WORKSPACE }));
      expect(serialized).not.toContain("SENTINEL");
    } finally {
      await chats.close();
    }
  });

  it("never applies served ops into a LOCAL thread that is not bound to the granted channel (private-thread injection)", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const relay = relayFor(fake);

    // A local PRIVATE channel thread the member already has. A hostile member
    // (or relay) who learns its threadId must not be able to inject into it.
    const chats = createLinkedChatStore(root);
    let privateThreadId: string;
    let privateMessageId: string;
    try {
      const personal = await chats.createChannel({ workspaceId: WORKSPACE, name: "personal" });
      const started = await chats.startChannelThread({
        workspaceId: WORKSPACE,
        channelId: personal.id,
        author: { kind: "human", displayName: "Member" },
        body: "PRIVATE-original",
      });
      privateThreadId = started.thread.id;
      privateMessageId = started.message.id;
    } finally {
      await chats.close();
    }

    // The served stream re-creates the member's private thread UNDER THE
    // GRANTED WIRE ID, then posts into it. The thread.create would no-op
    // locally (the thread exists), so trusting it would let the follow-up
    // message/reaction land in the PRIVATE thread.
    fake.addOp("origin-owner", "chat.thread.create", {
      threadId: privateThreadId,
      title: "",
      createdAtMs: 1,
      channelSlug: "team",
      channelWireId: WIRE,
    });
    fake.addOp("origin-owner", "chat.message.append", {
      messageId: "msg-inject-1",
      threadId: privateThreadId,
      authorKind: "human",
      authorDisplayName: "Owner",
      authorUserId: "granter",
      body: "SENTINEL-injected",
      createdAtMs: 2,
    });
    fake.addOp("origin-owner", "chat.reaction.set", {
      reactionId: "reaction-inject-1",
      messageId: privateMessageId,
      threadId: privateThreadId,
      emoji: "👍",
      authorId: "granter",
      authorKind: "human",
      authorDisplayName: "Owner",
      state: "added",
      atMs: 3,
    });
    // A LEGITIMATE shared-channel follow-up after the injection attempt: the
    // gate must drop the injection without wedging the rest of the stream.
    fake.addOp("origin-owner", "chat.message.append", {
      messageId: "msg-owner-2",
      threadId: "thread-team-1",
      authorKind: "human",
      authorDisplayName: "Owner",
      authorUserId: "granter",
      body: "still flowing",
      createdAtMs: 4,
    });

    const result = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    // Applied: the 3 seed ops + the legit follow-up. Skipped: the forged
    // thread.create and BOTH ops targeting the private thread.
    expect(result.applied).toBe(4);
    expect(result.skipped).toBe(3);

    // The shared channel converged; the private thread is untouched.
    expect(await teamMessages(root)).toEqual([
      "msg-owner-1:welcome",
      "msg-owner-2:still flowing",
    ]);
    const verify = createLinkedChatStore(root);
    try {
      const messages = await verify.listMessages({ workspaceId: WORKSPACE, threadId: privateThreadId });
      expect(messages.map((message) => message.body)).toEqual(["PRIVATE-original"]);
    } finally {
      await verify.close();
    }
    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      const reactions = db
        .prepare("SELECT COUNT(*) AS count FROM chat_reactions WHERE workspace_id = ?")
        .get(WORKSPACE);
      expect(Number(reactions?.count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("replays idempotently across a crash-refetch overlap (cursor reset)", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const relay = relayFor(fake);
    const first = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(first.applied).toBe(3);

    // Simulate the crash-before-cursor-commit window: the cursor rewinds, the
    // same ops re-arrive, and the per-origin applied_origin_seq skip must
    // make the replay an exact no-op (no duplicate messages, no new journal
    // rows under the share origin).
    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      db.prepare("UPDATE shared_channel_cursors SET relay_fetch_cursor = 0 WHERE share_id = ?").run(SHARE_ID);
    } finally {
      db.close();
    }
    const second = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(3);
    expect(await teamMessages(root)).toEqual(["msg-owner-1:welcome"]);
  });

  it("keeps cursor, peer, and push state isolated per workspace (same root, same share id)", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const relay = relayFor(fake);
    const workspaceB = "shared-channel-member-ws-b" as WorkspaceId;

    const first = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(first.applied).toBe(3);
    // Workspace A sends and pushes, advancing ITS scan/push watermarks.
    const chatsA = createLinkedChatStore(root);
    try {
      await chatsA.sendMessage({
        workspaceId: WORKSPACE,
        threadId: "thread-team-1",
        author: { kind: "human", displayName: "A" },
        authorUserId: "member-a",
        body: "from A",
      });
    } finally {
      await chatsA.close();
    }
    const pushedA = await pushSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(pushedA.pushed).toBe(2);

    // Workspace B in the SAME root joins the same share. Its pull must start
    // from ITS OWN cursor (3 seed ops + A's structure and message), not resume A's...
    const second = await pullSharedChannel({
      rootDir: root,
      workspaceId: workspaceB,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(second.applied).toBe(5);
    // ...and its push must scan B's OWN journal from the start, not skip
    // everything below A's scanned watermark.
    const chatsB = createLinkedChatStore(root);
    try {
      await chatsB.sendMessage({
        workspaceId: workspaceB,
        threadId: "thread-team-1",
        author: { kind: "human", displayName: "B" },
        authorUserId: "member-b",
        body: "from B",
      });
    } finally {
      await chatsB.close();
    }
    const pushedB = await pushSharedChannel({
      rootDir: root,
      workspaceId: workspaceB,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(pushedB.pushed).toBe(2);
    expect(JSON.stringify(fake.appends.at(-1))).toContain("from B");
  });

  it("skips malformed relay op coordinates without poisoning durable peer state", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    // Malformed coordinates a hostile relay could serve, pushed RAW into the
    // stream (addOp would mint valid ones). relaySeqs continue 4..9 after the
    // three seed ops; the trailing op is the LEGIT continuation (origin seq 3)
    // that must still apply after the garbage is skipped.
    const malformedMessage = (over: Partial<FakeOp>, id: string): FakeOp => ({
      relaySeq: 0,
      originId: "origin-owner",
      originSeq: 3,
      opKind: "chat.message.append",
      payload: {
        messageId: id,
        threadId: "thread-team-1",
        authorKind: "human",
        authorDisplayName: "Owner",
        body: "SENTINEL-malformed",
        createdAtMs: 9,
      },
      recordedAtMs: 1009,
      ...over,
    });
    fake.ops.push(
      malformedMessage({ relaySeq: 4, originId: "" }, "msg-bad-1"),
      malformedMessage({ relaySeq: 5, originSeq: Number.NaN }, "msg-bad-2"),
      malformedMessage({ relaySeq: 6, originSeq: -1 }, "msg-bad-3"),
      malformedMessage({ relaySeq: 7, originSeq: 2.5 }, "msg-bad-4"),
      malformedMessage({ relaySeq: 8, recordedAtMs: Number.POSITIVE_INFINITY }, "msg-bad-5"),
      malformedMessage(
        { relaySeq: 9, payload: {
          messageId: "msg-owner-3",
          threadId: "thread-team-1",
          authorKind: "human",
          authorDisplayName: "Owner",
          body: "still alive",
          createdAtMs: 10,
        }, recordedAtMs: 1010 },
        "msg-owner-3",
      ),
    );

    const root = await tempRoot();
    const relay = relayFor(fake);
    const result = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(result.applied).toBe(4);
    expect(result.skipped).toBe(5);
    expect(await teamMessages(root)).toEqual([
      "msg-owner-1:welcome",
      "msg-owner-3:still alive",
    ]);

    // Durable state stayed sane: the peers table holds only safe integers and
    // the next pull is a clean no-op (nothing wedged before cursor commit).
    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      const rows = db
        .prepare("SELECT applied_origin_seq, dense_seq FROM shared_channel_peers")
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Number.isSafeInteger(Number(row.applied_origin_seq))).toBe(true);
        expect(Number.isSafeInteger(Number(row.dense_seq))).toBe(true);
      }
    } finally {
      db.close();
    }
    const again = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(again.fetched).toBe(0);
    expect(await teamMessages(root)).toEqual([
      "msg-owner-1:welcome",
      "msg-owner-3:still alive",
    ]);
  });

  it("aborts a pull on a malformed relay page cursor before persisting anything", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const badPageFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (new URL(href).pathname.endsWith("/log") && (init?.method ?? "GET") === "GET") {
        return Response.json({ ok: true, ops: [], nextCursor: Number.NaN, hasMore: false });
      }
      return fake.fetch(url, init);
    };
    await expect(
      pullSharedChannel({
        rootDir: root,
        workspaceId: WORKSPACE,
        relay: { baseUrl: "http://relay.test", token: TOKEN, fetch: badPageFetch },
        shareId: SHARE_ID,
        channelWireId: WIRE,
      }),
    ).rejects.toThrow(/malformed/iu);
    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM shared_channel_cursors")
        .get();
      expect(Number(row?.count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("surfaces revocation as ShareUnavailableError and leaves the local copy readable", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const relay = relayFor(fake);
    await pullSharedChannel({ rootDir: root, workspaceId: WORKSPACE, relay, shareId: SHARE_ID, channelWireId: WIRE });
    fake.ended = true;
    await expect(
      pullSharedChannel({ rootDir: root, workspaceId: WORKSPACE, relay, shareId: SHARE_ID, channelWireId: WIRE }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    expect(await teamMessages(root)).toEqual(["msg-owner-1:welcome"]);
  });

  it("refuses to open a path share as a channel", async () => {
    const fake = new FakeChannelRelay();
    const pathInfoFetch = async (): Promise<Response> =>
      Response.json({
        ok: true,
        shareId: SHARE_ID,
        granterUserId: "granter",
        selector: { paths: ["docs"], versionId: null },
        createdAtMs: 42,
      });
    await expect(
      fetchSharedChannelInfo({
        relay: { baseUrl: "http://relay.test", token: TOKEN, fetch: pathInfoFetch },
        shareId: SHARE_ID,
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    expect(fake.appends).toEqual([]);
  });
});

describe("pushSharedChannel", () => {
  it("pushes ONLY the channel's locally-authored ops, densely renumbered, and skips its own echoes on the next pull", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const relay = relayFor(fake);
    await pullSharedChannel({ rootDir: root, workspaceId: WORKSPACE, relay, shareId: SHARE_ID, channelWireId: WIRE });

    // Local activity: a reply in the shared thread (in scope), plus an
    // UNRELATED private channel with its own thread + message (out of scope).
    const chats = createLinkedChatStore(root);
    try {
      await chats.sendMessage({
        workspaceId: WORKSPACE,
        threadId: "thread-team-1",
        author: { kind: "human", displayName: "Member" },
        authorUserId: "member",
        body: "my reply",
      });
      const personal = await chats.createChannel({ workspaceId: WORKSPACE, name: "personal" });
      await chats.startChannelThread({
        workspaceId: WORKSPACE,
        channelId: personal.id,
        author: { kind: "human", displayName: "Member" },
        body: "PRIVATE-note to self",
      });
    } finally {
      await chats.close();
    }

    const pushed = await pushSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(pushed.pushed).toBe(2);
    expect(fake.appends).toHaveLength(1);
    const batch = fake.appends[0]!;
    expect(batch.ops).toHaveLength(2);
    expect(batch.ops[0]).toMatchObject({
      originSeq: 0,
      opKind: "chat.thread.create",
      payload: { threadId: "thread-team-1" },
    });
    expect(batch.ops[1]).toMatchObject({
      originSeq: 1,
      opKind: "chat.message.append",
      payload: { messageId: expect.any(String), threadId: "thread-team-1", body: "my reply" },
    });
    expect(JSON.stringify(batch)).not.toContain("PRIVATE-note");

    // A second local send continues the DENSE share sequence (0, 1, then 2)
    // even though the local journal interleaved out-of-scope ops between.
    const chats2 = createLinkedChatStore(root);
    try {
      await chats2.sendMessage({
        workspaceId: WORKSPACE,
        threadId: "thread-team-1",
        author: { kind: "human", displayName: "Member" },
        authorUserId: "member",
        body: "second reply",
      });
    } finally {
      await chats2.close();
    }
    await pushSharedChannel({ rootDir: root, workspaceId: WORKSPACE, relay, shareId: SHARE_ID, channelWireId: WIRE });
    expect(fake.appends[1]!.ops[0]).toMatchObject({ originSeq: 2, payload: { body: "second reply" } });

    // The relay now serves this member's own appends back; the next pull
    // must skip them (no duplicate messages, applied 0).
    const echoPull = await pullSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(echoPull.applied).toBe(0);
    const bodies = (await teamMessages(root)).map((row) => row.split(":")[1]);
    expect(bodies.sort()).toEqual(["my reply", "second reply", "welcome"]);
  });

  it("surfaces a read-only refusal as SharedChannelReadOnlyError without losing local ops", async () => {
    const fake = new FakeChannelRelay();
    seedGrantedChannel(fake);
    const root = await tempRoot();
    const relay = relayFor(fake);
    await pullSharedChannel({ rootDir: root, workspaceId: WORKSPACE, relay, shareId: SHARE_ID, channelWireId: WIRE });
    const chats = createLinkedChatStore(root);
    try {
      await chats.sendMessage({
        workspaceId: WORKSPACE,
        threadId: "thread-team-1",
        author: { kind: "human", displayName: "Member" },
        authorUserId: "member",
        body: "should be refused",
      });
    } finally {
      await chats.close();
    }
    fake.readOnly = true;
    await expect(
      pushSharedChannel({ rootDir: root, workspaceId: WORKSPACE, relay, shareId: SHARE_ID, channelWireId: WIRE }),
    ).rejects.toBeInstanceOf(SharedChannelReadOnlyError);
    // Nothing was recorded as pushed: a later read-write flip re-sends it.
    fake.readOnly = false;
    const retry = await pushSharedChannel({
      rootDir: root,
      workspaceId: WORKSPACE,
      relay,
      shareId: SHARE_ID,
      channelWireId: WIRE,
    });
    expect(retry.pushed).toBe(2);
  });
});
