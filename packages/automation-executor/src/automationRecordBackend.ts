import { isAppBackendRuntimeError } from "@dohc/app-backend-runtime";
import { DATASET_FIND_PAGE_SIZE, MAX_FOUND_RECORDS } from "./automationLimits";
import type { StoredRun } from "./automationRunStore";
import { datasetUndoDeletes, datasetCodeTable, datasetCodeOperation, datasetTableNamed, datasetStepsOf } from "./datasetAutomationPlan";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import {
  parseCollectionAutomationId,
  codeFilesOf,
  codeStepOrdinals,
  codeRecordKey,
  definitionHash,
  findOverflowError,
  findQueryOf,
  runRecordOf,
  scheduleDueAt,
  stepsInOrder,
  type RunContext,
  type RunRecord,
  type RunClaim,
  type PlannedEffect,
} from "./automationPlan";
import { chatNeedsOf } from "./automationChat";
import { automationTargetPathProblem, checkAutomationReach, datasetFieldKey, personHoldsOperation, reachStepId, type ReachStep, type ReachRoster } from "./automationReach";
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
  datasetRecordIdOf,
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
import type { AutomationTarget } from "./automationTargets";

export type RecordRunDependencies = Pick<CollectionAutomationRunDependencies,
  "targets" | "evaluator" | "store" | "nowMs" | "personName" | "chat" | "postNotice" | "recipientVerdicts" | "readMessageBody" | "readCode"
> & Partial<Pick<CollectionAutomationRunDependencies,
  "withReads" | "withRecordWrites" | "collectionIdOf" | "collectionPathOf" | "checkReach" | "localPersonId"
