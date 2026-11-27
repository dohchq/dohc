import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  EXCALIDRAW_EXPORTABLE_APP_STATE,
  SceneCodecError,
  applySceneDelta,
  assertRestorableElement,
  canonicalPortableScene,
  foldScene,
  lostElementRevisions,
  validateSceneElements,
  type ElementSnapshot,
  type JsonObject,
} from "@dohc/excalidraw-scene";
import { EMPTY_EXCALIDRAW_DOCUMENT } from "@dohc/excalidraw-scene/agent";
import { isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import { VersionedTextStoreError } from "@dohc/workspace-contracts/engine";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { asRecord, validateUserWritePath } from "@dohc/workspace-core";
import {
  DaemonRefusalError,
  VersionedLiveAdapter,
  isIdempotencyKeyReuseRefusal,
  openEngineYdocProviderSession,
  type ArtifactAssetDescriptor,
  type EngineTransport,
} from "@dohc/workspace-engine-client";
import { isOperationId } from "./accountChatWrites";
import { currentAccountFeedCursor, hiddenFile } from "./accountFeed";
import type { AutomationReplica } from "./automationReplicas";
import { badRequest, notFound } from "./errors";
import { untilAborted } from "./namedLiveFrameHost";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import { MAX_SHARE_PATH_CHARS } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";

export const SAVE_SKETCH_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SKETCH_FILE_BYTES = 16 * 1024 * 1024;
const MAX_HYDRATED_ASSET_BYTES = 24 * 1024 * 1024;
const MAX_SAVE_ELEMENTS = 10_000;
const EMPTY_SET: ReadonlySet<string> = new Set();
const ASSET_MIME_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
  "application/octet-stream",
]);
export type PhoneSketchOperation = "readSketch" | "createSketch" | "saveSketch";
const SKETCH_OPS: ReadonlySet<string> = new Set<PhoneSketchOperation>([
  "readSketch",
  "createSketch",
  "saveSketch",
]);
export const isPhoneSketchOperation = (name: string): name is PhoneSketchOperation =>
  SKETCH_OPS.has(name);

export function isAllowedSketchPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SHARE_PATH_CHARS) return false;
  if (hiddenFile(path) || isFolderMarkerPath(path)) return false;
  const checked = validateUserWritePath(path);
  return (
    checked.ok &&
    checked.normalized === path &&
    liveDocumentKindForPath(path) === "scene" &&
    posix.basename(path).length > ".excalidraw".length
  );
}

export interface HydratedSketchFile {
  readonly id: string;
  readonly mimeType: string;
  readonly dataURL: string;
  readonly created: number;
  readonly lastRetrieved?: number;
  readonly version?: number;
}
export interface SketchScenePayload {
  readonly ok: true;
  readonly path: string;
  readonly objectId: string;
  readonly elements: readonly ElementSnapshot[];
  readonly appState: JsonObject;
  readonly files: Readonly<Record<string, HydratedSketchFile>>;
  readonly missingAssets: number;
  readonly readOnly?: boolean;
}
export type SketchReadResult =
  | SketchScenePayload
  | {
      readonly ok: false;
      readonly refusal: "missing" | "too-large" | "invalid";
      readonly reason: string;
    };
export type SketchCreateResult =
  | { readonly ok: true; readonly path: string; readonly objectId: string }
  | { readonly ok: false; readonly refusal: "exists"; readonly reason: string };
export type SketchSaveResult =
  | (SketchScenePayload & {
      readonly lostElementIds: readonly string[];
      readonly lostVersions?: Readonly<Record<string, number>>;
    })
  | {
      readonly ok: false;
      readonly refusal: "missing" | "object-changed" | "invalid";
      readonly reason: string;
    };
export type PhoneSketchResult = SketchReadResult | SketchCreateResult | SketchSaveResult;

type ParsedRequest =
  | { readonly operation: "readSketch"; readonly path: string }
  | { readonly operation: "createSketch"; readonly path: string; readonly requestId: string }
  | {
      readonly operation: "saveSketch";
      readonly path: string;
      readonly objectId: string;
      readonly requestId: string;
      readonly elements: readonly unknown[];
    };

const missingSketch = (path: string) =>
  ({ ok: false, refusal: "missing", reason: `No sketch at ${path}.` }) as const;
