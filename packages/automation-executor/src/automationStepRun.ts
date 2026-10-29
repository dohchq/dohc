import { isEngineStoreBusyRefusal } from "@dohc/workspace-engine-client";
import { prepareRecordBackend, type RecordRunDependencies, type RecordRunInput, type RunSource } from "./automationRecordBackend";
import { AutomationRunWait } from "./automationRunWait";
import { automationUsageInvocations } from "./automationUsage";
import type { AutomationTimeSpent, JsonValue } from "@dohc/app-backend-runtime/automation";
import {
  answersOf,
  bindingsIn,
  codeChangesOf,
  evaluateRequest,
  fieldWriteCount,
  filterValues,
  findRequest,
  formulaPeople,
  MAX_RUN_FIELD_WRITES,
  namesUsed,
  orderSteps,
  planStep,
  refOf,
  stepRequest,
  tooManyWritesError,
  unavailableTo,
  type Bound,
  type CodeChange,
  type FindValue,
  type OrderedStep,
  type PlannedEffect,
  type RunContext,
  type RunRecord,
  type RunRef,
} from "./automationPlan";
import { chatNeedsOf, AutomationChatSessionWait, type ChatDirectory } from "./automationChat";
import type { ReachCollection, ReachRoster } from "./automationReach";
import { engineWrite, RUN_PLAN_BUDGET_BYTES, type RunWrite, type StoredRun, type StoredStep } from "./automationRunStore";
import {
  startRun,
  checkPlannedMessages,
  DEADLINE_ERROR,
  UNREADABLE_RUN_ERROR,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunOutcome,
} from "./collectionAutomationRun";

// Runs a run's steps in order, for both kinds of Collection. Each step reads
// what it needs once the steps before it have landed, evaluates, and is saved
// before its first effect; then its effects land in order, each saved as it
// lands. A run that stops part way resumes here: steps already saved are not
// evaluated again, the step that stopped lands its remaining effects, and the
// steps after it read and evaluate as if the run had not stopped.
//
// Nothing is saved until the first step that changes something. A run that
// stops before then wrote nothing, so the next attempt starts it over,
// conditions and all.

// A record that keeps changing while a step reads it stops the run rather than loop.
export const MAX_REREADS = 5;
export const KEPT_CHANGING_ERROR = "The record kept changing while this automation ran. Try again.";
export const tooLargeError = (ordinal: number) =>
  `Step ${ordinal + 1} would make this run change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations.`;

/** A record changed between two of one step's reads of it: the step reads again. */
export class StepRecordChanged extends Error {}

/** The reads one step makes through its Collection's own reads. */
export interface StepReads {
  destinations?(ordinal: number): NonNullable<StoredStep["destinations"]>;
  /** The trigger record as it is now; null when the run has none or it is gone. */
  trigger(): Promise<RunRecord | null>;
  /** The records a Find or an Add record step at `ordinal` gave, as they are now. A record that is gone is left out. */
  bound(ordinal: number, refs: readonly RunRef[]): Promise<RunRecord[]>;
  /** What the Find at `ordinal` compares each field it checks with. */
  findValues(ordinal: number): readonly FindValue[];
  /** The records the Find at `ordinal` matches now, with its filters' values, or why it cannot read them all. */
  find(ordinal: number, values: readonly JsonValue[]): Promise<RunRecord[] | { problem: string }>;
  /** Checks what a code step changes, then reads each record it changes by id. */
  codeRecords(changes: readonly CodeChange[], inputs: { record: RunRecord | null }): Promise<{ records: Map<string, RunRecord> } | { outcome: CollectionAutomationRunOutcome }>;
  /** A step's planned effects as the run saves them, or why they cannot run. */
  effects(ordinal: number, planned: readonly PlannedEffect[]): StoredStep["effects"] | { problem: string };
}

