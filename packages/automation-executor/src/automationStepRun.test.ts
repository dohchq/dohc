import type { ReachRoster } from "./automationReach";
import { describe, expect, it } from "vitest";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import type { RunContext } from "./automationPlan";
import { newRun, type CollectionAutomationRunDependencies } from "./collectionAutomationRun";
import { writeConfirmed, type AutomationRunStore, type RunWrite, type StoredRun } from "./automationRunStore";
import { runSteps, type EffectMode, type StepBackend } from "./automationStepRun";
import { documentUndoChanges } from "./collectionAutomationUndo";

function fixture(count = 1) {
  const parsed = parseAutomationsFile(`version: 1
automations:
  - id: change
    name: Change
    when: record-added
    do: [${Array.from({ length: count > 50 ? 1 : count }, () => "{set: {A: 1}}").join(", ")}]
`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw Error("invalid fixture");
  const automation = parsed.entries[0].automation;
  const claim = { claimId: "claim", automationId: "collection:Tasks#change", collectionPath: "Tasks", createdAtMs: 1,
    change: { kind: "added" as const, fields: [], fieldsOmitted: 0 } };
  const run = newRun(claim, automation, "key", 1);
  const writes: RunWrite[] = [{ kind: "field", recordId: "record", path: "Tasks/one.md", field: "A", before: 0, after: 1 }];
  run.steps = Array.from({ length: count }, (_, ordinal) => ({ ordinal, effects: [{ kind: "set", target: {
    recordId: "record", path: "Tasks/one.md", collectionPath: "Tasks" }, fields: [{ field: "A", before: 0, after: 1 }] }] }));
  if (count > 50) run.steps = [{ ordinal: 0, effects: run.steps.flatMap(step => step.effects) }];
  const log: string[] = [], modes: EffectMode[] = [], saves: StoredRun[] = [];
  let value = 0, engineWrites = 0, barrierFails = false;
  const keys = new Set<number>();
  const store = {
    save: async (state: StoredRun) => { log.push(`save:${state.outcome?.state ?? "open"}:${state.durableEffects}`); saves.push(structuredClone(state)); },
    appendEffect: async () => { log.push("appendEffect"); },
  } as unknown as AutomationRunStore;
  const dependencies: Pick<CollectionAutomationRunDependencies, "makeDurable" | "store" | "nowMs" | "evaluator" | "chat" | "recipientVerdicts" | "readCode" | "onUsageSuccess" | "beforeEffect" | "onRunEnded"> = {
    store, nowMs: () => 2,
    makeDurable: async () => { log.push("makeDurable"); if (barrierFails) throw Error("unavailable"); },
    evaluator: { evaluate: async () => { throw Error("saved steps must not evaluate"); }, runCode: async () => { throw Error("saved steps must not evaluate"); } },
    chat: { hasMessage: async () => false, directory: async () => null, write: async () => { throw Error("unexpected chat"); } },
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
  const execute = (roster: Exclude<ReachRoster, { kind: "unknown" }> = { kind: "owner", ownerUserId: null, grants: [] }, saved = true) => runSteps(dependencies, backend, { automation, collection: { path: "Tasks", name: "Tasks" },
    roster, signal: new AbortController().signal, stopped: stopped.signal,
    claimRun: 1, engineClaimId: "claim" }, context, run, saved, { prepareMs: 0, runMs: 0 });
  return { run, log, modes, saves, backend, dependencies, stopped, execute,
    value: () => value, engineWrites: () => engineWrites,
    loseWrites: () => { value = 0; keys.clear(); }, failBarrier: (failed: boolean) => { barrierFails = failed; } };
}

describe("durable replay boundaries", () => {
  it("derives unvisited engine receipts from the mark and keeps them available to Undo", async () => {
    const f = fixture(3);
    f.run.applied = f.run.steps.map(step => ({ ordinal: step.ordinal, writes: [{ kind: "created", recordId: `r${step.ordinal}`, path: `Tasks/${step.ordinal}.md` }] }));
    f.run.created = f.run.steps.map(step => ({ ordinal: step.ordinal, planned: `r${step.ordinal}`, recordId: `r${step.ordinal}`, path: `Tasks/${step.ordinal}.md` }));
    f.run.durableEffects = 1;
    f.backend.apply = async () => ({ outcome: { kind: "failed", error: "reach changed", timedOut: false } });
    await expect(f.execute()).resolves.toMatchObject({ kind: "failed" });
    expect(f.run.applied.map((effect, index) => writeConfirmed(f.run, index, effect.writes[0]!))).toEqual([true, false, false]);
    expect([...documentUndoChanges([f.run]).added.keys()]).toEqual(["r0", "r1", "r2"]);
    expect(f.saves.at(-1)?.outcome?.state).toBe("failed");
    expect(f.log).not.toContain("makeDurable");
  });

  it("checks a newly planned resumed message step before sending Alice's message when Bob lost reach", async () => {
    const f = fixture();
    f.run.steps = [];
    const effects = ["Alice", "Bob"].map(name => ({ kind: "message" as const, effectId: name, messageId: name, threadId: name,
      body: "Hello", name, channelWireId: name, to: { kind: "direct-message" as const, userId: name, threadId: name }, byFormula: false }));
    f.backend.step = (async () => ({ step: { ordinal: 0, effects } })) as StepBackend["step"];
    f.dependencies.store.appendStep = async () => { f.log.push("appendStep"); };
    const roster = { kind: "owner" as const, ownerUserId: "owner", grants: [{ grantId: "Alice", recipientUserId: "Alice", recipientEmail: "alice@example.com",
      files: { paths: ["Tasks"], versionId: null, access: "edit" as const }, channel: { wireId: "Alice", canPost: true } }] };
    await expect(f.execute(roster)).resolves.toMatchObject({ kind: "failed", error: "alice@example.com cannot post in Bob." });
    expect(f.modes).toEqual([]);
    expect(f.run.applied).toEqual([]);
  });

  it.each(["field", "created", "message", "kept", "skipped", "notice", "dataset-edit", "dataset-created", "dataset-action"] as const)("confirms each recorded %s write according to its storage", kind => {
    const f = fixture();
    const write = { kind } as RunWrite;
    expect(writeConfirmed(f.run, 0, write)).toBe(!["field", "created", "message"].includes(kind));
    f.run.durableEffects = 1;
    expect(writeConfirmed(f.run, 0, write)).toBe(true);
  });

  it.each(["kept", "skipped", "notice", "dataset-edit", "dataset-created", "dataset-action"])("does not replay a recorded %s receipt", async kind => {
    const f = fixture();
    f.run.applied = [{ ordinal: 0, writes: [{ kind } as RunWrite] }];
    await expect(f.execute()).resolves.toEqual({ kind: "done" });
    expect(f.modes).toEqual([]); expect(f.engineWrites()).toBe(0);
    expect(f.log).not.toContain("makeDurable");
  });

  it("replays only written fields of a mixed written/kept effect", async () => {
    const f = fixture(), effect = f.run.steps[0]!.effects[0]!;
    if (effect.kind !== "set") throw Error("expected set");
    effect.fields.push({ field: "B", before: 0, after: 1 });
    f.run.applied = [{ ordinal: 0, writes: [
      { kind: "field", recordId: "record", path: "Tasks/one.md", field: "A", before: 0, after: 1 },
      { kind: "kept", recordId: "record", path: "Tasks/one.md", field: "B", planned: 1, current: 2 },
    ] }];
    const apply = f.backend.apply;
    f.backend.apply = async (...args) => {
      expect(args[1].kind === "set" && args[1].fields.map(field => field.field)).toEqual(["A"]);
      return apply(...args);
    };
    await f.execute();
    expect(f.run.applied[0]?.writes.filter(write => write.kind === "kept")).toHaveLength(1);
  });

  it("marks every 50 engine effects once at least two seconds have elapsed", async () => {
    const f = fixture(200), apply = f.backend.apply;
    let now = 0;
    f.dependencies.nowMs = () => now;
    f.backend.apply = async (...args) => { now += 50; return apply(...args); };
    await f.execute();
    expect(f.saves.map(run => run.durableEffects)).toEqual([50, 100, 150, 200, 200]);
    expect(f.log.filter(call => call === "makeDurable")).toHaveLength(4);
  });

  it("keeps a short 200-effect run to one final barrier", async () => {
    const f = fixture(200);
    await f.execute();
    expect(f.log.filter(call => call === "makeDurable")).toHaveLength(1);
  });

  it("waits after a failed periodic barrier without retrying or publishing progress", async () => {
    const f = fixture(51), apply = f.backend.apply;
    let now = 0;
    f.dependencies.nowMs = () => now;
    f.backend.apply = async (...args) => { now += 50; return apply(...args); };
    f.failBarrier(true);
    await expect(f.execute()).resolves.toEqual({ kind: "wait", reason: "engine" });
    expect(f.run.durableEffects).toBe(0); expect(f.saves).toEqual([]);
    expect(f.log.filter(call => call === "makeDurable")).toHaveLength(1);
    expect(f.modes).toHaveLength(50);
  });
});

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

describe("what a run tells its host before it changes anything and when it ends", () => {
  const hooked = (f: ReturnType<typeof fixture>) => {
    f.dependencies.beforeEffect = (_run, effect) => { f.log.push(`before:${effect.kind}`); };
    f.dependencies.onRunEnded = (run) => { f.log.push(`ended:${run.outcome?.state}`); };
  };

  it("tells before a fresh run's first effect, after saving its step with the run", async () => {
    const f = fixture();
    hooked(f);
    const [step] = f.run.steps;
    f.run.steps = [];
    f.backend.step = (async () => ({ step: structuredClone(step!) })) as StepBackend["step"];
    f.dependencies.store.appendStep = async () => { f.log.push("appendStep"); };
    await expect(f.execute(undefined, false)).resolves.toEqual({ kind: "done" });
    expect(f.log).toEqual(["save:open:0", "before:set", "apply:0:fresh", "write", "appendEffect", "makeDurable", "save:done:1", "ended:done"]);
  });

  it("ends a resumed run only at its final save, not at the saves of its progress", async () => {
    const f = fixture(51), apply = f.backend.apply;
    hooked(f);
    f.run.outcome = { state: "failed", error: "refused", run: 1, step: 0 };
    f.run.finishedAtMs = 1;
    let now = 0;
    f.dependencies.nowMs = () => now;
    f.backend.apply = async (...args) => { now += 50; return apply(...args); };
    await expect(f.execute()).resolves.toEqual({ kind: "done" });
    expect(f.log.filter(entry => entry.startsWith("save") || entry.startsWith("ended"))).toEqual(["save:failed:50", "save:done:51", "ended:done"]);
    expect(f.log.filter(entry => entry === "before:set")).toHaveLength(51);
  });

  it("does not end a run that waits", async () => {
    const f = fixture(), apply = f.backend.apply;
    hooked(f);
    f.backend.apply = async (...args) => { const result = await apply(...args); f.stopped.abort(); return result; };
    await expect(f.execute()).resolves.toEqual({ kind: "wait", reason: "stopped" });
    expect(f.log.slice(-2)).toEqual(["makeDurable", "save:open:1"]);
  });
});

describe("automation usage completion", () => {
  it.each(["dataset-edit", "dataset-create"] as const)("counts a successful %s as the corresponding Collection action", async kind => {
    const f = fixture();
    const calls: Array<{ capabilityId: string; door: string }> = [];
    f.dependencies.onUsageSuccess = pair => { calls.push(pair); };
    const rules = { datasetId: "dataset", revision: 1, revisionSha256: "hash" };
    f.run.steps = [{ ordinal: 0, effects: Array.from({ length: 2 }, () => kind === "dataset-edit"
      ? { kind, rules, operationId: "edit", tableId: "table", target: { recordId: "record", version: 1 },
        fields: [{ fieldId: "A", field: "A", before: 0, after: 1 }] }
      : { kind, rules, operationId: "create", tableId: "table", values: [{ fieldId: "A", field: "A", value: 1 }], deletes: [] }) }];
    f.backend.apply = async () => kind === "dataset-edit"
      ? [{ kind, rules, operationId: "edit", tableId: "table", recordId: "record", expectedVersion: 1, version: 2,
        fields: [{ fieldId: "A", field: "A", before: 0, after: 1 }] }]
      : [{ kind: "dataset-created", rules, operationId: "create", tableId: "table", recordId: "record", version: 1, deletes: [] }];
    expect(await f.execute()).toEqual({ kind: "done" });
    expect(calls).toEqual([{ capabilityId: kind === "dataset-edit" ? "collection.record.edit" : "collection.record.create", door: "automation" }]);
  });

  it("waits for durability and saved completion, and preserves success if the observer throws", async () => {
    const f = fixture();
    const calls: Array<{ capabilityId: string; door: string }> = [];
    f.dependencies.onUsageSuccess = pair => {
      expect(f.saves.at(-1)?.outcome).toEqual({ state: "done" });
      calls.push(pair);
      throw Error("record unavailable");
    };
    f.failBarrier(true);
    expect(await f.execute()).toEqual({ kind: "wait", reason: "engine" });
    expect(calls).toEqual([]);
    f.failBarrier(false);
    expect(await f.execute()).toEqual({ kind: "done" });
    expect(calls).toEqual([{ capabilityId: "collection.record.edit", door: "automation" }]);
  });
});
