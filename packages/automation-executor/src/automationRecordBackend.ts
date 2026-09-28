import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { StoredRun } from "./automationRunStore";
import { datasetUndoDeletes } from "./datasetAutomationPlan";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import {
  parseCollectionAutomationId,
  codeFilesOf,
  codeStepOrdinals,
  definitionHash,
  findOverflowError,
  findQueryOf,
  MAX_FOUND_RECORDS,
  runRecordOf,
  scheduleDueAt,
  stepsInOrder,
  type RunContext,
  type RunRecord,
  type RunClaim,
} from "./automationPlan";
import { chatNeedsOf } from "./automationChat";
import { checkAutomationReach, datasetFieldKey, type ReachStep, type ReachRoster } from "./automationReach";
import {
  applyDocumentEffect,
  applyChatEffect,
  rebaseRun,
  groupChangedOutcome,
  groupMessage,
  newRun,
  readDocumentRecord,
  readsChats,
  LOST_COLLECTION_ERROR,
  RULES_CHANGED_ERROR,
  savedRunOf,
  type CollectionAutomationRunDependencies,
  type CollectionAutomationRunInput,
  type CollectionAutomationRunOutcome,
  type CollectionAutomationReads,
} from "./collectionAutomationRun";
import {
  applyDatasetEffect,
  ACCESS_NARROWED_ERROR,
  codeStepProblem,
  datasetRunRecordOf,
  datasetStepEffects,
  findValueProblem,
  readDatasetRecord,
  rowsOf,
  type DatasetAutomationRunDependencies,
  type DatasetRow,
} from "./datasetAutomationRun";
import {
  datasetRecordKey,
  type DatasetRecordId,
} from "./datasetAutomationPlan";
import {
  StepRecordChanged,
  type StepBackend,
  type StepReads,
} from "./automationStepRun";
import type { DatasetTable, DatasetOperation } from "@dohc/security-contract/dataset";
import { AutomationRunWait } from "./automationRunWait";
import { resolveAutomationInventory, type AutomationInventory } from "./automationInventory";

export type RecordRunDependencies = Pick<CollectionAutomationRunDependencies,
  "targets" | "evaluator" | "store" | "nowMs" | "personName" | "chat" | "postNotice" | "recipientVerdicts" | "readMessageBody" | "readCode"
> & Partial<Pick<CollectionAutomationRunDependencies,
  "withReads" | "withRecordWrites" | "collectionIdOf" | "collectionPathOf" | "checkReach"
>> & Partial<Pick<DatasetAutomationRunDependencies, "withHost" | "cachedRoster">>;
export type RecordRunInput = Omit<CollectionAutomationRunInput, "claim"> & {
  claim: Pick<AutomationClaim, "automationId" | "claimId" | "run" | "depth" | "createdAtMs">;
};
export interface RecordReads {
  document(path: string, id: string): Promise<RunRecord | null>;
  dataset(path: string, operation: DatasetOperation, table: DatasetTable, id: DatasetRecordId): Promise<DatasetRow | null>;
  remember(path: string, row: DatasetRow, table: DatasetTable): RunRecord;
  snapshots: ReadonlyMap<string, RunRecord>;
}
export interface RunSource {
  kind: "document" | "dataset";
  datasetId?: string;
  personId: string | null;
  writeAuthorId: string | null;
  engineClaim: AutomationClaim | null;
  decode(inventory: AutomationInventory, readable: ReadonlySet<string>, resuming: boolean): RunClaim | { outcome: CollectionAutomationRunOutcome };
  reads(access: RecordReads, inventory: AutomationInventory, readable: ReadonlySet<string>): Pick<StepReads, "trigger" | "codeRecords">;
  validate?(inventory: AutomationInventory, run: StoredRun | null): Promise<CollectionAutomationRunOutcome | null> | CollectionAutomationRunOutcome | null;
  checkEffect?(effect: import("./automationRunStore").StoredStep["effects"][number], ordinal: number, roster: Exclude<ReachRoster, { kind: "unknown" }>): Promise<CollectionAutomationRunOutcome | null>;
}
const failed = (error: string): CollectionAutomationRunOutcome => ({ kind: "failed", error, timedOut: false });