/** How a run's steps read and write one kind of Collection. */
export interface StepBackend {
  /** Whether this approved action can write. Unknown actions are not counted. */
  isWriteAction?(effect: Extract<StoredStep["effects"][number], { kind: "dataset-action" }>): boolean;
  /** A write may have landed even if applying its effect failed before recording it. */
  needsDurability?(): boolean;
  madeDurable?(): void;
  /**
   * Runs one step's reads. Null when the Collection's store is not open;
   * "changed" when a record changed between two of the step's reads of it.
   */
  step<T>(work: (reads: StepReads) => Promise<T>): Promise<T | null | "changed">;
  /** Each document Collection a step writes, by its Collection id; none for a dataset. */
  collectionsOf(step: StoredStep): StoredRun["collections"];
  /** The record the Add record step at `ordinal` added, from what the run recorded. */
  added(run: StoredRun, ordinal: number): RunRef | null;
  /** Lands one effect and says what it did, or how the run ends instead. */
  apply(
    run: StoredRun,
    effect: StoredStep["effects"][number],
    place: { index: number; ordinal: number; part: number; mode: EffectMode; recorded?: boolean },
    chat: ChatDirectory | null,
  ): Promise<RunWrite[] | { outcome: CollectionAutomationRunOutcome }>;
}

/**
 * How an effect's writes are recorded. Every field write lands only on its
 * planned before value. One this attempt planned is recorded as it lands;
 * the first effect an earlier attempt had not recorded may already have
 * landed; the others an earlier attempt planned find their field as someone
 * left it.
 */
export type EffectMode = "fresh" | "may-have-landed" | "resumed";

export interface StepRunInput {
  automation: RunContext["automation"];
  collection: ReachCollection;
  roster: Exclude<ReachRoster, { kind: "unknown" }>;
  signal: AbortSignal;
  stopped: AbortSignal;
  /** The claim's run: 1, plus one per Try again. */
  claimRun: number;
  engineClaimId?: string;
}

const failed = (error: string, timedOut = false): CollectionAutomationRunOutcome => ({ kind: "failed", error, timedOut });
const stopped: CollectionAutomationRunOutcome = { kind: "wait", reason: "stopped" };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The saved step whose effects an earlier attempt had not all recorded, or
 * null. The runner checks it can still land them before the run goes on.
 */
export function unfinishedStep(run: StoredRun): StoredStep | null {
  let planned = 0;
  for (const step of run.steps) {
    planned += step.effects.length;
    if (planned > run.applied.length) return step;
  }
  return null;
}

/**
 * The first effect a stopped run had not recorded, with its step, or null.
 * It may have landed before the run stopped; no later effect started.
 */
export function unrecordedEffect(run: StoredRun): { ordinal: number; effect: StoredStep["effects"][number] } | null {
  let first = 0;
  for (const step of run.steps) {
    const index = run.applied.length - first;
    if (index < step.effects.length) return { ordinal: step.ordinal, effect: step.effects[index]! };
    first += step.effects.length;
  }
  return null;
}

/** An earlier step's result, as the run knows it without reading. */
type Done =
  | { kind: "find"; ordinal: number; refs: readonly RunRef[] }
  | { kind: "add"; ordinal: number; ref: RunRef | null }
  | { kind: "code"; value: JsonValue };

function replayEffect(effect: StoredStep["effects"][number], writes: readonly RunWrite[]): StoredStep["effects"][number] {
  const fields = new Set(writes.flatMap(write => write.kind === "field" ? [write.field] : []));
  if (effect.kind === "set") return { ...effect, fields: effect.fields.filter(field => fields.has(field.field)) };
  if (effect.kind === "add") return { ...effect, fields: effect.fields.filter(field => fields.has(field.field)) };
  return effect;
}

type RunProgress = {
  effects: number;
  engineEffects: number;
  syncFailed: boolean;
  append: Promise<{ error: unknown } | null> | null;
  checkpoint(): Promise<boolean>;
};

async function finishEffectAppend(progress: RunProgress): Promise<void> {
  const append = progress.append;
  progress.append = null;
  const result = await append;
  if (result) throw result.error;
}

/**
 * Runs the steps of `run`, which is saved when `saved` is true, and ends it:
 * a run that is done or failed is saved with its outcome, and one that waits
 * keeps its progress for the next drain.
 */