>> & Partial<Pick<DatasetAutomationRunDependencies, "withHost" | "cachedRoster">>;
export type RecordRunInput = Omit<CollectionAutomationRunInput, "claim"> & {
  claim: Pick<AutomationClaim, "automationId" | "claimId" | "run" | "depth" | "createdAtMs">;
};
export interface RecordReads {
  document(path: string, id: string): Promise<RunRecord | null>;
  dataset(path: string, operation: DatasetOperation, table: DatasetTable, id: DatasetRecordId): Promise<DatasetRow | null>;
  remember(path: string, row: DatasetRow, table: DatasetTable): RunRecord;
}
export interface RunSource {
  kind: "document" | "dataset";
  datasetId?: string;
  personId: string | null;
  writeAuthorId: string | null;
  engineClaim: AutomationClaim | null;
  decode(inventory: AutomationInventory, readable: ReadonlySet<string>, resuming: boolean): RunClaim | { outcome: CollectionAutomationRunOutcome };
  reads(access: RecordReads, inventory: AutomationInventory, readable: ReadonlySet<string>): Pick<StepReads, "trigger">;
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
      if ((step.kind === "find" || step.kind === "add-record" || step.kind === "invoke") && current.steps.some((saved) => saved.ordinal === ordinal)) {
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
  const readable = new Set<string>();
  const verdicts = checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: inventory.reach });
  if (await deps.checkReach?.(inventory.reach, roster)) return { outcome: { kind: "wait", reason: "held" } };
  for (const [index, verdict] of verdicts.entries()) {
    const step = inventory.reach[index]!;
    if (step.kind === "dataset-field") {
      if (verdict.allowed) readable.add(datasetFieldKey(step.datasetId, step.tableId, step.field.fieldId));
    } else if (!verdict.allowed) return { outcome: failed(verdict.reason) };
  }
  const visible = current === null ? readable : new Set(current.readableFields ?? []);
  const decoded = source.decode(inventory, visible, current !== null);
  if ("outcome" in decoded) return decoded;
  const runClaim = decoded;
  const personId = source.personId;
  const state = current ?? { ...newRun(claim, automation, definitionHash(automation) + "-" + claim.run, deps.nowMs()), rules: sourceRules, readableFields: [...visible] };
  // Retire effect-free runs before this definition can save or write. A
  // later edit back to their hash must not revive an old Find binding.
  for (const prior of saved.replaceable) {
    await deps.store.save({ ...prior, superseded: true, finishedAtMs: prior.finishedAtMs ?? deps.nowMs() });
  }
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
  // Record history names the automation as it was called when it ran, and opens this run.
  const author: ChangeAuthor = { kind: "automation", automationId: claim.automationId, depth: claim.depth + 1,
    ...(source.writeAuthorId === null ? {} : { onBehalfOf: source.writeAuthorId }),
    run: { claimId: claim.claimId, automationName: automation.name } };
  const ordered = new Map(stepsInOrder(automation).map(({ ordinal, step }) => [ordinal, step]));
  const pathOf = (ordinal: number) => inventory.destinations.get(ordinal) ?? collection.path;
  const association = (path: string) => {
    const target = inventory.targets.get(path)!;
    return { path, rules: target.kind === "dataset" ? { datasetId: target.approved.datasetId, revision: target.approved.revision, revisionSha256: target.approved.revisionSha256 } : null };
  };
  const codeOrdinals = codeStepOrdinals(automation);
  type CodeTarget = { ordinal: number; collection: string; table?: string; tableId?: string; recordPath?: string; action: "add" | "change"; fields: readonly string[]; fieldIds?: readonly string[]; operationId?: string };
  const codeReach = new Map<string, { ordinal: number; reach: ReachStep }>();
  let recordReadable = visible;
  const loadCodeTarget = async (path: string) => {
    const problem = automationTargetPathProblem(path);
    if (problem !== null) throw new Error(problem);
    if (inventory.targets.has(path)) return inventory.targets.get(path)!;
    const target = await deps.targets.resolve(path);
    if (target.kind === "problem") {
      if (target.code === "host-unavailable") throw new AutomationRunWait(target.problem);
      throw new Error(target.problem);
    }
    inventory.targets.set(path, target);
    if (target.kind === "dataset") {
      const rules = { definition: target.approved.definition, generated: target.generated, sourceCollection: collection.path };
      inventory.datasets.set(path, { rules, steps: datasetStepsOf(automation, rules) });
    }
    return target;
  };
  const codeTable = (target: Extract<AutomationTarget, { kind: "dataset" }>, request: CodeTarget) => {
    const definition = target.approved.definition;
    const table = request.tableId !== undefined ? definition.tables.find((table) => table.tableId === request.tableId)
      : request.table !== undefined ? datasetTableNamed(definition, request.table)
      : request.collection === collection.path ? datasetCodeTable(automation, definition) : datasetTableNamed(definition, null);
    if (table === undefined) throw new Error(request.table !== undefined
      ? `${request.collection} has no table named ${request.table}. Check the table name in step ${request.ordinal + 1}.`
      : request.tableId !== undefined ? RULES_CHANGED_ERROR
      : `The code in step ${request.ordinal + 1} changes records in ${request.collection}. Name its table when the Collection has several tables.`);
    return table;
  };
  const authorizeCode = async (requests: readonly CodeTarget[]) => {
    const authorized = new Map<CodeTarget, { table: DatasetTable; operation: DatasetOperation; reader?: DatasetOperation }>();
    if (requests.length === 0) return authorized;
    const currentRoster = await deps.cachedRoster?.() ?? roster;
    if (currentRoster.kind === "unknown") throw new AutomationRunWait("The workspace roster is unavailable.", "roster");
    const checkedReach = new Map<string, { ordinal: number; reach: ReachStep }>();
    const addReach = (ordinal: number, reach: ReachStep) => checkedReach.set(JSON.stringify([ordinal, reachStepId(reach, 0)]), { ordinal, reach });
    const grantsByPath = new Map<string, Extract<AutomationTarget, { kind: "dataset" }>["grants"]>();
    const fieldsRead: string[] = [];
    const problems: string[] = [];
    for (const request of requests) {
      const pathReach: ReachStep = { kind: "change-records", collection: { path: request.collection, name: request.collection.split("/").at(-1)! }, identity: JSON.stringify(["code", request.ordinal, request.collection]) };
      const [pathVerdict] = checkAutomationReach(currentRoster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: [pathReach] });
      let target: Exclude<AutomationTarget, { kind: "problem" }>;
      try { target = await loadCodeTarget(request.collection); }
      catch (error) {
        addReach(request.ordinal, pathReach);
        if (error instanceof AutomationRunWait) throw error;
        problems.push(pathVerdict!.allowed
          ? `The code in step ${request.ordinal + 1} changes records in ${request.collection}. ${error instanceof Error ? error.message : String(error)}`
          : "This automation cannot use the requested Collection or fields.");
        continue;
      }
      if (target.kind === "document") {
        addReach(request.ordinal, pathReach);
        if (!pathVerdict!.allowed) continue;
        if (request.table !== undefined || request.tableId !== undefined) problems.push("Only a dataset Collection has named tables.");
        const missing = target.fields === null ? undefined : request.fields.find((field) => !target.fields!.has(field));
        if (missing !== undefined) problems.push(`The code in step ${request.ordinal + 1} sets ${missing}, which is not a field in ${target.collection.name}.`);
        continue;
      }
      const grants = grantsByPath.get(request.collection) ?? await deps.withHost?.((host) => host.dataGrants(target.approved.datasetId));
      if (grants == null) throw new AutomationRunWait("The dataset host is unavailable.");
      grantsByPath.set(request.collection, grants);
      try {
        if (!target.generated) throw new Error(`The code in step ${request.ordinal + 1} changes records in ${request.collection}. Its operations were written or changed outside dohc, so only an action can change its records. Run one with an invoke step.`);
        const table = codeTable(target, request);
        const names = request.fieldIds === undefined ? request.fields : request.fieldIds.map((id) => table.fields.find((field) => field.fieldId === id && field.type !== "button")?.name);
        if (names.some((name) => name === undefined)) throw new Error(RULES_CHANGED_ERROR);
        const fields = names as readonly string[];
        const missing = fields.find((name) => !table.fields.some((field) => field.name === name && field.type !== "button"));
        if (missing !== undefined) throw new Error(`The code in step ${request.ordinal + 1} sets ${missing}, which is not a field in ${table.name}.`);
        const operations: DatasetOperation[] = [];
        for (const kind of request.action === "add" ? ["create"] as const : ["edit", "read"] as const) {
          const operation = kind !== "read" && request.operationId !== undefined
            ? target.approved.definition.operations.find((operation) => operation.operationId === request.operationId && operation.tableId === table.tableId && operation.kind === kind && request.fieldIds!.every((id) => operation.fieldIds.includes(id)))
            : datasetCodeOperation(target.approved.definition, table, kind, fields);
          if (operation === undefined || "problem" in operation) throw new Error(operation === undefined ? RULES_CHANGED_ERROR : `The code in step ${request.ordinal + 1} changes records in ${table.name}. ${operation.problem}`);
          operations.push(operation);
        }
        authorized.set(request, { table, operation: operations[0]!, ...(operations[1] === undefined ? {} : { reader: operations[1] }) });
        for (const operation of operations) addReach(request.ordinal, { kind: "dataset-operation", collection: target.collection, datasetId: target.approved.datasetId, grants, operation });
        for (const operation of operations) if (operation.kind === "read") {
          fieldsRead.push(...operation.fieldIds.map((fieldId) => datasetFieldKey(target.approved.datasetId, table.tableId, fieldId)));
        }
      } catch (error) {
        // Schema errors disclose nothing until every editor can use the destination's operations.
        const schema = target.approved.definition.operations.map((operation): Extract<ReachStep, { kind: "dataset-operation" }> => ({ kind: "dataset-operation", collection: target.collection, datasetId: target.approved.datasetId, grants, operation }));
        const allowed = schema.length > 0 && checkAutomationReach(currentRoster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: schema }).every((verdict) => verdict.allowed) &&
          (automation.when.kind !== "button" || schema.every((step) => personHoldsOperation(currentRoster, source.personId, step, deps.localPersonId?.())));
        addReach(request.ordinal, allowed ? pathReach : { kind: "unavailable", reason: "This automation cannot use the requested Collection or fields.", identity: pathReach.identity });
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    const checks = [...checkedReach.values()];
    const verdicts = checkAutomationReach(currentRoster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: checks.map(({ reach }) => reach) });
    const staticIds = new Set(inventory.reach.map(reachStepId));
    const recipients = checks.flatMap(({ ordinal, reach }, index) => {
      if (reach.kind !== "change-records" && reach.kind !== "unavailable" && (reach.kind !== "dataset-operation" || staticIds.has(reachStepId(reach, index)))) return [];
      const verdict = verdicts[index]!;
      const operation = reach.kind === "dataset-operation" ? reach.operation as DatasetOperation : null;
      return [{ step: ordinal, id: reach.kind === "change-records" ? reach.collection.path : reachStepId(reach, index),
        name: reach.kind === "unavailable" ? "Requested Collection" : !verdict.allowed || operation === null ? reach.collection.name : `${reach.collection.name}: ${operation.label}`,
        action: verdict.allowed && operation?.kind === "read" ? "find" as const : "change" as const,
        reach: verdict.allowed ? verdict : { ...verdict, reason: "This automation cannot use the requested Collection or fields." } }];
    });
    const kept = recipients.length === 0 ? [] : await deps.recipientVerdicts({ automationId: claim.automationId, definitionHash: definitionHash(automation), recipients });
    for (const [index, entry] of checks.entries()) codeReach.set(JSON.stringify([entry.ordinal, reachStepId(entry.reach, index)]), entry);
    for (const [index, { ordinal, reach }] of checks.entries()) {
      const verdict = verdicts[index]!;
      if (!verdict.allowed) throw new Error(`The code in step ${ordinal + 1} changes records. This automation cannot use the requested Collection or fields.`);
      if (automation.when.kind === "button" && reach.kind === "dataset-operation" && !personHoldsOperation(currentRoster, source.personId, reach, deps.localPersonId?.())) throw new Error("The person who pressed this button cannot use its destination operation.");
    }
    if (kept.includes("held")) throw new AutomationRunWait("The automation is waiting for an editor.", "held");
    if (problems.length > 0) throw new Error(problems[0]);
    for (const field of fieldsRead) if (!recordReadable.has(field)) {
      if (recordReadable === visible) recordReadable = new Set(visible);
      recordReadable.add(field);
    }
    return authorized;
  };
  const savedCodeTargets = (step: StoredRun["steps"][number]): CodeTarget[] => !codeOrdinals.has(step.ordinal) ? [] : step.effects.flatMap((effect): CodeTarget[] => {
    if (effect.kind === "add") return [{ ordinal: step.ordinal, collection: effect.collectionPath, action: "add", fields: effect.fields.map(({ field }) => field) }];
    if (effect.kind === "set") return [{ ordinal: step.ordinal, collection: effect.target.collectionPath, action: "change", fields: effect.fields.map(({ field }) => field) }];
    if (effect.kind === "dataset-edit" || effect.kind === "dataset-create") return [{ ordinal: step.ordinal, collection: effect.collectionPath ?? collection.path,
      action: effect.kind === "dataset-create" ? "add" : "change", tableId: effect.tableId, operationId: effect.operationId,
      fields: (effect.kind === "dataset-create" ? effect.values : effect.fields).map(({ field }) => field),
      fieldIds: (effect.kind === "dataset-create" ? effect.values : effect.fields).map(({ fieldId }) => fieldId) }];
    return [];
  });
  for (const step of state.steps) {
    for (const target of step.destinations ?? []) await loadCodeTarget(target.path);
  }
  // A saved field keeps its identity even when a new table changes implicit table selection.
  const resumeReach: Extract<ReachStep, { kind: "dataset-field" }>[] = [];
  if (current !== null) for (const target of inventory.targets.values()) {
    if (target.kind !== "dataset") continue;
    for (const table of target.approved.definition.tables) for (const field of table.fields) {
      const key = datasetFieldKey(target.approved.datasetId, table.tableId, field.fieldId);
      if (field.type === "button" || readable.has(key) || !visible.has(key)) continue;
      const reach: Extract<ReachStep, { kind: "dataset-field" }> = { kind: "dataset-field", collection: target.collection, datasetId: target.approved.datasetId, tableId: table.tableId,
        grants: target.grants, field: { fieldId: field.fieldId, name: field.name },
        reads: target.approved.definition.operations.filter((operation) => operation.kind === "read" && operation.tableId === table.tableId && operation.fieldIds.includes(field.fieldId)) };
      resumeReach.push(reach);
    }
  }
  checkAutomationReach(roster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: resumeReach })
    .forEach((verdict, index) => { const step = resumeReach[index]!; if (verdict.allowed) readable.add(datasetFieldKey(step.datasetId, step.tableId, step.field.fieldId)); });
  inventory.reach.push(...resumeReach);
  await authorizeCode(state.steps.flatMap(savedCodeTargets));
  if (current?.readableFields?.some((field) => !readable.has(field))) return { outcome: failed(ACCESS_NARROWED_ERROR) };
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
    const allReach = [...inventory.reach, ...[...codeReach.values()].map(({ reach }) => reach)];
    const steps = inventory.datasets.size === 0 ? allReach : await deps.withHost?.((host) => {
      const grants = new Map<string, ReturnType<typeof host.dataGrants>>();
      for (const [path, target] of inventory.targets) {
        if (target.kind !== "dataset") continue;
        if (!host.resolves(association(path).rules!)) throw new Error(RULES_CHANGED_ERROR);
        grants.set(target.approved.datasetId, host.dataGrants(target.approved.datasetId));
      }
      return allReach.map((step): ReachStep => step.kind === "dataset-operation" || step.kind === "dataset-field"
        ? { ...step, grants: grants.get(step.datasetId)! } : step);
    });
    if (steps == null && inventory.datasets.size > 0) throw new AutomationRunWait("The dataset host is unavailable.");
    const fresh = { reach: steps ?? allReach };
    const checks = checkAutomationReach(currentRoster, { id: automation.id, collection, codeFiles: codeFilesOf(automation, collection.path), steps: fresh.reach });
    if (recordVerdicts && await deps.checkReach?.(fresh.reach.slice(0, inventory.reach.length), currentRoster)) throw new AutomationRunWait("The automation is waiting for an editor.", "held");
    for (const [index, verdict] of checks.entries()) {
      const step = fresh.reach[index]!;
      if (!verdict.allowed && (step.kind !== "dataset-field" || visible.has(datasetFieldKey(step.datasetId, step.tableId, step.field.fieldId)))) throw new Error(verdict.reason);
    }
    return currentRoster;
  };
  const verifyTarget = async (path: string) => {
    const before = inventory.targets.get(path);
    if (before === undefined) throw new Error(RULES_CHANGED_ERROR);
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
      const priorCodeReach = new Map(codeReach);
      const priorReadable = recordReadable;
      let codeOperations = new Map<CodeTarget, { table: DatasetTable; operation: DatasetOperation; reader?: DatasetOperation }>();
      const checked = new Set<string>();
      const ensure = async (path: string) => { if (!checked.has(path)) { await verifyTarget(path); checked.add(path); } };
      const versions = new Map<string, { id: DatasetRecordId; version: number }>();
      const snapshots = new Map<string, RunRecord>();
      const remember = (path: string, row: DatasetRow, table: DatasetTable) => {
        const target = inventory.targets.get(path)!;
        if (target.kind !== "dataset") throw new Error(RULES_CHANGED_ERROR);
        const record = datasetRunRecordOf(row, target.approved.datasetId, table, recordReadable);
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
          const found = reads === null ? await deps.withReads?.(async (reader) => ({ record: await readDocumentRecord(reader, path, id) }))
            : { record: await readDocumentRecord(reads, path, id) };
          if (found == null) throw new AutomationRunWait("The workspace engine is unavailable.");
          const record = found.record;
          if (record !== null) snapshots.set(key, record);
          return record;
        };
        try {
          return await work({
            ...source.reads({ document, remember,
              dataset: (path, operation, table, id) => readDatasetRecord((op, value) => call(path, op, value), operation, table, id),
            }, inventory, visible),
            async codeRecords(changes, { record }) {
              const requests: CodeTarget[] = [];
              const changed = new Map<string, { request: CodeTarget; table: DatasetTable; id: DatasetRecordId; keys: string[] }>();
              for (const change of changes) {
                const request = { ...change, fields: Object.keys(change.fields) };
                let target: Exclude<AutomationTarget, { kind: "problem" }>;
                let table: DatasetTable;
                try {
                  target = await loadCodeTarget(change.collection);
                  if (target.kind === "dataset") table = codeTable(target, request);
                } catch { requests.push(request); continue; }
                if (target.kind === "document" || change.action === "add") { requests.push(request); continue; }
                const id = change.id === null ? record?.key ?? null : datasetRecordIdOf(table!, change.id);
                if (id === null) { requests.push(request); continue; }
                const key = datasetRecordKey(target.approved.datasetId, table!.tableId, id);
                const entry = changed.get(key) ?? { request: { ...request, tableId: table!.tableId, recordPath: key }, table: table!, id, keys: new Array<string>() };
                entry.request.fields = [...new Set([...entry.request.fields, ...request.fields])];
                if (change.id !== null) entry.keys.push(codeRecordKey(change.collection, change.id, change.table));
                changed.set(key, entry);
              }
              codeOperations = await authorizeCode([...requests, ...[...changed.values()].map(({ request }) => request)]);
              await checkNow();
              const records = new Map<string, RunRecord>();
              // Check every returned destination before reading the first requested record.
              for (const change of changes) await ensure(change.collection);
              for (const change of changes) {
                const target = inventory.targets.get(change.collection)!;
                if (target.kind === "document" && change.action === "change" && change.id !== null) {
                  const key = codeRecordKey(change.collection, change.id, change.table);
                  if (!records.has(key)) {
                    const found = await document(change.collection, change.id);
                    if (found !== null) records.set(key, found);
                  }
                }
              }
              for (const [key, { request, table, id, keys }] of changed) {
                const target = inventory.targets.get(request.collection)!;
                if (target.kind !== "dataset") throw new Error(RULES_CHANGED_ERROR);
                const reader = codeOperations.get(request)!.reader!;
                let snapshot = snapshots.get(key);
                if (snapshot === undefined || request.fields.some((field) => !Object.hasOwn(snapshot!.values, field))) {
                  const row = await readDatasetRecord((op, value) => call(request.collection, op, value), reader, table, id);
                  snapshot = row === null ? undefined : remember(request.collection, row, table);
                }
                if (snapshot !== undefined) for (const key of keys) records.set(key, snapshot);
              }
              return { records };
            },
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
                return result.nextCursor !== null || result.records.length > MAX_FOUND_RECORDS ? { problem: findOverflowError(ordinal) } : result.records.map((found) => {
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
              const records: RunRecord[] = [];
              const identities = new Set<string>();
              const cursors: JsonValue[] = [];
              let after: JsonValue | undefined;
              for (;;) {
                let result;
                try { result = await call(path, operation.operationId, {
                  limit: Math.min(DATASET_FIND_PAGE_SIZE, MAX_FOUND_RECORDS - records.length), filters,
                  ...(after === undefined ? {} : { after }),
                }); }
                catch (error) {
                  const formulas = (dataset.steps.finds.get(ordinal) ?? []).filter((filter) => filter.value.kind === "formula");
                  if (!isAppBackendRuntimeError(error) || error.refusal.code !== "invalid_input" || formulas.length === 0) throw error;
                  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(formulas.map((filter) => filter.field));
                  return { problem: `The Find in step ${ordinal + 1} compares ${names} with a value this Collection does not accept.` };
                }
                for (const row of rowsOf(result)) {
                  const identity = JSON.stringify([typeof row.id, row.id]);
                  if (identities.has(identity)) return { problem: `The Find in step ${ordinal + 1} returned a duplicate record identity. Ask the owner to check its read operation.` };
                  identities.add(identity);
                  records.push(remember(path, row, table));
                  if (records.length > MAX_FOUND_RECORDS) return { problem: findOverflowError(ordinal) };
                }
                const page = result.result;
                const cursor = page !== null && typeof page === "object" && !Array.isArray(page) ? page.nextCursor : null;
                if (cursor == null) return records;
                if (records.length === MAX_FOUND_RECORDS) return { problem: findOverflowError(ordinal) };
                if (cursors.some((seen) => isDeepStrictEqual(seen, cursor))) return { problem: `The Find in step ${ordinal + 1} returned a repeated cursor. Ask the owner to check its read operation.` };
                cursors.push(cursor);
                after = cursor;
              }
            },
            effects(ordinal, planned) {
              const convert = (planned: readonly PlannedEffect[], path: string) => {
                const dataset = inventory.datasets.get(path);
                if (dataset === undefined && codeOrdinals.has(ordinal)) return [...planned];
                if (dataset === undefined) return planned.map((effect) => effect.kind === "set" ? { ...effect, target: { ...effect.target, collectionPath: path } } : effect.kind === "add" ? { ...effect, collectionPath: path } : effect);
                const target = inventory.targets.get(path) as Extract<AutomationTarget, { kind: "dataset" }>;
                const effects = datasetStepEffects(ordinal, planned, dataset.steps, codeOrdinals.has(ordinal) ? (effect) => {
                  const selected = [...codeOperations].find(([request]) => request.collection === path && request.action === (effect.kind === "add" ? "add" : "change") &&
                    (effect.kind === "set" ? request.recordPath === effect.target.path :
                      request.table === effect.table && request.fields.length === effect.fields.length && effect.fields.every(({ field }) => request.fields.includes(field))));
                  if (selected === undefined) throw new Error(RULES_CHANGED_ERROR);
                  return selected[1];
                } : null, association(path).rules!, versions, path,
                  (tableId) => datasetUndoDeletes(roster, collection, dataset.rules.definition, tableId, target.grants, codeFilesOf(automation, collection.path))
                    .map((operation) => operation.operationId));
                return "problem" in effects ? effects : effects.map((effect) => effect.kind === "dataset-edit" || effect.kind === "dataset-create" ? { ...effect, collectionPath: path } : effect);
              };
              if (!codeOrdinals.has(ordinal)) return convert(planned, pathOf(ordinal));
              const effects: StoredRun["steps"][number]["effects"] = [];
              for (const effect of planned) {
                const path = effect.kind === "set" ? effect.target.collectionPath : effect.kind === "add" ? effect.collectionPath : collection.path;
                const converted = convert([effect], path);
                if ("problem" in converted) return converted;
                effects.push(...converted);
              }
              return effects;
            },
            destinations: (ordinal) => codeOrdinals.has(ordinal)
              ? [...new Set([...codeReach.values()].filter((entry) => entry.ordinal === ordinal).flatMap(({ reach }) => "collection" in reach ? [reach.collection.path] : []))].map(association)
              : [association(pathOf(ordinal))],
          });
        } catch (error) {
          if (error instanceof StepRecordChanged) {
            codeReach.clear();
            for (const [key, reach] of priorCodeReach) codeReach.set(key, reach);
            recordReadable = priorReadable;
            return "changed" as const;
          }
          throw error;
        }
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
      await authorizeCode(savedCodeTargets({ ordinal: place.ordinal, effects: [effect] }));
      await checkNow();
      const effectPath = effect.kind === "set" ? effect.target.collectionPath : "collectionPath" in effect ? effect.collectionPath ?? pathOf(place.ordinal) : pathOf(place.ordinal);
      await verifyTarget(effectPath);
      if (effect.kind === "dataset-edit" || effect.kind === "dataset-create" || effect.kind === "dataset-action") {
        const path = effectPath;
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
