import { generateKeyPairSync, verify } from "node:crypto";
import {
  constants,
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { accountDeletionIdentity } from "@dohc/workspace-auth/accountDeletion";
import { afterEach, expect, it, vi } from "vitest";
import { createApnsClient, type ApnsClient } from "./apnsClient";
import { APNS_PAYLOAD_MAX_BYTES, apnsPayload, apnsText } from "./apnsPayload";
import { readApnsConfig } from "./pushConfig";
import { APNS_PAUSE_MS, createPushSender, PUSH_STREAMS } from "./pushSender";
import { initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import {
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  moment,
  putBlob,
  sequenced,
  testHandler,
  testStorage,
  type ChatOp,
} from "./testing";

const TOPIC = "com.example.phone";
const KEY_ID = "KEY1234567";
const TEAM_ID = "TEAM123456";
const KEY_PATH = "/run/secrets/apns-key.p8";
const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const apnsConfig = readApnsConfig(
  {
    DOHC_RELAY_APNS_TOPIC: TOPIC,
    DOHC_RELAY_APNS_ENVIRONMENTS: "sandbox",
    DOHC_RELAY_APNS_KEY_FILE: KEY_PATH,
    DOHC_RELAY_APNS_KEY_ID: KEY_ID,
    DOHC_RELAY_APNS_TEAM_ID: TEAM_ID,
  },
  () => PEM,
)!;
const SECRET_TEXT = "the gate code is 4417";
const tokenOf = (userId: string) => Buffer.from(userId).toString("hex").padEnd(64, "0");

interface ApnsRequest {
  headers: IncomingHttpHeaders;
  body: string;
}
interface ApnsAnswer {
  status: number;
  body?: Record<string, unknown>;
  // Cancel the stream after the headers, before any body.
  reset?: boolean;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeTestStorages();
});

/** A local HTTP/2 stand-in for Apple. `answer` decides each response, and may wait. */
async function fakeApns() {
  const requests: ApnsRequest[] = [];
  const waiters: Array<{ count: number; done: () => void }> = [];
  let answer: (request: ApnsRequest) => ApnsAnswer | Promise<ApnsAnswer> = () => ({
    status: 200,
  });
  const server: Http2Server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  let connections = 0;
  server.on("session", (session) => {
    connections++;
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", () => {});
    stream.on("end", () => {
      const request = { headers, body: Buffer.concat(chunks).toString() };
      requests.push(request);
      for (const waiter of waiters.filter((w) => requests.length >= w.count)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.done();
      }
      void Promise.resolve(answer(request)).then((reply) => {
        if (stream.destroyed || stream.closed) return;
        stream.respond({ ":status": reply.status });
        if (reply.reset) return stream.close(constants.NGHTTP2_CANCEL);
        stream.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    get connections() {
      return connections;
    },
    answer(next: typeof answer) {
      answer = next;
    },
    received(count: number) {
      return requests.length >= count
        ? Promise.resolve()
        : new Promise<void>((done) => waiters.push({ count, done }));
    },
  };
}

/** Workspaces owned by each person, each with a team chat and the owner's phone, named for mentions. */
async function relay(people: Array<[string, string]> = [["owner", "Kim"]]) {
  const storage = (await testStorage({ apnsConfigured: true })) as StorageContext;
  const apple = await fakeApns();
  const append = (workspaceId: string, ops: ChatOp[], originId: string) =>
    storage.appendLogBatch({
      workspaceId,
      originId,
      ops: sequenced(ops, storage.maxOriginSeq(workspaceId, originId) + 1).map(
        ({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) }),
      ),
    });
  const generations = new Map<string, number>();
  const bind = (userId: string, name: string, token = tokenOf(userId)) => {
    const generation = storage.bindPushDevice({
      userId,
      sessionId: `${userId}-phone`,
      sessionExpiresAtMs: Date.now() + 1_000_000,
      token,
      environment: "sandbox",
      topic: TOPIC,
      accountName: name,
      nowMs: Date.now(),
    }).generation;
    generations.set(userId, generation);
    return generation;
  };
  for (const [userId, name] of people) {
    const workspaceId = `w-${userId}`;
    storage.claimWorkspace({ workspaceId, ownerUserId: userId, createdAtMs: 1 });
    append(
      workspaceId,
      [
        chatChannelCreate("team", {
          kind: "channel",
          name: "Team",
          type: "both",
          folderPath: "team",
        }),
        chatChannelCreate(AGENT_CHANNEL_WIRE_ID, { kind: "agent", name: "Claude" }),
        chatThreadCreate("team-thread", "team"),
        chatThreadCreate("other-thread", "team"),
        chatThreadCreate("agent-thread", AGENT_CHANNEL_WIRE_ID),
      ],
      userId,
    );
    bind(userId, name);
  }
  const clients: ApnsClient[] = [];
  const client = (now?: () => number) => {
    const made = createApnsClient(apnsConfig, {
      origins: { sandbox: apple.origin },
      ...(now ? { now } : {}),
    });
    clients.push(made);
    return made;
  };
  cleanups.push(async () => {
    await Promise.all(clients.map((made) => made.close()));
  });
  return {
    storage,
    apple,
    append,
    bind,
    generations,
    client,
    say(author: string, owner: string, messageId: string, threadId: string, body: string) {
      append(
        `w-${owner}`,
        [chatMessageAppend(messageId, threadId, body, { authorUserId: author })],
        author,
      );
    },
    agent(owner: string, messageId: string, threadId: string, name = "Claude") {
      append(
        `w-${owner}`,
        [
          chatMessageAppend(messageId, threadId, "Done.", {
            authorUserId: owner,
            authorKind: "agent",
            authorDisplayName: name,
          }),
        ],
        `${owner}-agent`,
      );
    },
    notice(owner: string, messageId: string, threadId: string) {
      storage.postNotice({
        noticeId: "agent-run:1",
        recipientUserId: owner,
        reach: { workspaceId: `w-${owner}` },
        kind: "agent-run",
        title: "Your agent finished",
        body: "",
        target: { thread: threadId, message: messageId },
        originInstallId: "install-a",
        senderUserId: owner,
        senderLabel: "Claude",
        nowMs: Date.now(),
      });
    },
    sender(options: Partial<Parameters<typeof createPushSender>[0]> = {}) {
      return createPushSender({
        storage,
        config: undefined,
        apns: client(),
        lookupAccountName: (userId) => (userId === "alice" ? "Alice" : "Someone"),
        sessionIsValid: async () => true,
        ...options,
      });
    },
    rows: () =>
      storage.db
        .prepare(
          "SELECT * FROM sync_relay_push_deliveries WHERE installation_id IS NULL ORDER BY rowid",
        )
        .all(),
    binding: (userId: string) =>
      storage.db
        .prepare(
          "SELECT generation FROM sync_relay_push_subscriptions WHERE kind = 'apns' AND account_user_id = ?",
        )
        .get(userId),
  };
}

const decodeJwt = (authorization: unknown) => {
  const [header, claims, signature] = String(authorization)
    .replace(/^bearer /u, "")
    .split(".");
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature!, "base64url"),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header!, "base64url").toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<string, unknown>,
  };
};

it("sends one alert with Apple's headers, a signed provider token, and only identifiers besides the alert", async () => {
  const f = await relay();
  f.say(
    "alice",
    "owner",
    "message",
    "team-thread",
    "@Kim see https://example.com/trip/secret?code=1 and @[docs/plan.md] and @[docs/.env.local]",
  );
  const before = Date.now();
  const sender = f.sender();
  expect(await sender.runOnce()).toBe(true);
  const after = Date.now();
  await sender.close();
  expect(f.apple.requests).toHaveLength(1);
  const [{ headers, body }] = f.apple.requests as [ApnsRequest];
  expect(headers).toMatchObject({
    ":method": "POST",
    ":path": `/3/device/${tokenOf("owner")}`,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-topic": TOPIC,
    "content-type": "application/json",
  });
  // Now + 60 s, well inside the delivery's 15 minutes.
  const expiration = Number(headers["apns-expiration"]);
  expect(expiration).toBeGreaterThanOrEqual(Math.floor((before + 60_000) / 1000));
  expect(expiration).toBeLessThanOrEqual(Math.floor((after + 60_000) / 1000));
  const collapse = String(headers["apns-collapse-id"]);
  expect(Buffer.byteLength(collapse)).toBeLessThanOrEqual(64);
  const jwt = decodeJwt(headers.authorization);
  expect(jwt.valid).toBe(true);
  expect(jwt.header).toEqual({ alg: "ES256", kid: KEY_ID });
  expect(jwt.claims).toEqual({ iss: TEAM_ID, iat: expect.any(Number) });

  const payload = JSON.parse(body) as Record<string, unknown>;
  const row = f.rows()[0]!;
  expect(payload).toEqual({
    aps: {
      alert: {
        title: "Alice mentioned you in Team",
        body: "@Kim see example.com and plan.md and a file",
      },
      sound: "default",
      "thread-id": collapse,
    },
    generation: f.generations.get("owner"),
    workspaceId: "w-owner",
    threadId: "team-thread",
    messageId: "message",
    deliveryId: row.delivery_id,
  });
  expect(row).toMatchObject({ state: "sent", attempts: 1 });
  // Nothing composed is kept.
  expect(
    JSON.stringify(f.storage.db.prepare("SELECT * FROM sync_relay_push_deliveries").all()),
  ).not.toContain("example.com");
});

it("caps the expiration at the delivery's own expiry, and drops one that would expire within the second", async () => {
  const f = await relay();
  f.say("alice", "owner", "soon", "team-thread", "@Kim soon");
  const nowMs = Math.ceil(Date.now() / 1000) * 1000 + 1000;
  f.storage.db
    .prepare("UPDATE sync_relay_push_deliveries SET expires_at_ms = ?")
    .run(nowMs + 5_400);
  const sender = f.sender({ now: () => nowMs });
  await sender.runOnce();
  expect(f.apple.requests[0]?.headers["apns-expiration"]).toBe(String(nowMs / 1000 + 5));

  f.say("alice", "owner", "late", "other-thread", "@Kim late");
  f.storage.db
    .prepare("UPDATE sync_relay_push_deliveries SET expires_at_ms = ? WHERE message_id = 'late'")
    .run(nowMs + 400);
  await sender.runOnce();
  await sender.close();
  expect(f.apple.requests).toHaveLength(1);
  expect(f.rows().find((row) => row.message_id === "late")).toMatchObject({ state: "dropped" });
});

it("sends nothing for a run Notice still waiting for its message", async () => {
  const f = await relay();
  f.notice("owner", "answer", "agent-thread");
  expect(f.rows()).toEqual([expect.objectContaining({ relay_seq: null, state: "pending" })]);
  const sender = f.sender();
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(f.apple.requests).toEqual([]);
});

type Stage = "provider token and connection" | "name lookup" | "session check";
type Change = (f: Awaited<ReturnType<typeof relay>>) => void | Promise<void>;
const changes: Array<[string, Change]> = [
  [
    "Show on phone turns off",
    (f) => {
      f.storage.setShowOnPhone({
        ownerUserId: "owner",
        workspaceId: "w-owner",
        showOnPhone: false,
      });
    },
  ],
  [
    "the phone begins signing out",
    (f) =>
      f.storage.fencePushSession({
        userId: "owner",
        sessionId: "owner-phone",
        attemptId: "attempt",
        expiresAtMs: Date.now() + 1_000_000,
      }),
  ],
  ["the binding takes a new generation", (f) => void f.bind("owner", "Kim", "ef".repeat(32))],
  [
    "the workspace is being deleted",
    (f) => {
      initializeAccountDeletion(f.storage, "account-deletion-key-at-least-32-bytes");
      f.storage.db
        .prepare("INSERT INTO sync_relay_deleted_workspaces VALUES (?)")
        .run(
          accountDeletionIdentity("account-deletion-key-at-least-32-bytes", "workspace:w-owner"),
        );
    },
  ],
  [
    "the chat's file moves to a hidden path",
    (f) =>
      void f.append(
        "w-owner",
        [
          moment("docs/.env.local", "plan", {
            objectId: "plan",
            operation: "rename",
            beforePath: "docs/plan.md",
            beforeContent: "plan",
          }),
        ],
        "owner",
      ),
  ],
];
const stages: Stage[] = ["provider token and connection", "name lookup", "session check"];

it.each(stages.flatMap((stage) => changes.map(([name, change]) => [stage, name, change] as const)))(
  "sends nothing when, during the %s, %s",
  async (stage, _name, change) => {
    const f = await relay();
    await putBlob(testHandler(f.storage), "owner", "w-owner", "plan");
    f.append(
      "w-owner",
      [
        moment("docs/plan.md", "plan", { objectId: "plan" }),
        chatThreadCreate("file-thread", "", {
          channelWireId: null,
          channelSlug: null,
          linkedObjectId: "plan",
          linkedAtMs: 2,
        }),
      ],
      "owner",
    );
    f.say("alice", "owner", "message", "file-thread", `@Kim ${SECRET_TEXT}`);
    expect(f.rows()).toHaveLength(1);
    const apns = f.client();
    const sender = f.sender({
      apns: {
        config: apns.config,
        async open(environment, signal) {
          if (stage === "provider token and connection") await change(f);
          return apns.open(environment, signal);
        },
        forgetToken: () => apns.forgetToken(),
        close: () => apns.close(),
      },
      async lookupAccountName() {
        if (stage === "name lookup") await change(f);
        return "Alice";
      },
      async sessionIsValid() {
        if (stage === "session check") await change(f);
        return true;
      },
    });
    await sender.runOnce();
    await sender.close();
    expect(f.apple.requests).toEqual([]);
    expect(f.rows().filter((row) => row.state !== "dropped")).toEqual([]);
  },
);

it("sends nothing when the session check finds the sign-in revoked", async () => {
  const f = await relay();
  f.say("alice", "owner", "message", "team-thread", "@Kim hi");
  const sessionIsValid = vi.fn(async () => false);
  const sender = f.sender({ sessionIsValid });
  await sender.runOnce();
  await sender.close();
  expect(sessionIsValid).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "owner", sessionId: "owner-phone" }),
    expect.any(AbortSignal),
  );
  expect(f.apple.requests).toEqual([]);
  expect(f.rows()).toEqual([expect.objectContaining({ state: "dropped" })]);
});