export async function runSteps(
  dependencies: StepRunDependencies,
  backend: StepBackend,
  input: StepRunInput,
  ctx: RunContext,
  run: StoredRun,
  saved: boolean,
  /** The run's evaluator time, which every step goes on counting. */
  spent: AutomationTimeSpent,
): Promise<CollectionAutomationRunOutcome> {
  const mark = run.durableEffects;
  let lastDurableAt = dependencies.nowMs();
  const sync = async () => {
    const engineWrites = backend.needsDurability?.() || run.applied.slice(run.durableEffects, progress.effects)
      .some(({ writes }) => writes.some(engineWrite));
    // The receipt and WAL sync different files. Own both through completion.
    const [durable, appended] = await Promise.allSettled([
      (async () => { if (engineWrites) await dependencies.makeDurable(input.engineClaimId); })(),
      finishEffectAppend(progress),
    ]);
    if (appended.status === "rejected") throw appended.reason;
    if (durable.status === "rejected") { progress.syncFailed = true; return false; }
    backend.madeDurable?.();
    return true;
  };
  const progress: RunProgress = { effects: mark, engineEffects: 0, syncFailed: false, append: null,
    async checkpoint() {
      // Bound crash replay without syncing short runs or every effect.
      if (progress.engineEffects < 50 || dependencies.nowMs() - lastDurableAt < 2000) return true;
      if (!await sync()) return false;
      await dependencies.store.save({ ...run, durableEffects: progress.effects });
      run.durableEffects = progress.effects;
      progress.engineEffects = 0;
      lastDurableAt = dependencies.nowMs();
      return true;
    },
  };
  let outcome: Awaited<ReturnType<typeof walkSteps>>;
  try {
    outcome = await walkSteps(dependencies, backend, input, ctx, run, saved, spent, progress);
  } catch (error) {
    await finishEffectAppend(progress).catch(() => {});
    throw error;
  }
  if (progress.syncFailed || !await sync()) return { kind: "wait", reason: "engine" };
  if (outcome.kind === "done" && input.stopped.aborted) outcome = { kind: "wait", reason: "stopped" };
  const durableEffects = progress.effects;
  if (outcome.kind === "wait") {
    if (durableEffects > mark) {
      await dependencies.store.save({ ...run, durableEffects });
      run.durableEffects = durableEffects;
    }
    return outcome;
  }
  // A step that failed before anything was saved changed nothing.
  if (outcome.kind !== "done" && !outcome.saved) return outcome.outcome;
  run.durableEffects = durableEffects;
  if (outcome.kind === "done") {
    run.outcome = { state: "done" };
  } else if (outcome.outcome.kind === "failed") {
    run.outcome = { state: "failed", error: outcome.outcome.error, run: input.claimRun, step: outcome.step };
  }
  run.finishedAtMs = dependencies.nowMs();
  await dependencies.store.save(run);
  dependencies.onRunEnded?.(run);
  if (dependencies.onUsageSuccess && outcome.kind === "done") {
    for (const invocation of automationUsageInvocations(run, effect => backend.isWriteAction?.(effect) === true)) {
      // Measurement must not change a run's result.
      try { dependencies.onUsageSuccess(invocation); } catch {}
    }
  }
  return outcome.kind === "done" ? outcome : outcome.outcome;
}

/** What running steps needs besides a backend. */
type StepRunDependencies = Pick<CollectionAutomationRunDependencies, "makeDurable" | "evaluator" | "store" | "nowMs" | "chat" | "recipientVerdicts" | "readCode" | "onUsageSuccess" | "beforeEffect" | "onRunEnded">;

/** The text of the code file a run-file step runs, or why it cannot run. */
export async function readCodeFile(
  dependencies: Pick<CollectionAutomationRunDependencies, "readCode">,
  collectionPath: string,
  ordinal: number,
  file: string,
): Promise<string | { problem: string }> {
  const path = `${collectionPath}/${file}`;
  const read = await dependencies.readCode(path);
  if (read === null) return { problem: `Step ${ordinal + 1} runs ${path}, and dohc cannot find that file.` };
  if (read.truncated) return { problem: `Step ${ordinal + 1} runs ${path}, which is too large to run.` };
  return read.text;
}

