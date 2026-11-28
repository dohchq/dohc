import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { serveFetchHandler } from "@dohc/service-http";
import { streamsRequestBody } from "./server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import {
  CHATS_METHOD,
  ChatsLiveAdapter,
  VersionedLiveAdapter,
  type EngineTransport,
  type JsonValue,
} from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { cliThreadId } from "@dohc/workspace-operations/chats";
import { asRecord } from "@dohc/workspace-core";
import { parseAccessRule } from "@dohc/security-contract/access-rules";
import { PhoneChatContext } from "@dohc/workspace-contracts/chat-wakes";
import {
  ChatsLoopbackEngine,
  VersionedLoopbackEngine,
} from "@dohc/workspace-engine-client/testing";
import {
  cleanupLiveDeliveryFixtures,
  registered,
} from "../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport";
import { seededNote } from "../../../packages/ydoc-projection/src/bodySequenceChecksTestSupport";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import { phoneWriteIds, runPhoneWrite, type PhoneWrite } from "./accountChatWrites";
import { ACCOUNT_FEED_WAITS_PER_ACCOUNT, currentAccountFeedCursor } from "./accountFeed";
import { ACCOUNT_READ_DEADLINE_MS } from "./accountOperations";
import { untilAborted } from "./namedLiveFrameHost";
import { createAccountDeletionRoute } from "./accountDeletionRoute";
import { DiscussionActivityHub } from "./discussionActivity";
import type { AutomationReplica } from "./automationReplicas";
import { ACCOUNT_VISITS_PER_CALLER, startServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import {
  CHAT_RUNNER_LEASE_MS,
  CHAT_WAKE_CONFIRM_MS,
  CHAT_WAKE_KEEP_MS,
  chatWakeId,
} from "./storage/chatWakes";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, denialBytes, json, testHandler, testStorage } from "./testing";
import { PhoneWriteEngine, seedPhoneChats } from "./testing/phoneWriteEngine";
import { PUBLICATION_DEADLINE_MS } from "./operationPublication";
import { notifyChatWakeChange } from "./relayWriteChanges";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await closeTestStorages();
  cleanupLiveDeliveryFixtures();
});

const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "desktop",
  } satisfies AccountSession;
};
const signedIn = (userId: string, sessionId = "phone") => ({
  authorization: `Bearer session:${userId}:${sessionId}`,
});

function op(
  workspaceId: string,
  operation: string,
  args: unknown = {},
  headers: Record<string, string> = signedIn("ana"),
): Request {
  return new Request(`http://relay.test/sync/${encodeURIComponent(workspaceId)}/ops/${operation}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: typeof args === "string" ? args : JSON.stringify(args),
  });
}

/**
 * One engine for chats and files, which fails a method on request. Its file
 * listing can also name `listedHidden`, as an engine that kept a secret file,
 * or a path it ignores, among the others would.
 */
class TestEngine implements EngineTransport {
  readonly chats = new ChatsLoopbackEngine();
  readonly files = new VersionedLoopbackEngine();
  readonly failing = new Map<string, Error>();
  readonly listedHidden: string[] = [];
  onEvent() {
    return () => undefined;
  }
  close() {}
  async sendRequest(request: Parameters<EngineTransport["sendRequest"]>[0]) {
    const failure = this.failing.get(request.method);
    if (failure) throw failure;
    if (request.method.startsWith("chats.")) return await this.chats.sendRequest(request);
    const response = await this.files.sendRequest(request);
    if (request.method !== "versionedText.list" || this.listedHidden.length === 0) return response;
    const page = response.result as { files: Array<Record<string, JsonValue>> };
    const listed = this.listedHidden.map((path) => ({
      ...page.files[0]!,
      path,
      objectId: `object-${path}`,
    }));
    return { ...response, result: { ...page, files: [...page.files, ...listed] } };
  }
  methods(): string[] {
    return [...this.chats.requests, ...this.files.requests].map((request) => request.method);
  }
}

async function serverCopies(storage: SyncRelayStorage, engine: TestEngine) {
  const syncs: string[] = [];
  let held: Promise<void> | null = null;
  let requestId = 0;
  let opensCaughtUp = true;
  let opens = true;
  const lifetime = new AbortController();
  const copies = await startServerCopies({
    storage,
    root: "unused",
    engineExecutable: "unused",
    relayOrigin: "https://relay.example.test",
    key: new Uint8Array(32),
    namespace: "test",
    startReplicas: async (hooks) => {
      const open = new Map<string, AutomationReplica>();
      const pass = () => {
        const wanted = hooks.wanted();
        for (const [workspaceId, reasons] of wanted) {
          const row = storage.joinAutomationWorkspace({ workspaceId, nowMs: 1, reasons });
          if (!row || open.has(workspaceId) || !opens) continue;
          let running = 0;
          const copy = {
            workspaceId,
            ownerUserId: row.ownerUserId,
            incarnation: row.incarnation,
            reasons: row.reasons,
            startedAtMs: 1,
            pulledHead: opensCaughtUp ? storage.automationWorkspaceLogHead(workspaceId) : 0,
            root: "unused",
            metadataDir: "unused",
            client: engine as unknown as EngineClient,
            workspace: workspaceId,
            signal: lifetime.signal,
            nextRequestId: () => ++requestId,
            withRecordWork: <T>(work: () => Promise<T>) => work(),
            busy: () => running > 0,
            step: async () => true,
            sync: async (signal?: AbortSignal) => {
              syncs.push(workspaceId);
              running += 1;
              try {
                const head = storage.automationWorkspaceLogHead(workspaceId);
                const wait = held ?? Promise.resolve();
                await (signal ? untilAborted(wait, signal) : wait);
                copy.pulledHead = Math.max(copy.pulledHead, head);
              } finally {
                running -= 1;
              }
            },
          } satisfies AutomationReplica;
          open.set(workspaceId, copy);
          hooks.onChanged?.(workspaceId);
        }
        for (const workspaceId of [...open.keys()])
          if (!wanted.has(workspaceId)) open.delete(workspaceId);
      };
      return {
        unavailable: false,
        replica: (id) => open.get(id),
        reconcile: () => queueMicrotask(pass),
        deleteWorkspaces: async () => undefined,
        failedSyncs: () => new Map(),
        settled: async () => undefined,
        close: async () => undefined,
      };
    },
  });
  cleanup.push(async () => {
    lifetime.abort();
    await copies.close();
  });
  return {
    copies,
    syncs,
    opensBehind() {
      opensCaughtUp = false;
    },
    holdOpens() {
      opens = false;
    },
    holdSyncs() {
      let release!: () => void;
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
  };
}

async function relay(
  options: {
    resolve?: ResolveAccountSession;
    limiter?: TokenBucketLimiter;
    activity?: DiscussionActivityHub;
    /** False for a server whose copies aren't running. */
    copies?: boolean;
  } = {},
) {
  const storage = await testStorage();
  for (const [workspaceId, ownerUserId] of [
    ["trip", "ana"],
    ["notes", "ana"],
    ["budget", "ben"],
  ] as const) {
    storage.claimWorkspace({ workspaceId, ownerUserId, createdAtMs: 1 });
    if (workspaceId !== "notes")
      storage.claimWorkspaceIdentity({
        workspaceId,
        replicationEpoch: "epoch",
        streamIdentity: "stream",
      });
  }
  const engine = new TestEngine();
  const run = await serverCopies(storage, engine);
  const activity = options.activity ?? new DiscussionActivityHub();
  const h = testHandler(storage, {
    resolveAccountSession: options.resolve ?? resolveAccountSession,
    resolvePhoneCapableAccountSession: options.resolve ?? resolveAccountSession,
    serverCopies: () => (options.copies === false ? undefined : run.copies),
    ...(options.limiter ? { accountOperationRateLimiter: options.limiter } : {}),
    discussionActivity: activity,
  });
  return { storage, engine, h, activity, ...run };
}

async function seedTrip(engine: TestEngine) {
  const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
  engine.files.seedTextFile({
    workspace: "trip",
    path: "docs/plan.md",
    text: "# Plan\n\nStay in Alfama.\n",
    objectId: "object-plan",
  });
  const planning = await chats.createChannel({ workspaceId: "trip", name: "Planning" });
  const author = { kind: "human" as const, displayName: "Ana" };
  const started = await chats.startChannelThread({
    workspaceId: "trip",
    channelId: planning.channelId,
    threadId: "thread-stay",
    messageId: "message-stay",
    author,
    authorActorKey: null,
    body: "Where do we stay?",
    attachments: [
      { objectId: "object-plan", pathHint: "docs/plan.md" },
      { objectId: "object-env", pathHint: ".env" },
    ],
  });
  const onPage = await chats.createThread({
    workspaceId: "trip",
    title: "Plan",
    linkedFile: { objectId: "object-plan", pathHint: "docs/plan.md" },
  });
  await chats.sendMessage({
    workspaceId: "trip",
    threadId: onPage.id,
    messageId: "message-page",
    author,
    authorActorKey: null,
    body: "Looks good.",
  });
  const onSecret = await chats.createThread({
    workspaceId: "trip",
    title: "Keys",
    linkedFile: { objectId: "object-env", pathHint: ".env" },
  });
  return { planning, thread: started.thread, onPage, onSecret };
}

async function answer(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).result as Record<string, unknown>;
}

/**
 * Appends one row to a workspace's log and wakes its waits, as the relay's
 * log routes do. A moment also places its object at its path, or deletes it.
 * It calls wakeLog itself, so a test that needs a route to wake the feed
 * writes through that route instead.
 */
function logWriter(
  storage: SyncRelayStorage,
  activity: DiscussionActivityHub,
  workspaceId = "trip",
) {
  const context = storage as StorageContext;
  let originSeq = 0;
  const append = (opKind: string, payload: Record<string, unknown>) =>
    context.tx(() => {
      const row = context.db
        .prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
      VALUES (?, 'origin-test', ?, ?, ?, 1) RETURNING relay_seq`)
        .get(workspaceId, ++originSeq, opKind, JSON.stringify(payload))!;
      const relaySeq = Number(row.relay_seq);
      if (opKind === "moment.append") {
        context.db
          .prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
        VALUES (?, ?, ?, ?, 'main', ?, 1)`)
          .run(
            workspaceId,
            String(payload.objectId),
            relaySeq,
            `moment-${relaySeq}`,
            payload.path ?? null,
          );
      }
      return relaySeq;
    });
  return (opKind: string, payload: Record<string, unknown>) => {
    const relaySeq = append(opKind, payload);
    activity.wakeLog(workspaceId);
    return relaySeq;
  };
}

function changes(
  since: string,
  options: {
    hold?: number;
    headers?: Record<string, string>;
    workspaceId?: string;
    signal?: AbortSignal;
  } = {},
): Request {
  const query = new URLSearchParams({
    since,
    ...(options.hold === undefined ? {} : { hold: String(options.hold) }),
  });
  return new Request(
    `http://relay.test/sync/${options.workspaceId ?? "trip"}/ops/changes?${query}`,
    {
      headers: options.headers ?? signedIn("ana"),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

async function feed(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return await json(response);
}

describe("an account's reads through the server's copy", () => {
  it("names each agent's chat as the computers name its agent, and archives one no computer has", async () => {
    const { storage, engine, h } = await relay();
    const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
    await chats.createChannel({ workspaceId: "trip", name: "Planning" });
    await chats.ensureAgentChannel({ workspaceId: "trip", agentId: "default", name: "Claude" });
    await chats.ensureAgentChannel({ workspaceId: "trip", agentId: "t3-code", name: "d3-code" });
    const listed = async () =>
      (
        (await answer(await h(op("trip", "groupsFull")))) as { groups: Record<string, unknown>[] }
      ).groups
        .map(({ name, kind, archived }) => ({ name, kind, archived }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // No computer has sent its list yet: the chats stand as stored.
    expect(await listed()).toEqual([
      { name: "d3-code", kind: "agent", archived: undefined },
      { name: "My agent", kind: "agent", archived: undefined },
      { name: "Planning", kind: "group", archived: undefined },
    ]);
    storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId: "pc",
      computerLabel: "PC",
      runners: [],
      agents: [{ agentId: "t3-code", displayName: "Nova" }],
      nowMs: Date.now(),
    });
    expect(await listed()).toEqual([
      { name: "My agent", kind: "agent", archived: true },
      { name: "Nova", kind: "agent", archived: undefined },
      { name: "Planning", kind: "group", archived: undefined },
    ]);
  });

  it("answers each read from the copy once it has synced, without creating General", async () => {
    const { engine, h, syncs } = await relay();
    const { planning, thread, onPage } = await seedTrip(engine);

    expect(await answer(await h(op("trip", "groups")))).toMatchObject({
      groups: [{ name: "Planning", slug: "planning" }],
    });
    expect(syncs).toEqual(["trip"]);
    expect(await answer(await h(op("trip", "threads", { group: "planning" })))).toMatchObject({
      threads: [{ title: "Where do we stay?" }],
    });
    expect(await answer(await h(op("trip", "groupsFull")))).toMatchObject({
      ok: true,
      groups: [{ slug: "planning", threadCount: 1 }],
    });
    expect(await answer(await h(op("trip", "fileChats", { path: "docs/plan.md" })))).toMatchObject({
      ok: true,
      path: "docs/plan.md",
      fileObjectId: "object-plan",
      threads: [{ id: onPage.id }],
    });
    const onFile = await answer(await h(op("trip", "chat", { threadId: onPage.id })));
    expect(onFile).toMatchObject({
      ok: true,
      thread: { id: onPage.id },
      messages: [{ body: "Looks good." }],
    });
    expect(onFile.projection).toMatchObject({ text: expect.stringContaining("docs/plan.md") });
    expect(await answer(await h(op("trip", "chat", { group: "planning" })))).toMatchObject({
      ok: true,
      stream: { group: { id: planning.channelId }, items: [{ threadId: thread.id }] },
    });
    expect(
      await answer(await h(op("trip", "show", { target: "planning", peek: true }))),
    ).toMatchObject({ stream: { group: { slug: "planning" } } });
    expect(
      await answer(await h(op("trip", "show", { target: "th_stay", peek: true }))),
    ).toMatchObject({
      thread: { title: "Where do we stay?" },
      dispatch: { paused: null, lastRun: null },
    });
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/plan.md" })))).toEqual({
      ok: true,
      path: "docs/plan.md",
      markdown: "# Plan\n\nStay in Alfama.\n",
      objectId: expect.any(String),
    });

    expect(syncs, "a page read on a caught-up copy skips the sync").toHaveLength(8);
    expect(engine.methods()).not.toContain("chats.channels.ensureGeneral");
  });

  it("refuses a request without a Bearer session, one with a cookie, and a fenced account, before it opens a copy", async () => {
    const { storage, h, syncs } = await relay();
    const missing = await denialBytes(await h(op("trip", "groups", {}, {})));
    expect(await denialBytes(await h(op("trip", "groups", {}, { cookie: "session=ana" })))).toBe(
      missing,
    );
    expect(
      await denialBytes(
        await h(op("trip", "groups", {}, { ...signedIn("ana"), cookie: "session=ana" })),
      ),
    ).toBe(missing);
    expect(
      (await h(op("trip", "groups", {}, { authorization: "Bearer user:ana" }))).status,
      "a sign-in it cannot validate",
    ).toBe(401);
    createAccountDeletionRoute({
      storage: storage as StorageContext,
      key: "bearer-test",
      fenceKey: "fence-test",
      invalidate() {},
      deleteRuntime: async () => {},
    }).fence("ana", "ana@example.test");
    expect(await denialBytes(await h(op("trip", "groups")))).toBe(missing);
    expect(syncs).toEqual([]);
  });

  it("answers another account's workspace, a missing one and an impossible ID alike, without reading the arguments", async () => {
    const { h, syncs } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    let pulled = false;
    const unread = new Request("http://relay.test/sync/budget/ops/groups", {
      method: "POST",
      headers: { ...signedIn("ana"), "content-type": "application/json" },
      duplex: "half",
      body: new ReadableStream(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    } as RequestInit & { duplex: "half" });
    expect(await denialBytes(await h(unread))).toBe(missing);
    expect(pulled, "the body of a request for another account's workspace").toBe(false);
    expect(await denialBytes(await h(op("link", "groups")))).toBe(missing);
    expect(await denialBytes(await h(op("account", "groups")))).toBe(missing);
    expect(await denialBytes(await h(op("trip/x", "groups")))).toBe(missing);
    expect(syncs).toEqual([]);
  });

  it("answers an unknown operation, and the reserved `changes`, as missing", async () => {
    const { h, syncs } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    for (const name of [
      "changes",
      "groupCreate",
      "watch",
      "toString",
      "__proto__",
      "constructor",
    ]) {
      expect(await denialBytes(await h(op("trip", name))), name).toBe(missing);
    }
    expect(syncs).toEqual([]);
  });

  it("takes exactly each operation's server arguments", async () => {
    const { engine, h, syncs } = await relay();
    await seedTrip(engine);
    for (const [name, args] of [
      ["groups", { cwd: "/", actor: "human" }],
      ["groups", { agentId: "nova" }],
      ["groups", { token: "a".repeat(64) }],
      ["threads", { group: "planning", actor: "agent" }],
      ["show", { target: "planning", peek: false }],
      ["show", { target: "planning" }],
      ["show", { target: "planning", peek: true, runSecret: "a".repeat(64) }],
      ["documentRead", { path: "docs/plan.md", agent: "Nova" }],
      ["chat", { threadId: "thread-stay", group: "planning" }],
      ["groups", []],
      ["groups", "not json"],
    ] as const) {
      const response = await h(op("trip", name, args));
      expect(response.status, `${name} ${JSON.stringify(args)}`).toBe(400);
      expect((await json(response)).code).toBe("bad_request");
    }
    expect(syncs).toEqual([]);
  });

  it("refuses arguments over 256 KiB, and streams them so the owner is checked first", async () => {
    const { h, syncs } = await relay();
    const response = await h(op("trip", "documentRead", { path: "a".repeat(256 * 1024) }));
    expect(response.status).toBe(413);
    expect(streamsRequestBody(new URL("http://relay.test//sync/trip/%6Fps/groups"), "POST")).toBe(
      true,
    );
    expect(syncs).toEqual([]);
  });

  it("answers only POST", async () => {
    const { h } = await relay();
    expect(
      (await h(new Request("http://relay.test/sync/trip/ops/groups", { headers: signedIn("ana") })))
        .status,
    ).toBe(405);
  });

  it("answers as missing, with no result, when access ends once the result is ready", async () => {
    let reads = 0;
    const { storage, activity, engine, h, syncs, opensBehind } = await relay({
      resolve: async (request) => {
        const session = await resolveAccountSession(request);
        // Before the arguments, after them, once the copy opens, once it syncs, then once the result is ready.
        return ++reads === 5 ? { ...session, sessionId: "another" } : session;
      },
    });
    await seedTrip(engine);
    opensBehind();
    logWriter(storage, activity)("files.change", {});
    const response = await h(op("trip", "documentRead", { path: "docs/plan.md" }));
    expect(reads).toBe(5);
    expect(syncs).toEqual(["trip"]);
    expect(engine.files.requests.map((request) => request.method)).toContain("versionedText.read");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Alfama");
  });

  it("answers an unknown operation without reading its arguments", async () => {
    const { h } = await relay();
    let pulled = false;
    const unread = new Request("http://relay.test/sync/trip/ops/changes", {
      method: "POST",
      headers: { ...signedIn("ana"), "content-type": "application/json" },
      duplex: "half",
      body: new ReadableStream(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    } as RequestInit & { duplex: "half" });
    await denialBytes(await h(unread));
    expect(pulled).toBe(false);
  });
});

describe("a page read on a caught-up copy", () => {
  const read = op("trip", "documentRead", { path: "docs/plan.md" });

  it("skips the sync and answers the feed's cursor for what the copy holds, while other reads still sync", async () => {
    const { storage, activity, engine, h, syncs } = await relay();
    await seedTrip(engine);
    logWriter(storage, activity)("files.change", {});
    const response = await h(read.clone());
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      result: {
        ok: true,
        path: "docs/plan.md",
        markdown: "# Plan\n\nStay in Alfama.\n",
        objectId: "object-plan",
      },
      cursor: currentAccountFeedCursor(storage, "trip"),
    });
    expect(syncs).toEqual([]);
    await answer(await h(op("trip", "groups")));
    expect(syncs).toEqual(["trip"]);
  });

  it("logs how long it spent opening the copy, syncing, and reading, and nothing else", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await answer(await h(read.clone()));
      expect(log.mock.calls).toHaveLength(1);
      expect(log.mock.calls[0]).toEqual([
        expect.stringMatching(/^\[account-reads\] documentRead open=\d+ms sync=\d+ms read=\d+ms$/),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the copy open only after a read that succeeded", async () => {
    const { engine, h, copies } = await relay();
    await seedTrip(engine);
    expect(
      await answer(await h(op("trip", "documentRead", { path: "docs/missing.md" }))),
    ).toMatchObject({ ok: false, refusal: "missing" });
    await expect.poll(() => copies.replica("trip")).toBeUndefined();
  });

  it("syncs a copy behind the relay's log", async () => {
    const { storage, activity, engine, h, syncs, opensBehind } = await relay();
    await seedTrip(engine);
    opensBehind();
    logWriter(storage, activity)("files.change", {});
    await answer(await h(read.clone()));
    expect(syncs).toEqual(["trip"]);
  });

  it("waits for a sync already running on the copy", async () => {
    const { engine, h, holdSyncs, syncs } = await relay();
    await seedTrip(engine);
    const release = holdSyncs();
    const groups = h(op("trip", "groups"));
    await expect.poll(() => syncs.length).toBe(1);
    const page = h(read.clone());
    await expect.poll(() => syncs.length).toBe(2);
    release();
    await answer(await groups);
    await answer(await page);
  });

  it("keeps the copy open after a read until Show on phone turns off", async () => {
    const { engine, h, copies } = await relay();
    await seedTrip(engine);
    await answer(await h(read.clone()));
    await expect.poll(() => copies.replica("trip")).toBeDefined();
    const hidden = await h(
      new Request("http://relay.test/sync/account/workspaces/trip", {
        method: "PATCH",
        headers: { ...signedIn("ana"), "content-type": "application/json" },
        body: JSON.stringify({ showOnPhone: false }),
      }),
    );
    expect(hidden.status).toBe(200);
    await expect.poll(() => copies.replica("trip")).toBeUndefined();
  });

  it("syncs a copy that is no longer the workspace's current one", async () => {
    let reads = 0;
    const { storage, engine, h, syncs } = await relay({
      resolve: async (request) => {
        if (++reads === 3)
          (storage as StorageContext).db
            .prepare(
              "UPDATE sync_relay_automation_workspaces SET left_at_ms = 1 WHERE workspace_id = 'trip'",
            )
            .run();
        return await resolveAccountSession(request);
      },
    });
    await seedTrip(engine);
    await answer(await h(read.clone()));
    expect(syncs).toEqual(["trip"]);
  });
});

describe("an account read's deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers server_busy before the phone's 15 s wait, whether the copy is opening, syncing, or reading", async () => {
    expect(ACCOUNT_READ_DEADLINE_MS).toBeLessThan(15_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine, h, holdOpens, holdSyncs, syncs } = await relay();
    await seedTrip(engine);
    const late = async (request: Request, wait: () => Promise<unknown>) => {
      const response = h(request);
      await wait();
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_DEADLINE_MS);
      const busy = await response;
      expect(busy.status).toBe(503);
      expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    };
    const release = holdSyncs();
    await late(op("trip", "groups"), () => expect.poll(() => syncs.length).toBe(1));
    release();
    const send = engine.sendRequest.bind(engine);
    engine.sendRequest = async (request) =>
      request.method === "versionedText.read"
        ? await new Promise<never>(() => undefined)
        : await send(request);
    await late(op("trip", "documentRead", { path: "docs/plan.md" }), async () => undefined);
    holdOpens();
    await late(op("budget", "groups", {}, signedIn("ben")), async () => undefined);
    expect(syncs).toHaveLength(1);
  });
});

