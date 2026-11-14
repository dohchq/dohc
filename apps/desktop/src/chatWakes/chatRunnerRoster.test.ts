import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRunnerDeclaration } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import type { Agent } from "../settings/userSettings";
import { deferred } from "../testing/deferred";
import { ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import {
  ChatRunnerLedgerUnreadableError,
  type ChatRunnerLedger,
  type ChatRunnerLedgerEntry,
} from "./chatRunnerLedger";
import {
  CHAT_RUNNER_CHECK_MS,
  CHAT_RUNNER_REFRESH_MS,
  CHAT_RUNNER_WITHDRAW_MS,
  createChatRunnerRoster,
  type ChatRunnerRosterDeps,
} from "./chatRunnerRoster";
import { sleepUnlessAborted, type ChatWakeSession } from "./chatWakeLifetime";

// The server, the ledger, and settings are fakes. A held or hanging PUT waits
// on a gate or its signal, never on time.

type AgentRow = Pick<Agent, "id" | "name" | "enabled" | "launch">;
const runner = (over: Partial<AgentRow> = {}): AgentRow => ({
  id: "default",
  name: "Claude",
  enabled: true,
  launch: { command: "agent run" },
  ...over,
});

function session(scope: string) {
  let current = true;
  const value = {
    account: { scope, userId: `user-${scope}`, installId: "mac" },
    relay: { baseUrl: "https://relay.test", token: `token-${scope}` },
    isCurrent: () => current,
    unauthorized: vi.fn(() => {
      current = false;
    }),
    end: () => {
      current = false;
    },
  } satisfies ChatWakeSession & { end(): void };
  return value;
}

type Put = { scope: string; workspaceId: string; declaration: ChatRunnerDeclaration };
type Behavior = (put: Put, signal: AbortSignal) => Promise<void>;

/** The server's runner rows by account and workspace. Each PUT takes the next queued behavior, if any. */
function fakeServer() {
  const puts: Put[] = [];
  const putTimes: number[] = [];
  const putSessions: ChatWakeSession[] = [];
  const putCurrent: boolean[] = [];
  const rows = new Map<string, ChatRunnerDeclaration["runners"]>();
  const behaviors: Behavior[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  // PUTs the server answered with success, and who waits for a count of them.
  let done = 0;
  const watchers: Array<{ at: number; resolve: () => void }> = [];
  const client = (wakeSession: ChatWakeSession): ChatWakeClient => ({
    async replaceRunners(workspaceId, declaration, signal) {
      const put = { scope: wakeSession.account.scope, workspaceId, declaration };
      puts.push(put);
      putTimes.push(Date.now());
      putSessions.push(wakeSession);
      putCurrent.push(wakeSession.isCurrent());
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        await behaviors.shift()?.(put, signal);
        rows.set(JSON.stringify([put.scope, workspaceId]), declaration.runners);
        done += 1;
        for (const watcher of [...watchers]) {
          if (done < watcher.at) continue;
          watchers.splice(watchers.indexOf(watcher), 1);
          watcher.resolve();
        }
      } finally {
        inFlight -= 1;
      }
    },
    waitWakes: async () => {
      throw new Error("The roster never reads wakes.");
    },
    claimWake: async () => {
      throw new Error("The roster never claims.");
    },
    confirmQueued: async () => {
      throw new Error("The roster never confirms.");
    },
  });
  return {
    puts,
    putTimes,
    putSessions,
    putCurrent,
    rows,
    behaviors,
    client,
    mostInFlight: () => mostInFlight,
    /** Resolves once `count` PUTs have succeeded. */
    untilDone: (count: number) =>
      done >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            watchers.push({ at: count, resolve });
          }),
    row: (scope: string, workspaceId: string) => rows.get(JSON.stringify([scope, workspaceId])),
    /** The next PUT waits until `release`, and resolves `entered` once it is in flight. */
    hold() {
      const entered = deferred<void>();
      const release = deferred<void>();
      behaviors.push(async () => {
        entered.resolve();
        await release.promise;
      });
      return { entered, release };
    },
    /** The next PUT never answers: it ends only when its signal aborts. */
    hang() {
      const entered = deferred<void>();
      behaviors.push((_put, signal) => {
        entered.resolve();
        return new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      });
      return entered;
    },
    refuse(error: Error) {
      behaviors.push(async () => {
        throw error;
      });
    },
  };
}

