import { rebaseRun } from "./collectionAutomationRun";
import type { AutomationTargets } from "./automationTargets";
import type { ReachStep } from "./automationReach";

import {
  datasetRecordKey,
} from "./datasetAutomationPlan";

import { unrecordedEffect } from "./automationStepRun";
import type {
  DatasetUndoRequest,
  StoredRun,
} from "./automationRunStore";
import { documentUndoChanges, undoCollectionAutomationRuns, type CollectionAutomationUndoDependencies, type CollectionAutomationUndone } from "./collectionAutomationUndo";
import { datasetUndoChanges, datasetUndoPreviewReads, datasetUndoRulesChanged, DATASET_UNDO_RULES_CHANGED, undoDatasetAutomationRuns, type DatasetUndoHost } from "./datasetAutomationUndo";

type Target = { kind: "document"; recordId: string } | { kind: "dataset"; datasetId: string; tableId: string; recordId: string | number }
  | { kind: "action"; datasetId: string; revision: number; operationId: string };
const empty = (): CollectionAutomationUndone => ({ reverted: 0, removed: 0, kept: 0, deleted: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 });

/** Reverse the last write to each record in journal order, coalescing each field's unbroken chain. */
export async function undoAutomationRuns(
  documents: CollectionAutomationUndoDependencies, host: DatasetUndoHost | null, collection: import("./automationReach").ReachCollection, rosterNow: () => Promise<import("./automationReach").ReachRoster>, claimId: string, runs: readonly StoredRun[],
  saveRequest: (request: DatasetUndoRequest) => Promise<void>, signal: AbortSignal,
  codeFiles: readonly string[] = [],
): Promise<{ undone: CollectionAutomationUndone; keptFields: Array<{ recordId: string; field: string }> }> {
  if (host !== null && datasetUndoRulesChanged(host, runs)) throw new Error(DATASET_UNDO_RULES_CHANGED);
  const targets = new Map<string, Target>();
  const touch = (key: string, target: Target) => { targets.delete(key); targets.set(key, target); };
  for (const run of [...runs].sort((a, b) => a.startedAtMs - b.startedAtMs)) {
    for (const created of run.created) touch("document:" + created.recordId, { kind: "document", recordId: created.recordId });
    for (const { writes } of run.applied) for (const write of writes) {
      if (write.kind === "field" || write.kind === "created") touch("document:" + write.recordId, { kind: "document", recordId: write.recordId });
      else if (write.kind === "dataset-edit" || write.kind === "dataset-created") {
        const target: Target = { kind: "dataset", datasetId: write.rules.datasetId, tableId: write.tableId, recordId: write.recordId };
        const key = datasetRecordKey(target.datasetId, target.tableId, target.recordId);
        touch(key, target);

      } else if (write.kind === "dataset-action") {
        touch(JSON.stringify([write.rules.datasetId, write.revision, write.operationId]),
          { kind: "action", datasetId: write.rules.datasetId, revision: write.revision, operationId: write.operationId });
      }
    }
    const pending = unrecordedEffect(run)?.effect;
    if (pending?.kind === "set") touch("document:" + pending.target.recordId, { kind: "document", recordId: pending.target.recordId });
    if (pending?.kind === "dataset-edit") {
      touch(datasetRecordKey(pending.rules.datasetId, pending.tableId, pending.target.recordId),
        { kind: "dataset", datasetId: pending.rules.datasetId, tableId: pending.tableId, recordId: pending.target.recordId });
    }
    if (pending?.kind === "add") touch("document:" + pending.recordId, { kind: "document", recordId: pending.recordId });
  }
  // All revisions and reverse capabilities are checked before the first reversal.
  const documentChanges = documentUndoChanges(runs.map((run) => {
    const moved = structuredClone(run);
    rebaseRun(moved, (id) => documents.collectionPathOf(id));
    return moved;
  }));
  const datasetChanges = host === null ? [] : datasetUndoChanges(host, runs);
  const result = empty();
  const keptFields: Array<{ recordId: string; field: string }> = [];
  const accumulate = (next: CollectionAutomationUndone) => { for (const key of Object.keys(result) as Array<keyof CollectionAutomationUndone>) result[key] += next[key]; };
  const ordered = [...targets.values()].reverse();
  const actions = new Map<string, Array<Extract<Target, { kind: "action" }>>>();
  for (const target of ordered) {
    if (target.kind !== "action") continue;
    const own = actions.get(target.datasetId) ?? [];
    own.push(target);
    actions.set(target.datasetId, own);
  }
  for (const own of actions.values()) own.sort((left, right) => right.revision - left.revision);
  for (const recorded of ordered) {
    // Commit revisions retain action order even when the wall clock moved backwards.
    const target = recorded.kind === "action" ? actions.get(recorded.datasetId)!.shift()! : recorded;
    signal.throwIfAborted();
    if (target.kind === "document") {
      const document = await undoCollectionAutomationRuns(documents, runs, signal, undefined, target.recordId, documentChanges);
      accumulate(document.undone);
      keptFields.push(...document.keptFields);
      continue;
    }
    if (host === null) throw new Error("The dataset host is unavailable.");
    const only = target.kind === "dataset" ? { ...target, kind: "record" as const } : target;
    const dataset = await undoDatasetAutomationRuns(host, collection, rosterNow, claimId, runs, saveRequest, signal, only, datasetChanges, codeFiles);
    accumulate(dataset.undone);
    keptFields.push(...dataset.keptFields);
  }
  return { undone: result, keptFields };
}

