import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatWakeView } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import { deferred } from "../testing/deferred";
import { ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import type { ChatWakeWorkspace } from "./chatWakeConsumer";
import { ChatWakeIntentsUnreadableError, type ChatWakeIntent, type ChatWakeIntents } from "./chatWakeIntents";
import {
  CHAT_WAKE_BACKOFF_MAX_MS, chatWakeBackoffMs, createChatWakeLifetime, sleepUnlessAborted,
  type ChatWakeLifetimeDeps, type ChatWakeSession,
} from "./chatWakeLifetime";

// The relay, the intent store, and the workspace are fakes. Each wait is on a
// barrier: a read parking, a report, or a gate the test opens.

afterEach(() => {
  vi.useRealTimers();
});

const WAKE = `wake-${"a".repeat(32)}`;

function session(scope: string, installId = "mac") {
  let current = true;
  const value = {
    account: { scope, userId: "ana", installId },
    relay: { baseUrl: "https://relay.test", token: `token-${scope}` },
    isCurrent: () => current,
    unauthorized: vi.fn(() => { current = false; }),
    end: () => { current = false; },
  } satisfies ChatWakeSession & { end(): void };
  return value;
}

function intentOf(phase: ChatWakeIntent["phase"], scope = "A"): ChatWakeIntent {
  return {
    account: scope, userId: "ana", installId: "mac", wakeId: WAKE, generation: 1, workspaceId: "ws", threadId: "t1",
    messageId: "m1", prerequisiteMessageId: null,
    candidate: { installId: "mac", agentId: "default", label: "Mac", matched: { handle: "claude" } }, phase,
  };
}

const view = (state: ChatWakeView["state"]): ChatWakeView => ({
  wakeId: WAKE, workspaceId: "ws", messageId: "m1", threadId: "t1", generation: 1, state,
  prerequisiteMessageId: null, winnerLabel: "Mac",
});

/** Reads park until their consumer stops. `untilReads(n)` resolves once n reads have parked. */
function fakeRelay() {
  const reads: string[] = [];
  const aborted: string[] = [];
  let watchers: Array<{ count: number; resolve: () => void }> = [];
  const untilReads = (count: number) => count <= reads.length ? Promise.resolve()
    : new Promise<void>((resolve) => { watchers.push({ count, resolve }); });
  const firstRead = new Map<string, () => Promise<never>>();
  const claims: string[] = [];
  const confirms: Array<() => Promise<ChatWakeView>> = [];
  const client = (wakeSession: ChatWakeSession): ChatWakeClient => ({
    replaceRunners: async () => undefined,
    async waitWakes(_input, signal) {
      const scope = wakeSession.account.scope;
      const refusal = firstRead.get(scope);
      if (refusal) {
        firstRead.delete(scope);
        return await refusal();
      }
      reads.push(scope);
      for (const watcher of watchers.filter((each) => each.count <= reads.length)) watcher.resolve();
      watchers = watchers.filter((each) => each.count > reads.length);
      return await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => { aborted.push(scope); reject(new Error("aborted")); }, { once: true });
      });
    },
    async claimWake() {
      claims.push(wakeSession.account.scope);
      throw new ChatWakeMissingError();
    },
    async confirmQueued() {
      const next = confirms.shift();
      if (!next) throw new ChatWakeMissingError();
      return await next();
    },
  });
  return { reads, aborted, untilReads, firstRead, claims, confirms, client };
}

function memoryIntents(rows: ChatWakeIntent[] = []) {
  const state = { rows, unreadable: false, listGate: null as Promise<void> | null, lists: 0 };
  const same = (a: ChatWakeIntent, b: ChatWakeIntent) => a.account === b.account && a.installId === b.installId && a.wakeId === b.wakeId;
  const check = () => { if (state.unreadable) throw new ChatWakeIntentsUnreadableError(); };
  const store: ChatWakeIntents = {
    list: async () => {
      state.lists += 1;
      const gate = state.listGate;
      state.listGate = null;
      if (gate) await gate;
      check();
      return [...state.rows];
    },
    save: async (intent) => { check(); state.rows = [...state.rows.filter((row) => !same(row, intent)), intent]; },
    remove: async (intent) => { check(); state.rows = state.rows.filter((row) => !same(row, intent)); },
  };
  return { state, store };
}