function memoryLedger(rows: ChatRunnerLedgerEntry[] = []) {
  const state = {
    rows,
    listFails: null as { error: Error; once: boolean } | null,
    removeFailsOnce: false,
    addFailsOnce: false,
    removed: deferred<void>(),
  };
  const same = (a: ChatRunnerLedgerEntry, b: ChatRunnerLedgerEntry) =>
    a.account === b.account && a.installId === b.installId && a.workspaceId === b.workspaceId;
  const ledger: ChatRunnerLedger = {
    list: async () => {
      const failure = state.listFails;
      if (failure) {
        if (failure.once) state.listFails = null;
        throw failure.error;
      }
      return [...state.rows];
    },
    add: async (entry) => {
      if (state.addFailsOnce) {
        state.addFailsOnce = false;
        throw new Error("The ledger could not be read just now.");
      }
      if (!state.rows.some((row) => same(row, entry))) state.rows = [...state.rows, entry];
    },
    remove: async (entry) => {
      if (state.removeFailsOnce) {
        state.removeFailsOnce = false;
        throw new Error("The ledger could not be written just now.");
      }
      state.rows = state.rows.filter((row) => !same(row, entry));
      state.removed.resolve();
    },
  };
  return { state, ledger };
}

function heldSleeps() {
  const sleeps: Array<{ ms: number; signal: AbortSignal; release: () => void }> = [];
  const watchers: Array<{ at: number; resolve: () => void }> = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      sleeps.push({ ms, signal, release: resolve });
      for (const watcher of [...watchers]) {
        if (sleeps.length < watcher.at) continue;
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
    });
  return {
    sleeps,
    sleep,
    until: (count: number) =>
      sleeps.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            watchers.push({ at: count, resolve });
          }),
  };
}

