import type { UndoHistoryOperationRefusal } from "../../ipc/bridgeContract";
import { basenameOf, dirnameOf } from "../path";
import type { PendingTreeChange, PendingTreeMove } from "./file-tree-optimistic";

// What the Explorer says after a rename, a move or a delete that main
// recorded as a History operation, and after its Undo.

export type RecordedTreeChange = {
  change: PendingTreeMove | Extract<PendingTreeChange, { kind: "delete-file" | "delete-folder" }>;
  operationId: string;
  // main offered Undo for this operation.
  undoable: boolean;
  // Why main offers no Undo, in its own words, when it says.
  noUndo?: string;
};

// The workspace's top level, named as the Explorer's own section header names it.
const TOP_LEVEL = "Files";

function folderOf(path: string): string {
  const folder = dirnameOf(path);
  return folder === "" ? TOP_LEVEL : basenameOf(folder);
}

// Several items can mix files and folders, so they are items.
function subject(done: readonly RecordedTreeChange[], path: (change: RecordedTreeChange["change"]) => string): string {
  return done.length === 1 ? basenameOf(path(done[0]!.change)) : `${done.length} items`;
}

const pathOf = (change: RecordedTreeChange["change"]) => ("path" in change ? change.path : change.fromPath);

export function operationWord(change: RecordedTreeChange["change"]): "delete" | "rename" | "move" {
  if ("path" in change) return "delete";
  return dirnameOf(change.fromPath) === dirnameOf(change.toPath) ? "rename" : "move";
}

// One action's changes are all deletes or all moves to one folder.
export function doneNotice(done: readonly RecordedTreeChange[]): { message: string; undoable: boolean } {
  const first = done[0]!.change;
  const word = operationWord(first);
  const message = "path" in first
    ? `Deleted ${subject(done, pathOf)}`
    : word === "rename" && done.length === 1
      ? `Renamed ${basenameOf(first.fromPath)} to ${basenameOf(first.toPath)}`
      : `Moved ${subject(done, pathOf)} to ${folderOf(first.toPath)}`;
  const refused = done.find((recorded) => !recorded.undoable);
  if (!refused) return { message, undoable: true };
  return { message: refused.noUndo ? `${message}. ${refused.noUndo}` : message, undoable: false };
}

// A refused Undo says what cannot happen, what is in the way, and what to do,
// since its row has Try again. A refusal main did not name says only what
// cannot happen; main's own text goes to Copy.
export function undoRefusedNotice(change: RecordedTreeChange["change"], refusal: UndoHistoryOperationRefusal): string {
  const word = operationWord(change);
  const failed = word === "delete"
    ? `Cannot restore ${basenameOf(pathOf(change))}.`
    : word === "rename" ? "Cannot undo the rename." : `Cannot move ${basenameOf(pathOf(change))} back.`;
  if (refusal.code !== "old-path-occupied") return failed;
  const name = basenameOf(refusal.path);
  return word === "move"
    ? `${failed} ${folderOf(refusal.path)} already has a ${name}. Move or rename that one, then try again.`
    : `${failed} A new ${name} is in its place. Move or rename it, then try again.`;
}

export function undoneNotice(done: readonly RecordedTreeChange[]): string {
  const first = done[0]!.change;
  if ("path" in first) return `Restored ${subject(done, pathOf)}`;
  if (done.length > 1) return `Moved ${done.length} items back`;
  return operationWord(first) === "rename"
    ? `Renamed ${basenameOf(first.toPath)} back to ${basenameOf(first.fromPath)}`
    : `Moved ${basenameOf(first.fromPath)} back to ${folderOf(first.fromPath)}`;
}