/** Reach and descriptor checks come from recorded writes, not the source Collection's current storage kind. */
export async function automationUndoReach(
  runs: readonly StoredRun[], resolver: AutomationTargets, datasetPath: (datasetId: string) => string | null,
  source: { roster: import("./automationReach").ReachRoster; collection: import("./automationReach").ReachCollection; codeFiles?: readonly string[] } | null,
  host: Pick<DatasetUndoHost, "resolves"> | null,
): Promise<ReachStep[]> {
  const paths = new Map<string, { datasetId: string | null; operations: Set<string> }>();
  for (const run of runs) {
    const started = run.steps.flatMap((step) => step.effects).slice(0, run.applied.length + 1);
    for (const effect of started) {
      if (effect.kind === "set" || effect.kind === "add") {
        const path = effect.kind === "set" ? effect.target.collectionPath : effect.collectionPath;
        const old = paths.get(path);
        if (old !== undefined && old.datasetId !== null) throw new Error(DATASET_UNDO_RULES_CHANGED);
        paths.set(path, { datasetId: null, operations: new Set() });
      } else if (effect.kind === "dataset-edit" || effect.kind === "dataset-create" || effect.kind === "dataset-action") {
        const path = ("collectionPath" in effect ? effect.collectionPath : undefined) ?? datasetPath(effect.rules.datasetId);
        if (path == null) throw new Error(DATASET_UNDO_RULES_CHANGED);
        const own = paths.get(path) ?? { datasetId: effect.rules.datasetId, operations: new Set<string>() };
        if (own.datasetId !== effect.rules.datasetId || !host?.resolves(effect.rules)) throw new Error(DATASET_UNDO_RULES_CHANGED);
        paths.set(path, own);
      }
    }
  }
  const resolved = new Map<string, Awaited<ReturnType<AutomationTargets["resolve"]>>>();
  for (const path of paths.keys()) resolved.set(path, await resolver.resolve(path));
  const revisions = new Map([...resolved.values()].flatMap((target) => target.kind === "dataset" ? [[target.approved.datasetId, target.approved] as const] : []));
  const reach: ReachStep[] = [];
  const previewReads = source === null ? [] : datasetUndoPreviewReads({
    revision: (id) => revisions.get(id)!,
    dataGrants: (id) => {
      const target = [...resolved.values()].find((target) => target.kind === "dataset" && target.approved.datasetId === id);
      if (target?.kind !== "dataset") throw new Error(DATASET_UNDO_RULES_CHANGED);
      return target.grants;
    },
  }, source, runs);
  for (const [path, expected] of paths) {
    const target = resolved.get(path)!;
    if (target.kind === "problem") throw new Error(target.problem);
    if (expected.datasetId === null) {
      if (target.kind !== "document") throw new Error(DATASET_UNDO_RULES_CHANGED);
      continue;
    }
    if (target.kind !== "dataset" || target.approved.datasetId !== expected.datasetId) throw new Error(DATASET_UNDO_RULES_CHANGED);
    for (const write of runs.flatMap((run) => run.applied.flatMap((entry) => entry.writes))) {
      if (!("rules" in write) || write.rules.datasetId !== expected.datasetId) continue;
      if (write.kind === "dataset-action" && write.reverseOperationId !== undefined) expected.operations.add(write.reverseOperationId);
    }
    for (const read of previewReads) if (read.datasetId === expected.datasetId) expected.operations.add(read.operationId);
    if ([...expected.operations].some((id) => !target.approved.definition.operations.some((operation) => operation.operationId === id))) {
      throw new Error(DATASET_UNDO_RULES_CHANGED);
    }
    for (const operation of target.approved.definition.operations) {
      if (!expected.operations.has(operation.operationId)) continue;
      reach.push({ kind: "dataset-operation", collection: target.collection, datasetId: target.approved.datasetId, operations: target.approved.definition.operations, grants: target.grants, operation });
    }
  }
  return reach;
}
