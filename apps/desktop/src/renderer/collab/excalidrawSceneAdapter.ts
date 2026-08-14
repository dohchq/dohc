import {
  EXCALIDRAW_EXPORTABLE_APP_STATE,
  foldScene,
  insertElementRevision,
  revisionDominates,
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
export type SceneRemoteEchoes = {
  // Revision tuples of the elements the LAST remote render handed the canvas.
  elements: Set<string>;
  // Durable app-state values remote renders handed the canvas, per key.
  // Unlike elements these carry no revision identity, so a delayed
  // callback's stale value can only be recognized by remembering the values
  // themselves. Every unconsumed value is retained — evicting one would let
  // a long enough burst of renders replay its stale value — and the each-
  // callback consume paths plus canvas remounts keep the sets small.
  appState: Map<string, Set<string>>;
};

export function createSceneRemoteEchoes(): SceneRemoteEchoes {
  return { elements: new Set(), appState: new Map() };
}

export function sceneForCanvas(doc: Y.Doc): {
  elements: ElementSnapshot[];
  appState: JsonObject;
} {
  const scene = foldScene(doc);
  return { elements: scene.elements, appState: scene.appState };
}

export function rememberRemoteScene(
  scene: {
    elements: readonly ElementSnapshot[];
    appState: Readonly<Record<string, unknown>>;
  },
  echoes: SceneRemoteEchoes,
): void {
  echoes.elements.clear();
  for (const element of scene.elements) {
    echoes.elements.add(
      revisionKey(element.id, element.version, element.versionNonce),
    );
  }
  for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
    const value = scene.appState[key];
    if (value === undefined) continue;
    let values = echoes.appState.get(key);
    if (!values) {
      values = new Set();
      echoes.appState.set(key, values);
    }
    values.add(stableJson(jsonValueOf(value)));
  }
}

export function applyCanvasSceneChange(input: {
  doc: Y.Doc;
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  remoteEchoes: SceneRemoteEchoes;
  hydratedFileIds?: ReadonlySet<string>;
  // The transaction origin of THIS canvas. Two panes of one document share
  // one Y.Doc; each pane must recognize only its own transactions as local,
  // so the other pane's edits still render into it.
  origin?: unknown;
}): { changed: boolean; assetsRefused: boolean } {
  const current = foldScene(input.doc);
  const currentElements = new Map(
    current.elements.map((element) => [element.id, element]),
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
      if (input.remoteEchoes.elements.has(key)) {
        input.remoteEchoes.elements.delete(key);
        continue;
      }
      const winner = currentElements.get(element.id);
      if (
        winner &&
        revisionKey(winner.id, winner.version, winner.versionNonce) === key
      ) {
        continue;
      }
      if (
        winner &&
        revisionDominates(winner, element.version, element.versionNonce)
      ) {
        // A delayed Excalidraw callback can replay a render whose echo
        // identity a newer remote render already replaced. The fold would
        // discard this revision; writing it would journal and transmit a
        // record every reader drops.
        continue;
      }
      if (
        element.type === "text" &&
        element.isDeleted !== true &&
        (typeof element.text !== "string" || element.text.length === 0)
      ) {
        // Excalidraw streams a text element while it is being typed. Both
        // folds drop live text without content, so the revision is only
        // written once it carries text.
        continue;
      }
      if (insertElementRevision(input.doc, element)) changed = true;
    }

    for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
      const value = input.appState[key];
      if (value === undefined) continue;
      const jsonValue = jsonValueOf(value);
      const encoded = stableJson(jsonValue);
      const rememberedRemote = input.remoteEchoes.appState.get(key);
      const isRememberedRemote = rememberedRemote?.has(encoded) ?? false;
      const currentValue = current.appState[key];
      if (currentValue !== undefined && stableJson(currentValue) === encoded) {
        // The callback confirms the value the fold already holds. If that
        // value came from a remote render, this IS its echo — consume it now
        // so a later intentional local reversion to the same value cannot be
        // mistaken for a replay.
        if (isRememberedRemote) rememberedRemote?.delete(encoded);
        continue;
      }
      // A delayed callback can replay a superseded remote render's app state
      // (elements are guarded by revision dominance; app state has no
      // revision identity). A remembered remote value that no longer matches
      // the fold is such a replay — consume it instead of writing an old
      // gridSize or background over the newer value.
      if (isRememberedRemote) {
        rememberedRemote?.delete(encoded);
        continue;
      }
      setAppStateProperty(input.doc, key, jsonValue);
      changed = true;
    }
  }, input.origin ?? LOCAL_EXCALIDRAW_ORIGIN);
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