/** A workspace where the wake's message, thread, and agent all allow it. */
function readyWorkspace(): ChatWakeWorkspace {
  return {
    current: () => true,
    requestSync: () => undefined,
    message: async () => ({ id: "m1", workspaceId: "ws", threadId: "t1", author: { kind: "human", displayName: "Ana" }, authorUserId: "ana" }),
    threadVisibility: async () => "visible",
    decisions: async () => [],
    agent: async () => ({ name: "Claude", enabled: true, launch: true, admitted: true }),
    recordTrigger: async () => true,
    dispatch: () => undefined,
    release: async () => undefined,
  };
}

function setup(over: Partial<ChatWakeLifetimeDeps> = {}, rows: ChatWakeIntent[] = []) {
  const relay = fakeRelay();
  const intents = memoryIntents(rows);
  const deps: ChatWakeLifetimeDeps = {
    on: true,
    intents: intents.store,
    client: vi.fn(relay.client),
    openWorkspace: vi.fn(async () => null),
    // A backoff parks until its consumer stops.
    sleep: (_ms, signal) => new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); }),
    backoffMs: chatWakeBackoffMs,
    nowMs: () => 0,
    report: vi.fn(),
    clear: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  return { relay, intents, deps, lifetime: createChatWakeLifetime(deps) };
}

describe("the chat wake lifetime", () => {
  it("starts nothing while chat wakes are off", async () => {
    const w = setup({ on: false });
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await w.lifetime.stop();
    expect(w.deps.client).not.toHaveBeenCalled();
    expect(w.intents.state.lists).toBe(0);
  });

  it("reads only from startup, with no window or focus, and once per snapshot", async () => {
    const w = setup();
    const a = session("A");
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.resume();
    expect(w.deps.client).not.toHaveBeenCalled();
    w.lifetime.start();
    await w.relay.untilReads(1);
    // The same snapshot again changes nothing.
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    await w.lifetime.stop();
    expect(w.deps.client).toHaveBeenCalledOnce();
    expect(w.relay.reads).toEqual(["A"]);
    expect(w.relay.aborted).toEqual(["A"]);
  });

  it("starts the next account only after the old reader has stopped and drained", async () => {
    const w = setup();
    const gate = deferred<void>();
    w.intents.state.listGate = gate.promise;
    const a = session("A");
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    // A's recovery is holding the intent file.
    const b = session("B");
    a.end();
    w.lifetime.credentialsChanged(b, true);
    // Every pending step runs before this; B must still wait for A.
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.deps.client).toHaveBeenCalledTimes(1);
    gate.resolve();
    await w.relay.untilReads(1);
    expect(w.relay.reads).toEqual(["B"]);
    expect(w.deps.client).toHaveBeenLastCalledWith(b);
    await w.lifetime.stop();
  });

  it("ends only the session whose request got a 401", async () => {
    const w = setup();
    const a = session("A");
    w.relay.firstRead.set("A", async () => { throw new RelayUnauthorizedError(); });
    const ended = deferred<void>();
    a.unauthorized.mockImplementation(() => { a.end(); ended.resolve(); });
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    await ended.promise;
    const b = session("B");
    w.lifetime.credentialsChanged(b, true);
    await w.relay.untilReads(1);
    expect(w.relay.reads).toEqual(["B"]);
    expect(a.unauthorized).toHaveBeenCalledOnce();
    expect(b.unauthorized).not.toHaveBeenCalled();
    expect(w.deps.log).not.toHaveBeenCalledWith(expect.any(RelayUnauthorizedError));
    await w.lifetime.stop();
  });

  it("starts nothing after quit", async () => {
    const w = setup();
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await w.relay.untilReads(1);
    await w.lifetime.stop();
    w.lifetime.credentialsChanged(session("B"), true);
    w.lifetime.retry();
    await w.lifetime.stop();
    expect(w.relay.reads).toEqual(["A"]);
    expect(w.relay.aborted).toEqual(["A"]);
  });

  it("refuses an install ID the relay can't take", async () => {
    const w = setup();
    w.lifetime.credentialsChanged(session("A", "x".repeat(257)), true);
    w.lifetime.start();
    await w.lifetime.stop();
    expect(w.deps.client).not.toHaveBeenCalled();
    expect(w.deps.log).toHaveBeenCalledOnce();
  });
});

