import type { ReadOnlyTransitionCause } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { rearmDesktopAdmission } from "./rearmDesktopAdmission";
import type { SharedDocumentOpenState } from "../../ipc/sharedDocumentOpenState";
import { captureHeldLiveMessage } from "../../ipc/errorWords";
import { UNKNOWN_SAVE_STATE, type SaveState } from "@dohc/workspace-contracts/save-state";
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
  type DocumentGoneCause,
} from "./engineDocLease";

export type { EngineRemovalInProgress };

const NO_DRAFT_IDS: readonly number[] = [];

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
  headSha256?: string | null;
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
  saveState: SaveState;
  // A known terminal save failure. The save-state chip uses this instead of
  // its generic error text so it can name the constraint and measured bytes.
  saveError: string | null;
  authorCapacity: boolean;
  // The path is not in the version this workspace is on: a version switch
  // removed it while this open was queued behind that switch.
  // The caller must not fall back to the writable plain editor, whose autosave
  // would write the file back into the version the user just entered.
  notInVersion: boolean;
  // Main could no longer resolve the live file at the path the renderer read.
  // The caller replaces the stale document instead of recreating the file.
  documentUnavailable: boolean;
  liveHostUnavailable: boolean;
  sharedWaiting?: SharedDocumentOpenState | null;
  // The open did not land and a session for this document may still be the
  // engine's. Same no-downgrade rule as notInVersion: the caller
  // stays read-only, states the reason, and offers a retry (bump retryKey),
  // which is also what discharges what the failure left behind.
  engineMayHoldDocument: boolean;
  openRefusal?: string;
  // The canonical drawing's image records conflict with authoritative
  // storage. Retrying cannot repair this state.
  artifactAssetsInvalid: boolean;
  // Main confirmed that this document left its path while the live session
  // was bound: the file was deleted, or another file now holds the path
  // (`goneCause`). The current document is retained for recovery only.
  deletedWhileEditing: boolean;
  goneCause: DocumentGoneCause | null;
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
  // The file changed outside dohc while this session held it: "saved" when
  // the document had no unsaved edits then, "unsaved" when it had.
  changedOutside: "saved" | "unsaved" | null;
  // A close released the file, but capture has not recorded the version
  // changed outside dohc yet, so the document did not open again.
  outsideWriteWaiting: boolean;
  // Asked right before a reload: edits main has not confirmed yet.
  unsavedEditsPending: () => boolean;
  // The live session became read-only after it opened. Unconfirmed local
  // edits are retained for recovery; a clean access stop creates no draft.
  readOnlyWhileEditing: boolean;
  // The recovery row that read-only transition created, if it still exists.
  readOnlyDraftId: number | null;
  readOnlyCause: ReadOnlyTransitionCause | null;
  // Try again for a history replacement that could not set the earlier edits
  // aside. The editor stays frozen until it succeeds.
  retryReplacement: (() => void) | null;
  // The recovery rows holding edits a finished history replacement set aside.
  replacedDraftIds: readonly number[];
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
  const [deliveryRetry, setDeliveryRetry] = useState(0);
  const retryKey = (input.retryKey ?? 0) + deliveryRetry;
  const requestInput = { ...input, retryKey };
  const requestKey = engineDocRequestKey(requestInput);
  const waiting = useRef(false);
  const activityRevision = useRef(0);
  const openingRevision = useRef(0);
  useEffect(() => bridge().onWorkspaceActivity?.(event => {
    if (event.workspaceId !== undefined && event.workspaceId !== input.workspaceId) return;
    if (event.paths?.length && !event.paths.includes(input.path)) return;
    activityRevision.current++;
    if (waiting.current) setDeliveryRetry(value => value + 1);
  }), [input.workspaceId, input.path]);
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

  const [readOnlyHistory, setReadOnlyHistory] = useState<{
    versionKey: string;
    retryKey: number;
    bound: boolean;
    cause: UseEngineDoc["readOnlyCause"];
  } | null>(null);

  useEffect(() => {
    const previousRequest = committedRequestRef.current;
    if (!input.enabled) {
      setReadOnlyHistory((previous) =>
        previous?.versionKey === versionKey && previous.retryKey === retryKey && previous.bound && input.accessEnded
          ? { ...previous, cause: "access-ended" }
          : previous,
      );
      previousRequest?.lease?.disposeIfReleased();
      committedRequestRef.current = { versionKey, retryKey, lease: null };
      setLeaseState(null);
      return;
    }

    const isRetry =
      previousRequest?.versionKey === versionKey &&
      previousRequest.retryKey !== retryKey;
    openingRevision.current = activityRevision.current;
    const lease = retainEngineDocLease(requestInput, requestKey, isRetry);
    committedRequestRef.current = { versionKey, retryKey, lease };
    const update = () => {
      const snapshot = lease.getSnapshot();
      setLeaseState({ requestKey, snapshot });
      const bound = snapshot.outcome?.kind === "bound";
      const transition = snapshot.readOnlyTransition;
      const cause = snapshot.outcome?.kind === "bound" && transition?.token === snapshot.outcome.token
        ? transition.cause : null;
      setReadOnlyHistory((previous) =>
        previous?.versionKey === versionKey && previous.retryKey === retryKey && previous.bound === bound && previous.cause === cause
          ? previous : { versionKey, retryKey, bound, cause },
      );
    };
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
    retryKey,
    input.accessEnded,
  ]);

  // Derive this during render. A result for an earlier request never grants
  // one editable frame while a version, path, gate, or retry request changes.
  const settled =
    leaseState?.requestKey === requestKey ? leaseState.snapshot : null;
  const outcome = settled?.outcome ?? null;
  const admissionWaiting = input.enabled && outcome?.kind === "shared-waiting" && outcome.waiting.state === "failed";
  useEffect(() => {
    if (!admissionWaiting) return;
    let active: {cancel: AbortController; sessionId: string} | undefined;
    const stop = () => {
      if (!active) return;
      active.cancel.abort();
      void bridge().closeEngineYDocSession({sessionId: active.sessionId}).catch(() => {});
      active = undefined;
    };
    const start = () => {
      if (document.visibilityState === "hidden") { stop(); return; }
      if (active) return;
      const run = {cancel: new AbortController(), sessionId: crypto.randomUUID()};
      active = run;
      void rearmDesktopAdmission({signal: run.cancel.signal,
        wait: () => bridge().waitForEngineYDocAdmission({workspaceId: input.workspaceId, path: input.path, sessionId: run.sessionId}),
        ready: () => setDeliveryRetry(value => value + 1),
      });
    };
    document.addEventListener("visibilitychange", start);
    start();
    return () => { document.removeEventListener("visibilitychange", start); stop(); };
  }, [admissionWaiting, input.workspaceId, input.path, requestKey]);
  waiting.current = outcome?.kind === "shared-waiting" || outcome?.kind === "live-host-unavailable";
  useEffect(() => {
    if (waiting.current && activityRevision.current > openingRevision.current) setDeliveryRetry(value => value + 1);
  }, [outcome]);
  const available = outcome?.kind === "bound";
  const doc = outcome?.kind === "bound" ? outcome.doc : null;
  const objectId = outcome?.kind === "bound" ? outcome.objectId : null;
  const versionId = outcome?.kind === "bound" ? outcome.versionId : null;
  const opening = input.enabled && outcome === null;
  const notInVersion = outcome?.kind === "not-in-version";
  const documentUnavailable = outcome?.kind === "document-unavailable";
  const engineMayHoldDocument = outcome?.kind === "engine-may-hold-document" || outcome?.kind === "capture-held";
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
  const goneCause = deletedWhileEditing
    ? (settled?.deletion?.cause ?? "deleted")
    : null;
  const readOnlyWhileEditing =
    outcome?.kind === "bound" &&
    settled?.readOnlyTransition?.token === outcome.token;
  const readOnlyDraftId = readOnlyWhileEditing
    ? (settled?.readOnlyTransition?.draftId ?? null)
    : null;
  const history = readOnlyHistory?.versionKey === versionKey && readOnlyHistory.retryKey === retryKey
    ? readOnlyHistory : null;
  const readOnlyCause = !input.enabled
    ? input.accessEnded && history?.bound ? "access-ended" : history?.cause ?? null
    : readOnlyWhileEditing ? settled!.readOnlyTransition!.cause : null;
  const retryReplacement = readOnlyWhileEditing ? settled!.readOnlyTransition!.retry ?? null : null;
  const permanentFailureWhileEditing =
    outcome?.kind === "bound" &&
    settled?.permanentFailure?.token === outcome.token;
  const outsideWriteWaiting = outcome?.kind === "outside-write-waiting";
  const changedOutside =
    outcome?.kind === "bound" && settled?.changedOutside?.token === outcome.token
      ? settled.changedOutside.unsaved ? "unsaved" : "saved"
      : null;
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
    headSha256: outcome?.kind === "bound" ? outcome.headSha256 : undefined,
    opening,
    doc,
    objectId,
    versionId,
    saveState: settled?.saveState ?? UNKNOWN_SAVE_STATE,
    saveError: settled?.saveError ?? null,
    authorCapacity: settled?.authorCapacity ?? false,
    notInVersion,
    documentUnavailable,
    liveHostUnavailable: outcome?.kind === "live-host-unavailable" || outcome?.kind === "shared-waiting",
    sharedWaiting: outcome?.kind === "shared-waiting" ? outcome.waiting : null,
    engineMayHoldDocument,
    openRefusal: outcome?.kind === "capture-held" ? captureHeldLiveMessage(input.path) : undefined,
    artifactAssetsInvalid,
    deletedWhileEditing,
    goneCause,
    deletedDraftId,
    recoveryAssets,
    permanentFailureWhileEditing,
    changedOutside,
    outsideWriteWaiting,
    unsavedEditsPending: () => committedRequestRef.current?.lease?.unsavedEditsPending() ?? false,
    readOnlyWhileEditing,
    readOnlyDraftId,
    readOnlyCause,
    retryReplacement,
    replacedDraftIds: settled?.replacedDraftIds ?? NO_DRAFT_IDS,
    removalInProgress,
    artifactAssets,
    readArtifactAsset,
    flushPendingLocalUpdates,
  };
}