it("sends an agent's answer only while its run Notice is still listed", async () => {
  const f = await relay();
  f.agent("owner", "answer", "agent-thread");
  f.notice("owner", "answer", "agent-thread");
  expect(f.rows()).toEqual([expect.objectContaining({ notice_id: "agent-run:1" })]);
  const sender = f.sender({
    async sessionIsValid() {
      f.storage.db.prepare("UPDATE sync_relay_notices SET dismissed_at_ms = ?").run(Date.now());
      return true;
    },
  });
  await sender.runOnce();
  await sender.close();
  expect(f.apple.requests).toEqual([]);
});

it.each([
  ["dismissed before the final check, sends nothing", true],
  ["still listed, names it in the alert", false],
] as const)(
  "reads a run Notice that arrives during the session check: %s",
  async (_name, dismissed) => {
    const f = await relay();
    f.agent("owner", "answer", "agent-thread");
    expect(f.rows()).toEqual([expect.objectContaining({ reason: "agent", notice_id: null })]);
    const sender = f.sender({
      async sessionIsValid() {
        f.notice("owner", "answer", "agent-thread");
        if (dismissed)
          f.storage.db.prepare("UPDATE sync_relay_notices SET dismissed_at_ms = ?").run(Date.now());
        return true;
      },
    });
    await sender.runOnce();
    await sender.close();
    expect(f.rows()).toEqual([expect.objectContaining({ notice_id: "agent-run:1" })]);
    if (dismissed) return expect(f.apple.requests).toEqual([]);
    expect(f.apple.requests).toHaveLength(1);
    expect(JSON.parse(f.apple.requests[0]!.body)).toMatchObject({ noticeId: "agent-run:1" });
  },
);

