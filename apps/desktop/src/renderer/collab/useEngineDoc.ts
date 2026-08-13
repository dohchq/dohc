import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { LiveDocumentKind } from "@dohc/workspace-contracts/live-documents";
import {
  declareSceneRoots,
  exportPortableScene,
  stableJson,
} from "@dohc/excalidraw-scene";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { bridge } from "../bridge";
import { binaryFileDataFromArtifact } from "../excalidrawAssets";
import {
  captureOrphanedDraft,
  replaceOrphanedDraft,
} from "../orphanedDrafts";
import {
  bindEngineYDoc,
  type EngineYDocUpdateTooLargeError,
  type EngineRemovalInProgress,
  type EngineYDocBinding,
  type EngineYDocTransport,
} from "./engineYDocProvider";

export type { EngineRemovalInProgress };

// `@dohc/ydoc-projection` statically pulls in the full Tiptap stack and
// builds its schema at module load. `useEngineDoc` backs every FileInspector,
// so a static import here put that whole editor stack in the renderer's
// eager chunk. Loaded once, lazily, and cached — every caller in this module
// shares the same in-flight/resolved promise instead of re-importing.
type ProjectionModule = typeof import("@dohc/ydoc-projection");
let projectionModulePromise: Promise<ProjectionModule> | null = null;
function loadProjectionModule(): Promise<ProjectionModule> {
  if (projectionModulePromise === null) {
    // A rejected import must not be cached: a transient chunk-fetch failure
    // (a bundle replaced mid-session by an update, for example) would
    // otherwise fail every later deletion's faithful capture for the rest of
    // the session. Clearing on rejection lets the next deletion retry.
    const pending = import("@dohc/ydoc-projection");
    projectionModulePromise = pending;
    void pending.catch(() => {
      if (projectionModulePromise === pending) projectionModulePromise = null;
    });
  }
  return projectionModulePromise;
}

// A deletion's draft text depends on the projection module, but the BYTES
// that produce it must not: the live doc can be destroyed (unmount) before
// the module resolves, so the doc is snapshotted synchronously at the event
// and projected to markdown lazily, off a reconstructed doc.
function markdownFromSnapshot(snapshot: Uint8Array): Promise<string> {
  return loadProjectionModule().then(({ yDocToMarkdown }) => {
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, snapshot);
    return yDocToMarkdown(rebuilt);
  });
}

function sceneFromSnapshot(snapshot: Uint8Array): string {
  const rebuilt = new Y.Doc();
  declareSceneRoots(rebuilt);
  Y.applyUpdate(rebuilt, snapshot);
  return exportPortableScene(rebuilt);
}

type SceneRecoveryWork = {
  immediateText: string;
  requiredAssetCount: number;
  completed: Promise<{ text: string; missingAssetCount: number }>;
};

function portableSceneRecovery(
  snapshot: Uint8Array,
  files: Readonly<Record<string, BinaryFileData>>,
): { text: string; requiredAssetIds: readonly string[] } {
  const scene = JSON.parse(sceneFromSnapshot(snapshot)) as {
    elements: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  const requiredAssetIds = new Set<string>();
  for (const element of scene.elements) {
    if (element.type === "image" && typeof element.fileId === "string") {
      requiredAssetIds.add(element.fileId);
    }
  }
  const available = new Set(Object.keys(files));
  const elements = scene.elements.map((element) =>
    element.type === "image" &&
    typeof element.fileId === "string" &&
    !available.has(element.fileId)
      ? { ...element, fileId: null }
      : element,
  );
  return {
    text: stableJson({ ...scene, elements, files }),
    requiredAssetIds: [...requiredAssetIds],
  };
}

function recoveryTextFromSnapshot(
  kind: LiveDocumentKind,
  snapshot: Uint8Array,
): Promise<string> {
  return kind === "scene"
    ? Promise.resolve(sceneFromSnapshot(snapshot))
    : markdownFromSnapshot(snapshot);
}

function crudeRecoveryText(kind: LiveDocumentKind, doc: Y.Doc): string {
  return kind === "scene" ? exportPortableScene(doc) : crudeMarkdownFromDoc(doc);
}

// The crude fallback the deletion boundary persists BEFORE the projection
// module is even guaranteed to load — pure yjs, no Tiptap, so it never waits
// on the chunk this whole lazy-load exists to defer. Faithful markdown
// (frontmatter ordering, table/list formatting, escaping) replaces this the
// moment `markdownFromSnapshot` resolves; this only has to outlast a crash.
function crudeMarkdownFromDoc(doc: Y.Doc): string {
  const meta = doc.getMap("meta");
  if (meta.get("contentKind") === "plain-text") {
    return doc.getText("plainText").toString();
  }
  const frontmatter = doc.getMap("frontmatter");
  const frontmatterLines: string[] = [];
  for (const [key, value] of frontmatter.entries()) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      frontmatterLines.push(`${key}: ${String(value)}`);
    }
  }
  const frontmatterText =
    frontmatterLines.length > 0
      ? `---\n${frontmatterLines.join("\n")}\n---\n\n`
      : "";
  const blockText = (node: Y.XmlText | Y.XmlElement | Y.XmlHook): string => {
    if (node instanceof Y.XmlText) return node.toString();
    if (node instanceof Y.XmlElement) {
      return node.toArray().map(blockText).join("");
    }
    return "";
  };
  const blocks = doc
    .getXmlFragment("body")
    .toArray()
    .map(blockText)
    .filter((text) => text.length > 0);
  return frontmatterText + blocks.join("\n\n");
}

function snapshotsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// The engine Y.Doc editor hook for live files. Given a workspace, path, and
// format kind, it opens a live engine Y.Doc session in main over IPC and binds
// a mirror Y.Doc to the format editor. Solo editing runs through the engine; a
// co-editor's edit arrives as a forwarded remote delta on the same channel.
//
// available:false AND opening:false => the doc is NOT engine-backed (unflagged
// workspace, secret path, or already live) — the caller stays on the plain
// local autosave editor showing the real on-disk content. While opening:true
// the answer is not known yet and the caller must stay read-only. The other
// exception is `notInVersion`, where the answer IS known and the caller must
// stop editing rather than fall back (#534). Each editor owns undo: rich
// documents use their collaboration history, while drawings use Excalidraw's
// native history and publish the resulting higher element revision.
//
// Renderer async-state invariant (product invariant): every open response is
// guarded by the per-open request token (a monotonic id + the effect's cancelled
// flag). A slow open for workspace/path A can never bind or repaint after the
// user has switched to B — the stale response is dropped and its session closed.

// "error" = a settle FAILED, so the file on disk is behind what the editor
// shows. "file-locked" = the same stale disk, but transient by contract:
// another program holds the file's handle and the engine retries until it
// releases (#554), so the copy names the blocker instead of advising an edit.
// "read-only" = the workspace is a read-only shared view and the edit
// was discarded outright; retrying cannot help, so it gets its own copy.
// "changed-on-disk" = the file was edited outside dohc while this document was
// open, and dohc kept that edit instead of overwriting it (#338).
// None is ever inferred — main pushes all of them from real outcomes.
export type EngineDocSaveState =
  | "saved"
  | "saving"
  | "error"
  | "file-locked"
  | "read-only"
  | "changed-on-disk"
  | "deleted";

export type UseEngineDoc = {
  // True once the engine session is open and the mirror doc is bound. false =>
  // fall back to the local autosave editor, but ONLY once `opening` is false.
  available: boolean;
  // No open has answered for the CURRENT request yet (#533). "Opening" and
  // "not engine-backed" used to be the same `available: false`, so the caller
  // showed its writable plain editor — whose autosave writes straight to disk
  // — for the whole wait. On a workspace whose capture chain is busy (startup
  // reconciliation, a version switch) that wait is seconds, and every keystroke
  // in it took a path the about-to-bind session never sees: the session then
  // seeds from a head without them. True on the first render of an open AND on
  // the first render after the request changes under a bound document (a
  // version switch), because both are the same unanswered question.
  // The caller must offer no writable surface while this is true.
  opening: boolean;
  // The mirror Y.Doc Tiptap binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // Exact engine identity for this bound document. Presence must not use the
  // path because a rename does not create a new document.
  objectId: string | null;
  versionId: string | null;
  // The document's REAL save state. "saving" the moment an edit is made,
  // "saved" ONLY when main reports a settle that covered that edit actually
  // committed and wrote the .md, "error" when a settle failed. This used to be
  // a 1s timer that flipped to "saved" regardless of what the engine did —
  // three dogfood journeys watched a doc read "Saved" over a zero-byte file.
  saveState: EngineDocSaveState;
  // A known terminal save failure. The save-state chip uses this instead of
  // its generic error text so it can name the constraint and measured bytes.
  saveError: string | null;
  // The path is not in the version this workspace is on: a version switch
  // removed it while this open was queued behind that switch (#534). Unlike
  // every other available:false the caller must NOT fall back to the writable
  // plain editor, whose autosave would write the file back into the version the
  // user just entered.
  notInVersion: boolean;
  // The open did not land and a session for this document may still be the
  // engine's (#564, #657). Same no-downgrade rule as notInVersion: the caller
  // stays read-only, states the reason, and offers a retry (bump retryKey),
  // which is also what discharges what the failure left behind.
  engineMayHoldDocument: boolean;
  // The canonical drawing's image records conflict with authoritative
  // storage. Retrying cannot repair this state.
  artifactAssetsInvalid: boolean;
  // Main confirmed that it removed this file while the live session was
  // bound. The current document is retained for recovery only.
  deletedWhileEditing: boolean;
  // The recovery row created for this deletion, if it still exists.
  deletedDraftId: number | null;
  // Image recovery for a drawing retained after deletion or a read-only
  // transition, or after a permanent local-update refusal. While loading, the
  // immediate draft has null file references.
  recoveryAssets:
    | { state: "loading"; count: number }
    | { state: "missing"; count: number }
    | null;
  // A local update exceeded the permanent transport limit. The rejected
  // document is retained for recovery only.
  permanentFailureWhileEditing: boolean;
  // Main refused a live edit because this workspace became read-only after
  // the session opened. The rejected document is retained for recovery only.
  readOnlyWhileEditing: boolean;
  // An open lost to a delete or move interval. This is not a terminal outcome:
  // the operation can still fail, so the caller stays read-only and retries.
  removalInProgress: EngineRemovalInProgress | null;
  artifactAssets: readonly ArtifactAssetDescriptor[];
  readArtifactAsset(assetId: string): Promise<{
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  }>;
};

