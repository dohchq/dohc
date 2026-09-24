import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import type { ArtifactAssetDescriptor } from "@dohc/workspace-engine-client";
import { documentVersionKey } from "../documentVersionKey";
import type {
  EngineRemovalInProgress,
  EngineYDocBinding,
} from "./engineYDocProvider";
import {
  engineDocRequestKey,
  retainEngineDocLease,
  type EngineDocInput,
  type EngineDocLease,
  type EngineDocLeaseSnapshot,
  type EngineDocSaveState,
} from "./engineDocLease";

export type { EngineRemovalInProgress };

// The engine Y.Doc editor hook for live files. Given a workspace, path, and
// format kind, it opens a live engine Y.Doc session in main over IPC and binds
// a mirror Y.Doc to the format editor. Solo editing runs through the engine; a
// co-editor's edit arrives as a forwarded remote delta on the same channel.
//
// available:false and opening:false => the doc is not engine-backed (shared
// view, secret path, or already live) — the caller stays on the plain
// local autosave editor showing the real on-disk content. While opening:true
// the answer is not known yet and the caller must stay read-only. Named refusal
// outcomes also block the writable fallback when main cannot prove it is safe.
// Each editor owns undo: rich
// documents use their collaboration history, while drawings use Excalidraw's
// native history and publish the resulting higher element revision.
//
// Duplicate views of one document share one session: leases are keyed by the
// workspace, path, and active-version token, so two panes showing the same
// file bind the same mirror Y.Doc, share its save state, and recover together.
//
// Renderer async-state invariant (product invariant): every open response is
// guarded by its request key and the session's disposed flag. A slow open for
// workspace/path A can never bind or repaint after the user has switched to B
// — the stale response is dropped and its session closed.

export type UseEngineDoc = {
  // True once the engine session is open and the mirror doc is bound. false
  // permits the local autosave editor only after opening settles without a
  // named refusal outcome.
  available: boolean;
  // No open has answered for the current request yet. "Opening" and
  // "not engine-backed" used to be the same `available: false`, so the caller
  // showed its writable plain editor — whose autosave writes straight to disk
  // — for the whole wait. On a workspace whose capture chain is busy (startup
  // reconciliation, a version switch) that wait is seconds, and every keystroke
  // in it took a path the about-to-bind session never sees: the session then
  // seeds from a head without them. True on the first render of an open and on
  // the first render after the request changes under a bound document (a
  // version switch), because both are the same unanswered question.
  // The caller must offer no writable surface while this is true.
  opening: boolean;
  // The mirror Y.Doc the editor binds to; null until bound / when unavailable.
  doc: Y.Doc | null;
  // Exact engine identity for this bound document. Presence must not use the
  // path because a rename does not create a new document.
  objectId: string | null;
  versionId: string | null;
  // The document's real save state. "saving" the moment an edit is made,
  // "saved" Only when main reports a settle that covered that edit actually
  // committed and wrote the .md, "error" when a settle failed. This used to be
  // a 1s timer that flipped to "saved" regardless of what the engine did —
  // three dogfood journeys watched a doc read "Saved" over a zero-byte file.
  saveState: EngineDocSaveState;
  // How many saves replaced an outside write that overlapped the person's own
  // text. The caller tells the person once per increase.
  externalWritesInHistory: number;
  // A known terminal save failure. The save-state chip uses this instead of
  // its generic error text so it can name the constraint and measured bytes.
  saveError: string | null;
  // The path is not in the version this workspace is on: a version switch
  // removed it while this open was queued behind that switch.
  // The caller must not fall back to the writable plain editor, whose autosave
  // would write the file back into the version the user just entered.
  notInVersion: boolean;
  // Main could no longer resolve the live file at the path the renderer read.
  // The caller replaces the stale document instead of recreating the file.
  documentUnavailable: boolean;
  liveHostUnavailable: boolean;
  // The open did not land and a session for this document may still be the
  // engine's. Same no-downgrade rule as notInVersion: the caller
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
  // A local update exceeded the permanent transport limit, or main refused a
  // delivery outright. The rejected document is retained for recovery only.
  permanentFailureWhileEditing: boolean;
  // Main refused a live edit because this workspace became read-only after
  // the session opened. The rejected document is retained for recovery only.
  readOnlyWhileEditing: boolean;
  // An open lost to a delete or move interval. This is not a terminal outcome:
  // the operation can still fail, so the caller stays read-only and retries.
  removalInProgress: EngineRemovalInProgress | null;
  artifactAssets: readonly ArtifactAssetDescriptor[];
  readArtifactAsset(descriptor: ArtifactAssetDescriptor): Promise<{
    descriptor: ArtifactAssetDescriptor;
    bytes: Uint8Array;
  }>;
  // Push every accepted renderer edit to main and wait for acknowledgement.
  // Explorer mutations await this before main settles the old-path session.
  flushPendingLocalUpdates: EngineYDocBinding["flushPendingLocalUpdates"];
};

