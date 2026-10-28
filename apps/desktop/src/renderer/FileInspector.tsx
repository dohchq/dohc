import type { SaveState } from "@dohc/workspace-contracts/save-state";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import type { RecordHistoryTarget } from "./collections/useRecordHistory";
import { filenameStem, MarkdownView, type HeadingTarget, type PageEditor, type ScrollTarget } from "./MarkdownView";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES, exceedsUtf8Bytes } from "../workspaces/workspaceTextLimits";
import { DrawingView } from "./DrawingView";
import { lossyNoteRefusal } from "@dohc/ydoc-projection/lossy-markdown";
import {
  DocumentControls,
  EngineArtifactAssetsInvalidNotice,
  EngineMayHoldDocumentNotice,
  ViewActions,
  OrphanedDraftNotices,
  EngineRemovalInProgressNotice,
  OPENING_TITLE,
  OpenExternallyButton,
  OpenExternallyControl,
  openExternally,
} from "./fileInspectorUi";
import { TextEditorView } from "./TextEditorView";
import type { PendingFileUndo } from "./fileEditorUndo";
import { CsvControls, CsvView } from "./CsvView";
import { ImageView } from "./ImageView";
import { extensionOf } from "./path";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { DraftFlush } from "./useAutosavedTextDraft";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  Suspense,
  lazy,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { bridge } from "./bridge";
import { useEngineDoc } from "./collab/useEngineDoc";
import { useBoundNoteCheck, useLossyNote, warmLossyNoteCheck } from "./editor/lossyNote";
import { useAuthorCapacityNotice } from "./collab/useAuthorCapacityNotice";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import { Layers, TriangleAlert } from "lucide-react";
import { EmptyState, SecondaryButton } from "./ui/controls";
import { SkeletonRows, SkeletonSlot } from "./ui/SkeletonRows";
import type { ExcalidrawPresenceFactory } from "./collab/excalidrawPresence";
import {
  acquireSharedLocalDocument,
  getSharedLocalDocument,
  type SharedLocalDocument,
} from "./sharedLocalDocument";
import { documentVersionKey } from "./documentVersionKey";

// Builds the privileged URL the dohc-file protocol serves bytes from. The
// main process resolves <workspaceId> to a real workspace root and enforces
// path containment, so this URL can't escape the workspace. `refreshKey`
// rides along as a cache-buster: share-mount pulls (and history refreshes)
// change bytes without remounting the inspector, and a stable URL would
// keep the old <img>/<audio> bytes on screen.
function assetUrl(workspaceId: string, path: string, refreshKey: number): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `dohc-file://${workspaceId}/${encoded}?v=${refreshKey}`;
}

const LazyDatabaseStudioView = lazy(() =>
  import("./DatabaseStudioView").then((mod) => ({
    default: mod.DatabaseStudioView,
  })),
);

