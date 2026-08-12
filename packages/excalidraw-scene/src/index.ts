import * as Y from "yjs";
import { EXCALIDRAW_SCENE_ROOTS } from "@dohc/workspace-contracts/live-documents";

export const EXCALIDRAW_SCENE_SCHEMA = {
  version: 1,
  roots: EXCALIDRAW_SCENE_ROOTS,
} as const;

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface ElementSnapshot extends JsonObject {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index?: string | null;
}

export interface SceneAsset extends JsonObject {
  id: string;
  mimeType: string;
  created: number;
  ref: string;
  sha256: string;
  lastRetrieved?: number;
  version?: number;
}

export interface FoldedScene {
  elements: ElementSnapshot[];
  appState: JsonObject;
  assets: Record<string, SceneAsset>;
}

export const EXCALIDRAW_EXPORTABLE_APP_STATE = [
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "viewBackgroundColor",
] as const;
const EXPORTABLE_APP_STATE = new Set<string>(EXCALIDRAW_EXPORTABLE_APP_STATE);
const ASSET_FIELDS = new Set([
  "id",
  "mimeType",
  "created",
  "ref",
  "sha256",
  "lastRetrieved",
  "version",
]);

export class SceneCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneCodecError";
  }
}

export function declareSceneRoots(doc: Y.Doc) {
  return {
    revisions: doc.getMap<string>(EXCALIDRAW_SCENE_SCHEMA.roots.revisions),
    appState: doc.getMap<string>(EXCALIDRAW_SCENE_SCHEMA.roots.appState),
    assets: doc.getMap<string>(EXCALIDRAW_SCENE_SCHEMA.roots.assets),
  };
}

export function revisionKey(id: string, version: number, versionNonce: number): string {
  validateIdentity(id, version, versionNonce);
  return JSON.stringify([id, version, versionNonce]);
}

export function parseRevisionKey(key: string): readonly [string, number, number] {
  let tuple: unknown;
  try {
    tuple = JSON.parse(key);
  } catch {
    throw new SceneCodecError("The element revision key is not valid JSON.");
  }
  if (!Array.isArray(tuple) || tuple.length !== 3) {
    throw new SceneCodecError("The element revision key must be a three-item JSON tuple.");
  }
  const [id, version, nonce] = tuple;
  validateIdentity(id, version, nonce);
  if (revisionKey(id, version as number, nonce as number) !== key) {
    throw new SceneCodecError("The element revision key must use canonical JSON.");
  }
  return [id, version, nonce];
}

export function insertElementRevision(doc: Y.Doc, input: unknown): boolean {
  const element = validateElement(input);
  const key = revisionKey(element.id, element.version, element.versionNonce);
  const encoded = stableJson(element);
  const revisions = declareSceneRoots(doc).revisions;
  const existing = revisions.get(key);
  if (existing === encoded) return false;
  if (existing !== undefined) {
    throw new SceneCodecError("The element revision tuple already has different content.");
  }
  doc.transact(() => {
    const observed = [...revisions.keys()];
    revisions.set(key, encoded);
    for (const observedKey of observed) {
      try {
        const [id, version, nonce] = parseRevisionKey(observedKey);
        if (id === element.id && dominates(element, version, nonce)) {
          revisions.delete(observedKey);
        }
      } catch {
        // A malformed remote key cannot block a valid local revision.
      }
    }
  });
  return true;
}

export function setAppStateProperty(doc: Y.Doc, key: string, value: JsonValue): void {
  validateAppStateProperty(key, value);
  const encoded = stableJson(value);
  doc.transact(() => declareSceneRoots(doc).appState.set(key, encoded));
}

export function putSceneAsset(doc: Y.Doc, input: unknown): void {
  const asset = validateAsset(input);
  doc.transact(() =>
    declareSceneRoots(doc).assets.set(asset.id, stableJson(asset)),
  );
}

