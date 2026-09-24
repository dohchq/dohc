import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { Automation } from "@dohc/workspace-contracts/automations";
import type {
  CollectionGetRecordParams,
  CollectionGetRecordResult,
  CollectionQueryParams,
  CollectionQueryResult,
} from "@dohc/workspace-contracts/collection";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import {
  createCollectionRecord,
  setCollectionRecordFields,
  type CollectionRecordEditContext,
  type SetCollectionRecordFieldsResult,
} from "../workspaces/collectionRecordEdits";
import type { AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import {
  definitionHash,
  evaluationRequest,
  findsOf,
  MAX_FOUND_RECORDS,
  planRun,
  reachStepsOf,
  runRecordOf,
  stepKey,
  triggerMatches,
  type PlannedEffect,
  type PlannedField,
  type PlannedStep,
  type RunInputs,
  type RunRecord,
} from "./automationPlan";
import { checkAutomationReach, type ReachCollection, type ReachRoster } from "./automationReach";
import { RUN_PLAN_BUDGET_BYTES, type AutomationRunStore, type RunWrite, type StoredRun } from "./automationRunStore";

// One run of one claim: check reach, read, evaluate, save the plan, then
// apply the plan's effects in order, saving each one as it lands. The
// executor settles the claim with the outcome.

const RECORD_NOT_FOUND = "collection-record-not-found";

export const DEADLINE_ERROR = "The automation did not finish within 5 minutes.";
export const DEFINITION_CHANGED_ERROR =
  "This automation changed after this run began. Try again to run the new version from the start.";
export const UNREADABLE_RUN_ERROR =
  "dohc could not read this run's saved progress in .dohc/automations, so it did not run again. Move that folder aside, then try again.";
export const COMPACTED_RUN_ERROR =
  "This run failed too long ago for dohc to finish it. Change the records by hand, or wait for the automation's next run.";

/** The engine reads a run makes. VersionedLiveAdapter satisfies it. */
export interface CollectionAutomationReads {
  getCollectionRecord(input: CollectionGetRecordParams): Promise<CollectionGetRecordResult>;
  queryCollectionRecords(input: CollectionQueryParams): Promise<CollectionQueryResult>;
}

export interface CollectionAutomationRunDependencies {
  /** Engine reads; resolves null when the engine is unavailable. */
  withReads<T>(work: (reads: CollectionAutomationReads) => Promise<T>): Promise<T | null>;
  /** Record writes with the workspace's write authority, ending at `signal`. */
  withRecordWrites<T>(signal: AbortSignal, work: (context: CollectionRecordEditContext) => Promise<T>): Promise<T>;
  /** Whether a folder is a Collection the engine lists. */
  isCollection(path: string): boolean;
  /** Whether a folder keeps its records in a dataset (it holds dataset.json). */
  isDatasetCollection(path: string): Promise<boolean>;
  evaluator: AutomationFormulaEvaluator;
  store: AutomationRunStore;
  nowMs(): number;
}

export type CollectionAutomationRunOutcome =
  | { kind: "done" }
  // The trigger or a condition did not hold, or the record is gone.
  | { kind: "skipped" }
  | { kind: "failed"; error: string; timedOut: boolean }
  // The claim's run already failed here; the engine handed it out again
  // without a Try again, so only its settle is left.
  | { kind: "failed-before"; error: string }
  // Leave the claim for a later drain: the evaluator is busy, or the engine
  // is not answering.
  | { kind: "wait"; reason: "busy" | "engine" };

export interface CollectionAutomationRunInput {
  claim: AutomationClaim;
  automation: Automation;
  collection: ReachCollection;
  /** Who can edit what now; the executor waits while it is unknown. */
  roster: Exclude<ReachRoster, { kind: "unknown" }>;
  /** Aborts at the run's deadline, or when the executor stops. */
  signal: AbortSignal;
}

const failed = (error: string, timedOut = false): CollectionAutomationRunOutcome => ({ kind: "failed", error, timedOut });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ClaimRuns =
  | { unreadable: true }
  | {
      unreadable: false;
      /** A run that finished, under any definition. The claim needs only its settle. */
      done: StoredRun | null;
      /** The run this definition continues. */
      current: StoredRun | null;
      /**
       * A run of another definition that reached its writes. Running this
       * one from the start could repeat what that one did.
       */
      changedSince: StoredRun | null;
    };

export async function runsForClaim(
  store: AutomationRunStore,
  claim: Pick<AutomationClaim, "automationId" | "claimId">,
  automation: Automation,
): Promise<ClaimRuns> {
  const hash = definitionHash(automation);
  const { runs, unreadable } = await store.runsOf(claim.automationId, claim.claimId);
  if (unreadable) return { unreadable: true };
  const live = runs.filter((run) => !run.superseded);
  return {
    unreadable: false,
    done: live.find((run) => run.outcome?.state === "done") ?? null,
    current: live.find((run) => run.definitionHash === hash) ?? null,
    // A run is saved only once its plan is ready to write, so any saved run
    // of another definition may have written.
    changedSince: live.find((run) => run.definitionHash !== hash) ?? null,
  };
}

export async function runCollectionAutomation(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, automation, collection, roster } = input;
  const { store } = dependencies;
  const runs = await runsForClaim(store, claim, automation);
  // Never start over as if nothing had run.
  if (runs.unreadable) return failed(UNREADABLE_RUN_ERROR);
  const { done, current, changedSince } = runs;
  // It finished before this computer could settle the claim, whatever the
  // automation says now.
  if (done !== null) return { kind: "done" };
  // Running another definition from the start could repeat the changes the
  // earlier one made. A person has to choose that with Try again.
  if (current === null && changedSince !== null) return failed(DEFINITION_CHANGED_ERROR);
  if (current?.compacted) return failed(COMPACTED_RUN_ERROR);
  // The engine handed the claim out again without a Try again, as after a
  // crash before the failure reached it: the run stays failed.
  if (current?.outcome?.state === "failed" && current.outcome.run === claim.run) {
    return { kind: "failed-before", error: current.outcome.error };
  }

  // Reach (ADR 0012), before anything is read. The targets are in the file,
  // so the check needs only the roster.
  const steps = reachStepsOf(automation, collection, (path) => ({ path, name: path.split("/").at(-1) ?? path }));
  for (const verdict of checkAutomationReach(roster, { id: automation.id, collection, codeFiles: [], steps })) {
    if (!verdict.allowed) return failed(verdict.reason);
  }
  const targets = new Map<string, ReachCollection>();
  for (const step of steps) {
    if (step.kind === "change-records" || step.kind === "find-records") targets.set(step.collection.path, step.collection);
  }
  for (const target of targets.values()) {
    // A dataset's records change only through its approved operations.
    if (await dependencies.isDatasetCollection(target.path)) {
      return failed(`Automations cannot use ${target.name} yet, because it keeps its records in a dataset.`);
    }
    if (!dependencies.isCollection(target.path)) return failed(`dohc cannot find the Collection ${target.path}.`);
  }

  let run = current?.plan ? current : null;
  const resumed = run !== null;
  if (run === null) {
    let planned: Awaited<ReturnType<typeof plan>>;
    try {
      planned = await plan(dependencies, input);
    } catch (error) {
      return failed(errorText(error));
    }
    if (planned.kind === "stop") return planned.outcome;
    const now = dependencies.nowMs();
    run = {
      version: 1,
      claimId: claim.claimId,
      automationId: claim.automationId,
      definitionHash: definitionHash(automation),
      startedAtMs: now,
      updatedAtMs: now,
      plan: planned.steps,
      applied: [],
      superseded: false,
      settled: false,
      compacted: false,
      outcome: null,
    };
    // The run is saved again after every effect, so the plan with every
    // effect recorded must fit, and one that does not is refused before
    // anything is written.
    if (Buffer.byteLength(JSON.stringify({ ...run, applied: projectedProgress(run.plan ?? []) })) > RUN_PLAN_BUDGET_BYTES) {
      return failed("This run would change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations.");
    }
    // The plan is on disk before the first write, so a run that stops part
    // way continues with these values instead of evaluating again.
    await store.save(run);
  }
  const outcome = await applyPlan(dependencies, input, run, resumed);
  if (outcome.kind === "failed") {
    run.outcome = { state: "failed", error: outcome.error, run: claim.run };
  } else {
    run.outcome = { state: "done" };
    run.plan = null;
  }
  run.updatedAtMs = dependencies.nowMs();
  await store.save(run);
  return outcome;
}

