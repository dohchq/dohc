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
  // Where main put a deleted row: the system trash (true) or the workspace's
  // own .dohc/local/trash (false).
  trashed?: boolean;
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

const WORKSPACE_TRASH = ".dohc/local/trash in this workspace";

// Where a delete's rows went, counted as its subject counts them. Once the
// notice is gone, that place is the way back.
function deletedPlace(done: readonly RecordedTreeChange[]): string | undefined {
  const system = done.filter((recorded) => recorded.trashed === true).length;
  const workspace = done.filter((recorded) => recorded.trashed === false).length;
  if (system + workspace !== done.length) return undefined;
  if (workspace === 0) return done.length === 1 ? "It's in the system trash." : "They're in the system trash.";
  if (system === 0) return done.length === 1 ? `It's in ${WORKSPACE_TRASH}.` : `They're in ${WORKSPACE_TRASH}.`;
  const are = (count: number) => `${count} ${count === 1 ? "is" : "are"}`;
  return `${are(system)} in the system trash, and ${are(workspace)} in ${WORKSPACE_TRASH}.`;
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
  // Without Undo, main's reason already says where the rows are.
  if (!refused) {
    const place = "path" in first ? deletedPlace(done) : undefined;
    return { message: place ? `${message}. ${place}` : message, undoable: true };
  }
  return { message: refused.noUndo ? `${message}. ${refused.noUndo}` : message, undoable: false };
}

// A refused Undo fits a notice's two lines: what failed, then the one thing to
// do before Try again. A refusal main did not name says only what failed. The
// cause, in main's own text, goes to Copy.
export function undoRefusedNotice(change: RecordedTreeChange["change"], refusal: UndoHistoryOperationRefusal): string {
  const word = operationWord(change);
  const failed = word === "delete"
    ? `Cannot restore ${basenameOf(pathOf(change))}.`
    : word === "rename" ? "Cannot undo the rename." : `Cannot move ${basenameOf(pathOf(change))} back.`;
  if (refusal.code === "unexplained") return failed;
  const name = basenameOf(refusal.path);
  if (refusal.code === "live-page-owned") return `${failed} Stop live editing for ${name} first.`;
  return word === "move"
    ? `${failed} Move the ${name} in ${folderOf(refusal.path)} first.`
    : `${failed} Move the new ${name} first.`;
}

export function undoneNotice(done: readonly RecordedTreeChange[]): string {
  const first = done[0]!.change;
  if ("path" in first) return `Restored ${subject(done, pathOf)}`;
  if (done.length > 1) return `Moved ${done.length} items back`;
  return operationWord(first) === "rename"
    ? `Renamed ${basenameOf(first.toPath)} back to ${basenameOf(first.fromPath)}`
    : `Moved ${basenameOf(first.fromPath)} back to ${folderOf(first.fromPath)}`;
}