const invalidSketch = (path: string, reason = `${path} is not a valid Excalidraw sketch.`) =>
  ({ ok: false, refusal: "invalid", reason }) as const;
const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseSketchRequest(operation: PhoneSketchOperation, args: unknown): ParsedRequest {
  const allowed =
    operation === "readSketch"
      ? ["path"]
      : operation === "createSketch"
        ? ["path", "requestId"]
        : ["path", "objectId", "requestId", "elements"];
  const r = asRecord(args);
  if (
    !r ||
    Object.keys(r).some((k) => !allowed.includes(k)) ||
    typeof r.path !== "string" ||
    r.path.length > MAX_SHARE_PATH_CHARS
  ) {
    throw badRequest(`the arguments do not fit ${operation}`);
  }
  if (operation === "readSketch") return { operation, path: r.path };
  if (!isOperationId(r.requestId)) throw badRequest(`the arguments do not fit ${operation}`);
  if (operation === "createSketch") {
    if (!isAllowedSketchPath(r.path))
      throw badRequest("Sketch paths must be valid workspace paths ending in .excalidraw.");
    return { operation, path: r.path, requestId: r.requestId };
  }
  if (
    typeof r.objectId !== "string" ||
    !r.objectId ||
    r.objectId.length > 256 ||
    !Array.isArray(r.elements) ||
    r.elements.length > MAX_SAVE_ELEMENTS
  ) {
    throw badRequest(`the arguments do not fit ${operation}`);
  }
  return {
    operation,
    path: r.path,
    objectId: r.objectId,
    requestId: r.requestId,
    elements: r.elements,
  };
}

function validateDeltaInput(elements: readonly unknown[], existingAssets: ReadonlySet<string>) {
  for (const raw of elements) {
    const el = asRecord(raw);
    if (
      el?.type === "image" &&
      el.isDeleted !== true &&
      typeof el.fileId === "string" &&
      !existingAssets.has(el.fileId)
    ) {
      throw badRequest("New image files cannot be added to a sketch from a phone yet.");
    }
  }
  try {
    validateSceneElements(elements);
  } catch (e) {
    if (e instanceof SceneCodecError) throw badRequest(e.message);
    throw e;
  }
}