async function plan(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
): Promise<{ kind: "plan"; steps: PlannedStep[] } | { kind: "stop"; outcome: CollectionAutomationRunOutcome }> {
  const { claim, automation } = input;
  const stop = (outcome: CollectionAutomationRunOutcome) => ({ kind: "stop" as const, outcome });
  const read = await dependencies.withReads(async (reads) => {
    let record: RunRecord | null = null;
    if (claim.change.kind !== "removed") {
      try {
        const result = await reads.getCollectionRecord({
          collectionPath: claim.collectionPath,
          recordId: claim.recordId,
          historyLimit: 1,
        });
        record = runRecordOf(result.record);
      } catch (error) {
        // The record was removed before its automation ran.
        if (error instanceof Error && error.message === RECORD_NOT_FOUND) return { removed: true } as const;
        throw error;
      }
    }
    const found = new Map<number, RunRecord[]>();
    for (const find of findsOf(automation)) {
      const { query } = find;
      const filter = query.match === "all" ? undefined : {
        field: query.field,
        operator: query.operator,
        value: query.value.kind === "literal" ? query.value.value : (record?.values[query.value.field] ?? null),
      };
      const result = await reads.queryCollectionRecords({
        collectionPath: find.collection ?? claim.collectionPath,
        ...(filter ? { filter } : {}),
        limit: MAX_FOUND_RECORDS,
      });
      found.set(find.ordinal, result.records.map(runRecordOf));
    }
    return { removed: false, record, found } as const;
  });
  if (read === null) return stop({ kind: "wait", reason: "engine" });
  if (read.removed) return stop({ kind: "skipped" });
  const inputs: RunInputs = { automation, claim, record: read.record, found: read.found };
  if (!triggerMatches(inputs)) return stop({ kind: "skipped" });
  // Formulas read `now` as the time of the change, so every attempt plans
  // the same values.
  const request = evaluationRequest(inputs, claim.createdAtMs);
  const results = request.formulas.length === 0
    ? []
    : await dependencies.evaluator.evaluate(claim.automationId, request.scope, request.formulas);
  if (results === "busy") return stop({ kind: "wait", reason: "busy" });
  const planned = planRun(inputs, request, results, { claimId: claim.claimId, hash: definitionHash(automation) });
  if (planned.kind === "skip") return stop({ kind: "skipped" });
  if (planned.kind === "failed") return stop(failed(planned.error, planned.timedOut));
  return { kind: "plan", steps: planned.steps };
}