// What ONE open answers: a workspace, a path, the gate, and the active-version
// token. Everything this hook returns belongs to exactly one of these. JSON
// quotes each part, so two different requests cannot produce one key.
function engineDocRequestKey(input: {
  workspaceId: string;
  path: string;
  enabled: boolean;
  kind?: LiveDocumentKind;
  reopenKey?: number;
  retryKey?: number;
}): string {
  return JSON.stringify([
    input.enabled,
    input.kind ?? "richdoc",
    input.workspaceId,
    input.path,
    input.reopenKey ?? null,
    input.retryKey ?? null,
  ]);
}

// The settled result of one open, stamped with the request it answers.
type EngineDocOpenOutcome =
  | {
      key: string;
      token: number;
      kind: "bound";
      doc: Y.Doc;
      objectId: string | null;
      versionId: string | null;
      artifactAssets: readonly ArtifactAssetDescriptor[];
      readArtifactAsset: EngineYDocBinding["readArtifactAsset"];
    }
  | { key: string; kind: "unavailable" }
  // Their OWN kinds, not flags on "unavailable": every other unavailable
  // answer means "fall back to the plain editor", and these two mean the
  // opposite (#534, #564). Collapsing them would put the branches back
  // behind one flag.
  | { key: string; kind: "not-in-version" }
  | { key: string; kind: "engine-may-hold-document" }
  | { key: string; kind: "artifact-assets-invalid" }
  | { key: string; kind: "removal-in-progress"; removal: EngineRemovalInProgress };

let engineDocSessionCounter = 0;
function nextSessionId(): string {
  engineDocSessionCounter += 1;
  // Bounded (< 64 chars) + unique per open, like the search searchId.
  return `eyd-${Date.now().toString(36)}-${engineDocSessionCounter.toString(36)}`;
}

function makeTransport(
  workspaceId: string,
  path: string,
  sessionId: string,
  // Monotonic local-edit counter, shared with the save-state listener: main
  // echoes back the seq each settle STARTED at, and only a settle that covers
  // the newest edit may be reported as "Saved".
  localSeq: { current: number },
  writesRefused: { current: boolean },
  kind: LiveDocumentKind,
): EngineYDocTransport {
  return {
    ...(kind === "scene" ? { initializeDoc: declareSceneRoots } : {}),
    async open() {
      const result = await bridge().openEngineYDocSession({
        workspaceId,
        path,
        sessionId,
      });
      return {
        available: result.available,
        ...(result.initialUpdate ? { initialUpdate: result.initialUpdate } : {}),
        ...(result.objectId ? { objectId: result.objectId } : {}),
        ...(result.versionId ? { versionId: result.versionId } : {}),
        ...(result.artifactAssets
          ? { artifactAssets: result.artifactAssets }
          : {}),
        ...(result.notInVersion ? { notInVersion: true } : {}),
        ...(result.engineMayHoldDocument ? { engineMayHoldDocument: true } : {}),
        ...(result.artifactAssetsInvalid ? { artifactAssetsInvalid: true } : {}),
        ...(result.removalInProgress
          ? { removalInProgress: result.removalInProgress }
          : {}),
      };
    },
    readArtifactAsset(assetId) {
      return bridge().readEngineYDocArtifactAsset({ sessionId, assetId });
    },
    stageLocalUpdate() {
      if (writesRefused.current) return null;
      localSeq.current += 1;
      return localSeq.current;
    },
    async applyLocalUpdate(update, seq) {
      if (writesRefused.current) return;
      // The provider owns ordered retry. Rejecting here keeps this batch at
      // the head of that queue; resolving is the acknowledgement that main
      // accepted it. The staged seq is reused on retry, never rolled back.
      await bridge().applyEngineYDocUpdate({ sessionId, update, seq });
    },
    onRemoteUpdate(listener) {
      return bridge().onEngineYDocRemoteUpdate((event) => {
        if (event.sessionId !== sessionId) return;
        listener(event.update);
      });
    },
    async close() {
      await bridge().closeEngineYDocSession({ sessionId }).catch(() => undefined);
    },
  };
}

