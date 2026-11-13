import { open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatWakeCandidate, ChatWakeView, WaitingChatWake } from "@dohc/workspace-contracts/chat-wakes";
import type { DurableFileOperations } from "../atomicReplaceFile";
import { deferred } from "../testing/deferred";
import { createTestScratch } from "../workspaces/testTemp";
import { ChatWakeAnswerError, ChatWakeBusyError, ChatWakeMissingError, type ChatWakeClient, type ChatWakePageAnswer } from "./chatWakeClient";
import {
  chatWakeAgentMatches, chatWakeThreadVisibility, createChatWakeConsumer,
  type ChatWakeAgent, type ChatWakeConsumerDeps, type ChatWakeDecision, type ChatWakeMessage, type ChatWakeThreadVisibility,
} from "./chatWakeConsumer";
import { createChatWakeIntents, ChatWakeIntentsUnreadableError, type ChatWakeIntent, type ChatWakeIntents } from "./chatWakeIntents";

// The relay and the computer are fakes; the intent file is real. Every wait
// is on a barrier the test controls: the relay's next parked read, a gate, or
// a resume pass.

const SCOPE = "https://dohc.test#https://relay.test#ana";
const WAKE = `wake-${"a".repeat(32)}`;
const OTHER_WAKE = `wake-${"b".repeat(32)}`;

afterEach(() => {
  vi.useRealTimers();
});

const candidate = (installId: string, over: Partial<ChatWakeCandidate> = {}): ChatWakeCandidate =>
  ({ installId, agentId: "default", label: installId === "mac" ? "Mac" : "PC", matched: { handle: "claude" }, ...over });

const human: ChatWakeMessage = { id: "m1", workspaceId: "ws", threadId: "t1", author: { kind: "human", displayName: "Ana" }, authorUserId: "ana" };

function intentOf(phase: ChatWakeIntent["phase"], over: Partial<ChatWakeIntent> = {}): ChatWakeIntent {
  return {
    account: SCOPE, userId: "ana", installId: "mac", wakeId: WAKE, generation: 1, workspaceId: "ws", threadId: "t1",
    messageId: "m1", prerequisiteMessageId: null, candidate: candidate("mac"), phase, ...over,
  };
}

type Row = { view: ChatWakeView; candidates: ChatWakeCandidate[]; winner: string | null };

