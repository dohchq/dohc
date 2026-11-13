import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatWakeView, WaitingChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import { deferred } from "../testing/deferred";
import { ChatWakeMissingError, type ChatWakeClient, type ChatWakePageAnswer } from "./chatWakeClient";
import type { ChatWakeWorkspace } from "./chatWakeConsumer";
import { ChatWakeIntentsUnreadableError, type ChatWakeIntent, type ChatWakeIntents } from "./chatWakeIntents";
import {
  CHAT_WAKE_BACKOFF_MAX_MS, chatWakeBackoffMs, createChatWakeLifetime, sleepUnlessAborted,
  type ChatWakeLifetimeDeps, type ChatWakeSession,
} from "./chatWakeLifetime";
import { createChatWakeNotices } from "./chatWakeNotices";
import type { ChatRunnerRoster } from "./chatRunnerRoster";

// The relay, the intent store, and the workspace are fakes. Each wait is on a
// barrier: a read parking or ending, a report, a gate the test opens, or a
// pass the test awaits. The lifetime's transitions run on a promise chain, so
// a test lets one run (a barrier, or one event-loop turn where it proves an
// absence) before it changes the session again or stops.

afterEach(() => {
  vi.useRealTimers();
});

const WAKE = `wake-${"a".repeat(32)}`;

/** One event-loop turn: every step already queued runs. Used only to show that something did not happen. */
const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });

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

const candidate = { installId: "mac", agentId: "default", label: "Mac", matched: { handle: "claude" } };

function intentOf(phase: ChatWakeIntent["phase"], scope = "A"): ChatWakeIntent {
  return {
    account: scope, userId: "ana", installId: "mac", wakeId: WAKE, generation: 1, workspaceId: "ws", threadId: "t1",
    messageId: "m1", prerequisiteMessageId: null, candidate, phase,
  };
}

const view = (state: ChatWakeView["state"]): ChatWakeView => ({
  wakeId: WAKE, workspaceId: "ws", messageId: "m1", threadId: "t1", generation: 1, state,
  prerequisiteMessageId: null, winnerLabel: "Mac",
});
const waiting: WaitingChatWake = { ...view("waiting"), state: "waiting", candidate };

/** Each read answers a page the test queued, or parks until its consumer stops. */
function fakeRelay() {
  const reads: string[] = [];
  const aborted: string[] = [];
  const watchers: Array<{ count: () => number; at: number; resolve: () => void }> = [];
  const notify = () => {
    for (const watcher of [...watchers]) {
      if (watcher.count() < watcher.at) continue;
      watchers.splice(watchers.indexOf(watcher), 1);
      watcher.resolve();
    }
  };
  const until = (count: () => number, at: number) => count() >= at ? Promise.resolve()
    : new Promise<void>((resolve) => { watchers.push({ count, at, resolve }); });
  const pages: ChatWakePageAnswer[] = [];
  const firstRead = new Map<string, () => Promise<never>>();
  const claims: string[] = [];
  const confirms: Array<() => Promise<ChatWakeView>> = [];
  let wins = false;
  const client = (wakeSession: ChatWakeSession): ChatWakeClient => ({
    replaceRunners: async () => undefined,
    async waitWakes(_input, signal) {
      const scope = wakeSession.account.scope;
      const refusal = firstRead.get(scope);
      if (refusal) {
        firstRead.delete(scope);
        return await refusal();
      }
      const page = pages.shift();
      if (page) return page;
      reads.push(scope);
      notify();
      return await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(scope);
          notify();
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
    async claimWake() {
      claims.push(wakeSession.account.scope);
      if (!wins) throw new ChatWakeMissingError();
      return { won: true, wake: view("claimed") };
    },
    async confirmQueued() {
      const next = confirms.shift();
      if (!next) throw new ChatWakeMissingError();
      return await next();
    },
  });
  return {
    reads, aborted, pages, firstRead, claims, confirms, client,
    /** Resolves once `count` reads have parked. */
    untilReads: (count: number) => until(() => reads.length, count),
    /** Resolves once `count` parked reads have ended. */
    untilAborted: (count: number) => until(() => aborted.length, count),
    winClaims: () => { wins = true; },
  };
}

function memoryIntents(rows: ChatWakeIntent[] = []) {
  const state = { rows, unreadable: false, listGate: null as Promise<void> | null, listEntered: deferred<void>(), lists: 0 };
  const same = (a: ChatWakeIntent, b: ChatWakeIntent) => a.account === b.account && a.installId === b.installId && a.wakeId === b.wakeId;
  const check = () => { if (state.unreadable) throw new ChatWakeIntentsUnreadableError(); };
  const store: ChatWakeIntents = {
    list: async () => {
      state.lists += 1;
      const gate = state.listGate;
      state.listGate = null;
      if (gate) {
        state.listEntered.resolve();
        await gate;
      }
      check();
      return [...state.rows];
    },
    save: async (intent) => { check(); state.rows = [...state.rows.filter((row) => !same(row, intent)), intent]; },
    remove: async (intent) => { check(); state.rows = state.rows.filter((row) => !same(row, intent)); },
  };
  return { state, store };
}

/** A workspace where the wake's message, thread, and agent all allow it. */
function readyWorkspace(over: Partial<ChatWakeWorkspace> = {}): ChatWakeWorkspace {
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
    ...over,
  };
}