/** Where the record with `recordId` is now, or null when it left the Collection. */
async function locate(
  dependencies: CollectionAutomationRunDependencies,
  collectionPath: string,
  recordId: string,
): Promise<string | null> {
  const found = await dependencies.withReads(async (reads) => {
    try {
      return { path: (await reads.getCollectionRecord({ collectionPath, recordId, historyLimit: 1 })).record.path };
    } catch (error) {
      if (error instanceof Error && error.message === RECORD_NOT_FOUND) return { path: null };
      throw error;
    }
  });
  if (found === null) throw new Error("The workspace engine is not running.");
  return found.path;
}

async function applyPlan(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
  run: StoredRun,
  resumed: boolean,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, signal } = input;
  const author: ChangeAuthor = {
    kind: "automation",
    automationId: claim.automationId,
    // The origin computer runs automations for its own workspace owner.
    onBehalfOf: "local",
    depth: claim.depth + 1,
  };
  const effects = (run.plan ?? []).flatMap((step) => step.effects.map((effect) => ({ ordinal: step.ordinal, effect })));
  const firstUnrecorded = run.applied.length;
  for (let index = firstUnrecorded; index < effects.length; index += 1) {
    if (signal.aborted) return failed(DEADLINE_ERROR, true);
    const { ordinal, effect } = effects[index]!;
    // After a stop, records may have changed while the run waited, so every
    // effect checks each field before it writes. Only the first effect the
    // run had not recorded may have landed before the stop.
    const mode: EffectMode = !resumed ? "fresh" : index === firstUnrecorded ? "may-have-landed" : "resumed";
    let writes: RunWrite[];
    try {
      writes = await applyEffect(dependencies, { run, author, signal, ordinal }, effect, mode);
    } catch (error) {
      return signal.aborted ? failed(DEADLINE_ERROR, true) : failed(errorText(error));
    }
    run.applied.push({ ordinal, writes });
    run.updatedAtMs = dependencies.nowMs();
    await dependencies.store.save(run);
  }
  return { kind: "done" };
}

/**
 * How an effect writes: a fresh run writes as planned; after a stop, every
 * effect writes only fields still at their planned before value, and the
 * first effect the run had not recorded may already have landed.
 */
type EffectMode = "fresh" | "may-have-landed" | "resumed";