describe("an account read's deadline over its checks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts when the request arrives, and ends a first check of the sign-in that outlasts it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    const { h, holdOpens } = await relay({
      resolve: async (request) => {
        const slow = [4_000, ACCOUNT_READ_DEADLINE_MS + 1_000][calls++];
        if (slow !== undefined) await new Promise((resolve) => setTimeout(resolve, slow));
        return await resolveAccountSession(request);
      },
    });
    holdOpens();
    for (const _ of [1, 2]) {
      let answered = false;
      const response = h(op("trip", "groups")).finally(() => {
        answered = true;
      });
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_DEADLINE_MS);
      expect(answered).toBe(true);
      expect((await response).status).toBe(503);
    }
  });

  it("answers server_busy for a check of the sign-in that outlasts the deadline, and frees the visit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let calls = 0;
    let pausing = true;
    const { engine, h } = await relay({
      resolve: async (request) => {
        if (++calls % 5 === 0 && pausing) await new Promise<never>(() => undefined);
        return await resolveAccountSession(request);
      },
    });
    await seedTrip(engine);
    for (let read = 1; read <= ACCOUNT_VISITS_PER_CALLER; read++) {
      const response = h(op("trip", "documentRead", { path: "docs/plan.md" }));
      await expect.poll(() => calls).toBe(5 * read);
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_DEADLINE_MS);
      const busy = await response;
      expect(busy.status).toBe(503);
      expect(await busy.text()).not.toContain("Alfama");
    }
    pausing = false;
    expect((await h(op("trip", "groups"))).status, "every visit was freed").toBe(200);
  });
});

describe("an account read's deadline over the HTTP adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers server_busy while the arguments are still arriving", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let checks = 0;
    const { h } = await relay({
      resolve: async (request) => {
        checks += 1;
        return await resolveAccountSession(request);
      },
    });
    const server = serveFetchHandler({
      handler: h,
      maxBodyBytes: () => 1024 * 1024,
      streamBody: streamsRequestBody,
      oversized: () => new Response(null, { status: 413 }),
      failure: () => new Response(null, { status: 500 }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const sent = httpRequest({
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path: "/sync/trip/ops/documentRead",
          method: "POST",
          headers: {
            ...signedIn("ana"),
            "content-type": "application/json",
            "content-length": "64",
          },
        });
        sent.on("response", (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            sent.destroy();
            resolve({ status: response.statusCode ?? 0, body });
          });
        });
        sent.on("error", reject);
        sent.write('{"path":');
      });
      await expect.poll(() => checks).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(ACCOUNT_READ_DEADLINE_MS);
      const busy = await answer;
      expect(busy.status).toBe(503);
      expect(JSON.parse(busy.body)).toMatchObject({ ok: false, code: "server_busy" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("a cancelled account read", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("frees its visit at once, while its engine call is still pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { engine, h } = await relay();
    await seedTrip(engine);
    let reads = 0;
    const send = engine.sendRequest.bind(engine);
    engine.sendRequest = async (request) => {
      if (request.method !== "versionedText.read") return await send(request);
      reads += 1;
      return await new Promise<never>(() => undefined);
    };
    const cancels = Array.from({ length: ACCOUNT_VISITS_PER_CALLER }, () => new AbortController());
    const cancelled = cancels.map((cancel) =>
      h(
        new Request(op("trip", "documentRead", { path: "docs/plan.md" }), {
          signal: cancel.signal,
        }),
      ).catch(() => undefined),
    );
    await expect.poll(() => reads).toBe(ACCOUNT_VISITS_PER_CALLER);
    for (const cancel of cancels) cancel.abort(new Error("The phone tapped a page."));
    expect((await h(op("trip", "groups"))).status).toBe(200);
    await Promise.all(cancelled);
    expect(reads, "no engine call answered or started again").toBe(ACCOUNT_VISITS_PER_CALLER);
  });
});

describe("an account's share of the server", () => {
  it("answers server_busy past one sign-in's open visits", async () => {
    const { h, holdSyncs, syncs } = await relay();
    const release = holdSyncs();
    const held = Array.from({ length: ACCOUNT_VISITS_PER_CALLER }, () => h(op("trip", "groups")));
    await expect.poll(() => syncs.length).toBe(ACCOUNT_VISITS_PER_CALLER);
    const busy = await h(op("trip", "groups"));
    expect(busy.status).toBe(503);
    expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    release();
    for (const response of await Promise.all(held)) expect(response.status).toBe(200);
    expect((await h(op("trip", "groups"))).status).toBe(200);
  });

  it("answers server_busy past one sign-in's rate, keyed by the sign-in", async () => {
    const { h } = await relay({ limiter: new TokenBucketLimiter(1, 0.001, 16) });
    expect((await h(op("trip", "groups"))).status).toBe(200);
    const limited = await h(op("trip", "groups"));
    expect(limited.status).toBe(503);
    expect(await json(limited)).toMatchObject({ ok: false, code: "server_busy" });
    expect((await h(op("trip", "groups", {}, signedIn("ana", "laptop")))).status).toBe(200);
  });
});

describe("secret files through the server's copy", () => {
  it("reads a secret file's page exactly as a missing one, without asking the engine", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    const missing = (path: string) => ({
      ok: false,
      reason: `dohc: No document at ${path}.`,
      refusal: "missing",
    });
    expect(await answer(await h(op("trip", "documentRead", { path: "docs/missing.md" })))).toEqual(
      missing("docs/missing.md"),
    );
    const reads = engine.files.requests.length;
    for (const [path, normalized] of [
      [".env", ".env"],
      ["a/.env/b.md", "a/.env/b.md"],
      ["x.env", "x.env"],
      [".env.local", ".env.local"],
      ["%2Eenv", ".env"],
      ["notes/.ENV.md", "notes/.ENV.md"],
    ] as const) {
      expect(await answer(await h(op("trip", "documentRead", { path }))), path).toEqual(
        missing(normalized),
      );
    }
    expect(engine.files.requests.slice(reads).map((request) => request.method)).toEqual([]);
  });

  it("answers a secret file's page with the same bytes as a missing one's, its path aside", async () => {
    const { engine, h } = await relay();
    await seedTrip(engine);
    const bytes = async (path: string) => {
      const response = await h(op("trip", "documentRead", { path }));
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: (await response.text()).replaceAll(path, "<path>"),
      };
    };
    const missing = await bytes("docs/missing.md");
    expect(missing.body).toContain('"refusal":"missing"');
    for (const path of [".env", "docs/.env.local", "a/.env/b.md"])
      expect(await bytes(path), path).toEqual(missing);
  });

  it("lists a secret file's chats exactly as a missing file's, and reads its threads and attachments as missing", async () => {
    const { engine, h } = await relay();
    const { onSecret } = await seedTrip(engine);
    expect(await answer(await h(op("trip", "fileChats", { path: "%2Eenv" })))).toEqual({
      ok: true,
      path: ".env",
      fileObjectId: null,
      threads: [],
    });
    expect(await answer(await h(op("trip", "fileChats", { path: "docs/missing.md" })))).toEqual({
      ok: true,
      path: "docs/missing.md",
      fileObjectId: null,
      threads: [],
    });
    // The thread's file is nowhere in the copy, as a secret file never is.
    expect(await answer(await h(op("trip", "chat", { threadId: onSecret.id })))).toEqual({
      ok: false,
      reason: `chat thread not found: ${onSecret.id}`,
      refusal: "missing",
    });
    expect(await answer(await h(op("trip", "chat", { threadId: "thread-nowhere" })))).toEqual({
      ok: false,
      reason: "chat thread not found: thread-nowhere",
      refusal: "missing",
    });
    for (const target of [onSecret.id, cliThreadId(onSecret.id)]) {
      expect(await json(await h(op("trip", "show", { target, peek: true })))).toMatchObject({
        code: "bad_request",
        error: `dohc: no such thread or message: ${target}`,
      });
    }
    const ambiguous = await json(await h(op("trip", "show", { target: "th_", peek: true })));
    expect(ambiguous).toMatchObject({
      code: "bad_request",
      error: expect.stringContaining("ambiguous thread or message prefix"),
    });
    expect(String(ambiguous.error)).not.toContain(cliThreadId(onSecret.id));
    expect(JSON.stringify(await answer(await h(op("trip", "groupsFull"))))).not.toContain(
      onSecret.id,
    );

    const shown = await answer(await h(op("trip", "show", { target: "th_stay", peek: true })));
    expect(shown.messages).toMatchObject([
      { attachments: [{ objectId: "object-plan", pathHint: "docs/plan.md" }] },
    ]);
    const stream = await answer(await h(op("trip", "chat", { group: "planning" })));
    expect(JSON.stringify(stream)).not.toContain("object-env");
  });

  it("keeps a chat on a deleted file readable, and hides one on a file the relay last saw at a secret path", async () => {
    const { storage, engine, h } = await relay();
    const { planning } = await seedTrip(engine);
    const moment = (objectId: string, relaySeq: number, path: string | null) =>
      (storage as StorageContext).db
        .prepare(
          `INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
       VALUES ('trip', ?, ?, ?, 'main', ?, 1)`,
        )
        .run(objectId, relaySeq, `moment-${relaySeq}`, path);
    moment("object-old", 1, "docs/old.md");
    moment("object-old", 2, null);
    moment("object-dotenv", 3, ".env");
    moment("object-dotenv", 4, null);
    moment("object-renamed", 5, "docs/keys.md");
    moment("object-renamed", 6, ".env.local");
    const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
    const author = { kind: "human" as const, displayName: "Ana" };
    const thread = async (objectId: string, pathHint: string) => {
      const created = await chats.createThread({
        workspaceId: "trip",
        title: objectId,
        linkedFile: { objectId, pathHint },
      });
      await chats.sendMessage({
        workspaceId: "trip",
        threadId: created.id,
        author,
        authorActorKey: null,
        body: `On ${objectId}`,
      });
      return created;
    };
    const deleted = await thread("object-old", "docs/old.md");
    // Each hint names an ordinary file; the relay's own record decides.
    const dotenv = await thread("object-dotenv", "docs/notes.md");
    const renamed = await thread("object-renamed", "docs/keys.md");

    const read = await answer(await h(op("trip", "chat", { threadId: deleted.id })));
    expect(read).toMatchObject({
      ok: true,
      thread: { title: "object-old" },
      messages: [{ body: "On object-old" }],
    });
    expect((read.projection as { text: string }).text).toContain("Linked file: unavailable");
    expect(
      await answer(await h(op("trip", "show", { target: cliThreadId(deleted.id), peek: true }))),
    ).toMatchObject({ thread: { title: "object-old" }, messages: [{ body: "On object-old" }] });
    for (const hidden of [dotenv, renamed]) {
      expect(
        await answer(await h(op("trip", "chat", { threadId: hidden.id }))),
        hidden.title,
      ).toEqual({ ok: false, reason: `chat thread not found: ${hidden.id}`, refusal: "missing" });
      expect(
        await json(await h(op("trip", "show", { target: cliThreadId(hidden.id), peek: true }))),
      ).toMatchObject({
        code: "bad_request",
        error: `dohc: no such thread or message: ${cliThreadId(hidden.id)}`,
      });
    }

    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: planning.channelId,
      threadId: "thread-files",
      messageId: "message-files",
      author,
      authorActorKey: null,
      body: "Files",
      attachments: [
        { objectId: "object-old", pathHint: "docs/old.md" },
        { objectId: "object-dotenv", pathHint: "docs/notes.md" },
      ],
    });
    const shown = await answer(await h(op("trip", "show", { target: "th_files", peek: true })));
    expect(shown.messages).toMatchObject([
      { body: "Files", attachments: [{ objectId: "object-old", pathHint: "docs/old.md" }] },
    ]);
  });
});