export function useEngineDoc(input: EngineDocInput): UseEngineDoc {
  const requestKey = engineDocRequestKey(input);
  const retryKey = input.retryKey ?? 0;
  const versionKey = documentVersionKey(
    input.workspaceId,
    input.path,
    input.reopenKey,
  );
  const committedRequestRef = useRef<{
    versionKey: string;
    retryKey: number;
    lease: EngineDocLease | null;
  } | null>(null);
  const [leaseState, setLeaseState] = useState<{
    requestKey: string;
    snapshot: EngineDocLeaseSnapshot;
  } | null>(null);

  useEffect(() => {
    const previousRequest = committedRequestRef.current;
    if (!input.enabled) {
      previousRequest?.lease?.disposeIfReleased();
      committedRequestRef.current = { versionKey, retryKey, lease: null };
      setLeaseState(null);
      return;
    }

    const isRetry =
      previousRequest?.versionKey === versionKey &&
      previousRequest.retryKey !== retryKey;
    const lease = retainEngineDocLease(input, requestKey, isRetry);
    committedRequestRef.current = { versionKey, retryKey, lease };
    const update = () =>
      setLeaseState({
        requestKey,
        snapshot: lease.getSnapshot(),
      });
    const unsubscribe = lease.subscribe(update);
    update();
    return () => {
      unsubscribe();
      lease.release();
    };
    // Re-open only when the workspace, path, gate, kind, retry, or active
    // version changes. Other renders keep the same shared lease.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    input.workspaceId,
    input.path,
    input.enabled,
    input.kind,
    input.reopenKey,
    input.retryKey,
  ]);

  // Derive this during render. A result for an earlier request never grants
  // one editable frame while a version, path, gate, or retry request changes.
  const settled =
    leaseState?.requestKey === requestKey ? leaseState.snapshot : null;
  const outcome = settled?.outcome ?? null;
  const available = outcome?.kind === "bound";
  const doc = outcome?.kind === "bound" ? outcome.doc : null;
  const objectId = outcome?.kind === "bound" ? outcome.objectId : null;
  const versionId = outcome?.kind === "bound" ? outcome.versionId : null;
  const opening = input.enabled && outcome === null;
  const notInVersion = outcome?.kind === "not-in-version";
  const documentUnavailable = outcome?.kind === "document-unavailable";
  const engineMayHoldDocument = outcome?.kind === "engine-may-hold-document";
  const artifactAssetsInvalid = outcome?.kind === "artifact-assets-invalid";
  const artifactAssets =
    outcome?.kind === "bound" ? outcome.artifactAssets : [];
  const readArtifactAsset =
    outcome?.kind === "bound"
      ? outcome.readArtifactAsset
      : (descriptor: ArtifactAssetDescriptor) =>
          Promise.reject(
            new Error(
              `Artifact asset ${descriptor.id} cannot load without a live document session.`,
            ),
          );
  const flushPendingLocalUpdates =
    outcome?.kind === "bound"
      ? outcome.flushPendingLocalUpdates
      : () => Promise.resolve();
  const removalInProgress =
    outcome?.kind === "removal-in-progress" ? outcome.removal : null;
  const deletedWhileEditing =
    outcome?.kind === "bound" && settled?.deletion?.token === outcome.token;
  const deletedDraftId = deletedWhileEditing
    ? (settled?.deletion?.draftId ?? null)
    : null;
  const readOnlyWhileEditing =
    outcome?.kind === "bound" &&
    settled?.readOnlyTransition?.token === outcome.token;
  const permanentFailureWhileEditing =
    outcome?.kind === "bound" &&
    settled?.permanentFailure?.token === outcome.token;
  const recoveryAssets =
    settled?.sceneRecoveryAssets != null &&
    outcome?.kind === "bound" &&
    settled.sceneRecoveryAssets.token === outcome.token
      ? {
          state: settled.sceneRecoveryAssets.state,
          count: settled.sceneRecoveryAssets.count,
        }
      : null;

  return {
    available,
    opening,
    doc,
    objectId,
    versionId,
    saveState: settled?.saveState ?? "saved",
    externalWritesInHistory: settled?.externalWritesInHistory ?? 0,
    saveError: settled?.saveError ?? null,
    notInVersion,
    documentUnavailable,
    liveHostUnavailable: outcome?.kind === "live-host-unavailable",
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
    flushPendingLocalUpdates,
  };
}
