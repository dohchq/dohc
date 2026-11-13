import { afterEach, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { UnauthorizedError, type AccountSession, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { CHAT_WAKE_WAIT_MAX_MS } from "@dohc/workspace-contracts/chat-wakes";
import { CHAT_WAKE_WAITS_PER_INSTALL } from "./chatWakeRoutes";
import { DiscussionActivityHub } from "./discussionActivity";
import { chatWakeId, type ChatWakeTarget } from "./storage/chatWakes";
import { closeTestStorages, denialBytes, inspectDatabase, json, storagePath, testHandler, testStorage } from "./testing";

// The routes run over real storage, with the wakes a publication would make written to it directly.

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeTestStorages();
});

const NOW = 50_000_000;

const target = (name: string, ...installs: string[]): ChatWakeTarget => ({
  target: `mention:${name}`, candidates: installs.map((installId) => ({ installId, agentId: "default", label: `${installId} label`, matched: { handle: name } })),
});
const wakeOf = (messageId: string, name = "claude", generation = 1) => chatWakeId("ana", "trip", messageId, `mention:${name}`, generation);

async function relay() {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  storage.claimWorkspace({ workspaceId: "bens", ownerUserId: "ben", createdAtMs: 1 });
  // `Bearer session:<user>:<session>` is a valid sign-in, under `rename` while it is set. `holdSession(n)` holds the
  // nth sign-in check from now until its release.
  let rename: string | null = null;
  let checks = 0;
  let held: { at: number; reached(): void; open: Promise<void> } | null = null;
  const resolveAccountSession: ResolveAccountSession = async (request) => {
    const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(request.headers.get("authorization") ?? "");
    if (!match) throw new UnauthorizedError();
    checks += 1;
    if (held !== null && checks === held.at) {
      const hold = held;
      held = null;
      hold.reached();
      await hold.open;
    }
    return { userId: match[1]!, sessionId: rename ?? match[2]!, expiresAtMs: Number.MAX_SAFE_INTEGER } satisfies AccountSession;
  };
  const holdSession = (nth: number) => {
    let reached!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    held = { at: checks + nth, reached, open: new Promise<void>((resolve) => { release = resolve; }) };
    return { reached: waiting, release: () => release() };
  };
  const hub = new DiscussionActivityHub();
  const h = testHandler(storage, {
    resolveAccountSession, discussionActivity: hub, nowMs: () => NOW, accountOperationRateLimiter: new TokenBucketLimiter(10_000, 1, 16),
  });
  const call = (method: string, path: string, body?: unknown, input: { userId?: string; signal?: AbortSignal } = {}) =>
    h(new Request(`http://relay.test${path}`, {
      method, headers: { authorization: `Bearer session:${input.userId ?? "ana"}:mac`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(input.signal ? { signal: input.signal } : {}),
    }));
  // A published phone message's wakes, as its verdict records them.
  const publish = (operationId: string, messageId: string, targets: ChatWakeTarget[]) => {
    storage.recordAccountOperation({
      accountId: "ana", operationId, binding: { workspaceId: "trip", operation: "send", args: { operationId } }, incarnation: 1,
      replicationEpoch: "epoch", streamIdentity: "stream", command: {}, writesMessage: true, nowMs: NOW,
    });
    storage.advanceAccountOperation({ accountId: "ana", operationId, message: "published", nowMs: NOW,
      wakes: { publish: { messageId, threadId: "thread-1", held: false, targets } } });
  };
  return { storage, hub, call, publish, holdSession, signOut: () => { rename = "another"; } };
}

it("declares a computer's agents only where its account owns the workspace, with exactly the fields it allows", async () => {
  const { storage, call } = await relay();
  const declaration = { installId: "mac", computerLabel: "Ana's Mac", runners: [{ agentId: "default", displayName: "Claude Code", enabled: true }] };
  expect(await json(await call("PUT", "/sync/workspaces/trip/runners", declaration)))
    .toEqual({ ok: true, workspaceId: "trip", installId: "mac", runners: 1 });
  expect(storage.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs: NOW }))
    .toEqual([{ installId: "mac", computerLabel: "Ana's Mac", agentId: "default", handle: "claudecode", displayName: "Claude Code", enabled: true }]);

  const missing = await denialBytes(await call("PUT", "/sync/workspaces/nowhere/runners", declaration));
  expect(await denialBytes(await call("PUT", "/sync/workspaces/trip/runners", declaration, { userId: "ben" }))).toBe(missing);
  expect(await denialBytes(await call("PUT", "/sync/workspaces/wakes/runners", declaration)), "a reserved ID is no workspace").toBe(missing);
  const runner = declaration.runners[0]!;
  for (const body of [
    { ...declaration, token: "x" },
    { ...declaration, runners: [{ ...runner, handle: "claude" }] },
    { ...declaration, runners: [{ ...runner, agentId: "Default" }] },
    { ...declaration, runners: [{ ...runner, agentId: "p-nova" }] },
    { ...declaration, runners: [runner, { ...runner, agentId: "second" }] },
    { ...declaration, runners: [{ ...runner, enabled: "yes" }] },
  ]) {
    const response = await call("PUT", "/sync/workspaces/trip/runners", body);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  expect((await call("GET", "/sync/workspaces/trip/runners")).status).toBe(405);
  expect(storage.enabledChatRunners({ accountId: "ana", workspaceId: "trip", nowMs: NOW })).toHaveLength(1);
});