function setup(over: Partial<ChatRunnerRosterDeps> = {}) {
  const server = fakeServer();
  const ledger = memoryLedger();
  const owned: Record<string, string[]> = { A: ["ws1", "ws2"] };
  let agents: AgentRow[] = [runner(), { id: "mine", name: "Mine", enabled: true }];
  const deadline = new AbortController();
  const deps: ChatRunnerRosterDeps = {
    ledger: ledger.ledger,
    client: vi.fn(server.client),
    workspaces: (wakeSession) => owned[wakeSession.account.scope] ?? [],
    agents: async () => agents,
    computerLabel: () => "Mac",
    // A retry waits until the roster stops, unless a test passes its own.
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    // The hourly due check waits until the roster stops, unless a test passes its own.
    refreshSleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    nowMs: () => Date.now(),
    backoffMs: (failures) => 1_000 * failures,
    timeout: vi.fn(() => deadline.signal),
    refused: vi.fn(),
    accepted: vi.fn(),
    ledgerUnreadable: vi.fn(),
    clearLedgerUnreadable: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  return {
    server,
    ledger,
    owned,
    deps,
    deadline,
    roster: createChatRunnerRoster(deps),
    setAgents: (next: AgentRow[]) => {
      agents = next;
    },
  };
}

const declared = (runners: ChatRunnerDeclaration["runners"]): ChatRunnerDeclaration => ({
  installId: "mac",
  computerLabel: "Mac",
  runners,
});
const CLAUDE_ON = [{ agentId: "default", displayName: "Claude", enabled: true }];
const CLAUDE_OFF = [{ agentId: "default", displayName: "Claude", enabled: false }];

describe("publishing this computer's agents", () => {
  it("declares each agent dohc starts in every synced workspace, open or not, and nothing again until it changes", async () => {
    const r = setup();
    const a = session("A");
    await r.roster.reconcile(a);
    expect(r.server.puts).toEqual([
      { scope: "A", workspaceId: "ws1", declaration: declared(CLAUDE_ON) },
      { scope: "A", workspaceId: "ws2", declaration: declared(CLAUDE_ON) },
    ]);
    expect(r.ledger.state.rows).toEqual([
      { account: "A", installId: "mac", workspaceId: "ws1" },
      { account: "A", installId: "mac", workspaceId: "ws2" },
    ]);
    await r.roster.reconcile(a);
    expect(r.server.puts).toHaveLength(2);
    expect(r.deps.log).not.toHaveBeenCalled();
  });

  it("keeps a last agent switched off declared as off, and withdraws it once removed", async () => {
    const r = setup();
    r.owned.A = ["ws1"];
    const a = session("A");
    await r.roster.reconcile(a);
    r.setAgents([runner({ enabled: false })]);
    await r.roster.reconcile(a);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_OFF);
    r.setAgents([]);
    await r.roster.reconcile(a);
    expect(r.server.row("A", "ws1")).toEqual([]);
    expect(r.ledger.state.rows).toEqual([]);
  });

  it("declares nothing where it has nothing to declare and nothing to take back", async () => {
    const r = setup();
    r.setAgents([{ id: "mine", name: "Mine", enabled: true }]);
    await r.roster.reconcile(session("A"));
    expect(r.server.puts).toEqual([]);
  });

  it("never lets an older declaration land after a newer one, and shares one pass between calls made before it starts", async () => {
    const r = setup();
    r.owned.A = ["ws1"];
    const a = session("A");
    const held = r.server.hold();
    const first = r.roster.reconcile(a);
    await held.entered.promise;
    r.setAgents([runner({ enabled: false })]);
    const second = r.roster.reconcile(a);
    const third = r.roster.reconcile(a);
    expect(third).toBe(second);
    held.release.resolve();
    await Promise.all([first, second]);
    expect(r.server.puts.map((put) => put.declaration.runners)).toEqual([CLAUDE_ON, CLAUDE_OFF]);
    expect(r.server.mostInFlight()).toBe(1);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_OFF);
  });

  it.each([
    ["paused", ["ws1"]],
    ["removed", ["ws1"]],
  ] as const)("withdraws its agents from a workspace %s here", async (_how, left) => {
    const r = setup();
    const a = session("A");
    await r.roster.reconcile(a);
    r.owned.A = [...left];
    await r.roster.reconcile(a);
    expect(r.server.puts.at(-1)).toEqual({
      scope: "A",
      workspaceId: "ws2",
      declaration: declared([]),
    });
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
    expect(r.ledger.state.rows).toEqual([{ account: "A", installId: "mac", workspaceId: "ws1" }]);
  });

  it("is quiet when the server has no wake routes, and asks again on the next reconciliation", async () => {
    const r = setup();
    r.owned.A = ["ws1"];
    const a = session("A");
    r.server.refuse(new ChatWakeMissingError());
    await r.roster.reconcile(a);
    expect(r.deps.log).not.toHaveBeenCalled();
    expect(r.deps.refused).not.toHaveBeenCalled();
    expect(r.server.row("A", "ws1")).toBeUndefined();
    await r.roster.reconcile(a);
    expect(r.server.puts).toHaveLength(2);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
  });

  it("tries a busy server again by itself after a backoff, quietly", async () => {
    const backoffs = heldSleeps();
    const r = setup({ sleep: backoffs.sleep });
    r.owned.A = ["ws1"];
    const a = session("A");
    r.server.refuse(new ChatWakeBusyError());
    await r.roster.reconcile(a);
    await backoffs.until(1);
    expect(r.deps.log).not.toHaveBeenCalled();
    backoffs.sleeps[0]!.release();
    // No other call: the backoff's own pass sends it.
    await r.server.untilDone(1);
    expect(r.server.puts).toHaveLength(2);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
  });

  it.each([
    ["a new token for the same account", "A"],
    ["another account", "B"],
  ] as const)(
    "retries for %s even while an older session's backoff sleeps",
    async (_case, scope) => {
      const backoffs = heldSleeps();
      const r = setup({ sleep: backoffs.sleep });
      r.owned.A = ["ws1"];
      r.owned.B = ["ws1"];
      const a = session("A");
      r.server.refuse(new ChatWakeBusyError());
      await r.roster.reconcile(a);
      await backoffs.until(1);
      a.end();
      const next = session(scope);
      r.server.refuse(new ChatWakeBusyError());
      await r.roster.reconcile(next);
      await backoffs.until(2);
      expect(backoffs.sleeps[0]!.signal.aborted).toBe(true);
      expect(backoffs.sleeps[1]!.ms).toBe(1_000);
      backoffs.sleeps[0]!.release();
      backoffs.sleeps[1]!.release();
      await r.server.untilDone(1);
      expect(r.server.puts.at(-1)).toEqual({
        scope,
        workspaceId: "ws1",
        declaration: declared(CLAUDE_ON),
      });
      expect(r.deps.client).toHaveBeenLastCalledWith(next);
    },
  );

  it("retries a pass whose ledger read failed once, by itself", async () => {
    const backoffs = heldSleeps();
    const r = setup({ sleep: backoffs.sleep });
    r.owned.A = ["ws1"];
    r.ledger.state.listFails = { error: new Error("The disk is busy."), once: true };
    await r.roster.reconcile(session("A"));
    expect(r.server.puts).toEqual([]);
    await backoffs.until(1);
    backoffs.sleeps[0]!.release();
    await r.server.untilDone(1);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
    expect(r.deps.ledgerUnreadable).not.toHaveBeenCalled();
  });

  it("shows an unreadable ledger, declares and withdraws nothing, and recovers once it is repaired and tried again", async () => {
    const backoffs = heldSleeps();
    const r = setup({ sleep: backoffs.sleep });
    r.owned.A = ["ws1"];
    const a = session("A");
    r.ledger.state.listFails = { error: new ChatRunnerLedgerUnreadableError(), once: false };
    await r.roster.reconcile(a);
    expect(r.deps.ledgerUnreadable).toHaveBeenCalledOnce();
    expect(r.deps.log).not.toHaveBeenCalled();
    await backoffs.until(1);
    backoffs.sleeps[0]!.release();
    await backoffs.until(2);
    expect(r.deps.ledgerUnreadable).toHaveBeenCalledTimes(2);
    expect(r.server.puts).toEqual([]);
    expect(r.ledger.state.rows).toEqual([]);
    r.ledger.state.listFails = null;
    await r.roster.reconcile(a);
    expect(r.deps.clearLedgerUnreadable).toHaveBeenCalled();
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
    expect(backoffs.sleeps[1]!.signal.aborted).toBe(true);
  });

  it("finishes removing a withdrawn workspace from the ledger after the first removal failed", async () => {
    const backoffs = heldSleeps();
    const r = setup({ sleep: backoffs.sleep });
    r.owned.A = ["ws1"];
    const a = session("A");
    await r.roster.reconcile(a);
    r.setAgents([]);
    r.ledger.state.removeFailsOnce = true;
    await r.roster.reconcile(a);
    expect(r.server.row("A", "ws1")).toEqual([]);
    expect(r.ledger.state.rows).toEqual([{ account: "A", installId: "mac", workspaceId: "ws1" }]);
    await backoffs.until(1);
    backoffs.sleeps[0]!.release();
    await r.ledger.state.removed.promise;
    expect(r.ledger.state.rows).toEqual([]);
    // The server's confirmed withdrawal wasn't sent again.
    expect(r.server.puts).toHaveLength(2);
  });

  it("ends the session whose declaration got a 401", async () => {
    const r = setup();
    const a = session("A");
    r.server.refuse(new RelayUnauthorizedError());
    await r.roster.reconcile(a);
    expect(a.unauthorized).toHaveBeenCalledOnce();
    // The session is over, so nothing more goes out for it.
    expect(r.server.puts).toHaveLength(1);
  });

  it("files one row in each workspace for a refusal, withdraws what was declared, and takes the rows back once it is fixed", async () => {
    const r = setup();
    const a = session("A");
    await r.roster.reconcile(a);
    const many = Array.from({ length: 65 }, (_, index) =>
      runner({ id: `agent-${index}`, name: `Agent ${index}` }),
    );
    r.setAgents(many);
    await r.roster.reconcile(a);
    expect(r.deps.refused).toHaveBeenCalledTimes(2);
    expect(r.deps.refused).toHaveBeenCalledWith(
      "ws1",
      expect.objectContaining({ reason: "too-many-agents" }),
    );
    expect(r.server.row("A", "ws1")).toEqual([]);
    expect(r.server.row("A", "ws2")).toEqual([]);
    await r.roster.reconcile(a);
    expect(r.deps.refused).toHaveBeenCalledTimes(2);
    r.setAgents([runner()]);
    await r.roster.reconcile(a);
    expect((r.deps.accepted as ReturnType<typeof vi.fn>).mock.calls).toEqual([["ws1"], ["ws2"]]);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
  });

  it("takes a refusal row back when its workspace stops syncing here", async () => {
    const r = setup();
    const a = session("A");
    r.setAgents(
      Array.from({ length: 65 }, (_, index) =>
        runner({ id: `agent-${index}`, name: `Agent ${index}` }),
      ),
    );
    await r.roster.reconcile(a);
    r.owned.A = ["ws1"];
    await r.roster.reconcile(a);
    expect(r.deps.accepted).toHaveBeenCalledExactlyOnceWith("ws2");
  });

  it("publishes nothing for a session that is no longer current, or after stop", async () => {
    const r = setup();
    const a = session("A");
    a.end();
    await r.roster.reconcile(a);
    const b = session("A");
    await r.roster.stop();
    await r.roster.reconcile(b);
    expect(r.server.puts).toEqual([]);
  });
});

