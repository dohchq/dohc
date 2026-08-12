import {
  EXCALIDRAW_EXPORTABLE_APP_STATE,
  foldScene,
  insertElementRevision,
  revisionKey,
  setAppStateProperty,
  stableJson,
  type ElementSnapshot,
  type JsonObject,
  type JsonValue,
} from "@dohc/excalidraw-scene";
import * as Y from "yjs";

export const LOCAL_EXCALIDRAW_ORIGIN: unique symbol = Symbol(
  "dohc.localExcalidrawChange",
);

// Excalidraw restores legacy/sparse elements before it calls `onChange`.
// Consequently, the callback for a remote revision can contain normalized
// JSON even though it still carries the same immutable revision identity.
// Consume that identity once; a real local edit always bumps the version and
// nonce, so it cannot be mistaken for the remote callback.
export type SceneRemoteEchoes = Set<string>;

export function sceneForCanvas(doc: Y.Doc): {
  elements: ElementSnapshot[];
  appState: JsonObject;
} {
  const scene = foldScene(doc);
  return { elements: scene.elements, appState: scene.appState };
}

export function rememberRemoteScene(
  elements: readonly ElementSnapshot[],
  echoes: SceneRemoteEchoes,
): void {
  echoes.clear();
  for (const element of elements) {
    echoes.add(revisionKey(element.id, element.version, element.versionNonce));
  }
}

export function applyCanvasSceneChange(input: {
  doc: Y.Doc;
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  remoteEchoes: SceneRemoteEchoes;
  hydratedFileIds?: ReadonlySet<string>;
}): { changed: boolean; assetsRefused: boolean } {
  const current = foldScene(input.doc);
  const currentElements = new Map(
    current.elements.map((element) => [element.id, stableJson(element)]),
  );
  let changed = false;
  let assetsRefused = false;
  input.doc.transact(() => {
    for (const raw of input.elements) {
      const element = jsonObject(raw) as ElementSnapshot;
      if (
        hasUnsupportedFileBytes(
          element,
          input.files,
          current.assets,
          input.hydratedFileIds,
        )
      ) {
        assetsRefused = true;
        continue;
      }
      const key = revisionKey(
        element.id,
        element.version,
        element.versionNonce,
      );
      const encoded = stableJson(element);
      if (input.remoteEchoes.has(key)) {
        input.remoteEchoes.delete(key);
        continue;
      }
      if (currentElements.get(element.id) === encoded) continue;
      if (insertElementRevision(input.doc, element)) changed = true;
    }

    for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
      const value = input.appState[key];
      if (value === undefined) continue;
      const jsonValue = jsonValueOf(value);
      const currentValue = current.appState[key];
      if (
        currentValue !== undefined &&
        stableJson(currentValue) === stableJson(jsonValue)
      ) {
        continue;
      }
      setAppStateProperty(input.doc, key, jsonValue);
      changed = true;
    }
  }, LOCAL_EXCALIDRAW_ORIGIN);
  return { changed, assetsRefused };
}

function hasUnsupportedFileBytes(
  element: ElementSnapshot,
  files: Record<string, unknown>,
  assets: Record<string, unknown>,
  hydratedFileIds?: ReadonlySet<string>,
): boolean {
  if (element.isDeleted || typeof element.fileId !== "string") return false;
  const file = files[element.fileId];
  const carriesBytes =
    typeof file === "object" &&
    file !== null &&
    "dataURL" in file &&
    typeof (file as { dataURL?: unknown }).dataURL === "string";
  return (
    carriesBytes &&
    (!assets[element.fileId] || !hydratedFileIds?.has(element.fileId))
  );
}

function jsonObject(value: unknown): JsonObject {
  const normalized = jsonValueOf(value);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new Error("The drawing element is not valid JSON.");
  }
  return normalized;
}

function jsonValueOf(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The drawing change is not valid JSON.");
  return JSON.parse(encoded) as JsonValue;
}