describe("pages the relay hosts live", () => {
  async function livePage(
    seed: (engine: TestEngine) => void = (engine) =>
      engine.files.seedTextFile({
        workspace: "workspace",
        path: "docs/a.md",
        text: "Hello\n",
        objectId: "object",
      }),
    baselineBytes?: Uint8Array,
  ) {
    const f = registered({ deployment: true, ...(baselineBytes ? { baselineBytes } : {}) });
    cleanup.push(async () => f.close());
    f.storage.claimWorkspaceIdentity({
      workspaceId: "workspace",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    const engine = new TestEngine();
    seed(engine);
    const run = await serverCopies(f.storage, engine);
    const h = testHandler(f.storage, {
      resolveAccountSession,
      resolvePhoneCapableAccountSession: resolveAccountSession,
      serverCopies: () => run.copies,
    });
    const read = async () =>
      await h(op("workspace", "documentRead", { path: "docs/a.md" }, signedIn("owner")));
    const edit = () =>
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(f.update("title", "Lisbon"))).result.kind,
      ).toBe("accepted");
    return { f, engine, read, edit };
  }
  const edited = {
    ok: true,
    path: "docs/a.md",
    markdown: "---\ntitle: Lisbon\n---\n\nHello\n",
    objectId: "object",
  };

  it("reads an edit the relay accepted before it settles, and writes nothing", async () => {
    const { f, engine, read, edit } = await livePage();
    expect(await answer(await read())).toEqual({
      ok: true,
      path: "docs/a.md",
      markdown: "Hello\n",
      objectId: "object",
    });
    edit();
    const journal = f.journalRows().journal.length;
    expect(await answer(await read())).toEqual(edited);
    expect(f.journalRows().journal).toHaveLength(journal);
    expect(new Set(engine.methods())).toEqual(new Set(["versions.active", "versionedText.read"]));
  });

  it("reads a format-2 note the relay hosts as its text", async () => {
    admitBodySequenceNotes(true);
    cleanup.push(async () => admitBodySequenceNotes(false));
    const { read } = await livePage(undefined, seededNote());
    const { markdown } = (await answer(await read())) as { markdown: string };
    expect(markdown).toMatch(/^---\nstatus: draft\n---\n\n# Trip plan\n/);
  });
});

describe("file reads through the server's copy", () => {
  function seedFiles(engine: TestEngine) {
    for (const [path, text] of [
      ["docs/plan.md", "# Plan\n"],
      ["docs/trips/lisbon.md", "Alfama\n"],
      ["Docs/old.md", "Old\n"],
    ] as const) {
      engine.files.seedTextFile({ workspace: "trip", path, text, objectId: `object-${path}` });
    }
    engine.listedHidden.push(".env", "docs/.env.local", "a/.env/b.md", "docs/.DS_Store.");
    engine.files.seedBinaryFile({
      workspace: "trip",
      path: "photo.png",
      bytes: [1, 2, 3],
      objectId: "object-photo",
    });
  }
  const paths = (result: Record<string, unknown>) => ({
    files: (result.files as Array<{ path: string }>).map((file) => file.path),
    folders: result.folders,
  });

  it("lists the copy's files in lexical order without hidden ones, and reads a text file", async () => {
    const { engine, h, syncs } = await relay();
    seedFiles(engine);
    const listed = await answer(await h(op("trip", "listFiles")));
    expect(paths(listed)).toEqual({
      files: ["Docs/old.md", "docs/plan.md", "docs/trips/lisbon.md", "photo.png"],
      folders: ["Docs", "docs", "docs/trips"],
    });
    expect((listed.files as unknown[])[3]).toEqual({
      path: "photo.png",
      objectId: "object-photo",
      contentKind: "binary",
      byteLength: 3,
    });
    expect(
      paths(await answer(await h(op("trip", "listFiles", { path: "docs", recursive: false })))),
    ).toEqual({ files: ["docs/plan.md"], folders: ["docs", "docs/trips"] });
    expect(await answer(await h(op("trip", "readText", { path: "./docs//plan.md" })))).toEqual({
      ok: true,
      path: "docs/plan.md",
      text: "# Plan\n",
    });
    expect(await answer(await h(op("trip", "readText", { path: "photo.png" })))).toEqual({
      ok: false,
      reason: "dohc: photo.png is not a text file.",
      refusal: "binary",
    });
    expect(syncs).toEqual(["trip", "trip", "trip", "trip"]);
  });

  it("reads a secret file exactly as a missing one, without asking the engine", async () => {
    const { engine, h } = await relay();
    seedFiles(engine);
    const missing = (path: string) => ({ ok: false, reason: `dohc: No file at ${path}.` });
    expect(await answer(await h(op("trip", "readText", { path: "docs/missing.md" })))).toEqual(
      missing("docs/missing.md"),
    );
    const reads = engine.files.requests.length;
    for (const [path, normalized] of [
      [".env", ".env"],
      ["%2Eenv", ".env"],
      ["docs/.env.local", "docs/.env.local"],
      ["a/.env/b.md", "a/.env/b.md"],
    ] as const) {
      expect(await answer(await h(op("trip", "readText", { path }))), path).toEqual(
        missing(normalized),
      );
    }
    expect(engine.files.requests.slice(reads).map((request) => request.method)).toEqual([]);
    expect(
      JSON.stringify(await answer(await h(op("trip", "listFiles", { path: "a" })))),
    ).not.toContain(".env");
  });

  it("takes exactly the file reads' arguments, and words an engine failure without its detail", async () => {
    const { engine, h } = await relay();
    seedFiles(engine);
    for (const [name, args] of [
      ["listFiles", { cwd: "/" }],
      ["listFiles", { path: 1 }],
      ["listFiles", { recursive: "no" }],
      ["readText", {}],
      ["readText", { path: "a.md", actor: "human" }],
    ] as const) {
      const response = await h(op("trip", name, args));
      expect(response.status, `${name} ${JSON.stringify(args)}`).toBe(400);
    }
    engine.failing.set(
      "versionedText.list",
      new Error("The engine could not open /srv/dohc/engine.db."),
    );
    expect(await answer(await h(op("trip", "listFiles")))).toEqual({
      ok: false,
      reason: "failed to list files",
    });
  });
});

describe("an account's change feed", () => {
  it("delivers a change made between a read and the feed's start, from the log alone", async () => {
    const { storage, activity, engine, h, syncs } = await relay();
    await seedTrip(engine);
    const { cursor } = await json(await h(op("trip", "groups")));
    const write = logWriter(storage, activity);
    write("moment.append", { objectId: "object-plan", path: "docs/plan.md", versionId: "main" });
    write("chat.message.append", { threadId: "thread-stay", messageId: "m" });
    write("chat.channel.create", { channelId: "c" });
    write("moment.append", { objectId: "object-photo", path: "photo.png", versionId: "main" });
    const last = write("moment.append", {
      objectId: "object-photo",
      path: null,
      versionId: "main",
    });
    const delivered = await feed(await h(changes(String(cursor))));
    expect(delivered).toEqual({
      ok: true,
      cursor: `0.${last}.0`,
      changed: {
        files: ["object-plan", "object-photo"],
        pages: ["object-plan"],
        chats: ["thread-stay"],
      },
    });
    expect(await feed(await h(changes(String(delivered.cursor))))).toEqual({
      ok: true,
      cursor: `0.${last}.0`,
      changed: {},
    });
    expect(syncs).toEqual(["trip"]);
  });

  it("leaves out changes on secret files, and keeps waiting through them", async () => {
    let checks = 0;
    const { storage, activity, h } = await relay({
      resolve: async (request) => {
        checks += 1;
        return await resolveAccountSession(request);
      },
    });
    const write = logWriter(storage, activity);
    write("moment.append", { objectId: "object-keys", path: "docs/keys.md", versionId: "main" });
    // A thread made on .env whose object now sits at a public path stays hidden, as its reads hide it.
    write("moment.append", { objectId: "object-moved", path: "docs/moved.md", versionId: "main" });
    const start = write("chat.thread.create", {
      threadId: "thread-keys",
      linkedObjectId: "object-moved",
      linkedPathHint: ".env",
    });
    const held = h(changes(`0.${start}.0`, { hold: 30_000 }));
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const parked = checks;
    write("moment.append", { objectId: "object-env", path: ".env", versionId: "main" });
    write("moment.append", {
      objectId: "object-ignored",
      path: "docs/.DS_Store.",
      versionId: "main",
    });
    write("chat.message.append", { threadId: "thread-keys", messageId: "m" });
    await expect.poll(() => checks).toBeGreaterThan(parked);
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const last = write("moment.append", {
      objectId: "object-keys",
      path: ".env.local",
      versionId: "main",
    });
    expect(await feed(await held)).toEqual({
      ok: true,
      cursor: `0.${last}.0`,
      changed: { files: ["object-keys"], pages: ["object-keys"] },
    });
  });

  it("brings a page's accepted live edit before it settles", async () => {
    const f = registered({ deployment: true });
    cleanup.push(async () => f.close());
    f.storage.claimWorkspaceIdentity({
      workspaceId: "workspace",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    const engine = new TestEngine();
    engine.files.seedTextFile({
      workspace: "workspace",
      path: "docs/a.md",
      text: "Hello\n",
      objectId: "object",
    });
    const run = await serverCopies(f.storage, engine);
    const h = testHandler(f.storage, {
      resolveAccountSession,
      resolvePhoneCapableAccountSession: resolveAccountSession,
      serverCopies: () => run.copies,
    });
    const read = await json(
      await h(op("workspace", "documentRead", { path: "docs/a.md" }, signedIn("owner"))),
    );
    const edit = (title: string) =>
      expect(
        f.storage.commitLiveUpdateJournal(f.capture(f.update("title", title), `edit-${title}`))
          .result.kind,
      ).toBe("accepted");
    edit("Lisbon");
    const delivered = await feed(
      await h(
        changes(String(read.cursor), { workspaceId: "workspace", headers: signedIn("owner") }),
      ),
    );
    expect(delivered.changed).toEqual({ pages: ["object"] });
    const held = h(
      changes(String(delivered.cursor), {
        workspaceId: "workspace",
        headers: signedIn("owner"),
        hold: 30_000,
      }),
    );
    edit("Porto");
    expect((await feed(await held)).changed).toEqual({ pages: ["object"] });
    const rows = f.storage.accountFeedJournalRows({
      workspaceId: "workspace",
      after: 0,
      through: Number.MAX_SAFE_INTEGER,
      limit: 1,
    });
    expect(rows).toEqual([
      { journalCursor: expect.any(Number), objectId: "object", path: "docs/a.md" },
    ]);
    expect(
      f.storage.accountFeedJournalRows({
        workspaceId: "workspace",
        after: rows[0]!.journalCursor,
        through: Number.MAX_SAFE_INTEGER,
        limit: 5,
      }),
    ).toHaveLength(1);
  });

  it("answers replace for a cursor from before a restore, or past what the workspace holds", async () => {
    const { storage, activity, h } = await relay();
    const relaySeq = logWriter(storage, activity)("chat.channel.create", { channelId: "c" });
    const current = `0.${relaySeq}.0`;
    for (const since of ["1.0.0", `0.${relaySeq + 1}.0`, `0.${relaySeq}.1`]) {
      expect(await feed(await h(changes(since))), since).toEqual({
        ok: true,
        cursor: current,
        replace: true,
      });
    }
    for (const since of ["", "x", "1.2", "01.0.0", "0.0.0.0", "0.-1.0", "0.99999999999999999.0"]) {
      const response = await h(changes(since));
      expect(response.status, since).toBe(400);
      expect(await json(response)).toMatchObject({ code: "bad_request" });
    }
    const response = await h(changes(current, { hold: 30_001 }));
    expect(response.status).toBe(400);

    // A restore set the log floor where the log stood.
    const context = storage as StorageContext;
    context.tx(() =>
      context.db
        .prepare("UPDATE sync_relay_workspaces SET epoch_log_floor = ? WHERE workspace_id = 'trip'")
        .run(relaySeq),
    );
    const restored = `${relaySeq}.${relaySeq}.0`;
    for (const since of [current, `${relaySeq}.0.0`]) {
      expect(await feed(await h(changes(since))), since).toEqual({
        ok: true,
        cursor: restored,
        replace: true,
      });
    }
    expect(await feed(await h(changes(restored)))).toEqual({
      ok: true,
      cursor: restored,
      changed: {},
    });
  });

  it("answers server_busy past one account's waits, across its sign-ins, while another account still waits", async () => {
    const { storage, activity, h } = await relay();
    const stop = new AbortController();
    const held = Array.from({ length: ACCOUNT_FEED_WAITS_PER_ACCOUNT }, (_, index) =>
      h(
        changes("0.0.0", {
          hold: 30_000,
          signal: stop.signal,
          headers: signedIn("ana", `phone-${index}`),
        }),
      ),
    );
    await expect.poll(() => activity.stats().waiters).toBe(ACCOUNT_FEED_WAITS_PER_ACCOUNT);
    const busy = await h(
      changes("0.0.0", { hold: 30_000, headers: signedIn("ana", "another-phone") }),
    );
    expect(busy.status).toBe(503);
    expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    const other = h(
      changes("0.0.0", { hold: 30_000, workspaceId: "budget", headers: signedIn("ben") }),
    );
    await expect.poll(() => activity.stats().waiters).toBe(ACCOUNT_FEED_WAITS_PER_ACCOUNT + 1);
    const relaySeq = logWriter(
      storage,
      activity,
      "budget",
    )("chat.channel.create", { channelId: "c" });
    expect(await feed(await other)).toEqual({
      ok: true,
      cursor: `0.${relaySeq}.0`,
      changed: { chats: [] },
    });
    stop.abort();
    for (const response of await Promise.all(held)) expect(response.status).toBe(200);
  });
});

describe("an account's chat writes through the server's copy", () => {
  const ORIGIN = "https://relay.example.test";
  type AccessChange = "sign-in" | "owner" | "show on phone";
  const ACCESS_CHANGES: readonly AccessChange[] = ["owner"];

  /**
   * The route over one copy of "trip", whose engine writes a receipt for each
   * keyed stage and whose step pushes the receipts' rows to the relay's log,
   * which accepts them. The account's name comes from `named`. Access can
   * change at a numbered check of the sign-in: the first is before the
   * arguments, then after them, after the name lookup, once the copy is open,
   * and once the write's lock is held.
   */
  async function writeRelay(
    options: {
      limiter?: TokenBucketLimiter;
      nowMs?: () => number;
      activity?: DiscussionActivityHub;
    } = {},
  ) {
    const storage = await testStorage();
    const context = storage as StorageContext;
    storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
    storage.claimWorkspaceIdentity({
      workspaceId: "trip",
      replicationEpoch: "epoch",
      streamIdentity: "stream",
    });
    const row = storage.joinAutomationWorkspace({
      workspaceId: "trip",
      nowMs: 1,
      reasons: ["account"],
    })!;
    const engine = new PhoneWriteEngine("trip", "server-copy");
    engine.files.seedTextFile({
      workspace: "trip",
      path: "README.md",
      text: "# Trip\n",
      objectId: "object-readme",
    });
    const seeded = await seedPhoneChats(
      new ChatsLiveAdapter(engine.chats, "trip", { workspaceId: "trip" }),
      "trip",
      "ana",
    );
    const syncs: string[] = [];
    let syncError: Error | null = null;
    let heldStep: { reached(): void; open: Promise<void> } | null = null;
    let stepError: Error | null = null;
    let requestId = 0;
    const lifetime = new AbortController();
    const copy: AutomationReplica = {
      workspaceId: "trip",
      ownerUserId: "ana",
      incarnation: row.incarnation,
      reasons: row.reasons,
      startedAtMs: 1,
      pulledHead: 0,
      root: "unused",
      metadataDir: "unused",
      client: engine as unknown as EngineClient,
      workspace: "trip",
      signal: lifetime.signal,
      nextRequestId: () => ++requestId,
      withRecordWork: (work) => work(),
      busy: () => false,
      sync: async () => {
        syncs.push("trip");
        if (syncError !== null) throw syncError;
      },
      // As a copy's step does, it gives up, rejecting, when its caller's signal aborts.
      step: async (signal) => {
        const held = heldStep;
        heldStep = null;
        if (held !== null) {
          held.reached();
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            void held.open.then(resolve);
          });
        }
        if (stepError !== null) throw stepError;
        engine.push((pushed) =>
          context.tx(() =>
            context.db
              .prepare(`INSERT INTO sync_relay_log
          (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) VALUES ('trip', 'server-copy', ?, ?, ?, 1)`)
              .run(pushed.originSeq, pushed.kind, JSON.stringify(pushed.payload)),
          ),
        );
        return true;
      },
    };
    let open = false;
    let closes = 0;
    let pass = () => {};
    const copies = await startServerCopies({
      storage,
      root: "unused",
      engineExecutable: "unused",
      relayOrigin: ORIGIN,
      key: new Uint8Array(32),
      namespace: "test",
      startReplicas: async (hooks) => {
        pass = () => {
          const reasons = hooks.wanted().get("trip");
          const joined =
            reasons === undefined
              ? null
              : storage.joinAutomationWorkspace({ workspaceId: "trip", nowMs: 1, reasons });
          const opens =
            joined?.incarnation === copy.incarnation && joined.ownerUserId === copy.ownerUserId;
          // The copy opens before the hook, whose recheck reads it.
          const was = open;
          open = opens;
          if (opens && !was) hooks.onChanged?.("trip");
          if (was && !opens) closes += 1;
        };
        return {
          unavailable: false,
          replica: (id) => (id === "trip" && open ? copy : undefined),
          reconcile: () => queueMicrotask(pass),
          deleteWorkspaces: async () => undefined,
          failedSyncs: () => new Map(),
          settled: async () => undefined,
          close: async () => undefined,
        };
      },
    });
    cleanup.push(async () => {
      lifetime.abort();
      await copies.close();
    });

    let checks = 0;
    let changeAt: { check: number; kind: AccessChange } | null = null;
    let heldCheck: { at: number; reached(): void; open: Promise<void> } | null = null;
    let signedOut = false;
    let name: () => string | null = () => "Ana";
    const change = (kind: AccessChange) => {
      if (kind === "sign-in") signedOut = true;
      else if (kind === "owner")
        context.tx(() =>
          context.db
            .prepare(
              "UPDATE sync_relay_workspaces SET owner_user_id = 'ben' WHERE workspace_id = 'trip'",
            )
            .run(),
        );
      else storage.setShowOnPhone({ userId: "ana", workspaceId: "trip", showOnPhone: false });
    };
    // The computers' routes and the phone's share one counted check, as one resolver served both before.
    const resolve: ResolveAccountSession = async (request) => {
      const session = await resolveAccountSession(request);
      checks += 1;
      if (changeAt !== null && checks === changeAt.check) change(changeAt.kind);
      if (heldCheck !== null && checks === heldCheck.at) {
        const hold = heldCheck;
        heldCheck = null;
        hold.reached();
        await hold.open;
      }
      return signedOut ? { ...session, sessionId: "another" } : session;
    };
    const h = testHandler(storage, {
      resolveAccountSession: resolve,
      resolvePhoneCapableAccountSession: resolve,
      serverCopies: () => copies,
      accountOperationRateLimiter: options.limiter ?? new TokenBucketLimiter(10_000, 1, 16),
      lookupUserDisplayName: () => name(),
      relayPublicOrigin: ORIGIN,
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      ...(options.activity ? { discussionActivity: options.activity } : {}),
    });
    return {
      storage,
      engine,
      copy,
      h,
      syncs,
      seeded,
      change,
      /** How many times a request has checked its sign-in. */
      checks: () => checks,
      write: (operation: string, args: unknown) => h(op("trip", operation, args)),
      rows: () =>
        Number(
          context.db.prepare("SELECT count(*) AS n FROM sync_relay_account_operations").get()?.n,
        ),
      changeAt: (check: number, kind: AccessChange) => {
        changeAt = { check, kind };
      },
      holdCheck: (nth: number) => {
        let reached!: () => void, release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        heldCheck = {
          at: checks + nth,
          reached,
          open: new Promise<void>((resolve) => {
            release = resolve;
          }),
        };
        return { reached: waiting, release: () => release() };
      },
      named: (next: () => string | null) => {
        name = next;
      },
      failSync: (error: Error | null) => {
        syncError = error;
      },
      failStep: (error: Error | null) => {
        stepError = error;
      },
      /** Runs a pass of the copies now, which closes the copy unless something still needs it. */
      reconcile: () => pass(),
      copyOpen: () => open,
      closes: () => closes,
      holdStep: () => {
        let reached!: () => void, release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          reached = resolve;
        });
        heldStep = {
          reached,
          open: new Promise<void>((resolve) => {
            release = resolve;
          }),
        };
        return { reached: waiting, release: () => release() };
      },
      /** Runs a write on the copy as an earlier request did, which gave up waiting for its publication at once. */
      earlier: (write: PhoneWrite) => {
        let ms = 0;
        return runPhoneWrite({
          storage,
          copy,
          write,
          writer: { accountId: "ana", displayName: "Ana", serverUrl: ORIGIN },
          authorize: async () => undefined,
          nowMs: () => ms,
          pause: async (wait) => {
            ms += wait;
          },
          deadlineMs: 1_000,
        });
      },
    };
  }
  type WriteRelay = Awaited<ReturnType<typeof writeRelay>>;
  const schemaRefusal = (operation: string) => ({
    ok: false,
    code: "bad_request",
    error: `the arguments do not fit ${operation}`,
  });

  it("saves each write as the session's account by its name now, and answers a retry from its row with the author it first had", async () => {
    const f = await writeRelay();
    const { planning } = f.seeded;
    const post = {
      operationId: "op-post",
      groupId: planning.channelId,
      title: "Dinner",
      body: "Where?",
    };
    const posted = await json(await f.write("post", post));
    const ids = phoneWriteIds("ana", "trip", "op-post");
    expect(posted).toEqual({
      ok: true,
      result: {
        ok: true,
        state: "saved",
        threadId: ids.threadId,
        messageId: ids.messageId("post"),
      },
      cursor: "0.0.0",
    });
    expect(f.engine.writes).toMatchObject([
      {
        method: CHATS_METHOD.threadStart,
        params: { authorDisplayName: "Ana", authorUserId: "ana" },
      },
    ]);
    expect(
      await answer(
        await f.write("send", {
          operationId: "op-send",
          streamId: planning.channelId,
          body: "Lunch?",
        }),
      ),
    ).toMatchObject({
      ok: true,
      state: "saved",
      threadId: phoneWriteIds("ana", "trip", "op-send").threadId,
    });
    expect(
      await answer(
        await f.write("reply", {
          operationId: "op-reply",
          threadId: "thread-stay",
          parentMessageId: "message-stay",
          body: "By the river.",
        }),
      ),
    ).toEqual({
      ok: true,
      state: "saved",
      threadId: "thread-stay",
      messageId: phoneWriteIds("ana", "trip", "op-reply").messageId("reply"),
    });
    expect(
      await answer(
        await f.write("reply", {
          operationId: "op-answer",
          threadId: "thread-stay",
          body: "Alfama",
          resolves: { messageId: "message-poll", chosenOption: " Alfama " },
        }),
      ),
    ).toMatchObject({ ok: true, state: "saved", threadId: "thread-stay" });
    for (const state of ["added", "removed"]) {
      expect(
        await answer(
          await f.write("react", {
            operationId: `op-${state}`,
            messageId: "message-stay",
            emoji: "👍",
            state,
          }),
        ),
        state,
      ).toMatchObject({ ok: true, state: "saved", threadId: "thread-stay" });
    }

    f.named(() => "Ana Maria");
    await answer(
      await f.write("reply", { operationId: "op-renamed", threadId: "thread-stay", body: "Hi" }),
    );
    expect(f.engine.writes.at(-1)).toMatchObject({
      method: CHATS_METHOD.messageSend,
      params: { authorDisplayName: "Ana Maria" },
    });
    const writes = f.engine.writes.length;
    expect((await json(await f.write("post", post))).result).toEqual(posted.result);
    expect(f.engine.writes).toHaveLength(writes);

    const lost = { operationId: "op-lost", threadId: "thread-stay", body: "Baixa" };
    f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
    expect(await f.earlier({ operation: "reply", args: lost })).toMatchObject({
      ok: true,
      state: "pending",
    });
    f.engine.failing.clear();
    expect(await answer(await f.write("reply", lost))).toMatchObject({
      ok: true,
      state: "saved",
      threadId: "thread-stay",
    });
    expect(f.engine.writes.at(-1)).toMatchObject({
      method: CHATS_METHOD.messageSend,
      params: { authorDisplayName: "Ana", body: "Baixa" },
    });
  });

  it("refuses a field outside each write's schema, in an answer's resolves too, before the copy syncs", async () => {
    const f = await writeRelay();
    const valid: Record<string, Record<string, unknown>> = {
      post: { operationId: "op", groupId: "channel-nowhere", body: "Hi" },
      send: { operationId: "op", streamId: "channel-nowhere", body: "Hi" },
      reply: { operationId: "op", threadId: "thread-stay", body: "Hi" },
      react: { operationId: "op", messageId: "message-stay", emoji: "👍", state: "added" },
    };
    const forbidden: Record<string, unknown> = {
      runId: "run",
      reported: { product: "Nova" },
      work: { status: "done" },
      agent: "Nova",
      attachments: [],
      cwd: "/",
      actor: "human",
      agentId: "nova",
      token: "a".repeat(64),
      runSecret: "a".repeat(64),
      door: "cli",
      author: { kind: "human", displayName: "Ben" },
      authorKind: "human",
      authorDisplayName: "Ben",
      authorUserId: "ben",
      authorActorKey: "key",
      idempotencyKey: "key",
      stageKey: "key",
      stageReceipt: true,
    };
    const requests: Array<[label: string, operation: string, args: Record<string, unknown>]> = [];
    for (const [operation, args] of Object.entries(valid)) {
      for (const [field, value] of Object.entries(forbidden))
        requests.push([`${operation} ${field}`, operation, { ...args, [field]: value }]);
    }
    // IDs the server derives, where the write names no such target.
    for (const operation of ["post", "send", "reply"])
      requests.push([
        `${operation} messageId`,
        operation,
        { ...valid[operation], messageId: "message-mine" },
      ]);
    for (const operation of ["post", "send"])
      requests.push([
        `${operation} threadId`,
        operation,
        { ...valid[operation], threadId: "thread-mine" },
      ]);
    for (const [field, value] of Object.entries({
      ...forbidden,
      resolvedByMessageId: "message-mine",
      threadId: "thread-stay",
    })) {
      requests.push([
        `resolves ${field}`,
        "reply",
        { ...valid.reply, resolves: { messageId: "message-poll", [field]: value } },
      ]);
    }
    for (const [label, operation, args] of requests) {
      const response = await f.write(operation, args);
      expect(response.status, label).toBe(400);
      expect(await json(response), label).toEqual(schemaRefusal(operation));
    }
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
    expect(f.syncs).toEqual([]);

    for (const [operation, args] of Object.entries(valid)) {
      expect(
        (await f.write(operation, { ...args, operationId: `op-${operation}` })).status,
        operation,
      ).toBe(200);
    }
  });

  it("reads a write's arguments, and answers an unknown or reserved name as missing without reading them", async () => {
    const f = await writeRelay();
    const streamed = (operation: string) => {
      const read = { pulled: false };
      const request = new Request(`http://relay.test/sync/trip/ops/${operation}`, {
        method: "POST",
        headers: { ...signedIn("ana"), "content-type": "application/json" },
        duplex: "half",
        body: new ReadableStream(
          {
            pull(controller) {
              read.pulled = true;
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      } as RequestInit & { duplex: "half" });
      return { request, read };
    };
    const missing = await denialBytes(await f.write("changes", {}));
    for (const name of ["changes", "groupCreate", "toString", "__proto__", "constructor"]) {
      const { request, read } = streamed(name);
      expect(await denialBytes(await f.h(request)), name).toBe(missing);
      expect(read.pulled, name).toBe(false);
    }
    for (const name of ["post", "send", "reply", "react", "markRead", "retryWake"]) {
      const { request, read } = streamed(name);
      const response = await f.h(request);
      expect(await json(response), name).toEqual(schemaRefusal(name));
      expect(read.pulled, name).toBe(true);
    }
    expect(f.syncs).toEqual([]);
  });

  it("keeps the body limit and the sign-in's rate on writes", async () => {
    const f = await writeRelay({ limiter: new TokenBucketLimiter(1, 0.001, 16) });
    expect(
      (
        await f.write("reply", {
          operationId: "op",
          threadId: "thread-stay",
          body: "a".repeat(256 * 1024),
        })
      ).status,
    ).toBe(413);
    const limited = await f.write("reply", {
      operationId: "op",
      threadId: "thread-stay",
      body: "Hi",
    });
    expect(limited.status).toBe(503);
    expect(await json(limited)).toMatchObject({ ok: false, code: "server_busy" });
    expect(f.rows()).toBe(0);
    expect(f.syncs).toEqual([]);
  });

  it("answers a hidden target with the same status, type and bytes as a missing one, for each write", async () => {
    const f = await writeRelay();
    const { onSecret } = f.seeded;
    const bytes = async (operation: string, args: Record<string, unknown>, id: string) => {
      const response = await f.write(operation, args);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: (await response.text()).replaceAll(id, "<id>"),
      };
    };
    const cases: Array<
      [
        label: string,
        hidden: Record<string, unknown>,
        hiddenId: string,
        absent: Record<string, unknown>,
        absentId: string,
      ]
    > = [
      [
        "a reply",
        { threadId: onSecret.id },
        onSecret.id,
        { threadId: "thread-nowhere" },
        "thread-nowhere",
      ],
      [
        "a reply under a parent",
        { threadId: "thread-stay", parentMessageId: "message-secret" },
        "message-secret",
        { threadId: "thread-stay", parentMessageId: "message-nowhere" },
        "message-nowhere",
      ],
      [
        "an answer",
        { threadId: onSecret.id, resolves: { messageId: "message-secret" } },
        onSecret.id,
        { threadId: "thread-nowhere", resolves: { messageId: "message-secret" } },
        "thread-nowhere",
      ],
    ];
    let next = 0;
    for (const [label, hidden, hiddenId, absent, absentId] of cases) {
      const answered = await bytes(
        "reply",
        { operationId: `op-${++next}`, body: "Hi", ...hidden },
        hiddenId,
      );
      expect(answered.status, label).toBe(200);
      expect(answered.body, label).toContain('"refusal":"missing"');
      expect(
        await bytes("reply", { operationId: `op-${++next}`, body: "Hi", ...absent }, absentId),
        label,
      ).toEqual(answered);
    }
    const reaction = (messageId: string) => ({
      operationId: `op-${++next}`,
      messageId,
      emoji: "👍",
      state: "added",
    });
    const reacted = await bytes("react", reaction("message-secret"), "message-secret");
    expect(reacted.body).toContain('"refusal":"missing"');
    expect(await bytes("react", reaction("message-nowhere"), "message-nowhere")).toEqual(reacted);
    expect(
      await answer(
        await f.write("post", { operationId: "op-post", groupId: "channel-nowhere", body: "Hi" }),
      ),
    ).toEqual({ ok: false, reason: "dohc: no such group: channel-nowhere", refusal: "missing" });
    expect(
      await answer(
        await f.write("send", { operationId: "op-send", streamId: "channel-nowhere", body: "Hi" }),
      ),
    ).toEqual({ ok: false, reason: "dohc: no such group: channel-nowhere", refusal: "missing" });
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("freezes each message's wake targets from the account's own computers before the engine writes, and publishes them without its text", async () => {
    const f = await writeRelay();
    const { planning, onSecret } = f.seeded;
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    const declare = async (
      installId: string,
      computerLabel: string,
      runners: Array<{ agentId: string; displayName: string }>,
    ) => {
      const response = await f.h(
        new Request("http://relay.test/sync/workspaces/trip/runners", {
          method: "PUT",
          headers: { ...signedIn("ana", "mac"), "content-type": "application/json" },
          body: JSON.stringify({
            installId,
            computerLabel,
            runners: runners.map((runner) => ({ ...runner, enabled: true })),
          }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
    };
    await declare("mac", "Ana's Mac", [{ agentId: "default", displayName: "Claude" }]);
    await declare("laptop", "Ana's Laptop", [
      { agentId: "default", displayName: "Codex" },
      { agentId: "helper", displayName: "Claude" },
    ]);
    // Posts opened by the account's Claude, by a participant's agent with the same ID and name, and by an agent no computer runs.
    for (const [threadId, authorUserId, displayName] of [
      ["thread-claude", "ana", "Claude"],
      ["thread-ben", "ben", "Claude"],
      ["thread-nova", "ana", "Nova"],
    ] as const) {
      await chats.startChannelThread({
        workspaceId: "trip",
        channelId: planning.channelId,
        threadId,
        messageId: `${threadId}-opening`,
        lane: "posts",
        author: { kind: "agent", displayName },
        authorOwnerDisplayName: "Ana",
        authorUserId,
        authorAgentId: "default",
        authorActorKey: null,
        body: "Done.",
      });
    }
    const db = (f.storage as StorageContext).db;
    type Frozen = { targets: Array<{ target: string; candidates: unknown[] }>; unmatched: boolean };
    const frozen = (operationId: string) =>
      (
        JSON.parse(
          String(
            db
              .prepare(
                "SELECT command_json FROM sync_relay_account_operations WHERE account_id = 'ana' AND operation_id = ?",
              )
              .get(operationId)?.command_json,
          ),
        ) as { wakes: Frozen }
      ).wakes;
    const candidate = (
      installId: string,
      agentId: string,
      label: string,
      matched: Record<string, string>,
    ) => ({ installId, agentId, label, matched });
    const mac = (matched: Record<string, string>) =>
      candidate("mac", "default", "Ana's Mac", matched);
    const saved = async (operation: string, args: Record<string, unknown>) =>
      expect(await answer(await f.write(operation, args))).toMatchObject({
        ok: true,
        state: "saved",
      });

    await saved("reply", { operationId: "op-answered", threadId: "thread-claude", body: "Thanks" });
    expect(frozen("op-answered")).toEqual({
      targets: [{ target: "implicit:mac:default", candidates: [mac({ displayName: "Claude" })] }],
      unmatched: false,
    });
    await saved("reply", { operationId: "op-participant", threadId: "thread-ben", body: "Thanks" });
    expect(frozen("op-participant"), "a participant's agent is no one's to wake").toEqual({
      targets: [],
      unmatched: false,
    });
    await saved("reply", { operationId: "op-nobody", threadId: "thread-nova", body: "Thanks" });
    expect(frozen("op-nobody"), "no computer runs Nova").toEqual({ targets: [], unmatched: true });
    await saved("post", {
      operationId: "op-codex",
      groupId: planning.channelId,
      body: "@codex look",
    });
    expect(frozen("op-codex").targets).toEqual([
      {
        target: "mention:codex",
        candidates: [candidate("laptop", "default", "Ana's Laptop", { handle: "codex" })],
      },
    ]);
    await saved("reply", {
      operationId: "op-both",
      threadId: "thread-claude",
      body: "@claude yes, secret-phrase-xyz",
    });
    expect(frozen("op-both"), "the answered Claude is already a candidate of the mention").toEqual({
      targets: [
        {
          target: "mention:claude",
          candidates: [
            candidate("laptop", "helper", "Ana's Laptop", { handle: "claude" }),
            mac({ handle: "claude" }),
          ],
        },
      ],
      unmatched: false,
    });
    await saved("react", {
      operationId: "op-react",
      messageId: "thread-claude-opening",
      emoji: "👍",
      state: "added",
    });
    expect(frozen("op-react")).toEqual({ targets: [], unmatched: false });

    const lost = { operationId: "op-lost", threadId: "thread-claude", body: "Again" };
    f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
    expect(await f.earlier({ operation: "reply", args: lost })).toMatchObject({
      ok: true,
      state: "pending",
    });
    f.engine.failing.clear();
    await declare("mac", "Ana's Mac", []);
    await declare("desktop", "Ana's Desktop", [{ agentId: "default", displayName: "Claude" }]);
    await saved("reply", lost);

    const rows = db.prepare("SELECT * FROM sync_relay_chat_wakes ORDER BY operation_id").all();
    const ids = (operationId: string) => phoneWriteIds("ana", "trip", operationId);
    expect(
      rows.map((row) => [
        row.operation_id,
        row.message_id,
        row.thread_id,
        row.target,
        row.state,
        JSON.parse(String(row.candidates_json)),
      ]),
    ).toEqual([
      [
        "op-answered",
        ids("op-answered").messageId("reply"),
        "thread-claude",
        "implicit:mac:default",
        "waiting",
        [mac({ displayName: "Claude" })],
      ],
      [
        "op-both",
        ids("op-both").messageId("reply"),
        "thread-claude",
        "mention:claude",
        "waiting",
        frozen("op-both").targets[0]!.candidates,
      ],
      [
        "op-codex",
        ids("op-codex").messageId("post"),
        ids("op-codex").threadId,
        "mention:codex",
        "waiting",
        frozen("op-codex").targets[0]!.candidates,
      ],
      [
        "op-lost",
        ids("op-lost").messageId("reply"),
        "thread-claude",
        "implicit:mac:default",
        "waiting",
        [mac({ displayName: "Claude" })],
      ],
    ]);
    expect(JSON.stringify(rows), "a wake keeps no message text").not.toContain("secret-phrase-xyz");

    const bytes = async (operationId: string, threadId: string) =>
      (
        await (await f.write("reply", { operationId, threadId, body: "@claude hi" })).text()
      ).replaceAll(threadId, "<id>");
    expect(await bytes("op-hidden", onSecret.id)).toBe(await bytes("op-missing", "thread-nowhere"));
  });

  const declare = async (
    f: WriteRelay,
    installId: string,
    runners: Array<{ agentId: string; displayName: string }>,
  ) => {
    const response = await f.h(
      new Request("http://relay.test/sync/workspaces/trip/runners", {
        method: "PUT",
        headers: { ...signedIn("ana", "mac"), "content-type": "application/json" },
        body: JSON.stringify({
          installId,
          computerLabel: `${installId} label`,
          runners: runners.map((runner) => ({ ...runner, enabled: true })),
        }),
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const frozenTargets = (f: WriteRelay, operationId: string) =>
    (
      JSON.parse(
        String(
          (f.storage as StorageContext).db
            .prepare(
              "SELECT command_json FROM sync_relay_account_operations WHERE account_id = 'ana' AND operation_id = ?",
            )
            .get(operationId)?.command_json,
        ),
      ) as {
        wakes: {
          targets: Array<{
            target: string;
            candidates: Array<{ installId: string; agentId: string }>;
          }>;
        };
      }
    ).wakes.targets;

  const wakesOf = (f: WriteRelay, operationId: string) =>
    (
      JSON.parse(
        String(
          (f.storage as StorageContext).db
            .prepare(
              "SELECT command_json FROM sync_relay_account_operations WHERE account_id = 'ana' AND operation_id = ?",
            )
            .get(operationId)?.command_json,
        ),
      ) as { wakes: { targets: unknown[]; unmatched: boolean } }
    ).wakes;
  const agentAuthor = (displayName: string) => ({
    author: { kind: "agent" as const, displayName },
    authorOwnerDisplayName: "Ana",
    authorUserId: "ana",
    authorAgentId: "default",
    authorActorKey: null,
  });

  it("takes a DM's newest agent message across both of its lanes", async () => {
    const f = await writeRelay();
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    await declare(f, "laptop", [{ agentId: "default", displayName: "Nova" }]);
    const dm = await chats.ensureAgentChannel({
      workspaceId: "trip",
      agentId: "default",
      name: "Claude",
    });
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: dm.channelId,
      threadId: "thread-dm",
      messageId: "dm-hello",
      lane: "chat",
      author: { kind: "human", displayName: "Ana" },
      authorUserId: "ana",
      authorActorKey: null,
      body: "Hello",
    });
    await chats.sendMessage({
      workspaceId: "trip",
      threadId: "thread-dm",
      messageId: "dm-claude",
      ...agentAuthor("Claude"),
      body: "Here.",
    });
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: dm.channelId,
      threadId: "thread-own",
      messageId: "own-nova",
      lane: "posts",
      ownThread: true,
      ...agentAuthor("Nova"),
      body: "Done.",
    });
    const send = async (operationId: string) =>
      expect(
        await answer(await f.write("send", { operationId, streamId: dm.channelId, body: "And?" })),
      ).toMatchObject({ ok: true, state: "saved" });
    await send("op-nova");
    expect(frozenTargets(f, "op-nova").map((target) => target.target)).toEqual([
      "implicit:laptop:default",
    ]);
    await chats.sendMessage({
      workspaceId: "trip",
      threadId: "thread-dm",
      messageId: "dm-claude-again",
      ...agentAuthor("Claude"),
      body: "Still here.",
    });
    await send("op-claude");
    expect(frozenTargets(f, "op-claude").map((target) => target.target)).toEqual([
      "implicit:mac:default",
    ]);
  });

  // A DM with `posts` threads of their own after its conversation, each opened by Ana unless `agentIn` names it.
  async function dmWithThreads(f: WriteRelay, posts: number, agentIn: number) {
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    const dm = await chats.ensureAgentChannel({
      workspaceId: "trip",
      agentId: "default",
      name: "Claude",
    });
    const human = {
      author: { kind: "human" as const, displayName: "Ana" },
      authorUserId: "ana",
      authorActorKey: null,
    };
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: dm.channelId,
      threadId: "thread-dm",
      messageId: "dm-hello",
      lane: "chat",
      ...human,
      body: "Hello",
    });
    for (let index = 0; index < posts; index += 1) {
      await chats.startChannelThread({
        workspaceId: "trip",
        channelId: dm.channelId,
        threadId: `thread-own-${index}`,
        messageId: `own-${index}`,
        lane: "posts",
        ownThread: true,
        ...(index === agentIn ? agentAuthor("Claude") : human),
        body: `Note ${index}`,
      });
    }
    return dm.channelId;
  }
  async function sendCounting(f: WriteRelay, operationId: string, streamId: string) {
    const asked = f.engine.asked.length;
    expect(
      await answer(await f.write("send", { operationId, streamId, body: "Still there?" })),
    ).toMatchObject({ ok: true, state: "saved" });
    const reads = f.engine.asked.slice(asked);
    const counted = (method: string) => reads.filter((each) => each === method).length;
    return {
      wakes: wakesOf(f, operationId),
      reads: [counted(CHATS_METHOD.threadsListForChannel), counted(CHATS_METHOD.messagesList)],
    };
  }

  it("wakes no one from a DM its budget can't cover, though it saw the agent's message, and still sends with the hint", async () => {
    const f = await writeRelay();
    // Six threads of one page each: the newest, read first, is the agent's; the budget ends after four.
    const streamId = await dmWithThreads(f, 5, 4);
    expect(await sendCounting(f, "op-long", streamId)).toEqual({
      wakes: { targets: [], unmatched: true },
      reads: [2, 4],
    });
  });

  it("wakes no one from a DM with more threads than one listing returns, without reading their messages", async () => {
    const f = await writeRelay();
    const streamId = await dmWithThreads(f, 9, 8);
    expect(await sendCounting(f, "op-wide", streamId)).toEqual({
      wakes: { targets: [], unmatched: true },
      reads: [2, 0],
    });
  });

  it("wakes no computer whose declaration's lease ended, by mention or by DM, until it declares again", async () => {
    let now = Date.now();
    const f = await writeRelay({ nowMs: () => now });
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    const dm = await chats.ensureAgentChannel({
      workspaceId: "trip",
      agentId: "default",
      name: "Claude",
    });
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: dm.channelId,
      threadId: "thread-dm",
      messageId: "dm-hello",
      lane: "chat",
      author: { kind: "human", displayName: "Ana" },
      authorUserId: "ana",
      authorActorKey: null,
      body: "Hello",
    });
    await chats.sendMessage({
      workspaceId: "trip",
      threadId: "thread-dm",
      messageId: "dm-claude",
      ...agentAuthor("Claude"),
      body: "Here.",
    });
    const send = async (operationId: string, body: string) => {
      expect(
        await answer(await f.write("send", { operationId, streamId: dm.channelId, body })),
      ).toMatchObject({ ok: true, state: "saved" });
      return frozenTargets(f, operationId).map((target) => target.target);
    };
    expect(await send("op-fresh", "@claude And?")).toEqual(["mention:claude"]);
    expect(await send("op-dm-fresh", "And?")).toEqual(["implicit:mac:default"]);
    now += CHAT_RUNNER_LEASE_MS;
    expect(await send("op-expired", "@claude And?")).toEqual([]);
    expect(await send("op-dm-expired", "And?")).toEqual([]);
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    expect(await send("op-refreshed", "@claude And?")).toEqual(["mention:claude"]);
  });

  it("takes a DM's agent by its message's time, not by when the message arrived", async () => {
    const f = await writeRelay();
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    await declare(f, "laptop", [{ agentId: "default", displayName: "Nova" }]);
    const dm = await chats.ensureAgentChannel({
      workspaceId: "trip",
      agentId: "default",
      name: "Claude",
    });
    const human = {
      author: { kind: "human" as const, displayName: "Ana" },
      authorUserId: "ana",
      authorActorKey: null,
    };
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: dm.channelId,
      threadId: "thread-dm",
      messageId: "dm-hello",
      lane: "chat",
      ...human,
      body: "Hello",
    });
    await chats.sendMessage({
      workspaceId: "trip",
      threadId: "thread-dm",
      messageId: "dm-claude",
      ...agentAuthor("Claude"),
      body: "Here.",
    });
    for (let index = 0; index < 500; index += 1) {
      await chats.sendMessage({
        workspaceId: "trip",
        threadId: "thread-dm",
        messageId: `dm-${index}`,
        ...human,
        body: `Note ${index}`,
      });
    }
    await chats.sendMessage({
      workspaceId: "trip",
      threadId: "thread-dm",
      messageId: "dm-import",
      ...agentAuthor("Nova"),
      body: "Earlier.",
    });
    // As a copy that synced Nova's message late holds it: last by arrival, on the first page read, with its sender's earlier time.
    const original = f.engine.chats.sendRequest.bind(f.engine.chats);
    vi.spyOn(f.engine.chats, "sendRequest").mockImplementation(async (request) => {
      const params = asRecord(request.params);
      if (
        request.method !== CHATS_METHOD.messagesList ||
        params === null ||
        params.threadId !== "thread-dm"
      )
        return await original(request);
      const all: Array<Record<string, JsonValue>> = [];
      let after: number | null = null;
      do {
        const page = (
          await original({
            ...request,
            params: {
              threadId: "thread-dm",
              limit: 500,
              ...(after === null ? {} : { afterMessageOrder: after }),
            },
          })
        ).result as unknown as {
          messages: Array<Record<string, JsonValue>>;
          nextAfterMessageOrder: number | null;
        };
        all.push(...page.messages);
        after = page.nextAfterMessageOrder;
      } while (after !== null);
      const arrived = [
        ...all.filter((message) => message.id !== "dm-import"),
        ...all
          .filter((message) => message.id === "dm-import")
          .map((message): Record<string, JsonValue> => ({ ...message, createdAtMs: 0 })),
      ];
      const start =
        (typeof params.afterMessageOrder === "number" ? params.afterMessageOrder : -1) + 1;
      const rows = arrived.slice(start, start + Number(params.limit));
      return {
        id: request.id,
        result: {
          messages: rows,
          nextAfterMessageOrder:
            start + rows.length < arrived.length ? start + rows.length - 1 : null,
        },
      };
    });
    const sent = await sendCounting(f, "op-time", dm.channelId);
    expect(sent.reads).toEqual([2, 2]);
    expect(frozenTargets(f, "op-time").map((target) => target.target)).toEqual([
      "implicit:mac:default",
    ]);
  });

  it("finds the agent of a DM from its newest messages, past a full page of them and in a reply", async () => {
    const f = await writeRelay();
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    await declare(f, "laptop", [{ agentId: "helper", displayName: "Claude" }]);
    const human = { kind: "human" as const, displayName: "Ana" };
    const agent = {
      author: { kind: "agent" as const, displayName: "Claude" },
      authorOwnerDisplayName: "Ana",
      authorUserId: "ana",
      authorActorKey: null,
    };
    const dms: Record<string, string> = {};
    for (const agentId of ["default", "helper"]) {
      const dm = await chats.ensureAgentChannel({ workspaceId: "trip", agentId, name: "Claude" });
      dms[agentId] = dm.channelId;
      const threadId = `thread-dm-${agentId}`;
      await chats.startChannelThread({
        workspaceId: "trip",
        channelId: dm.channelId,
        threadId,
        messageId: `${threadId}-hello`,
        lane: "chat",
        author: human,
        authorUserId: "ana",
        authorActorKey: null,
        body: "Hello",
      });
      await chats.sendMessage({
        workspaceId: "trip",
        threadId,
        messageId: `${threadId}-agent`,
        authorAgentId: agentId,
        ...agent,
        body: "Here.",
        ...(agentId === "default" ? { parentMessageId: `${threadId}-hello` } : {}),
      });
      for (let index = 0; index < (agentId === "default" ? 600 : 55); index += 1) {
        await chats.sendMessage({
          workspaceId: "trip",
          threadId,
          messageId: `${threadId}-${index}`,
          author: human,
          authorUserId: "ana",
          authorActorKey: null,
          body: `Note ${index}`,
        });
      }
    }
    for (const [agentId, installId] of [
      ["default", "mac"],
      ["helper", "laptop"],
    ] as const) {
      expect(
        await answer(
          await f.write("send", {
            operationId: `op-${agentId}`,
            streamId: dms[agentId],
            body: "Still there?",
          }),
        ),
      ).toMatchObject({ ok: true, state: "saved" });
      expect(frozenTargets(f, `op-${agentId}`), agentId).toEqual([
        {
          target: `implicit:${installId}:${agentId}`,
          candidates: [
            { installId, agentId, label: `${installId} label`, matched: { displayName: "Claude" } },
          ],
        },
      ]);
    }
  });

  it("keeps every target of a message, and refuses one that would wake more than 64 computers' agents before any change", async () => {
    const f = await writeRelay();
    const helpers = Array.from({ length: 33 }, (_, index) => ({
      agentId: `helper-${index}`,
      displayName: `Helper ${index}`,
    }));
    const body = helpers
      .map((helper) => `@helper${helper.agentId.slice("helper-".length)}`)
      .join(" ");
    await declare(f, "mac", helpers);
    expect(
      await answer(await f.write("reply", { operationId: "op-33", threadId: "thread-stay", body })),
    ).toMatchObject({ ok: true, state: "saved" });
    expect(frozenTargets(f, "op-33")).toHaveLength(33);

    await declare(f, "laptop", helpers);
    const [rows, writes] = [f.rows(), f.engine.writes.length];
    expect(
      await answer(await f.write("reply", { operationId: "op-66", threadId: "thread-stay", body })),
    ).toEqual({ ok: false, refusal: "refused", reason: "Couldn't send" });
    expect([f.rows(), f.engine.writes.length]).toEqual([rows, writes]);
  });

  const RETRY_NOW = 50_000_000;
  // A saved message's wake, claimed by one computer a day before the route's clock and never confirmed.
  const unconfirmedWake = (
    f: WriteRelay,
    operationId: string,
    messageId: string,
    threadId: string,
  ) => {
    const claude = {
      target: "mention:claude",
      candidates: ["mac", "laptop"].map((installId) => ({
        installId,
        agentId: "default",
        label: installId,
        matched: { handle: "claude" },
      })),
    };
    f.storage.recordAccountOperation({
      accountId: "ana",
      operationId,
      binding: { workspaceId: "trip", operation: "send", args: { operationId } },
      incarnation: 1,
      replicationEpoch: "epoch",
      streamIdentity: "stream",
      command: {},
      writesMessage: true,
      nowMs: RETRY_NOW,
    });
    f.storage.advanceAccountOperation({
      accountId: "ana",
      operationId,
      stage: "saved",
      message: "published",
      result: { threadId },
      nowMs: RETRY_NOW,
      wakes: { publish: { messageId, threadId, held: false, targets: [claude] } },
    });
    const wakeId = chatWakeId("ana", "trip", messageId, "mention:claude", 1);
    f.storage.claimChatWake({ accountId: "ana", wakeId, installId: "mac", nowMs: RETRY_NOW });
    // The laptop, where a retry goes, declared its agent then, so its lease holds a day later.
    f.storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId: "laptop",
      computerLabel: "laptop",
      runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
      nowMs: RETRY_NOW,
    });
    return wakeId;
  };
  // The Mac, which wins unconfirmedWake's claims, declares its agent switched off under `displayName`, which no mention
  // names.
  const nameMac = (f: WriteRelay, displayName: string) =>
    f.storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId: "mac",
      computerLabel: "mac",
      runners: [
        {
          agentId: "default",
          handle: displayName.toLowerCase().replaceAll(" ", ""),
          displayName,
          enabled: false,
        },
      ],
      nowMs: RETRY_NOW,
    });
  const count = (f: WriteRelay, sql: string) =>
    Number((f.storage as StorageContext).db.prepare(sql).get()?.n);

  it("tries a wake again with strict arguments, once per operation ID, and answers one in a thread now hidden as missing", async () => {
    const f = await writeRelay({ nowMs: () => RETRY_NOW + CHAT_WAKE_CONFIRM_MS });
    const { onSecret } = f.seeded;
    const unconfirmed = (operationId: string, messageId: string, threadId: string) =>
      unconfirmedWake(f, operationId, messageId, threadId);
    const visible = unconfirmed("op-visible", "message-visible", "thread-stay");
    const hidden = unconfirmed("op-hidden", "message-hidden", onSecret.id);
    const retry = (args: unknown) => f.write("retryWake", args);
    const next = {
      ok: true,
      wake: expect.objectContaining({
        wakeId: chatWakeId("ana", "trip", "message-visible", "mention:claude", 2),
        generation: 2,
      }),
    };
    expect(await answer(await retry({ operationId: "retry-1", wakeId: visible }))).toEqual(next);
    expect(await answer(await retry({ operationId: "retry-1", wakeId: visible }))).toEqual(next);
    expect(await answer(await retry({ operationId: "op-visible", wakeId: visible }))).toEqual({
      ok: false,
      refusal: "refused",
      reason: "Couldn't send",
    });

    const bytes = async (wakeId: string) =>
      (await (await retry({ operationId: `retry-${wakeId}`, wakeId })).text()).replaceAll(
        wakeId,
        "<id>",
      );
    expect(await bytes(hidden)).toBe(
      await bytes(chatWakeId("ana", "trip", "message-nowhere", "mention:claude", 1)),
    );
    expect(await bytes(hidden)).toContain('"refusal":"missing"');
    expect(
      count(
        f,
        "SELECT count(*) AS n FROM sync_relay_chat_wakes WHERE message_id = 'message-hidden'",
      ),
    ).toBe(1);

    for (const args of [
      { operationId: "retry-2", wakeId: visible, installId: "mac" },
      { operationId: "retry-2", wakeId: visible, messageId: "message-visible" },
      { operationId: "retry-2", wakeId: "wake-1" },
      { operationId: "", wakeId: visible },
      { wakeId: visible },
    ]) {
      const response = await retry(args);
      expect({ status: response.status, body: await json(response) }, JSON.stringify(args)).toEqual(
        { status: 400, body: schemaRefusal("retryWake") },
      );
    }
    const missing = await denialBytes(
      await f.h(op("nowhere", "retryWake", { operationId: "retry-3", wakeId: visible })),
    );
    expect(
      await denialBytes(
        await f.h(
          op("trip", "retryWake", { operationId: "retry-3", wakeId: visible }, signedIn("ben")),
        ),
      ),
    ).toBe(missing);
    f.change("show on phone");
    expect(await denialBytes(await retry({ operationId: "retry-3", wakeId: visible }))).toBe(
      missing,
    );
  });

  it("judges a retry's thread by everything the relay accepted before the retry commits", async () => {
    const f = await writeRelay({ nowMs: () => RETRY_NOW + CHAT_WAKE_CONFIRM_MS });
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    f.engine.files.seedTextFile({
      workspace: "trip",
      path: "notes.md",
      text: "# Notes\n",
      objectId: "object-notes",
    });
    const onNotes = await chats.createThread({
      workspaceId: "trip",
      title: "Notes",
      linkedFile: { objectId: "object-notes", pathHint: "notes.md" },
    });
    const wakeId = unconfirmedWake(f, "op-notes", "message-notes", onNotes.id);
    // The request's own check, the check after its body, and the copy's open come first; the fourth follows the thread read.
    const held = f.holdCheck(4);
    const retrying = f.write("retryWake", { operationId: "retry-race", wakeId });
    await held.reached;
    const db = (f.storage as StorageContext).db;
    const relaySeq = Number(
      db
        .prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
      VALUES ('trip', 'another-device', 1, 'moment.append', '{}', 1) RETURNING relay_seq`)
        .get()!.relay_seq,
    );
    db.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
      VALUES ('trip', 'object-notes', ?, 'moment-env', 'main', '.env', 1)`).run(relaySeq);
    await new VersionedLiveAdapter(f.engine, "trip", { workspaceId: "trip" }).deleteTextFile({
      workspaceId: "trip",
      versionId: "main",
      path: "notes.md",
      metadata: { origin: "api" },
    });
    held.release();
    expect(await answer(await retrying)).toEqual({
      ok: false,
      reason: `no such wake: ${wakeId}`,
      refusal: "missing",
    });
    expect(
      count(
        f,
        "SELECT count(*) AS n FROM sync_relay_chat_wakes WHERE message_id = 'message-notes'",
      ),
    ).toBe(1);
    expect(count(f, "SELECT count(*) AS n FROM sync_relay_chat_wake_retries")).toBe(0);
  });

  it("answers a repeated retry whose named wake went only while the generation it answered is in a thread the account may see", async () => {
    const f = await writeRelay({ nowMs: () => RETRY_NOW + CHAT_WAKE_CONFIRM_MS });
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    f.engine.files.seedTextFile({
      workspace: "trip",
      path: "notes.md",
      text: "# Notes\n",
      objectId: "object-notes",
    });
    const onNotes = await chats.createThread({
      workspaceId: "trip",
      title: "Notes",
      linkedFile: { objectId: "object-notes", pathHint: "notes.md" },
    });
    const wakeId = unconfirmedWake(f, "op-notes", "message-notes", onNotes.id);
    const next = chatWakeId("ana", "trip", "message-notes", "mention:claude", 2);
    const retry = { operationId: "retry-1", wakeId };
    expect(await answer(await f.write("retryWake", retry))).toMatchObject({
      ok: true,
      wake: { wakeId: next, generation: 2 },
    });

    // The named wake ended at the retry; 30 days on it is swept, and the generation it led to, which ended later, stays.
    expect(
      f.storage.sweepChatWakes(RETRY_NOW + CHAT_WAKE_CONFIRM_MS + CHAT_WAKE_KEEP_MS + 1),
    ).toBeGreaterThan(0);
    const left = () =>
      (f.storage as StorageContext).db
        .prepare("SELECT wake_id FROM sync_relay_chat_wakes WHERE message_id = 'message-notes'")
        .all()
        .map((row) => row.wake_id);
    expect(left()).toEqual([next]);
    expect(
      await answer(await f.write("retryWake", retry)),
      "a repeat in a thread still shown answers its generation",
    ).toMatchObject({ ok: true, wake: { wakeId: next, generation: 2 } });

    const db = (f.storage as StorageContext).db;
    const relaySeq = Number(
      db
        .prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
      VALUES ('trip', 'another-device', 1, 'moment.append', '{}', 1) RETURNING relay_seq`)
        .get()!.relay_seq,
    );
    db.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
      VALUES ('trip', 'object-notes', ?, 'moment-env', 'main', '.env', 1)`).run(relaySeq);
    await new VersionedLiveAdapter(f.engine, "trip", { workspaceId: "trip" }).deleteTextFile({
      workspaceId: "trip",
      versionId: "main",
      path: "notes.md",
      metadata: { origin: "api" },
    });
    const bytes = async (args: { operationId: string; wakeId: string }) =>
      (await (await f.write("retryWake", args)).text()).replaceAll(args.wakeId, "<id>");
    const hidden = await bytes(retry);
    expect(hidden).toBe(
      await bytes({
        operationId: "retry-unknown",
        wakeId: chatWakeId("ana", "trip", "message-nowhere", "mention:claude", 1),
      }),
    );
    expect(hidden).toContain('"refusal":"missing"');
    for (const id of [next, onNotes.id, "message-notes"]) expect(hidden).not.toContain(id);
    expect(left()).toEqual([next]);
  });

  it("answers as missing, with no result and no further change, when access ends at any check of a write", async () => {
    const { h } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    const write = { operationId: "op-gone", threadId: "thread-stay", body: "Hi" };
    const points: Array<
      [
        label: string,
        run: (f: WriteRelay, kind: AccessChange) => Promise<Response>,
        rows: number,
        writes: number,
      ]
    > = [
      [
        "after the arguments arrive",
        async (f, kind) => {
          f.changeAt(2, kind);
          return await f.write("reply", write);
        },
        0,
        0,
      ],
      [
        "while publication waits for the copy's step",
        async (f, kind) => {
          const held = f.holdStep();
          const writing = f.write("reply", write);
          await held.reached;
          f.change(kind);
          held.release();
          return await writing;
        },
        1,
        1,
      ],
      [
        "while a retry's replay reads its thread",
        async (f, kind) => {
          f.engine.failing.set(CHATS_METHOD.messageSend, new Error("the engine went away"));
          expect(await f.earlier({ operation: "reply", args: write })).toMatchObject({
            ok: true,
            state: "pending",
          });
          f.engine.failing.clear();
          const held = f.engine.hold(CHATS_METHOD.threadsList);
          const writing = f.write("reply", write);
          await held.reached;
          f.change(kind);
          held.release();
          return await writing;
        },
        1,
        0,
      ],
    ];
    for (const [label, run, rows, writes] of points) {
      for (const kind of ACCESS_CHANGES) {
        const f = await writeRelay();
        const response = await run(f, kind);
        expect(await denialBytes(response), `${label}, ${kind}`).toBe(missing);
        expect(f.rows(), `${label}, ${kind}`).toBe(rows);
        expect(f.engine.writes, `${label}, ${kind}`).toHaveLength(writes);
      }
    }
  });

  const markRows = (f: WriteRelay) =>
    (f.storage as StorageContext).db
      .prepare(
        "SELECT payload_json FROM sync_relay_log WHERE workspace_id = 'trip' AND op_kind = 'chat.thread.read.set' ORDER BY relay_seq",
      )
      .all()
      .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);

  it("marks a shown message read for the session's account, with no row, and its copy publishes the mark", async () => {
    const f = await writeRelay();
    const response = await f.write("markRead", {
      threadId: "thread-stay",
      messageId: "message-poll",
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      result: { ok: true },
      cursor: expect.any(String),
    });
    expect(f.engine.marks.map((request) => request.params)).toEqual([
      { threadId: "thread-stay", messageId: "message-poll", replicationOwnerUserId: "ana" },
    ]);
    expect(markRows(f)).toMatchObject([
      { accountUserId: "ana", threadId: "thread-stay", lastReadMessageId: "message-poll" },
    ]);
    expect(
      await answer(
        await f.write("markRead", { threadId: "thread-stay", messageId: "message-stay" }),
      ),
    ).toEqual({ ok: true });
    expect(f.rows()).toBe(0);
    expect(f.engine.writes).toEqual([]);
  });

  it("takes exactly a thread and a message, each of 1 to 256 units, before the copy syncs", async () => {
    const f = await writeRelay();
    const valid = { threadId: "thread-stay", messageId: "message-stay" };
    const units = (count: number) => "x".repeat(count);
    const forbidden: Record<string, unknown> = {
      operationId: "op",
      createdAtMs: 1,
      upToSequence: 1,
      lastReadSequence: 1,
      accountUserId: "ben",
      ownerUserId: "ben",
      account: "ben",
      replicationOwnerUserId: "ben",
      runId: "run",
      reported: { product: "Nova" },
      work: { status: "done" },
      agent: "Nova",
      attachments: [],
      cwd: "/",
      actor: "human",
      agentId: "nova",
      token: "a".repeat(64),
      runSecret: "a".repeat(64),
      door: "cli",
    };
    const refused: Array<[label: string, args: unknown]> = [
      ...Object.entries(forbidden).map(([field, value]): [string, unknown] => [
        field,
        { ...valid, [field]: value },
      ]),
      ["no thread", { messageId: "message-stay" }],
      ["no message", { threadId: "thread-stay" }],
      ["an empty thread ID", { ...valid, threadId: "" }],
      ["an empty message ID", { ...valid, messageId: "" }],
      ["a 257-unit thread ID", { ...valid, threadId: units(257) }],
      ["a 257-unit message ID", { ...valid, messageId: units(257) }],
      ["a thread ID that isn't text", { ...valid, threadId: 7 }],
      ["a list", [valid]],
    ];
    for (const [label, args] of refused) {
      const response = await f.write("markRead", args);
      expect({ status: response.status, body: await json(response) }, label).toEqual({
        status: 400,
        body: schemaRefusal("markRead"),
      });
    }
    expect(f.syncs).toEqual([]);
    expect(f.engine.marks).toEqual([]);
    expect(
      await answer(await f.write("markRead", { ...valid, threadId: units(256) })),
      "a 256-unit thread ID",
    ).toMatchObject({ refusal: "missing" });
    expect(
      await answer(await f.write("markRead", { ...valid, messageId: units(256) })),
      "a 256-unit message ID",
    ).toMatchObject({ refusal: "missing" });
    expect(await answer(await f.write("markRead", valid))).toEqual({ ok: true });
  });

  it("keeps the body limit and the sign-in's rate on read marks", async () => {
    const f = await writeRelay({ limiter: new TokenBucketLimiter(1, 0.001, 16) });
    expect(
      (await f.write("markRead", { threadId: "thread-stay", messageId: "a".repeat(256 * 1024) }))
        .status,
    ).toBe(413);
    const limited = await f.write("markRead", {
      threadId: "thread-stay",
      messageId: "message-stay",
    });
    expect(limited.status).toBe(503);
    expect(await json(limited)).toMatchObject({ ok: false, code: "server_busy" });
    expect(f.syncs).toEqual([]);
    expect(f.engine.marks).toEqual([]);
  });

  it("answers a hidden or missing thread, and a hidden, missing or another thread's message, as reads do, before any mark", async () => {
    const f = await writeRelay();
    const { planning, onSecret } = f.seeded;
    await new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" }).startChannelThread({
      workspaceId: "trip",
      channelId: planning.channelId,
      threadId: "thread-other",
      messageId: "message-other",
      lane: "posts",
      author: { kind: "human", displayName: "Ana" },
      authorUserId: "ana",
      authorActorKey: null,
      body: "And dinner?",
    });
    const bytes = async (args: Record<string, string>, id: string) => {
      const response = await f.write("markRead", args);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: (await response.text()).replaceAll(id, "<id>"),
      };
    };
    const hiddenThread = await bytes(
      { threadId: onSecret.id, messageId: "message-secret" },
      onSecret.id,
    );
    expect(hiddenThread.status).toBe(200);
    expect(hiddenThread.body).toContain('"refusal":"missing"');
    expect(
      await bytes({ threadId: "thread-nowhere", messageId: "message-secret" }, "thread-nowhere"),
    ).toEqual(hiddenThread);
    expect(
      await answer(
        await f.write("markRead", { threadId: onSecret.id, messageId: "message-secret" }),
      ),
    ).toEqual(await answer(await f.h(op("trip", "chat", { threadId: onSecret.id }))));
    const absentMessage = await bytes(
      { threadId: "thread-stay", messageId: "message-nowhere" },
      "message-nowhere",
    );
    expect(absentMessage.body).toContain('"refusal":"missing"');
    expect(
      await bytes({ threadId: "thread-stay", messageId: "message-secret" }, "message-secret"),
      "a message in a hidden thread",
    ).toEqual(absentMessage);
    expect(
      await bytes({ threadId: "thread-stay", messageId: "message-other" }, "message-other"),
      "another thread's message",
    ).toEqual(absentMessage);
    expect(f.engine.marks).toEqual([]);
    expect(markRows(f)).toEqual([]);
  });

  it("answers as missing, with no mark, when access ends at any check before a read mark, and with the mark once it is made", async () => {
    const { h } = await relay();
    const missing = await denialBytes(await h(op("nowhere", "groups")));
    const mark = { threadId: "thread-stay", messageId: "message-poll" };
    const during = async (f: WriteRelay, kind: AccessChange, method: string) => {
      const held = f.engine.hold(method);
      const marking = f.write("markRead", mark);
      await held.reached;
      f.change(kind);
      held.release();
      return await marking;
    };
    // The checks: before the arguments, after them, once the copy is open, once it has synced, after the thread read,
    // after the message read, and after the copy's step, before the answer.
    const at = async (f: WriteRelay, kind: AccessChange, check: number) => {
      f.changeAt(check, kind);
      return await f.write("markRead", mark);
    };
    const points: Array<
      [label: string, run: (f: WriteRelay, kind: AccessChange) => Promise<Response>, marks: number]
    > = [
      ["after the arguments arrive", (f, kind) => at(f, kind, 2), 0],
      ["once the copy is open", (f, kind) => at(f, kind, 3), 0],
      ["once the copy has synced", (f, kind) => at(f, kind, 4), 0],
      ["while the thread is read", (f, kind) => during(f, kind, CHATS_METHOD.threadsList), 0],
      ["while the message is read", (f, kind) => during(f, kind, CHATS_METHOD.messageGet), 0],
      [
        "while the copy's step sends the mark",
        async (f, kind) => {
          const held = f.holdStep();
          const marking = f.write("markRead", mark);
          await held.reached;
          f.change(kind);
          held.release();
          return await marking;
        },
        1,
      ],
      ["once the answer is ready", (f, kind) => at(f, kind, 7), 1],
    ];
    for (const [label, run, marks] of points) {
      for (const kind of ACCESS_CHANGES) {
        const f = await writeRelay();
        expect(await denialBytes(await run(f, kind)), `${label}, ${kind}`).toBe(missing);
        expect(f.engine.marks, `${label}, ${kind}`).toHaveLength(marks);
      }
    }
  });

  it("answers once the copy's step has sent the mark, and keeps the copy open while it runs", async () => {
    const f = await writeRelay();
    const held = f.holdStep();
    let answered = false;
    const marking = f
      .write("markRead", { threadId: "thread-stay", messageId: "message-poll" })
      .then((response) => {
        answered = true;
        return response;
      });
    await held.reached;
    f.reconcile();
    expect(f.copyOpen()).toBe(true);
    expect(f.closes()).toBe(0);
    expect(answered).toBe(false);
    expect(markRows(f)).toEqual([]);
    held.release();
    expect(await answer(await marking)).toEqual({ ok: true });
    expect(markRows(f)).toMatchObject([
      { accountUserId: "ana", threadId: "thread-stay", lastReadMessageId: "message-poll" },
    ]);
    await expect.poll(() => f.closes()).toBe(1);
  });

  it("answers Couldn't send, without the copy's words, when its step fails or passes the deadline", async () => {
    const couldNotSend = { ok: false, reason: "Couldn't send" };
    const failed = await writeRelay();
    failed.failStep(new Error("The relay at https://relay.internal refused the push."));
    const response = await failed.write("markRead", {
      threadId: "thread-stay",
      messageId: "message-poll",
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).result).toEqual(couldNotSend);
    expect(text).not.toContain("relay.internal");
    expect(failed.engine.marks).toHaveLength(1);
    expect(markRows(failed)).toEqual([]);

    const slow = await writeRelay();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const held = slow.holdStep();
      const marking = slow.write("markRead", {
        threadId: "thread-stay",
        messageId: "message-poll",
      });
      await held.reached;
      await vi.advanceTimersByTimeAsync(PUBLICATION_DEADLINE_MS);
      expect(await answer(await marking)).toEqual(couldNotSend);
    } finally {
      vi.useRealTimers();
    }
    expect(slow.engine.marks).toHaveLength(1);
    expect(markRows(slow)).toEqual([]);
  });

  it("sends a read mark and a later write in the order the copy journaled them", async () => {
    const f = await writeRelay();
    f.failStep(new Error("The relay is unreachable."));
    expect(
      await answer(
        await f.write("markRead", { threadId: "thread-stay", messageId: "message-poll" }),
      ),
    ).toEqual({ ok: false, reason: "Couldn't send" });
    f.failStep(null);
    expect(
      await answer(
        await f.write("reply", { operationId: "op-after", threadId: "thread-stay", body: "Hi" }),
      ),
    ).toMatchObject({ ok: true, state: "saved" });
    const pushed = (f.storage as StorageContext).db
      .prepare(
        "SELECT origin_seq, op_kind FROM sync_relay_log WHERE workspace_id = 'trip' AND origin_id = 'server-copy' ORDER BY relay_seq",
      )
      .all()
      .map((row) => ({ seq: Number(row.origin_seq), kind: String(row.op_kind) }));
    expect(pushed[0]?.kind).toBe("chat.thread.read.set");
    expect(pushed.map((row) => row.seq)).toEqual(
      pushed.map((row) => row.seq).sort((left, right) => left - right),
    );
    expect(pushed.length).toBeGreaterThan(1);
  });

  const LATE = RETRY_NOW + CHAT_WAKE_CONFIRM_MS;
  const personalAgent = (
    f: WriteRelay,
    letter: string,
    name: string,
    status: string,
    reach: string[],
  ) => {
    const db = (f.storage as StorageContext).db;
    const agentId = `p-${letter.repeat(26)}`;
    db.prepare(
      `INSERT INTO sync_relay_personal_agents (agent_id, owner_user_id, name, hue, status, epoch, created_at_ms)
       VALUES (?, 'ana', ?, 'blue', ?, 1, 1)`,
    ).run(agentId, name, status);
    for (const workspaceId of reach)
      db.prepare(
        "INSERT INTO sync_relay_personal_agent_reach (agent_id, workspace_id, level, start_seq) VALUES (?, ?, 'view', 0)",
      ).run(agentId, workspaceId);
  };

  it("reads a stream's lanes, who it can mention, and the latest wake of each of its messages, without a computer's ID or candidates", async () => {
    const f = await writeRelay({ nowMs: () => LATE });
    const { planning } = f.seeded;
    const stay = unconfirmedWake(f, "op-stay", "message-stay", "thread-stay");
    // A second computer runs the same agent, under a label that isn't its ID.
    f.storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId: "install-9f2c",
      computerLabel: "Ana's Mac",
      runners: [{ agentId: "default", handle: "claude", displayName: "Claude", enabled: true }],
      nowMs: RETRY_NOW,
    });
    personalAgent(f, "a", "Scout", "active", ["trip"]);
    personalAgent(f, "b", "Ranger", "active", []);
    personalAgent(f, "c", "Ghost", "signed_out", ["trip"]);
    nameMac(f, "Claude at work");

    const response = await f.write("chatContext", { group: planning.channelId });
    const text = await response.clone().text();
    const read = await answer(response);
    expect(PhoneChatContext.safeParse(read).success, "the phone takes the whole answer").toBe(true);
    expect(read).toEqual({
      ok: true,
      conversation: {
        kind: "stream",
        groupId: planning.channelId,
        groupKind: "group",
        canPost: true,
        canSend: true,
      },
      mentions: [
        { kind: "agent", handle: "Claude", label: "Claude", computers: ["Ana's Mac", "laptop"] },
        { kind: "personalAgent", handle: "Scout", label: "Scout" },
        { kind: "person", handle: "Ana", label: "Ana" },
      ],
      wakes: [
        {
          wakeId: stay,
          messageId: "message-stay",
          threadId: "thread-stay",
          generation: 1,
          state: "unconfirmed",
          winnerLabel: "mac",
          // The winner's current name, though switched off and so no mention.
          agentName: "Claude at work",
          canRetry: true,
        },
      ],
      wakeCursor: String(f.storage.chatWakeHead("ana")),
    });
    for (const withheld of [
      "install-9f2c",
      "installId",
      "agentId",
      "candidates",
      '"matched"',
      '"target"',
      "mention:",
      "winner_",
    ])
      expect(text).not.toContain(withheld);

    f.storage.replaceChatRunners({
      accountId: "ana",
      workspaceId: "trip",
      installId: "install-9f2c",
      computerLabel: "Ana's Mac",
      runners: [
        {
          agentId: "default",
          handle: "claude",
          displayName: "Claude",
          enabled: true,
          memory: true,
        },
      ],
      nowMs: RETRY_NOW,
    });
    expect(await answer(await f.write("chatContext", { group: planning.channelId }))).toMatchObject(
      {
        mentions: expect.arrayContaining([
          { kind: "agent", handle: "Claude", label: "Claude", computers: ["Ana's Mac"] },
        ]),
      },
    );

    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    for (const [type, canPost, canSend] of [
      ["posts", true, false],
      ["chat", false, true],
    ] as const) {
      const group = await chats.createChannel({ workspaceId: "trip", name: `Only ${type}`, type });
      expect(
        (await answer(await f.write("chatContext", { group: group.channelId }))).conversation,
      ).toEqual({ kind: "stream", groupId: group.channelId, groupKind: "group", canPost, canSend });
    }
  });

  it("reads a thread's latest generations, and gives no wake for an answered agent no computer ran, even once one does", async () => {
    const f = await writeRelay({ nowMs: () => LATE });
    const { planning } = f.seeded;
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await declare(f, "mac", [{ agentId: "default", displayName: "Claude" }]);
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: planning.channelId,
      threadId: "thread-nova",
      messageId: "thread-nova-opening",
      lane: "posts",
      ...agentAuthor("Nova"),
      body: "Done.",
    });
    expect(
      await answer(
        await f.write("reply", {
          operationId: "op-nobody",
          threadId: "thread-nova",
          body: "Thanks",
        }),
      ),
    ).toMatchObject({ ok: true, state: "saved" });
    expect(wakesOf(f, "op-nobody")).toEqual({ targets: [], unmatched: true });
    const context = async () =>
      await answer(await f.write("chatContext", { threadId: "thread-nova" }));
    const read = await context();
    expect(read).toMatchObject({
      ok: true,
      conversation: { kind: "thread", threadId: "thread-nova", groupKind: "group" },
      wakes: [],
    });
    expect(read, "this read gives no unmatched hint").not.toHaveProperty("unmatched");
    // A computer that runs Nova now changes nothing the write froze.
    await declare(f, "desktop", [{ agentId: "default", displayName: "Nova" }]);
    expect(await context()).toMatchObject({ wakes: [] });

    // A retried wake reads as its latest generation only. Its only computer claimed it and never confirmed, so no
    // other computer is left, and the context offers no retry, which the route refuses too.
    const first = unconfirmedWake(f, "op-stay", "message-poll", "thread-stay");
    const second = chatWakeId("ana", "trip", "message-poll", "mention:claude", 2);
    expect(
      await answer(await f.write("retryWake", { operationId: "retry-1", wakeId: first })),
    ).toMatchObject({ ok: true, wake: { wakeId: second } });
    f.storage.claimChatWake({
      accountId: "ana",
      wakeId: second,
      installId: "laptop",
      nowMs: RETRY_NOW,
    });
    expect((await answer(await f.write("chatContext", { threadId: "thread-stay" }))).wakes).toEqual(
      [
        expect.objectContaining({
          wakeId: second,
          generation: 2,
          state: "unconfirmed",
          winnerLabel: "laptop",
          agentName: "Claude",
          canRetry: false,
        }),
      ],
    );
    expect(
      await answer(await f.write("retryWake", { operationId: "retry-2", wakeId: second })),
    ).toMatchObject({ ok: false, refusal: "refused" });
  });

  it("answers a hidden or missing thread alike, and refuses other arguments, another account, and a workspace hidden from the phone", async () => {
    const f = await writeRelay({ nowMs: () => LATE });
    const { onSecret } = f.seeded;
    const hidden = unconfirmedWake(f, "op-hidden", "message-hidden", onSecret.id);
    nameMac(f, "Hidden Claude");
    const missing = await denialBytes(await f.h(op("nowhere", "groups")));
    const bytes = async (args: Record<string, string>) =>
      (await (await f.write("chatContext", args)).text()).replaceAll(
        Object.values(args)[0]!,
        "<id>",
      );
    const secret = await bytes({ threadId: onSecret.id });
    expect(secret).toBe(await bytes({ threadId: "thread-nowhere" }));
    expect(secret).toContain('"refusal":"missing"');
    expect(secret).not.toContain(hidden);
    expect(secret).not.toContain("Hidden Claude");
    expect(await answer(await f.write("chatContext", { group: "group-nowhere" }))).toEqual({
      ok: false,
      reason: "no such group: group-nowhere",
      refusal: "missing",
    });

    for (const args of [
      {},
      { threadId: "" },
      { group: "a", threadId: "b" },
      { group: "a", before: 1 },
      { threadId: "thread-stay", before: 0 },
      { threadId: "thread-stay", before: 1.5 },
      { threadId: "thread-stay", messageIds: ["message-stay"] },
      { threadId: "x".repeat(257) },
    ]) {
      const response = await f.write("chatContext", args);
      expect({ status: response.status, body: await json(response) }, JSON.stringify(args)).toEqual(
        { status: 400, body: schemaRefusal("chatContext") },
      );
    }
    expect(
      await denialBytes(
        await f.h(op("trip", "chatContext", { threadId: "thread-stay" }, signedIn("ben"))),
      ),
    ).toBe(missing);
    f.change("show on phone");
    expect(await denialBytes(await f.write("chatContext", { threadId: "thread-stay" }))).toBe(
      missing,
    );
  });

  it("answers as missing, with no context, when access ends at any check of a context read", async () => {
    const f0 = await writeRelay();
    const missing = await denialBytes(await f0.h(op("nowhere", "groups")));
    // The copy's open, after its sync, and after the conversation is read.
    for (const check of [3, 4, 5]) {
      for (const kind of ["sign-in", "owner", "show on phone"] as const) {
        const f = await writeRelay();
        unconfirmedWake(f, "op-stay", "message-stay", "thread-stay");
        f.changeAt(check, kind);
        expect(
          await denialBytes(await f.write("chatContext", { threadId: "thread-stay" })),
          `${check}, ${kind}`,
        ).toBe(missing);
      }
    }
  });

  it("judges a context's thread by everything the relay accepted before it answers", async () => {
    const f = await writeRelay({ nowMs: () => LATE });
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    f.engine.files.seedTextFile({
      workspace: "trip",
      path: "notes.md",
      text: "# Notes\n",
      objectId: "object-notes",
    });
    const onNotes = await chats.createThread({
      workspaceId: "trip",
      title: "Notes",
      linkedFile: { objectId: "object-notes", pathHint: "notes.md" },
    });
    const wakeId = unconfirmedWake(f, "op-notes", "message-notes", onNotes.id);
    nameMac(f, "Notes Claude");
    const db = (f.storage as StorageContext).db;
    // Another device's move of the notes, which the relay accepts.
    const accepted = (originSeq: number, path: string) => {
      const relaySeq = Number(
        db
          .prepare(`INSERT INTO sync_relay_log (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms)
        VALUES ('trip', 'another-device', ?, 'moment.append', '{}', 1) RETURNING relay_seq`)
          .get(originSeq)!.relay_seq,
      );
      db.prepare(`INSERT INTO sync_relay_object_moments (workspace_id, object_id, relay_seq, moment_id, version_id, path, recorded_at_ms)
        VALUES ('trip', 'object-notes', ?, ?, 'main', ?, 1)`).run(
        relaySeq,
        `moment-${originSeq}`,
        path,
      );
    };
    // The request's own check, the check after its body, the copy's open, and the check after its sync come first;
    // the fifth follows the conversation's read.
    const held = f.holdCheck(5);
    const reading = f.write("chatContext", { threadId: onNotes.id });
    await held.reached;
    accepted(1, ".env");
    await new VersionedLiveAdapter(f.engine, "trip", { workspaceId: "trip" }).deleteTextFile({
      workspaceId: "trip",
      versionId: "main",
      path: "notes.md",
      metadata: { origin: "api" },
    });
    held.release();
    const response = await reading;
    const hiddenText = await response.clone().text();
    expect(hiddenText).not.toContain(wakeId);
    expect(hiddenText).not.toContain("Notes Claude");
    expect(await answer(response)).toEqual({
      ok: false,
      reason: `chat thread not found: ${onNotes.id}`,
      refusal: "missing",
    });

    // A move during the read, and another during the read again, answer a failed read with no context.
    const first = f.holdCheck(5);
    const again = f.write("chatContext", { threadId: "thread-stay" });
    await first.reached;
    accepted(2, "notes-2.md");
    first.release();
    // The second read's sync, then its read.
    const second = f.holdCheck(2);
    await second.reached;
    accepted(3, "notes-3.md");
    second.release();
    expect(await answer(await again)).toEqual({ ok: false, reason: "failed to read chat context" });
  });

  it("covers a thread's newest messages a page at a time, reading only that page through every page the engine cuts it into", async () => {
    const f = await writeRelay({ nowMs: () => LATE });
    const chats = new ChatsLiveAdapter(f.engine.chats, "trip", { workspaceId: "trip" });
    await chats.startChannelThread({
      workspaceId: "trip",
      channelId: f.seeded.planning.channelId,
      threadId: "thread-long",
      messageId: "long-0",
      lane: "posts",
      author: { kind: "human", displayName: "Zed" },
      authorActorKey: null,
      body: "0",
    });
    for (let order = 1; order < 250; order += 1)
      await chats.sendMessage({
        workspaceId: "trip",
        threadId: "thread-long",
        messageId: `long-${order}`,
        author: { kind: "human", displayName: "Ana" },
        authorActorKey: null,
        body: String(order),
      });
    const oldest = unconfirmedWake(f, "op-oldest", "long-0", "thread-long");
    const newest = unconfirmedWake(f, "op-newest", "long-249", "thread-long");
    nameMac(f, "Claude at work");
    const covered = async (args: Record<string, number>) => {
      const from = f.engine.asked.length;
      const result = await answer(
        await f.write("chatContext", { threadId: "thread-long", ...args }),
      );
      return {
        reads: f.engine.asked
          .slice(from)
          .filter(
            (method) =>
              method === CHATS_METHOD.messagesList || method === CHATS_METHOD.reactionsList,
          ),
        nextBefore: (result.conversation as Record<string, unknown>).nextBefore,
        wakes: (result.wakes as Array<{ wakeId: string }>).map((wake) => wake.wakeId),
        people: (result.mentions as Array<{ kind: string; label: string }>)
          .filter((mention) => mention.kind === "person")
          .map((mention) => mention.label)
          .sort(),
      };
    };
    // One page of 100 messages each time, and no reactions, which list only whole.
    expect(await covered({})).toEqual({
      reads: [CHATS_METHOD.messagesList],
      nextBefore: 150,
      wakes: [newest],
      people: ["Ana"],
    });
    expect(await covered({ before: 150 })).toEqual({
      reads: [CHATS_METHOD.messagesList],
      nextBefore: 50,
      wakes: [],
      people: ["Ana"],
    });
    expect(await covered({ before: 50 })).toEqual({
      reads: [CHATS_METHOD.messagesList],
      nextBefore: null,
      wakes: [oldest],
      people: ["Ana", "Zed"],
    });
    expect((await covered({ before: 1_000 })).nextBefore, "past the end covers the newest").toBe(
      150,
    );
    // Each page names its wakes' agent.
    for (const [args, wakeId] of [
      [{}, newest],
      [{ before: 50 }, oldest],
    ] as const) {
      const page = await answer(await f.write("chatContext", { threadId: "thread-long", ...args }));
      expect(PhoneChatContext.safeParse(page).success).toBe(true);
      expect(page.wakes, JSON.stringify(args)).toEqual([
        expect.objectContaining({ wakeId, agentName: "Claude at work" }),
      ]);
    }

    // As the engine's byte budget does, it ends each page at three messages and says where to go on. Each context still
    // covers its whole interval, so every message is covered exactly once.
    const interior = unconfirmedWake(f, "op-interior", "long-200", "thread-long");
    const original = f.engine.chats.sendRequest.bind(f.engine.chats);
    const returned: string[] = [];
    const pages = vi.spyOn(f.engine.chats, "sendRequest");
    pages.mockImplementation(async (request) => {
      const params = asRecord(request.params);
      if (
        request.method !== CHATS_METHOD.messagesList ||
        params === null ||
        params.threadId !== "thread-long"
      )
        return await original(request);
      const response = await original({
        ...request,
        params: {
          threadId: "thread-long",
          limit: Math.min(Number(params.limit), 3),
          ...(typeof params.afterMessageOrder === "number"
            ? { afterMessageOrder: params.afterMessageOrder }
            : {}),
        },
      });
      const page = response.result as unknown as { messages: Array<{ id: string }> };
      returned.push(...page.messages.map((message) => message.id));
      return response;
    });
    const orders = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => `long-${from + index}`);
    const short = async (args: Record<string, number>) => {
      const from = returned.length;
      const result = await covered(args);
      return { ...result, reads: result.reads.length, ids: returned.slice(from) };
    };
    expect(await short({})).toEqual({
      reads: 34,
      nextBefore: 150,
      wakes: [interior, newest],
      people: ["Ana"],
      ids: orders(150, 250),
    });
    expect(await short({ before: 150 })).toMatchObject({
      reads: 34,
      nextBefore: 50,
      wakes: [],
      ids: orders(50, 150),
    });
    expect(await short({ before: 50 })).toMatchObject({
      reads: 17,
      nextBefore: null,
      wakes: [oldest],
      ids: orders(0, 50),
    });

    // An engine whose pages never cover the messages fails the read after at most 100 reads, naming no cursor.
    pages.mockImplementation(async (request) => {
      const params = asRecord(request.params);
      if (
        request.method !== CHATS_METHOD.messagesList ||
        params === null ||
        params.threadId !== "thread-long"
      )
        return await original(request);
      const after = typeof params.afterMessageOrder === "number" ? params.afterMessageOrder : -1;
      return { id: request.id, result: { messages: [], nextAfterMessageOrder: after + 1 } };
    });
    const from = f.engine.asked.length;
    expect(await answer(await f.write("chatContext", { threadId: "thread-long" }))).toEqual({
      ok: false,
      reason: "failed to read chat context",
    });
    expect(
      f.engine.asked.slice(from).filter((method) => method === CHATS_METHOD.messagesList),
    ).toHaveLength(100);
  });

  const wakeChanges = (
    since: string,
    options: { hold?: number; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ) =>
    new Request(
      `http://relay.test/sync/trip/ops/wakeChanges?${new URLSearchParams({
        since,
        ...(options.hold === undefined ? {} : { hold: String(options.hold) }),
      })}`,
      {
        headers: options.headers ?? signedIn("ana"),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );

  it("waits for a wake-only change apart from the workspace feed, answers only threads the phone may see, and answers at once for a change after its read", async () => {
    const activity = new DiscussionActivityHub();
    const f = await writeRelay({ activity, nowMs: () => LATE });
    const stay = unconfirmedWake(f, "op-stay", "message-stay", "thread-stay");
    // The log made one thread in a Group, and one on a secret file.
    const log = logWriter(f.storage, activity);
    log("chat.thread.create", { threadId: "thread-stay" });
    log("chat.thread.create", {
      threadId: "thread-keys",
      linkedObjectId: "object-keys",
      linkedPathHint: ".env",
    });
    const keys = unconfirmedWake(f, "op-keys", "message-keys", "thread-keys");
    const read = await json(await f.write("chatContext", { threadId: "thread-stay" }));
    const since = String((read.result as Record<string, unknown>).wakeCursor);
    const queued = (wakeId: string) =>
      f.storage.confirmChatWakeQueued({ accountId: "ana", wakeId, installId: "mac", nowMs: LATE });

    const held = f.h(wakeChanges(since, { hold: 30_000 }));
    await expect.poll(() => activity.stats().waiters).toBe(1);
    const parked = f.checks();
    queued(keys);
    await expect.poll(() => f.checks()).toBeGreaterThan(parked);
    await expect.poll(() => activity.stats().waiters).toBe(1);
    queued(stay);
    const head = String(f.storage.chatWakeHead("ana"));
    expect(await feed(await held)).toEqual({ ok: true, cursor: head, threads: ["thread-stay"] });
    expect(
      await feed(await f.h(changes(String(read.cursor)))),
      "no wake change reaches the workspace feed",
    ).toEqual({ ok: true, cursor: read.cursor, changed: {} });

    // A change between the context read and the wait's start answers at once, with nothing parked.
    const again = await answer(await f.write("chatContext", { threadId: "thread-stay" }));
    unconfirmedWake(f, "op-late", "message-late", "thread-stay");
    expect(await feed(await f.h(wakeChanges(String(again.wakeCursor), { hold: 30_000 })))).toEqual({
      ok: true,
      cursor: String(f.storage.chatWakeHead("ana")),
      threads: ["thread-stay"],
    });
    expect(activity.stats().waiters).toBe(0);

    const now = String(f.storage.chatWakeHead("ana"));
    expect(await feed(await f.h(wakeChanges(String(Number(now) + 5))))).toEqual({
      ok: true,
      cursor: now,
      replace: true,
    });
    expect(await feed(await f.h(wakeChanges(now)))).toEqual({ ok: true, cursor: now, threads: [] });
    for (const bad of ["", "x", "01", "-1", "99999999999999999"]) {
      const response = await f.h(wakeChanges(bad));
      expect(response.status, bad).toBe(400);
    }
    expect((await f.h(wakeChanges(now, { hold: 30_001 }))).status).toBe(400);

    // Two held reads per sign-in; cancelling them answers the caught-up cursor.
    const stop = new AbortController();
    const waiting = [0, 1].map(() => f.h(wakeChanges(now, { hold: 30_000, signal: stop.signal })));
    await expect.poll(() => activity.stats().waiters).toBe(2);
    const busy = await f.h(wakeChanges(now, { hold: 30_000 }));
    expect(busy.status).toBe(503);
    expect(await json(busy)).toMatchObject({ ok: false, code: "server_busy" });
    stop.abort();
    for (const response of await Promise.all(waiting)) expect(response.status).toBe(200);
  });

  it("names no thread whose create the log doesn't hold, and answers replace for its change instead", async () => {
    const f = await writeRelay({ nowMs: () => LATE });
    const { onSecret } = f.seeded;
    const since = String(f.storage.chatWakeHead("ana"));
    // The engine holds this thread on a secret file; the relay's log has no create for it.
    unconfirmedWake(f, "op-secret", "message-secret", onSecret.id);
    const response = await f.h(wakeChanges(since));
    const text = await response.clone().text();
    expect(await feed(response)).toEqual({
      ok: true,
      cursor: String(f.storage.chatWakeHead("ana")),
      replace: true,
    });
    expect(text).not.toContain(onSecret.id);
    expect(await answer(await f.write("chatContext", { threadId: onSecret.id }))).toMatchObject({
      ok: false,
      refusal: "missing",
    });
  });

  it("judges the threads a wake read answers after its last check of access", async () => {
    const activity = new DiscussionActivityHub();
    const f = await writeRelay({ activity, nowMs: () => LATE });
    const log = logWriter(f.storage, activity);
    log("chat.thread.create", {
      threadId: "thread-notes",
      linkedObjectId: "object-notes",
      linkedPathHint: "notes.md",
    });
    log("moment.append", { objectId: "object-notes", path: "notes.md" });
    const since = String(f.storage.chatWakeHead("ana"));
    unconfirmedWake(f, "op-notes", "message-notes", "thread-notes");
    const head = String(f.storage.chatWakeHead("ana"));
    expect(await feed(await f.h(wakeChanges(since)))).toEqual({
      ok: true,
      cursor: head,
      threads: ["thread-notes"],
    });

    // The request's own check comes first; the second is the last before the answer.
    const held = f.holdCheck(2);
    const reading = f.h(wakeChanges(since));
    await held.reached;
    log("moment.append", { objectId: "object-notes", path: ".env" });
    held.release();
    expect(await feed(await reading)).toEqual({ ok: true, cursor: head, threads: [] });
  });

  it("answers a held wake read as missing once the sign-in, the owner, or Show on phone changed while it waited", async () => {
    for (const kind of ["sign-in", "owner", "show on phone"] as const) {
      const activity = new DiscussionActivityHub();
      const f = await writeRelay({ activity });
      const missing = await denialBytes(await f.h(op("nowhere", "groups")));
      const held = f.h(wakeChanges(String(f.storage.chatWakeHead("ana")), { hold: 30_000 }));
      await expect.poll(() => activity.stats().waiters).toBe(1);
      f.change(kind);
      notifyChatWakeChange(f.storage, "ana");
      expect(await denialBytes(await held), kind).toBe(missing);
    }
  });
});