describe("withdrawing an account that left", () => {
  it("withdraws with the leaving account's own token, before the next account publishes", async () => {
    const r = setup();
    r.owned.B = ["ws9"];
    const a = session("A");
    await r.roster.reconcile(a);
    a.end();
    const b = session("B");
    const withdrawn = r.roster.withdraw(a);
    const published = r.roster.reconcile(b);
    await Promise.all([withdrawn, published]);
    expect(r.server.puts.slice(2)).toEqual([
      { scope: "A", workspaceId: "ws1", declaration: declared([]) },
      { scope: "A", workspaceId: "ws2", declaration: declared([]) },
      { scope: "B", workspaceId: "ws9", declaration: declared(CLAUDE_ON) },
    ]);
    expect(r.deps.client).toHaveBeenNthCalledWith(2, a);
    expect(r.deps.client).toHaveBeenLastCalledWith(b);
    expect(r.ledger.state.rows).toEqual([{ account: "B", installId: "mac", workspaceId: "ws9" }]);
  });

  it("bounds a withdrawal the server never answers, keeps it for that account's next sign-in, and lets the next account publish", async () => {
    const r = setup();
    r.owned.A = ["ws1"];
    r.owned.B = ["ws9"];
    const a = session("A");
    await r.roster.reconcile(a);
    a.end();
    const entered = r.server.hang();
    const withdrawn = r.roster.withdraw(a);
    const b = session("B");
    const published = r.roster.reconcile(b);
    await entered.promise;
    expect(r.deps.timeout).toHaveBeenCalledExactlyOnceWith(CHAT_RUNNER_WITHDRAW_MS);
    expect(r.server.puts.map((put) => put.scope)).toEqual(["A", "A"]);
    r.deadline.abort();
    await Promise.all([withdrawn, published]);
    expect(r.server.row("B", "ws9")).toEqual(CLAUDE_ON);
    expect(r.ledger.state.rows).toEqual([
      { account: "A", installId: "mac", workspaceId: "ws1" },
      { account: "B", installId: "mac", workspaceId: "ws9" },
    ]);
    // The same account signs in again here, with that workspace no longer synced: the old declaration goes first.
    r.owned.A = [];
    await r.roster.reconcile(session("A"));
    expect(r.server.row("A", "ws1")).toEqual([]);
    expect(r.ledger.state.rows).toEqual([{ account: "B", installId: "mac", workspaceId: "ws9" }]);
  });

  it("forgets a withdrawal the server holds nothing for", async () => {
    const r = setup();
    r.owned.A = ["ws1"];
    const a = session("A");
    await r.roster.reconcile(a);
    r.server.refuse(new ChatWakeMissingError());
    await r.roster.withdraw(a);
    expect(r.ledger.state.rows).toEqual([]);
  });

  it("takes back the leaving account's refusal rows", async () => {
    const r = setup();
    r.owned.A = ["ws1"];
    const a = session("A");
    r.setAgents(
      Array.from({ length: 65 }, (_, index) =>
        runner({ id: `agent-${index}`, name: `Agent ${index}` }),
      ),
    );
    await r.roster.reconcile(a);
    await r.roster.withdraw(a);
    expect(r.deps.accepted).toHaveBeenCalledExactlyOnceWith("ws1");
  });
});