// What a field write did, from the seam's answer. A field the seam kept
// belongs to whoever changed it since the plan, so it is not the
// automation's write, and Undo leaves it alone.
function fieldWrites(
  target: { recordId: string; path: string },
  fields: readonly PlannedField[],
  result: Pick<SetCollectionRecordFieldsResult, "replaced" | "kept">,
  mode: EffectMode,
): RunWrite[] {
  const writes: RunWrite[] = [];
  for (const { field, before, after } of fields) {
    const base = { recordId: target.recordId, path: target.path, field };
    if (Object.hasOwn(result.replaced, field)) {
      writes.push({ kind: "field", ...base, before: (result.replaced[field] ?? null) as JsonValue, after });
    } else if (Object.hasOwn(result.kept, field)) {
      writes.push({ kind: "kept", ...base, planned: after, current: (result.kept[field] ?? null) as JsonValue });
    } else if (mode === "may-have-landed" && !isDeepStrictEqual(before, after)) {
      // The earlier attempt wrote it before the run stopped.
      writes.push({ kind: "field", ...base, before, after });
    } else if (mode === "resumed" && !isDeepStrictEqual(before, after)) {
      // Someone else gave it the planned value while the run waited.
      writes.push({ kind: "kept", ...base, planned: after, current: after });
    }
  }
  return writes;
}

/** Every effect's record if it lands as planned, to size a run before it writes. */
function projectedProgress(plan: readonly PlannedStep[]): StoredRun["applied"] {
  return plan.flatMap((step) => step.effects.map((effect) => {
    if (effect.kind === "add") {
      const path = `${effect.collectionPath}/${effect.name}.md`;
      return { ordinal: step.ordinal, writes: [
        { kind: "created" as const, recordId: effect.recordId, path },
        ...effect.fields.map(({ field, value }) => ({ kind: "field" as const, recordId: effect.recordId, path, field, before: null, after: value })),
      ] };
    }
    const target = "addedBy" in effect.target ? { recordId: "rec_".padEnd(30, "x"), path: "" } : effect.target;
    return { ordinal: step.ordinal, writes: effect.fields.map(({ field, before, after }) =>
      ({ kind: "field" as const, recordId: target.recordId, path: target.path, field, before, after })) };
  }));
}

async function applyEffect(
  dependencies: CollectionAutomationRunDependencies,
  context: { run: StoredRun; author: ChangeAuthor; signal: AbortSignal; ordinal: number },
  effect: PlannedEffect,
  mode: EffectMode,
): Promise<RunWrite[]> {
  const { run, author, signal, ordinal } = context;
  const key = stepKey(run.claimId, run.definitionHash, ordinal);
  const seam = (edit: CollectionRecordEditContext, path: string, recordId: string, fields: readonly PlannedField[]) =>
    setCollectionRecordFields(edit, {
      recordPath: path,
      fields: Object.fromEntries(fields.map(({ field, after }) => [field, after])),
      author,
      idempotencyKeyPrefix: `${key}/${recordId}`,
      ...(mode === "fresh" ? {} : { expectedBefore: Object.fromEntries(fields.map(({ field, before }) => [field, before])) }),
    });

  if (effect.kind === "add") {
    // The record's id comes from the claim and step, so an earlier attempt's
    // record is found again instead of added twice.
    const created = await dependencies.withRecordWrites(signal, (edit) =>
      createCollectionRecord(edit, {
        collectionPath: effect.collectionPath,
        name: effect.name,
        author,
        recordId: effect.recordId,
      }),
    );
    const fields = effect.fields.map(({ field, value }) => ({ field, before: null, after: value }));
    const writes: RunWrite[] = [{ kind: "created", recordId: created.recordId, path: created.path }];
    if (fields.length === 0) return writes;
    const result = await dependencies.withRecordWrites(signal, (edit) => seam(edit, created.path, created.recordId, fields));
    return [...writes, ...fieldWrites(created, fields, result, mode)];
  }

  // Find the record again by its id: it may have moved since the plan, and
  // a saved path alone could name another file now.
  const planned = "addedBy" in effect.target ? addedRecord(run, effect.target.addedBy) : effect.target;
  if (planned === null) throw new Error("dohc cannot find the record an earlier step added.");
  const path = await locate(dependencies, planned.collectionPath, planned.recordId);
  if (path === null) {
    return [{ kind: "skipped", recordId: planned.recordId, path: planned.path, reason: "The record is no longer in the Collection." }];
  }
  const target = { recordId: planned.recordId, path };
  const result = await dependencies.withRecordWrites(signal, (edit) => seam(edit, path, planned.recordId, effect.fields));
  return fieldWrites(target, effect.fields, result, mode);
}

function addedRecord(run: StoredRun, ordinal: number): { recordId: string; collectionPath: string; path: string } | null {
  const add = run.plan?.find((step) => step.ordinal === ordinal)?.effects.find((effect) => effect.kind === "add");
  const created = run.applied.find((entry) => entry.ordinal === ordinal)?.writes.find((write) => write.kind === "created");
  return add?.kind === "add" && created?.kind === "created"
    ? { recordId: created.recordId, collectionPath: add.collectionPath, path: created.path }
    : null;
}