async function hydrateSceneAssets(
  files: VersionedLiveAdapter,
  workspaceId: string,
  descriptors: readonly ArtifactAssetDescriptor[],
) {
  const hydrated: Record<string, HydratedSketchFile> = {};
  let missingAssets = 0;
  let totalBytes = 0;
  for (const d of descriptors) {
    if (!ASSET_MIME_TYPES.has(d.mimeType)) {
      missingAssets += 1;
      continue;
    }
    try {
      const bytes = await files.readBinaryBlob({ workspaceId, sha256: d.sha256 });
      if (
        !bytes ||
        totalBytes + bytes.byteLength > MAX_HYDRATED_ASSET_BYTES ||
        createHash("sha256").update(bytes).digest("hex") !== d.sha256
      ) {
        missingAssets += 1;
        continue;
      }
      totalBytes += bytes.byteLength;
      hydrated[d.id] = {
        id: d.id,
        mimeType: d.mimeType,
        created: d.created,
        dataURL: `data:${d.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
        ...(d.lastRetrieved === undefined ? {} : { lastRetrieved: d.lastRetrieved }),
        ...(d.version === undefined ? {} : { version: d.version }),
      };
    } catch {
      missingAssets += 1;
    }
  }
  return { files: hydrated, missingAssets };
}

type ParsedPortable = {
  readonly result: SketchReadResult;
  readonly allElements: readonly ElementSnapshot[];
  readonly assetIds: ReadonlySet<string>;
  readonly rawFiles: Readonly<Record<string, JsonObject>>;
  readonly unseedableAsset: boolean;
  readonly headSha256?: string;
};

const EMPTY_FILES: Readonly<Record<string, JsonObject>> = {};
const EMPTY_ELEMENTS: readonly ElementSnapshot[] = [];
const EMBEDDED_FILE_FIELDS = new Set([
  "created",
  "dataURL",
  "id",
  "lastRetrieved",
  "mimeType",
  "version",
]);
const STANDARD_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function parseRustImportFile(id: string, entry: unknown): HydratedSketchFile | null {
  const f = asRecord(entry);
  if (
    !f ||
    Object.keys(f).some((k) => !EMBEDDED_FILE_FIELDS.has(k)) ||
    f.id !== id ||
    typeof f.mimeType !== "string" ||
    f.mimeType.length === 0 ||
    typeof f.dataURL !== "string" ||
    !isNonNegInt(f.created) ||
    (f.lastRetrieved !== undefined && !isNonNegInt(f.lastRetrieved)) ||
    (f.version !== undefined && !isNonNegInt(f.version))
  ) {
    return null;
  }
  const prefix = `data:${f.mimeType};base64,`;
  if (!f.dataURL.startsWith(prefix)) return null;
  const encoded = f.dataURL.slice(prefix.length);
  if (!STANDARD_BASE64.test(encoded)) return null;
  const canonicalDataURL = `${prefix}${Buffer.from(encoded, "base64").toString("base64")}`;
  return {
    id,
    mimeType: f.mimeType,
    dataURL: canonicalDataURL,
    created: f.created,
    ...(f.lastRetrieved === undefined ? {} : { lastRetrieved: f.lastRetrieved }),
    ...(f.version === undefined ? {} : { version: f.version }),
  };
}

function emptyPortable(result: SketchReadResult, headSha256?: string): ParsedPortable {
  return {
    result,
    allElements: EMPTY_ELEMENTS,
    assetIds: EMPTY_SET,
    rawFiles: EMPTY_FILES,
    unseedableAsset: false,
    headSha256,
  };
}

function parsePortableSketch(
  path: string,
  objectId: string,
  text: string,
  headSha256?: string,
): ParsedPortable {
  if (text.trim() === "")
    return emptyPortable(
      { ok: true, path, objectId, elements: [], appState: {}, files: {}, missingAssets: 0 },
      headSha256,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyPortable(invalidSketch(path, `${path} is not valid JSON.`));
  }
  const doc = asRecord(parsed);
  const rawElements = doc?.elements;
  const rawApp = doc?.appState;
  const rawFilesObj = doc?.files;
  if (
    !doc ||
    doc.type !== "excalidraw" ||
    (rawElements !== undefined && rawElements !== null && !Array.isArray(rawElements)) ||
    (rawApp !== undefined && rawApp !== null && !asRecord(rawApp)) ||
    (rawFilesObj !== undefined && rawFilesObj !== null && !asRecord(rawFilesObj))
  ) {
    return emptyPortable(invalidSketch(path));
  }
  const allElements: ElementSnapshot[] = [];
  const elements: ElementSnapshot[] = [];
  for (const raw of (rawElements as unknown[] | null | undefined) ?? []) {
    try {
      assertRestorableElement(raw);
    } catch (e) {
      return emptyPortable(invalidSketch(path, e instanceof Error ? e.message : undefined));
    }
    if (typeof raw.id !== "string" || raw.id.length === 0)
      return emptyPortable(invalidSketch(path));
    const version =
      raw.version === undefined || raw.version === null || raw.version === 0 ? 1 : raw.version;
    const versionNonce =
      raw.versionNonce === undefined || raw.versionNonce === null ? 0 : raw.versionNonce;
    const isDeleted = raw.isDeleted === undefined || raw.isDeleted === null ? false : raw.isDeleted;
    if (!isNonNegInt(version) || !isNonNegInt(versionNonce) || typeof isDeleted !== "boolean")
      return emptyPortable(invalidSketch(path));
    const normalizedEl = { ...raw, version, versionNonce, isDeleted } as ElementSnapshot;
    allElements.push(normalizedEl);
    if (!isDeleted) elements.push(normalizedEl);
  }
  const appRecord = asRecord(rawApp);
  const appState: JsonObject = {};
  for (const key of EXCALIDRAW_EXPORTABLE_APP_STATE) {
    if (appRecord?.[key] !== undefined) appState[key] = appRecord[key] as JsonObject[string];
  }
  const filesRecord = asRecord(rawFilesObj) ?? {};
  const assetIds = new Set(Object.keys(filesRecord));
  const referencedIds = new Set(
    elements
      .filter((e) => e.type === "image" && typeof e.fileId === "string")
      .map((e) => e.fileId as string),
  );
  const rawFiles: Record<string, JsonObject> = {};
  const files: Record<string, HydratedSketchFile> = {};
  let missingAssets = 0;
  let totalBytes = 0;
  let unseedableAsset = false;
  for (const [id, entry] of Object.entries(filesRecord)) {
    const valid = parseRustImportFile(id, entry);
    if (!valid) {
      if (referencedIds.has(id)) unseedableAsset = true;
      missingAssets += 1;
      continue;
    }
    rawFiles[id] = valid as unknown as JsonObject;
    if (
      !ASSET_MIME_TYPES.has(valid.mimeType) ||
      totalBytes + valid.dataURL.length > MAX_HYDRATED_ASSET_BYTES
    ) {
      missingAssets += 1;
      continue;
    }
    totalBytes += valid.dataURL.length;
    files[id] = valid;
  }
  return {
    result: { ok: true, path, objectId, elements, appState, files, missingAssets },
    allElements,
    assetIds,
    rawFiles,
    unseedableAsset,
    headSha256,
  };
}

const isFileExistsError = (e: unknown) =>
  (e instanceof VersionedTextStoreError && e.code === "target-path-exists") ||
  (e instanceof DaemonRefusalError &&
    (e.wireCode === "CONFLICT" ||
      (e.wireCode === "INVALID_PARAMS" && e.message === "target-path-exists")));
const isConflictOpenError = (e: unknown) =>
  (e instanceof DaemonRefusalError &&
    e.wireCode === "INVALID_PARAMS" &&
    e.message === "ydoc-conflict-open") ||
  (e instanceof Error && e.message === "ydoc-conflict-open");
const isInvalidSceneOpenError = (e: unknown) =>
  (e instanceof DaemonRefusalError &&
    e.wireCode === "INVALID_PARAMS" &&
    /invalid-input|excalidraw|scene/iu.test(e.message)) ||
  (e instanceof Error && e.message === "invalid-input");

async function resolveObjectId(
  files: VersionedLiveAdapter,
  workspaceId: string,
  path: string,
  signal: AbortSignal,
) {
  const [found] = (await files.resolveFiles({ workspaceId, targets: [{ path }], signal })).results;
  return found?.status === "found" ? found.objectId : null;
}

type SceneSession = Awaited<ReturnType<typeof openEngineYdocProviderSession>>;
type OpenSceneResult =
  | { readonly kind: "open"; readonly provider: SceneSession }
  | { readonly kind: "conflict" | "invalid" };

async function openScene(
  replica: AutomationReplica,
  input: { versionId: string; path: string; expectedObjectId: string; seedAbsentLineage: boolean },
): Promise<OpenSceneResult> {
  try {
    const provider = await openEngineYdocProviderSession({
      transport: replica.client as EngineTransport,
      workspace: replica.workspace,
      ...input,
      contentKind: "scene",
      onRemoteUpdate: () => undefined,
    });
    return { kind: "open", provider };
  } catch (e) {
    if (isConflictOpenError(e)) return { kind: "conflict" };
    if (isInvalidSceneOpenError(e)) return { kind: "invalid" };
    throw e;
  }
}

async function closeSession(provider: SceneSession, close: boolean): Promise<void> {
  if (!close) {
    await provider.evict().catch(() => undefined);
    return;
  }
  try {
    await provider.close({ settle: false });
  } catch (err) {
    await provider.evict().catch(() => undefined);
    throw err;
  }
}

async function foldHydratedScene(
  files: VersionedLiveAdapter,
  workspaceId: string,
  path: string,
  objectId: string,
  provider: SceneSession,
) {
  const scene = foldScene(provider.doc);
  const hydrated = await hydrateSceneAssets(files, workspaceId, provider.artifactAssets ?? []);
  return {
    scene,
    payload: {
      ok: true as const,
      path,
      objectId,
      elements: scene.elements.filter((e) => !e.isDeleted),
      appState: scene.appState,
      ...hydrated,
    },
  };
}

async function readPortableFile(
  files: VersionedLiveAdapter,
  workspaceId: string,
  versionId: string,
  path: string,
  objectId: string,
): Promise<ParsedPortable> {
  const file = await files.readTextFile({
    workspaceId,
    versionId,
    path,
    maxBytes: MAX_SKETCH_FILE_BYTES,
  });
  if (!file || file.contentKind !== "text") return emptyPortable(missingSketch(path));
  if (file.text === null || file.byteLength > MAX_SKETCH_FILE_BYTES) {
    return emptyPortable({
      ok: false,
      refusal: "too-large",
      reason: "This sketch is too large to open on a phone.",
    });
  }
  return parsePortableSketch(path, objectId, file.text, file.sha256);
}

async function hasOpenTextConflict(
  files: VersionedLiveAdapter,
  workspaceId: string,
  versionId: string,
  path: string,
) {
  const conflicts = await files
    .listTextConflicts({ workspaceId, status: "open" })
    .then((r) => r.conflicts)
    .catch(() => []);
  return conflicts.some((c) => c.targetVersionId === versionId && c.path === path);
}

async function readSketchInCopy(
  replica: AutomationReplica,
  workspaceId: string,
  path: string,
  signal: AbortSignal,
): Promise<SketchReadResult> {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  const version = await files.getActiveVersion({ workspaceId });
  const objectId = version ? await resolveObjectId(files, workspaceId, path, signal) : null;
  if (!version || !objectId) return missingSketch(path);
  const opened = await openScene(replica, {
    versionId: version.id,
    path,
    expectedObjectId: objectId,
    seedAbsentLineage: false,
  });
  if (opened.kind === "open") {
    try {
      if (opened.provider.head === "absent") return missingSketch(path);
      if (opened.provider.lineage === "existing")
        return (await foldHydratedScene(files, workspaceId, path, objectId, opened.provider))
          .payload;
    } finally {
      await closeSession(opened.provider, false);
    }
  }
  const fallback = (await readPortableFile(files, workspaceId, version.id, path, objectId)).result;
  if (!fallback.ok) return fallback;
  const conflicted =
    opened.kind === "conflict" ||
    (opened.kind === "invalid" &&
      (await hasOpenTextConflict(files, workspaceId, version.id, path)));
  return conflicted ? { ...fallback, readOnly: true } : fallback;
}

const EMPTY_SKETCH_DOCUMENT = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements: [],
    appState: (JSON.parse(EMPTY_EXCALIDRAW_DOCUMENT) as { appState: JsonObject }).appState,
    files: {},
  },
  null,
  2,
);

async function ensureClaimedSceneLineage(
  files: VersionedLiveAdapter,
  replica: AutomationReplica,
  input: {
    workspaceId: string;
    versionId: string;
    path: string;
    objectId: string;
    requestId: string;
    portable?: ParsedPortable;
  },
): Promise<OpenSceneResult> {
  const openOpts = {
    versionId: input.versionId,
    path: input.path,
    expectedObjectId: input.objectId,
  };
  if (input.portable?.result.ok) {
    const canonical = canonicalPortableScene(
      input.portable.allElements,
      input.portable.result.appState,
      input.portable.rawFiles,
    );
    const canonicalSha = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (input.portable.headSha256 && input.portable.headSha256 !== canonicalSha) {
      await files.writeTextFile({
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.path,
        text: canonical,
        expectedSha256: input.portable.headSha256,
        publish: true,
        requestId: `phone-sketch-seed:${input.requestId}`,
        metadata: { origin: "api", summary: `Updated ${posix.basename(input.path)}` },
      });
    }
  }
  const seeded = await openScene(replica, { ...openOpts, seedAbsentLineage: true });
  if (seeded.kind !== "open" || seeded.provider.head === "absent" || seeded.provider.lineageClaimId)
    return seeded;
  await closeSession(seeded.provider, true);
  return await openScene(replica, { ...openOpts, seedAbsentLineage: false });
}

async function createSketchInCopy(
  replica: AutomationReplica,
  workspaceId: string,
  path: string,
  requestId: string,
  signal: AbortSignal,
  authorize: () => Promise<void>,
): Promise<SketchCreateResult> {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  const version = await files.getActiveVersion({ workspaceId });
  if (!version) throw notFound();
  let objectId: string | null = null;
  try {
    const written = await files.writeTextFile({
      workspaceId,
      versionId: version.id,
      path,
      text: EMPTY_SKETCH_DOCUMENT,
      publish: true,
      createOnly: true,
      requestId: `phone-sketch-create:${requestId}`,
      metadata: { origin: "api", summary: `Created ${posix.basename(path)}` },
    });
    objectId = written.moment.objectId;
  } catch (e) {
    if (isIdempotencyKeyReuseRefusal(e))
      objectId = await resolveObjectId(files, workspaceId, path, signal);
    else if (isFileExistsError(e))
      return { ok: false, refusal: "exists", reason: `${path} already exists.` };
    else throw e;
  }
  if (objectId) {
    const seeded = await openScene(replica, {
      versionId: version.id,
      path,
      expectedObjectId: objectId,
      seedAbsentLineage: true,
    });
    if (seeded.kind === "open")
      await closeSession(seeded.provider, !seeded.provider.lineageClaimId);
  }
  await replica.sync(signal);
  await authorize();
  const resolved = (await resolveObjectId(files, workspaceId, path, signal)) ?? objectId;
  return resolved
    ? { ok: true, path, objectId: resolved }
    : { ok: false, refusal: "exists", reason: `${path} could not be created.` };
}

async function applyDeltaInSession(
  replica: AutomationReplica,
  provider: SceneSession,
  openOpts: { versionId: string; path: string; expectedObjectId: string },
  elements: readonly unknown[],
  requestId: string,
  summary: string,
): Promise<ElementSnapshot[]> {
  let released = false;
  try {
    validateDeltaInput(elements, new Set(Object.keys(foldScene(provider.doc).assets)));
    const delta = applySceneDelta(provider.doc, elements);
    const wasUnsettled = provider.unsettled;
    if (wasUnsettled) await provider.settleNow({ summary });
    if (delta.update !== null) {
      try {
        await provider.applyLocalUpdate(delta.update, {
          idempotencyKey: `phone-sketch-save:${requestId}`,
          attribution: { actorKind: "human" },
          armSettle: false,
        });
        await provider.settleNow({ summary });
      } catch (e) {
        if (!isIdempotencyKeyReuseRefusal(e)) throw e;
        await closeSession(provider, false);
        released = true;
        const reopened = await openScene(replica, { ...openOpts, seedAbsentLineage: false });
        if (reopened.kind === "open") {
          try {
            if (reopened.provider.unsettled) await reopened.provider.settleNow({ summary });
          } catch (err) {
            await closeSession(reopened.provider, false);
            throw err;
          }
          await closeSession(reopened.provider, true);
        }
      }
    }
    if (!released) {
      await closeSession(provider, delta.update !== null || wasUnsettled);
      released = true;
    }
    return delta.written;
  } finally {
    if (!released) await closeSession(provider, false);
  }
}

function buildLostVersions(
  lost: readonly ElementSnapshot[],
  winners: ReadonlyMap<string, ElementSnapshot>,
) {
  const versions: Record<string, number> = {};
  for (const e of lost) versions[e.id] = winners.get(e.id)?.version ?? e.version;
  return versions;
}

async function saveSketchInCopy(
  replica: AutomationReplica,
  workspaceId: string,
  input: Extract<ParsedRequest, { operation: "saveSketch" }>,
  signal: AbortSignal,
  authorize: () => Promise<void>,
): Promise<SketchSaveResult> {
  const files = new VersionedLiveAdapter(replica.client, replica.workspace, { workspaceId });
  const version = await files.getActiveVersion({ workspaceId });
  const currentObjectId = version
    ? await resolveObjectId(files, workspaceId, input.path, signal)
    : null;
  if (!version || !currentObjectId) return missingSketch(input.path);
  if (currentObjectId !== input.objectId)
    return { ok: false, refusal: "object-changed", reason: `${input.path} was replaced.` };
  const openOpts = {
    versionId: version.id,
    path: input.path,
    expectedObjectId: input.objectId,
  };
  const summary = `Updated ${posix.basename(input.path)}`;
  const initial = await openScene(replica, { ...openOpts, seedAbsentLineage: false });
  if (initial.kind !== "open") return invalidSketch(input.path);

  let written: ElementSnapshot[] = [];
  if (initial.provider.head === "absent") {
    await closeSession(initial.provider, false);
    return missingSketch(input.path);
  }
  if (initial.provider.lineage === "existing" && initial.provider.lineageClaimId) {
    written = await applyDeltaInSession(
      replica,
      initial.provider,
      openOpts,
      input.elements,
      input.requestId,
      summary,
    );
  } else {
    const existingAssets =
      initial.provider.lineage === "existing"
        ? new Set(Object.keys(foldScene(initial.provider.doc).assets))
        : null;
    await closeSession(initial.provider, false);
    let portable: ParsedPortable | undefined;
    if (!existingAssets) {
      portable = await readPortableFile(
        files,
        workspaceId,
        version.id,
        input.path,
        currentObjectId,
      );
      if (!portable.result.ok) {
        return portable.result.refusal === "missing"
          ? missingSketch(input.path)
          : invalidSketch(input.path, portable.result.reason);
      }
      if (portable.unseedableAsset) return invalidSketch(input.path);
      validateDeltaInput(input.elements, portable.assetIds);
      if (input.elements.length === 0) return { ...portable.result, lostElementIds: [] };
    } else {
      validateDeltaInput(input.elements, existingAssets);
    }
    const seeded = await ensureClaimedSceneLineage(files, replica, {
      workspaceId,
      ...openOpts,
      objectId: input.objectId,
      requestId: input.requestId,
      portable,
    });
    if (seeded.kind !== "open") return invalidSketch(input.path);
    if (seeded.provider.head === "absent") {
      await closeSession(seeded.provider, false);
      return missingSketch(input.path);
    }
    written = await applyDeltaInSession(
      replica,
      seeded.provider,
      openOpts,
      input.elements,
      input.requestId,
      summary,
    );
  }

  // Publish and pull concurrent desktop edits before judging winners against post-publication state.
  await replica.sync(signal);
  await authorize();

  const postObjectId = await resolveObjectId(files, workspaceId, input.path, signal);
  if (!postObjectId) return missingSketch(input.path);
  if (postObjectId !== input.objectId)
    return {
      ok: false,
      refusal: "object-changed",
      reason: `${input.path} was replaced while saving.`,
    };
  const fileConflict = await hasOpenTextConflict(files, workspaceId, version.id, input.path);
  const post = await openScene(replica, { ...openOpts, seedAbsentLineage: false });
  if (post.kind !== "open") {
    if (post.kind !== "conflict" && !fileConflict) return invalidSketch(input.path);
    const fallback = (
      await readPortableFile(files, workspaceId, version.id, input.path, postObjectId)
    ).result;
    if (!fallback.ok)
      return fallback.refusal === "missing"
        ? missingSketch(input.path)
        : invalidSketch(input.path, fallback.reason);
    const winners = new Map(fallback.elements.map((e) => [e.id, e]));
    return {
      ...fallback,
      lostElementIds: written.map((e) => e.id),
      ...(written.length > 0 ? { lostVersions: buildLostVersions(written, winners) } : {}),
    };
  }
  try {
    if (post.provider.head === "absent") return missingSketch(input.path);
    const { scene, payload } = await foldHydratedScene(
      files,
      workspaceId,
      input.path,
      input.objectId,
      post.provider,
    );
    const lost = fileConflict ? written : lostElementRevisions(scene, written);
    const winners = new Map(scene.elements.map((e) => [e.id, e]));
    return {
      ...payload,
      lostElementIds: lost.map((e) => e.id),
      ...(lost.length > 0 ? { lostVersions: buildLostVersions(lost, winners) } : {}),
    };
  } finally {
    await closeSession(post.provider, false);
  }
}

export async function runPhoneSketchOperation(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: {
    owner: string;
    workspaceId: string;
    operation: PhoneSketchOperation;
    args: unknown;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
  },
): Promise<{ result: PhoneSketchResult; cursor: string }> {
  const parsed = parseSketchRequest(input.operation, input.args);
  const signal = input.visitor.signal;
  const authorize = () => untilAborted(input.authorize(), signal);
  if (parsed.operation !== "createSketch" && !isAllowedSketchPath(parsed.path)) {
    return {
      result: missingSketch(parsed.path),
      cursor: currentAccountFeedCursor(server.storage, input.workspaceId, null),
    };
  }
  return await server.copies.withServerCopy(
    input.owner,
    input.workspaceId,
    input.visitor,
    (replica) =>
      replica.withRecordWork(async () => {
        await authorize();
        await replica.sync(signal);
        await authorize();
        const result = await untilAborted<PhoneSketchResult>(
          parsed.operation === "readSketch"
            ? readSketchInCopy(replica, input.workspaceId, parsed.path, signal)
            : parsed.operation === "createSketch"
              ? createSketchInCopy(
                  replica,
                  input.workspaceId,
                  parsed.path,
                  parsed.requestId,
                  signal,
                  authorize,
                )
              : saveSketchInCopy(replica, input.workspaceId, parsed, signal, authorize),
          signal,
        );
        await authorize();
        if (result.ok) server.copies.hold(input.visitor.userId, input.workspaceId);
        return {
          result,
          cursor: currentAccountFeedCursor(server.storage, input.workspaceId, null),
        };
      }),
  );
}