/** Records each publish and withdrawal, and whether that account's reader had stopped by then. */
function fakeRoster(relay: ReturnType<typeof fakeRelay>) {
  const calls: Array<{ kind: "reconcile" | "withdraw"; scope: string; readerStopped: boolean }> = [];
  const watchers: Array<{ at: number; resolve: () => void }> = [];
  let withdrawal: Promise<void> = Promise.resolve();
  const record = (kind: "reconcile" | "withdraw", wakeSession: ChatWakeSession) => {
    calls.push({ kind, scope: wakeSession.account.scope, readerStopped: relay.aborted.includes(wakeSession.account.scope) });
    for (const watcher of [...watchers]) {
      if (calls.length < watcher.at) continue;
      watchers.splice(watchers.indexOf(watcher), 1);
      watcher.resolve();
    }
  };
  const roster = {
    reconcile: async (wakeSession: ChatWakeSession) => { record("reconcile", wakeSession); },
    withdraw: (wakeSession: ChatWakeSession) => {
      record("withdraw", wakeSession);
      return withdrawal;
    },
    stop: vi.fn(async () => undefined),
  } satisfies ChatRunnerRoster;
  return {
    calls, roster,
    untilCalls: (at: number) => calls.length >= at ? Promise.resolve()
      : new Promise<void>((resolve) => { watchers.push({ at, resolve }); }),
    /** Withdrawals from now on never answer, as when the server hangs. */
    hangWithdrawals: () => { withdrawal = new Promise<void>(() => undefined); },
  };
}