// Text content comes over IPC, not via fetch — a file:// renderer can't fetch
// a custom scheme. Media (image/audio) instead use the dohc-file URL as an
// element src, which is not subject to that restriction.
function useTextContent(
  workspaceId: string,
  path: string,
  enabled: boolean,
  refreshKey: number,
  localBuffer: SharedLocalDocument,
) {
  const [conflictRefreshKey, setConflictRefreshKey] = useState(0);
  const refreshAfterConflict = useCallback(() => {
    setConflictRefreshKey((key) => key + 1);
  }, []);
  const requestRef = useRef({
    workspaceId: "",
    path: "",
    enabled: false,
    refreshKey: -1,
    conflictRefreshKey: -1,
    id: 0,
    localBuffer: null as SharedLocalDocument | null,
  });
  const requestChanged =
    requestRef.current.workspaceId !== workspaceId ||
    requestRef.current.path !== path ||
    requestRef.current.enabled !== enabled ||
    requestRef.current.refreshKey !== refreshKey ||
    requestRef.current.conflictRefreshKey !== conflictRefreshKey ||
    requestRef.current.localBuffer !== localBuffer;
  if (requestChanged) {
    requestRef.current = {
      workspaceId,
      path,
      enabled,
      refreshKey,
      conflictRefreshKey,
      id: requestRef.current.id + 1,
      localBuffer,
    };
  }
  const requestId = requestRef.current.id;
  // The body and its hash are one authoritative read snapshot. A render must
  // never pair a new body with the previous read's write precondition.
  const [content, setContent] = useState<{
    text: string;
    loadedWorkspaceId: string;
    loadedPath: string;
    truncated: boolean;
    contentHash: string | null;
    requestId: number;
    readTicket: number;
  } | null>(null);
  const [error, setError] = useState(false);
  // Bumped once per answered read. The dispatcher uses it to tell "the reread
  // a version switch triggered has landed" from "the pre-switch body is still
  // on screen" — the window the plain-text autosave used to write into.
  const [readSeq, setReadSeq] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const initializedRead = useRef<{
    buffer: SharedLocalDocument;
    ticket: number;
  } | null>(null);
  const markReadInitialized = useCallback((readTicket: number) => {
    const marked = initializedRead.current;
    initializedRead.current = {
      buffer: localBuffer,
      ticket:
        marked?.buffer === localBuffer
          ? Math.max(marked.ticket, readTicket)
          : readTicket,
    };
  }, [localBuffer]);
  const lastLocationRef = useRef<{
    workspaceId: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let answered: { text: string; contentHash: string | null } | null = null;
    const readTicket = localBuffer.beginRead();
    // Blank when switching workspaces or files. An activity refresh at the
    // same location swaps content in place instead of flashing it away.
    if (
      lastLocationRef.current?.workspaceId !== workspaceId ||
      lastLocationRef.current.path !== path
    ) {
      lastLocationRef.current = { workspaceId, path };
      setContent(null);
      setError(false);
    }
    void bridge()
      .readWorkspaceText({ workspaceId, relativePath: path })
      .then((r) => {
        if (cancelled) return;
        answered = r;
        setContent({
          text: r.text,
          loadedWorkspaceId: workspaceId,
          loadedPath: path,
          truncated: r.truncated,
          contentHash: r.contentHash,
          requestId,
          readTicket,
        });
        setError(false);
        setReadSeq((seq) => seq + 1);
      })
      .catch(() => {
        if (cancelled) return;
        setContent(null);
        setError(true);
        // A failed read still answers for request bookkeeping. Switch safety
        // also checks `error` and keeps writes refused until a later success.
        setReadSeq((seq) => seq + 1);
      });
    return () => {
      cancelled = true;
      if (
        !mounted.current &&
        answered &&
        (initializedRead.current?.buffer !== localBuffer ||
          initializedRead.current.ticket < readTicket)
      ) {
        const completed = answered;
        queueMicrotask(() => {
          if (
            initializedRead.current?.buffer === localBuffer &&
            initializedRead.current.ticket >= readTicket
          ) {
            return;
          }
          localBuffer.initializeRead(
            completed.text,
            completed.contentHash,
            readTicket,
          );
        });
      }
    };
    // refreshKey bumps on workspace activity so an open file re-reads when it
    // changes on disk (e.g. an agent edits it).
  }, [
    workspaceId,
    path,
    enabled,
    refreshKey,
    conflictRefreshKey,
    requestId,
    localBuffer,
  ]);
  const currentContent =
    content?.loadedWorkspaceId === workspaceId && content.loadedPath === path
      ? content
      : null;
  return {
    text: currentContent?.text ?? null,
    loadedPath: currentContent?.loadedPath ?? null,
    truncated: currentContent?.truncated ?? false,
    contentHash: currentContent?.contentHash ?? null,
    contentRequestId: currentContent?.requestId ?? 0,
    contentReadTicket: currentContent?.readTicket ?? 0,
    latestContentRequestId: requestId,
    error,
    readSeq,
    refreshAfterConflict,
    markReadInitialized,
  };
}

function TruncatedNotice(props: { workspaceId: string; path: string; onError?: ReportButtonError }) {
  return (
    <div
      data-testid="truncated-notice"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      <span>Showing the start of a large file.</span>
      <OpenExternallyControl workspaceId={props.workspaceId} path={props.path}>
        {(describedBy) => (
          <button
            type="button"
            aria-describedby={describedBy}
            onClick={() => openExternally(props)}
            className="text-subtle hover:text-ink"
          >
            Open the full file externally
          </button>
        )}
      </OpenExternallyControl>
    </div>
  );
}