/** The relay's wake rows and routes, first-winner like the real store. Hooks run after a commit and before the answer. */
function fakeRelay() {
  const rows = new Map<string, Row>();
  const pages: Array<(installId: string, since: number) => Promise<ChatWakePageAnswer>> = [];
  const calls = { waits: [] as number[], claims: [] as string[], confirms: [] as string[] };
  // `before…` runs before the relay commits, as a refusal does; the others run after it commits, before the answer.
  const hooks: {
    beforeClaim?: () => Promise<void>; claim?: (installId: string) => Promise<void>;
    beforeConfirm?: () => Promise<void>; confirm?: () => Promise<void>;
  } = {};
  let parks = 0;
  let watchers: Array<{ parks: number; resolve: () => void }> = [];
  const untilParks = (count: number) => count <= parks ? Promise.resolve()
    : new Promise<void>((resolve) => { watchers.push({ parks: count, resolve }); });

  const waiting = (installId: string): WaitingChatWake[] => [...rows.values()].flatMap((row) => {
    const mine = row.candidates.find((each) => each.installId === installId);
    return row.view.state === "waiting" && mine ? [{ ...row.view, state: "waiting" as const, candidate: mine }] : [];
  });

  const client: ChatWakeClient = {
    replaceRunners: async () => undefined,
    async waitWakes({ installId, since }, signal) {
      calls.waits.push(since);
      const page = pages.shift();
      if (page) return await page(installId, since);
      parks += 1;
      for (const watcher of watchers.filter((each) => each.parks <= parks)) watcher.resolve();
      watchers = watchers.filter((each) => each.parks > parks);
      return await new Promise<ChatWakePageAnswer>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    async claimWake(wakeId, installId) {
      calls.claims.push(installId);
      await hooks.beforeClaim?.();
      const row = rows.get(wakeId);
      const mine = row?.candidates.find((each) => each.installId === installId);
      if (!row || !mine) throw new ChatWakeMissingError();
      if (row.view.state === "waiting") {
        row.view = { ...row.view, state: "claimed", winnerLabel: mine.label };
        row.winner = installId;
      }
      await hooks.claim?.(installId);
      return { won: row.winner === installId, wake: { ...row.view } };
    },
    async confirmQueued(wakeId, installId) {
      calls.confirms.push(installId);
      await hooks.beforeConfirm?.();
      const row = rows.get(wakeId);
      if (!row || row.winner !== installId) throw new ChatWakeMissingError();
      if (row.view.state === "claimed" || row.view.state === "unconfirmed") row.view = { ...row.view, state: "queued" };
      await hooks.confirm?.();
      return { ...row.view };
    },
  };

  return {
    rows, calls, hooks, client,
    add(over: Partial<ChatWakeView> = {}, candidates = [candidate("mac")]) {
      const view: ChatWakeView = {
        wakeId: WAKE, workspaceId: "ws", messageId: "m1", threadId: "t1", generation: 1, state: "waiting",
        prerequisiteMessageId: null, winnerLabel: null, ...over,
      };
      rows.set(view.wakeId, { view, candidates, winner: null });
    },
    /** The next read answers this computer's waiting rows at that time, after `before`. */
    offer(cursor: number, before?: () => Promise<void>) {
      pages.push(async (installId) => {
        await before?.();
        return { cursor, wakes: waiting(installId) };
      });
    },
    answer(page: (since: number) => Promise<ChatWakePageAnswer>) {
      pages.push(async (_installId, since) => await page(since));
    },
    /** Resolves when a read next parks: everything before it was accounted for. */
    nextPark: () => untilParks(parks + 1),
    untilParks,
    parks: () => parks,
    state: (wakeId = WAKE) => rows.get(wakeId)?.view.state,
  };
}

/** One computer's workspace "ws", its settings, and its dispatch ledger keyed by workspace, message, and agent. */
function fakeComputer() {
  const local = {
    registered: true,
    current: true,
    messages: new Map<string, ChatWakeMessage>([["m1", human]]),
    visibility: "visible" as ChatWakeThreadVisibility,
    decisions: [] as ChatWakeDecision[],
    agents: new Map<string, ChatWakeAgent>([["default", { name: "Claude", enabled: true, launch: true, admitted: true }]]),
    ledger: new Map<string, string>(),
    recorded: [] as boolean[],
    opened: 0,
    released: 0,
    syncs: 0,
    dispatches: 0,
    hooks: {} as { message?: () => Promise<void>; decisions?: () => Promise<void>; record?: () => Promise<void> },
  };
  const open: ChatWakeConsumerDeps["openWorkspace"] = async (workspaceId) => {
    if (!local.registered || workspaceId !== "ws") return null;
    local.opened += 1;
    return {
      current: () => local.current,
      requestSync: () => { local.syncs += 1; },
      async message(_threadId, messageId) {
        await local.hooks.message?.();
        return local.messages.get(messageId) ?? null;
      },
      threadVisibility: async () => local.visibility,
      async decisions() {
        await local.hooks.decisions?.();
        return local.decisions;
      },
      agent: async (agentId) => local.agents.get(agentId) ?? null,
      async recordTrigger({ triggerMessageId, threadId, agentId }) {
        const key = JSON.stringify(["ws", triggerMessageId, agentId]);
        const had = local.ledger.get(key);
        if (had !== undefined && had !== threadId) throw new Error("This message is queued for that agent in another thread.");
        local.ledger.set(key, threadId);
        local.recorded.push(had === undefined);
        await local.hooks.record?.();
        return had === undefined;
      },
      dispatch: () => { local.dispatches += 1; },
      release: async () => { local.released += 1; },
    };
  };
  return { local, open };
}

/** Intents in memory, so a fake clock flushes every step between its timers. */
function memoryIntents(): ChatWakeIntents & { readonly rows: ChatWakeIntent[]; failNextList: boolean } {
  let rows: ChatWakeIntent[] = [];
  const same = (a: ChatWakeIntent, b: ChatWakeIntent) => a.account === b.account && a.installId === b.installId && a.wakeId === b.wakeId;
  const store: ChatWakeIntents & { readonly rows: ChatWakeIntent[]; failNextList: boolean } = {
    failNextList: false,
    get rows() { return rows; },
    list: async () => {
      if (store.failNextList) {
        store.failNextList = false;
        throw new Error("The saved wakes could not be read just now.");
      }
      return [...rows];
    },
    save: async (intent) => { rows = [...rows.filter((row) => !same(row, intent)), intent]; },
    remove: async (intent) => { rows = rows.filter((row) => !same(row, intent)); },
  };
  return store;
}

/** A backoff on the (fake) timer clock that ends early when the consumer stops. */
const timerSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function setup() {
  const file = join(await createTestScratch("chat-wakes-"), "chat-wakes.json");
  const relay = fakeRelay();
  const mac = fakeComputer();
  let current = true;
  const consumer = (over: Partial<ChatWakeConsumerDeps> = {}) => {
    const deps: ChatWakeConsumerDeps = {
      account: { scope: SCOPE, userId: "ana", installId: "mac" },
      isCurrent: () => current,
      client: relay.client,
      intents: createChatWakeIntents(file),
      openWorkspace: mac.open,
      // A backoff parks until the consumer stops, unless a test passes its own.
      sleep: vi.fn((_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      })),
      backoffMs: (failures) => 1_000 * failures,
      nowMs: () => 0,
      holdMs: 25_000,
      onError: vi.fn(),
      ...over,
    };
    return { deps, consumer: createChatWakeConsumer(deps) };
  };
  /** Starts a consumer and resolves once it has accounted for everything before its next parked read. */
  const settled = async (over: Partial<ChatWakeConsumerDeps> = {}) => {
    const run = consumer(over);
    const parked = relay.nextPark();
    run.consumer.start();
    await parked;
    return run;
  };
  return {
    file, relay, mac, consumer, settled,
    intents: () => createChatWakeIntents(file).list(),
    setCurrent: (value: boolean) => { current = value; },
  };
}

