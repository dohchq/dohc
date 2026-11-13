import { describe, expect, it, vi } from "vitest";
import type { ChatRunnerDeclaration } from "@dohc/workspace-contracts/chat-wakes";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import type { Agent } from "../settings/userSettings";
import { deferred } from "../testing/deferred";
import { ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient } from "./chatWakeClient";
import type { ChatRunnerLedger, ChatRunnerLedgerEntry } from "./chatRunnerLedger";
import { CHAT_RUNNER_WITHDRAW_MS, createChatRunnerRoster, type ChatRunnerRosterDeps } from "./chatRunnerRoster";
import type { ChatWakeSession } from "./chatWakeLifetime";

// The server, the ledger, and settings are fakes. A held or hanging PUT waits
// on a gate or its signal, never on time.

type AgentRow = Pick<Agent, "id" | "name" | "enabled" | "launch">;
const runner = (over: Partial<AgentRow> = {}): AgentRow =>
  ({ id: "default", name: "Claude", enabled: true, launch: { command: "agent run" }, ...over });

function session(scope: string) {
  let current = true;
  const value = {
    account: { scope, userId: `user-${scope}`, installId: "mac" },
    relay: { baseUrl: "https://relay.test", token: `token-${scope}` },
    isCurrent: () => current,
    unauthorized: vi.fn(() => { current = false; }),
    end: () => { current = false; },
  } satisfies ChatWakeSession & { end(): void };
  return value;
}

type Put = { scope: string; workspaceId: string; declaration: ChatRunnerDeclaration };
type Behavior = (put: Put, signal: AbortSignal) => Promise<void>;

/** The server's runner rows by account and workspace. Each PUT takes the next queued behavior, if any. */
function fakeServer() {
  const puts: Put[] = [];
  const rows = new Map<string, ChatRunnerDeclaration["runners"]>();
  const behaviors: Behavior[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const client = (wakeSession: ChatWakeSession): ChatWakeClient => ({
    async replaceRunners(workspaceId, declaration, signal) {
      const put = { scope: wakeSession.account.scope, workspaceId, declaration };
      puts.push(put);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        await behaviors.shift()?.(put, signal);
        rows.set(JSON.stringify([put.scope, workspaceId]), declaration.runners);
      } finally {
        inFlight -= 1;
      }
    },
    waitWakes: async () => { throw new Error("The roster never reads wakes."); },
    claimWake: async () => { throw new Error("The roster never claims."); },
    confirmQueued: async () => { throw new Error("The roster never confirms."); },
  });
  return {
    puts, rows, behaviors, client,
    mostInFlight: () => mostInFlight,
    row: (scope: string, workspaceId: string) => rows.get(JSON.stringify([scope, workspaceId])),
    /** The next PUT waits until `release`, and resolves `entered` once it is in flight. */
    hold() {
      const entered = deferred<void>();
      const release = deferred<void>();
      behaviors.push(async () => { entered.resolve(); await release.promise; });
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
      behaviors.push(async () => { throw error; });
    },
  };
}

function memoryLedger(rows: ChatRunnerLedgerEntry[] = []) {
  const state = { rows };
  const same = (a: ChatRunnerLedgerEntry, b: ChatRunnerLedgerEntry) =>
    a.account === b.account && a.installId === b.installId && a.workspaceId === b.workspaceId;
  const ledger: ChatRunnerLedger = {
    list: async () => [...state.rows],
    add: async (entry) => { if (!state.rows.some((row) => same(row, entry))) state.rows = [...state.rows, entry]; },
    remove: async (entry) => { state.rows = state.rows.filter((row) => !same(row, entry)); },
  };
  return { state, ledger };
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
    sleep: (_ms, signal) => new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); }),
    backoffMs: (failures) => 1_000 * failures,
    timeout: vi.fn(() => deadline.signal),
    refused: vi.fn(),
    accepted: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  return {
    server, ledger, owned, deps, deadline, roster: createChatRunnerRoster(deps),
    setAgents: (next: AgentRow[]) => { agents = next; },
  };
}

const declared = (runners: ChatRunnerDeclaration["runners"]): ChatRunnerDeclaration =>
  ({ installId: "mac", computerLabel: "Mac", runners });
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

  it.each([["paused", ["ws1"]], ["removed", ["ws1"]]] as const)(
    "withdraws its agents from a workspace %s here",
    async (_how, left) => {
      const r = setup();
      const a = session("A");
      await r.roster.reconcile(a);
      r.owned.A = [...left];
      await r.roster.reconcile(a);
      expect(r.server.puts.at(-1)).toEqual({ scope: "A", workspaceId: "ws2", declaration: declared([]) });
      expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
      expect(r.ledger.state.rows).toEqual([{ account: "A", installId: "mac", workspaceId: "ws1" }]);
    },
  );

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

  it("tries a busy server again after a backoff, quietly", async () => {
    const slept = deferred<void>();
    const wake = deferred<void>();
    const r = setup({ sleep: vi.fn(() => { slept.resolve(); return wake.promise; }) });
    r.owned.A = ["ws1"];
    const a = session("A");
    r.server.refuse(new ChatWakeBusyError());
    await r.roster.reconcile(a);
    await slept.promise;
    expect(r.deps.log).not.toHaveBeenCalled();
    wake.resolve();
    // The backoff's pass, or this call that shares or follows it, sends the declaration again.
    await r.roster.reconcile(a);
    expect(r.server.puts.length).toBeGreaterThanOrEqual(2);
    expect(r.server.row("A", "ws1")).toEqual(CLAUDE_ON);
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
    const many = Array.from({ length: 65 }, (_, index) => runner({ id: `agent-${index}`, name: `Agent ${index}` }));
    r.setAgents(many);
    await r.roster.reconcile(a);
    expect(r.deps.refused).toHaveBeenCalledTimes(2);
    expect(r.deps.refused).toHaveBeenCalledWith("ws1", expect.objectContaining({ reason: "too-many-agents" }));
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
    r.setAgents(Array.from({ length: 65 }, (_, index) => runner({ id: `agent-${index}`, name: `Agent ${index}` })));
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
    // The withdrawal's deadline passes.
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
    r.setAgents(Array.from({ length: 65 }, (_, index) => runner({ id: `agent-${index}`, name: `Agent ${index}` })));
    await r.roster.reconcile(a);
    await r.roster.withdraw(a);
    expect(r.deps.accepted).toHaveBeenCalledExactlyOnceWith("ws1");
  });
});