type FileInspectorProps = {
  workspaceId: string;
  path: string;
  // A record's Button fields report through the shell's toasts and Notices,
  // and the shell opens the record's History.
  onButtonError?: ReportButtonError;
  onButtonNotice?: (message: string, undo?: () => void) => void;
  // Closes every tab showing a file, as an Undo that removes it does first.
  onClosePath?: (path: string) => void;
  onOpenRecordHistory?: (record: RecordHistoryTarget) => void;
  fileOpenStartMark?: string;
  refreshKey?: number;
  onOpenPath?: (path: string, headingTarget?: HeadingTarget) => void;
  // A pending search-result jump. Consumed (onScrollConsumed)
  // once a mounted view applied it, so plain re-opens never re-jump.
  scrollTarget?: ScrollTarget;
  // A pending file/section mention or fragment-link jump. Unlike a search
  // target this stays in the rich editor and lands on the rendered heading.
  headingTarget?: HeadingTarget;
  onScrollConsumed?: (nonce: number) => void;
  // Editor save-state seam for the tab strip's dirty indicator. Editable
  // source/table/document views all report through the same small contract.
  onSaveStateChange?: (state: SaveState) => void;
  // A live document became read-only while it was open.
  onLiveReadOnly?: () => void;
  // Registers the active editor's draft flush with the shell: explorer ops
  // await it before re-pathing files.
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  knownMarkdownFiles?: ReadonlyArray<WikilinkFile>;
  onSharePath?: (path: string) => void;
  // This file is the entry of the app in `appFolder`: Run opens its preview.
  appFolder?: string | null;
  onRunApp?: (folder: string) => void;
  pendingUndo?: PendingFileUndo;
  onPendingUndoConsumed?: (token: number) => void;
  // Read-only shared views: every editable view refuses edits.
  readOnly?: boolean;
  // The file is a received share's: a shared view, or a mount in shared-with-me.
  receivedShare?: boolean;
  accessEnded?: boolean;
  // Capture holds this file's outside edit, and Try again asks it to retry.
  captureHeld?: boolean;
  onRetryHeldCapture?: (path: string) => void;
  // The engine holds a change to this lossy note until someone chooses Edit anyway.
  changeHeld?: boolean;
  // G2-C-3: a monotonic token that changes when the ACTIVE VERSION of this
  // workspace changes while the same file stays open (the shell's versionEpoch).
  // Threaded to the engine editor so a version switch re-binds it to the new
  // version's Y.Doc lineage. Distinct from refreshKey, which also bumps on
  // ordinary history growth (which must not reopen the live engine session).
  engineVersionKey?: number;
  // Signed-in collaboration for owner workspaces. Read-only shared views do
  // not open an engine session and never bind drawing presence.
  drawingCollaboration?: ExcalidrawPresenceFactory | null;
  // Registers the mounted markdown view's "view source" toggle with the shell
  // (command palette seam) — registerDraftFlush precedent.
  registerSourceToggle?: (toggle: (() => void) | null) => void;
  // Editor groups keep inactive inspectors mounted. They pass false so a
  // source editor mounting there cannot steal focus from the active group.
  autoFocus?: boolean;
  // Workspace-switch instrumentation waits for the restored active file to
  // finish its read and, when applicable, bind its live document session.
  surfaceKey?: string;
  onSurfaceReady?: (path: string, surfaceKey: string) => void;
  // A new page's file: its editor takes the keystrokes the page held, and
  // null says none will.
  onEditorReady?: (editor: PageEditor | null) => void;
};

function useRetainedLocalDocument(key: string): SharedLocalDocument {
  const [, retry] = useState(0);
  const buffer = getSharedLocalDocument(key);
  useLayoutEffect(() => {
    // React can yield after the render lookup. Acquire and retain again during
    // commit. If an unmounted writer replaced the entry, retry before paint.
    const acquired = acquireSharedLocalDocument(key);
    if (acquired.buffer !== buffer) {
      acquired.release();
      retry((revision) => revision + 1);
      return;
    }
    return acquired.release;
  }, [buffer, key]);
  return buffer;
}