export function foldScene(doc: Y.Doc): FoldedScene {
  const roots = declareSceneRoots(doc);
  const winners = new Map<string, ElementSnapshot>();
  for (const [key, encoded] of roots.revisions) {
    try {
      const tuple = parseRevisionKey(key);
      const parsed = parseStored(encoded, "element revision");
      if (stableJson(parsed) !== encoded) continue;
      const element = validateElement(parsed);
      if (revisionKey(element.id, element.version, element.versionNonce) !== key) {
        continue;
      }
      const previous = winners.get(tuple[0]);
      if (!previous || compareRevision(element, previous) > 0) {
        winners.set(element.id, element);
      }
    } catch {
      // A malformed remote record is not part of the scene. Other records in
      // the same Y.Map remain usable and converge independently.
    }
  }

  const elements = [...winners.values()].sort(compareElementOrder);
  const appState: JsonObject = {};
  for (const [key, encoded] of roots.appState) {
    try {
      const parsed = parseStored(encoded, "app-state value");
      validateAppStateProperty(key, parsed);
      if (stableJson(parsed) === encoded) appState[key] = parsed;
    } catch {
      // Ignore only this invalid property.
    }
  }
  const assets: Record<string, SceneAsset> = {};
  for (const [id, encoded] of roots.assets) {
    try {
      const parsed = parseStored(encoded, "asset");
      if (stableJson(parsed) !== encoded) continue;
      const asset = validateAsset(parsed);
      if (asset.id === id) assets[id] = asset;
    } catch {
      // Ignore only this invalid asset record.
    }
  }
  return { elements, appState, assets };
}

export function exportPortableScene(doc: Y.Doc): string {
  const scene = foldScene(doc);
  const liveElements = scene.elements.filter((element) => !element.isDeleted);
  const liveIds = new Set(liveElements.map((element) => element.id));
  const elements = liveElements.map((element) =>
    repairElementReferences(
      clearElementForExport(element),
      liveIds,
      new Set(Object.keys(scene.assets)),
    ),
  );
  const appState: JsonObject = {};
  for (const key of Object.keys(scene.appState).sort(compareUnicodeScalar)) {
    if (EXPORTABLE_APP_STATE.has(key)) appState[key] = scene.appState[key]!;
  }
  return stableJson({
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState,
    files: {},
  });
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SceneCodecError("Scene JSON numbers must be finite.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    keys.forEach(assertWellFormedUnicode);
    const entries = keys
      .sort(compareUnicodeScalar)
      .flatMap((key) => {
        const item = (value as Record<string, unknown>)[key];
        return item === undefined
          ? []
          : [`${JSON.stringify(key)}:${stableJson(item)}`];
      });
    return `{${entries.join(",")}}`;
  }
  throw new SceneCodecError("Scene data must contain only JSON values.");
}

function validateElement(input: unknown): ElementSnapshot {
  if (!isObject(input)) throw new SceneCodecError("The element revision must be a JSON object.");
  validateIdentity(input.id, input.version, input.versionNonce);
  if (typeof input.type !== "string" || input.type.length === 0)
    throw new SceneCodecError("The element type must not be empty.");
  if (input.type === "selection")
    throw new SceneCodecError("A selection cannot be stored as a drawing element.");
  if (typeof input.isDeleted !== "boolean")
    throw new SceneCodecError("The element deletion flag must be a Boolean.");
  if ("index" in input && input.index !== null && typeof input.index !== "string")
    throw new SceneCodecError("The element index must be a string, null, or missing.");
  stableJson(input);
  return input as ElementSnapshot;
}

function validateIdentity(id: unknown, version: unknown, nonce: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0)
    throw new SceneCodecError("The element ID must not be empty.");
  assertWellFormedUnicode(id);
  if (!Number.isSafeInteger(version) || (version as number) < 0)
    throw new SceneCodecError("The element version must be a nonnegative safe integer.");
  if (!Number.isSafeInteger(nonce) || (nonce as number) < 0)
    throw new SceneCodecError("The element version nonce must be a nonnegative safe integer.");
}

function validateAppStateProperty(key: string, value: JsonValue): void {
  assertWellFormedUnicode(key);
  const valid =
    key === "gridModeEnabled"
      ? typeof value === "boolean"
      : key === "gridSize" || key === "gridStep"
        ? value === null || (typeof value === "number" && Number.isFinite(value))
        : key === "viewBackgroundColor"
          ? typeof value === "string" && value.length > 0
          : false;
  if (!valid) {
    throw new SceneCodecError("The app-state property is not a valid durable value.");
  }
}