describe("claiming a wake", () => {
  it("saves each phase before its effect and confirms after the trigger exists", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    w.relay.hooks.claim = async () => { expect(await w.intents()).toEqual([intentOf("claim-pending")]); };
    w.mac.local.hooks.record = async () => { expect(await w.intents()).toEqual([intentOf("won")]); };
    w.relay.hooks.confirm = async () => {
      expect(await w.intents()).toEqual([intentOf("recorded")]);
      expect(w.mac.local.dispatches).toBe(1);
    };
    const { consumer, deps } = await w.settled();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.relay.state()).toBe("queued");
    expect(await w.intents()).toEqual([]);
    expect(w.mac.local.released).toBe(w.mac.local.opened);
    expect(w.relay.calls.waits).toEqual([0, 1]);
    expect(deps.onError).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("defers a wake that arrives before its message, moves the cursor on, and claims once after the pull", async () => {
    const w = await setup();
    w.mac.local.messages.clear();
    w.relay.add();
    w.relay.offer(7);
    const { consumer } = await w.settled();
    expect(w.relay.calls.claims).toEqual([]);
    expect(w.mac.local.syncs).toBe(1);
    // The cursor moved past the deferred row, and the read parked rather than asking again.
    expect(w.relay.calls.waits).toEqual([0, 7]);
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual([]);
    w.mac.local.messages.set("m1", human);
    await Promise.all([consumer.resume(), consumer.resume()]);
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.relay.calls.waits).toEqual([0, 7]);
    await consumer.stop();
  });

  it("finds a deferred wake again from zero after a restart before the pull", async () => {
    const w = await setup();
    w.mac.local.messages.clear();
    w.relay.add();
    w.relay.offer(3);
    await (await w.settled()).consumer.stop();
    w.mac.local.messages.set("m1", human);
    w.relay.offer(3);
    const { consumer } = await w.settled();
    expect(w.relay.calls.waits).toEqual([0, 3, 0, 3]);
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    await consumer.stop();
  });

  it("waits for the resolved decision a reply names, and not for one it doesn't", async () => {
    const w = await setup();
    w.relay.add({ prerequisiteMessageId: "q1" });
    w.relay.offer(1);
    const { consumer } = await w.settled();
    w.mac.local.decisions = [{ messageId: "q1", state: "open" }];
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual([]);
    expect(w.mac.local.syncs).toBe(2);
    w.mac.local.decisions = [{ messageId: "q1", state: "resolved", resolvedByMessageId: "m1" }];
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    await consumer.stop();

    // A lost or refused decision releases the reply with no prerequisite: an open question doesn't hold it.
    const v = await setup();
    v.relay.add();
    v.relay.offer(1);
    v.mac.local.decisions = [{ messageId: "q1", state: "open" }];
    await (await v.settled()).consumer.stop();
    expect(v.mac.local.recorded).toEqual([true]);
  });

  type Change = (w: Awaited<ReturnType<typeof setup>>) => void;
  it.each<[string, Change]>([
    ["an agent's message", (w) => w.mac.local.messages.set("m1", { ...human, author: { kind: "agent", displayName: "Claude" } })],
    ["another person's message", (w) => w.mac.local.messages.set("m1", { ...human, authorUserId: "ben" })],
    ["a message with no author ID", (w) => w.mac.local.messages.set("m1", { ...human, authorUserId: undefined })],
    ["a message from the CLI", (w) => w.mac.local.messages.set("m1", { ...human, origin: "cli" })],
    ["a message in another thread", (w) => w.mac.local.messages.set("m1", { ...human, threadId: "t2" })],
    ["a thread on a secret file", (w) => { w.mac.local.visibility = "hidden"; }],
    ["a thread that is gone", (w) => { w.mac.local.visibility = "missing"; }],
    ["a renamed agent", (w) => w.mac.local.agents.set("default", { name: "Claudia", enabled: true, launch: true, admitted: true })],
    ["a removed agent", (w) => w.mac.local.agents.clear()],
    ["another computer's candidate", (w) => w.relay.add({}, [candidate("pc")])],
    ["a decision another message resolved", (w) => {
      w.relay.add({ prerequisiteMessageId: "q1" });
      w.mac.local.decisions = [{ messageId: "q1", state: "resolved", resolvedByMessageId: "m9" }];
    }],
  ])("never claims for %s, even after a resume", async (_name, change) => {
    const w = await setup();
    w.relay.add();
    change(w);
    // A fake read that hands this computer another install's candidate, as a misbehaving relay could.
    const rows = [...w.relay.rows.values()];
    w.relay.answer(async () => ({ cursor: 1, wakes: rows.map((row) => ({ ...row.view, state: "waiting" as const, candidate: row.candidates[0]! })) }));
    const { consumer } = await w.settled();
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual([]);
    expect(w.mac.local.ledger.size).toBe(0);
    expect(await w.intents()).toEqual([]);
    expect(w.mac.local.released).toBe(w.mac.local.opened);
    await consumer.stop();
  });

  it.each<[string, Change, Change]>([
    ["placement it can't establish", (w) => { w.mac.local.visibility = "unknown"; }, (w) => { w.mac.local.visibility = "visible"; }],
    ["a paused agent", (w) => w.mac.local.agents.set("default", { name: "Claude", enabled: false, launch: true, admitted: true }),
      (w) => w.mac.local.agents.set("default", { name: "Claude", enabled: true, launch: true, admitted: true })],
    ["an agent with no way to start", (w) => w.mac.local.agents.set("default", { name: "Claude", enabled: true, launch: false, admitted: true }),
      (w) => w.mac.local.agents.set("default", { name: "Claude", enabled: true, launch: true, admitted: true })],
    ["Restricted Mode", (w) => w.mac.local.agents.set("default", { name: "Claude", enabled: true, launch: true, admitted: false }),
      (w) => w.mac.local.agents.set("default", { name: "Claude", enabled: true, launch: true, admitted: true })],
    ["a workspace that isn't open to this account", (w) => { w.mac.local.registered = false; }, (w) => { w.mac.local.registered = true; }],
    ["a replaced attachment", (w) => { w.mac.local.current = false; }, (w) => { w.mac.local.current = true; }],
  ])("defers %s without claiming, and claims once it allows it", async (_name, block, allow) => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    block(w);
    const { consumer } = await w.settled();
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual([]);
    allow(w);
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.mac.local.released).toBe(w.mac.local.opened);
    await consumer.stop();
  });

  it("claims in a ready workspace beside one that isn't", async () => {
    const w = await setup();
    w.relay.add({ wakeId: OTHER_WAKE, workspaceId: "elsewhere" });
    w.relay.add();
    w.relay.offer(2);
    const { consumer } = await w.settled();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.relay.state(OTHER_WAKE)).toBe("waiting");
    expect(w.relay.calls.waits).toEqual([0, 2]);
    await consumer.stop();
  });

  it("records on only the computer the frozen candidate names when two computers have the same agent ID", async () => {
    const w = await setup();
    const pc = fakeComputer();
    w.relay.add({}, [candidate("mac"), candidate("pc", { label: "PC" })]);
    // Both computers read the wake while it waits, then race to claim it.
    const bothRead = deferred();
    let reads = 0;
    const together = async () => { if (++reads === 2) bothRead.resolve(); await bothRead.promise; };
    w.relay.offer(1, together);
    w.relay.offer(1, together);
    const macRun = w.consumer();
    const pcRun = w.consumer({
      account: { scope: SCOPE, userId: "ana", installId: "pc" },
      openWorkspace: pc.open,
      intents: createChatWakeIntents(join(await createTestScratch("chat-wakes-pc-"), "chat-wakes.json")),
    });
    const parked = w.relay.untilParks(w.relay.parks() + 2);
    macRun.consumer.start();
    pcRun.consumer.start();
    await parked;
    expect(w.relay.calls.claims.toSorted()).toEqual(["mac", "pc"]);
    const winner = w.relay.rows.get(WAKE)!.winner;
    expect(w.mac.local.ledger.size + pc.local.ledger.size).toBe(1);
    expect((winner === "mac" ? w.mac : pc).local.ledger.size).toBe(1);
    expect(w.relay.calls.confirms).toEqual([winner]);
    await Promise.all([macRun.consumer.stop(), pcRun.consumer.stop()]);
  });
});