// Memoized: the workspace shell re-renders on every lane commit (status,
// history, agent state), and this component's render alone re-runs classify,
// engine-open, and markdown wiring for the open document. The shell keeps
// every prop identity-stable, so an unrelated shell render bails here.
export const FileInspector = memo(function FileInspector(
  props: FileInspectorProps,
) {
  const key = documentVersionKey(
    props.workspaceId,
    props.path,
    props.engineVersionKey,
  );
  const currentDocument = useRef(key);
  currentDocument.current = key;
  const localBuffer = useRetainedLocalDocument(key);
  const fileKind = fileKindForPath(props.path);
  const kind = fileKind.displayKind;
  const isText = fileKind.opens.content === "text";
  const localBufferSnapshot = useSyncExternalStore(
    localBuffer.subscribe,
    localBuffer.getSnapshot,
    localBuffer.getSnapshot,
  );
  // Whether an unsaved draft is pending. Only MarkdownView knows (it owns the
  // draft), so it reports every render and this holds the answer before the
  // refusal arrives — which is the only way to have it, since the refusal
  // unmounts the reporter.
  const [pendingDraft, setPendingDraft] = useState(false);
  const {
    text,
    loadedPath,
    truncated,
    contentHash,
    contentRequestId,
    contentReadTicket,
    latestContentRequestId,
    error,
    readSeq,
    refreshAfterConflict,
    markReadInitialized,
  } = useTextContent(
    props.workspaceId,
    props.path,
    isText,
    props.refreshKey ?? 0,
    localBuffer,
  );
  const retriedFailedReadBuffer = useRef<SharedLocalDocument | null>(null);
  useEffect(() => {
    if (text !== null) {
      if (retriedFailedReadBuffer.current === localBuffer) {
        retriedFailedReadBuffer.current = null;
      }
      return;
    }
    if (
      !isText ||
      !error ||
      !localBufferSnapshot.initialized ||
      retriedFailedReadBuffer.current === localBuffer
    ) {
      return;
    }
    // A sibling pane can initialize the shared document after this pane's
    // cold read fails. Retry this pane once so it gets the complete read
    // metadata (including truncation) instead of staying on its error branch.
    retriedFailedReadBuffer.current = localBuffer;
    refreshAfterConflict();
  }, [
    error,
    isText,
    localBuffer,
    localBufferSnapshot.initialized,
    refreshAfterConflict,
    text,
  ]);
  const switchReadPending = useRef(false);
  useEffect(() => {
    // A version switch keeps the previous read visible until the replacement
    // answers. Do not seed the new version's shared buffer with that stale
    // body; the successful replacement read initializes it below instead.
    if (
      text === null ||
      loadedPath !== props.path ||
      switchReadPending.current
    ) {
      return;
    }
    localBuffer.initializeRead(text, contentHash, contentReadTicket);
    markReadInitialized(contentReadTicket);
  }, [
    contentHash,
    contentReadTicket,
    loadedPath,
    localBuffer,
    markReadInitialized,
    props.path,
    readSeq,
    text,
  ]);
  // THE ENGINE OPEN LIVES HERE, above every branch that swaps the body out.
  // It used to live in MarkdownView, which the loading/error branch below
  // unmounts — and a version switch that removes the file bumps refreshKey and
  // engineVersionKey together, so the reread ENOENTs before the queued open
  // answers. The child went with the branch, the refusal landed on nobody, and
  // the user was told "Couldn't read this file": true of the read, silent about
  // the version.
  //
  // `enabled` waits for the read to answer, so this opens no earlier than it
  // used to. A scene can open after a truncated read because the engine owns
  // the full artifact. It deliberately does not go false
  // when that answer is a failure: a failed reread is exactly when the refusal
  // is on its way, and dropping `enabled` would cancel the open that carries it.
  const readAnswered = text !== null || error;
  const liveDocumentKind = liveDocumentKindForPath(props.path);
  // "Try again" after an open that hit its retry deadline: part of the
  // hook's request key, so a retry is a fresh open under the same
  // stale-response guard as any other request change.
  const [engineRetryNonce, setEngineRetryNonce] = useState(0);
  const retryEngineOpen = useCallback(() => {
    setEngineRetryNonce((nonce) => nonce + 1);
  }, []);
  // A reload after a change outside dohc opens new bytes, so it is a new open
  // for the lossy-note check: it reads the file again, checks it, and asks
  // for Edit anyway again. A retry of the same open keeps both.
  const [reloads, setReloads] = useState(0);
  const reloadChangedOutside = useCallback(() => {
    setReloads((count) => count + 1);
    refreshAfterConflict();
    retryEngineOpen();
  }, [refreshAfterConflict, retryEngineOpen]);
  // A note opens an engine session only once its bytes are known not to be a
  // lossy note. Until then, and for a lossy note, the view shows the file's
  // text read-only, and the engine sees the note as closed. A failed read
  // holds too, unless a version switch still carries the last version's
  // verdict: only a checked note opens for editing.
  const checksLossyNote = kind === "markdown" && liveDocumentKind !== null && !props.readOnly;
  useEffect(() => {
    if (checksLossyNote) warmLossyNoteCheck();
  }, [checksLossyNote]);
  // One open of one version: a switch, a reload that bumps the version key,
  // or a reload after a change outside dohc checks its own read, and asks for
  // Edit anyway again.
  const lossyOpen = `${key}\u0000${reloads}`;
  // A note past read mode's size with no engine record gets no session and
  // edits as source, which writes what is typed. So its open goes first, and
  // only a session that binds waits for the check.
  const large = text !== null && exceedsUtf8Bytes(text, WYSIWYG_MARKDOWN_THRESHOLD_BYTES);
  const [bound, setBound] = useState(false);
  const checked = useLossyNote({
    open: lossyOpen,
    note: `${props.workspaceId}\u0000${props.path}`,
    applies: checksLossyNote && !truncated,
    waiting: large && !bound,
    markdown: loadedPath === props.path ? text : null,
    contentHash,
    readSeq,
  });
  // "Edit anyway" lasts for this open and covers the bytes the person
  // accepted saving would rewrite: the session seeded from them records them
  // as its source. A session that records another source, as when another
  // pane reloads a change made outside dohc into the shared session, needs
  // its own check and consent.
  const [editAnyway, setEditAnyway] = useState<{ open: string; source: string | null; headSha256: string | null | undefined } | null>(null);
  const [staleConsentRead, setStaleConsentRead] = useState<{ open: string; seq: number } | null>(null);
  const consented = editAnyway?.open === lossyOpen;
  // A session that binds a different note from the one checked, as when the
  // file changed before the open, closes once its own check says lossy. It
  // stays closed until a read brings other bytes; the session that then
  // opens is checked in turn.
  const [sessionLossy, setSessionLossy] = useState<{ open: string; hash: string | null } | null>(null);
  const sessionRefused = sessionLossy?.open === lossyOpen && (contentHash === null || sessionLossy.hash === contentHash);
  const allowed = consented ? "clear" : sessionRefused ? "lossy" : checked.state;
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled:
      liveDocumentKind !== null &&
      (kind === "markdown" || kind === "drawing") &&
      readAnswered &&
      (!truncated || liveDocumentKind === "scene") &&
      (large ? allowed !== "lossy" : allowed === "clear") &&
      !props.readOnly,
    kind: liveDocumentKind ?? undefined,
    allowLossySourceSha256: consented && editAnyway?.source ? editAnyway.source : undefined,
    reopenKey: props.engineVersionKey,
    retryKey: engineRetryNonce,
    accessEnded: props.accessEnded,
  });
  useEffect(() => setBound(engine.available), [engine.available]);
  const boundSource = engine.doc?.getMap("meta").get("dohcMarkdownSourceSha256");
  const editingAnyway = consented && (typeof boundSource !== "string" || boundSource === editAnyway.source)
    && (!engine.available || engine.headSha256 === editAnyway.headSha256);
  useEffect(() => {
    if (consented && !editingAnyway) {
      setEditAnyway(null);
      // The shared session has other bytes. Read them before asking again.
      setStaleConsentRead({ open: lossyOpen, seq: readSeq });
      refreshAfterConflict();
    }
  }, [consented, editingAnyway, lossyOpen, readSeq, refreshAfterConflict]);
  const session = useBoundNoteCheck({
    open: lossyOpen,
    // Edit anyway already accepted what saving does.
    doc: checksLossyNote && !editingAnyway ? engine.doc : null,
    headSha256: engine.headSha256,
  });
  useEffect(() => {
    if (session === "lossy") setSessionLossy({ open: lossyOpen, hash: contentHash });
  }, [session, lossyOpen, contentHash]);
  // The render a large note's session binds in, before its check starts,
  // waits too, as does a bound session while its own check runs.
  const rereadingConsent = staleConsentRead?.open === lossyOpen && staleConsentRead.seq === readSeq;
  const lossyNote = rereadingConsent ? "checking"
    : editingAnyway ? "clear"
    : session === "lossy" ? "lossy"
    : session === "checking" || (large && engine.available && !bound && allowed === "clear") ? "checking"
    : allowed;
  useAuthorCapacityNotice({
    workspaceId: props.workspaceId, path: props.path,
    authorCapacity: engine.authorCapacity, saveState: engine.saveState,
    reportError: props.onButtonError, retry: retryEngineOpen,
  });
  // Derived, never stored. #565 keys the hook's outcome to the request that
  // asked for it, so a refusal for the version the user just left cannot repaint
  // the one they just entered — which is what a sticky flag here used to risk.
  // DISCLOSED: a file that reappears in the same version (an agent recreates it)
  // leaves this notice up until the request changes. Reopening a daemon session
  // on every activity tick would churn the capture chain for no gain.
  const notInVersion = engine.notInVersion;
  // A version switch bumps engineVersionKey, and the reread it triggers leaves
  // the PRE-switch body on screen until it answers. Markdown has the engine
  // open to tell it so; the plain-text views have nothing, so this window is
  // where their autosave landed pre-switch text on the post-switch tree.
  // True from the switch until a reread
  // SUCCEEDS. A failure leaves the selected version unverified and writes
  // refused until a later read succeeds.
  // True from a reopenKey change until the child that owns this surface's
  // resync has actually applied it — not merely until the reread lands.
  // The parent only ever arms this. The resyncing child clears it, so writes
  // cannot unblock ahead of the content they would write.
  const switchUnresyncedRef = useRef(false);
  const seenVersionKey = useRef(props.engineVersionKey);
  const seenReadSeq = useRef(readSeq);
  if (seenVersionKey.current !== props.engineVersionKey) {
    seenVersionKey.current = props.engineVersionKey;
    seenReadSeq.current = readSeq;
    switchReadPending.current = true;
    switchUnresyncedRef.current = true;
  }
  if (switchReadPending.current && readSeq !== seenReadSeq.current && !error) {
    switchReadPending.current = false;
  }
  // Every parent-owned write refusal, including the pending switch reread,
  // is carried for a child that might never render it. Path-not-in-version
  //  and the failed read below replace the child in the commit that
  // learns of the state, so the child's own refs still hold the old value when
  // its unmount flush runs. A REF the PARENT assigns during render crosses
  // that gap: the object identity is stable, so even the child's first-render
  // closures read the live value.
  const writesRefusedRef = useRef(false);
  writesRefusedRef.current =
    notInVersion ||
    engine.documentUnavailable ||
    engine.liveHostUnavailable ||
    engine.opening ||
    lossyNote !== "clear" ||
    engine.engineMayHoldDocument ||
    engine.artifactAssetsInvalid ||
    switchUnresyncedRef.current ||
    engine.deletedWhileEditing ||
    engine.readOnlyWhileEditing ||
    engine.permanentFailureWhileEditing ||
    engine.removalInProgress !== null;
  const pendingTextUndo =
    props.pendingUndo?.path === props.path &&
    text === props.pendingUndo.restoredText
      ? {
          token: props.pendingUndo.token,
          restoredText: props.pendingUndo.restoredText,
          undoText: props.pendingUndo.undoText,
        }
      : undefined;
  // An engine document that BOUND does not need the file read: the canonical
  // Y.Doc is the content, and main holds the live session. Without this, a
  // read that failed before a successful retry left the user at "Couldn't
  // read this file." with no document and no way back, while the session it
  // describes was live.
  const engineDocBound = engine.available && engine.doc !== null;
  // Consume the jump after the child view's own effects applied it (child
  // effects run before this parent effect). Text views wait for the loaded
  // text; every other kind has nowhere to land, so consume immediately.
  //
  // A bound Y.Doc counts as the text, because it IS the document: the branch
  // below is bypassed and this commit shows the user everything it is ever
  // going to show for this jump. Asking only about disk text left the jump
  // pending on the one path that has none, and the shell replayed it on a
  // later open of that path.
  const { scrollTarget, onScrollConsumed } = props;
  const textReady =
    !isText || engineDocBound || (text !== null && loadedPath === props.path);
  const activeSurfaceReady = textReady && !engine.opening && lossyNote !== "checking";
  useEffect(() => {
    if (!activeSurfaceReady || !props.surfaceKey) return;
    props.onSurfaceReady?.(props.path, props.surfaceKey);
  }, [activeSurfaceReady, props.onSurfaceReady, props.path, props.surfaceKey]);
  useEffect(() => {
    if (scrollTarget && scrollTarget.path === props.path && textReady) {
      onScrollConsumed?.(scrollTarget.nonce);
    }
  }, [scrollTarget, props.path, textReady, onScrollConsumed]);
  // A failed read of a note still waiting for its check shows the failure,
  // even over an earlier text: that note opens only once a read checks it.
  const readFailedUnchecked = error && lossyNote === "checking";
  const reading = isText && !engineDocBound && (text === null || loadedPath !== props.path || readFailedUnchecked);
  // A new page waiting on this file hears when no document opens here to
  // take what was typed; MarkdownView answers for one that does.
  const { onEditorReady } = props;
  const noDocument = notInVersion || engine.documentUnavailable || (reading && error);
  useEffect(() => {
    if (noDocument) onEditorReady?.(null);
  }, [noDocument, onEditorReady]);
  const url = assetUrl(props.workspaceId, props.path, props.refreshKey ?? 0);
  const truncatedNotice =
    isText && truncated ? (
      <TruncatedNotice workspaceId={props.workspaceId} path={props.path} onError={props.onButtonError} />
    ) : null;
  const onShareCurrentPath = props.onSharePath
    ? () => props.onSharePath?.(props.path)
    : undefined;
  const { appFolder, onRunApp } = props;
  const runApp = appFolder && onRunApp ? () => onRunApp(appFolder) : undefined;
  // Recovery follows the PATH, not the file kind: an
  // extension-changing rename remaps a markdown draft onto a text/CSV/binary
  // view, and Copy/Dismiss must exist wherever the marker shows. The markdown
  // branch renders its own copy inside its header layout.
  const recoveryNotices = (
    <OrphanedDraftNotices
      workspaceId={props.workspaceId}
      path={props.path}
      message={
        kind === "drawing" && engine.recoveryAssets?.state === "loading"
          ? `dohc is adding ${engine.recoveryAssets.count} ${engine.recoveryAssets.count === 1 ? "image" : "images"} to your set-aside drawing. Wait before you copy it.`
          : kind === "drawing" && engine.recoveryAssets?.state === "missing"
            ? `dohc could not recover ${engine.recoveryAssets.count} ${engine.recoveryAssets.count === 1 ? "image" : "images"}. Copy your set-aside drawing to keep the rest.`
            : kind === "drawing" && engine.goneCause === "object-changed"
              ? "Another file replaced this drawing while you had it open. Copy your set-aside drawing to keep it."
              : kind === "drawing" && engine.deletedWhileEditing
              ? "This drawing was deleted. Copy your set-aside drawing to keep it."
              : kind === "drawing" && engine.permanentFailureWhileEditing
                ? "dohc could not save this drawing. Copy your set-aside drawing to keep it."
                : kind === "drawing" && engine.readOnlyWhileEditing
                  ? "This drawing became read-only before your edit saved. Copy your set-aside drawing to keep it."
          : engine.readOnlyWhileEditing
            ? "This document became read-only before your edit saved. Copy your text to keep it."
            : undefined
      }
      replacedDraftIds={engine.replacedDraftIds}
    />
  );

  // A document's controls stand where they will be when it opens, from the
  // click frame: disabled as the opening view's are while it loads, and
  // disabled when it cannot open, so nothing in the header moves between
  // loading, ready and failed.
  const closedDocumentControls = (opening: boolean) =>
    kind === "markdown" ? (
      <DocumentControls
        toggle={{ label: "Edit", disabled: true, title: opening ? OPENING_TITLE : undefined }}
        menu={{
          workspaceId: props.workspaceId,
          reportError: props.onButtonError,
          suggestedName: filenameStem(props.path),
          getMarkdown: () => null,
          disabled: !opening,
        }}
      />
    ) : kind === "csv" ? (
      <CsvControls mode="table" importable={props.onOpenPath !== undefined} disabled />
    ) : undefined;

  if (notInVersion) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewActions
          onShare={onShareCurrentPath}
          actions={closedDocumentControls(false)}
        />
        {/* A reopen's set-aside drafts survive this refusal in the
            module store — recovery stays visible right here, not behind a
            version switch. */}
        {recoveryNotices}
        <EmptyState
          data-testid="file-not-in-version"
          icon={Layers}
          title={
            <>
              This version doesn&apos;t have this file.{" "}
              {pendingDraft ? (
                <span data-testid="file-not-in-version-discarded">
                  dohc discarded your unsaved edit.{" "}
                </span>
              ) : null}
              Switch to the version that has it.
            </>
          }
        />
      </div>
    );
  }

  if (engine.documentUnavailable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewActions
          onShare={onShareCurrentPath}
          actions={closedDocumentControls(false)}
        />
        {recoveryNotices}
        <EmptyState data-testid="file-unavailable" title="This file is no longer available at this path.">
          <SecondaryButton onClick={retryEngineOpen}>Try again</SecondaryButton>
        </EmptyState>
      </div>
    );
  }

  if (reading) {
    // Keep the inspector frame mounted while loading/erroring so the surface
    // is stable (and testable) rather than flickering between containers.
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewActions
          onShare={onShareCurrentPath}
          onRun={runApp}
          actions={closedDocumentControls(!error)}
        />
        {engine.engineMayHoldDocument ? (
          // A failed read returns here, before
          // MarkdownView mounts — without this the timeout had no notice and
          // no retry on exactly the path where the engine session is the only
          // way back to the content.
          <EngineMayHoldDocumentNotice onRetry={retryEngineOpen} contentShown={false} message={engine.openRefusal ?? engine.sharedWaiting?.message} />
        ) : null}
        {engine.artifactAssetsInvalid ? (
          <EngineArtifactAssetsInvalidNotice
            workspaceId={props.workspaceId}
            path={props.path}
            onError={props.onButtonError}
          />
        ) : null}
        {engine.removalInProgress ? (
          <EngineRemovalInProgressNotice
            removal={engine.removalInProgress}
            onRetry={retryEngineOpen}
          />
        ) : null}
        {/* A failed read is exactly when the set-aside text matters most —
            the marker and the close warning must not point at actions this
            branch withholds. */}
        {recoveryNotices}
        {error ? (
          <EmptyState icon={TriangleAlert} tone="danger" title="Couldn't read this file.">
            {/* A note opens only once a read checks it, so reading again is its way back. */}
            {checksLossyNote ? (
              <SecondaryButton data-testid="file-read-retry" onClick={refreshAfterConflict}>Try again</SecondaryButton>
            ) : null}
          </EmptyState>
        ) : kind === "markdown" ? (
          // Where the title and the first lines land when the document opens:
          // in a pane that keeps its scrollbar's room, as the document's does.
          <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
            <SkeletonRows layout="document" label="Loading…" className="pt-12" />
          </div>
        ) : (
          <SkeletonRows layout="panel" label="Loading…" />
        )}
      </div>
    );
  }

  switch (kind) {
    case "markdown":
      // MarkdownView renders its ViewActions itself: the edit toggle and save
      // state sit with Share in the tab row.
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <MarkdownView
            body={text ?? ""}
            contentHash={contentHash}
            contentRequestId={contentRequestId}
            contentReadTicket={contentReadTicket}
            latestContentRequestId={latestContentRequestId}
            refreshAfterConflict={refreshAfterConflict}
            workspaceId={props.workspaceId}
            path={props.path}
            documentKey={key}
            fileOpenStartMark={props.fileOpenStartMark ?? "file-open-start"}
            truncated={truncated}
            truncatedNotice={truncatedNotice}
            scrollTarget={props.scrollTarget}
            headingTarget={props.headingTarget}
            onOpenPath={props.onOpenPath}
            onSharePath={props.onSharePath}
            onSaveStateChange={props.onSaveStateChange}
            onLiveReadOnly={props.onLiveReadOnly}
            registerDraftFlush={props.registerDraftFlush}
            knownFiles={props.knownMarkdownFiles}
            pendingUndo={pendingTextUndo}
            onPendingUndoConsumed={props.onPendingUndoConsumed}
            forceReadOnly={props.readOnly}
            reopenKey={props.engineVersionKey}
            switchReadPending={switchReadPending.current}
            switchUnresyncedRef={switchUnresyncedRef}
            registerSourceToggle={props.registerSourceToggle}
            autoFocus={props.autoFocus}
            onPendingDraftChange={setPendingDraft}
            onButtonError={props.onButtonError}
            onButtonNotice={props.onButtonNotice}
            onOpenRecordHistory={props.onOpenRecordHistory}
            engine={engine}
            lossyNote={lossyNote}
            changeHeld={props.changeHeld}
            onEditAnyway={() => {
              const source = typeof boundSource === "string" ? boundSource : contentHash;
              setEditAnyway({ open: lossyOpen, source, headSha256: engine.available ? engine.headSha256 : contentHash });
              if (engine.available && source) {
                void bridge().retryEngineYDocSave({ workspaceId: props.workspaceId, path: props.path,
                  allowLossySourceSha256: source }).catch((error: unknown) => {
                  if (currentDocument.current === key) props.onButtonError?.(lossyNoteRefusal(props.path), error, retryEngineOpen);
                });
              }
            }}
            onRetryHeldCapture={props.captureHeld && props.onRetryHeldCapture ? () => props.onRetryHeldCapture?.(props.path) : undefined}
            onRetryEngineOpen={retryEngineOpen}
            onReloadChangedOutside={reloadChangedOutside}
            writesRefusedRef={writesRefusedRef}
            localBuffer={localBuffer}
            onEditorReady={props.onEditorReady}
          />
        </div>
      );
    case "drawing":
      return (
        <DrawingView
          body={text ?? ""}
          contentHash={contentHash}
          contentRequestId={contentRequestId}
          contentReadTicket={contentReadTicket}
          latestContentRequestId={latestContentRequestId}
          refreshAfterConflict={refreshAfterConflict}
          workspaceId={props.workspaceId}
          path={props.path}
          readOnly={!!props.readOnly}
          autoFocus={props.autoFocus}
          truncated={truncated}
          reopenKey={props.engineVersionKey}
          switchReadPending={switchReadPending.current}
          switchUnresyncedRef={switchUnresyncedRef}
          onSaveStateChange={props.onSaveStateChange}
          registerDraftFlush={props.registerDraftFlush}
          onShare={onShareCurrentPath}
          notice={truncatedNotice}
          recoveryNotices={recoveryNotices}
          engine={engine}
          onRetryEngineOpen={retryEngineOpen}
          presenceFactory={props.drawingCollaboration}
          localBuffer={localBuffer}
          onButtonError={props.onButtonError}
        />
      );
    case "csv":
      return (
        // CsvView and TextEditorView render their ViewActions themselves: the
        // save state and the view's controls sit with Share in the tab row.
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          {truncatedNotice}
          {recoveryNotices}
          <CsvView
            body={text ?? ""}
            contentHash={contentHash}
            contentRequestId={contentRequestId}
            contentReadTicket={contentReadTicket}
            latestContentRequestId={latestContentRequestId}
            refreshAfterConflict={refreshAfterConflict}
            workspaceId={props.workspaceId}
            path={props.path}
            onOpenPath={props.onOpenPath}
            truncated={truncated}
            readOnly={!!props.readOnly}
            reopenKey={props.engineVersionKey}
            switchReadPending={switchReadPending.current}
            switchUnresyncedRef={switchUnresyncedRef}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
            localBuffer={localBuffer}
            csvSource={props.receivedShare ? "received-share" : "workspace-file"}
            onShare={onShareCurrentPath}
            onError={props.onButtonError}
            onNotice={props.onButtonNotice}
            onClosePath={props.onClosePath}
          />
        </div>
      );
    case "json":
    case "text":
    case "code":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          {truncatedNotice}
          {recoveryNotices}
          <TextEditorView
            body={text ?? ""}
            contentHash={contentHash}
            contentRequestId={contentRequestId}
            contentReadTicket={contentReadTicket}
            latestContentRequestId={latestContentRequestId}
            refreshAfterConflict={refreshAfterConflict}
            testId={kind === "json" ? "view-json" : "view-text"}
            language={kind === "json" ? "json" : extensionOf(props.path) || "text"}
            workspaceId={props.workspaceId}
            path={props.path}
            truncated={truncated}
            readOnly={!!props.readOnly}
            reopenKey={props.engineVersionKey}
            switchReadPending={switchReadPending.current}
            switchUnresyncedRef={switchUnresyncedRef}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
            scrollLine={
              props.scrollTarget?.path === props.path
                ? props.scrollTarget.line
                : undefined
            }
            pendingUndo={pendingTextUndo}
            onPendingUndoConsumed={props.onPendingUndoConsumed}
            localBuffer={localBuffer}
            onShare={onShareCurrentPath}
            onRun={runApp}
          />
        </div>
      );
    case "image":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewActions onShare={onShareCurrentPath} />
          {recoveryNotices}
          <ImageView url={url} path={props.path} />
        </div>
      );
    case "audio":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewActions onShare={onShareCurrentPath} />
          {recoveryNotices}
          <div className="flex flex-1 items-center justify-center p-4">
            <audio data-testid="view-audio" controls src={url} />
          </div>
        </div>
      );
    case "pdf":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewActions onShare={onShareCurrentPath} />
          {recoveryNotices}
          <EmptyState data-testid="view-pdf" title="dohc can't preview PDF files.">
            <OpenExternallyButton workspaceId={props.workspaceId} path={props.path} onError={props.onButtonError} />
          </EmptyState>
        </div>
      );
    case "database":
      return (
        <>
          {recoveryNotices}
          {/* The view opens its database under the same header, in the
              place these lines stand, so its own lines take over. */}
          <SkeletonSlot>
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
                <ViewActions onShare={onShareCurrentPath} />
                <SkeletonRows inSlot layout="panel" label="Loading database…" />
              </div>
            }
          >
            <LazyDatabaseStudioView
              workspaceId={props.workspaceId}
              path={props.path}
              fileOpenStartMark={props.fileOpenStartMark}
              refreshKey={props.refreshKey}
              onSharePath={props.onSharePath}
              readOnly={props.readOnly}
              onError={props.onButtonError}
            />
          </Suspense>
          </SkeletonSlot>
        </>
      );
    default:
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewActions onShare={onShareCurrentPath} />
          {recoveryNotices}
          <EmptyState data-testid="view-binary" title="dohc can't preview this type of file.">
            <OpenExternallyButton workspaceId={props.workspaceId} path={props.path} onError={props.onButtonError} />
          </EmptyState>
        </div>
      );
  }
});