it("drops an alert that failed while a newer one for its thread arrived, so the retry cannot replace it", async () => {
  const f = await relay();
  f.say("alice", "owner", "older", "team-thread", "@Kim first");
  let offsetMs = 0;
  f.apple.answer(() => {
    if (f.apple.requests.length > 1) return { status: 200 };
    f.say("alice", "owner", "newer", "team-thread", "@Kim second");
    return { status: 500 };
  });
  const sender = f.sender({ now: () => Date.now() + offsetMs });
  await sender.runOnce();
  await sender.runOnce();
  // Past the older alert's backoff.
  offsetMs = 10_000;
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(
    f.apple.requests.map(
      (request) => (JSON.parse(request.body) as { messageId: string }).messageId,
    ),
  ).toEqual(["older", "newer"]);
  expect(f.rows().map((row) => [row.message_id, row.state])).toEqual([
    ["older", "dropped"],
    ["newer", "sent"],
  ]);
});

it("pauses phone alerts for 20 minutes on a 403, spending no attempt and keeping the token", async () => {
  const f = await relay();
  f.say("alice", "owner", "first", "team-thread", "@Kim one");
  f.say("alice", "owner", "second", "other-thread", "@Kim two");
  f.apple.answer(() => ({ status: 403, body: { reason: "InvalidProviderToken" } }));
  const onApnsRefused = vi.fn();
  const onError = vi.fn();
  const start = Date.now();
  const sender = f.sender({ onApnsRefused, onError });
  expect(await sender.runOnce()).toBe(true);
  expect(onApnsRefused).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  const paused = f.rows().find((row) => row.message_id === "first")!;
  expect(paused).toMatchObject({ state: "pending", attempts: 0, lease_token: null });
  expect(Number(paused.available_at_ms)).toBeGreaterThanOrEqual(start + APNS_PAUSE_MS);
  // The other alert waits too, and nothing else reaches Apple.
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(f.apple.requests).toHaveLength(1);
  expect(f.rows().every((row) => row.state === "pending")).toBe(true);
  expect(f.binding("owner")).toEqual({ generation: f.generations.get("owner") });
});