describe("rows a person sees", () => {
  it("keeps a row through a credential load's placeholder and the same account's next snapshot", async () => {
    const reported = deferred<void>();
    const w = setup({ report: vi.fn(() => reported.resolve()), openWorkspace: vi.fn(async () => readyWorkspace()) }, [intentOf("claim-pending")]);
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await reported.promise;
    expect(w.deps.report).toHaveBeenCalledExactlyOnceWith("ws", "dropped", intentOf("claim-pending"));
    w.lifetime.credentialsChanged(null, false);
    w.lifetime.credentialsChanged(session("A"), true);
    await w.relay.untilReads(2);
    await w.lifetime.stop();
    expect(w.deps.clear).not.toHaveBeenCalled();
  });

  it("takes rows back at sign-out and when another account signs in", async () => {
    const reported = deferred<void>();
    const w = setup({ report: vi.fn(() => reported.resolve()), openWorkspace: vi.fn(async () => readyWorkspace()) }, [intentOf("claim-pending")]);
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await reported.promise;
    w.lifetime.credentialsChanged(null, true);
    w.lifetime.credentialsChanged(session("B"), true);
    await w.relay.untilReads(2);
    await w.lifetime.stop();
    expect(w.deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "dropped");
  });

  it("reports an unreadable intent file once, and Try again takes it back once the file reads", async () => {
    const reported = deferred<void>();
    const w = setup({ report: vi.fn(() => reported.resolve()) });
    w.intents.state.unreadable = true;
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await reported.promise;
    await w.relay.untilReads(1);
    expect(w.deps.report).toHaveBeenCalledExactlyOnceWith(null, "unreadable", null);
    expect(w.deps.log).not.toHaveBeenCalled();
    w.intents.state.unreadable = false;
    w.lifetime.retry();
    await w.relay.untilReads(2);
    await w.lifetime.stop();
    expect(w.deps.clear).toHaveBeenCalledExactlyOnceWith(null, "unreadable");
    expect(w.deps.report).toHaveBeenCalledOnce();
  });

  it("reports a won wake parked on a workspace that left, and takes it back once it is recorded and confirmed", async () => {
    const reported = deferred<void>();
    const cleared = deferred<void>();
    let workspace: ChatWakeWorkspace | null = null;
    const w = setup({
      report: vi.fn(() => reported.resolve()),
      clear: vi.fn(() => cleared.resolve()),
      openWorkspace: vi.fn(async () => workspace),
    }, [intentOf("won")]);
    w.relay.confirms.push(async () => view("queued"));
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await reported.promise;
    expect(w.deps.report).toHaveBeenCalledExactlyOnceWith("ws", "parked", intentOf("won"));
    workspace = readyWorkspace();
    w.lifetime.resume();
    await cleared.promise;
    expect(w.deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "parked");
    await w.lifetime.stop();
    expect(w.intents.state.rows).toEqual([]);
  });

  it("logs nothing for a busy relay or a server without wake routes", async () => {
    const w = setup();
    w.relay.firstRead.set("A", async () => { throw new ChatWakeMissingError(); });
    const slept = deferred<void>();
    w.deps.sleep = (_ms, signal) => {
      slept.resolve();
      return new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    };
    const lifetime = createChatWakeLifetime(w.deps);
    lifetime.credentialsChanged(session("A"), true);
    lifetime.start();
    await slept.promise;
    await lifetime.stop();
    expect(w.deps.log).not.toHaveBeenCalled();
    expect(w.deps.report).not.toHaveBeenCalled();
  });
});

describe("the production backoff", () => {
  it("is positive, doubles, and stops at five minutes", () => {
    expect(chatWakeBackoffMs(0)).toBe(1_000);
    expect(chatWakeBackoffMs(1)).toBe(1_000);
    expect(chatWakeBackoffMs(2)).toBe(2_000);
    expect(chatWakeBackoffMs(9)).toBe(256_000);
    expect(chatWakeBackoffMs(10)).toBe(CHAT_WAKE_BACKOFF_MAX_MS);
    expect(chatWakeBackoffMs(10_000)).toBe(CHAT_WAKE_BACKOFF_MAX_MS);
  });

  it("sleeps until its time, or until its signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let woke = false;
    const sleep = sleepUnlessAborted(60_000, controller.signal).then(() => { woke = true; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(woke).toBe(false);
    controller.abort();
    await sleep;
    expect(woke).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await sleepUnlessAborted(60_000, controller.signal);
    let timed = false;
    const plain = sleepUnlessAborted(1_000, new AbortController().signal).then(() => { timed = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    await plain;
    expect(timed).toBe(true);
  });
});
