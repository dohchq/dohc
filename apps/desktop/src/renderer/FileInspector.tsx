import { MarkdownView, type HeadingTarget, type ScrollTarget } from "./MarkdownView";
import { DrawingView } from "./DrawingView";
import {
  AffordanceCard,
  EngineArtifactAssetsInvalidNotice,
  EngineMayHoldDocumentNotice,
  ViewHeader,
  type FileSaveState,
  OrphanedDraftNotices,
  EngineRemovalInProgressNotice,
} from "./fileInspectorUi";
import { TextEditorView } from "./TextEditorView";
import type { PendingFileUndo } from "./fileEditorUndo";
import { CsvView } from "./CsvView";
import { ImageView } from "./ImageView";
import { extensionOf } from "./path";
import type { DraftFlush } from "./useAutosavedTextDraft";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import {
  FileText,
  Image as ImageIcon,
  Music,
  Table,
} from "lucide-react";
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
import type { ChatFileMentionRecord } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { useEngineDoc } from "./collab/useEngineDoc";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import { SecondaryButton } from "./ui/controls";
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

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "wav", "ogg"]);
const DB_EXT = new Set(["sqlite", "sqlite3", "db"]);
const TABLE_EXT = new Set(["csv", "tsv", "tab"]);
const TEXT_EXT = new Set([
  "md",
  "markdown",
  "txt",
  "json",
  "html",
  "htm",
  "xml",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "log",
  "sql",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
]);

const LazyDatabaseStudioView = lazy(() =>
  import("./DatabaseStudioView").then((mod) => ({
    default: mod.DatabaseStudioView,
  })),
);

type FileViewKind =
  | "markdown"
  | "drawing"
  | "csv"
  | "json"
  | "text"
  | "image"
  | "audio"
  | "pdf"
  | "database"
  | "binary";

// Pure classifier: every file resolves to exactly one view kind. Exported so
// the E2E and unit tests pin the dispatch table directly.
export function classifyForView(path: string): FileViewKind {
  const ext = extensionOf(path);
  if (liveDocumentKindForPath(path) === "richdoc") return "markdown";
  if (ext === "excalidraw") return "drawing";
  if (TABLE_EXT.has(ext)) return "csv";
  if (ext === "json") return "json";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (DB_EXT.has(ext)) return "database";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-subtle">
      {children}
    </div>
  );
}

function TruncatedNotice(props: { workspaceId: string; path: string }) {
  return (
    <div
      data-testid="truncated-notice"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      <span>Showing the start of a large file.</span>
      <button
        type="button"
        onClick={() =>
          void bridge().openFileExternally({
            workspaceId: props.workspaceId,
            relativePath: props.path,
          })
        }
        className="text-subtle hover:text-ink"
      >
        Open the full file externally
      </button>
    </div>
  );
}