it.each([
  ["registered before Apple's timestamp", 1, false],
  ["registered again after Apple's timestamp", -1, true],
] as const)("on a 410, ends only that generation if it was %s", async (_name, sign, kept) => {
  const f = await relay([
    ["owner", "Kim"],
    ["ben", "Ben"],
  ]);
  f.say("alice", "owner", "message", "team-thread", "@Kim hi");
  const registeredAt = Number(
    f.storage.db
      .prepare(
        "SELECT updated_at_ms FROM sync_relay_push_subscriptions WHERE account_user_id = 'owner'",
      )
      .get()!.updated_at_ms,
  );
  f.apple.answer(() => ({
    status: 410,
    body: { reason: "Unregistered", timestamp: registeredAt + sign * 1000 },
  }));
  const sender = f.sender();
  await sender.runOnce();
  await sender.close();
  expect(f.binding("owner")).toEqual(kept ? { generation: f.generations.get("owner") } : undefined);
  expect(f.binding("ben")).toEqual({ generation: f.generations.get("ben") });
});

it("keeps the binding when a 410's stream is reset before its body arrives", async () => {
  const f = await relay();
  f.say("alice", "owner", "message", "team-thread", "@Kim hi");
  f.apple.answer(() => ({ status: 410, reset: true }));
  const onError = vi.fn();
  const sender = f.sender({ onError });
  await sender.runOnce();
  await sender.close();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(f.binding("owner")).toEqual({ generation: f.generations.get("owner") });
  expect(f.rows()).toEqual([expect.objectContaining({ state: "pending", lease_token: null })]);
});