async function walkSteps(
  dependencies: StepRunDependencies,
  backend: StepBackend,
  input: StepRunInput,
  ctx: RunContext,
  run: StoredRun,
  wasSaved: boolean,
  spent: AutomationTimeSpent,
  progress: RunProgress,
): Promise<{ kind: "done" } | { kind: "wait"; reason: Extract<CollectionAutomationRunOutcome, { kind: "wait" }>["reason"] } | { kind: "ended"; outcome: CollectionAutomationRunOutcome; saved: boolean; step: number }> {
  const { automation } = input;
  const { store } = dependencies;
  let saved = wasSaved;
  const bindings = bindingsIn(automation);
  const done = new Map<string, Done>();
  const savedSteps = new Map(run.steps.map((step) => [step.ordinal, step]));
  // Only the first effect an earlier attempt left unrecorded may have landed.
  const firstUnrecorded = run.applied.length;
  const durableEffects = run.durableEffects;
  let reused = 0;
  let effectIndex = 0;
  let fieldWrites = run.steps.reduce((count, step) => count + fieldWriteCount(step.effects), 0);
  // Each step and its effects' records, as the run's files will hold them.
  const sizeOf = (step: StoredStep) => 2 * Buffer.byteLength(JSON.stringify(step));
  let bytes = run.steps.reduce((total, step) => total + sizeOf(step), Buffer.byteLength(JSON.stringify({ ...run, steps: [] })));

  // The step the walk is at, which a run that fails names.
  let at = 0;
  type End = { kind: "wait"; reason: Extract<CollectionAutomationRunOutcome, { kind: "wait" }>["reason"] } | { kind: "ended"; outcome: CollectionAutomationRunOutcome; saved: boolean; step: number };
  const end = (outcome: CollectionAutomationRunOutcome): End =>
    outcome.kind === "wait" ? { kind: "wait", reason: outcome.reason } : { kind: "ended", outcome, saved, step: at };

  const prepare = async (entry: OrderedStep): Promise<{ step: StoredStep } | { outcome: CollectionAutomationRunOutcome }> => {
    const { ordinal, step } = entry;
    const timing = { findMs: 0, planMs: 0 };
    let stage: keyof typeof timing = "findMs";
    let since = dependencies.nowMs();
    const enter = (next: keyof typeof timing) => {
      const now = dependencies.nowMs();
      timing[stage] += Math.max(0, now - since);
      stage = next;
      since = now;
    };
    // A code file is read when its step starts; a saved step never reads it again.
    let source: string | undefined;
    if (step.kind === "run-file") {
      const read = await readCodeFile(dependencies, input.collection.path, ordinal, step.file);
      if (typeof read !== "string") return { outcome: failed(read.problem) };
      source = read;
    }
    enter("planMs");
    const names = namesUsed(step);
    // A result the step cannot read yet stops it with why when it reads it.
    const unavailable = unavailableTo(ordinal, bindings, new Set(done.keys()), names);
    for (let rereads = 0; ; rereads += 1) {
      enter("findMs");
      const result = await backend.step(async (reads): Promise<{ step: StoredStep } | { outcome: CollectionAutomationRunOutcome }> => {
        const record = await reads.trigger();
        const bound = new Map<string, Bound>();
        for (const [name, result] of done) {
          if (names !== "all" && !names.has(name)) continue;
          if (result.kind === "code") bound.set(name, { kind: "code", value: result.value });
          else if (result.kind === "find") bound.set(name, { kind: "find", records: await reads.bound(result.ordinal, result.refs) });
          else bound.set(name, { kind: "add", record: result.ref === null ? null : ((await reads.bound(result.ordinal, [result.ref]))[0] ?? null) });
        }
        enter("planMs");
        const inputs = { record, bound, unavailable };
        if (step.kind === "find") {
          const values = reads.findValues(ordinal);
          const request = findRequest(ctx, ordinal, inputs, values);
          const results = request.items.length === 0 ? [] : await evaluateRequest(dependencies.evaluator, ctx.claim.automationId, request, spent);
          if (results === "busy") return { outcome: { kind: "wait", reason: "busy" } };
          const answers = answersOf(request, results);
          if ("error" in answers) return { outcome: failed(answers.error, answers.timedOut) };
          const filters = filterValues(values, record, answers);
          enter("findMs");
          const found = await reads.find(ordinal, filters);
          enter("planMs");
          if ("problem" in found) return { outcome: failed(found.problem) };
          return { step: { ordinal, ...(reads.destinations ? { destinations: reads.destinations(ordinal) } : {}), effects: [], output: { kind: "find", records: found.map(refOf) } } };
        }
        const request = stepRequest(ctx, entry, inputs, source);
        const results = await evaluateRequest(dependencies.evaluator, ctx.claim.automationId, request, spent);
        if (results === "busy") return { outcome: { kind: "wait", reason: "busy" } };
        const answers = answersOf(request, results);
        if ("error" in answers) return { outcome: failed(answers.error, answers.timedOut) };
        const codeChanges = codeChangesOf(request, results, ctx.claim.collectionPath);
        if ("problem" in codeChanges) return { outcome: failed(codeChanges.problem) };
        let codeRecords = new Map<string, RunRecord>();
        if (codeChanges.length > 0) {
          enter("findMs");
          const checked = await reads.codeRecords(codeChanges, inputs);
          enter("planMs");
          if ("outcome" in checked) return checked;
          codeRecords = checked.records;
        }
        // Only the conversations of the people the step's formulas named are read.
        let chat = ctx.chat;
        const named = formulaPeople(request, results);
        if (named.length > 0) {
          const needs = chatNeedsOf([automation]);
          for (const userId of named) needs.people.add(userId);
          enter("findMs");
          chat = await dependencies.chat.directory(input.roster, needs);
          enter("planMs");
          if (chat === null) return { outcome: { kind: "wait", reason: "engine" } };
        }
        const planned = planStep(ctx, entry, inputs, answers, { chat, codeChanges, codeRecords });
        if ("problem" in planned) return { outcome: failed(planned.problem) };
        const effects = reads.effects(ordinal, planned.step.effects);
        if ("problem" in effects) return { outcome: failed(effects.problem) };
        return { step: { ordinal, ...(reads.destinations ? { destinations: reads.destinations(ordinal) } : {}), effects, ...(planned.step.output ? { output: planned.step.output } : {}) } };
      });
      if (result === null) return { outcome: { kind: "wait", reason: "engine" } };
      if (result !== "changed") {
        enter(stage);
        if ("step" in result) Object.assign(result.step, timing, { appendMs: 0, appendCount: 0 });
        return result;
      }
      if (input.signal.aborted) return { outcome: failed(DEADLINE_ERROR, true) };
      if (rereads >= MAX_REREADS) return { outcome: failed(KEPT_CHANGING_ERROR) };
    }
  };

  // Lands the effects of `step` this attempt has not recorded.
  const land = async (step: StoredStep, fresh: boolean): Promise<CollectionAutomationRunOutcome | null> => {
    const first = effectIndex;
    effectIndex += step.effects.length;
    const recorded = run.applied.filter((effect) => effect.ordinal === step.ordinal).length;
    // A crash can leave durable effects whose append timing was never saved.
    if (step.appendCount !== recorded) {
      delete step.appendMs;
      delete step.appendCount;
    }
    if (effectIndex <= durableEffects) return null;
    // Check newly planned steps together before sending any message or notice.
    const unsent = { ...step, effects: step.effects.filter((_effect, part) => first + part >= firstUnrecorded) };
    const messages = fresh || !wasSaved ? await checkPlannedMessages(dependencies, { automationId: ctx.claim.automationId, automation, collection: input.collection, roster: input.roster }, [unsent], ctx.chat) : { chat: ctx.chat };
    if ("outcome" in messages) return messages.outcome;
    for (const [part, effect] of step.effects.entries()) {
      const index = first + part;
      if (index < durableEffects) continue;
      const recorded = index < firstUnrecorded;
      const receipt = recorded ? run.applied[index]! : null;
      if (receipt !== null && !receipt.writes.some(engineWrite)) {
        progress.effects = index + 1;
        continue;
      }
      if (input.stopped.aborted) return stopped;
      if (input.signal.aborted) return failed(DEADLINE_ERROR, true);
      // Keep at most one effect without a durable receipt, as resume expects.
      await finishEffectAppend(progress);
      if (input.stopped.aborted) return stopped;
      if (input.signal.aborted) return failed(DEADLINE_ERROR, true);
      const mode: EffectMode = recorded ? "may-have-landed" : fresh ? "fresh" : index === firstUnrecorded ? "may-have-landed" : "resumed";
      let writes: RunWrite[];
      const writeStarted = dependencies.nowMs();
      try {
        dependencies.beforeEffect?.(run, effect);
        const applied = await backend.apply(run, receipt === null ? effect : replayEffect(effect, receipt.writes), { index, ordinal: step.ordinal, part, mode, recorded }, messages.chat);
        if ("outcome" in applied) return applied.outcome;
        writes = receipt === null ? applied : [...receipt.writes.filter(write => !engineWrite(write)), ...applied];
      } catch (error) {
        if (isEngineStoreBusyRefusal(error)) return { kind: "wait", reason: "busy" };
        if (error instanceof AutomationRunWait) return { kind: "wait", reason: error.reason };
        if (input.stopped.aborted) return stopped;
        // A synced workspace with no session waits for one: a post written now would reach nobody.
        if (error instanceof AutomationChatSessionWait) return { kind: "wait", reason: "session" };
        return input.signal.aborted ? failed(DEADLINE_ERROR, true) : failed(errorText(error));
      }
      const landed = { ordinal: step.ordinal, writes, writeMs: Math.max(0, dependencies.nowMs() - writeStarted), writeCount: 1 };
      const appendStarted = dependencies.nowMs();
      if (recorded) {
        progress.effects = index + 1;
        run.applied[index] = landed;
        if (writes.some(engineWrite)) progress.engineEffects++;
        if (!await progress.checkpoint()) return { kind: "wait", reason: "engine" };
        continue;
      }
      progress.append = store.appendEffect(run, landed).then(() => {
        const appendMs = Math.max(0, dependencies.nowMs() - appendStarted);
        if (step.appendMs !== undefined && step.appendCount !== undefined) {
          step.appendMs += appendMs;
          step.appendCount += 1;
        }
        return null;
      }, (error: unknown) => ({ error }));
      run.applied.push(landed);
      progress.effects = index + 1;
      if (writes.some(engineWrite)) progress.engineEffects++;
      if (!await progress.checkpoint()) return { kind: "wait", reason: "engine" };
    }
    return null;
  };

  const walk = async (entries: readonly OrderedStep[]): Promise<End | null> => {
    for (const entry of entries) {
      const { ordinal } = entry;
      at = ordinal;
      if (input.stopped.aborted) return end(stopped);
      if (input.signal.aborted) return end(failed(DEADLINE_ERROR, true));
      let step = savedSteps.get(ordinal) ?? null;
      const fresh = step === null;
      if (step !== null) {
        reused += 1;
      } else {
        await finishEffectAppend(progress);
        // Saved steps run first, in order; one this walk never reached means the run is not this automation's.
        if (reused < run.steps.length) return end(failed(UNREADABLE_RUN_ERROR));
        let prepared: Awaited<ReturnType<typeof prepare>>;
        try {
          prepared = await prepare(entry);
        } catch (error) {
          if (isEngineStoreBusyRefusal(error)) return end({ kind: "wait", reason: "busy" });
          if (error instanceof AutomationRunWait) return end({ kind: "wait", reason: error.reason });
          return end(input.stopped.aborted ? stopped : input.signal.aborted ? failed(DEADLINE_ERROR, true) : failed(errorText(error)));
        }
        if (input.stopped.aborted) return end(stopped);
        if (input.signal.aborted) return end(failed(DEADLINE_ERROR, true));
        if ("outcome" in prepared) return end(prepared.outcome);
        step = prepared.step;
        // Checked before the step writes: earlier steps stay landed and undoable.
        fieldWrites += fieldWriteCount(step.effects);
        if (fieldWrites > MAX_RUN_FIELD_WRITES) return end(failed(tooManyWritesError(ordinal)));
        bytes += sizeOf(step);
        if (bytes > RUN_PLAN_BUDGET_BYTES) return end(failed(tooLargeError(ordinal)));
        run.steps.push(step);
        reused += 1;
        // Saved before its first effect, so a run that stops part way lands
        // these effects and evaluates the step no more.
        // A Collection the step writes that the run does not name yet is
        // saved with the step, so a move is followed by its Collection id.
        const known = new Set(run.collections.map(({ collectionId }) => collectionId));
        const joined = backend.collectionsOf(step).filter(({ collectionId }) => !known.has(collectionId));
        if (joined.length > 0) {
          step.collections = joined;
          run.collections.push(...joined);
        }
        if (saved) {
          await store.appendStep(run, step);
        } else if (step.effects.length > 0) {
          await store.save(run);
          saved = true;
        }
      }
      const landed = await land(step, fresh);
      if (landed !== null) return end(landed);
      const { output } = step;
      if ("then" in entry) {
        if (output?.kind !== "if") return end(failed(UNREADABLE_RUN_ERROR));
        const branched = await walk(output.branch ? entry.then : entry.otherwise);
        if (branched !== null) return branched;
        continue;
      }
      const as = "as" in entry.step ? entry.step.as : null;
      if (as === null) continue;
      if (entry.step.kind === "find") {
        if (output?.kind !== "find") return end(failed(UNREADABLE_RUN_ERROR));
        done.set(as, { kind: "find", ordinal, refs: output.records });
      } else if (entry.step.kind === "add-record") {
        done.set(as, { kind: "add", ordinal, ref: backend.added(run, ordinal) });
      } else if (entry.step.kind === "run" || entry.step.kind === "run-file") {
        if (output?.kind !== "code") return end(failed(UNREADABLE_RUN_ERROR));
        done.set(as, { kind: "code", value: output.value });
      }
    }
    return null;
  };

  const ended = await walk(orderSteps(automation.do));
  // A stop that came during the last write or its record leaves the run to
  // the next drain, which finds every effect recorded and completes it.
  if (ended === null) return input.stopped.aborted ? { kind: "wait", reason: "stopped" } : { kind: "done" };
  return ended;
}

