import {
  EXCALIDRAW_EXPORTABLE_APP_STATE,
  createIncrementalSceneFold,
  insertElementRevision,
  revisionDominates,
  revisionKey,
  setAppStateProperty,
  stableJson,
  type ElementSnapshot,
  type FoldedScene,
  type IncrementalSceneFold,
  type JsonObject,
  type JsonValue,
} from "@dohc/excalidraw-scene";
import * as Y from "yjs";

export const LOCAL_EXCALIDRAW_ORIGIN: unique symbol = Symbol(
  "dohc.localExcalidrawChange",
);

type SceneRemoteEchoes = {
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

type CanvasScene = {
  elements: ElementSnapshot[];
  appState: JsonObject;
};

type CanvasSceneChange = {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  hydratedFileIds?: ReadonlySet<string>;
  // The transaction origin of THIS canvas. Two panes of one document share
  // one Y.Doc; each pane must recognize only its own transactions as local,
  // so the other pane's edits still render into it.
  origin?: unknown;
};

export class ExcalidrawSceneBinding {
  private readonly fold: IncrementalSceneFold;
  private readonly canvasElements = new Map<
    string,
    { source: ElementSnapshot; canvas: ElementSnapshot }
  >();
  private readonly remoteEchoes: SceneRemoteEchoes = {
    elements: new Set(),
    appState: new Map(),
  };

  constructor(private readonly doc: Y.Doc) {
    this.fold = createIncrementalSceneFold(doc);
  }

  current(): FoldedScene {
    return this.fold.current();
  }

  canvas(): CanvasScene {
    return this.canvasScene(this.fold.current());
  }

  refresh(): FoldedScene {
    this.fold.refresh();
    return this.current();
  }

  remote(transaction?: Y.Transaction): CanvasScene {
    if (transaction) this.fold.update(transaction);
    const scene = this.fold.current();
    rememberRemoteScene(scene, this.remoteEchoes);
    return this.canvasScene(scene);
  }

  apply(input: CanvasSceneChange): {
    changed: boolean;
    assetsRefused: boolean;
  } {
    const current = this.fold.current();
    let changed = false;
    let assetsRefused = false;
    const origin = input.origin ?? LOCAL_EXCALIDRAW_ORIGIN;
    let appliedTransaction: Y.Transaction | undefined;
    const captureTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === origin) appliedTransaction = transaction;
    };
    this.doc.on("afterTransaction", captureTransaction);
    try {
      this.doc.transact(() => {
        for (const raw of input.elements) {
          const identity = elementIdentity(raw);
          if (
            hasUnsupportedFileBytes(
              identity.raw,
              input.files,
              current.assets,
              input.hydratedFileIds,
            )
          ) {
            assetsRefused = true;
            continue;
          }
          if (this.remoteEchoes.elements.has(identity.key)) {
            this.remoteEchoes.elements.delete(identity.key);
            continue;
          }
          const winner = this.fold.element(identity.id);
          if (
            winner &&
            revisionKey(winner.id, winner.version, winner.versionNonce) ===
              identity.key
          ) {
            continue;
          }
          if (
            winner &&
            revisionDominates(winner, identity.version, identity.versionNonce)
          ) {
            // A delayed Excalidraw callback can replay a render whose echo
            // identity a newer remote render already replaced. The fold would
            // discard this revision; writing it would journal and transmit a
            // record every reader drops.
            continue;
          }
          const element = jsonObject(raw) as ElementSnapshot;
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
          if (insertElementRevision(this.doc, element)) changed = true;
        }

        for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
          const value = input.appState[key];
          if (value === undefined) continue;
          const jsonValue = jsonValueOf(value);
          const encoded = stableJson(jsonValue);
          const rememberedRemote = this.remoteEchoes.appState.get(key);
          const isRememberedRemote = rememberedRemote?.has(encoded) ?? false;
          const currentValue = current.appState[key];
          if (
            currentValue !== undefined &&
            stableJson(currentValue) === encoded
          ) {
            // The callback confirms the value the fold already holds. If that
            // value came from a remote render, this IS its echo — consume it
            // now so a later intentional local reversion to the same value
            // cannot be mistaken for a replay.
            if (isRememberedRemote) rememberedRemote?.delete(encoded);
            continue;
          }
          // A delayed callback can replay a superseded remote render's app
          // state (elements are guarded by revision dominance; app state has
          // no revision identity). A remembered remote value that no longer
          // matches the fold is such a replay — consume it instead of writing
          // an old gridSize or background over the newer value.
          if (isRememberedRemote) {
            rememberedRemote?.delete(encoded);
            continue;
          }
          setAppStateProperty(this.doc, key, jsonValue);
          changed = true;
        }
      }, origin);
    } finally {
      this.doc.off("afterTransaction", captureTransaction);
      if (appliedTransaction) this.fold.update(appliedTransaction);
    }
    return { changed, assetsRefused };
  }

  private canvasScene(scene: FoldedScene): CanvasScene {
    const currentIds = new Set<string>();
    const elements = scene.elements.map((source) => {
      currentIds.add(source.id);
      const cached = this.canvasElements.get(source.id);
      if (cached?.source === source) return cached.canvas;
      const canvas = jsonObject(source) as ElementSnapshot;
      this.canvasElements.set(source.id, { source, canvas });
      return canvas;
    });
    for (const id of this.canvasElements.keys()) {
      if (!currentIds.has(id)) this.canvasElements.delete(id);
    }
    return {
      elements,
      appState: jsonObject(scene.appState),
    };
  }
}

function rememberRemoteScene(
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

function elementIdentity(value: unknown): {
  raw: Readonly<Record<string, unknown>>;
  id: string;
  version: number;
  versionNonce: number;
  key: string;
} {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("The drawing element is not valid JSON.");
  }
  const raw = value as Record<string, unknown>;
  const id = raw.id as string;
  const version = raw.version as number;
  const versionNonce = raw.versionNonce as number;
  return {
    raw,
    id,
    version,
    versionNonce,
    key: revisionKey(id, version, versionNonce),
  };
}

function hasUnsupportedFileBytes(
  element: Readonly<Record<string, unknown>>,
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
  if (
    normalized === null ||
    Array.isArray(normalized) ||
    typeof normalized !== "object"
  ) {
    throw new Error("The drawing element is not valid JSON.");
  }
  return normalized;
}

function jsonValueOf(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("The drawing change is not valid JSON.");
  }
  return JSON.parse(encoded) as JsonValue;
}