function setup(over: Partial<ChatWakeLifetimeDeps> = {}, rows: ChatWakeIntent[] = []) {
  const relay = fakeRelay();
  const intents = memoryIntents(rows);
  const roster = fakeRoster(relay);
  const deps: ChatWakeLifetimeDeps = {
    on: true,
    intents: intents.store,
    roster: roster.roster,
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
  return { relay, intents, roster, deps, lifetime: createChatWakeLifetime(deps) };
}

const NOTHING_NEW = { applied: false, recovered: false } as const;
const APPLIED = { applied: true, recovered: false } as const;

describe("the chat wake lifetime", () => {
  it("starts nothing while chat wakes are off", async () => {
    const w = setup({ on: false });
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    // The start transition has run.
    await turn();
    expect(w.deps.client).not.toHaveBeenCalled();
    expect(w.intents.state.lists).toBe(0);
    await w.lifetime.runnersChanged();
    await w.lifetime.stop();
    expect(w.roster.calls).toEqual([]);
  });

  it("reads only from startup, with no window or focus, and once per snapshot", async () => {
    const w = setup();
    const a = session("A");
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.resume();
    await turn();
    expect(w.deps.client).not.toHaveBeenCalled();
    w.lifetime.start();
    await w.relay.untilReads(1);
    // The same snapshot again changes nothing.
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    await turn();
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
    // A's recovery is inside the intent file.
    await w.intents.state.listEntered.promise;
    expect(w.deps.client).toHaveBeenCalledExactlyOnceWith(a);
    const b = session("B");
    a.end();
    w.lifetime.credentialsChanged(b, true);
    await turn();
    // B waits for A's stop, which waits for A's recovery.
    expect(w.deps.client).toHaveBeenCalledOnce();
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
    const logged = deferred<void>();
    const w = setup({ log: vi.fn(() => logged.resolve()) });
    w.lifetime.credentialsChanged(session("A", "x".repeat(257)), true);
    w.lifetime.start();
    await logged.promise;
    await w.lifetime.stop();
    expect(w.deps.client).not.toHaveBeenCalled();
    expect(w.deps.log).toHaveBeenCalledOnce();
  });

  it("resumes after a pull only when it brought changes or reached the relay again", async () => {
    let arrived = false;
    let syncs = 0;
    const workspace = readyWorkspace({
      requestSync: () => { syncs += 1; },
      message: async () => arrived
        ? { id: "m1", workspaceId: "ws", threadId: "t1", author: { kind: "human", displayName: "Ana" }, authorUserId: "ana" }
        : null,
    });
    const w = setup({ openWorkspace: vi.fn(async () => workspace) });
    w.relay.pages.push({ cursor: 1, wakes: [waiting] });
    w.relay.winClaims();
    w.relay.confirms.push(async () => view("queued"));
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    // The wake came before its message: it asked for one pull and waits.
    await w.relay.untilReads(1);
    expect(syncs).toBe(1);
    // That pull came back empty: nothing to check again, so no second pull.
    await w.lifetime.pulled(NOTHING_NEW);
    expect(syncs).toBe(1);
    // Reaching the relay again is worth another look.
    await w.lifetime.pulled({ applied: false, recovered: true });
    expect(syncs).toBe(2);
    expect(w.relay.claims).toEqual([]);
    arrived = true;
    await w.lifetime.pulled(APPLIED);
    expect(w.relay.claims).toEqual(["A"]);
    expect(syncs).toBe(2);
    expect(w.intents.state.rows).toEqual([]);
    await w.lifetime.stop();
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
    await w.relay.untilReads(1);
    w.lifetime.credentialsChanged(null, false);
    // The placeholder stopped A's reader.
    await w.relay.untilAborted(1);
    w.lifetime.credentialsChanged(session("A"), true);
    await w.relay.untilReads(2);
    await w.lifetime.stop();
    expect(w.deps.clear).not.toHaveBeenCalled();
  });

  it("takes rows back at a settled sign-out", async () => {
    const reported = deferred<void>();
    const cleared = deferred<void>();
    const w = setup({
      report: vi.fn(() => reported.resolve()), clear: vi.fn(() => cleared.resolve()),
      openWorkspace: vi.fn(async () => readyWorkspace()),
    }, [intentOf("claim-pending")]);
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await reported.promise;
    await w.relay.untilReads(1);
    w.lifetime.credentialsChanged(null, true);
    await cleared.promise;
    expect(w.deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "dropped");
    await w.lifetime.stop();
  });

  it("takes rows back when another account signs in", async () => {
    const reported = deferred<void>();
    const cleared = deferred<void>();
    const w = setup({
      report: vi.fn(() => reported.resolve()), clear: vi.fn(() => cleared.resolve()),
      openWorkspace: vi.fn(async () => readyWorkspace()),
    }, [intentOf("claim-pending")]);
    const a = session("A");
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    await reported.promise;
    await w.relay.untilReads(1);
    a.end();
    w.lifetime.credentialsChanged(session("B"), true);
    await cleared.promise;
    await w.relay.untilReads(2);
    expect(w.relay.reads).toEqual(["A", "B"]);
    expect(w.deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "dropped");
    await w.lifetime.stop();
  });

  it("reports an unreadable intent file, and Try again takes it back once the file reads", async () => {
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

  it("shows an unreadable file in a workspace that starts syncing after the first failure, once", async () => {
    let workspaces: string[] = [];
    const shown = vi.fn();
    const takenBack = vi.fn();
    const notices = createChatWakeNotices({
      file: "/state/chat-wakes.json", workspaces: () => workspaces, report: shown, clear: takenBack, log: vi.fn(),
    });
    const w = setup({ report: notices.report, clear: notices.clear });
    w.intents.state.unreadable = true;
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await w.relay.untilReads(1);
    // No synced workspace yet, so no row anywhere.
    expect(shown).not.toHaveBeenCalled();
    workspaces = ["ws"];
    await w.lifetime.pulled(APPLIED);
    expect(shown).toHaveBeenCalledExactlyOnceWith("ws", expect.objectContaining({ reason: "wake-unreadable", file: "/state/chat-wakes.json" }));
    await w.lifetime.pulled(APPLIED);
    expect(shown).toHaveBeenCalledOnce();
    w.intents.state.unreadable = false;
    await w.lifetime.pulled(APPLIED);
    expect(takenBack).toHaveBeenCalledExactlyOnceWith("ws", "wake-unreadable");
    await w.lifetime.stop();
  });

  it("offers a row again after its report failed, and takes it back once the wake is recorded and confirmed", async () => {
    const tried = deferred<void>();
    let workspace: ChatWakeWorkspace | null = null;
    const failure = new Error("The window could not take the row.");
    const report = vi.fn<ChatWakeLifetimeDeps["report"]>()
      .mockImplementationOnce(() => { tried.resolve(); throw failure; });
    const w = setup({ report, openWorkspace: vi.fn(async () => workspace) }, [intentOf("won")]);
    w.relay.confirms.push(async () => view("queued"));
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await tried.promise;
    await w.relay.untilReads(1);
    expect(w.deps.log).toHaveBeenCalledWith(failure);
    await w.lifetime.pulled(APPLIED);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenLastCalledWith("ws", "parked", intentOf("won"));
    // Shown now, so a later pass doesn't show it again.
    await w.lifetime.pulled(APPLIED);
    expect(report).toHaveBeenCalledTimes(2);
    workspace = readyWorkspace();
    await w.lifetime.pulled(APPLIED);
    expect(w.deps.clear).toHaveBeenCalledExactlyOnceWith("ws", "parked");
    expect(w.intents.state.rows).toEqual([]);
    await w.lifetime.stop();
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

describe("publishing and withdrawing this computer's agents", () => {
  const reconcile = (scope: string) => ({ kind: "reconcile", scope, readerStopped: false });
  const withdraw = (scope: string) => ({ kind: "withdraw", scope, readerStopped: true });

  it("publishes for the running session only, from startup and on each change", async () => {
    const w = setup();
    const a = session("A");
    w.lifetime.credentialsChanged(a, true);
    await w.lifetime.runnersChanged();
    await turn();
    expect(w.roster.calls).toEqual([]);
    w.lifetime.start();
    await w.roster.untilCalls(1);
    await w.lifetime.runnersChanged();
    // Reaching the relay again is when a declaration that failed can go out.
    await w.lifetime.pulled({ applied: false, recovered: true });
    await w.lifetime.pulled(APPLIED);
    expect(w.roster.calls).toEqual([reconcile("A"), reconcile("A"), reconcile("A")]);
    await w.lifetime.stop();
  });

  it("withdraws an account that another one replaced after its reader stops, and before the next account publishes", async () => {
    const w = setup();
    const a = session("A");
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    await w.relay.untilReads(1);
    a.end();
    w.lifetime.credentialsChanged(session("B"), true);
    await w.roster.untilCalls(3);
    expect(w.roster.calls).toEqual([reconcile("A"), withdraw("A"), reconcile("B")]);
    await w.lifetime.stop();
  });

  it("stops the reader at once at sign-out, withdraws without holding up the next sign-in, and withdraws again for nobody", async () => {
    const w = setup();
    const a = session("A");
    w.roster.hangWithdrawals();
    w.lifetime.credentialsChanged(a, true);
    w.lifetime.start();
    await w.relay.untilReads(1);
    a.end();
    w.lifetime.credentialsChanged(null, true);
    await w.roster.untilCalls(2);
    expect(w.roster.calls).toEqual([reconcile("A"), withdraw("A")]);
    expect(w.relay.aborted).toEqual(["A"]);
    // The withdrawal never answers, and the next account still starts.
    w.lifetime.credentialsChanged(session("B"), true);
    await w.relay.untilReads(2);
    await w.roster.untilCalls(3);
    expect(w.roster.calls.at(-1)).toEqual(reconcile("B"));
    await w.lifetime.stop();
    expect(w.roster.calls.filter((call) => call.kind === "withdraw")).toHaveLength(1);
  });

  it("withdraws nothing for a credential load's placeholder, a new token for the same account, or quit", async () => {
    const w = setup();
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await w.relay.untilReads(1);
    w.lifetime.credentialsChanged(null, false);
    await w.relay.untilAborted(1);
    w.lifetime.credentialsChanged(session("A"), true);
    await w.relay.untilReads(2);
    w.lifetime.credentialsChanged(session("A"), true);
    await w.relay.untilReads(3);
    await w.lifetime.stop();
    expect(w.roster.calls).toEqual([reconcile("A"), reconcile("A"), reconcile("A")]);
    expect(w.roster.roster.stop).toHaveBeenCalled();
  });

  it("withdraws the account a placeholder ended once another account settles", async () => {
    const w = setup();
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await w.relay.untilReads(1);
    w.lifetime.credentialsChanged(null, false);
    await w.relay.untilAborted(1);
    w.lifetime.credentialsChanged(session("B"), true);
    await w.roster.untilCalls(3);
    expect(w.roster.calls).toEqual([reconcile("A"), withdraw("A"), reconcile("B")]);
    await w.lifetime.stop();
  });
});

describe("Try again", () => {
  it("restarts once for presses made before the restart begins, and keeps a dropped wake's row", async () => {
    const reported = deferred<void>();
    const w = setup({ report: vi.fn(() => reported.resolve()), openWorkspace: vi.fn(async () => readyWorkspace()) }, [intentOf("claim-pending")]);
    w.lifetime.credentialsChanged(session("A"), true);
    w.lifetime.start();
    await reported.promise;
    await w.relay.untilReads(1);
    w.lifetime.retry();
    w.lifetime.retry();
    await w.relay.untilReads(2);
    await turn();
    expect(w.deps.client).toHaveBeenCalledTimes(2);
    expect(w.deps.clear).not.toHaveBeenCalled();
    await w.lifetime.stop();
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