export function useEngineDoc(input: {
  workspaceId: string;
  path: string;
  // The caller gates which supported live files open an engine session.
  // Read-only shared views stay local. A scene can open even when the bounded
  // renderer text read is truncated because the engine owns the full scene.
  enabled: boolean;
  // Defaults to richdoc for existing direct hook callers. Product callers pass
  // the classifier result explicitly.
  kind?: LiveDocumentKind;
  // Bump to retry after `engineMayHoldDocument` (#564): part of the request
  // key, so a retry is a fresh open with the same stale-response guard as any
  // other.
  retryKey?: number;
  // G2-C-3 version-switch re-bind: a monotonic token that changes whenever the
  // ACTIVE VERSION of this workspace changes while the SAME file stays open
  // (the shell's versionEpoch). The session keys on it so switching version
  // flushes+closes the current engine session and reopens it against the
  // now-active version's Y.Doc lineage — resume-never-reseed for a replicated
  // doc (the durable lineage), reseed-from-the-new-file for a local-only doc
  // (switchVersion already materialized the new version onto disk before this
  // reopens). Undefined/stable => no reopen; ordinary history growth in the
  // SAME version must NOT bump this (that would churn the live session).
  reopenKey?: number;
}): UseEngineDoc {
  const documentKind = input.kind ?? "richdoc";
  const requestKey = engineDocRequestKey(input);
  const [outcome, setOutcome] = useState<EngineDocOpenOutcome | null>(null);
  const [saveState, setSaveState] = useState<EngineDocSaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{
    token: number;
    draftId: number | null;
  } | null>(null);
  const [readOnlyTransition, setReadOnlyTransition] = useState<{
    token: number;
  } | null>(null);
  const [permanentFailure, setPermanentFailure] = useState<{
    token: number;
  } | null>(null);
  const [sceneRecoveryAssets, setSceneRecoveryAssets] = useState<{
    token: number;
    state: "loading" | "missing";
    count: number;
  } | null>(null);
  const saveStateRef = useRef<EngineDocSaveState>("saved");
  // Monotonic per-open token: only the newest open may set state (the async-
  // state invariant — a stale workspace/path response never repaints).
  const openTokenRef = useRef(0);

  // DERIVED DURING RENDER, never set by an effect. An effect runs after the
  // render that scheduled it, so an effect-set flag is one frame late — and
  // that frame is the whole defect. When the version switches under an open
  // document (`reopenKey`), the render that carries the new token would
  // otherwise still report the PREVIOUS version's `available`/`doc`: one
  // committed frame of an editable, already-closed session, whose keystrokes
  // go to an obsolete session. A result only counts for the request it
  // answers, so switching request answers "opening" the instant it happens.
  const settled = outcome !== null && outcome.key === requestKey ? outcome : null;
  const available = settled?.kind === "bound";
  const doc = settled?.kind === "bound" ? settled.doc : null;
  const objectId = settled?.kind === "bound" ? settled.objectId : null;
  const versionId = settled?.kind === "bound" ? settled.versionId : null;
  const opening = input.enabled && settled === null;
  // Derived from the same settled result, so it is subject to the same
  // request-identity rule: a refusal for the version the user just LEFT never
  // repaints the document they just entered.
  const notInVersion = settled?.kind === "not-in-version";
  const engineMayHoldDocument = settled?.kind === "engine-may-hold-document";
  const artifactAssetsInvalid = settled?.kind === "artifact-assets-invalid";
  const artifactAssets =
    settled?.kind === "bound" ? settled.artifactAssets : [];
  const readArtifactAsset =
    settled?.kind === "bound"
      ? settled.readArtifactAsset
      : (assetId: string) =>
          Promise.reject(
            new Error(
              `Artifact asset ${assetId} cannot load without a live document session.`,
            ),
          );
  const removalInProgress =
    settled?.kind === "removal-in-progress" ? settled.removal : null;
  const deletedWhileEditing =
    settled?.kind === "bound" && deletion?.token === settled.token;
  const deletedDraftId = deletedWhileEditing ? deletion.draftId : null;
  const readOnlyWhileEditing =
    settled?.kind === "bound" && readOnlyTransition?.token === settled.token;
  const permanentFailureWhileEditing =
    settled?.kind === "bound" && permanentFailure?.token === settled.token;
  const recoveryAssets =
    (deletedWhileEditing ||
      readOnlyWhileEditing ||
      permanentFailureWhileEditing) &&
    sceneRecoveryAssets?.token === settled.token
      ? {
          state: sceneRecoveryAssets.state,
          count: sceneRecoveryAssets.count,
        }
      : null;
  const writesRefused = useRef(false);
  const writesRefusedKey = useRef(requestKey);
  if (writesRefusedKey.current !== requestKey) {
    writesRefusedKey.current = requestKey;
    writesRefused.current = false;
  }
  if (
    deletedWhileEditing ||
    readOnlyWhileEditing ||
    permanentFailureWhileEditing ||
    removalInProgress !== null
  ) {
    writesRefused.current = true;
  }

  useEffect(() => {
    saveStateRef.current = "saved";
    setSaveState("saved");
    setSaveError(null);
    if (!input.enabled) return;
    const { workspaceId, path } = input;
    // The key of the render that scheduled this effect — the request this open
    // answers. Stamped onto the result so a render can tell whether the result
    // it holds is still the one it asked for.
    const key = requestKey;
    const token = ++openTokenRef.current;
    setDeletion(null);
    setReadOnlyTransition(null);
    setPermanentFailure(null);
    setSceneRecoveryAssets(null);
    let cancelled = false;
    let binding: EngineYDocBinding | null = null;
    let detachSaveObserver: (() => void) | null = null;
    let unsubscribeSaveState: (() => void) | null = null;
    // The last recovery snapshot (for change dedup) and the draft it produced.
    // Terminal deletion, read-only transitions, and permanently refused local
    // updates share this path because the mirror holds the user's latest work.
    let recoverySnapshotBytes: Uint8Array | null = null;
    let recoveryDraftId: number | null = null;
    // Serializes recovery snapshots in the order they were taken: a later
    // snapshot's capture must never be overwritten by an earlier one that
    // resolves late (the projection import, and each markdown conversion,
    // are async now).
    let recoveryQueue: Promise<void> = Promise.resolve();
    let recoveryTransition:
      | "deletion"
      | "read-only"
      | "permanent-failure"
      | null = null;
    let deletionPending = false;
    let releaseStarted = false;
    let recoveryRevision = 0;
    const recoveryAssetReads = new Map<
      string,
      Promise<BinaryFileData | null>
    >();

    const sessionId = nextSessionId();
    const localSeq = { current: 0 };
    const transport = makeTransport(
      workspaceId,
      path,
      sessionId,
      localSeq,
      writesRefused,
      documentKind,
    );

    const reportSaveState = (
      state: EngineDocSaveState,
      error: string | null = null,
    ): void => {
      saveStateRef.current = state;
      setSaveState(state);
      setSaveError(error);
    };

    const prepareSceneRecovery = (
      bytes: Uint8Array,
      bound: EngineYDocBinding,
    ): SceneRecoveryWork => {
      const initial = portableSceneRecovery(bytes, {});
      const descriptors = new Map(
        bound.artifactAssets.map((descriptor) => [descriptor.id, descriptor]),
      );
      const reads = initial.requiredAssetIds.map((assetId) => {
        let read = recoveryAssetReads.get(assetId);
        if (!read) {
          const descriptor = descriptors.get(assetId);
          read = descriptor
            ? bound
                .readArtifactAsset(assetId)
                .then((loaded) =>
                  binaryFileDataFromArtifact(descriptor, loaded),
                )
                .catch(() => null)
            : Promise.resolve(null);
          recoveryAssetReads.set(assetId, read);
        }
        return read.then((file) => [assetId, file] as const);
      });
      return {
        immediateText: initial.text,
        requiredAssetCount: initial.requiredAssetIds.length,
        completed: Promise.all(reads).then((results) => {
          const files: Record<string, BinaryFileData> = {};
          let missingAssetCount = 0;
          for (const [assetId, file] of results) {
            if (file) files[assetId] = file;
            else missingAssetCount += 1;
          }
          return {
            text: portableSceneRecovery(bytes, files).text,
            missingAssetCount,
          };
        }),
      };
    };

    // `forceCreate` false means: nothing was unsettled at the moment this
    // snapshot was taken (the dominant delete path, settled before removal)
    // — no draft is worth creating for it. A later snapshot always forces
    // creation: it only runs because the doc changed since the last one.
    const enqueueRecoverySnapshot = (
      bytes: Uint8Array,
      forceCreate: boolean,
      transition: "deletion" | "read-only" | "permanent-failure" | null,
      sceneRecovery: SceneRecoveryWork | null = null,
    ): void => {
      const revision = ++recoveryRevision;
      if (transition && sceneRecovery) {
        setSceneRecoveryAssets(
          sceneRecovery.requiredAssetCount === 0
            ? null
            : {
                token,
                state: "loading",
                count: sceneRecovery.requiredAssetCount,
              },
        );
      }
      recoveryQueue = recoveryQueue
        .then(async () => {
          const text =
            sceneRecovery?.immediateText ??
            (await recoveryTextFromSnapshot(documentKind, bytes));
          if (recoveryDraftId === null) {
            if (!forceCreate) return;
            recoveryDraftId = captureOrphanedDraft(workspaceId, path, text);
          } else {
            replaceOrphanedDraft(workspaceId, path, recoveryDraftId, text);
          }
          // Only the LOCAL render state is guarded by the open token — the
          // draft itself is already durable in the module-level store above,
          // unmount or not.
          if (transition === "deletion" && token === openTokenRef.current) {
            setDeletion({ token, draftId: recoveryDraftId });
          }
          if (!sceneRecovery) return;
          // Asset I/O must not hold the recovery queue. A later scene update
          // must replace the immediate draft now, even if this older image
          // read is slow. Only the newest snapshot may apply its async result.
          void sceneRecovery.completed.then((recovered) => {
            if (revision !== recoveryRevision || recoveryDraftId === null) {
              return;
            }
            replaceOrphanedDraft(
              workspaceId,
              path,
              recoveryDraftId,
              recovered.text,
            );
            if (transition && token === openTokenRef.current) {
              setSceneRecoveryAssets(
                recovered.missingAssetCount === 0
                  ? null
                  : {
                      token,
                      state: "missing",
                      count: recovered.missingAssetCount,
                    },
              );
            }
          });
        })
        .catch((error: unknown) => {
          // This draft is the last copy of the user's text — a load failure
          // here must not disappear silently.
          console.error(
            `[desktop] could not write a recovery draft for ${workspaceId}:${path}:`,
            error,
          );
        });
    };

    const captureDeletion = (doc: Y.Doc): void => {
      writesRefused.current = true;
      recoveryTransition = "deletion";
      // Snapshot NOW, synchronously: the doc can be destroyed (unmount) or
      // the caller's reference can go stale before a lazily-loaded
      // serializer would otherwise get to read it.
      const bytes = Y.encodeStateAsUpdate(doc);
      recoverySnapshotBytes = bytes;
      const forceCreate = saveStateRef.current !== "saved";
      const sceneRecovery =
        forceCreate && documentKind === "scene" && binding
          ? prepareSceneRecovery(bytes, binding)
          : null;
      if (forceCreate) {
        // Persisted NOW, before the projection module is even guaranteed to
        // load: a renderer close/reload/crash while that import is still in
        // flight must not lose text that exists only in this queue's promise
        // closure, with the file already gone and no draft for the recovery
        // close guard to find. The queue below upgrades this row to the
        // faithful markdown a microtask later; it never creates a second one.
        recoveryDraftId = captureOrphanedDraft(
          workspaceId,
          path,
          sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc),
        );
      }
      setDeletion({ token, draftId: recoveryDraftId });
      reportSaveState("deleted");
      enqueueRecoverySnapshot(
        bytes,
        forceCreate,
        recoveryTransition,
        sceneRecovery,
      );
    };

    const captureReadOnlyTransition = (doc: Y.Doc): void => {
      writesRefused.current = true;
      recoveryTransition = "read-only";
      const bytes = Y.encodeStateAsUpdate(doc);
      recoverySnapshotBytes = bytes;
      const sceneRecovery =
        documentKind === "scene" && binding
          ? prepareSceneRecovery(bytes, binding)
          : null;
      // Main sends this state only after it has discarded a local update.
      // Persist the rejected document synchronously before the session closes.
      recoveryDraftId = captureOrphanedDraft(
        workspaceId,
        path,
        sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc),
      );
      setReadOnlyTransition({ token });
      reportSaveState("read-only");
      enqueueRecoverySnapshot(bytes, true, recoveryTransition, sceneRecovery);
    };

    const refreshRecoveryDraft = (doc: Y.Doc): void => {
      if (recoverySnapshotBytes === null) return;
      const bytes = Y.encodeStateAsUpdate(doc);
      if (snapshotsEqual(bytes, recoverySnapshotBytes)) return;
      recoverySnapshotBytes = bytes;
      const sceneRecovery =
        documentKind === "scene" && binding
          ? prepareSceneRecovery(bytes, binding)
          : null;
      if (sceneRecovery && recoveryDraftId !== null) {
        replaceOrphanedDraft(
          workspaceId,
          path,
          recoveryDraftId,
          sceneRecovery.immediateText,
        );
      }
      enqueueRecoverySnapshot(
        bytes,
        true,
        recoveryTransition,
        sceneRecovery,
      );
    };

    const capturePermanentFailure = (
      error: EngineYDocUpdateTooLargeError,
      doc: Y.Doc,
    ): void => {
      writesRefused.current = true;
      recoveryTransition = "permanent-failure";
      const bytes = Y.encodeStateAsUpdate(doc);
      recoverySnapshotBytes = bytes;
      const sceneRecovery =
        documentKind === "scene" && binding
          ? prepareSceneRecovery(bytes, binding)
          : null;
      recoveryDraftId = captureOrphanedDraft(
        workspaceId,
        path,
        sceneRecovery?.immediateText ?? crudeRecoveryText(documentKind, doc),
      );
      if (!cancelled && token === openTokenRef.current) {
        setPermanentFailure({ token });
        reportSaveState("error", error.message);
      }
      enqueueRecoverySnapshot(bytes, true, recoveryTransition, sceneRecovery);
    };

    const releaseBinding = (): void => {
      if (!binding || releaseStarted) return;
      releaseStarted = true;
      // The rejected apply is an acknowledged no-op. destroy() drains that
      // acknowledgement, refuses queued follow-ups through writesRefused, and
      // then closes the main session instead of leaving it alive to retry.
      void binding.destroy();
    };

    const onSaveState = (event: EngineYDocSaveStateEvent): void => {
      if (cancelled || token !== openTokenRef.current) return;
      if (event.sessionId !== sessionId) return;
      if (event.state === "deleted") {
        const doc = binding?.doc;
        if (!doc) {
          deletionPending = true;
          writesRefused.current = true;
          return;
        }
        if (recoverySnapshotBytes !== null) {
          deletionPending = true;
          recoveryTransition = "deletion";
          setDeletion({ token, draftId: recoveryDraftId });
          reportSaveState("deleted");
          refreshRecoveryDraft(doc);
          return;
        }
        captureDeletion(doc);
        return;
      }
      // Deletion is terminal for this session. A settle/update already in
      // flight can report after main's deletion notice, but it no longer
      // describes a path that exists and must not repaint this state.
      if (writesRefused.current) return;
      if (event.state === "read-only") {
        const doc = binding?.doc;
        // Unlike deletion, this report answers a local update, so it cannot
        // precede the binding that allowed that update.
        if (!doc) return;
        captureReadOnlyTransition(doc);
        releaseBinding();
        return;
      }
      if (event.state === "file-locked") {
        if (event.seq >= localSeq.current) reportSaveState(event.state);
        return;
      }
      if (
        event.state === "error" ||
        event.state === "changed-on-disk"
      ) {
        reportSaveState(event.state);
        return;
      }
      if (event.state === "settling") {
        reportSaveState("saving");
        return;
      }
      if (event.seq >= localSeq.current) reportSaveState("saved");
    };

    const openAttempt = (async (): Promise<EngineYDocBinding> => {
      // Subscribe before open: main registers the live entry before the IPC
      // answer returns, so deletion can otherwise notify an empty listener set
      // in that hand-over window. The async boundary catches an older preload
      // that does not expose this channel without delaying the open itself.
      unsubscribeSaveState = bridge().onEngineYDocSaveState(onSaveState);
      return bindEngineYDoc(transport, undefined, {
        onPermanentLocalUpdateFailure: capturePermanentFailure,
      });
    })();
    void openAttempt
      .then((bound) => {
        // A newer open (workspace/path switch) superseded this one, or the effect
        // already cleaned up: never bind the stale doc — close it and bail.
        if (cancelled || token !== openTokenRef.current) {
          void bound.destroy();
          return;
        }
        binding = bound;
        // Preload, don't block: by the time any real deletion can arrive,
        // the module is very likely already resolved, so a draft's markdown
        // lands within the same microtask as its snapshot. The snapshot in
        // captureDeletion/refreshRecoveryDraft keeps a genuinely cold start
        // (import still in flight) correct regardless.
        if (documentKind === "richdoc") void loadProjectionModule();
        if (!bound.available || !bound.doc) {
          // Resolved: NOT engine-backed. The caller may offer the plain local
          // editor again — that is what `opening` was holding back. EXCEPT
          // when the path is not in this version, where offering it would
          // write the phantom the engine just refused (#534), and when the
          // engine may still hold the document, where a plain autosave would
          // race the session it still binds (#564, #657).
          if (bound.notInVersion) {
            setOutcome({ key, kind: "not-in-version" });
          } else if (bound.artifactAssetsInvalid) {
            setOutcome({ key, kind: "artifact-assets-invalid" });
          } else if (bound.engineMayHoldDocument) {
            setOutcome({ key, kind: "engine-may-hold-document" });
          } else if (bound.removalInProgress) {
            setOutcome({
              key,
              kind: "removal-in-progress",
              removal: bound.removalInProgress,
            });
          } else {
            setOutcome({ key, kind: "unavailable" });
          }
          return;
        }
        // An edit is unsaved the instant it happens. Only main's settle report
        // may clear it — nothing here guesses "saved". The seed apply happened
        // before this observer attached, so it never shows a spurious "saving".
        const doc = bound.doc;
        const onUpdate = () => {
          if (cancelled) return;
          if (writesRefused.current) {
            refreshRecoveryDraft(doc);
            return;
          }
          reportSaveState("saving");
        };
        doc.on("update", onUpdate);
        detachSaveObserver = () => doc.off("update", onUpdate);
        if (deletionPending) captureDeletion(doc);
        setOutcome({
          key,
          token,
          kind: "bound",
          doc,
          objectId: bound.objectId,
          versionId: bound.versionId,
          artifactAssets: bound.artifactAssets,
          readArtifactAsset: (assetId) => bound.readArtifactAsset(assetId),
        });
      })
      .catch(() => {
        if (cancelled || token !== openTokenRef.current) return;
        setOutcome({ key, kind: "unavailable" });
      });

    return () => {
      // Belt-and-suspenders, not the sole catcher: `onUpdate` below already
      // snapshots synchronously for any doc mutation once `writesRefused` is
      // true, local or remote, ahead of this cleanup in the same tick. This
      // guards a mutation landing between `cancelled = true` and
      // `detachSaveObserver()` — narrower than reachable through the public
      // API today, kept for what a future change to that ordering could open.
      if (binding?.doc) refreshRecoveryDraft(binding.doc);
      cancelled = true;
      unsubscribeSaveState?.();
      detachSaveObserver?.();
      // Settle + close the engine session in main (releases the single-canonical
      // reservation so a version/file switch can reopen the same object), then
      // drop the mirror doc.
      void binding?.destroy();
      // The result dies with the session it describes. Without this, a request
      // that comes BACK to a key it held before (a truncated read that reloads
      // whole, so `enabled` goes false then true) would match the old outcome
      // and hand the caller an editable doc this cleanup already destroyed.
      setOutcome(null);
    };
    // input is destructured; re-open only when the workspace, path, gate, or the
    // active-version token changes — never on unrelated re-renders. reopenKey
    // re-binds the editor to the new version's lineage on a version switch
    // (server-side switchVersion already settled+closed the old session and
    // materialized the new version to disk; this effect's cleanup settles+closes
    // the renderer's mirror session and the re-run opens a fresh one, guarded by
    // the per-open token so a stale response never repaints).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    input.workspaceId,
    input.path,
    input.enabled,
    input.kind,
    input.reopenKey,
    input.retryKey,
  ]);

  return {
    available,
    opening,
    doc,
    objectId,
    versionId,
    saveState,
    saveError,
    notInVersion,
    engineMayHoldDocument,
    artifactAssetsInvalid,
    deletedWhileEditing,
    deletedDraftId,
    recoveryAssets,
    permanentFailureWhileEditing,
    readOnlyWhileEditing,
    removalInProgress,
    artifactAssets,
    readArtifactAsset,
  };
}
