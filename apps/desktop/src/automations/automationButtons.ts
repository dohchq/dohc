import type { DatasetDefinition, DatasetDescription } from "@dohc/security-contract/dataset";
import type { Automation, AutomationsFileParseResult } from "@dohc/workspace-contracts/automations";
import { recordedShareSelector } from "../workspaces/shareViewRecords";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { shareViewTakesLocalWrites } from "../workspaces/shareWriteGate";
import { collectionAutomationId, definitionHash, unsupportedReason } from "./automationPlan";
import { datasetOperationsOf } from "./datasetAutomationPlan";

// Button fields (item 8): which automation a button runs, and who may press
// it on this computer. Main decides both; a renderer only shows the answer.

/** A Button field's state, as its button shows it. */
export type AutomationButtonState =
  | { kind: "ready"; automationId: string }
  // Nothing runs yet. Someone who can edit the Collection can choose what it does.
  | { kind: "no-automation"; reason: string }
  | { kind: "disabled"; reason: string };

export const NO_AUTOMATION = "No automation uses this button.";
export const RUNNING_FOR_RECORD = "Running for this record.";

export function noAccessReason(collectionName: string): string {
  return `Only people who can edit ${collectionName} can use this button.`;
}

/** Why a press runs nothing: what it asked for is not what the button does now. */
export function changedSincePressed(field: string): string {
  return `${field} changed after it was pressed. Press it again.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * Who may press a document Collection's buttons from this computer, and
 * where the press runs. A workspace that is not a share view takes hand
 * edits, so it takes presses and runs them here. A share view cannot run
 * them: its automations need the owner's list of who can edit, which only
 * the owner can read. With Edit on main over the Collection's folder or a
 * folder above it, its presses are "relayed" to the computer that runs the
 * owner's schedules (ADR 0012); the relay checks the same rule. Edit on one
 * record's file, a version share, or a lower level is not enough.
 */
export function documentButtonAccess(shareView: unknown, collectionPath: string): "press" | "relayed" | "no-access" {
  if (!shareViewIsPresent(shareView)) return "press";
  const marker = isRecord(shareView) ? shareView : {};
  const grant = recordedShareSelector(marker.grantedSelector);
  if (!grant || !shareViewTakesLocalWrites({ access: grant.access, ended: marker.ended === true })) return "no-access";
  if (grant.versionId !== null || grant.paths.length === 0) return "no-access";
  const covers = grant.paths.some((path) => collectionPath === path || collectionPath.startsWith(`${path}/`));
  return covers ? "relayed" : "no-access";
}

/**
 * What a button in a shared view shows. The recipient's computer reads the
 * Collection's automations.yaml, but cannot check reach, so a button is
 * ready once one switched-on automation it can run uses it. The owner's
 * computer checks the rest when it runs the press.
 */
export function relayedButtonState(file: AutomationsFileParseResult | null, collectionPath: string, field: string, collectionName: string): AutomationButtonState {
  const target = relayedButtonTarget(file, collectionPath, field, collectionName);
  return "state" in target ? target.state : { kind: "ready", automationId: target.automationId };
}

/**
 * The automation a shared view's press asks the owner's computer to run,
 * with the definition the recipient sees, so it runs only if that still
 * holds. Or the state that stops it.
 */
export function relayedButtonTarget(
  file: AutomationsFileParseResult | null,
  collectionPath: string,
  field: string,
  collectionName: string,
): { automationId: string; definitionHash: string } | { state: Exclude<AutomationButtonState, { kind: "ready" }> } {
  const resolved = resolveButton(file, field, (table) => table === null, collectionName);
  if (resolved.kind === "state") return { state: resolved.state };
  const unsupported = unsupportedReason(resolved.automation);
  if (unsupported !== null) return { state: { kind: "disabled", reason: unsupported } };
  return { automationId: collectionAutomationId(collectionPath, resolved.automation.id), definitionHash: definitionHash(resolved.automation) };
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
 * Why a shared view's dataset button cannot run. Access comes first: a
 * person who cannot press it learns nothing about its automation. Its
 * dataset is on a server, which runs no automations yet, so a press that
 * passes access still stops.
 */
export function sharedDatasetButtonRefusal(input: {
  definition: DatasetDefinition;
  file: AutomationsFileParseResult | null;
  description: DatasetDescription;
  field: string;
  table: string | null;
}): string {
  const { definition } = input;
  const only = definition.tables.length === 1 ? definition.tables[0]!.name : null;
  const table = input.table ?? only;
  if (table === null || !definition.tables.some((candidate) => candidate.name === table)) {
    return noAccessReason(input.table ?? definition.name);
  }
  const resolution = resolveButton(input.file, input.field, (named) => named === table || (named === null && only !== null), definition.name);
  const invoked = resolution.kind === "one" ? datasetOperationsOf(resolution.automation, definition) : [];
  if (!datasetButtonAccess(input.description, table, invoked)) return noAccessReason(table);
  return resolution.kind === "state" ? resolution.state.reason : SHARED_DATASET_BUTTONS;
}