type FileInspectorProps = {
  workspaceId: string;
  path: string;
  fileOpenStartMark?: string;
  refreshKey?: number;
  onOpenPath?: (path: string, headingTarget?: HeadingTarget) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
  // Whether this workspace has the capture Chats calls need. The
  // linked-mentions panel asks main for chat mentions, which goes through
  // requireEngineCapture — so a shared view must not ask. Same name and same
  // fact GraphView's chat-mentions toggle reads.
  chatMentionsAvailable?: boolean;
  // A pending search-result jump. Consumed (onScrollConsumed)
  // once a mounted view applied it, so plain re-opens never re-jump.
  scrollTarget?: ScrollTarget;
  // A pending file/section mention or fragment-link jump. Unlike a search
  // target this stays in the rich editor and lands on the rendered heading.
  headingTarget?: HeadingTarget;
  onScrollConsumed?: (nonce: number) => void;
  // Editor save-state seam for the tab strip's dirty indicator. Editable
  // source/table/document views all report through the same small contract.
  onSaveStateChange?: (state: FileSaveState) => void;
  // Registers the active editor's draft flush with the shell: explorer ops
  // await it before re-pathing files.
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  knownMarkdownFiles?: ReadonlyArray<WikilinkFile>;
  onSharePath?: (path: string) => void;
  pendingUndo?: PendingFileUndo;
  onPendingUndoConsumed?: (token: number) => void;
  // Read-only shared views: every editable view refuses edits.
  readOnly?: boolean;
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
  const localBuffer = useRetainedLocalDocument(key);
  const kind = classifyForView(props.path);
  const isText =
    kind === "markdown" ||
    kind === "drawing" ||
    kind === "csv" ||
    kind === "json" ||
    kind === "text";
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
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled:
      liveDocumentKind !== null &&
      (kind === "markdown" || kind === "drawing") &&
      readAnswered &&
      (!truncated || liveDocumentKind === "scene") &&
      !props.readOnly,
    kind: liveDocumentKind ?? undefined,
    reopenKey: props.engineVersionKey,
    retryKey: engineRetryNonce,
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
  const activeSurfaceReady = textReady && !engine.opening;
  useEffect(() => {
    if (!activeSurfaceReady || !props.surfaceKey) return;
    props.onSurfaceReady?.(props.path, props.surfaceKey);
  }, [activeSurfaceReady, props.onSurfaceReady, props.path, props.surfaceKey]);
  useEffect(() => {
    if (scrollTarget && scrollTarget.path === props.path && textReady) {
      onScrollConsumed?.(scrollTarget.nonce);
    }
  }, [scrollTarget, props.path, textReady, onScrollConsumed]);
  const url = assetUrl(props.workspaceId, props.path, props.refreshKey ?? 0);
  const truncatedNotice =
    isText && truncated ? (
      <TruncatedNotice workspaceId={props.workspaceId} path={props.path} />
    ) : null;
  const onShareCurrentPath = props.onSharePath
    ? () => props.onSharePath?.(props.path)
    : undefined;
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
    />
  );

  if (notInVersion) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewHeader
          icon={<FileText size={13} aria-hidden />}
          path={props.path}
          label="file"
          onShare={onShareCurrentPath}
        />
        {/* A reopen's set-aside drafts survive this refusal in the
            module store — recovery stays visible right here, not behind a
            version switch. */}
        {recoveryNotices}
        <div
          data-testid="file-not-in-version"
          className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-subtle"
        >
          <span>This version doesn&apos;t have this file.</span>
          {pendingDraft ? (
            <span data-testid="file-not-in-version-discarded">
              dohc discarded your unsaved edit.
            </span>
          ) : null}
          <span>Switch to the version that has it.</span>
        </div>
      </div>
    );
  }

  if (engine.documentUnavailable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewHeader
          icon={<FileText size={13} aria-hidden />}
          path={props.path}
          label="file"
          onShare={onShareCurrentPath}
        />
        {recoveryNotices}
        <div
          data-testid="file-unavailable"
          className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center text-sm text-muted"
        >
          <span>This file is no longer available at this path.</span>
          <SecondaryButton className="mt-1" onClick={retryEngineOpen}>
            Try again
          </SecondaryButton>
        </div>
      </div>
    );
  }

  if (isText && !engineDocBound && (text === null || loadedPath !== props.path)) {
    // Keep the inspector frame mounted while loading/erroring so the surface
    // is stable (and testable) rather than flickering between containers.
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewHeader
          icon={<FileText size={13} aria-hidden />}
          path={props.path}
          label="file"
          onShare={onShareCurrentPath}
        />
        {engine.engineMayHoldDocument ? (
          // A failed read returns here, before
          // MarkdownView mounts — without this the timeout had no notice and
          // no retry on exactly the path where the engine session is the only
          // way back to the content.
          <EngineMayHoldDocumentNotice onRetry={retryEngineOpen} contentShown={false} />
        ) : null}
        {engine.artifactAssetsInvalid ? (
          <EngineArtifactAssetsInvalidNotice
            workspaceId={props.workspaceId}
            path={props.path}
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
        <Empty>{error ? "Couldn't read this file." : "Loading…"}</Empty>
      </div>
    );
  }

  switch (kind) {
    case "markdown":
      // MarkdownView renders the ViewHeader itself: the edit toggle and save
      // state live IN the document header (one bar, not two).
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
            onOpenChatMention={props.onOpenChatMention}
            chatMentionsAvailable={props.chatMentionsAvailable}
            onSharePath={props.onSharePath}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
            knownFiles={props.knownMarkdownFiles}
            pendingUndo={pendingTextUndo}
            onPendingUndoConsumed={props.onPendingUndoConsumed}
            forceReadOnly={props.readOnly}
            reopenKey={props.engineVersionKey}
            switchReadPending={switchReadPending.current}
            switchUnresyncedRef={switchUnresyncedRef}
            refreshKey={props.refreshKey}
            registerSourceToggle={props.registerSourceToggle}
            autoFocus={props.autoFocus}
            onPendingDraftChange={setPendingDraft}
            engine={engine}
            onRetryEngineOpen={retryEngineOpen}
            writesRefusedRef={writesRefusedRef}
            localBuffer={localBuffer}
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
        />
      );
    case "csv":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader
            icon={<Table size={13} aria-hidden />}
            path={props.path}
            label="data"
            onShare={onShareCurrentPath}
          />
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
            truncated={truncated || !!props.readOnly}
            reopenKey={props.engineVersionKey}
            switchReadPending={switchReadPending.current}
            switchUnresyncedRef={switchUnresyncedRef}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
            localBuffer={localBuffer}
          />
        </div>
      );
    case "json":
    case "text":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader
            icon={<FileText size={13} aria-hidden />}
            path={props.path}
            label={kind === "json" ? "json" : "text"}
            onShare={onShareCurrentPath}
          />
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
            truncated={truncated || !!props.readOnly}
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
          />
        </div>
      );
    case "image":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader
            icon={<ImageIcon size={13} aria-hidden />}
            path={props.path}
            label="image"
            onShare={onShareCurrentPath}
          />
          {recoveryNotices}
          <ImageView url={url} path={props.path} />
        </div>
      );
    case "audio":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader
            icon={<Music size={13} aria-hidden />}
            path={props.path}
            label="audio"
            onShare={onShareCurrentPath}
          />
          {recoveryNotices}
          <div className="flex flex-1 items-center justify-center p-4">
            <audio data-testid="view-audio" controls src={url} />
          </div>
        </div>
      );
    case "pdf":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader
            icon={<FileText size={13} aria-hidden />}
            path={props.path}
            label="pdf"
            onShare={onShareCurrentPath}
          />
          {recoveryNotices}
          <AffordanceCard
            testId="view-pdf"
            title="PDF document"
            body="Open this PDF in your system viewer."
            openExternally={{ workspaceId: props.workspaceId, path: props.path }}
          />
        </div>
      );
    case "database":
      return (
        <>
          {recoveryNotices}
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
                <ViewHeader
                  icon={<FileText size={13} aria-hidden />}
                  path={props.path}
                  label="database"
                  onShare={onShareCurrentPath}
                />
                <Empty>Loading database…</Empty>
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
            />
          </Suspense>
        </>
      );
    default:
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader
            icon={<FileText size={13} aria-hidden />}
            path={props.path}
            label="file"
            onShare={onShareCurrentPath}
          />
          {recoveryNotices}
          <AffordanceCard
            testId="view-binary"
            title="File"
            body="This file type doesn't have a preview yet."
            openExternally={{ workspaceId: props.workspaceId, path: props.path }}
          />
        </div>
      );
  }
});