it("keeps a binding registered again during a 410 that carries no timestamp", async () => {
  const f = await relay();
  const generation = f.generations.get("owner");
  f.say("alice", "owner", "message", "team-thread", "@Kim hi");
  let rebound: number | undefined;
  f.apple.answer(() => {
    rebound = f.bind("owner", "Kim");
    return { status: 410, body: { reason: "Unregistered" } };
  });
  const sender = f.sender();
  await sender.runOnce();
  await sender.close();
  // The same token and sign-in keeps its generation, so only the missing timestamp can save it.
  expect(rebound).toBe(generation);
  expect(f.binding("owner")).toEqual({ generation });
  expect(f.rows()).toEqual([expect.objectContaining({ state: "pending", lease_token: null })]);
});

it(`runs at most ${PUSH_STREAMS} streams at once, one per recipient`, async () => {
  const people: Array<[string, string]> = [
    ["ana", "Ana"],
    ["ben", "Ben"],
    ["cyd", "Cyd"],
    ["dee", "Dee"],
    ["eve", "Eve"],
  ];
  const f = await relay(people);
  for (const [userId, name] of people)
    f.say("zed", userId, `m-${userId}`, "team-thread", `@${name} hi`);
  f.say("zed", "ana", "m-ana-2", "other-thread", "@Ana again");
  const held: Array<() => void> = [];
  f.apple.answer(() => new Promise<ApnsAnswer>((done) => held.push(() => done({ status: 200 }))));
  const sender = f.sender();
  sender.start();
  await f.apple.received(PUSH_STREAMS);
  const leased = () =>
    f.rows().filter((row) => row.lease_token !== null && Number(row.lease_until_ms) > Date.now());
  // Every claim that could start did, in the same pass, so a fifth would be leased by now.
  expect(leased()).toHaveLength(PUSH_STREAMS);
  expect(new Set(leased().map((row) => row.account_user_id)).size).toBe(PUSH_STREAMS);
  expect(f.apple.requests).toHaveLength(PUSH_STREAMS);
  held.shift()!();
  await f.apple.received(PUSH_STREAMS + 1);
  const recipients = f.apple.requests.map((request) => request.headers[":path"]);
  expect(new Set(recipients).size).toBe(PUSH_STREAMS + 1);
  while (f.apple.requests.length < people.length + 1) {
    for (const release of held.splice(0)) release();
    await f.apple.received(f.apple.requests.length + 1);
  }
  for (const release of held.splice(0)) release();
  await sender.close();
  expect(f.rows().map((row) => row.state)).toEqual(Array(people.length + 1).fill("sent"));
});

