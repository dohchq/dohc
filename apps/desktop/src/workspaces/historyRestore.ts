import type {
  ChangeSetFileRecord,
  FileChangeSnapshot,
  RestoreHistoryFileResult,
} from "../ipc/bridgeContract";
import { createHash } from "node:crypto";
import { readWorkspaceText, restoreWorkspaceText } from "./workspaceAssets";
import { deletePath } from "./workspaceFiles";

type CurrentTextState =
  | { status: "text"; text: string }
  | { status: "missing" }
  | { status: "too-large" }
  | { status: "unavailable"; message: string };

type RestoreDirection = "restore" | "undo";

export interface HistoryRestoreExpectedEvent {
  path: string;
  operation: "update" | "delete";
  sha256?: string;
}

type RestoreAction =
  | {
      kind: "write";
      text: string;
      expected: { kind: "text"; text: string } | { kind: "missing" };
    }
  | { kind: "delete"; expectedText: string };

function snapshotText(snapshot: FileChangeSnapshot | null | undefined) {
  return typeof snapshot?.text === "string" ? snapshot.text : undefined;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function snapshotMissing(snapshot: FileChangeSnapshot | null | undefined) {
  return snapshot === null || snapshot?.unavailableReason === "missing";
}

async function readCurrentSmallText(
  rootPath: string,
  relativePath: string,
): Promise<CurrentTextState> {
  try {
    const current = await readWorkspaceText(rootPath, relativePath);
    if (current.truncated) return { status: "too-large" };
    return { status: "text", text: current.text };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
    return {
      status: "unavailable",
      message:
        error instanceof Error
          ? error.message
          : "The live file could not be verified.",
    };
  }
}

function unsafeSnapshotError(path: string) {
  return new Error(
    `Cannot restore ${path} because this history item has no safely restorable small-text snapshot.`,
  );
}

function changedError(direction: RestoreDirection, path: string) {
  return new Error(
    direction === "restore"
      ? `Cannot restore ${path} because the live file changed since this history item.`
      : `Cannot undo the restore for ${path} because the live file changed again.`,
  );
}

function missingError(direction: RestoreDirection, path: string) {
  return new Error(
    direction === "restore"
      ? `Cannot restore ${path} because the live file is missing.`
      : `Cannot undo the restore for ${path} because the live file is missing.`,
  );
}

function existsError(direction: RestoreDirection, path: string) {
  return new Error(
    direction === "restore"
      ? `Cannot restore ${path} because a live file already exists at that path.`
      : `Cannot undo the restore for ${path} because a live file already exists at that path.`,
  );
}

function tooLargeError(direction: RestoreDirection, path: string) {
  return new Error(
    direction === "restore"
      ? `Cannot restore ${path} because the live file is too large to verify safely.`
      : `Cannot undo the restore for ${path} because the live file is too large to verify safely.`,
  );
}

function unavailableError(
  direction: RestoreDirection,
  path: string,
  state: Extract<CurrentTextState, { status: "unavailable" }>,
) {
  const prefix =
    direction === "restore"
      ? `Cannot restore ${path}`
      : `Cannot undo the restore for ${path}`;
  return new Error(
    `${prefix} because the live path is not a small text file that can be verified safely. ${state.message}`,
  );
}

function buildAction(
  file: ChangeSetFileRecord,
  direction: RestoreDirection,
): RestoreAction {
  if (file.operation === "rename") throw unsafeSnapshotError(file.path);

  const beforeText = snapshotText(file.before);
  const afterText = snapshotText(file.after);
  const beforeMissing = snapshotMissing(file.before);
  const afterMissing = snapshotMissing(file.after);

  if (beforeText !== undefined && afterText !== undefined) {
    return direction === "restore"
      ? {
          kind: "write",
          text: beforeText,
          expected: { kind: "text", text: afterText },
        }
      : {
          kind: "write",
          text: afterText,
          expected: { kind: "text", text: beforeText },
        };
  }

  if (beforeText !== undefined && afterMissing) {
    return direction === "restore"
      ? {
          kind: "write",
          text: beforeText,
          expected: { kind: "missing" },
        }
      : { kind: "delete", expectedText: beforeText };
  }

  if (beforeMissing && afterText !== undefined) {
    return direction === "restore"
      ? { kind: "delete", expectedText: afterText }
      : {
          kind: "write",
          text: afterText,
          expected: { kind: "missing" },
        };
  }

  throw unsafeSnapshotError(file.path);
}

async function requireCurrentText(
  rootPath: string,
  relativePath: string,
  expectedText: string,
  direction: RestoreDirection,
) {
  const current = await readCurrentSmallText(rootPath, relativePath);
  if (current.status === "text") {
    if (current.text === expectedText) return;
    throw changedError(direction, relativePath);
  }
  if (current.status === "missing") throw missingError(direction, relativePath);
  if (current.status === "too-large") throw tooLargeError(direction, relativePath);
  throw unavailableError(direction, relativePath, current);
}

async function requireCurrentMissing(
  rootPath: string,
  relativePath: string,
  direction: RestoreDirection,
) {
  const current = await readCurrentSmallText(rootPath, relativePath);
  if (current.status === "missing") return;
  if (current.status === "too-large") throw tooLargeError(direction, relativePath);
  if (current.status === "unavailable") {
    throw unavailableError(direction, relativePath, current);
  }
  throw existsError(direction, relativePath);
}

async function applyAction(input: {
  rootPath: string;
  file: ChangeSetFileRecord;
  direction: RestoreDirection;
  trashItem: (absolutePath: string) => Promise<void>;
}): Promise<RestoreHistoryFileResult> {
  const action = buildAction(input.file, input.direction);

  if (action.kind === "write") {
    if (action.expected.kind === "missing") {
      await requireCurrentMissing(
        input.rootPath,
        input.file.path,
        input.direction,
      );
    } else {
      await requireCurrentText(
        input.rootPath,
        input.file.path,
        action.expected.text,
        input.direction,
      );
    }
    await restoreWorkspaceText(input.rootPath, input.file.path, action.text);
    return { restored: "text" };
  }

  await requireCurrentText(
    input.rootPath,
    input.file.path,
    action.expectedText,
    input.direction,
  );
  await deletePath(input.rootPath, input.file.path, input.trashItem);
  return { restored: "deleted" };
}

export async function restoreHistoryFileSnapshot(input: {
  rootPath: string;
  file: ChangeSetFileRecord;
  trashItem: (absolutePath: string) => Promise<void>;
}): Promise<RestoreHistoryFileResult> {
  return applyAction({ ...input, direction: "restore" });
}

export async function undoHistoryFileRestoreSnapshot(input: {
  rootPath: string;
  file: ChangeSetFileRecord;
  trashItem: (absolutePath: string) => Promise<void>;
}): Promise<RestoreHistoryFileResult> {
  return applyAction({ ...input, direction: "undo" });
}

export function expectedHistoryRestoreEvent(
  file: ChangeSetFileRecord,
  direction: RestoreDirection,
): HistoryRestoreExpectedEvent {
  const action = buildAction(file, direction);
  return action.kind === "write"
    ? { path: file.path, operation: "update", sha256: sha256Text(action.text) }
    : { path: file.path, operation: "delete" };
}
