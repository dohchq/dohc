import { describe, expect, it } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { RunContext } from "./automationPlan";
import { newRun, type CollectionAutomationRunDependencies } from "./collectionAutomationRun";
import type { AutomationRunStore, RunWrite, StoredRun } from "./automationRunStore";
import { runSteps, type EffectMode, type StepBackend } from "./automationStepRun";

function fixture(count = 1) {
  const parsed = parseAutomationsFile(`version: 1
automations:
  - id: change
    name: Change
    when: record-added
    do: [${Array.from({ length: count }, () => "{set: {A: 1}}").join(", ")}]
`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("invalid fixture");
  const automation = parsed.entries[0].automation;
  const claim = { claimId: "claim", automationId: "collection:Tasks#change", collectionPath: "Tasks", createdAtMs: 1,
    change: { kind: "added" as const, fields: [], fieldsOmitted: 0 } };
  const run = newRun(claim, automation, "key", 1);
  const writes: RunWrite[] = [{ kind: "field", recordId: "record", path: "Tasks/one.md", field: "A", before: 0, after: 1 }];
  run.steps = Array.from({ length: count }, (_, ordinal) => ({ ordinal, effects: [{ kind: "set", target: {
    recordId: "record", path: "Tasks/one.md", collectionPath: "Tasks" }, fields: [{ field: "A", before: 0, after: 1 }] }] }));
  const log: string[] = [], modes: EffectMode[] = [], saves: StoredRun[] = [];
  let value = 0, engineWrites = 0, barrierFails = false;
  const keys = new Set<number>();
  const store = {
    save: async (state: StoredRun) => { log.push(`save:${state.outcome?.state ?? "open"}:${state.durableEffects}`); saves.push(structuredClone(state)); },
    appendEffect: async () => { log.push("appendEffect"); },
  } as unknown as AutomationRunStore;
  const dependencies: Pick<CollectionAutomationRunDependencies, "makeDurable" | "store" | "nowMs" | "evaluator" | "chat" | "recipientVerdicts" | "readCode"> = {
    store, nowMs: () => 2,
    makeDurable: async () => { log.push("makeDurable"); if (barrierFails) throw Error("unavailable"); },
    evaluator: { evaluate: async () => { throw Error("saved steps must not evaluate"); }, runCode: async () => { throw Error("saved steps must not evaluate"); } },
    chat: { directory: async () => null, write: async () => { throw Error("unexpected chat"); } },
    recipientVerdicts: async () => [], readCode: async () => null,
  };
  const backend: StepBackend = {
    step: async () => { throw Error("saved steps must not read"); }, collectionsOf: () => [], added: () => null,
    apply: async (_run, _effect, place) => {
      modes.push(place.mode);
      log.push(`apply:${place.index}:${place.mode}`);
      if (!keys.has(place.index) && value === 0) { value = 1; engineWrites++; log.push("write"); keys.add(place.index); }
      return structuredClone(writes);
    },
  };
  const context: RunContext = { automation, claim, message: null, person: null, chat: null, nowMs: 1, key: { claimId: "claim", hash: "key" } };
  const stopped = new AbortController();
  const execute = () => runSteps(dependencies, backend, { automation, collection: { path: "Tasks", name: "Tasks" },
    roster: { kind: "owner", ownerUserId: null, grants: [] }, signal: new AbortController().signal, stopped: stopped.signal,
    claimRun: 1, engineClaimId: "claim" }, context, run, true, { prepareMs: 0, runMs: 0 });
  return { run, log, modes, saves, backend, dependencies, stopped, execute,
    value: () => value, engineWrites: () => engineWrites,
    loseWrites: () => { value = 0; keys.clear(); }, failBarrier: (failed: boolean) => { barrierFails = failed; } };
}

describe("engine durability before run outcomes", () => {
  it.each(["barrier", "receipt"])("overlaps the final receipt and barrier, with %s finishing first", async (first) => {
    const f = fixture();
    const receipt = Promise.withResolvers<void>(), barrier = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    f.dependencies.store.appendEffect = async () => { f.log.push("append:start"); await receipt.promise; f.log.push("append:end"); };
    f.dependencies.makeDurable = async () => { f.log.push("barrier:start"); started.resolve(); await barrier.promise; f.log.push("barrier:end"); };
    const executing = f.execute();
    await started.promise;
    expect(f.log).toContain("append:start");
    expect(f.log).not.toContain("append:end");
    if (first === "barrier") barrier.resolve(); else receipt.resolve();
    await (first === "barrier" ? barrier.promise : receipt.promise);
    expect(f.saves).toEqual([]);
    receipt.resolve(); barrier.resolve();
    await expect(executing).resolves.toEqual({ kind: "done" });
    expect(f.log.at(-1)).toBe("save:done:1");
    expect(f.log).toContain("append:end"); expect(f.log).toContain("barrier:end");
  });

  it("waits for the receipt after a failed barrier without publishing an outcome", async () => {
    const f = fixture(), receipt = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    f.dependencies.store.appendEffect = async () => { await receipt.promise; f.log.push("append:end"); };
    f.dependencies.makeDurable = async () => { started.resolve(); throw Error("unavailable"); };
    let returned = false;
    const executing = f.execute().then(result => { returned = true; return result; });
    await started.promise;
    expect(returned).toBe(false); expect(f.saves).toEqual([]);
    receipt.resolve();
    await expect(executing).resolves.toEqual({ kind: "wait", reason: "engine" });
    expect(f.log).toContain("append:end");
    expect(f.run.outcome).toBeNull(); expect(f.run.durableEffects).toBe(0);
  });

  it("keeps a stop during the final receipt as a wait with durable progress", async () => {
    const f = fixture(), receipt = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    f.dependencies.store.appendEffect = async () => { await receipt.promise; f.stopped.abort(); };
    f.dependencies.makeDurable = async () => { started.resolve(); };
    const executing = f.execute();
    await started.promise;
    receipt.resolve();
    await expect(executing).resolves.toEqual({ kind: "wait", reason: "stopped" });
    expect(f.run.outcome).toBeNull(); expect(f.run.durableEffects).toBe(1);
    expect(f.saves).toHaveLength(1); expect(f.saves[0]?.outcome).toBeNull();
  });

  it("joins the barrier after a receipt failure and leaves no outcome", async () => {
    const f = fixture(), barrier = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    f.dependencies.store.appendEffect = async () => { throw Error("journal failed"); };
    f.dependencies.makeDurable = async () => { started.resolve(); await barrier.promise; };
    const executing = f.execute();
    const rejected = expect(executing).rejects.toThrow("journal failed");
    await started.promise;
    expect(f.saves).toEqual([]);
    barrier.resolve(); await rejected;
    expect(f.run.outcome).toBeNull(); expect(f.run.durableEffects).toBe(0);
  });

  it("waits for each earlier receipt before another effect can write", async () => {
    const f = fixture(2), receipt = Promise.withResolvers<void>(), appended = Promise.withResolvers<void>();
    let appends = 0;
    f.dependencies.store.appendEffect = async () => { if (++appends === 1) { appended.resolve(); await receipt.promise; } };
    const executing = f.execute();
    await appended.promise;
    expect(f.modes).toHaveLength(1);
    expect(f.log).not.toContain("makeDurable");
    receipt.resolve(); await executing;
    expect(f.modes).toHaveLength(2);
    expect(f.log.filter(call => call === "makeDurable")).toHaveLength(1);
  });

  it("syncs once after effects and before the save holding done", async () => {
    const f = fixture(2);
    await expect(f.execute()).resolves.toEqual({ kind: "done" });
    expect(f.log.slice(-2)).toEqual(["makeDurable", "save:done:2"]);
    expect(f.log.filter(call => call === "makeDurable")).toHaveLength(1);
    expect(f.saves[0]?.durableEffects).toBe(2);
  });

  it("syncs before saving a failure after a write", async () => {
    const f = fixture(2), apply = f.backend.apply;
    f.backend.apply = async (...args) => args[2].index === 1
      ? { outcome: { kind: "failed", error: "refused", timedOut: false } } : apply(...args);
    await expect(f.execute()).resolves.toMatchObject({ kind: "failed" });
    expect(f.log.slice(-2)).toEqual(["makeDurable", "save:failed:1"]);
  });

  it("leaves the header and outcome untouched when the barrier fails", async () => {
    const f = fixture(); f.failBarrier(true);
    await expect(f.execute()).resolves.toEqual({ kind: "wait", reason: "engine" });
    expect(f.run.outcome).toBeNull(); expect(f.run.durableEffects).toBe(0); expect(f.saves).toEqual([]);
  });

  it("syncs and saves the watermark when a run waits after its write", async () => {
    const f = fixture(), apply = f.backend.apply;
    f.backend.apply = async (...args) => { const result = await apply(...args); f.stopped.abort(); return result; };
    await expect(f.execute()).resolves.toEqual({ kind: "wait", reason: "stopped" });
    expect(f.log.slice(-2)).toEqual(["makeDurable", "save:open:1"]);
    expect(f.run.outcome).toBeNull(); expect(f.run.durableEffects).toBe(1);
  });

  it.each([false, true])("replays recorded effects past the watermark when retained=%s", async (retained) => {
    const f = fixture(); f.failBarrier(true);
    await f.execute();
    expect(f.run.applied).toHaveLength(1);
    const firstWrites = f.engineWrites();
    if (!retained) f.loseWrites();
    f.failBarrier(false); f.log.length = 0;
    await expect(f.execute()).resolves.toEqual({ kind: "done" });
    expect(f.modes).toEqual(["may-have-landed", "may-have-landed"]);
    expect(f.engineWrites()).toBe(firstWrites + (retained ? 0 : 1));
    expect(f.value()).toBe(1);
    expect(f.run.applied).toHaveLength(1);
    expect(f.log).not.toContain("appendEffect");
    expect(f.log.slice(-2)).toEqual(["makeDurable", "save:done:1"]);
  });

  it("does not mark unvisited recorded effects durable when a resume stops", async () => {
    const f = fixture(2); f.failBarrier(true);
    await f.execute();
    f.loseWrites(); f.failBarrier(false);
    const apply = f.backend.apply;
    f.backend.apply = async (...args) => { const result = await apply(...args); f.stopped.abort(); return result; };
    await expect(f.execute()).resolves.toEqual({kind: "wait", reason: "stopped"});
    expect(f.run.applied).toHaveLength(2);
    expect(f.run.durableEffects).toBe(1);
    expect(f.saves[0]?.durableEffects).toBe(1);
  });

  it("does not advance the mark when a resume stops before replay", async () => {
    const f = fixture(); f.failBarrier(true);
    await f.execute(); f.loseWrites(); f.failBarrier(false); f.stopped.abort();
    const barriers = f.log.filter(call => call === "makeDurable").length;
    await expect(f.execute()).resolves.toEqual({kind: "wait", reason: "stopped"});
    expect(f.run.durableEffects).toBe(0); expect(f.saves).toEqual([]);
    expect(f.log.filter(call => call === "makeDurable")).toHaveLength(barriers);
  });

  it("skips effects already covered by the watermark without another sync", async () => {
    const f = fixture(); f.run.applied = [{ ordinal: 0, writes: [] }]; f.run.durableEffects = 1;
    await f.execute();
    expect(f.modes).toEqual([]); expect(f.log).toEqual(["save:done:1"]);
  });

  it("does not sync runs with no engine writes", async () => {
    const f = fixture(); f.backend.apply = async () => [];
    await f.execute();
    expect(f.log).not.toContain("makeDurable"); expect(f.run.outcome).toEqual({ state: "done" });
  });

  it("syncs a partial engine write even when no effect was recorded", async () => {
    const f = fixture(); f.backend.needsDurability = () => true;
    f.backend.apply = async () => ({ outcome: { kind: "failed", error: "partial", timedOut: false } });
    await f.execute();
    expect(f.log).toEqual(["makeDurable", "save:failed:0"]);
  });
});