export async function prepareRecordBackend(deps: RecordRunDependencies, input: RecordRunInput, source: RunSource): Promise<
  { outcome: CollectionAutomationRunOutcome } |
  { backend: StepBackend; ctx: RunContext; state: StoredRun; resuming: boolean }
> {
  const { automation, collection, claim, signal, roster } = input;
  const saved = await savedRunOf(deps.store, claim, automation);
  if ("outcome" in saved) return { outcome: saved.outcome };
  const current = saved.current;
  const chat = readsChats(automation) ? await deps.chat.directory(roster, chatNeedsOf([automation])) : null;
  if (readsChats(automation) && chat === null) return { outcome: { kind: "wait", reason: "engine" } };
  if (source.engineClaim !== null) {
    const changed = groupChangedOutcome(automation, source.engineClaim, chat, current !== null);
    if (changed !== null) return { outcome: changed };
  }
  // Check availability before interpreting a missing dataset identity as a deletion.
  if (source.kind === "dataset" || current?.steps.some((step) => step.destinations?.some((target) => target.rules !== null))) {
    if (await deps.withHost?.(() => true) !== true) return { outcome: { kind: "wait", reason: "engine" } };
  }
  const located = structuredClone(automation);
  let moved = false;
  if (current !== null) {
    const result = rebaseRun(current, (id) => deps.collectionPathOf?.(id) ?? (id === source.datasetId ? collection.path : null));
    if (result.lost) return { outcome: failed(LOST_COLLECTION_ERROR) };
    moved = result.moved;
    for (const { ordinal, step } of stepsInOrder(located)) {
      if ((step.kind === "find" || step.kind === "add-record") && current.steps.some((saved) => saved.ordinal === ordinal)) {
        step.collection = current.steps.find((saved) => saved.ordinal === ordinal)?.destinations?.[0]?.path ?? step.collection;
      }
    }
  }
  let inventory: AutomationInventory;
  try { inventory = await resolveAutomationInventory(located, collection.path, deps.targets, chat); }
  catch (error) { if (error instanceof AutomationRunWait) throw error; return { outcome: failed(error instanceof Error ? error.message : String(error)) }; }
  const origin = inventory.targets.get(collection.path)!;
  if (origin.kind !== source.kind) return { outcome: failed(RULES_CHANGED_ERROR) };
  const sourceRules = origin.kind === "dataset" ? { datasetId: origin.approved.datasetId, revision: origin.approved.revision, revisionSha256: origin.approved.revisionSha256 } : null;
  if (source.kind === "dataset" && (origin.kind !== "dataset" || origin.approved.datasetId !== source.datasetId)) return { outcome: failed(RULES_CHANGED_ERROR) };
  const resolves = async (...rules: NonNullable<StoredRun["rules"]>[]) => {
    if (rules.length === 0) return true;
    const result = await deps.withHost?.((host) => rules.every((rule) => host.resolves(rule)));
    if (result == null) throw new AutomationRunWait("The dataset host is unavailable.");
    return result;
  };
  if (current !== null && (current.rules === null ? sourceRules !== null
    : sourceRules === null || current.rules.datasetId !== sourceRules.datasetId)) return { outcome: failed(RULES_CHANGED_ERROR) };
  if (current !== null) {
    const savedRules = [...(current.rules === null ? [] : [current.rules]), ...current.steps.flatMap((step) => [
      ...(step.destinations ?? []).flatMap((target) => target.rules === null ? [] : [target.rules]),
      ...step.effects.flatMap((effect) => "rules" in effect ? [effect.rules] : []),
    ])];
    if (!await resolves(...savedRules)) return { outcome: failed(RULES_CHANGED_ERROR) };
  }
  const problem = await source.validate?.(inventory, current);
  if (problem != null) return { outcome: problem };
  const readable = new Set<string>();
  const verdicts = checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: inventory.reach });
  if (await deps.checkReach?.(inventory.reach, roster)) return { outcome: { kind: "wait", reason: "held" } };
  for (const [index, verdict] of verdicts.entries()) {
    const step = inventory.reach[index]!;
    if (step.kind === "dataset-field") {
      if (verdict.allowed) readable.add(datasetFieldKey(step.datasetId, step.tableId, step.field.fieldId));
    } else if (!verdict.allowed) return { outcome: failed(verdict.reason) };
  }
  if (current?.readableFields?.some((field) => !readable.has(field))) return { outcome: failed(ACCESS_NARROWED_ERROR) };
  const visible = current === null ? readable : new Set(current.readableFields ?? []);
  const decoded = source.decode(inventory, visible, current !== null);
  if ("outcome" in decoded) return decoded;
  const runClaim = decoded;
  const personId = source.personId;
  const state = current ?? { ...newRun(claim, automation, definitionHash(automation) + "-" + claim.run, deps.nowMs()), rules: sourceRules, readableFields: [...visible] };
  let message: RunContext["message"] = null;
  if (source.engineClaim?.change.kind === "message") {
    const got = await groupMessage(deps, source.engineClaim, automation, chat);
    if ("outcome" in got) return got;
    message = got.message;
  }
  const ctx: RunContext = {
    automation, claim: runClaim, chat, message,
    person: personId === null ? null : { id: personId, name: deps.personName(personId) },
    nowMs: scheduleDueAt(runClaim) ?? claim.createdAtMs,
    key: { claimId: claim.claimId, hash: state.keySeed },
    ...(origin.kind === "dataset" && !origin.generated ? { recordKeys: ["id"] } : {}),
  };
  const author: ChangeAuthor = { kind: "automation", automationId: claim.automationId, depth: claim.depth + 1,
    ...(source.writeAuthorId === null ? {} : { onBehalfOf: source.writeAuthorId }) };
  const ordered = new Map(stepsInOrder(automation).map(({ ordinal, step }) => [ordinal, step]));
  const pathOf = (ordinal: number) => inventory.destinations.get(ordinal) ?? collection.path;
  const association = (path: string) => {
    const target = inventory.targets.get(path)!;
    return { path, rules: target.kind === "dataset" ? { datasetId: target.approved.datasetId, revision: target.approved.revision, revisionSha256: target.approved.revisionSha256 } : null };
  };
  for (const step of state.steps) {
    for (const target of step.destinations ?? []) {
      if (!inventory.targets.has(target.path)) return { outcome: failed(RULES_CHANGED_ERROR) };
      const rules = association(target.path).rules;
      if (target.rules === null ? rules !== null : rules === null || rules.datasetId !== target.rules.datasetId) {
        return { outcome: failed(RULES_CHANGED_ERROR) };
      }
    }
  }
  if (moved) await deps.store.save(state);
  const checkLocations = () => {
    const sourceId = parseCollectionAutomationId(claim.automationId)?.collectionId ?? null;
    const sourcePath = sourceId === null ? null : deps.collectionPathOf?.(sourceId) ?? (sourceId === source.datasetId ? collection.path : null);
    if (source.kind === "document" && sourcePath === null) throw new Error("This automation's Collection is gone.");
    if (sourcePath !== collection.path) throw new AutomationRunWait("The automation's Collection moved.", "moved");
    for (const target of state.collections) if ((deps.collectionPathOf?.(target.collectionId) ?? (target.collectionId === source.datasetId ? collection.path : null)) !== target.path) throw new AutomationRunWait("A Collection moved while this run was active.", "moved");
  };
  // Refresh grants and descriptor associations before reads and effects. Metadata stays local to this attempt.
  const checkNow = async (recordVerdicts = false) => {
    checkLocations();
    const currentRoster = (await deps.cachedRoster?.()) ?? roster;
    if (currentRoster.kind === "unknown") throw new AutomationRunWait("The workspace roster is unavailable.", "roster");
    const steps = inventory.datasets.size === 0 ? inventory.reach : await deps.withHost?.((host) => {
      const grants = new Map<string, ReturnType<typeof host.dataGrants>>();
      for (const [path, target] of inventory.targets) {
        if (target.kind !== "dataset") continue;
        if (!host.resolves(association(path).rules!)) throw new Error(RULES_CHANGED_ERROR);
        grants.set(target.approved.datasetId, host.dataGrants(target.approved.datasetId));
      }
      return inventory.reach.map((step): ReachStep => step.kind === "dataset-operation" || step.kind === "dataset-field"
        ? { ...step, grants: grants.get(step.datasetId)! } : step);
    });
    if (steps == null && inventory.datasets.size > 0) throw new AutomationRunWait("The dataset host is unavailable.");
    const fresh = { reach: steps ?? inventory.reach };
    const checks = checkAutomationReach(currentRoster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: fresh.reach });
    if (recordVerdicts && await deps.checkReach?.(fresh.reach, currentRoster)) throw new AutomationRunWait("The automation is waiting for an editor.", "held");
    for (const [index, verdict] of checks.entries()) {
      const step = fresh.reach[index]!;
      if (!verdict.allowed && (step.kind !== "dataset-field" || visible.has(datasetFieldKey(step.datasetId, step.tableId, step.field.fieldId)))) throw new Error(verdict.reason);
    }
    return currentRoster;
  };
  const verifyTarget = async (path: string) => {
    const before = inventory.targets.get(path);
    if (before === undefined) {
      const resolved = await deps.targets.resolve(path);
      if (resolved.kind === "problem") {
        if (resolved.code === "host-unavailable") throw new AutomationRunWait(resolved.problem);
        throw new Error(resolved.problem);
      }
      if (resolved.kind !== "document") throw new Error(RULES_CHANGED_ERROR);
      return;
    }
    const fresh = await (deps.targets.validate ? deps.targets.validate(before) : deps.targets.resolve(path));
    if (fresh.kind === "problem") {
      if (fresh.code === "host-unavailable") throw new AutomationRunWait(fresh.problem);
      throw new Error(fresh.problem);
    }
    if (fresh.kind !== before.kind || (fresh.kind === "dataset" && before.kind === "dataset" &&
      (fresh.approved.datasetId !== before.approved.datasetId || !await resolves(before.approved)))) throw new Error(RULES_CHANGED_ERROR);
  };
  const backend: StepBackend = {
    async step(work) {
      await checkNow(true);
      const checked = new Set<string>();
      const ensure = async (path: string) => { if (!checked.has(path)) { await verifyTarget(path); checked.add(path); } };
      const versions = new Map<string, { id: DatasetRecordId; version: number }>();
      const snapshots = new Map<string, RunRecord>();
      const remember = (path: string, row: DatasetRow, table: DatasetTable) => {
        const target = inventory.targets.get(path)!;
        if (target.kind !== "dataset") throw new Error(RULES_CHANGED_ERROR);
        const record = datasetRunRecordOf(row, target.approved.datasetId, table, visible);
        if (versions.has(record.path) && versions.get(record.path)!.version !== row.version) throw new StepRecordChanged();
        versions.set(record.path, { id: row.id, version: row.version });
        const prior = snapshots.get(record.path);
        if (prior !== undefined) { Object.assign(prior.values, record.values); return prior; }
        snapshots.set(record.path, record);
        return record;
      };
      const call = async (path: string, operationId: string, value: JsonValue) => {
        await ensure(path);
        const target = inventory.targets.get(path)!;
        if (target.kind !== "dataset") throw new Error(RULES_CHANGED_ERROR);
        const result = await deps.withHost?.((host) => {
          const rules = association(path).rules!;
          if (!host.resolves(rules)) throw new Error(RULES_CHANGED_ERROR);
          return host.invoke(host.context({ automationId: claim.automationId, claimId: claim.claimId, depth: claim.depth + 1, person: source.writeAuthorId }), { ...rules, operationId, input: value, idempotencyKey: "automation-read", signal });
        });
        if (result == null) throw new AutomationRunWait("The dataset host is unavailable.");
        return result;
      };
      const execute = async (reads: CollectionAutomationReads | null) => {
        checkLocations();
        const document = async (path: string, id: string) => {
          await ensure(path);
          const key = JSON.stringify([path, id]);
          if (snapshots.has(key)) return snapshots.get(key)!;
          if (reads === null) throw new AutomationRunWait("The workspace engine is unavailable.");
          const record = await readDocumentRecord(reads, path, id);
          if (record !== null) snapshots.set(key, record);
          return record;
        };
        try {
          return await work({
            ...source.reads({ document, snapshots, remember,
              dataset: (path, operation, table, id) => readDatasetRecord((op, value) => call(path, op, value), operation, table, id),
            }, inventory, visible),
            async bound(ordinal, refs) {
              const path = pathOf(ordinal);
              const target = inventory.targets.get(path)!;
              const records: RunRecord[] = [];
              for (const ref of refs) {
                if (target.kind === "document") {
                  const record = await document(path, ref.id);
                  if (record !== null) records.push(record);
                } else {
                  const steps = inventory.datasets.get(path)!.steps;
                  const own = steps.steps.get(ordinal)!;
                  const reader = own.operation.kind === "read" ? own.operation : steps.rereads.get(ordinal);
                  if (ref.key === undefined || ref.path !== datasetRecordKey(target.approved.datasetId, own.table.tableId, ref.key)) throw new Error(RULES_CHANGED_ERROR);
                  if (reader === undefined) {
                    const created = state.applied.flatMap((entry) => entry.ordinal === ordinal ? entry.writes : [])
                      .find((write) => write.kind === "dataset-created" && write.recordId === ref.key);
                    if (created?.kind === "dataset-created") versions.set(ref.path, { id: ref.key, version: created.version });
                    records.push({ ...ref, values: {} });
                    continue;
                  }
                  const row = await readDatasetRecord((op, value) => call(path, op, value), reader, own.table, ref.key);
                  if (row !== null) records.push(remember(path, row, own.table));
                }
              }
              return records;
            },
            findValues(ordinal) {
              const path = pathOf(ordinal);
              const dataset = inventory.datasets.get(path);
              if (dataset !== undefined) return (dataset.steps.finds.get(ordinal) ?? []).map((filter) => filter.value);
              const step = ordered.get(ordinal)!;
              const query = step.kind === "find" ? findQueryOf(step.condition) : { problem: "Not a Find step." };
              if ("problem" in query) throw new Error(query.problem);
              return query.match === "all" ? [] : [query.value];
            },
            async find(ordinal, values) {
              const path = pathOf(ordinal);
              await ensure(path);
              const dataset = inventory.datasets.get(path);
              if (dataset === undefined) {
                const step = ordered.get(ordinal)!;
                const query = step.kind === "find" ? findQueryOf(step.condition) : { problem: "Not a Find step." };
                if ("problem" in query) return query;
                if (reads === null) throw new AutomationRunWait("The workspace engine is unavailable.");
                const result = await reads.queryCollectionRecords({ collectionPath: path, limit: MAX_FOUND_RECORDS,
                  ...(query.match === "all" ? {} : { filter: { field: query.field, operator: query.operator, value: values[0] ?? null } }) });
                return result.nextCursor !== null ? { problem: findOverflowError(ordinal) } : result.records.map((found) => {
                  const record = runRecordOf(found), key = JSON.stringify([path, record.id]);
                  const previous = snapshots.get(key);
                  if (previous !== undefined && !isDeepStrictEqual(previous.values, record.values)) throw new StepRecordChanged();
                  snapshots.set(key, record);
                  return record;
                });
              }
              const { operation, table } = dataset.steps.steps.get(ordinal)!;
              const filters = (dataset.steps.finds.get(ordinal) ?? []).map((filter, index) => {
                const field = table.fields.find((field) => field.name === filter.field)!;
                const value = values[index] ?? null;
                const problem = filter.value.kind === "formula" ? findValueProblem(ordinal, field, value) : null;
                if (problem !== null) throw new Error(problem);
                return { fieldId: field.fieldId, value };
              });
              let result;
              try { result = await call(path, operation.operationId, { limit: MAX_FOUND_RECORDS, filters }); }
              catch (error) {
                const formulas = (dataset.steps.finds.get(ordinal) ?? []).filter((filter) => filter.value.kind === "formula");
                if (!isAppBackendRuntimeError(error) || error.refusal.code !== "invalid_input" || formulas.length === 0) throw error;
                const names = new Intl.ListFormat("en", { type: "conjunction" }).format(formulas.map((filter) => filter.field));
                return { problem: `The Find in step ${ordinal + 1} compares ${names} with a value this Collection does not accept.` };
              }
              const page = result.result;
              if (page !== null && typeof page === "object" && !Array.isArray(page) && page.nextCursor != null) return { problem: findOverflowError(ordinal) };
              return rowsOf(result).map((row) => remember(path, row, table));
            },
            effects(ordinal, planned) {
              const path = pathOf(ordinal);
              const dataset = inventory.datasets.get(path);
              if (dataset === undefined && codeStepOrdinals(automation).has(ordinal)) return [...planned];
              if (dataset === undefined) return planned.map((effect) => effect.kind === "set" ? { ...effect, target: { ...effect.target, collectionPath: path } } : effect.kind === "add" ? { ...effect, collectionPath: path } : effect);
              const effects = datasetStepEffects(automation, ordinal, planned, dataset.steps, dataset.rules.definition, codeStepOrdinals(automation).has(ordinal), association(path).rules!, versions, path,
                (tableId) => datasetUndoDeletes(roster, collection, dataset.rules.definition, tableId,
                  (inventory.targets.get(path) as Extract<import("./automationTargets").AutomationTarget, { kind: "dataset" }>).grants,
                  ).map((operation) => operation.operationId));
              if (!("problem" in effects)) {
                const problem = codeStepProblem(automation, dataset.rules.definition, [{ ordinal, effects }]);
                if (problem !== null) return { problem };
              }
              return "problem" in effects ? effects : effects.map((effect) => effect.kind === "dataset-edit" || effect.kind === "dataset-create" ? { ...effect, collectionPath: path } : effect);
            },
            destinations: (ordinal) => [association(pathOf(ordinal))],
          });
        } catch (error) { if (error instanceof StepRecordChanged) return "changed" as const; throw error; }
      };
      if (!deps.withReads || ![...inventory.targets.values()].some((target) => target.kind === "document")) return execute(null);
      const result = await deps.withReads(async (reads) => ({ value: await execute(reads) }));
      if (result === null) throw new AutomationRunWait("The workspace engine is unavailable.");
      return result.value;
    },
    collectionsOf: (step) => [...new Set([...(step.destinations ?? []).map(({ path }) => path),
      ...step.effects.flatMap((effect) => effect.kind === "set" ? [effect.target.collectionPath] : effect.kind === "add" ? [effect.collectionPath] : []),
    ])].flatMap((path) => {
      const target = inventory.targets.get(path);
      const collectionId = target?.kind === "dataset" ? target.approved.datasetId : deps.collectionIdOf?.(path) ?? null;
      return collectionId === null ? [] : [{ collectionId, path }];
    }),
    added(run, ordinal) {
      const writes = run.applied.filter((entry) => entry.ordinal === ordinal).flatMap((entry) => entry.writes);
      const created = writes.find((write) => write.kind === "created" || write.kind === "dataset-created");
      if (created?.kind === "created") return { id: created.recordId, path: created.path };
      if (created?.kind === "dataset-created") return { id: String(created.recordId), key: created.recordId, path: datasetRecordKey(created.rules.datasetId, created.tableId, created.recordId) };
      return null;
    },
    async apply(run, effect, place, chat) {
      const currentRoster = await checkNow();
      const stopped = await source.checkEffect?.(effect, place.ordinal, currentRoster);
      if (stopped != null) return { outcome: stopped };
      const effectPath = effect.kind === "set" ? effect.target.collectionPath : effect.kind === "add" ? effect.collectionPath : pathOf(place.ordinal);
      await verifyTarget(effectPath);
      if (effect.kind === "dataset-edit" || effect.kind === "dataset-create" || effect.kind === "dataset-action") {
        const path = pathOf(place.ordinal);
        const dataset = inventory.datasets.get(path)!;
        if (effect.rules.datasetId !== association(path).rules?.datasetId || !await resolves(effect.rules)) return { outcome: failed(RULES_CHANGED_ERROR) };
        const result = await deps.withHost?.((host) => applyDatasetEffect({
          dependencies: deps as DatasetAutomationRunDependencies, host,
          context: host.context({ automationId: claim.automationId, claimId: claim.claimId, depth: claim.depth + 1, person: source.writeAuthorId }),
          run, index: place.index, ordinal: place.ordinal, part: place.part, signal,
          datasetRules: dataset.rules, reader: dataset.steps.rereads.get(place.ordinal),
        }, effect, automation));
        return result ?? { outcome: { kind: "wait", reason: "engine" } };
      }
      if (effect.kind === "message" || effect.kind === "notice" || effect.kind === "wake") {
        return applyChatEffect(deps, { run, signal, automationName: automation.name, depth: claim.depth + 1, chat }, effect);
      }
      if (!deps.withRecordWrites || !deps.withReads || !deps.collectionPathOf || !deps.collectionIdOf) {
        throw new Error("The workspace engine is unavailable.");
      }
      return applyDocumentEffect(deps as CollectionAutomationRunDependencies, { run, author, signal, ordinal: place.ordinal, automationName: automation.name, depth: claim.depth + 1, chat }, effect, place.mode);
    },
  };
  return { backend, ctx, state, resuming: current !== null };
}