describe("a Member's phone reads in a workspace they joined", () => {
  const RULE = parseAccessRule("people:\n  cara@dohc.test: edit\n")!;
  async function joined() {
    const fixture = await relay();
    const { storage, engine } = fixture;
    expect(
      storage.inviteWorkspaceMember({
        workspaceId: "trip",
        actorUserId: "ana",
        workspaceName: "Lisbon",
        email: "ben@dohc.test",
        recipientUserId: "ben",
        newMemberId: () => "member-ben",
        newGrantId: () => "grant-ben",
        newShareId: () => "share-trip",
        nowMs: 1,
      }),
    ).toMatchObject({ ok: true });
    const seeded = await seedTrip(engine);
    engine.files.seedTextFile({
      workspace: "trip",
      path: "private/budget.md",
      text: "# Budget\n",
      objectId: "object-budget",
    });
    const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
    const onBudget = await chats.createThread({
      workspaceId: "trip",
      title: "Budget",
      linkedFile: { objectId: "object-budget", pathHint: "private/budget.md" },
    });
    const ruled = storage.changeFolderRule({
      workspaceId: "trip",
      actorUserId: "ana",
      change: { kind: "create", folder: "private", rule: RULE },
      nowMs: 2,
    });
    expect(ruled).toMatchObject({ ok: true });
    return { ...fixture, ...seeded, onBudget };
  }
  const asBen = signedIn("ben");
  const files = (result: Record<string, unknown>) =>
    (result.files as Array<{ path: string }>).map((file) => file.path);

  it("lists, reads and comments only within the Member's reach", async () => {
    const { h, onBudget } = await joined();
    expect(files(await answer(await h(op("trip", "listFiles"))))).toContain("private/budget.md");
    expect(files(await answer(await h(op("trip", "listFiles", {}, asBen))))).toEqual([
      "docs/plan.md",
    ]);
    expect(
      JSON.stringify(
        await answer(await h(op("trip", "readText", { path: "private/budget.md" }, asBen))),
      ),
    ).toBe(
      JSON.stringify(
        await answer(await h(op("trip", "readText", { path: "private/nothing.md" }, asBen))),
      ).replace("nothing", "budget"),
    );
    expect(
      await answer(await h(op("trip", "documentRead", { path: "private/budget.md" }, asBen))),
    ).toMatchObject({ ok: false, refusal: "missing" });
    expect(
      await answer(await h(op("trip", "documentRead", { path: "docs/plan.md" }, asBen))),
    ).toMatchObject({ ok: true });
    expect(
      JSON.stringify(await answer(await h(op("trip", "fileChats", { path: "private/budget.md" })))),
    ).toContain(onBudget.id);
    expect(JSON.stringify(await answer(await h(op("trip", "groupsFull", {}, asBen))))).toContain(
      "Planning",
    );
    expect(
      JSON.stringify(
        await answer(await h(op("trip", "fileChats", { path: "private/budget.md" }, asBen))),
      ),
    ).toBe(
      JSON.stringify(
        await answer(await h(op("trip", "fileChats", { path: "private/none.md" }, asBen))),
      ).replace("none", "budget"),
    );
    expect(
      await answer(await h(op("trip", "chat", { threadId: onBudget.id }, asBen))),
    ).toMatchObject({ ok: false, refusal: "missing" });
    expect(await answer(await h(op("trip", "chat", { threadId: onBudget.id })))).toMatchObject({
      ok: true,
    });
  });

  it("refuses the owner's writes, marks, wakes, contexts and page opens alike, and a workspace they left", async () => {
    const { storage, h } = await joined();
    const missing = await denialBytes(await h(op("notes", "groups", {}, asBen)));
    for (const operation of [
      ...Object.keys(phoneWriteIds),
      "markRead",
      "retryWake",
      "chatContext",
      "openPage",
    ])
      expect(await denialBytes(await h(op("trip", operation, {}, asBen))), operation).toBe(missing);
    expect((await h(changes("0.0.0", { headers: asBen }))).status).toBe(200);
    const wakes = new Request("http://relay.test/sync/trip/ops/wakeChanges?since=0", {
      headers: asBen,
    });
    expect(await denialBytes(await h(wakes))).toBe(missing);
    expect(
      storage.removeWorkspaceMember({
        workspaceId: "trip",
        actorUserId: "ana",
        memberId: "member-ben",
        nowMs: 3,
      }),
    ).toMatchObject({ ok: true });
    expect(await denialBytes(await h(op("trip", "groups", {}, asBen)))).toBe(missing);
  });

  it("keeps reading after the owner hides it on their phone, and stops when the Member hides it", async () => {
    const { storage, h } = await joined();
    expect(storage.setShowOnPhone({ userId: "ana", workspaceId: "trip", showOnPhone: false })).toBe(
      true,
    );
    expect(files(await answer(await h(op("trip", "listFiles", {}, asBen))))).toEqual([
      "docs/plan.md",
    ]);
    expect(storage.setShowOnPhone({ userId: "ben", workspaceId: "trip", showOnPhone: false })).toBe(
      true,
    );
    expect((await h(op("trip", "listFiles", {}, asBen))).status).toBe(404);
    expect(storage.showsOnPhone("ana", "trip")).toBe(false);
    expect(storage.setShowOnPhone({ userId: "ana", workspaceId: "trip", showOnPhone: true })).toBe(
      true,
    );
    expect(storage.showsOnPhone("ben", "trip")).toBe(false);
  });

  it("answers the feed only within the Member's reach, and replaces it when their reach narrows", async () => {
    const { storage, activity, h } = await joined();
    const { cursor } = await json(await h(op("trip", "groups", {}, asBen)));
    expect(String(cursor)).toMatch(/^\d+\.\d+\.\d+\.[0-9a-f]{16}$/u);
    const write = logWriter(storage, activity);
    write("moment.append", {
      objectId: "object-budget",
      path: "private/budget.md",
      versionId: "main",
    });
    write("chat.thread.create", {
      threadId: "thread-budget",
      linkedObjectId: "object-budget",
      linkedPathHint: "private/budget.md",
    });
    write("chat.message.append", { threadId: "thread-budget", messageId: "m" });
    write("chat.channel.create", { channelId: "c" });
    const last = write("moment.append", {
      objectId: "object-plan",
      path: "docs/plan.md",
      versionId: "main",
    });
    const delivered = await feed(await h(changes(String(cursor), { headers: asBen })));
    expect(delivered).toMatchObject({
      cursor: expect.stringMatching(new RegExp(`^0\\.${last}\\.0\\.`, "u")),
      changed: { files: ["object-plan"], pages: ["object-plan"] },
    });
    expect(
      storage.changeFolderRule({
        workspaceId: "trip",
        actorUserId: "ana",
        change: { kind: "create", folder: "docs", rule: RULE },
        nowMs: 4,
      }),
    ).toMatchObject({ ok: true });
    const replaced = await feed(await h(changes(String(delivered.cursor), { headers: asBen })));
    expect(replaced).toMatchObject({ replace: true });
    expect(replaced.cursor).not.toBe(delivered.cursor);
    expect(await feed(await h(changes(String(replaced.cursor), { headers: asBen })))).toMatchObject(
      {
        changed: {},
      },
    );
    expect(
      await feed(await h(changes(String(replaced.cursor).split(".").slice(0, 3).join(".")))),
      "the owner's cursor names no reach",
    ).toMatchObject({ changed: {} });
  });

  it("withholds file links the Member's reach doesn't cover, and the owner's read places", async () => {
    const { h, engine, planning } = await joined();
    const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
    await chats.sendMessage({
      workspaceId: "trip",
      threadId: "thread-stay",
      messageId: "message-links",
      author: { kind: "human", displayName: "Cara" },
      authorActorKey: null,
      body: "See @[private/budget.md] and @[docs/plan.md]",
    });
    const owner = JSON.stringify(
      await answer(await h(op("trip", "chat", { threadId: "thread-stay" }))),
    );
    const member = JSON.stringify(
      await answer(await h(op("trip", "chat", { threadId: "thread-stay" }, asBen))),
    );
    expect(owner).toContain("@[private/budget.md]");
    expect(member).not.toContain("private/budget.md");
    expect(member).toContain("(a file not shared here)");
    expect(member).toContain("@[docs/plan.md]");
    const groups = JSON.stringify(await answer(await h(op("trip", "groupsFull", {}, asBen))));
    expect(groups).toContain(planning.channelId);
    expect(groups).not.toMatch(/"unreadCount":[1-9]|"unread":true/u);
  });

  it("leaves the owner's read places, branch moments and hidden Groups out of the Member's feed, and names a new Group", async () => {
    const { storage, activity, h } = await joined();
    const { cursor } = await json(await h(op("trip", "groups", {}, asBen)));
    const write = logWriter(storage, activity);
    write("chat.thread.read.set", { threadId: "thread-stay", accountUserId: "ana" });
    const branch = write("moment.append", {
      objectId: "object-branch",
      path: "docs/branch.md",
      versionId: "main",
    });
    (storage as StorageContext).db
      .prepare(
        "UPDATE sync_relay_object_moments SET version_id = 'v-branch' WHERE workspace_id = 'trip' AND relay_seq = ?",
      )
      .run(branch);
    expect(await feed(await h(changes(String(cursor), { headers: asBen })))).toMatchObject({
      changed: {},
    });
    write("chat.channel.create", {
      channelId: "channel-new",
      wireId: "wire-new",
      name: "New",
      slug: "new",
      kind: "channel",
      createdAtMs: 1,
    });
    expect(await feed(await h(changes(String(cursor), { headers: asBen })))).toMatchObject({
      changed: { chats: [] },
    });
    expect(
      await feed(await h(changes(String(cursor).split(".").slice(0, 3).join(".")))),
      "the owner hears their own read place",
    ).toMatchObject({ changed: { chats: ["thread-stay"] } });
  });

  it("keeps Comments on a file deleted while hidden out of a Member's reads after the folder opens", async () => {
    const { storage, activity, engine, h } = await joined();
    const write = logWriter(storage, activity);
    write("moment.append", { objectId: "object-old", path: "private/old.md", versionId: "main" });
    write("moment.append", { objectId: "object-old", path: null, versionId: "main" });
    const chats = new ChatsLiveAdapter(engine, "trip", { workspaceId: "trip" });
    const onOld = await chats.createThread({
      workspaceId: "trip",
      title: "Old",
      linkedFile: { objectId: "object-old", pathHint: "private/old.md" },
    });
    const view = await json(
      await h(
        new Request("http://relay.test/sync/trip/members", {
          headers: { authorization: "Bearer user:ana" },
        }),
      ),
    );
    const rule = (view.folderRules as Array<{ ruleId: string; revision: number }>)[0]!;
    expect(
      storage.changeFolderRule({
        workspaceId: "trip",
        actorUserId: "ana",
        change: { kind: "clear", ruleId: rule.ruleId, revision: rule.revision },
        nowMs: 5,
      }),
    ).toMatchObject({ ok: true });
    expect(files(await answer(await h(op("trip", "listFiles", {}, asBen))))).toContain(
      "private/budget.md",
    );
    expect(await answer(await h(op("trip", "chat", { threadId: onOld.id }, asBen)))).toMatchObject({
      ok: false,
      refusal: "missing",
    });
    expect(await answer(await h(op("trip", "chat", { threadId: onOld.id })))).toMatchObject({
      ok: true,
    });
  });

  it("reaches a folder a rule shares with the Member's address on their first phone read", async () => {
    const { storage, engine, h } = await joined();
    engine.files.seedTextFile({
      workspace: "trip",
      path: "shared/notes.md",
      text: "# Notes\n",
      objectId: "object-notes",
    });
    expect(
      storage.changeFolderRule({
        workspaceId: "trip",
        actorUserId: "ana",
        change: {
          kind: "create",
          folder: "shared",
          rule: parseAccessRule("people:\n  ben@dohc.test: edit\n")!,
        },
        nowMs: 6,
      }),
    ).toMatchObject({ ok: true });
    expect(files(await answer(await h(op("trip", "listFiles", {}, asBen))))).toContain(
      "shared/notes.md",
    );
  });

  it("answers a read during which the Member's reach changed as one to try again, not a missing workspace", async () => {
    const { storage, h, holdSyncs } = await joined();
    const release = holdSyncs();
    const reading = h(op("trip", "listFiles", {}, asBen));
    await vi.waitFor(() => expect(storage.listAutomationWorkspaces().length).toBeGreaterThan(0));
    expect(
      storage.changeFolderRule({
        workspaceId: "trip",
        actorUserId: "ana",
        change: { kind: "create", folder: "docs", rule: RULE },
        nowMs: 7,
      }),
    ).toMatchObject({ ok: true });
    release();
    const answer = await reading;
    expect(answer.status).toBe(503);
    expect(await json(answer)).toMatchObject({ code: "server_busy" });
  });
});