describe("finishing from a saved intent", () => {
  it("repeats a claim whose answer was lost, without the feed", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    w.relay.hooks.claim = async () => { throw new ChatWakeAnswerError("Wake claim"); };
    const first = await w.settled();
    await first.consumer.stop();
    expect(w.relay.state()).toBe("claimed");
    expect(w.mac.local.ledger.size).toBe(0);
    expect(await w.intents()).toEqual([intentOf("claim-pending")]);
    // The claimed row is no longer waiting, so only the saved intent can finish it.
    w.relay.hooks.claim = undefined;
    const { consumer } = await w.settled();
    expect(w.relay.calls.claims).toEqual(["mac", "mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.relay.state()).toBe("queued");
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it("repeats an enqueue whose answer was lost, and the ledger makes it the same request", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    w.mac.local.hooks.record = async () => { throw new Error("The engine stopped answering."); };
    const { consumer } = await w.settled();
    expect(await w.intents()).toEqual([intentOf("won")]);
    expect(w.relay.calls.confirms).toEqual([]);
    w.mac.local.hooks.record = undefined;
    await consumer.resume();
    expect(w.mac.local.recorded).toEqual([true, false]);
    expect(w.mac.local.ledger.size).toBe(1);
    expect(w.relay.state()).toBe("queued");
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it("keeps the won intent when saving the recorded phase fails, and repeats the enqueue before confirming", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    const real = createChatWakeIntents(w.file);
    let failed = false;
    const intents: ChatWakeIntents = {
      ...real,
      save: async (intent) => {
        if (intent.phase === "recorded" && !failed) { failed = true; throw new Error("rename failed"); }
        await real.save(intent);
      },
    };
    const { consumer } = await w.settled({ intents });
    expect(await w.intents()).toEqual([intentOf("won")]);
    expect(w.relay.calls.confirms).toEqual([]);
    // The trigger is durable, so its dispatch scan was arranged although the recorded phase didn't save.
    expect(w.mac.local.dispatches).toBe(1);
    await consumer.resume();
    expect(w.mac.local.recorded).toEqual([true, false]);
    expect(w.relay.calls.confirms).toEqual(["mac"]);
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it.each([
    ["after the relay committed it", "queued"],
    ["before it committed, and the wake became unconfirmed", "unconfirmed"],
  ] as const)("retries only the confirmation when its answer was lost %s", async (_name, laterState) => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    w.relay.hooks.confirm = async () => {
      if (laterState === "unconfirmed") w.relay.rows.get(WAKE)!.view.state = "unconfirmed";
      throw new ChatWakeAnswerError("Wake confirmation");
    };
    await (await w.settled()).consumer.stop();
    expect(await w.intents()).toEqual([intentOf("recorded")]);
    expect(w.relay.state()).toBe(laterState);
    w.relay.hooks.confirm = undefined;
    const { consumer } = await w.settled();
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.relay.calls.confirms).toEqual(["mac", "mac"]);
    expect(w.relay.state()).toBe("queued");
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it("confirms again when removing the intent failed", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    const real = createChatWakeIntents(w.file);
    let failed = false;
    const intents: ChatWakeIntents = {
      ...real,
      remove: async (intent) => {
        if (!failed) { failed = true; throw new Error("rename failed"); }
        await real.remove(intent);
      },
    };
    const { consumer } = await w.settled({ intents });
    expect(await w.intents()).toEqual([intentOf("recorded")]);
    await consumer.resume();
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.relay.calls.confirms).toEqual(["mac", "mac"]);
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it.each<[string, Partial<ChatWakeView>, string | null]>([
    ["another computer won", { state: "claimed" }, "pc"],
    ["another computer's trigger is queued", { state: "queued" }, "pc"],
    ["the wake is held for its decision", { state: "held" }, null],
    ["no computer claimed it in time", { state: "unclaimed" }, null],
    ["this computer confirmed it before", { state: "queued" }, "mac"],
  ])("records nothing and drops the intent when %s", async (_name, view, winner) => {
    const w = await setup();
    w.relay.add(view, [candidate("mac"), candidate("pc")]);
    w.relay.rows.get(WAKE)!.winner = winner;
    await createChatWakeIntents(w.file).save(intentOf("claim-pending"));
    const { consumer } = await w.settled();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.ledger.size).toBe(0);
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it("drops an unrecorded intent whose wake is gone, and keeps a recorded one", async () => {
    const w = await setup();
    await createChatWakeIntents(w.file).save(intentOf("claim-pending"));
    await createChatWakeIntents(w.file).save(intentOf("recorded", { wakeId: OTHER_WAKE }));
    const { consumer, deps } = await w.settled();
    expect(w.mac.local.ledger.size).toBe(0);
    expect(await w.intents()).toEqual([intentOf("recorded", { wakeId: OTHER_WAKE })]);
    expect(deps.onError).toHaveBeenCalledWith(expect.any(ChatWakeMissingError));
    await consumer.stop();
  });

  it("drops a won intent whose agent changed before recording, and never picks another agent", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    w.mac.local.agents.set("helper", { name: "Claude", enabled: true, launch: true, admitted: true });
    w.relay.hooks.claim = async () => {
      w.mac.local.agents.set("default", { name: "Claudia", enabled: true, launch: true, admitted: true });
    };
    const { consumer } = await w.settled();
    expect(w.relay.state()).toBe("claimed");
    expect(w.mac.local.ledger.size).toBe(0);
    expect(w.relay.calls.confirms).toEqual([]);
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it("keeps a won intent while its agent is paused, and records it once it is on again", async () => {
    const w = await setup();
    w.relay.add({ state: "claimed", winnerLabel: "Mac" });
    w.relay.rows.get(WAKE)!.winner = "mac";
    await createChatWakeIntents(w.file).save(intentOf("won"));
    w.mac.local.agents.set("default", { name: "Claude", enabled: false, launch: true, admitted: true });
    const { consumer } = await w.settled();
    expect(await w.intents()).toEqual([intentOf("won")]);
    w.mac.local.agents.set("default", { name: "Claude", enabled: true, launch: true, admitted: true });
    await consumer.resume();
    expect(w.mac.local.recorded).toEqual([true]);
    expect(w.relay.state()).toBe("queued");
    await consumer.stop();
  });

  it("confirms a recorded intent without enqueueing again after its agent was renamed", async () => {
    const w = await setup();
    w.relay.add({ state: "claimed", winnerLabel: "Mac" });
    w.relay.rows.get(WAKE)!.winner = "mac";
    await createChatWakeIntents(w.file).save(intentOf("recorded"));
    w.mac.local.agents.set("default", { name: "Claudia", enabled: false, launch: true, admitted: true });
    const { consumer } = await w.settled();
    expect(w.mac.local.opened).toBe(0);
    expect(w.relay.state()).toBe("queued");
    expect(await w.intents()).toEqual([]);
    await consumer.stop();
  });

  it("fails closed when the ledger has the message for that agent in another thread", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    w.mac.local.ledger.set(JSON.stringify(["ws", "m1", "default"]), "t2");
    const { consumer, deps } = await w.settled();
    expect(w.relay.calls.confirms).toEqual([]);
    expect(await w.intents()).toEqual([intentOf("won")]);
    expect(deps.onError).toHaveBeenCalled();
    await consumer.stop();
  });

  it("leaves another account's and another install's intents in the file", async () => {
    const w = await setup();
    const others = [intentOf("won", { account: "https://other.test##ana" }), intentOf("recorded", { installId: "old-install" })];
    for (const intent of others) await createChatWakeIntents(w.file).save(intent);
    const { consumer } = await w.settled();
    expect(w.relay.calls.claims).toEqual([]);
    expect(w.relay.calls.confirms).toEqual([]);
    expect(w.mac.local.opened).toBe(0);
    expect(await w.intents()).toEqual(others);
    await consumer.stop();
  });
});

describe("the credential lifetime", () => {
  it.each(["the message read", "the claim's answer", "the enqueue"] as const)(
    "lets nothing past %s once the account is no longer current, and its own lifetime finishes it once",
    async (boundary) => {
      const w = await setup();
      w.relay.add();
      w.relay.offer(1);
      const reached = deferred();
      const release = deferred();
      const hold = async () => { reached.resolve(); await release.promise; };
      if (boundary === "the message read") w.mac.local.hooks.message = hold;
      if (boundary === "the claim's answer") w.relay.hooks.claim = hold;
      if (boundary === "the enqueue") w.mac.local.hooks.record = hold;
      const { consumer } = w.consumer();
      consumer.start();
      await reached.promise;
      w.setCurrent(false);
      release.resolve();
      await consumer.stop();
      expect(w.relay.calls.claims).toEqual(boundary === "the message read" ? [] : ["mac"]);
      expect(w.mac.local.recorded).toEqual(boundary === "the enqueue" ? [true] : []);
      expect(w.relay.calls.confirms).toEqual([]);
      expect(w.mac.local.released).toBe(w.mac.local.opened);

      // The next account's lifetime leaves the saved work alone.
      const saved = await w.intents();
      w.setCurrent(true);
      const next = await w.settled({ account: { scope: "https://dohc.test#https://relay.test#ben", userId: "ben", installId: "mac" } });
      await next.consumer.stop();
      expect(await w.intents()).toEqual(saved);

      // The same account's next lifetime finishes it exactly once.
      w.mac.local.hooks = {};
      w.relay.hooks.claim = undefined;
      if (boundary === "the message read") w.relay.offer(1);
      const again = await w.settled();
      expect(w.mac.local.ledger.size).toBe(1);
      expect(w.relay.state()).toBe("queued");
      expect(await w.intents()).toEqual([]);
      await again.consumer.stop();
    },
  );

  it("admits nothing once stopped during a step, and settles after its release", async () => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    const reached = deferred();
    const release = deferred();
    w.mac.local.hooks.message = async () => { reached.resolve(); await release.promise; };
    const { consumer } = w.consumer();
    consumer.start();
    await reached.promise;
    const stopped = consumer.stop();
    release.resolve();
    await stopped;
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual([]);
    expect(await w.intents()).toEqual([]);
    expect(w.mac.local.released).toBe(1);
  });
});

describe("reading wakes", () => {
  it("claims nothing and keeps the file when the saved intents can't be read", async () => {
    const w = await setup();
    await writeFile(w.file, "{broken");
    w.relay.add();
    w.relay.offer(1);
    const backoff = deferred();
    const { consumer, deps } = w.consumer({ sleep: vi.fn(async () => { backoff.resolve(); }) });
    const parked = w.relay.nextPark();
    consumer.start();
    await backoff.promise;
    await parked;
    expect(deps.onError).toHaveBeenCalledWith(expect.any(ChatWakeIntentsUnreadableError));
    expect(w.relay.calls.claims).toEqual([]);
    // The page was not accounted for, so the cursor stayed.
    expect(w.relay.calls.waits).toEqual([0, 0]);
    expect(await readFile(w.file, "utf8")).toBe("{broken");
    await consumer.stop();
  });

  it("backs off on a busy server by the backoff's own time, then reads again", async () => {
    const w = await setup();
    vi.useFakeTimers();
    w.relay.answer(async () => { throw new ChatWakeBusyError(); });
    w.relay.answer(async () => { throw new ChatWakeBusyError(); });
    const sleep = timerSleep;
    const parked = w.relay.nextPark();
    // In memory, so every step before a timer is a microtask the fake clock flushes.
    const intents: ChatWakeIntents = { list: async () => [], save: async () => undefined, remove: async () => undefined };
    const { consumer } = w.consumer({ sleep, intents });
    consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.relay.calls.waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(w.relay.calls.waits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.relay.calls.waits).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(w.relay.calls.waits).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await parked;
    expect(w.relay.calls.waits).toHaveLength(3);
    await consumer.stop();
  });

  it("backs off rather than asking again when a read answers early with no change", async () => {
    const w = await setup();
    w.relay.answer(async (since) => ({ cursor: since, wakes: [] }));
    const backoff = deferred();
    const { consumer } = w.consumer({ sleep: vi.fn(async (_ms: number, signal: AbortSignal) => {
      backoff.resolve();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
    }) });
    consumer.start();
    await backoff.promise;
    expect(w.relay.calls.waits).toEqual([0]);
    await consumer.stop();
  });

  it("moves past a full page of deferred wakes and asks from its last row", async () => {
    const w = await setup();
    w.mac.local.messages.clear();
    const wakes: WaitingChatWake[] = Array.from({ length: 100 }, (_, index) => ({
      wakeId: `wake-${index.toString(16).padStart(32, "0")}`, workspaceId: "ws", messageId: `m${index}`, threadId: "t1",
      generation: 1, state: "waiting", prerequisiteMessageId: null, winnerLabel: null, candidate: candidate("mac"),
    }));
    w.relay.answer(async () => ({ cursor: 100, wakes }));
    const { consumer } = await w.settled();
    expect(w.relay.calls.waits).toEqual([0, 100]);
    expect(w.relay.calls.claims).toEqual([]);
    await consumer.stop();
  });
});

describe("local checks", () => {
  it("matches the frozen handle or shown name, not a new resolution", () => {
    expect(chatWakeAgentMatches("Claude", { handle: "claude" })).toBe(true);
    expect(chatWakeAgentMatches("Claude Code", { handle: "claude" })).toBe(false);
    expect(chatWakeAgentMatches("Claude", { displayName: "Claude" })).toBe(true);
    expect(chatWakeAgentMatches("claude", { displayName: "Claude" })).toBe(false);
  });

  it("reads a thread as hidden by its hint or its file's current path, and unknown without evidence", () => {
    const thread = (pathHint?: string) => ({ linkedFile: { objectId: "o1", linkedAtMs: 0, ...(pathHint === undefined ? {} : { pathHint }) } });
    expect(chatWakeThreadVisibility(null, undefined, "linux")).toBe("missing");
    expect(chatWakeThreadVisibility({}, undefined, "linux")).toBe("visible");
    expect(chatWakeThreadVisibility(thread(".env"), { status: "found", objectId: "o1", path: "notes.md" }, "linux")).toBe("hidden");
    expect(chatWakeThreadVisibility(thread("notes.md"), { status: "found", objectId: "o1", path: ".env" }, "linux")).toBe("hidden");
    expect(chatWakeThreadVisibility(thread("notes.md"), { status: "found", objectId: "o1", path: "plan.md" }, "linux")).toBe("visible");
    expect(chatWakeThreadVisibility(thread("notes.md"), { status: "absent" }, "linux")).toBe("visible");
    expect(chatWakeThreadVisibility(thread(), { status: "absent" }, "linux")).toBe("unknown");
    expect(chatWakeThreadVisibility(thread("notes.md"), { status: "invalid" }, "linux")).toBe("unknown");
    expect(chatWakeThreadVisibility(thread("notes.md"), undefined, "linux")).toBe("unknown");
  });
});

describe("fix round 1", () => {
  it.each(["claim-pending", "won", "recorded"] as const)(
    "saves a %s intent read back after a failed folder sync again before its next step",
    async (phase) => {
      const w = await setup();
      let syncFails = false;
      const flakyFolderSync: NonNullable<DurableFileOperations["open"]> = async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        return {
          writeFile: (data: string) => handle.writeFile(data),
          close: () => handle.close(),
          sync: async () => {
            if (flags === "r" && syncFails) throw new Error("fsync failed");
            await handle.sync();
          },
        };
      };
      const intents = createChatWakeIntents(w.file, { open: flakyFolderSync, platform: "linux" });
      w.relay.add();
      w.relay.offer(1);
      if (phase === "claim-pending") syncFails = true;
      if (phase === "won") w.relay.hooks.claim = async () => { syncFails = true; };
      if (phase === "recorded") w.mac.local.hooks.record = async () => { syncFails = true; };
      const { consumer } = await w.settled({ intents });
      // The rename happened, so the phase reads back although its save rejected.
      expect(await w.intents()).toEqual([intentOf(phase)]);
      const sent = { claims: [...w.relay.calls.claims], recorded: [...w.mac.local.recorded], confirms: [...w.relay.calls.confirms] };

      // Folder syncs keep failing: recovery reads the row, can't save it again, and takes no next step.
      await consumer.resume();
      await consumer.resume();
      expect(w.relay.calls.claims).toEqual(sent.claims);
      expect(w.mac.local.recorded).toEqual(sent.recorded);
      expect(w.relay.calls.confirms).toEqual(sent.confirms);
      expect(sent.claims).toEqual(phase === "claim-pending" ? [] : ["mac"]);
      expect(sent.recorded).toEqual(phase === "recorded" ? [true] : []);
      expect(sent.confirms).toEqual([]);

      syncFails = false;
      w.relay.hooks.claim = undefined;
      w.mac.local.hooks = {};
      await consumer.resume();
      expect(w.relay.calls.claims).toEqual(["mac"]);
      expect(w.mac.local.ledger.size).toBe(1);
      expect(w.mac.local.recorded).toEqual([true]);
      expect(w.relay.calls.confirms).toEqual(["mac"]);
      expect(w.relay.state()).toBe("queued");
      expect(await w.intents()).toEqual([]);
      await consumer.stop();
    },
  );

  it.each([
    ["renamed", { name: "Claudia", enabled: true, launch: true, admitted: true }, []],
    ["paused", { name: "Claude", enabled: false, launch: true, admitted: true }, [intentOf("won", { prerequisiteMessageId: "q1" })]],
  ] as const)("records nothing when the agent is %s while the decision is read before the enqueue", async (_name, agent, left) => {
    const w = await setup();
    w.relay.add({ prerequisiteMessageId: "q1" });
    w.relay.offer(1);
    w.mac.local.decisions = [{ messageId: "q1", state: "resolved", resolvedByMessageId: "m1" }];
    const reached = deferred();
    const release = deferred();
    let reads = 0;
    // The first read admits the claim; the second is the check before the enqueue.
    w.mac.local.hooks.decisions = async () => {
      if (++reads !== 2) return;
      reached.resolve();
      await release.promise;
    };
    const parked = w.relay.nextPark();
    const { consumer } = w.consumer();
    consumer.start();
    await reached.promise;
    w.mac.local.agents.set("default", { ...agent });
    release.resolve();
    await parked;
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.ledger.size).toBe(0);
    expect(await w.intents()).toEqual(left);
    await consumer.stop();
  });

  it.each([
    ["succeeds", []],
    ["fails", [intentOf("claim-pending")]],
  ] as const)("sends no claim when the attachment retires during its save and the removal %s, until it is back", async (removal, left) => {
    const w = await setup();
    w.relay.add();
    w.relay.offer(1);
    const real = createChatWakeIntents(w.file);
    const reached = deferred();
    const release = deferred();
    let held = false;
    let removeFails = removal === "fails";
    const intents: ChatWakeIntents = {
      ...real,
      save: async (intent) => {
        await real.save(intent);
        if (intent.phase !== "claim-pending" || held) return;
        held = true;
        reached.resolve();
        await release.promise;
      },
      remove: async (intent) => {
        if (removeFails) {
          removeFails = false;
          throw new Error("rename failed");
        }
        await real.remove(intent);
      },
    };
    const parked = w.relay.nextPark();
    const { consumer } = w.consumer({ intents });
    consumer.start();
    await reached.promise;
    w.mac.local.current = false;
    release.resolve();
    await parked;
    expect(w.relay.calls.claims).toEqual([]);
    expect(await w.intents()).toEqual(left);
    // Retries while it is still retired: recovery won't claim a saved claim-pending intent from it.
    await consumer.resume();
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual([]);
    expect(w.relay.state()).toBe("waiting");
    w.mac.local.current = true;
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    await consumer.stop();
  });

  it("sends no recovered claim when the attachment retires during its re-save, until it is back", async () => {
    const w = await setup();
    w.relay.add();
    const real = createChatWakeIntents(w.file);
    await real.save(intentOf("claim-pending"));
    const reached = deferred();
    const release = deferred();
    let held = false;
    const intents: ChatWakeIntents = {
      ...real,
      save: async (intent) => {
        await real.save(intent);
        if (intent.phase !== "claim-pending" || held) return;
        held = true;
        reached.resolve();
        await release.promise;
      },
    };
    const parked = w.relay.nextPark();
    const { consumer } = w.consumer({ intents });
    consumer.start();
    await reached.promise;
    w.mac.local.current = false;
    release.resolve();
    await parked;
    expect(w.relay.calls.claims).toEqual([]);
    expect(await w.intents()).toEqual([intentOf("claim-pending")]);
    w.mac.local.current = true;
    await consumer.resume();
    expect(w.relay.calls.claims).toEqual(["mac"]);
    expect(w.mac.local.recorded).toEqual([true]);
    await consumer.stop();
  });

  it.each(["claim", "confirmation"] as const)(
    "tries a %s the server refused as busy again after its backoff, with nothing calling resume",
    async (step) => {
      const w = await setup();
      vi.useFakeTimers();
      w.relay.add();
      w.relay.offer(1);
      let refused = false;
      const refuseOnce = async () => {
        if (refused) return;
        refused = true;
        throw new ChatWakeBusyError();
      };
      if (step === "claim") w.relay.hooks.beforeClaim = refuseOnce;
      else w.relay.hooks.beforeConfirm = refuseOnce;
      const intents = memoryIntents();
      const { consumer } = w.consumer({ sleep: timerSleep, intents });
      consumer.start();
      await vi.advanceTimersByTimeAsync(0);
      const sends = () => (step === "claim" ? w.relay.calls.claims : w.relay.calls.confirms).length;
      expect(sends()).toBe(1);
      expect(w.relay.state()).toBe(step === "claim" ? "waiting" : "claimed");
      expect(intents.rows).toEqual([intentOf(step === "claim" ? "claim-pending" : "recorded")]);
      // No hot loop: nothing is sent again before the backoff ends.
      await vi.advanceTimersByTimeAsync(999);
      expect(sends()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sends()).toBe(2);
      expect(w.mac.local.recorded).toEqual([true]);
      expect(w.relay.state()).toBe("queued");
      expect(intents.rows).toEqual([]);
      await consumer.stop();
    },
  );

  it("keeps owing a refused confirmation when a retry pass can't read the saved wakes, and confirms on a later pass", async () => {
    const w = await setup();
    vi.useFakeTimers();
    w.relay.add();
    w.relay.offer(1);
    let refused = false;
    w.relay.hooks.beforeConfirm = async () => {
      if (refused) return;
      refused = true;
      throw new ChatWakeBusyError();
    };
    const intents = memoryIntents();
    const { consumer, deps } = w.consumer({ sleep: timerSleep, intents });
    consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.relay.calls.confirms).toHaveLength(1);
    intents.failNextList = true;
    // The first retry fails before it reaches the intent.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(intents.failNextList).toBe(false);
    expect(w.relay.calls.confirms).toHaveLength(1);
    expect(intents.rows).toEqual([intentOf("recorded")]);
    // The next waits a longer backoff, with nothing calling resume.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(w.relay.calls.confirms).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.relay.calls.confirms).toHaveLength(2);
    expect(w.relay.state()).toBe("queued");
    expect(intents.rows).toEqual([]);
    expect(w.mac.local.recorded).toEqual([true]);
    expect(deps.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "The saved wakes could not be read just now." }));
    await consumer.stop();
  });
});
