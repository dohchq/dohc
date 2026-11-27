import type { ElementSnapshot, JsonObject } from "@dohc/excalidraw-scene";
import { each, isFields, okAnswer, segment, text } from "./api";
import type { ServerClient } from "./client";

const SKETCH_TIMEOUT_MS = 45_000;
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export interface SketchFileAsset {
  readonly id: string;
  readonly mimeType: string;
  readonly dataURL: string;
  readonly created: number;
  readonly lastRetrieved?: number;
  readonly version?: number;
}
export interface SketchScene {
  readonly path: string;
  readonly objectId: string;
  readonly elements: readonly ElementSnapshot[];
  readonly appState: JsonObject;
  readonly files: Readonly<Record<string, SketchFileAsset>>;
  readonly missingAssets: number;
}
export type SketchReadResult =
  | ({ readonly kind: "sketch" } & SketchScene)
  | { readonly kind: "missing" | "too-large" | "invalid" };
export type SketchCreateResult =
  | { readonly kind: "created"; readonly path: string; readonly objectId: string }
  | { readonly kind: "exists" };
export type SketchSaveResult =
  | ({ readonly kind: "saved"; readonly lostElementIds: readonly string[] } & SketchScene)
  | { readonly kind: "missing" | "object-changed" | "invalid" };

function readScene(result: Record<string, unknown>): SketchScene | null {
  const elements = each(result.elements, (item) =>
    isFields(item) &&
    text(item.id, 256) &&
    text(item.type, 64) &&
    (item.version === undefined || isCount(item.version)) &&
    (item.versionNonce === undefined || isCount(item.versionNonce))
      ? (item as unknown as ElementSnapshot)
      : null,
  );
  if (
    !text(result.path, 4096) ||
    !text(result.objectId, 256) ||
    !elements ||
    !isFields(result.appState) ||
    !isFields(result.files) ||
    !isCount(result.missingAssets)
  ) {
    return null;
  }
  const files: Record<string, SketchFileAsset> = {};
  for (const [key, item] of Object.entries(result.files)) {
    if (
      !isFields(item) ||
      !text(item.id, 256) ||
      !text(item.mimeType, 128) ||
      typeof item.dataURL !== "string" ||
      !item.dataURL.startsWith("data:") ||
      !isCount(item.created)
    ) {
      return null;
    }
    files[key] = {
      id: item.id,
      mimeType: item.mimeType,
      dataURL: item.dataURL,
      created: item.created,
      ...(isCount(item.lastRetrieved) ? { lastRetrieved: item.lastRetrieved } : {}),
      ...(isCount(item.version) ? { version: item.version } : {}),
    };
  }
  return {
    path: result.path,
    objectId: result.objectId,
    elements,
    appState: result.appState as JsonObject,
    files,
    missingAssets: result.missingAssets,
  };
}

const postSketch = <T>(
  client: ServerClient,
  workspaceId: string,
  op: string,
  body: unknown,
  parse: (result: Record<string, unknown>) => T | null,
  signal: AbortSignal,
) =>
  client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/${op}`,
    (raw) => {
      const result = okAnswer(raw)?.result;
      return isFields(result) ? parse(result) : null;
    },
    body,
    { signal, timeoutMs: SKETCH_TIMEOUT_MS },
  );

export const readSketch = (
  client: ServerClient,
  workspaceId: string,
  path: string,
  signal: AbortSignal,
) =>
  postSketch<SketchReadResult>(
    client,
    workspaceId,
    "readSketch",
    { path },
    (r) =>
      r.ok === true
        ? ((scene) => (scene ? { kind: "sketch", ...scene } : null))(readScene(r))
        : r.refusal === "missing" || r.refusal === "too-large" || r.refusal === "invalid"
          ? { kind: r.refusal }
          : null,
    signal,
  );

export const createSketch = (
  client: ServerClient,
  workspaceId: string,
  input: { readonly path: string; readonly requestId: string },
  signal: AbortSignal,
) =>
  postSketch<SketchCreateResult>(
    client,
    workspaceId,
    "createSketch",
    input,
    (r) =>
      r.ok === true
        ? text(r.path, 4096) && text(r.objectId, 256)
          ? { kind: "created", path: r.path, objectId: r.objectId }
          : null
        : r.refusal === "exists"
          ? { kind: "exists" }
          : null,
    signal,
  );

export const saveSketch = (
  client: ServerClient,
  workspaceId: string,
  input: {
    readonly path: string;
    readonly objectId: string;
    readonly requestId: string;
    readonly elements: readonly ElementSnapshot[];
    readonly appState?: JsonObject;
  },
  signal: AbortSignal,
) =>
  postSketch<SketchSaveResult>(
    client,
    workspaceId,
    "saveSketch",
    input,
    (r) => {
      if (r.ok === true) {
        const scene = readScene(r);
        const lostElementIds = each(r.lostElementIds, (id) => (text(id, 256) ? id : null));
        return scene && lostElementIds ? { kind: "saved", ...scene, lostElementIds } : null;
      }
      return r.refusal === "missing" || r.refusal === "object-changed" || r.refusal === "invalid"
        ? { kind: r.refusal }
        : null;
    },
    signal,
  );
