import { describe, expect, it } from "vitest";
import type { AutomationClaim, AutomationClaimSummary } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { ServerClaimEngine, type LiveClaimLedger } from "./automationLiveClaims";

// The server's executor drains its own copy's claims, then the live host's,
// and runs a live claim only once the relay logged its change and the copy
// pulled it. Each claim goes back to the engine that served it.

const WORKSPACE = "workspace-trip";
const SUBSCRIPTION = { automationId: "collection:Tasks#stamp", path: "Tasks", kinds: ["changed" as const], fields: ["Status"] };

// The claim's own fields, as the engine answers them; the test reads only a few.
const claimFields = (claimId: string, originSeq: number) => ({
  claimId, automationId: "collection:Tasks#stamp", trigger: { originId: "live-host", originSeq },
  recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa", collectionPath: "Tasks", depth: 0, state: "running" as const, attempts: 1, run: 1,
  createdAtMs: originSeq, updatedAtMs: originSeq,
});
const claim = (claimId: string, originSeq: number) => ({
  ...claimFields(claimId, originSeq),
  change: { kind: "changed", authorOriginId: "ana", actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
}) as unknown as AutomationClaim;
const summary = (claimId: string, createdAtMs: number) => ({
  ...claimFields(claimId, createdAtMs),
  change: { kind: "changed", authorOriginId: "ana", actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null },
}) as unknown as AutomationClaimSummary;

function fakeLedger(pending: AutomationClaim[]) {
  const calls: Array<[string, unknown]> = [];
  const ledger: LiveClaimLedger = {
    incarnation: "host-1",
    engine: {
      subscribeAutomation: async (input) => { calls.push(["subscribe", input]); return { subscribed: true }; },
      unsubscribeAutomation: async (input) => { calls.push(["unsubscribe", input]); return { unsubscribed: true }; },
      claimNextAutomation: async () => pending.shift() ?? null,
      settleAutomationClaim: async (input) => { calls.push(["settle", input]); return summary(input.claimId, 1); },
      releaseAutomationClaim: async (input) => { calls.push(["release", input]); return summary(input.claimId, 1); },
      retryAutomationClaim: async (input) => { calls.push(["retry", input]); return summary(input.claimId, 1); },
      getAutomationClaim: async () => ({ claim: null }),
      pruneAutomationHistory: async () => ({ pruned: 0, more: false }),
      listAutomationClaims: async () => ({ claims: [summary("live-old", 5)], next: null }),
      listAutomationFailures: async () => ({ failures: [{ automationId: "collection:Tasks#stamp", claimId: "live-old", chainStopped: false, error: "x", updatedAtMs: 9, generation: 1 }] }),
    } as LiveClaimLedger["engine"],
  };
  return { ledger, calls };
}

/** The copy's engine answers through a daemon client; these tests answer it by method. */
function copyClient(answers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const methods: string[] = [];
  const client = {
    sendRequest: async (request: { id: number; method: string; params: Record<string, unknown> }) => {
      methods.push(request.method);
      const answer = answers[request.method];
      if (!answer) throw new Error(`unexpected ${request.method}`);
      return { id: request.id, result: answer(request.params) };
    },
  } as unknown as EngineClient;
  return { client, methods };
}

function engine(options: {
  live: ReturnType<typeof fakeLedger> | null;
  logged: Map<number, number>;
  head: { value: number };
  /** Where a settlement's moment was logged, by the live cursor it carried. */
  settled?: Map<number, number>;
  sync?: () => Promise<void>;
}) {
  const copy = copyClient({
    "automations.subscribe": () => ({ subscribed: true }),
    "automations.unsubscribe": () => ({ unsubscribed: true }),
    "automations.claimNext": () => null,
    "automations.listClaims": () => ({ claims: [summary("own-new", 7)], next: null }),
    "automations.failures": () => ({ failures: [{ automationId: "collection:Tasks#stamp", claimId: "own", chainStopped: false, error: "y", updatedAtMs: 3, generation: 1 }] }),
  });
  const pulls: number[] = [];
  const errors: string[] = [];
  const adapter = new ServerClaimEngine([copy.client, "handle", { workspaceId: WORKSPACE }], {
    ledger: () => options.live?.ledger ?? null,
    storage: {
      automationWorkspaceLogSeq: ({ originSeq }) => options.logged.get(originSeq) ?? null,
      automationWorkspaceLogHead: () => options.head.value,
      liveClaimLogSeq: ({ liveCursor }) => options.settled?.get(liveCursor) ?? null,
    },
    sync: async () => { pulls.push(options.head.value); await options.sync?.(); },
    onFailuresChanged: () => {},
    onError: (context) => errors.push(context),
  });
  return { adapter, copy, pulls, errors };
}

describe("the server's claim engine", () => {
  it("pages both ledgers with one cursor, including equal timestamps, and retains live lookups", async () => {
    const own = [summary("z", 7), summary("a", 7), summary("old", 1)];
    const other = [summary("y", 7), summary("live", 3)];
    const page = (rows: AutomationClaimSummary[], input: { before?: unknown; limit?: unknown }) => {
      const before = typeof input.before === "string" ? input.before : null;
      const cut = before?.indexOf(":") ?? -1;
      const found = rows.filter((row) => before === null || row.createdAtMs < Number(before.slice(0, cut)) ||
        (row.createdAtMs === Number(before.slice(0, cut)) && row.claimId < before.slice(cut + 1)));
      const claims = found.slice(0, Number(input.limit ?? 20));
      const last = claims.at(-1)!;
      return { claims, next: found.length > claims.length ? `${last.createdAtMs}:${last.claimId}` : null };
    };
    const live = fakeLedger([]);
    live.ledger.engine.listAutomationClaims = async (input) => page(other, input);
    live.ledger.engine.getAutomationClaim = async () => ({ claim: other[1]! });
    live.ledger.engine.pruneAutomationHistory = async (input) => {
      expect(input.keep).toEqual(["live"]);
      return { pruned: 2, more: true };
    };
    const copy = copyClient({
      "automations.listClaims": (input) => page(own, input),
      "automations.getClaim": () => ({ claim: null }),
      "automations.pruneHistory": () => ({ pruned: 1, more: false }),
    });
    const adapter = new ServerClaimEngine([copy.client, "handle", { workspaceId: WORKSPACE }], {
      ledger: () => live.ledger,
      storage: { automationWorkspaceLogSeq: () => null, automationWorkspaceLogHead: () => 0, liveClaimLogSeq: () => null },
      sync: async () => {}, onFailuresChanged: () => {}, onError: () => {},
    });
    const first = await adapter.listAutomationClaims({ automationId: SUBSCRIPTION.automationId, limit: 2 });
    expect(first.claims.map((row) => row.claimId)).toEqual(["z", "y"]);
    const second = await adapter.listAutomationClaims({ automationId: SUBSCRIPTION.automationId, limit: 2, before: first.next! });
    expect(second.claims.map((row) => row.claimId)).toEqual(["a", "live"]);
    const last = await adapter.listAutomationClaims({ automationId: SUBSCRIPTION.automationId, limit: 2, before: second.next! });
    expect(last.claims.map((row) => row.claimId)).toEqual(["old"]);
    expect(last.next).toBeNull();
    expect((await adapter.getAutomationClaim({ claimId: "live" })).claim?.claimId).toBe("live");
    expect(await adapter.pruneAutomationHistory({ keep: ["live"] })).toEqual({ pruned: 3, more: true });
  });

  it("sends subscriptions to the live host, and all of them again after it restarts", async () => {
    const live = fakeLedger([]);
    const { adapter } = engine({ live, logged: new Map(), head: { value: 0 } });
    await adapter.subscribeAutomation(SUBSCRIPTION);
    expect(live.calls).toEqual([["subscribe", SUBSCRIPTION]]);
    await adapter.unsubscribeAutomation({ automationId: SUBSCRIPTION.automationId, path: "Tasks" });
    expect(live.calls.at(-1)).toEqual(["unsubscribe", { automationId: SUBSCRIPTION.automationId, path: "Tasks" }]);
    await adapter.subscribeAutomation(SUBSCRIPTION);
    // A new live host incarnation holds none of them.
    (live.ledger as { incarnation: string }).incarnation = "host-2";
    expect(adapter.waiting()).toBe(true);
    live.calls.length = 0;
    await adapter.claimNextAutomation({ automationIdPrefix: "collection:" });
    expect(live.calls).toEqual([["subscribe", SUBSCRIPTION]]);
    expect(adapter.waiting()).toBe(false);
    // The same incarnation already holds them: a drain sends nothing.
    await adapter.claimNextAutomation({ automationIdPrefix: "collection:" });
    expect(live.calls).toEqual([["subscribe", SUBSCRIPTION]]);
  });

  it("runs a live claim only once the relay logged its change and the copy pulled it, in order", async () => {
    const live = fakeLedger([claim("live-1", 11), claim("live-2", 12)]);
    const logged = new Map<number, number>();
    const head = { value: 40 };
    const { adapter, pulls } = engine({ live, logged, head });
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }), "the change has not reached the relay").toBeNull();
    expect(adapter.waiting()).toBe(true);
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }), "the next one waits behind it").toBeNull();
    logged.set(11, 41);
    head.value = 41;
    expect((await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }))?.claimId).toBe("live-1");
    expect(pulls, "the copy pulled through the change first").toEqual([41]);
    logged.set(12, 41);
    expect((await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }))?.claimId).toBe("live-2");
    expect(pulls, "a change the copy already pulled needs no second pull").toEqual([41]);
    expect(adapter.waiting()).toBe(false);
  });

  it("answers each claim to the engine that served it, and lists both engines' claims", async () => {
    const live = fakeLedger([claim("live-1", 11)]);
    const { adapter, copy } = engine({ live, logged: new Map([[11, 1]]), head: { value: 1 } });
    await adapter.claimNextAutomation({ automationIdPrefix: "collection:" });
    await adapter.settleAutomationClaim({ claimId: "live-1", state: "done" });
    expect(live.calls).toContainEqual(["settle", { claimId: "live-1", state: "done" }]);
    expect(copy.methods).not.toContain("automations.settle");
    expect((await adapter.listAutomationClaims({ automationId: "collection:Tasks#stamp" })).claims.map((row) => row.claimId))
      .toEqual(["own-new", "live-old"]);
    expect((await adapter.listAutomationFailures()).failures.map((row) => row.claimId), "the newest failure wins").toEqual(["live-old"]);
  });

  it("hands a held live claim back when the workspace closes", async () => {
    const live = fakeLedger([claim("live-1", 11)]);
    const { adapter } = engine({ live, logged: new Map(), head: { value: 0 } });
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" })).toBeNull();
    await adapter.close();
    expect(live.calls).toContainEqual(["release", { claimId: "live-1" }]);
  });

  it("hands back a live claim the executor took and never answered, as when the copy's engine stopped", async () => {
    const live = fakeLedger([claim("live-1", 11), claim("live-2", 12)]);
    const { adapter } = engine({ live, logged: new Map([[11, 1], [12, 1]]), head: { value: 1 } });
    await adapter.claimNextAutomation({ automationIdPrefix: "collection:" });
    await adapter.claimNextAutomation({ automationIdPrefix: "collection:" });
    await adapter.settleAutomationClaim({ claimId: "live-2", state: "done" });
    await adapter.close();
    expect(live.calls.filter(([call]) => call === "release")).toEqual([["release", { claimId: "live-1" }]]);
  });

  it("fails an unplaceable live claim after the first pull and continues to the next claim", async () => {
    const byHistory = { ...claim("live-1", 11), trigger: { historyId: 7 } } as unknown as AutomationClaim;
    const live = fakeLedger([byHistory, claim("live-2", 11)]);
    const { adapter, pulls } = engine({ live, logged: new Map([[11, 1]]), head: { value: 1 } });
    expect((await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }))?.claimId).toBe("live-2");
    expect(adapter.waiting()).toBe(false);
    expect(pulls).toEqual([1]);
    expect(live.calls).toContainEqual(["settle", {
      claimId: "live-1", state: "failed",
      error: "This automation could not run because the live host did not record which change triggered it. Update your dohc server, then change the record again.",
    }]);
    await adapter.close();
    expect(live.calls.filter(([call]) => call === "release")).toEqual([["release", { claimId: "live-2" }]]);
  });

  it("keeps an unplaceable claim until a pull succeeds, even with an empty relay log", async () => {
    const byHistory = { ...claim("live-1", 11), trigger: { historyId: 7 } } as unknown as AutomationClaim;
    const live = fakeLedger([byHistory]);
    let failPull = true;
    const { adapter, pulls } = engine({ live, logged: new Map(), head: { value: 0 }, sync: async () => {
      if (failPull) throw new Error("pull failed");
    } });
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" })).toBeNull();
    expect(adapter.waiting()).toBe(true);
    expect(live.calls.filter(([call]) => call === "settle")).toEqual([]);
    failPull = false;
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" })).toBeNull();
    expect(adapter.waiting()).toBe(false);
    expect(pulls).toEqual([0, 0]);
    expect(live.calls.filter(([call]) => call === "settle")).toHaveLength(1);
  });

  it("runs a live frame's claim once the settlement that carried its cursor is logged and pulled", async () => {
    const byHistory = { ...claim("live-1", 11), trigger: { historyId: 7 }, change: { ...claim("live-1", 11).change, liveCursor: 41 } } as unknown as AutomationClaim;
    const live = fakeLedger([byHistory]);
    const settled = new Map<number, number>();
    const head = { value: 50 };
    const { adapter, pulls } = engine({ live, logged: new Map(), head, settled });
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }), "no settlement has carried it yet").toBeNull();
    expect(adapter.waiting()).toBe(true);
    // The live host settled the document through cursor 41, and its moment was logged at 52.
    settled.set(41, 52);
    head.value = 52;
    expect((await adapter.claimNextAutomation({ automationIdPrefix: "collection:" }))?.claimId).toBe("live-1");
    expect(pulls, "the copy pulled through the moment first").toEqual([52]);
  });

  it("drains only its own copy while no live host runs", async () => {
    const { adapter, copy } = engine({ live: null, logged: new Map(), head: { value: 0 } });
    await adapter.subscribeAutomation(SUBSCRIPTION);
    expect(await adapter.claimNextAutomation({ automationIdPrefix: "collection:" })).toBeNull();
    expect(copy.methods).toEqual(["automations.subscribe", "automations.claimNext"]);
    expect(adapter.waiting()).toBe(false);
  });
});
