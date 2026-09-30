import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { Automation, AutomationsFileParseResult } from "@dohc/workspace-contracts/automations";
import { collectionAutomationId, definitionHash, unsupportedReason } from "./automationPlan";
import { recordStepDestinations } from "./datasetAutomationPlan";

// Button fields (item 8): which automation a button runs, and who may press
// it on this computer. Main decides both; a renderer only shows the answer.

/** A Button field's state, as its button shows it. */
export type AutomationButtonState =
  /**
   * `irreversible` lists the actions a press runs whose changes dohc cannot
   * undo, by operation name and by what a person reads, so the button asks
   * before it runs them. Absent when there are none.
   */
  | { kind: "ready"; automationId: string; irreversible?: IrreversibleAction[] }
  // Nothing runs yet. Someone who can edit the Collection can choose what it does.
  | { kind: "no-automation"; reason: string }
  | { kind: "disabled"; reason: string };

/**
 * An action a press runs that dohc cannot undo. `name` includes the dataset
 * id for another Collection and is what a press confirms; `label` is what the question shows,
 * with the name added where two actions share a label.
 */
export interface IrreversibleAction { name: string; label: string }

export const NO_AUTOMATION = "No automation uses this button.";
export const RUNNING_FOR_RECORD = "Running for this record.";

export function noAccessReason(collectionName: string): string {
  return `Only people who can edit ${collectionName} can use this button.`;
}

/** Why a press runs nothing: what it asked for is not what the button does now. */
export function changedSincePressed(field: string): string {
  return `${field} changed after it was pressed. Press it again.`;
}

// The file contract loads each mapping as a Map.
const entryOf = (value: unknown, key: string): unknown => (value instanceof Map ? value.get(key) : undefined);

/** An entry the file contract refused whose trigger still names this button. */
export function namesButton(raw: unknown, field: string): boolean {
  return entryOf(entryOf(raw, "when"), "button") === field;
}

export type ButtonResolution =
  | { kind: "one"; automation: Automation }
  | { kind: "state"; state: Exclude<AutomationButtonState, { kind: "ready" }> };

/**
 * The one switched-on automation a button runs, or the state that stops it:
 * none, one that is off, one the file contract refused, or several.
 * `inTable` says whether a trigger's `table` names the button's table.
 */
export function resolveButton(
  file: AutomationsFileParseResult | null,
  field: string,
  inTable: (table: string | null) => boolean,
  collectionName: string,
): ButtonResolution {
  const disabled = (reason: string): ButtonResolution => ({ kind: "state", state: { kind: "disabled", reason } });
  if (file?.status === "unreadable") return disabled(`dohc cannot read automations.yaml in ${collectionName}. Fix it in Automations.`);
  const entries = file?.entries ?? [];
  const using = entries.flatMap((entry) =>
    entry.status === "valid" && entry.automation.when.kind === "button" &&
      entry.automation.when.field === field && inTable(entry.automation.when.table)
      ? [entry.automation]
      : []);
  const on = using.filter((automation) => automation.enabled);
  if (on.length === 1) return { kind: "one", automation: on[0]! };
  if (on.length > 1) return disabled(`${on.length === 2 ? "Two" : on.length} automations use ${field}. Keep one.`);
  if (using.length > 0) return disabled(`${using[0]!.name} is off. Turn it on in Automations.`);
  if (entries.some((entry) => entry.status === "invalid" && namesButton(entry.raw, field))) {
    return disabled(`The automation for ${field} has a problem. Fix it in Automations.`);
  }
  return { kind: "state", state: { kind: "no-automation", reason: NO_AUTOMATION } };
}

export const UNVERIFIED_SHARED_DATASET_ACCESS = "dohc cannot check your dataset access for this button in a shared view. Ask the owner to run it.";

export type ButtonDestinationKind = (path: string) => Promise<"document" | "dataset" | null>;

/** Shared presses have no caller dataset description. Unknown destinations cannot prove that none is needed. */
export async function relayedDatasetReason(automation: Automation, source: string, destinationKind: ButtonDestinationKind): Promise<string | null> {
  try {
    for (const path of new Set([source, ...recordStepDestinations(automation, source).values()])) {
      if (await destinationKind(path) !== "document") return UNVERIFIED_SHARED_DATASET_ACCESS;
    }
  } catch {
    return UNVERIFIED_SHARED_DATASET_ACCESS;
  }
  return null;
}

/** What a shared view shows, with the same dataset check that admits its press. */
export async function relayedButtonState(
  file: AutomationsFileParseResult | null, collectionId: string, field: string, collectionName: string,
  collectionPath: string, destinationKind: ButtonDestinationKind,
): Promise<AutomationButtonState> {
  const target = await relayedButtonTarget(file, collectionId, field, collectionName, collectionPath, destinationKind);
  return "state" in target ? target.state : { kind: "ready", automationId: target.automationId };
}

/**
 * The automation a shared view's press asks the owner's computer to run,
 * with the definition the recipient sees, so it runs only if that still
 * holds. Or the state that stops it.
 */
export async function relayedButtonTarget(
  file: AutomationsFileParseResult | null,
  /** The Collection's id: the object id of its collection.yaml. */
  collectionId: string,
  field: string,
  collectionName: string,
  collectionPath: string,
  destinationKind: ButtonDestinationKind,
): Promise<{ automationId: string; definitionHash: string } | { state: Exclude<AutomationButtonState, { kind: "ready" }> }> {
  const resolved = resolveButton(file, field, (table) => table === null, collectionName);
  if (resolved.kind === "state") return { state: resolved.state };
  const datasetReason = await relayedDatasetReason(resolved.automation, collectionPath, destinationKind);
  if (datasetReason !== null) return { state: { kind: "disabled", reason: datasetReason } };
  const unsupported = unsupportedReason(resolved.automation);
  if (unsupported !== null) return { state: { kind: "disabled", reason: unsupported } };
  return { automationId: collectionAutomationId(collectionId, resolved.automation.id), definitionHash: definitionHash(resolved.automation) };
}

/**
 * Whether the operations the host describes for the person pressing let
 * them press a dataset table's button: a writable operation on the table,
 * and every operation the button's steps invoke.
 */
export function datasetButtonAccess(description: DatasetDescription, tableName: string, invoked: readonly string[]): boolean {
  const table = description.tables.find((candidate) => candidate.name === tableName);
  if (!table) return false;
  const names = new Set(description.operations.map((operation) => operation.name));
  return description.operations.some((operation) => operation.tableId === table.tableId && !operation.readOnly) &&
    invoked.every((name) => names.has(name));
}

export const SHARED_DATASET_BUTTONS = "dohc can't run buttons on shared dataset Collections yet.";

/**
 * What a dataset button shows in a shared view. Its dataset is on a server,
 * which runs no automations yet, so no button runs. Someone who cannot edit
 * the button's table is told that, as anywhere else.
 */
export function sharedDatasetButtonState(description: DatasetDescription, tableName: string): Extract<AutomationButtonState, { kind: "disabled" }> {
  return { kind: "disabled", reason: datasetButtonAccess(description, tableName, []) ? SHARED_DATASET_BUTTONS : noAccessReason(tableName) };
}
