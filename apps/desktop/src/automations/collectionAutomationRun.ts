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
  type PlannedStep,
  type RunInputs,
  type RunRecord,
} from "./automationPlan";
import { checkAutomationReach, type ReachCollection, type ReachRoster } from "./automationReach";
import type { AutomationRunStore, RunWrite, StoredRun } from "./automationRunStore";

// One run of one claim: check reach, read, evaluate, save the plan, then
// write in step order, saving each step's writes as it lands. The executor
// settles the claim with the outcome.

const RECORD_NOT_FOUND = "collection-record-not-found";

export const DEADLINE_ERROR = "The automation did not finish within 5 minutes.";
export const DEFINITION_CHANGED_ERROR =
  "This automation changed after this run began. Try again to run the new version from the start.";

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
  // Leave the claim for a later drain: the evaluator is busy, or the engine
  // is not answering.
  | { kind: "defer"; reason: "busy" | "engine" };

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

/** The run this definition continues for a claim, and a run of another definition that already changed records. */
export async function runsForClaim(
  store: AutomationRunStore,
  claim: Pick<AutomationClaim, "automationId" | "claimId">,
  automation: Automation,
): Promise<{ current: StoredRun | null; changedSince: StoredRun | null }> {
  const hash = definitionHash(automation);
  const runs = (await store.runsOf(claim.automationId, claim.claimId)).filter((run) => !run.superseded);
  return {
    current: runs.find((run) => run.definitionHash === hash) ?? null,
    changedSince:
      runs.find((run) => run.definitionHash !== hash && run.done.some((step) => step.writes.length > 0)) ?? null,
  };
}

export async function runCollectionAutomation(
  dependencies: CollectionAutomationRunDependencies,
  input: CollectionAutomationRunInput,
): Promise<CollectionAutomationRunOutcome> {
  const { claim, automation, collection, roster } = input;
  const { store } = dependencies;
  const { current, changedSince } = await runsForClaim(store, claim, automation);
  // Running another definition from the start could repeat the changes the
  // earlier one made. A person has to choose that with Try again.
  if (current === null && changedSince !== null) return failed(DEFINITION_CHANGED_ERROR);
  // It finished before this computer could settle the claim.
  if (current?.outcome?.state === "done" || current?.outcome?.state === "skipped") return { kind: current.outcome.state };

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
      done: [],
      superseded: false,
      outcome: null,
    };
    // The plan is on disk before the first write, so a run that stops part
    // way continues with these values instead of evaluating again.
    await store.save(run);
  }
  const outcome = await applyPlan(dependencies, input, run, resumed);
  if (outcome.kind === "failed") {
    run.outcome = { state: "failed", error: outcome.error };
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
  if (read === null) return stop({ kind: "defer", reason: "engine" });
  if (read.removed) return stop({ kind: "skipped" });
  const inputs: RunInputs = { automation, claim, record: read.record, found: read.found };
  if (!triggerMatches(inputs)) return stop({ kind: "skipped" });
  // Formulas read `now` as the time of the change, so every attempt plans
  // the same values.
  const request = evaluationRequest(inputs, claim.createdAtMs);
  const results = request.formulas.length === 0
    ? []
    : await dependencies.evaluator.evaluate(claim.automationId, request.scope, request.formulas);
  if (results === "busy") return stop({ kind: "defer", reason: "busy" });
  const planned = planRun(inputs, request, results, { claimId: claim.claimId, hash: definitionHash(automation) });
  if (planned.kind === "skip") return stop({ kind: "skipped" });
  if (planned.kind === "failed") return stop(failed(planned.error, planned.timedOut));
  return { kind: "plan", steps: planned.steps };
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
  const steps = run.plan ?? [];
  const firstUnrecorded = run.done.length;
  for (let index = firstUnrecorded; index < steps.length; index += 1) {
    if (signal.aborted) return failed(DEADLINE_ERROR, true);
    const step = steps[index]!;
    let writes: RunWrite[];
    try {
      // The first step a resumed run has not recorded may have landed before
      // the run stopped, so its writes check each field before writing.
      writes = await applyStep(dependencies, { run, author, signal }, step, resumed && index === firstUnrecorded);
    } catch (error) {
      return signal.aborted ? failed(DEADLINE_ERROR, true) : failed(errorText(error));
    }
    run.done.push({ ordinal: step.ordinal, writes });
    run.updatedAtMs = dependencies.nowMs();
    await dependencies.store.save(run);
  }
  return { kind: "done" };
}

async function applyStep(
  dependencies: CollectionAutomationRunDependencies,
  context: { run: StoredRun; author: ChangeAuthor; signal: AbortSignal },
  step: PlannedStep,
  mayHaveLanded: boolean,
): Promise<RunWrite[]> {
  const { run, author, signal } = context;
  const key = stepKey(run.claimId, run.definitionHash, step.ordinal);
  const writes: RunWrite[] = [];
  for (const effect of step.effects) {
    if (effect.kind === "add") {
      const created = await dependencies.withRecordWrites(signal, (edit) =>
        createCollectionRecord(edit, {
          collectionPath: effect.collectionPath,
          name: effect.name,
          fields: Object.fromEntries(effect.fields.map(({ field, value }) => [field, value])),
          author,
          recordId: effect.recordId,
          idempotencyKeyPrefix: `${key}/${effect.recordId}`,
          ...(mayHaveLanded ? { expectedBefore: Object.fromEntries(effect.fields.map(({ field }) => [field, null])) } : {}),
        }),
      );
      writes.push({ kind: "created", recordId: created.recordId, path: created.path });
      for (const { field, value } of effect.fields) {
        writes.push({ kind: "field", recordId: created.recordId, path: created.path, field, before: null, after: value });
      }
      continue;
    }
    const target = "addedBy" in effect.target ? addedRecord(run, effect.target.addedBy) : effect.target;
    if (target === null) throw new Error("dohc cannot find the record an earlier step added.");
    const result = await dependencies.withRecordWrites(signal, (edit) =>
      setCollectionRecordFields(edit, {
        recordPath: target.path,
        fields: Object.fromEntries(effect.fields.map(({ field, after }) => [field, after])),
        author,
        idempotencyKeyPrefix: `${key}/${target.recordId}`,
        ...(mayHaveLanded ? { expectedBefore: Object.fromEntries(effect.fields.map(({ field, before }) => [field, before])) } : {}),
      }),
    );
    for (const { field, before, after } of effect.fields) {
      const write = { kind: "field" as const, recordId: target.recordId, path: target.path, field };
      if (Object.hasOwn(result.replaced, field)) {
        writes.push({ ...write, before: (result.replaced[field] ?? null) as JsonValue, after });
      } else if (Object.hasOwn(result.kept, field)) {
        // Someone changed the field since the earlier attempt may have
        // written it. The step counts as done, and the field keeps its value.
        writes.push({ ...write, before, after: (result.kept[field] ?? null) as JsonValue });
      } else if (mayHaveLanded && !isDeepStrictEqual(before, after)) {
        // The earlier attempt wrote it before the run stopped.
        writes.push({ ...write, before, after });
      }
    }
  }
  return writes;
}

function addedRecord(run: StoredRun, ordinal: number): { recordId: string; path: string } | null {
  const created = run.done.find((entry) => entry.ordinal === ordinal)?.writes.find((write) => write.kind === "created");
  return created ? { recordId: created.recordId, path: created.path } : null;
}