it("reuses the provider token for 40 minutes, and signs a new one after that or after Apple refuses it", async () => {
  const f = await relay();
  let nowMs = Date.UTC(2026, 10, 19, 4);
  const client = f.client(() => nowMs);
  const send = async () => {
    const controller = new AbortController();
    const stream = await client.open("sandbox", controller.signal);
    await stream.send(tokenOf("owner"), { "apns-topic": TOPIC }, "{}", controller.signal);
    return decodeJwt(f.apple.requests.at(-1)!.headers.authorization);
  };
  const first = await send();
  expect(first.claims.iat).toBe(nowMs / 1000);
  nowMs += 39 * 60_000;
  expect((await send()).claims.iat).toBe(first.claims.iat);
  nowMs += 2 * 60_000;
  const renewed = await send();
  expect(renewed.claims.iat).toBe(nowMs / 1000);
  expect(renewed.valid).toBe(true);
  nowMs += 60_000;
  client.forgetToken();
  expect((await send()).claims.iat).toBe(nowMs / 1000);
  // One connection carried every request.
  expect(f.apple.connections).toBe(1);
});

it("keeps tokens, provider tokens, the key, and message text out of every log and error", async () => {
  const f = await relay();
  const logged: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(...args));
  const onError = vi.fn((...args: unknown[]) => logged.push(...args));
  const onApnsRefused = vi.fn((...args: unknown[]) => logged.push(...args));
  const answers: ApnsAnswer[] = [
    { status: 403, body: { reason: "InvalidProviderToken" } },
    { status: 500, body: { reason: "InternalServerError" } },
    { status: 410, body: { reason: "Unregistered", timestamp: Date.now() + 60_000 } },
  ];
  for (const [index, reply] of answers.entries()) {
    f.append("w-owner", [chatThreadCreate(`t${index}`, "team")], "owner");
    f.say("alice", "owner", `m${index}`, `t${index}`, `@Kim ${SECRET_TEXT}`);
    f.apple.answer(() => reply);
    const sender = f.sender({ onError, onApnsRefused });
    await sender.runOnce();
    await sender.close();
  }
  // A send that never gets an answer, and a connection that fails.
  const client = createApnsClient(apnsConfig, { origins: { sandbox: "http://127.0.0.1:1" } });
  const failed = await client.open("sandbox", new AbortController().signal).catch((error) => error);
  await client.close();
  logged.push(failed);
  expect(onError.mock.calls.every((call) => call.length === 0)).toBe(true);
  expect(onApnsRefused.mock.calls.every((call) => call.length === 0)).toBe(true);
  const authorization = String(f.apple.requests[0]?.headers.authorization);
  const text = logged
    .map((entry) => (entry instanceof Error ? `${entry.message}\n${entry.stack}` : String(entry)))
    .join("\n");
  for (const secret of [
    tokenOf("owner"),
    authorization.replace(/^bearer /u, ""),
    PEM.split("\n")[1]!,
    SECRET_TEXT,
    KEY_PATH,
  ])
    expect(text).not.toContain(secret);
});

