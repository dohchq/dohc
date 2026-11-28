import { documentWords } from "@dohc/interface-words/documents";
import { workspaceNameError } from "@dohc/workspace-contracts/workspace-paths";
import { isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";
import { writesIn } from "./phoneWrites";
import type { WorkspaceData } from "./workspaceData";

export const FILE_WRITE_TIMEOUT_MS = 45_000;

const REFUSAL_TEXT = {
  "invalid-path": () => documentWords.invalidName,
  "path-exists": () => documentWords.refusedExists,
  "not-found": () => documentWords.refusedMissing,
  "stale-object": () => documentWords.refusedChanged,
  "live-active": () => documentWords.refusedLiveActive,
  "live-unsettled": () => documentWords.refusedLiveUnsettled,
} as const;

export type FileWriteRefusal = keyof typeof REFUSAL_TEXT;
export type FileWriteResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly objectId: string;
      readonly fromPath?: string;
    }
  | { readonly ok: false; readonly refusal: FileWriteRefusal; readonly reason: string };

export const canWriteFiles = (
  data: Pick<WorkspaceData, "joined"> | null,
  workspace: { readonly fileWritesAvailable?: boolean } | null | undefined,
): boolean => writesIn(data) && workspace?.fileWritesAvailable === true;

export function newFileRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export const fileWriteRefusalText = (refusal: FileWriteRefusal, fallback: string): string =>
  REFUSAL_TEXT[refusal]?.() ?? fallback;

export const fileExtension = (path: string): ".md" | ".excalidraw" =>
  /\.excalidraw$/i.test(path) ? ".excalidraw" : ".md";

export const editableStem = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|excalidraw)$/i, "");

export const parentFolder = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export function buildTargetPath(
  folder: string,
  enteredName: string,
  extension: ".md" | ".excalidraw",
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly error: string } {
  const trimmed = enteredName.trim();
  if (!trimmed) return { ok: false, error: documentWords.nameRequired };
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith("."))
    return { ok: false, error: documentWords.invalidName };
  const stem = trimmed.replace(new RegExp(`\\${extension}$`, "i"), "").trim();
  if (!stem || stem.startsWith(".")) return { ok: false, error: documentWords.invalidName };
  const fileName = `${stem}${extension}`;
  if (workspaceNameError(fileName, "win32") !== null)
    return { ok: false, error: documentWords.invalidName };
  return { ok: true, path: folder ? `${folder}/${fileName}` : fileName };
}

function readFileWriteResult(body: unknown): FileWriteResult | null {
  const answer = okAnswer(body);
  const result = answer && isFields(answer.result) ? answer.result : null;
  if (!result || typeof result.ok !== "boolean") return null;
  if (result.ok) {
    if (!text(result.path, 1024) || !text(result.objectId, 256)) return null;
    if (result.fromPath !== undefined && !text(result.fromPath, 1024)) return null;
    return {
      ok: true,
      path: result.path,
      objectId: result.objectId,
      ...(result.fromPath !== undefined ? { fromPath: result.fromPath } : {}),
    };
  }
  if (
    typeof result.refusal !== "string" ||
    !(result.refusal in REFUSAL_TEXT) ||
    !text(result.reason, 512)
  )
    return null;
  return { ok: false, refusal: result.refusal as FileWriteRefusal, reason: result.reason };
}

export function fileWriteOperations(client: ServerClient, workspaceId: string) {
  const run = (operation: string, args: object, signal?: AbortSignal) =>
    client.send(
      "POST",
      `/sync/${segment(workspaceId)}/ops/${operation}`,
      readFileWriteResult,
      args,
      {
        signal,
        timeoutMs: FILE_WRITE_TIMEOUT_MS,
      },
    );
  return {
    createPage: (
      input: { path: string; requestId: string; content?: string },
      signal?: AbortSignal,
    ) => run("createPage", input, signal),
    renameFile: (
      input: { fromPath: string; toPath: string; expectedObjectId: string; requestId: string },
      signal?: AbortSignal,
    ) => run("renameFile", input, signal),
    deleteFile: (
      input: { path: string; expectedObjectId: string; requestId: string },
      signal?: AbortSignal,
    ) => run("deleteFile", input, signal),
  };
}