/** Both source runners use this coordinator and its destination-routed backend. */
export async function coordinateSourceRun(
  dependencies: RecordRunDependencies, input: RecordRunInput, source: RunSource,
): Promise<CollectionAutomationRunOutcome> {
  try {
    const prepared = await prepareRecordBackend(dependencies, input, source);
    if ("outcome" in prepared) return prepared.outcome;
    const { backend, ctx, state, resuming } = prepared;
    const spent = { prepareMs: 0, runMs: 0 };
    if (!resuming) {
      let started: CollectionAutomationRunOutcome | null;
      try { started = await startRun(dependencies.evaluator, backend, ctx, spent); }
      catch (error) {
        if (error instanceof AutomationRunWait || isEngineStoreBusyRefusal(error)) throw error;
        return failed(errorText(error));
      }
      if (started !== null) return input.stopped.aborted ? stopped : started;
    }
    return await runSteps(dependencies, backend, { ...input, claimRun: input.claim.run, engineClaimId: source.engineClaim?.claimId }, ctx, state, resuming, spent);
  } catch (error) {
    if (isEngineStoreBusyRefusal(error)) return { kind: "wait", reason: "busy" };
    if (error instanceof AutomationRunWait) return { kind: "wait", reason: error.reason };
    throw error;
  }
}