it("answers a computer only the waiting wakes that list it, gives the first claim the wake, and takes queued only from the winner", async () => {
  const { call, publish } = await relay();
  publish("op-1", "message-1", [target("claude", "mac", "laptop")]);
  const wakeId = wakeOf("message-1");
  expect(await json(await call("GET", "/sync/wakes?installId=desktop"))).toEqual({ ok: true, cursor: "1", wakes: [] });
  expect(await json(await call("GET", "/sync/wakes?installId=mac"))).toEqual({ ok: true, cursor: "1", wakes: [{
    wakeId, workspaceId: "trip", messageId: "message-1", threadId: "thread-1", generation: 1, state: "waiting",
    prerequisiteMessageId: null, winnerLabel: null, candidate: target("claude", "mac").candidates[0],
  }] });
  expect(await json(await call("GET", "/sync/wakes?installId=mac", undefined, { userId: "ben" }))).toEqual({ ok: true, cursor: "0", wakes: [] });

  const claim = (installId: string, userId = "ana") => call("POST", `/sync/wakes/${wakeId}/claim`, { installId }, { userId });
  const missing = await denialBytes(await call("POST", `/sync/wakes/${wakeOf("message-nowhere")}/claim`, { installId: "mac" }));
  expect(await denialBytes(await claim("desktop"))).toBe(missing);
  expect(await denialBytes(await claim("mac", "ben"))).toBe(missing);
  expect((await call("POST", `/sync/wakes/${wakeId}/claim`, { installId: "mac", agentId: "default" })).status).toBe(400);
  expect((await call("GET", `/sync/wakes/${wakeId}/claim`)).status).toBe(405);
  expect((await call("POST", "/sync/wakes/not-a-wake/claim", { installId: "mac" })).status).toBe(404);
  expect(await json(await claim("mac"))).toMatchObject({ ok: true, won: true, wake: { state: "claimed", winnerLabel: "mac label" } });
  expect(await json(await claim("laptop"))).toMatchObject({ ok: true, won: false, wake: { state: "claimed", winnerLabel: "mac label" } });
  expect(await json(await call("GET", "/sync/wakes?installId=laptop&since=1"))).toEqual({ ok: true, cursor: "2", wakes: [] });

  const queued = (installId: string) => call("POST", `/sync/wakes/${wakeId}/queued`, { installId });
  expect(await denialBytes(await queued("laptop"))).toBe(missing);
  expect(await json(await queued("mac"))).toMatchObject({ ok: true, wake: { state: "queued" } });
});