function countedSleep() {
  let started = 0;
  const watchers: Array<{ at: number; resolve: () => void }> = [];
  return {
    sleep: (ms: number, signal: AbortSignal) => {
      started += 1;
      for (const watcher of [...watchers]) {
        if (started < watcher.at) continue;
        watchers.splice(watchers.indexOf(watcher), 1);
        watcher.resolve();
      }
      return sleepUnlessAborted(ms, signal);
    },
    /** Resolves once `count` waits have started, so their timers are on the clock. */
    until: (count: number) =>
      started >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            watchers.push({ at: count, resolve });
          }),
  };
}

describe("keeping the relay's lease", () => {
  const HOUR = 60 * 60 * 1000;
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a confirmed declaration again once it is a day old, past what the server confirmed, and not before", async () => {
    vi.useFakeTimers();
    const checks = countedSleep();
    const r = setup({ refreshSleep: checks.sleep });
    const a = session("A");
    await r.roster.reconcile(a);
    expect(r.server.puts).toHaveLength(2);
    await checks.until(1);
    await vi.advanceTimersByTimeAsync(CHAT_RUNNER_REFRESH_MS - CHAT_RUNNER_CHECK_MS);
    await r.roster.reconcile(a);
    expect(r.server.puts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CHAT_RUNNER_CHECK_MS);
    await r.server.untilDone(4);
    // The same declarations again: the relay starts each lease again.
    expect(r.server.puts.slice(2)).toEqual(r.server.puts.slice(0, 2));
    a.end();
    await vi.advanceTimersByTimeAsync(2 * CHAT_RUNNER_REFRESH_MS);
    expect(r.server.puts).toHaveLength(4);
    await r.roster.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews within the lease across same-account session replacements, each time with the session current then", async () => {
    vi.useFakeTimers();
    const checks = countedSleep();
    const r = setup({ refreshSleep: checks.sleep });
    r.owned.A = ["ws1"];
    const started = Date.now();
    const sessions = [session("A")];
    await r.roster.reconcile(sessions[0]!);
    await checks.until(1);
    // A credential reload every 20 hours, as opening a shared view does: a new session for the same account each time.
    for (let index = 1; index <= 4; index += 1) {
      await vi.advanceTimersByTimeAsync(20 * HOUR);
      sessions.at(-1)!.end();
      sessions.push(session("A"));
      await r.roster.reconcile(sessions.at(-1)!);
    }
    await r.server.untilDone(4);
    expect(r.server.putTimes.map((at) => at - started)).toEqual([
      0,
      24 * HOUR,
      48 * HOUR,
      72 * HOUR,
    ]);
    // By reference: the session replaced at 20 h renewed at 24 h, the next at 48 h, and so on.
    expect(r.server.putSessions.map((each) => sessions.findIndex((made) => made === each))).toEqual(
      [0, 1, 2, 3],
    );
    expect(r.server.putCurrent).toEqual([true, true, true, true]);
    await r.roster.stop();
  });

  it("keeps a renewal due through a failed read and a failed ledger write before its PUT, and sends it on the retry", async () => {
    vi.useFakeTimers();
    const checks = countedSleep();
    const backoffs = countedSleep();
    const r = setup({ refreshSleep: checks.sleep, sleep: backoffs.sleep });
    r.owned.A = ["ws1"];
    await r.roster.reconcile(session("A"));
    await checks.until(1);
    r.ledger.state.listFails = { error: new Error("The disk is busy."), once: true };
    await vi.advanceTimersByTimeAsync(CHAT_RUNNER_REFRESH_MS);
    await backoffs.until(1);
    r.ledger.state.addFailsOnce = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await backoffs.until(2);
    expect(r.server.puts).toHaveLength(1);
    // The next retry sends it, with no other check and no other call.
    await vi.advanceTimersByTimeAsync(2_000);
    await r.server.untilDone(2);
    expect(r.server.putTimes[1]! - r.server.putTimes[0]!).toBe(CHAT_RUNNER_REFRESH_MS + 3_000);
    await r.roster.stop();
  });

  it("sends what is due when the computer wakes from a long sleep, and nothing when nothing is due", async () => {
    vi.useFakeTimers();
    const r = setup();
    r.owned.A = ["ws1"];
    await r.roster.reconcile(session("A"));
    await r.roster.check();
    expect(r.server.puts).toHaveLength(1);
    // Asleep for four days: the wall clock moved, and no timer did.
    vi.setSystemTime(Date.now() + 4 * 24 * HOUR);
    await r.roster.check();
    expect(r.server.puts).toHaveLength(2);
    expect(r.server.putTimes[1]! - r.server.putTimes[0]!).toBe(4 * 24 * HOUR);
    await r.roster.stop();
  });

  it("renews at once when the clock moves back past a confirmation, then waits a day again", async () => {
    vi.useFakeTimers();
    const r = setup();
    r.owned.A = ["ws1"];
    const a = session("A");
    vi.setSystemTime(Date.now() + 4 * 24 * HOUR);
    await r.roster.reconcile(a);
    expect(r.server.puts).toHaveLength(1);
    // The clock is corrected; no timer has moved.
    vi.setSystemTime(Date.now() - 4 * 24 * HOUR);
    await r.roster.check();
    expect(r.server.puts).toHaveLength(2);
    expect(r.server.putSessions[1]).toBe(a);
    await r.roster.check();
    expect(r.server.puts).toHaveLength(2);
    vi.setSystemTime(Date.now() + CHAT_RUNNER_REFRESH_MS);
    await r.roster.check();
    expect(r.server.puts).toHaveLength(3);
    await r.roster.stop();
  });

  it("retries a renewal the server was too busy for, with the same backoff", async () => {
    vi.useFakeTimers();
    const checks = countedSleep();
    const backoffs = countedSleep();
    const r = setup({ refreshSleep: checks.sleep, sleep: backoffs.sleep });
    r.owned.A = ["ws1"];
    await r.roster.reconcile(session("A"));
    r.server.refuse(new ChatWakeBusyError());
    await checks.until(1);
    await vi.advanceTimersByTimeAsync(CHAT_RUNNER_REFRESH_MS);
    await backoffs.until(1);
    expect(r.server.puts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await r.server.untilDone(2);
    expect(r.server.puts).toHaveLength(3);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
    await r.roster.stop();
  });

  it("renews nothing for an account that was withdrawn, and the next account's own", async () => {
    vi.useFakeTimers();
    const checks = countedSleep();
    const r = setup({ refreshSleep: checks.sleep });
    r.owned.B = ["ws9"];
    const a = session("A");
    await r.roster.reconcile(a);
    a.end();
    await r.roster.withdraw(a);
    const b = session("B");
    await r.roster.reconcile(b);
    await checks.until(1);
    await vi.advanceTimersByTimeAsync(CHAT_RUNNER_REFRESH_MS);
    // A's two declarations, A's two withdrawals, B's declaration, and B's renewal.
    await r.server.untilDone(6);
    expect(r.server.puts.at(-1)).toEqual({
      scope: "B",
      workspaceId: "ws9",
      declaration: declared(CLAUDE_ON),
    });
    expect(r.server.puts.filter((put) => put.scope === "A")).toHaveLength(4);
    await r.roster.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("an unreadable ledger's row", () => {
  it("is taken back when its account leaves, though the file still can't be read", async () => {
    const r = setup();
    const a = session("A");
    r.ledger.state.listFails = { error: new ChatRunnerLedgerUnreadableError(), once: false };
    await r.roster.reconcile(a);
    expect(r.deps.ledgerUnreadable).toHaveBeenCalledOnce();
    expect(r.deps.clearLedgerUnreadable).not.toHaveBeenCalled();
    a.end();
    await r.roster.withdraw(a);
    expect(r.deps.clearLedgerUnreadable).toHaveBeenCalledOnce();
    expect(r.server.puts).toEqual([]);
  });
});
