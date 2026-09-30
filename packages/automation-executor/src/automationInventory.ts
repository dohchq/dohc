import { AutomationRunWait } from "./automationRunWait";
import type { Automation } from "@dohc/workspace-contracts/automations";
import { bindingsIn, reachStepsOf, chatReachStepsOf, findQueryOf, shapeProblem, stepsInOrder, type FindValue } from "./automationPlan";
import type { ChatDirectory } from "./automationChat";
import type { AutomationTarget, AutomationTargets } from "./automationTargets";
import type { ReachStep } from "./automationReach";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { IrreversibleAction } from "./automationButtons";
import { datasetIrreversibleActions, datasetReachSteps, datasetStepsOf, recordStepDestinations, type DatasetRules, type DatasetSteps } from "./datasetAutomationPlan";

export interface AutomationInventory {
  targets: Map<string, AutomationTarget>;
  destinations: Map<number, string>;
  datasets: Map<string, { rules: DatasetRules; steps: DatasetSteps }>;
  reach: ReachStep[];
}

/** A button's caller must hold every operation, including implicit reads, in its own dataset. */
export async function canPressInventory(inventory: AutomationInventory, describe?: (datasetId: string) => Promise<DatasetDescription>): Promise<boolean> {
  const operations = new Map<string, Set<string>>();
  for (const step of inventory.reach) {
    if (step.kind !== "dataset-operation") continue;
    const ids = operations.get(step.datasetId) ?? new Set<string>();
    ids.add(step.operation.operationId);
    operations.set(step.datasetId, ids);
  }
  for (const [datasetId, ids] of operations) {
    if (describe === undefined) return false;
    try {
      const access = await describe(datasetId);
      if (access.datasetId !== datasetId ||
        [...ids].some((id) => !access.operations.some((operation) => operation.operationId === id))) return false;
    } catch { return false; }
  }
  return true;
}

/** Destination-qualified confirmations cannot authorize an identically named action elsewhere. */
export function irreversibleActionsOf(automation: Automation, source: string, inventory: AutomationInventory): IrreversibleAction[] {
  const actions = new Map<string, IrreversibleAction>();
  for (const { ordinal, step } of stepsInOrder(automation)) {
    if (step.kind !== "invoke") continue;
    const path = inventory.destinations.get(ordinal)!;
    const dataset = inventory.datasets.get(path)!;
    const [action] = datasetIrreversibleActions({ ...automation, do: [step] }, dataset.rules.definition);
    if (action === undefined) continue;
    const name = path === source ? action.name : `${dataset.rules.definition.datasetId}/${action.name}`;
    actions.set(name, { name, label: path === source ? action.label : `${path}: ${action.label}` });
  }
  return [...actions.values()];
}

/** Metadata and operation inventory. This never grants access to records. */
export async function resolveAutomationInventory(
  automation: Automation, source: string, resolver: AutomationTargets, chat: ChatDirectory | null,
): Promise<AutomationInventory> {
  const destinations = recordStepDestinations(automation, source);
  const targets = new Map<string, AutomationTarget>();
  for (const path of new Set([source, ...destinations.values()])) {
    const target = await resolver.resolve(path);
    if (target.kind === "problem") {
      if (target.code === "host-unavailable") throw new AutomationRunWait(target.problem);
      throw new Error(target.problem);
    }
    targets.set(path, target);
  }
  return automationInventory(automation, source, (path) => targets.get(path)!, chat);
}

/** The same synchronous inventory serves runs, reach, buttons, and notices. */
export function automationInventory(
  automation: Automation, source: string, resolve: (path: string) => AutomationTarget,
  chat: ChatDirectory | null,
): AutomationInventory {
  const destinations = recordStepDestinations(automation, source);
  const targets = new Map<string, AutomationTarget>();
  const datasets: AutomationInventory["datasets"] = new Map();
  const reach: ReachStep[] = [];
  for (const path of new Set([source, ...destinations.values()])) {
    const target = resolve(path);
    targets.set(path, target);
    if (target.kind !== "dataset") continue;
    if (path === source && !target.generated && automation.when.kind === "starts-matching") {
      throw new Error("An authored dataset cannot read records for a matching-condition trigger.");
    }
    const rules: DatasetRules = { definition: target.approved.definition, generated: target.generated, sourceCollection: source };
    const steps = datasetStepsOf(automation, rules);
    datasets.set(path, { rules, steps });
    const inventory = datasetReachSteps(automation, target.collection, rules, target.grants, null);
    if (inventory === null) throw new Error("This automation does not match the Collection rules. Check its approved operations.");
    reach.push(...inventory.filter((step) => step.kind === "dataset-operation" || step.kind === "dataset-field"));
  }
  const bindings = bindingsIn(automation);
  for (const { ordinal, step } of stepsInOrder(automation)) {
    const path = destinations.get(ordinal);
    if (path === undefined) continue;
    const target = targets.get(path)!;
    if (target.kind !== "document") continue;
    if (step.kind === "invoke") throw new Error("Only a dataset Collection has actions.");
    if (step.kind === "find" || step.kind === "add-record" || step.kind === "set") {
      if (step.operation !== null) throw new Error("A document Collection does not have dataset operations.");
      if (step.kind === "set" && step.records !== null && !bindings.has(step.records)) throw new Error("The Set step has no record binding.");

      if (step.kind !== "find" && target.fields !== null) {
        for (const { field } of step.values) if (!target.fields.has(field)) throw new Error(field + " is not a field in " + target.collection.name + ".");
      }
    }
  }
  const named = (path: string) => ({ path, name: path.split("/").at(-1) ?? path });
  const origin = targets.get(source)!;
  const recordReach = reachStepsOf(automation, named(source), named, chat);
  let documentIndex = 0;
  reach.unshift(...recordReach.flatMap((step, index): ReachStep[] => {
    if ((step.kind === "change-records" || step.kind === "find-records") && targets.get(step.collection.path)?.kind === "dataset") return [];
    if (origin.kind === "dataset") {
      if (step.kind !== "change-records" && step.kind !== "find-records") return [];
      return [{ ...step, identity: "document:" + documentIndex++ }];
    }
    return [{ ...step, identity: String(index) }];
  }));
  if (origin.kind === "dataset") reach.unshift(...chatReachStepsOf(automation, chat).map((step, index) => ({ ...step, identity: String(index) })));
  if (origin.kind === "document" && "table" in automation.when && automation.when.table !== null) throw new Error("Only a dataset Collection has named tables.");
  // Validate Find syntax with each destination's query language.
  const findValues = new Map<number, readonly FindValue[]>();
  for (const { ordinal, step } of stepsInOrder(automation)) {
    if (step.kind !== "find") continue;
    const path = destinations.get(ordinal)!;
    const values = targets.get(path)!.kind === "document" ? (() => {
      const query = findQueryOf(step.condition);
      return "problem" in query ? query : query.match === "all" ? [] : [query.value];
    })() : (datasets.get(path)!.steps.finds.get(ordinal) ?? []).map((filter) => filter.value);
    if ("problem" in values) throw new Error(values.problem);
    findValues.set(ordinal, values);
  }
  const problem = shapeProblem(automation, (_condition, ordinal) => findValues.get(ordinal) ?? []);
  if (problem !== null) throw new Error(problem);
  return { targets, destinations, datasets, reach };
}