it("cleans lock-screen text: file names unless hidden, hosts only, no Markdown targets or control characters", () => {
  const work = `@[work:${"a".repeat(43)}]`;
  expect(
    apnsText(
      `# Plan\n**Read** [the doc](https://docs.example.com/x/y?k=1) ![map](/blob/abc) ${work} ` +
        "and @[notes/trip.md] or @[docs/.env.local]; join example.org/l/AbCdEfGh /l/AbCdEfGh12 " +
        "mail ana@mail.example.com a\u0000b\u202ec\u200bd <script>",
    ),
  ).toBe(
    "Plan Read the doc map a link and trip.md or a file; join example.org a link mail mail.example.com a b c d script",
  );
  expect(apnsText("broken @[unclosed and more")).toBe("broken a file");
  expect(apnsText("lone \uD800 surrogate")).toBe("lone \uFFFD surrogate");
});

it.each([
  ["a target with parentheses", "[doc](https://files.example/report(2026)/invite/SECRET)", "doc"],
  ["a target with a query after parentheses", "[doc](https://example.com/a(b)?secret=4417)", "doc"],
  ["a relative target with a title", '[doc](/private/SECRET "Document")', "doc"],
  ["a target with an escaped parenthesis", "[doc](https://files.example/a\\)/invite/SECRET) after", "doc after"],
  ["a target never closed", "[doc](https://x.example/(a)/SECRET\nnext", "doc next"],
  ["a host without a dot", "see https://intranet/private?code=SECRET now", "see intranet now"],
  ["a URL with no host", "open file:///Users/kim/SECRET.txt", "open a link"],
  ["a Unicode host", "https://例え.jp/l/SECRET", "例え.jp"],
  ["a Unicode host without a scheme", "at 例え.jp/l/SECRET", "at 例え.jp"],
])("keeps no URL path from %s", (_name, text, cleaned) => {
  expect(apnsText(text)).toBe(cleaned);
});

it.each([
  ["hyphenated words", "a-".repeat(32_768)],
  ["single-letter domain labels", "a.".repeat(32_768)],
  ["user names without a host", "a@".repeat(32_768)],
  ["Markdown openers", "[a](".repeat(16_384)],
  ["brackets", "[".repeat(65_536)],
])("cleans 64 KB of %s quickly", (_name, text) => {
  apnsText("warm https://example.com/x [a](b)");
  const start = performance.now();
  const cleaned = apnsText(text);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(25);
  expect(cleaned.endsWith("…")).toBe(true);
});

it("cleans a URL out of the sender's name in the title", async () => {
  const f = await relay();
  f.say("alice", "owner", "message", "team-thread", "@Kim hi");
  const sender = f.sender({ lookupAccountName: () => "https://example.com/l/SECRET" });
  await sender.runOnce();
  await sender.close();
  const payload = JSON.parse(f.apple.requests[0]!.body) as { aps: { alert: { title: string } } };
  expect(payload.aps.alert.title).toBe("example.com mentioned you in Team");
});

it("keeps the agent mark after a name with an unclosed Markdown target", async () => {
  const f = await relay();
  f.agent("owner", "answer", "agent-thread", "[Ana](");
  const sender = f.sender();
  await sender.runOnce();
  await sender.close();
  const payload = JSON.parse(f.apple.requests[0]!.body) as { aps: { alert: { title: string } } };
  expect(payload.aps.alert.title).toMatch(/^Ana \(.+'s agent\) /u);
});

it.each([
  ["a short body", "See you at 9.", false],
  ["many escaped characters", '"\\\n'.repeat(3000), true],
  ["four-byte characters", "😀".repeat(2000), true],
  ["two-byte characters", "é".repeat(5000), true],
])("fits %s into Apple's 4096 bytes, cut by code point", (_name, body, cut) => {
  const payload = apnsPayload({
    title: "Alice mentioned you in Team",
    body,
    threadKey: "thread-key",
    data: { generation: 1, workspaceId: "w", threadId: "t", messageId: "m", deliveryId: "d" },
  });
  expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(APNS_PAYLOAD_MAX_BYTES);
  const sent = (JSON.parse(payload) as { aps: { alert: { body: string } } }).aps.alert.body;
  expect(sent.isWellFormed()).toBe(true);
  if (!cut) return expect(sent).toBe(body);
  expect(sent.endsWith("…")).toBe(true);
  expect(body.startsWith(sent.slice(0, -1))).toBe(true);
  // One more code point would not have fit.
  const next = [...body].slice(0, [...sent].length).join("") + "…";
  expect(
    Buffer.byteLength(payload.replace(JSON.stringify(sent), JSON.stringify(next))),
  ).toBeGreaterThan(APNS_PAYLOAD_MAX_BYTES);
});