it("holds a read without polling until a wake commits, within its bounds, and checks the sign-in again after the wait", async () => {
  const { storage, call, publish, signOut } = await relay();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  expect((await call("GET", `/sync/wakes?installId=mac&wait=${CHAT_WAKE_WAIT_MAX_MS + 1}`)).status).toBe(400);

  // A read parks once its recheck of the head runs, after it registers. `parks(n)` resolves once n more have.
  const head = storage.chatWakeHead.bind(storage);
  let checks = 0;
  let waiters: Array<{ at: number; resolve(): void }> = [];
  const heads = vi.spyOn(storage, "chatWakeHead").mockImplementation((accountId) => {
    checks += 1;
    for (const waiter of waiters) if (checks >= waiter.at) waiter.resolve();
    waiters = waiters.filter((waiter) => checks < waiter.at);
    return head(accountId);
  });
  const parks = (count: number) => new Promise<void>((resolve) => { waiters.push({ at: checks + count, resolve }); });
  const lists = vi.spyOn(storage, "listWaitingChatWakes");
  const read = (installId: string, since: number) => call("GET", `/sync/wakes?installId=${installId}&since=${since}&wait=${CHAT_WAKE_WAIT_MAX_MS}`);

  let parked = parks(1);
  const held = read("mac", 0);
  await parked;
  const asked = [heads.mock.calls.length, lists.mock.calls.length];
  vi.advanceTimersByTime(CHAT_WAKE_WAIT_MAX_MS - 1);
  expect([heads.mock.calls.length, lists.mock.calls.length], "an idle read runs no query").toEqual(asked);
  publish("op-1", "message-1", [target("claude", "mac")]);
  expect(await json(await held)).toMatchObject({ ok: true, cursor: "1", wakes: [{ wakeId: wakeOf("message-1") }] });

  // A read past its computer's waits answers busy at once; another computer's still waits. Each ends at its time.
  parked = parks(CHAT_WAKE_WAITS_PER_INSTALL);
  const waiting = Array.from({ length: CHAT_WAKE_WAITS_PER_INSTALL }, () => read("mac", 1));
  await parked;
  const busy = await read("mac", 1);
  expect([busy.status, (await json(busy)).code]).toEqual([503, "server_busy"]);
  parked = parks(1);
  const other = read("laptop", 1);
  await parked;
  vi.advanceTimersByTime(CHAT_WAKE_WAIT_MAX_MS);
  for (const response of await Promise.all([...waiting, other])) expect(await json(response)).toEqual({ ok: true, cursor: "1", wakes: [] });

  // A sign-in that changed while the read waited gets no answer.
  parked = parks(1);
  const gone = read("mac", 1);
  await parked;
  signOut();
  publish("op-2", "message-2", [target("claude", "mac")]);
  expect((await gone).status).toBe(404);
});

it("holds no more than 16 reads for one account across its computers", async () => {
  const { storage, call } = await relay();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const head = storage.chatWakeHead.bind(storage);
  let parked = 0;
  let all!: () => void;
  const filled = new Promise<void>((resolve) => { all = resolve; });
  vi.spyOn(storage, "chatWakeHead").mockImplementation((accountId) => {
    if (++parked === 16) all();
    return head(accountId);
  });
  const read = (installId: string) => call("GET", `/sync/wakes?installId=${installId}&wait=${CHAT_WAKE_WAIT_MAX_MS}`);
  // Two reads on each of eight computers fill the account.
  const waiting = Array.from({ length: 16 }, (_, index) => read(`computer-${index % 8}`));
  await filled;
  const busy = await read("computer-8");
  expect([busy.status, (await json(busy)).code]).toEqual([503, "server_busy"]);
  vi.advanceTimersByTime(CHAT_WAKE_WAIT_MAX_MS);
  for (const response of await Promise.all(waiting)) expect(response.status).toBe(200);
});

it("answers no wake of a workspace deleted while the final sign-in check waits", async () => {
  const { storage, call, publish, holdSession } = await relay();
  publish("op-1", "message-1", [target("claude", "mac")]);
  // The request's own check is the first; the check before the read is the second.
  const held = holdSession(2);
  const reading = call("GET", "/sync/wakes?installId=mac");
  await held.reached;
  const db = inspectDatabase(storagePath(storage), { foreignKeys: true });
  db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = 'trip'").run();
  db.close();
  held.release();
  expect(await json(await reading)).toEqual({ ok: true, cursor: "1", wakes: [] });
});