function validateAsset(input: unknown): SceneAsset {
  if (!isObject(input)) throw new SceneCodecError("The asset must be a JSON object.");
  if (Object.keys(input).some((key) => !ASSET_FIELDS.has(key)))
    throw new SceneCodecError("The asset record has an unsupported property.");
  if (typeof input.id !== "string" || input.id.length === 0)
    throw new SceneCodecError("The asset ID must not be empty.");
  if (typeof input.mimeType !== "string" || input.mimeType.length === 0)
    throw new SceneCodecError("The asset MIME type must not be empty.");
  if (!Number.isSafeInteger(input.created) || (input.created as number) < 0)
    throw new SceneCodecError("The asset creation time must be a nonnegative safe integer.");
  for (const field of ["lastRetrieved", "version"] as const) {
    const value = input[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new SceneCodecError(`The asset ${field} value must be a nonnegative safe integer.`);
    }
  }
  if (typeof input.ref !== "string" || !isWorkspaceRelativeRef(input.ref))
    throw new SceneCodecError("The asset reference must be a normalized workspace-relative path.");
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256))
    throw new SceneCodecError("The asset SHA-256 must be 64 lowercase hexadecimal characters.");
  stableJson(input);
  return input as SceneAsset;
}

function isWorkspaceRelativeRef(ref: string): boolean {
  if (
    !ref ||
    ref.includes("\\") ||
    ref.includes(":") ||
    ref.startsWith("/") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(ref)
  ) return false;
  const parts = ref.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function dominates(element: ElementSnapshot, version: number, nonce: number): boolean {
  return element.version > version || (element.version === version && element.versionNonce < nonce);
}

function compareRevision(left: ElementSnapshot, right: ElementSnapshot): number {
  if (left.version !== right.version) return left.version - right.version;
  return right.versionNonce - left.versionNonce;
}

function compareElementOrder(left: ElementSnapshot, right: ElementSnapshot): number {
  const leftIndex = indexKey(left);
  const rightIndex = indexKey(right);
  const indexOrder =
    leftIndex[0] - rightIndex[0] ||
    compareUnicodeScalar(leftIndex[1], rightIndex[1]);
  return indexOrder || compareUnicodeScalar(left.id, right.id);
}

export function compareUnicodeScalar(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new SceneCodecError("Scene JSON strings must contain valid Unicode.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SceneCodecError("Scene JSON strings must contain valid Unicode.");
    }
  }
}

function indexKey(element: ElementSnapshot): readonly [number, string] {
  if (element.index === undefined) return [2, ""];
  if (element.index === null) return [1, ""];
  return [0, element.index];
}

function clearElementForExport(element: ElementSnapshot): ElementSnapshot {
  if (element.type === "line" || element.type === "arrow") {
    return { ...element, lastCommittedPoint: null };
  }
  return element;
}

function repairElementReferences(
  element: ElementSnapshot,
  liveIds: ReadonlySet<string>,
  assetIds: ReadonlySet<string>,
): ElementSnapshot {
  const repaired: ElementSnapshot = { ...element };
  if (Array.isArray(element.boundElements)) {
    const seen = new Set<string>();
    repaired.boundElements = element.boundElements.filter((bound) => {
      if (
        typeof bound !== "object" ||
        bound === null ||
        Array.isArray(bound) ||
        typeof bound.id !== "string" ||
        !liveIds.has(bound.id) ||
        seen.has(bound.id)
      ) return false;
      seen.add(bound.id);
      return true;
    });
  } else if ("boundElements" in element) {
    repaired.boundElements = null;
  }
  for (const field of ["containerId", "frameId"] as const) {
    const target = element[field];
    if (field in element && (typeof target !== "string" || !liveIds.has(target))) {
      repaired[field] = null;
    }
  }
  for (const field of ["startBinding", "endBinding"] as const) {
    const binding = element[field];
    const valid =
      element.type === "arrow" &&
      typeof binding === "object" &&
      binding !== null &&
      !Array.isArray(binding) &&
      typeof binding.elementId === "string" &&
      liveIds.has(binding.elementId);
    if (field in element && !valid) {
      repaired[field] = null;
    }
  }
  if (
    element.type === "image" &&
    (typeof element.fileId !== "string" || !assetIds.has(element.fileId))
  ) {
    repaired.fileId = null;
  }
  return repaired;
}

function parseStored(encoded: string, label: string): JsonValue {
  try {
    return JSON.parse(encoded) as JsonValue;
  } catch {
    throw new SceneCodecError(`The stored ${label} is not valid JSON.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
