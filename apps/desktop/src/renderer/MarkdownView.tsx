import { registerPendingEditorDraft } from "./pendingEditorDrafts";
import {
  DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE,
  ENGINE_CHIP,
  EngineMayHoldDocumentNotice,
  READ_ONLY_TRANSITION_CHIP,
  ViewHeader,
  type FileSaveState,
  OrphanedDraftNotices,
  EngineRemovalInProgressNotice,
} from "./fileInspectorUi";
import { LazySourceCodeEditor } from "./LazySourceCodeEditor";
import type { PendingTextUndo } from "./fileEditorUndo";
import {
  AUTOSAVE_DEBOUNCE_MS,
  publishOwnedUnmountDraft,
  type DraftFlush,
  type SaveState,
} from "./useAutosavedTextDraft";
import { resolveWikilinkNavigation, resolveWorkspaceLinkNavigation } from "./wikilinkNavigation";
import { CopyButton } from "./ui/CopyButton";
import { FileText } from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ForwardRefExoticComponent,
  type LazyExoticComponent,
  type RefAttributes,
} from "react";
import type * as Y from "yjs";
import type { ChatFileMentionRecord } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";
import type { UseEngineDoc } from "./collab/useEngineDoc";
import {
  frontmatterBlockFor,
  writtenFrontmatterKeys,
} from "@dohc/ydoc-projection/frontmatter";
import {
  applyFrontmatter,
  orderFrontmatter,
  parseFrontmatter,
} from "./markdown/frontmatter";
import type {
  BlockNavigationTarget,
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from "./editor/MarkdownEditor";
import type { WorkspaceLinkTarget } from "./linkActivation";
import { blockTargetForLine } from "./editor/intraBlock";
import type { HeadingNavigationTarget } from "./editor/OutlinePanel";
import type { PropertiesPanelProps } from "./PropertiesPanel";
import { PageIdentity } from "./PageIdentity";
import { FrontmatterComments } from "./FrontmatterComments";
import { captureOrphanedDraft, useOrphanedDrafts } from "./orphanedDrafts";
import { BacklinksPanel } from "./BacklinksPanel";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import { DocumentMenu } from "./DocumentMenu";
import { EditorErrorBoundary } from "./editor/EditorErrorBoundary";
import { extractWorkspaceHeadings, resolveWorkspaceHeadingAnchorTarget } from "../workspaces/workspaceHeadings";
import type { SharedLocalDocument } from "./sharedLocalDocument";
import { LazyMarkdownReadView } from "./markdown/LazyMarkdownReadView";
import { useAuthoritativeValueRevision } from "./useAuthoritativeValueRevision";

const EMPTY_WIKILINK_FILES: ReadonlyArray<WikilinkFile> = [];

// The engine Y.Doc frontmatter map field name — the same key PageIdentity and
// PropertiesPanel use for title, icon, and properties. Read it directly so
// engine-mode export/copy reflects live frontmatter edits.
const ENGINE_FRONTMATTER_FIELD = "frontmatter";

// The filename without its directory or extension — the Notion-style empty
// title placeholder ("2026-plan.md" -> "2026-plan").
function filenameStem(path: string): string {
  const slash = path.lastIndexOf("/");
  const leaf = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

// A search result landing in the editor. nonce distinguishes
// repeated jumps to the same path+line; the shell clears the target once a
// mounted view consumed it, so later plain opens of the same file never
// re-trigger the jump.
export interface ScrollTarget {
  path: string;
  line: number;
  nonce: number;
}

export type HeadingTarget = HeadingNavigationTarget;

// Source is a read-only projection of the live Y.Doc. Coalesce update bursts
// without starving a source view that stays visible during sustained edits.
const SOURCE_VIEW_UPDATE_DELAY_MS = 150;

const SOURCE_VIEW_UPDATE_MAX_WAIT_MS = 500;

const WYSIWYG_MARKDOWN_THRESHOLD_BYTES = 64 * 1024;

const RAW_FRONTMATTER_RE =
  /^(---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?)([\s\S]*)$/;

type MarkdownEditorComponent = ForwardRefExoticComponent<
  MarkdownEditorProps & RefAttributes<MarkdownEditorHandle>
>;

let markdownEditorPromise: Promise<{ default: MarkdownEditorComponent }> | null = null;

function loadMarkdownEditor(): Promise<{ default: MarkdownEditorComponent }> {
  markdownEditorPromise ??= import("./editor/MarkdownEditor").then((mod) => ({
    default: mod.MarkdownEditor as MarkdownEditorComponent,
  }));
  return markdownEditorPromise;
}

export function preloadMarkdownEditor(): void {
  void loadMarkdownEditor();
}

const LazyMarkdownEditor = lazy(loadMarkdownEditor) as unknown as LazyExoticComponent<
  MarkdownEditorComponent
>;

const LazyPropertiesPanel = lazy(() =>
  import("./PropertiesPanel").then((mod) => ({
    default: mod.PropertiesPanel,
  })),
) as LazyExoticComponent<(props: PropertiesPanelProps) => React.ReactElement>;

// The source view needs editor/import-export only on demand. Cache the module
// after the first toggle so later toggles reuse it.
let importExportPromise: Promise<typeof import("./editor/import-export")> | null = null;

function loadImportExport(): Promise<typeof import("./editor/import-export")> {
  importExportPromise ??= import("./editor/import-export");
  return importExportPromise;
}

function splitRawFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = RAW_FRONTMATTER_RE.exec(markdown);
  if (!match) return { frontmatter: null, body: markdown };
  const parsed = parseFrontmatter(markdown);
  if (parsed.body === markdown) {
    return { frontmatter: null, body: markdown };
  }
  return { frontmatter: match[1] ?? "", body: parsed.body };
}

export function markdownEditorBody(markdown: string): string {
  return splitRawFrontmatter(markdown).body;
}

/** Lines of frontmatter above the editor body. Search numbers its lines
 *  against the FILE; the editor and the block mapping both count from the
 *  body, and this is the offset between them. */
function frontmatterLineCount(markdown: string): number {
  const body = markdownEditorBody(markdown);
  return (markdown.slice(0, markdown.length - body.length).match(/\n/g) ?? [])
    .length;
}

export function mergeMarkdownEditorBody(sourceMarkdown: string, body: string): string {
  const split = splitRawFrontmatter(sourceMarkdown);
  if (!split.frontmatter) return body;
  const separator = split.body.startsWith("\n") && !body.startsWith("\n") ? "\n" : "";
  return `${split.frontmatter}${separator}${body}`;
}

// The restore half of the cancel-and-restore: one row per set-aside
// draft, oldest first, because a second reopen must not cost the first draft
// its row. Self-contained on the module store, so every
// surface where the keyed document view dies — the editor branches and the
// not-in-version refusal — can show the same recovery.
const DELETED_WITH_SET_ASIDE_EDIT_NOTICE =
  "This file was deleted while you had it open. Copy your set-aside edit to keep it.";

function DeletedWhileEditingNotice(props: { hasSetAsideEdit: boolean }) {
  return (
    <div
      data-testid="deleted-while-editing-notice"
      className="border-b border-line bg-panel px-4 py-1 text-[11px] text-danger"
    >
      {props.hasSetAsideEdit
        ? DELETED_WITH_SET_ASIDE_EDIT_NOTICE
        : DELETED_WITHOUT_SET_ASIDE_EDIT_NOTICE}
    </div>
  );
}

function PropertiesFallback() {
  return (
    <div className="dohc-page-properties">
      <div className="dohc-page-properties__inner text-[11px] text-subtle">
        Loading properties...
      </div>
    </div>
  );
}

function MarkdownRenderCommitted(props: { onRendered: () => void }) {
  useEffect(() => props.onRendered(), [props.onRendered]);
  return null;
}

export function MarkdownView(props: {
  body: string;
  contentHash: string | null;
  contentRequestId: number;
  contentReadTicket: number;
  latestContentRequestId: number;
  refreshAfterConflict: () => void;
  workspaceId: string;
  path: string;
  documentKey: string;
  fileOpenStartMark: string;
  truncated?: boolean;
  truncatedNotice?: React.ReactNode;
  // A pending search-result jump for this path.
  scrollTarget?: ScrollTarget;
  headingTarget?: HeadingTarget;
  onOpenPath?: (path: string, headingTarget?: HeadingTarget) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
  chatMentionsAvailable?: boolean;
  onSharePath?: (path: string) => void;
  onSaveStateChange?: (state: FileSaveState) => void;
  registerDraftFlush?: (flush: DraftFlush | null) => void;
  knownFiles?: ReadonlyArray<WikilinkFile>;
  pendingUndo?: PendingTextUndo;
  onPendingUndoConsumed?: (token: number) => void;
  // Read-only shared views: editing is disabled regardless of size,
  // and live collab never activates.
  forceReadOnly?: boolean;
  // G2-C-3 version-switch re-bind token (the shell's versionEpoch), forwarded
  // to useEngineDoc so switching the active version reopens the engine session
  // against the new version's lineage.
  reopenKey?: number;
  switchReadPending: boolean;
  switchUnresyncedRef: { current: boolean };
  // Workspace-activity token: bumps after saves / external edits so the linked
  // mentions section recomputes without polling.
  refreshKey?: number;
  // Registers the mounted document's "view source" toggle with the shell so
  // the command palette can flip it (registerDraftFlush precedent). Engine
  // docs toggle the read-only source projection; the legacy autosave editor
  // switches its existing (editable) source mode.
  registerSourceToggle?: (toggle: (() => void) | null) => void;
  // Only the active editor group may claim focus when its source editor
  // mounts. Omitted preserves the single-editor behavior for existing callers.
  autoFocus?: boolean;
  // The engine refused the open because the path is not in this workspace's
  // version. `discardedEdit` is true when the user had typed and that
  // draft was thrown away rather than written — the inspector owes them that
  // fact, because nothing else will tell them.
  // Whether an unsaved draft is pending, reported on every render. The
  // inspector needs this AT refusal time, and by then this component is gone:
  // the commit that learns of the refusal is the one that replaces it, so a
  // callback fired from here at that moment would never run. Reporting
  // continuously means the inspector already holds the answer. The setter bails
  // out when the value is unchanged, so this costs a comparison per render.
  onPendingDraftChange?: (pending: boolean) => void;
  // The engine open, opened by the inspector and passed down. It deliberately
  // does not live here: this component is unmounted by the inspector's own
  // loading/error branch, and a version switch that removes the file makes the
  // reread fail before the queued open answers — so an open owned here would be
  // cancelled by the very race its refusal exists to name.
  engine: UseEngineDoc;
  // Reopen the engine session after `engine.engineMayHoldDocument`.
  // Owned by the inspector, like the open itself. Required: the notice must
  // never render without its retry, and the one caller always passes it.
  onRetryEngineOpen: () => void;
  // Set by the inspector during every render for its live write refusal,
  // including a pending switch reread. Read by every write guard beside
  // `readOnlyRef`, because an engine refusal can arrive in the commit that
  // unmounts this component, with no child render to fold into `readOnly`.
  writesRefusedRef: { current: boolean };
  localBuffer: SharedLocalDocument;
}) {
  const [mode, setMode] = useState<"read" | "wysiwyg" | "source">(() =>
    props.truncated || props.body.length > WYSIWYG_MARKDOWN_THRESHOLD_BYTES
      ? "read"
      : "wysiwyg",
  );
  const [draft, setDraft] = useState(props.body);
  const [savedBody, setSavedBody] = useState(props.body);
  const [wysiwygResyncEpoch, setWysiwygResyncEpoch] = useState(0);
  const knownFiles = props.knownFiles ?? EMPTY_WIKILINK_FILES;
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [writerSettledEpoch, setWriterSettledEpoch] = useState(0);
  const localSource = useRef<object>({});
  const activeLocalBuffer = useRef(props.localBuffer);
  activeLocalBuffer.current = props.localBuffer;
  const sharedSnapshot = useSyncExternalStore(
    props.localBuffer.subscribe,
    props.localBuffer.getSnapshot,
    props.localBuffer.getSnapshot,
  );
  const pendingMarkdownOwner = useSyncExternalStore(
    props.localBuffer.subscribe,
    props.localBuffer.getPendingDraftSource,
    props.localBuffer.getPendingDraftSource,
  );
  const sharedRevision = useRef<{
    buffer: SharedLocalDocument;
    revision: number;
  } | null>(null);

  const engine = props.engine;
  useEffect(() => {
    if (!engine.available && pendingMarkdownOwner !== null) {
      setSaveState("saving");
    }
  }, [engine.available, pendingMarkdownOwner]);
  // The engine open runs ON the capture chain, so a document opened
  // while that chain is busy (startup reconciliation of a 1,000-file
  // workspace, a version switch) waits before dohc knows whether it is
  // engine-backed. `available: false` alone cannot tell that wait apart from
  // "not engine-backed", so this surface used to answer it with the plain
  // editor — writable, autosaving straight TO disk — while the session about
  // to bind seeded from the engine head. Keystrokes in that window took a path
  // that session never sees. Nothing here is writable until the open answers.
  const opening = engine.opening;
  // What the user sees, as against `mode`, which is what the user CHOSE. An
  // opening document reads; its chosen mode is kept and restored, so a
  // document that would have opened straight into the editor still does.
  const surfaceMode = opening ? "read" : mode;
  const editorPendingUndo = useMemo(
    () =>
      props.pendingUndo
        ? {
            token: props.pendingUndo.token,
            restoredText: markdownEditorBody(props.pendingUndo.restoredText),
            undoText: markdownEditorBody(props.pendingUndo.undoText),
          }
        : undefined,
    [props.pendingUndo],
  );
  // Search lands HERE. One jump at a time, in one of two states: the LINE the
  // result named, and — once the engine editor has something to map it
  // against — the BLOCK holding that line. Whichever surface owns the
  // document consumes it: the source editor selects the line, the
  // engine editor reveals the block. Consuming it retires it, so a later
  // commit cannot replay the jump.
  const [jump, setJump] = useState<
    | { kind: "line"; line: number }
    | ({ kind: "block" } & BlockNavigationTarget)
    // A frontmatter hit, whose landing is the top of the pane rather than any
    // block. In the union so the three retire sites cover it too.
    | { kind: "top" }
    | null
  >(null);
  const jumpNonce = useRef(0);
  // The editor reports the jump it landed, and it goes away. Keyed by nonce so
  // a report for a jump this view has already replaced is ignored.
  const retireJump = useCallback((nonce: number) => {
    setJump((current) =>
      current?.kind === "block" && current.nonce === nonce ? null : current,
    );
  }, []);
  // A version switch retires a jump that has not landed yet. Reporting back
  // covers the applied one; this covers everything before that, where the
  // reopen unbinds the Y.Doc and the editor that remounts on the new version
  // would land a line the reader numbered against the version they left. It
  // covers the unmapped line too — a document still opening has nothing to map
  // against yet — because both states live here.
  const jumpReopenKey = useRef(props.reopenKey);
  if (props.reopenKey !== jumpReopenKey.current) {
    jumpReopenKey.current = props.reopenKey;
    if (jump) setJump(null);
  }
  const scrollTargetNonce = props.scrollTarget?.nonce;
  useEffect(() => {
    if (!props.scrollTarget || props.scrollTarget.path !== props.path) return;
    setMode("source");
    setJump({ kind: "line", line: props.scrollTarget.line });
    // Applied once per jump: nonce is the identity of one click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTargetNonce]);
  const wysiwygRef = useRef<MarkdownEditorHandle | null>(null);
  const latestDraft = useRef(props.body);
  const baseContentHash = useRef(props.contentHash);
  const baseContentRequestId = useRef(props.contentRequestId);
  const latestSnapshot = useRef({
    body: props.body,
    contentHash: props.contentHash,
    requestId: props.contentRequestId,
    readTicket: props.contentReadTicket,
  });
  latestSnapshot.current = {
    body: props.body,
    contentHash: props.contentHash,
    requestId: props.contentRequestId,
    readTicket: props.contentReadTicket,
  };
  const latestContentRequestId = useRef(props.latestContentRequestId);
  latestContentRequestId.current = props.latestContentRequestId;
  const acceptedRequestFloor = useRef(0);
  const staleBaseline = useRef(false);
  const flushConflict = useRef(false);
  const conflictContentHash = useRef<string | null>(null);
  const conflictRequestId = useRef(0);
  const conflictRefreshRequestId = useRef<number | null>(null);
  const verifyAfterRequestId = useRef<number | null>(null);
  const blockedDraftRevision = useRef(-1);
  const capturedConflictDraft = useRef<string | null>(null);
  const conflictDraftId = useRef<number | null>(null);
  const draftRevision = useRef(0);
  // CodeMirror owns local keystrokes. Advance only when an accepted external
  // value must replace its document and local undo history.
  const [sourceValueRevision, bumpSourceValueRevision] =
    useAuthoritativeValueRevision();
  const unmounted = useRef(false);
  const serializeDraftRef = useRef<() => string>(() => props.body);
  const editing = surfaceMode !== "read";
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the keystroke until a write for that draft has been ISSUED.
  // The unmount flush keys off this — never off the timer handle, which stays
  // set (already fired) after a completed autosave and would double-write.
  const unsavedDraft = useRef(false);
  // One queue, joined at ENTRY. The earlier design tracked
  // the write that held the slot, so a writer PARKED behind it was invisible:
  // the flush could see an empty slot while a waiter was still queued, and
  // that waiter then landed the previous version's text after the switch.
  // Three rounds each closed one interleaving and exposed the next, which is
  // what polling a slot always does. Membership now starts when the writer
  // arrives, so "everything ahead of me" is one await of this tail.
  //
  // Never rejects: a failed write is its own caller's business, not a poison
  // pill for every writer behind it.
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  // Writers that have entered and not yet finished. Zero means the queue is
  // idle and the next writer can run without deferring (see writeDraftNow).
  const writersLive = useRef(0);
  // Armed while the flush drains. New edits stay on this side of the barrier
  // and are written before the shell can move or close the current path.
  const flushBarrier = useRef(false);
  const flushInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (
      engine.available ||
      !sharedSnapshot.initialized ||
      (sharedRevision.current?.buffer === props.localBuffer &&
        sharedRevision.current.revision === sharedSnapshot.revision)
    ) {
      return;
    }
    sharedRevision.current = {
      buffer: props.localBuffer,
      revision: sharedSnapshot.revision,
    };
    const bodyChanged = latestDraft.current !== sharedSnapshot.body;
    const baselineChanged =
      baseContentHash.current !== sharedSnapshot.contentHash;
    baseContentHash.current = sharedSnapshot.contentHash;
    latestDraft.current = sharedSnapshot.body;
    setSaveState(sharedSnapshot.saveState);
    const newerInitialization =
      sharedSnapshot.source === null && baselineChanged;
    if (
      sharedSnapshot.saveState === "saved" &&
      !sharedSnapshot.dirty &&
      !bodyChanged
    ) {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      unsavedDraft.current = false;
    }
    if (
      (sharedSnapshot.source === null && !newerInitialization) ||
      sharedSnapshot.source === localSource.current ||
      !bodyChanged
    ) {
      return;
    }
    draftRevision.current += 1;
    bumpSourceValueRevision();
    setDraft(sharedSnapshot.body);
    setSavedBody(sharedSnapshot.body);
    if (mode === "wysiwyg") {
      wysiwygRef.current?.replaceMarkdown(
        markdownEditorBody(sharedSnapshot.body),
      );
    }
  }, [bumpSourceValueRevision, engine.available, mode, sharedSnapshot]);

  function captureLatestConflictDraft(text?: string) {
    const capturedText =
      text ??
      (unmounted.current
        ? latestDraft.current
        : props.localBuffer.takePendingDraft(localSource.current) ??
          latestDraft.current);
    if (capturedConflictDraft.current === capturedText) return;
    conflictDraftId.current = captureOrphanedDraft(
      props.workspaceId,
      props.path,
      capturedText,
    );
    capturedConflictDraft.current = capturedText;
  }

  function captureFailedFlush() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    unsavedDraft.current = false;
    blockedDraftRevision.current = Math.max(
      blockedDraftRevision.current,
      draftRevision.current,
    );
    captureLatestConflictDraft();
    if (!unmounted.current) setSaveState("error");
  }

  function acceptSnapshot(
    snapshot: {
      body: string;
      contentHash: string | null;
      requestId: number;
      readTicket: number;
    },
    state: SaveState,
  ): boolean {
    if (
      !props.localBuffer.acceptRead(
        snapshot.body,
        snapshot.contentHash,
        localSource.current,
        state === "error",
        snapshot.readTicket,
      )
    ) {
      return false;
    }
    sharedRevision.current = {
      buffer: props.localBuffer,
      revision: props.localBuffer.getSnapshot().revision,
    };
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (staleBaseline.current && unsavedDraft.current) {
      captureLatestConflictDraft();
    }
    unsavedDraft.current = false;
    draftRevision.current += 1;
    bumpSourceValueRevision();
    blockedDraftRevision.current = Math.max(
      blockedDraftRevision.current,
      draftRevision.current,
    );
    staleBaseline.current = false;
    baseContentHash.current = snapshot.contentHash;
    baseContentRequestId.current = snapshot.requestId;
    if (
      verifyAfterRequestId.current !== null &&
      snapshot.requestId > verifyAfterRequestId.current
    ) {
      verifyAfterRequestId.current = null;
    }
    acceptedRequestFloor.current = Math.max(
      acceptedRequestFloor.current,
      snapshot.requestId,
    );
    setDraft(snapshot.body);
    setSavedBody(snapshot.body);
    latestDraft.current = snapshot.body;
    if (mode === "wysiwyg") setWysiwygResyncEpoch((epoch) => epoch + 1);
    setSaveState(state);
    return true;
  }

  function acceptConflictSnapshotIfCurrent(): boolean {
    const snapshot = latestSnapshot.current;
    const shared = props.localBuffer.getSnapshot();
    if (
      (snapshot.contentHash !== conflictContentHash.current &&
        snapshot.requestId <= conflictRequestId.current) ||
      (shared.initialized &&
        !shared.dirty &&
        shared.contentHash !== snapshot.contentHash)
    ) {
      return false;
    }
    return acceptSnapshot(snapshot, "error");
  }

  function reconcileConflictSnapshot() {
    if (acceptConflictSnapshotIfCurrent()) return;
    const shared = props.localBuffer.getSnapshot();
    if (
      shared.dirty &&
      (shared.source !== localSource.current || writersLive.current > 0)
    ) {
      return;
    }
    const requestId = latestSnapshot.current.requestId;
    if (conflictRefreshRequestId.current === requestId) return;
    conflictRefreshRequestId.current = requestId;
    props.refreshAfterConflict();
  }

  // Cancel-and-restore: the moment `opening` flips true, the pending
  // draft leaves the save pipeline. Writing it would land the previous
  // version's text on the tree the reopen is binding; dropping it would lose
  // keystrokes silently. So the armed autosave is cancelled, the draft is set
  // aside, and the notice below surfaces it for the user to copy.
  //
  // The drafts live in a module store keyed by workspace + path, not in this
  // component's state: the notice promises the text stays recoverable, and
  // this view unmounts on every tab switch. The hook
  // subscribes; the capture appends.
  //
  // The capture runs during render, not in an effect, for two reasons. The
  // armed 800ms timer can fire between this commit and a passive effect — by
  // then it has written. And `serializeDraftRef` still holds the previous
  // render's closure here, which reads the live editor this very commit is
  // about to unmount — an effect would serialize the pre-edit body (the trap
  // writeDraftNow documents). The transition guard keeps it idempotent under
  // replayed renders (`readOnlyRef` precedent below).
  const orphanedDrafts = useOrphanedDrafts(props.workspaceId, props.path);
  const openingRef = useRef(opening);
  if (opening && !openingRef.current) {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (unsavedDraft.current) {
      unsavedDraft.current = false;
      props.localBuffer.clearPendingDraft(localSource.current);
      captureOrphanedDraft(
        props.workspaceId,
        props.path,
        serializeDraftRef.current(),
      );
      // The armed save will never issue, so "saving" must not stand. The
      // set-aside edit's own signal is derived from the store below — that
      // way Dismiss retires it instead of stranding an
      // error chip on a draft that no longer exists.
      setSaveState("saved");
      // The surface goes back to the document. Clearing the flag lets the
      // props.body sync effect take over when a dependency fires — but in
      // read mode `editing` never flips and the reopened body can be
      // byte-identical, so that effect has nothing to fire on and the
      // set-aside title/property edit would keep painting the view and ride
      // into the next property save. Reset here.
      draftRevision.current += 1;
      bumpSourceValueRevision();
      setDraft(props.body);
      setSavedBody(props.body);
      latestDraft.current = props.body;
      baseContentHash.current = props.contentHash;
      baseContentRequestId.current = props.contentRequestId;
      acceptedRequestFloor.current = Math.max(
        acceptedRequestFloor.current,
        props.contentRequestId,
      );
    }
  }
  openingRef.current = opening;
  useEffect(() => {
    const id = conflictDraftId.current;
    if (!flushConflict.current || staleBaseline.current || id === null) return;
    if (orphanedDrafts.some((draft) => draft.id === id)) return;
    conflictDraftId.current = null;
    capturedConflictDraft.current = null;
    flushConflict.current = false;
    setSaveState("saved");
  }, [orphanedDrafts, saveState, props.contentRequestId]);
  // What the header chip shows: a real pending/failed save wins; otherwise an
  // unresolved set-aside draft gets its own state. The
  // set-aside edit is not in the file, but it is not savable-dirty either —
  // only the real save state is lifted to the shell, so the version-switch
  // save-first prompt never promises to save a draft the pipeline cannot
  // write. The shell reads the store itself for the tab dot.
  const chipState =
    saveState !== "saved"
      ? saveState
      : orphanedDrafts.length > 0
        ? ("recovery" as const)
        : "saved";
  // The engine branch has its own authoritative save state; the set-aside
  // draft still is not in the document it shows, so a settled engine must
  // not read "Saved" over an unresolved notice.
  const engineChipState =
    engine.saveState === "saved" && orphanedDrafts.length > 0
      ? ("recovery" as const)
      : engine.saveState;
  const engineChip = engine.readOnlyWhileEditing
    ? READ_ONLY_TRANSITION_CHIP
    : ENGINE_CHIP[engineChipState];

  serializeDraftRef.current = () => {
    // WYSIWYG mode: the Tiptap editor owns the body while inline PageIdentity /
    // PropertiesPanel own the frontmatter (both write frontmatter through
    // latestDraft.current). Merge the live editor body over that frontmatter so
    // a save never emits the stale mount-time body. Source mode edits the full
    // markdown directly in CodeMirror, so latestDraft.current is canonical.
    if (surfaceMode === "wysiwyg") {
      const body = wysiwygRef.current?.getMarkdown() ?? markdownEditorBody(draft);
      return mergeMarkdownEditorBody(latestDraft.current, body);
    }
    return latestDraft.current;
  };

  // Engine-mode export/serialize: in the engine branch the WYSIWYG editor is
  // always mounted and collab-bound to the engine Y.Doc, so its live body is
  // the canonical current markdown. serializeDraftRef can't be reused here
  // because it falls back to the stale (possibly truncated) props.body whenever
  // the properties panel is open or the doc opened in read mode, neither of
  // which reflects the live edit. This reads the editor on demand at click time
  // so the exported source is fresh.
  //
  // Frontmatter (title / icon / properties) is edited through PageIdentity and
  // PropertiesPanel, which write straight into the engine Y.Doc's frontmatter
  // MAP — not into latestDraft.current, which stays at this mount's initial
  // markdown. Reading latestDraft.current for the frontmatter therefore exports
  // a stale title. Serialize the live map instead and combine it with the body
  // the mounted WYSIWYG editor already owns.
  const serializeEngineDraft = (): string | null => {
    // This export path needs the mounted editor's live body. `props.body` is
    // the markdown cache beside the canonical Y.Doc, so it lags every edit the
    // document has taken since the read. On the recovery path (a failed read
    // whose retry bound the document), it is empty. Refuse instead of
    // exporting stale text; the menu says the document is not ready.
    const editorBody = wysiwygRef.current?.getMarkdown();
    if (editorBody === undefined && engine.doc !== null) return null;
    const body = editorBody ?? markdownEditorBody(props.body);
    if (!engine.doc) {
      return applyFrontmatter(body, orderFrontmatter(parseFrontmatter(latestDraft.current).meta));
    }
    const liveMeta = Object.fromEntries(
      engine.doc.getMap(ENGINE_FRONTMATTER_FIELD).entries(),
    ) as Record<string, unknown>;
    // The frontmatter text the settle keeps, so a copy matches the file.
    const meta = engine.doc.getMap("meta");
    const written = writtenFrontmatterKeys(engine.doc.getMap(ENGINE_FRONTMATTER_FIELD), meta);
    const block = frontmatterBlockFor(
      orderFrontmatter(liveMeta),
      meta.get("dohcFrontmatterSource"),
      body,
      "\n",
      written,
    );
    return `${block}${body}`;
  };

  const hasSetAsideEdit =
    engine.deletedDraftId !== null &&
    orphanedDrafts.some((draft) => draft.id === engine.deletedDraftId);

  useEffect(() => {
    if (surfaceMode === "read") void loadMarkdownEditor();
  }, [surfaceMode, props.path]);

  const { onSaveStateChange } = props;

  // Parse-once + visible-first: the memo stops re-parses on
  // unrelated re-renders (collab status flips, save-state ticks), and the
  // incremental document commits only the opening window up front, idle-
  // backfilling the rest — a 250KB doc opens in tens of ms, not ~575ms.
  // Strip YAML frontmatter before rendering the read view: the title/icon it
  // encodes is already surfaced by <PageIdentity> above the document, so the
  // raw `---`/`title:`/`icon:` block must not also render as body content (the
  // WYSIWYG editor uses the same `markdownEditorBody` split — keep read mode in
  // lockstep so both show the document body, not its metadata).
  const linkNavigationNonce = useRef(0);
  const openWikilinkRef = useRef<(target: string) => void>(() => undefined);
  const openWorkspaceLinkRef = useRef<(target: WorkspaceLinkTarget) => void>(
    () => undefined,
  );
  openWikilinkRef.current = (target) => {
    const navigation = resolveWikilinkNavigation(
      target,
      props.path,
      knownFiles,
      ++linkNavigationNonce.current,
    );
    props.onOpenPath?.(navigation.path, navigation.headingTarget);
  };
  openWorkspaceLinkRef.current = (target) => {
    const navigation = resolveWorkspaceLinkNavigation(
      target,
      props.path,
      knownFiles,
      ++linkNavigationNonce.current,
    );
    props.onOpenPath?.(navigation.path, navigation.headingTarget);
  };
  const markdownOpenMarkedRef = useRef(false);
  // Complete the open from the first real Markdown surface that commits. The
  // read view reports after its lazy chunk parses the visible window; small
  // files report from the editor after its own lazy chunk resolves.
  const onMarkdownRendered = useCallback(() => {
    if (markdownOpenMarkedRef.current) return;
    markdownOpenMarkedRef.current = true;
    rendererMarks.measureSince("markdown-open", props.fileOpenStartMark);
    // Last-wins: readers poll this epoch to know the measure above belongs to
    // the open they triggered (never a stale value from the previous file).
    rendererMarks.mark("markdown-opened");
  }, [props.fileOpenStartMark, props.path]);
  const renderedDocument = useMemo(
    () => (
      <LazyMarkdownReadView
        body={markdownEditorBody(savedBody)}
        resetKey={`${props.workspaceId}:${props.path}:${props.reopenKey}`}
        onOpenWorkspaceLink={(target) => openWorkspaceLinkRef.current(target)}
        onRendered={onMarkdownRendered}
      />
    ),
    [onMarkdownRendered, props.path, props.reopenKey, props.workspaceId, savedBody],
  );
  const onShareCurrentPath = props.onSharePath
    ? () => props.onSharePath?.(props.path)
    : undefined;

  // The engine refused because the path is not in the version this workspace is
  // on. The plain editor is writable too, so falling back to it would
  // autosave the file the version switch removed back into the version as a
  // phantom. Hand the refusal up; the caller replaces the document.
  //
  // A pending draft reached disk by two routes, and turning the document
  // read-only closed neither, because both held a stale `readOnly`: the armed
  // 800ms autosave (see writeDraftNow) and the unmount flush below, which had
  // `readOnly` in its deps and so ran its previous cleanup on the very
  // false->true transition with `readOnly === false` captured. Making the
  // document read-only was itself the write. Both now read `readOnlyRef`.
  //
  // #567 decided the `opening` half: a reopen cancels the armed autosave and
  // sets the draft aside (the render-phase capture above), and every write
  // path refuses while `opening` holds, via `openingRef` — assigned during
  // render for the same reason as `readOnlyRef`.
  //
  // The draft is reported, not written: the user typed into a file this
  // version does not have, and nothing else would tell them it went nowhere.
  const { onPendingDraftChange } = props;
  useEffect(() => {
    // Set-aside drafts deliberately do not count: they are not
    // discarded — the store outlives this view and the refusal screen renders
    // their notice itself, Copy included.
    onPendingDraftChange?.(unsavedDraft.current);
  });
  const readOnly =
    !!props.forceReadOnly ||
    engine.notInVersion ||
    engine.documentUnavailable ||
    engine.liveHostUnavailable ||
    engine.deletedWhileEditing ||
    engine.readOnlyWhileEditing ||
    engine.permanentFailureWhileEditing ||
    engine.removalInProgress !== null ||
    // The engine open hit its retry deadline. The plain editor stays
    // read-only — its autosave would race the session the engine may still
    // bind — and the notice below states the reason and offers the retry.
    engine.engineMayHoldDocument ||
    (props.truncated && !engine.available);
  // Every write guard reads this, never the captured `readOnly`. Assigned
  // during render so a cleanup or an armed timer that runs after the flip sees
  // the flip. See writeDraftNow and the unmount flush.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const switchReadPendingRef = useRef(props.switchReadPending);
  switchReadPendingRef.current = props.switchReadPending;
  // The single question all three write paths ask. Both refs, because they
  // close different gaps: `readOnlyRef` a flip this component rendered,
  // `writesRefusedRef` an engine refusal or unapplied switch resync (already
  // folded into its OR-chain by the parent — reading `switchUnresyncedRef`
  // here too would shadow it) that a long-lived closure may never get to
  // render.
  const { writesRefusedRef } = props;
  const writesBlocked = () =>
    readOnlyRef.current || writesRefusedRef.current || staleBaseline.current;
  const engineMode = engine.available && engine.doc !== null;
  const engineModeRef = useRef(engineMode);
  engineModeRef.current = engineMode;
  const flushEngineUpdatesRef = useRef(engine.flushPendingLocalUpdates);
  flushEngineUpdatesRef.current = engine.flushPendingLocalUpdates;

  // "View markdown as source" (engine mode): a READ-ONLY projection of the
  // canonical Y.Doc through the same yDocToMarkdown the settle uses to write
  // the .md — the source view shows exactly what lands on disk. Deliberately
  // not editable: `atoms.body` markdown is a derived cache of the Y.Doc, and
  // an editable raw surface would have to round-trip through full-body
  // markdown patching (the invariant this must never become).
  const [showSource, setShowSource] = useState(false);
  const [sourceProjection, setSourceProjection] = useState<{
    documentKey: string;
    doc: Y.Doc;
    markdown: string;
  } | null>(null);
  // Derive currentness during render, before passive-effect cleanup can run.
  // The key is FileInspector's existing workspace/path/version generation;
  // doc identity also covers a same-version engine retry.
  const sourceMarkdown =
    sourceProjection?.documentKey === props.documentKey &&
    sourceProjection.doc === engine.doc
      ? sourceProjection.markdown
      : null;
  const readDocumentRef = useRef<HTMLDivElement | null>(null);
  const localDocPaneRef = useRef<HTMLDivElement | null>(null);
  // The engine branch's scroller. It holds the top-matter (title, properties)
  // above the editor, which is where a frontmatter search hit actually lives.
  const engineDocPaneRef = useRef<HTMLDivElement | null>(null);
  const [pendingRenderedHeadingIndex, setPendingRenderedHeadingIndex] = useState<
    number | null
  >(null);
  const headingTargetNonce = props.headingTarget?.nonce;
  function applyHeadingTarget(
    targetMode: "read" | "wysiwyg" | "source" = surfaceMode,
    replaySource?: string,
  ): boolean {
    if (!props.headingTarget || props.truncated) return false;
    // Search-line jumps intentionally keep their established source-mode
    // behavior when both targets are present.
    if (props.scrollTarget?.path === props.path) return false;
    if (engineMode) {
      // The engine editor owns canonical live content (which may be newer than
      // the markdown cache below). Reveal it and let OutlinePanel resolve the
      // target against that live Y.Doc.
      setShowSource(false);
      // The heading is the reader's newest destination, so a search jump that
      // has not landed yet is over. Left pending it lands the moment the lazy
      // editor arrives and pulls them off the heading they just chose.
      setJump(props.headingTarget.anchor === "" ? { kind: "top" } : null);
      return true;
    }
    if (props.headingTarget.anchor === "") {
      if (targetMode === "source") {
        setJump({ kind: "line", line: 1 });
        return true;
      }
      const pane = localDocPaneRef.current;
      if (!pane) return false;
      pane.scrollTo({ top: 0 });
      return true;
    }
    const source =
      replaySource ?? (targetMode === "source" ? latestDraft.current : savedBody);
    const markdown = markdownEditorBody(source);
    const headings = extractWorkspaceHeadings(markdown);
    const heading = resolveWorkspaceHeadingAnchorTarget(headings, props.headingTarget);
    if (!heading) return false;
    if (targetMode === "source") {
      // Local source is an intentional editing/viewing mode. Keep it visible
      // and select the heading's real markdown line instead of replacing it
      // with the rich editor merely to navigate.
      setJump({ kind: "line", line: heading.line + frontmatterLineCount(source) });
      return true;
    }
    if (readOnly || targetMode === "read") {
      // Read-only documents do not mount Tiptap, so navigate the rendered
      // heading with the same document-order identity used by the parser.
      setPendingRenderedHeadingIndex(headings.indexOf(heading));
      return true;
    }
    setMode("wysiwyg");
    return true;
  }
  const appliedHeadingNonce = useRef<number | undefined>(undefined);
  const headingReopenKey = useRef(props.reopenKey);
  const armedHeadingReplayMode = useRef<"read" | "source" | null>(null);
  // A version switch refuses every write until its reread succeeds, and any
  // local editable mode active during that window resyncs after success,
  // preserving a pending edit as an orphaned draft first. A standing heading
  // target is an optional replay layered on that resync, never its gate.
  const armedLocalResyncMode = useRef<
    "read" | "source" | "wysiwyg" | null
  >(null);
  // External changes (agent edits, sync pulls) flow into the open document
  // only while not editing and with no unsaved draft — mid-edit, the user's
  // draft wins until saved. Read mode now edits frontmatter inline (title/icon
  // via PageIdentity, properties via PropertiesPanel) without switching to an
  // "editing" mode, so a pending property save must be guarded here too or an
  // external refresh mid-edit would clobber the unsaved change.
  //
  // This runs before the switch fire effect. A read-mode resync therefore
  // applies before that effect lifts the shared write refusal.
  useEffect(() => {
    if (staleBaseline.current) {
      reconcileConflictSnapshot();
      return;
    }
    const verificationFloor = verifyAfterRequestId.current;
    if (verificationFloor !== null) {
      const snapshot = latestSnapshot.current;
      if (snapshot.requestId <= verificationFloor) return;
      if (unsavedDraft.current || writersLive.current > 0) return;
      if (editing) {
        if (snapshot.contentHash === baseContentHash.current) {
          verifyAfterRequestId.current = null;
          baseContentRequestId.current = snapshot.requestId;
          acceptedRequestFloor.current = Math.max(
            acceptedRequestFloor.current,
            snapshot.requestId,
          );
          setSaveState("saved");
          return;
        }
        flushConflict.current = true;
        conflictContentHash.current = snapshot.contentHash;
        conflictRequestId.current = snapshot.requestId;
        captureLatestConflictDraft();
        acceptSnapshot(snapshot, "error");
        return;
      }
    }
    if (
      !editing &&
      !unsavedDraft.current &&
      writersLive.current === 0 &&
      props.contentRequestId > acceptedRequestFloor.current
    ) {
      acceptSnapshot(latestSnapshot.current, "saved");
    }
    // The helpers read mutable writer state and the atomic snapshot above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.body,
    props.contentHash,
    props.contentRequestId,
    editing,
    sharedSnapshot,
    writerSettledEpoch,
  ]);
  useEffect(() => {
    if (props.reopenKey === headingReopenKey.current) return;
    headingReopenKey.current = props.reopenKey;
    if (
      headingTargetNonce === appliedHeadingNonce.current &&
      !engineMode &&
      (mode === "source" || readOnly || mode === "read")
    ) {
      // A fresh arm retires whatever the last one was still waiting on — a
      // read-mode replay's MutationObserver, still watching for a heading the
      // new document may not even have, must not land on an unrelated ordinal
      // as the new doc backfills. Unconditional: a wait carried from an
      // earlier read-mode visit survives a later switch to source and back,
      // so the mode AT arm time does not prove none is pending.
      setPendingRenderedHeadingIndex(null);
      armedHeadingReplayMode.current = mode === "source" ? "source" : "read";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reopenKey]);
  useEffect(() => {
    if (!engineMode && props.switchReadPending) {
      armedLocalResyncMode.current = mode;
    }
  }, [mode, props.switchReadPending, engineMode]);
  useEffect(() => {
    if (props.switchReadPending) return;
    const resyncMode = armedLocalResyncMode.current;
    if (resyncMode) {
      armedLocalResyncMode.current = null;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (unsavedDraft.current) {
        unsavedDraft.current = false;
        // The same retirement the `opening` capture performs. A LAZY WYSIWYG
        // draft survives the reset below untouched, and its `materialize`
        // closes over the editor this resync is about to replace — the next
        // caller to materialize (the shell's flush, a mode switch, a property
        // edit) would merge the previous version's body over the new baseline
        // and write it. The text itself is not lost: the capture below takes
        // it from the live editor.
        props.localBuffer.clearPendingDraft(localSource.current);
        captureOrphanedDraft(
          props.workspaceId,
          props.path,
          serializeDraftRef.current(),
        );
        setSaveState("saved");
      }
      const sharedBeforeResync = props.localBuffer.getSnapshot();
      const peerDraftPending =
        sharedBeforeResync.dirty &&
        sharedBeforeResync.source !== localSource.current;
      if (!peerDraftPending) {
        props.localBuffer.reset(
          props.body,
          props.contentHash,
          localSource.current,
        );
      }
      const resyncBody = peerDraftPending
        ? sharedBeforeResync.body
        : props.body;
      const resyncContentHash = peerDraftPending
        ? sharedBeforeResync.contentHash
        : props.contentHash;
      draftRevision.current += 1;
      bumpSourceValueRevision();
      setDraft(resyncBody);
      setSavedBody(resyncBody);
      latestDraft.current = resyncBody;
      baseContentHash.current = resyncContentHash;
      baseContentRequestId.current = props.contentRequestId;
      if (peerDraftPending) setSaveState(sharedBeforeResync.saveState);
      acceptedRequestFloor.current = Math.max(
        acceptedRequestFloor.current,
        props.contentRequestId,
      );
      if (resyncMode === "wysiwyg") {
        setWysiwygResyncEpoch((epoch) => epoch + 1);
      }
    }
    const replayMode = armedHeadingReplayMode.current;
    if (replayMode) {
      armedHeadingReplayMode.current = null;
      applyHeadingTarget(replayMode, props.body);
    }
    props.switchUnresyncedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.switchReadPending]);
  useEffect(() => {
    const applied = applyHeadingTarget();
    // Only a target that actually landed counts as "standing" for a later
    // switch to replay. One suppressed by an active scrollTarget, or one that
    // resolved to no heading, must not be replayed later as if the reader had
    // visited it.
    if (applied) appliedHeadingNonce.current = headingTargetNonce;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingTargetNonce]);
  useEffect(() => {
    if (pendingRenderedHeadingIndex === null || surfaceMode !== "read") return;
    const container = readDocumentRef.current;
    if (!container) return;
    const applyTarget = () => {
      const target = container.querySelectorAll<HTMLElement>(
        "h1, h2, h3, h4, h5, h6",
      )[pendingRenderedHeadingIndex];
      if (!target) return false;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setPendingRenderedHeadingIndex(null);
      return true;
    };
    if (applyTarget()) return;
    // Large documents backfill rendered chunks during idle time. Observe that
    // bounded subtree until the requested heading is committed rather than
    // silently dropping an otherwise valid jump.
    const observer = new MutationObserver(() => {
      if (applyTarget()) observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [surfaceMode, pendingRenderedHeadingIndex]);
  // The engine editor's line-jump seam. Engine mode renders no editable
  // source editor, so before this every engine-backed search result opened at the
  // top of the document. The jump is retired here, once, for every engine-
  // backed open — including the recovery path, whose `props.body` is empty
  // (the failed read) and therefore resolves to the first block.
  //
  // `props.body` is the on-disk Markdown, which is what search numbered its
  // lines against, so it is the right text to map — even though the canonical
  // Y.Doc may have moved on since. The block index absorbs small drift.
  useEffect(() => {
    if (jump?.kind !== "line" || !engineMode) return;
    // Show the document, not the source projection. A reader who clicked a
    // search result wants the match, and the editor pane is `hidden` while
    // source is up — the reveal would land where nobody can see it. Same move
    // the heading jump makes above.
    setShowSource(false);
    const body = markdownEditorBody(props.body);
    const bodyLine = jump.line - frontmatterLineCount(props.body);
    if (bodyLine < 1) {
      // The hit is in the frontmatter. The title and properties it names are
      // rendered by PageIdentity/PropertiesPanel above the editor, so there is
      // no body block to reveal — and revealing the first one would scroll the
      // real match off the top. Show the top of the document instead — after
      // the pane is visible, because `setShowSource` above only schedules the
      // unhide and a hidden element cannot be scrolled.
      setJump({ kind: "top" });
    } else {
      // The line becomes the block, which is what retires it: a jump still
      // waiting on the lazy editor names the result before this one, and
      // would land the moment that editor arrives.
      //
      // The target carries the block's own source with it, so the editor can
      // land the matched line inside a long list or fence rather than at its
      // top — one target, retired once, either way.
      setJump({
        kind: "block",
        ...blockTargetForLine(body, bodyLine),
        nonce: ++jumpNonce.current,
      });
    }
  }, [jump, engineMode, props.body]);
  // The frontmatter jump's landing, once the pane it moves is on screen.
  useEffect(() => {
    if (jump?.kind !== "top" || showSource) return;
    engineDocPaneRef.current?.scrollTo({ top: 0 });
    setJump(null);
  }, [jump, showSource]);
  useEffect(() => {
    if (!showSource || !engine.doc) {
      setSourceProjection(null);
      return;
    }
    const doc = engine.doc;
    const documentKey = props.documentKey;
    let cancelled = false;
    let serialize: ((doc: Y.Doc) => string) | null = null;
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    let updateDeadline: number | null = null;
    const recompute = () => {
      if (cancelled || !serialize) return;
      const markdown = serialize(doc);
      if (cancelled) return;
      setSourceProjection({ documentKey, doc, markdown });
    };
    const runScheduledRecompute = () => {
      updateTimer = null;
      updateDeadline = null;
      recompute();
    };
    void loadImportExport().then((mod) => {
      serialize = mod.yDocToMarkdown;
      if (updateTimer !== null) {
        clearTimeout(updateTimer);
        updateTimer = null;
        updateDeadline = null;
      }
      recompute();
    });
    // Live: agent edits / co-editors keep flowing into the mirror doc while
    // the source view is up. A co-editor's keystroke burst forwards one delta
    // per keystroke, so wait for a short trailing edge while the maximum wait
    // keeps a sustained burst repainting twice per second.
    const scheduleRecompute = () => {
      const now = Date.now();
      updateDeadline ??= now + SOURCE_VIEW_UPDATE_MAX_WAIT_MS;
      if (updateTimer !== null) clearTimeout(updateTimer);
      updateTimer = setTimeout(
        runScheduledRecompute,
        Math.max(
          0,
          Math.min(SOURCE_VIEW_UPDATE_DELAY_MS, updateDeadline - now),
        ),
      );
    };
    doc.on("update", scheduleRecompute);
    return () => {
      cancelled = true;
      if (updateTimer !== null) clearTimeout(updateTimer);
      doc.off("update", scheduleRecompute);
    };
  }, [showSource, engine.doc, props.documentKey]);

  // One toggle for both branches (the shell's palette command and Ctrl/Cmd+/
  // route through it): engine mode flips the read-only source projection; the
  // legacy autosave editor switches its existing source mode — editable where
  // the .md on disk IS the source of truth, and read-only on shared or truncated
  // docs (shared views / truncated reads), so "view source" works everywhere
  // a markdown document renders.
  function toggleSourceView() {
    if (engineMode) {
      setShowSource((current) => !current);
      return;
    }
    if (surfaceMode === "source") {
      // Leaving editable source with an autosave still pending: flush the raw
      // draft first (header-toggle parity). Switching mode re-points
      // serializeDraftRef at the Tiptap parse, which is lossy for constructs
      // the editor doesn't model (e.g. HTML comments) — the late timer would
      // otherwise overwrite the file with that parse instead of the typed
      // source.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        void saveNow();
      }
      switchMode(readOnly ? "read" : "wysiwyg");
      return;
    }
    switchMode("source");
  }
  const toggleSourceViewRef = useRef(toggleSourceView);
  toggleSourceViewRef.current = toggleSourceView;
  const { registerSourceToggle } = props;
  useEffect(() => {
    if (!registerSourceToggle) return;
    registerSourceToggle(() => toggleSourceViewRef.current());
    return () => registerSourceToggle(null);
  }, [registerSourceToggle]);

  // Lift the save state to the shell (smallest seam): the active editor tab
  // shows a dirty dot while this is not "saved". When the engine owns the
  // surface (engine mode) its in-flight/settling state is the authoritative
  // dirty cue — the LOCAL saveState never leaves "saved" on the engine path,
  // so without lifting the engine state the tab dot would be dead while the
  // engine Y.Doc is still settling.
  useEffect(() => {
    if (!engine.available) {
      // The real save state only — a set-aside draft is deliberately not
      // lifted here. Lifting it as "error" made the shell's
      // save-first machinery promise a save the flush cannot deliver; the
      // shell reads the store itself for the tab dot instead.
      onSaveStateChange?.(saveState);
      return;
    }
    // Deletion is terminal: recovery owns any text worth keeping, and the
    // shell must not promise a flush to a path that no longer exists.
    onSaveStateChange?.(
      engine.saveState === "saved" ||
        engine.saveState === "saving" ||
        engine.saveState === "deleted"
        ? engine.saveState
        : "error",
    );
  }, [saveState, engine.available, engine.saveState, onSaveStateChange]);

  useEffect(() => {
    if (!readOnly) return;
    setMode("read");
  }, [readOnly]);

  async function writeDraftNow(
    options: {
      rejectOnError?: boolean;
      fromFlush?: boolean;
      textSnapshot?: string;
      captureOnFailure?: boolean;
      releaseUnusedDraft?: boolean;
    } = {},
  ): Promise<void> {
    if (flushBarrier.current && !options.fromFlush) {
      if (options.captureOnFailure && options.textSnapshot !== undefined) {
        captureLatestConflictDraft(options.textSnapshot);
        if (options.releaseUnusedDraft) props.localBuffer.releaseUnusedDraft();
      }
      return;
    }
    const enteredRevision = draftRevision.current;
    const run = async (): Promise<void> => {
      props.localBuffer.materializePendingDraft();
      if (
        enteredRevision <= blockedDraftRevision.current &&
        !props.localBuffer.getSnapshot().dirty
      ) {
        return;
      }
      const current = props.localBuffer.getSnapshot();
      if (
        activeLocalBuffer.current === props.localBuffer &&
        props.switchUnresyncedRef.current &&
        !switchReadPendingRef.current &&
        current.initialized &&
        current.contentHash === latestSnapshot.current.contentHash
      ) {
        props.switchUnresyncedRef.current = false;
      }
      // The refs, not captured values. The 800ms autosave timer holds the
      // closure from the render that armed it, where readOnly was false — so
      // a document that turned read-only after the keystroke still wrote.
      // And this runs after everything ahead of it in the queue, so
      // `readOnly`/`opening` may have flipped meanwhile; the refs carry the
      // current answer. Writes are blocked (a read-only view, or the version
      // refusal). The edit does not reach disk — and the indicator must stop
      // saying it is going to. Leaving it on "saving" is the same lie as a
      // doc reading "Saved" over a zero-byte file.
      //
      // The draft itself is still lost when the view is torn down in this
      // state: preserving the TEXT needs eager serialization, because
      // `serializeDraftRef` reads the live editor and a read-only window
      // unmounts it — a naive rearm here writes the PRE-EDIT body. The
      // `opening` window is different: its render-phase capture serialized
      // the draft eagerly and surfaced it, so this gate only refuses.
      if (writesBlocked() || openingRef.current) {
        if (props.localBuffer.getSnapshot().dirty) {
          props.localBuffer.markError();
        }
        if (options.captureOnFailure && options.textSnapshot !== undefined) {
          captureLatestConflictDraft(options.textSnapshot);
          if (options.releaseUnusedDraft) props.localBuffer.releaseUnusedDraft();
        }
        if (!unmounted.current) setSaveState("error");
        return;
      }
      // Mounted edits publish when they happen. Re-reading this pane's editor
      // after waiting in its local queue can be stale relative to a peer pane
      // that has since published a newer shared draft. Only an explicit
      // unmount snapshot is allowed to publish here because its editor is gone
      // and it has no earlier publish seam.
      if (options.textSnapshot !== undefined) {
        publishOwnedUnmountDraft(
          props.localBuffer,
          options.textSnapshot,
          localSource.current,
        );
      }
      const issuedBaseRequestId = baseContentRequestId.current;
      // Serialized here, not at enqueue: a writer that waited reads the
      // newest text, so an older queued write can never land over a newer one.
      const issuedRevision = draftRevision.current;
      unsavedDraft.current = false;
      if (!unmounted.current) setSaveState("saving");
      let issuedText: string | null = null;
      try {
        const writing = props.localBuffer.write(
          localSource.current,
          (text, expectedContentHash) => {
            issuedText = text;
            return bridge().writeWorkspaceText({
              workspaceId: props.workspaceId,
              relativePath: props.path,
              text,
              expectedContentHash,
            });
          },
        );
        if (options.releaseUnusedDraft) props.localBuffer.releaseUnusedDraft();
        const result = await writing;
        if (activeLocalBuffer.current !== props.localBuffer) {
          if (result.status === "conflict" || result.status === "no-baseline") {
            captureOrphanedDraft(props.workspaceId, props.path, result.body);
          }
          return;
        }
        const text = result.body;
        latestDraft.current = props.localBuffer.getSnapshot().body;
        if (result.status === "skipped") {
          baseContentHash.current = result.contentHash;
          if (!unmounted.current) setSaveState("saved");
          return;
        }
        if (result.status === "no-baseline") {
          unsavedDraft.current = true;
          if (options.captureOnFailure && options.textSnapshot !== undefined) {
            captureLatestConflictDraft(options.textSnapshot);
          }
          if (!unmounted.current) setSaveState("error");
          if (options.rejectOnError) {
            throw new Error("dohc cannot save this draft without a content hash.");
          }
          return;
        }
        if (result.status === "conflict") {
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          staleBaseline.current = true;
          flushConflict.current = true;
          conflictContentHash.current = result.currentContentHash;
          conflictRequestId.current = latestSnapshot.current.requestId;
          blockedDraftRevision.current = Math.max(
            blockedDraftRevision.current,
            draftRevision.current,
          );
          unsavedDraft.current = false;
          captureLatestConflictDraft();
          if (!unmounted.current) {
            setSaveState("error");
            reconcileConflictSnapshot();
          }
          if (options.rejectOnError) {
            throw new Error("The file changed on disk while dohc saved it.");
          }
          return;
        }
        baseContentHash.current = result.contentHash;
        acceptedRequestFloor.current = Math.max(
          acceptedRequestFloor.current,
          issuedBaseRequestId,
        );
        if (latestContentRequestId.current > issuedBaseRequestId) {
          verifyAfterRequestId.current = latestContentRequestId.current;
          if (!unmounted.current) {
            setSaveState("saving");
            props.refreshAfterConflict();
          }
          return;
        }
        if (!unmounted.current && draftRevision.current === issuedRevision) {
          setDraft(text);
          setSavedBody(text);
          setSaveState("saved");
        } else if (!unmounted.current && !unsavedDraft.current) {
          // The write queue cannot start a newer writer until this run returns.
          // A queued or pending local edit therefore keeps this flag set.
          setSaveState("saved");
        }
      } catch (error) {
        if (activeLocalBuffer.current !== props.localBuffer) {
          if (issuedText !== null) {
            captureOrphanedDraft(props.workspaceId, props.path, issuedText);
          }
          if (options.rejectOnError) throw error;
          return;
        }
        // The write failed: the draft is still unsaved, so the unmount flush
        // gets another shot at landing it.
        unsavedDraft.current = true;
        if (options.captureOnFailure && options.textSnapshot !== undefined) {
          captureLatestConflictDraft(options.textSnapshot);
        }
        if (!unmounted.current) setSaveState("error");
        if (options.rejectOnError) throw error;
      }
    };
    // Synchronous when the queue is idle. Callers like the source-mode toggle
    // serialize-then-switch-mode in one tick, and switching re-points
    // serializeDraftRef at the Tiptap parse — deferring the serialize by even
    // a microtask would write that lossy parse instead of the typed source.
    // Only a writer that must actually wait is deferred.
    const runsNow = writersLive.current === 0;
    writersLive.current += 1;
    const queued = (runsNow ? run() : writeChain.current.then(run)).finally(
      () => {
        writersLive.current -= 1;
        if (!unmounted.current) setWriterSettledEpoch((epoch) => epoch + 1);
      },
    );
    writeChain.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function saveNow(): Promise<void> {
    await writeDraftNow();
  }

  function onDraft(next: string) {
    if (readOnly) return;
    setDraft(next);
    latestDraft.current = next;
    scheduleSave("complete");
  }

  function onPropertiesDraft(next: string) {
    if (readOnly) return;
    const pending = props.localBuffer.materializePendingDraft();
    const combined = pending !== null
      ? mergeMarkdownEditorBody(next, markdownEditorBody(pending))
      : next;
    setDraft(combined);
    latestDraft.current = combined;
    if (mode === "read") setSavedBody(combined);
    scheduleSave("complete");
  }

  function scheduleSave(
    kind: "complete" | "wysiwyg",
    materializeWysiwyg?: () => string,
  ) {
    if (readOnly) return;
    if (kind === "wysiwyg") {
      const pending = {
        source: localSource.current,
        materialize: () => {
          const serialized = materializeWysiwyg
            ? mergeMarkdownEditorBody(
                latestDraft.current,
                materializeWysiwyg(),
              )
            : serializeDraftRef.current();
          latestDraft.current = serialized;
          return serialized;
        },
      };
      props.localBuffer.setPendingDraft(pending);
    } else {
      props.localBuffer.clearPendingDraft(localSource.current);
      props.localBuffer.publishDraft(latestDraft.current, localSource.current);
    }
    draftRevision.current += 1;
    unsavedDraft.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), AUTOSAVE_DEBOUNCE_MS);
  }

  function onLocalEditorFocus() {
    const pendingOwner = props.localBuffer.getPendingDraftSource();
    if (pendingOwner !== null && pendingOwner !== localSource.current) {
      props.localBuffer.materializePendingDraft();
    }
    const shared = props.localBuffer.getSnapshot();
    if (
      !shared.initialized ||
      shared.source === null ||
      shared.source === localSource.current ||
      shared.body === latestDraft.current
    ) {
      return;
    }
    const text = shared.body;
    latestDraft.current = text;
    bumpSourceValueRevision();
    setDraft(text);
    wysiwygRef.current?.replaceMarkdown(markdownEditorBody(text));
  }

  function switchMode(next: "read" | "wysiwyg" | "source") {
    // Read-only docs (shared views, truncated reads) still allow SOURCE — the
    // source editor is read-only, so it is a view, not an
    // edit surface (search jumps already force source mode this way). Only
    // the editable WYSIWYG mode is off-limits.
    if (readOnly && next === "wysiwyg") return;
    const pending = props.localBuffer.materializePendingDraft();
    const current =
      pending ??
      (mode === "wysiwyg" && !unsavedDraft.current
        ? latestDraft.current
        : serializeDraftRef.current());
    latestDraft.current = current;
    setDraft(current);
    setMode(next);
  }

  function toggleEditorMode() {
    // `opening` too, so Ctrl+/ answers the same as the disabled button.
    if (readOnly || opening) return;
    if (mode === "read") {
      // Large documents open in read mode because mounting the rich editor is
      // expensive. Keep that performance boundary when editing starts: source
      // mode handles the full draft without building a ProseMirror document.
      switchMode(
        props.body.length > WYSIWYG_MARKDOWN_THRESHOLD_BYTES
          ? "source"
          : "wysiwyg",
      );
      return;
    }
    if (mode === "wysiwyg") {
      switchMode("source");
      return;
    }
    switchMode("wysiwyg");
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "/") return;
      if (props.autoFocus === false) return;
      event.preventDefault();
      // Engine mode: the same keystroke drives the source-view toggle (the
      // legacy mode cycle is meaningless there — the CRDT editor is the only
      // editing surface). Read-only legacy docs get the source toggle too —
      // the edit-mode cycle is off-limits, viewing raw source is not.
      if (engineMode || readOnly) {
        toggleSourceView();
        return;
      }
      toggleEditorMode();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function openWikilink(target: string) {
    openWikilinkRef.current(target);
  }

  function openWorkspaceLink(target: WorkspaceLinkTarget) {
    openWorkspaceLinkRef.current(target);
  }

  // Unmount flush — silent loss is never acceptable. Closing/switching the
  // tab (the inspector is keyed by the active tab) unmounts mid-autosave;
  // clearing the timer alone would drop the draft. Fire the pending draft
  // write-through here: the component is gone, but the write (same bounded
  // IPC as saveNow) still lands and the watcher records it like any save.
  // props are stable for a mount (keyed remount per path), so the captured
  // workspaceId/path always belong to the draft being flushed.
  //
  // `readOnly` is READ FROM A REF and is deliberately not a dependency. As a
  // dependency it made every read-only transition run this cleanup with the
  // previous render's value captured, so turning the document read-only was
  // itself a write. The ref carries the current value to a real unmount.
  const { workspaceId, path, localBuffer } = props;
  useEffect(() => {
    unmounted.current = false;
    const retireAfterSettlement = () => {
      localBuffer.retireCapturedDraft(localSource.current);
      localBuffer.releaseUnusedDraft();
      void localBuffer.settled().then(() => {
        localBuffer.retireCapturedDraft(localSource.current);
        localBuffer.releaseUnusedDraft();
      });
    };
    return () => {
      unmounted.current = true;
      draftRevision.current += 1;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // `opening` too: unmounting mid-reopen must not land the
      // previous version's draft on the tree the reopen is binding.
      if (!unsavedDraft.current) {
        if (writersLive.current > 0) {
          void writeChain.current.then(() => {
            // A buffer-key replacement reuses this component and its refs.
            // Never consume the replacement version's draft from an older
            // cleanup callback; retire only the buffer captured above.
            if (activeLocalBuffer.current !== localBuffer) {
              retireAfterSettlement();
              return;
            }
            if (unsavedDraft.current) {
              unsavedDraft.current = false;
              captureOrphanedDraft(workspaceId, path, latestDraft.current);
            }
            retireAfterSettlement();
          });
        } else {
          // A reopen can capture and clear the local pending flag during
          // render. Finish that same captured buffer's retirement here; never
          // reach through to the replacement version's shared document.
          retireAfterSettlement();
        }
        return;
      }
      unsavedDraft.current = false;
      const text =
        localBuffer.materializePendingDraft() ??
        serializeDraftRef.current();
      // Same invariant as the plain-text hook:
      // a draft this unmount may not write is set aside rather than dropped.
      // The render-phase capture normally runs first, but it cannot when the
      // branch above replaces this view in the very commit that flips
      // `opening` — and this cleanup is already willing to write this exact
      // value, so keeping it can only be safer than losing it.
      //
      // Declared unpinned, and it stays that way after #564. No test enters
      // this branch with a draft the render-phase capture did not already
      // take: reaching it needs the engine open and the file read to land in
      // the same batch. Both conditions are conservative on purpose —
      // `openingRef` holds the last rendered value and `writesBlocked` reads
      // the parent's ref, so neither depends on this view living long enough
      // to observe the refusal. Kept as a backstop, not as covered code.
      const current = localBuffer.getSnapshot();
      if (
        activeLocalBuffer.current === localBuffer &&
        props.switchUnresyncedRef.current &&
        !switchReadPendingRef.current &&
        current.initialized &&
        current.contentHash === latestSnapshot.current.contentHash
      ) {
        props.switchUnresyncedRef.current = false;
      }
      if (writesBlocked() || openingRef.current) {
        captureOrphanedDraft(workspaceId, path, text);
        retireAfterSettlement();
        return;
      }
      // Join the same queue as every mounted save. The hash is read when this
      // task reaches the head, after any in-flight write has advanced it.
      // Capture the text now because the editor is gone before the task runs.
      latestDraft.current = text;
      const operationSettlement = flushInFlight.current;
      void writeDraftNow({
        textSnapshot: text,
        captureOnFailure: true,
        releaseUnusedDraft: true,
      }).then(() => {
        if (operationSettlement) {
          void operationSettlement.then(
            retireAfterSettlement,
            retireAfterSettlement,
          );
        } else {
          retireAfterSettlement();
        }
      });
    };
  }, [workspaceId, path, localBuffer]);

  // Imperative flush seam: the shell awaits this before an explorer op that
  // moves/deletes paths. A rename of the open file remounts the keyed
  // inspector after the disk rename — by then the unmount flush above writes
  // to the renamed-away old path (ENOENT, swallowed) and the draft is lost.
  // Flushing through here lands the keystrokes while the path still exists.
  const { registerDraftFlush } = props;
  const exitFlush = useRef<DraftFlush>(() => Promise.resolve());
  const exitCapturedDraft = useRef<{ revision: number; text: string } | null>(null);
  const captureStalledExit = useRef(() => {});
  captureStalledExit.current = () => {
    props.localBuffer.materializePendingDraft();
    capturedConflictDraft.current = null;
    captureFailedFlush();
    exitCapturedDraft.current = { revision: draftRevision.current, text: latestDraft.current };
  };
  useEffect(() => {
    const flushDraft: DraftFlush = (options) => {
      if (engineModeRef.current) {
        return flushEngineUpdatesRef.current();
      }
      if (flushInFlight.current) {
        const inFlight = flushInFlight.current;
        if (!options?.captureOnFailure) return inFlight;
        return inFlight.catch((error) => {
          captureFailedFlush();
          throw error;
        });
      }
      // A write already past the guards is the same obligation as an armed
      // timer: the caller is about to move paths or switch
      // versions, and must not proceed while the previous state's text is
      // still landing. If that write fails, `unsavedDraft` is true again by
      // the time this resumes, and the seam's own write below lands it before
      // the move.
      //
      // A BARRIER in the write queue, not a poll of it.
      // Arming and reading the tail are one synchronous step, so no writer
      // can slip between them.
      flushBarrier.current = true;
      const startedAfterUnmount = unmounted.current;
      props.localBuffer.materializePendingDraft();
      const localWritePending = writersLive.current > 0;
      const flush = (async () => {
        try {
          // Everything already enqueued — in flight OR parked behind it — runs
          // to completion ahead of this point, and nothing can join behind.
          await writeChain.current;
          if (!localWritePending) await props.localBuffer.settled();
          if (flushConflict.current) {
            throw new Error("The file changed on disk while dohc saved it.");
          }
          while (
            (unsavedDraft.current || props.localBuffer.getSnapshot().dirty) &&
            !startedAfterUnmount &&
            !writesBlocked() &&
            !openingRef.current
          ) {
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
            await writeDraftNow({ rejectOnError: true, fromFlush: true });
          }
          if (options?.captureOnFailure && unsavedDraft.current) captureFailedFlush();
          if (flushConflict.current) {
            throw new Error("The file changed on disk while dohc saved it.");
          }
        } catch (error) {
          if (options?.captureOnFailure) captureFailedFlush();
          throw error;
        } finally {
          flushBarrier.current = false;
          flushInFlight.current = null;
        }
      })();
      flushInFlight.current = flush;
      return flush;
    };
    registerDraftFlush?.(flushDraft);
    exitFlush.current = flushDraft;
    return () => registerDraftFlush?.(null);
    // writeDraftNow and this flush read mutable state through refs plus
    // per-mount-stable props, so the first closure stays correct for the mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush]);

  useEffect(() => registerPendingEditorDraft(
    () => !engineModeRef.current && (unsavedDraft.current || writersLive.current > 0) &&
      (exitCapturedDraft.current?.revision !== draftRevision.current ||
        exitCapturedDraft.current.text !== latestDraft.current),
    options => exitFlush.current(options),
    () => captureStalledExit.current(),
  ), []);

  // The restore half of #567: each set-aside draft stays copyable until the
  // user takes it or dismisses it. Rendered in both branches below — the
  // reopen can resolve into either editor.
  const documentNotices = (
    <>
      {engine.deletedWhileEditing ? (
        <DeletedWhileEditingNotice hasSetAsideEdit={hasSetAsideEdit} />
      ) : null}
      <OrphanedDraftNotices workspaceId={props.workspaceId} path={props.path} />
    </>
  );

  // Linked mentions live at the bottom of the document, inside the reading
  // measure, in every markdown branch (engine / wysiwyg / read). Hidden when a
  // file has none, so it only ever adds chrome when there's something to show.
  const backlinks = (
    <BacklinksPanel
      workspaceId={props.workspaceId}
      path={props.path}
      refreshKey={props.refreshKey}
      onOpenPath={props.onOpenPath}
      onOpenChatMention={props.onOpenChatMention}
      chatMentionsAvailable={props.chatMentionsAvailable}
    />
  );

  // Engine mode: the engine-native rich Y.Doc drives Tiptap (recordUpdate +
  // debounced settle in main; engine.db + the .md are the durable artifact).
  // There is no read/source/Edit gate here — the CRDT is canonical the whole
  // time the doc is open — but a settle indicator keeps the editing feel
  // unchanged, and undo/redo stays intact through the Collaboration extension's
  // Yjs UndoManager.
  // "Source" flips to a read-only projection of the Y.Doc's markdown — a VIEW,
  // never a second editing surface (see the showSource comment above).
  if (engine.available && engine.doc) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader
          icon={<FileText size={13} aria-hidden />}
          path={props.path}
          label={showSource ? "markdown source" : "document"}
          onShare={onShareCurrentPath}
          actions={
            <>
              <span
                data-testid="markdown-save-state"
                data-state={engineChipState}
                title={
                  engineChipState === "deleted" && hasSetAsideEdit
                    ? DELETED_WITH_SET_ASIDE_EDIT_NOTICE
                    : engineChipState === "error" && engine.saveError
                      ? engine.saveError
                      : engineChip.title
                }
                className={`font-mono text-[11px] ${
                  engineChipState === "saved" || engineChipState === "saving"
                    ? "text-subtle"
                    : "text-danger"
                }`}
              >
                {engineChip.label}
              </span>
              <button
                type="button"
                data-testid="markdown-source-toggle"
                aria-pressed={showSource}
                title="Toggle markdown source (Ctrl+/)"
                onClick={toggleSourceView}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                {showSource ? "Editor" : "Source"}
              </button>
              <DocumentMenu
                workspaceId={props.workspaceId}
                suggestedName={filenameStem(props.path)}
                // Always live, even in source view: the WYSIWYG editor stays
                // MOUNTED (hidden) while source is shown, so its ref keeps
                // serializing the current Y.Doc state at click time.
                getMarkdown={() => serializeEngineDraft()}
              />
            </>
          }
        />
        {props.truncatedNotice}
        {documentNotices}
        {showSource ? (
          // Raw markdown, monospaced and read-only — frontmatter included, so
          // the top-matter zone (which renders the same metadata as chrome)
          // steps aside, like the legacy editor's source mode.
          <div data-testid="view-markdown-source" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-line bg-panel px-4 py-1 text-[11px] text-subtle">
              <span>Read-only markdown source — switch back to Editor to make changes.</span>
              <CopyButton testId="markdown-source-copy" getText={() => sourceMarkdown} />
            </div>
            {sourceMarkdown === null ? (
              <div className="flex flex-1 items-center justify-center text-xs text-subtle">
                Loading source...
              </div>
            ) : (
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-xs text-subtle">
                    Loading source...
                  </div>
                }
              >
                <LazySourceCodeEditor
                  testId="markdown-source-view"
                  value={sourceMarkdown}
                  valueRevision={sourceMarkdown}
                  language="markdown"
                  path={props.path}
                  readOnly
                  onChange={() => undefined}
                  onSave={() => undefined}
                />
              </Suspense>
            )}
          </div>
        ) : null}
        {/* data-dohc-doc-pane: the whole pane is the editor's image drop zone,
            top-matter included — MarkdownEditor finds it with closest(). See
            the drop-zone comment in imagePaste.ts.

            Hidden (not unmounted) while source is shown: unmounting Tiptap
            destroys the Collaboration extension's Yjs UndoManager and the
            cursor/selection, and would leave the DocumentMenu serializing a
            stale mount-time body. The hidden editor stays bound to the Y.Doc,
            so toggling back restores the exact editing state. */}
        <div
          ref={engineDocPaneRef}
          data-testid="view-markdown"
          data-dohc-doc-pane=""
          hidden={showSource}
          className="min-h-0 flex-1 overflow-auto bg-bg text-[15px]"
        >
          {/* Title + inline properties are one top-matter zone (hovering it
              reveals the quiet "Add a property" affordance on empty docs). */}
          <div className="dohc-page-topmatter">
            <PageIdentity
              ydoc={engine.doc}
              filenameStem={filenameStem(props.path)}
              readOnly={readOnly}
              onEnterBody={() => wysiwygRef.current?.focus("start")}
            />
            {readOnly ? null : (
              <Suspense fallback={<PropertiesFallback />}>
                <LazyPropertiesPanel ydoc={engine.doc} />
              </Suspense>
            )}
            <FrontmatterComments ydoc={engine.doc} />
          </div>
          <EditorErrorBoundary
            resetKey={`${props.workspaceId}:${props.path}:${props.reopenKey}:engine`}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-subtle">
                  Loading editor...
                </div>
              }
            >
              <LazyMarkdownEditor
                ref={wysiwygRef}
                value={props.body}
                onDirty={() => undefined}
                workspaceId={props.workspaceId}
                path={props.path}
                knownFiles={knownFiles}
                onOpenWikilink={openWikilink}
                onOpenWorkspaceLink={openWorkspaceLink}
                headingTarget={props.headingTarget}
                blockTarget={jump?.kind === "block" ? jump : undefined}
                onBlockTargetConsumed={retireJump}
                pendingUndo={editorPendingUndo}
                onPendingUndoConsumed={props.onPendingUndoConsumed}
                readOnly={readOnly}
                collab={{
                  ydoc: engine.doc,
                  // Solo engine editing shows the settle indicator, not presence
                  // chrome — "disabled" hides the in-editor presence bar while the
                  // ydoc still drives Tiptap (collabActive keys off ydoc, not this).
                  status: "disabled",
                  peerCount: 0,
                  synced: true,
                }}
              />
              <MarkdownRenderCommitted onRendered={onMarkdownRendered} />
            </Suspense>
          </EditorErrorBoundary>
          {backlinks}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        icon={<FileText size={13} aria-hidden />}
        path={props.path}
        label="document"
        onShare={onShareCurrentPath}
        actions={
          <>
            {/* The wait has its own word: an opening document is not a
                saved one, and dohc has not decided about it yet. Read mode
                hides the "Saved" idle chip, but PageIdentity stays editable
                there and autosaves title/icon edits — so a pending or failed
                save (saveState !== "saved") must surface even when not
                `editing`, or a failed title/icon save is invisible while the
                optimistic value keeps showing. */}
            {opening ? (
              <span
                data-testid="markdown-open-state"
                data-state="opening"
                // The same sentence as the disabled button's, because a
                // browser does not reliably draw a tooltip over a disabled
                // control. This span is not disabled, so hovering the state
                // always explains it.
                title="You can edit this document when it finishes opening."
                className="font-mono text-[11px] text-subtle"
              >
                Opening…
              </span>
            ) : null}
            {/* Independent of "Opening…", not its else-branch: a save
                that fails inside the opening window must still surface. While
                opening, `editing` is always false, so the chip appears there
                only when the state is not "saved". */}
            {editing || chipState !== "saved" ? (
              <span
                data-testid="markdown-save-state"
                data-state={chipState}
                title={
                  chipState === "recovery"
                    ? "A set-aside edit is not saved. Copy or dismiss it in the notice below."
                    : undefined
                }
                className={`font-mono text-[11px] ${
                  chipState === "error" || chipState === "recovery"
                    ? "text-danger"
                    : "text-subtle"
                }`}
              >
                {chipState === "saved"
                  ? "Saved"
                  : chipState === "saving"
                    ? "Saving…"
                    : chipState === "recovery"
                      ? "Edit set aside"
                      : "Couldn't save"}
              </span>
            ) : null}
            <button
              type="button"
              data-testid="markdown-edit-toggle"
              disabled={readOnly || opening}
              title={
                opening
                  ? "You can edit this document when it finishes opening."
                  : undefined
              }
              onClick={() => {
                if (readOnly || opening) return;
                if (mode === "source" && saveTimer.current) {
                  clearTimeout(saveTimer.current);
                  void saveNow();
                }
                toggleEditorMode();
              }}
              className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {surfaceMode === "read" ? "Edit" : surfaceMode === "wysiwyg" ? "Source" : "WYSIWYG"}
            </button>
            {/* A truncated doc only loaded a bounded prefix into
                serializeDraftRef — copying/exporting it would silently emit a
                partial document. Hide the menu until the full file is loaded
                (same gate as the inline properties below). */}
            {!props.truncated ? (
              <DocumentMenu
                workspaceId={props.workspaceId}
                suggestedName={filenameStem(props.path)}
                // The same rule the engine branch answers to: emit the
                // document, or refuse. This branch shows the disk, and until
                // the engine open answers there is no telling whether the
                // disk is the document — a session that binds a moment later
                // may hold replicated updates the file has never seen (#564,
                // codex r19/r21). Refuse for the whole unresolved window,
                // which the editor beside this menu already spends read-only
                // or opening. The refusal reads "Document not open", and the
                // notice below offers the retry that resolves it.
                //
                // `opening` is the wait and `engineMayHoldDocument` is the
                // wait giving up; both mean the same thing to an export. Once
                // the open answers "not engine-backed", the file IS the
                // document and this lifts.
                getMarkdown={() =>
                  engine.opening || engine.engineMayHoldDocument
                    ? null
                    : serializeDraftRef.current()
                }
              />
            ) : null}
          </>
        }
      />
      {props.truncatedNotice}
      {/* "Try again" after a timed-out open. It retries and nothing
          else: the retry changes the request key, so `opening` flips true in
          that same render and the capture above sets a draft typed before the
          timeout aside — where the user can copy it — instead of letting it
          reach disk over the artifact the engine is binding. */}
      {engine.engineMayHoldDocument || engine.liveHostUnavailable ? (
        <EngineMayHoldDocumentNotice onRetry={props.onRetryEngineOpen} contentShown />
      ) : null}
      {engine.removalInProgress ? (
        <EngineRemovalInProgressNotice
          removal={engine.removalInProgress}
          onRetry={props.onRetryEngineOpen}
        />
      ) : null}
      {documentNotices}
      {surfaceMode === "source" ? (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-subtle">
              Loading editor...
            </div>
          }
        >
          <LazySourceCodeEditor
            testId="markdown-editor"
            value={draft}
            valueRevision={sourceValueRevision}
            language="markdown"
            path={props.path}
            readOnly={readOnly}
            autoFocus={props.autoFocus ?? true}
            scrollLine={jump?.kind === "line" ? jump.line : undefined}
            pendingUndo={props.pendingUndo}
            onPendingUndoConsumed={props.onPendingUndoConsumed}
            onFocus={onLocalEditorFocus}
            onScrollLineApplied={() => setJump(null)}
            onChange={onDraft}
            onSave={() => {
              if (saveTimer.current) clearTimeout(saveTimer.current);
              void saveNow();
            }}
          />
          <MarkdownRenderCommitted onRendered={onMarkdownRendered} />
        </Suspense>
      ) : surfaceMode === "wysiwyg" ? (
        // data-dohc-doc-pane: see the note on the engine pane above.
        <div
          ref={localDocPaneRef}
          data-testid="view-markdown"
          data-dohc-doc-pane=""
          className="min-h-0 flex-1 overflow-auto bg-bg text-[15px]"
        >
          <div className="dohc-page-topmatter">
            <PageIdentity
              body={draft}
              onChange={onPropertiesDraft}
              filenameStem={filenameStem(props.path)}
              readOnly={readOnly}
              onEnterBody={() => wysiwygRef.current?.focus("start")}
            />
            {!readOnly ? (
              <Suspense fallback={<PropertiesFallback />}>
                <LazyPropertiesPanel body={draft} onChange={onPropertiesDraft} />
              </Suspense>
            ) : null}
            <FrontmatterComments markdown={draft} />
          </div>
          <EditorErrorBoundary
            resetKey={`${props.workspaceId}:${props.path}:${props.reopenKey}:local`}
          >
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-subtle">
                  Loading editor...
                </div>
              }
            >
              <LazyMarkdownEditor
                key={wysiwygResyncEpoch}
                ref={wysiwygRef}
                value={markdownEditorBody(draft)}
                onDirty={(materialize) =>
                  scheduleSave("wysiwyg", materialize)
                }
                onFocus={onLocalEditorFocus}
                workspaceId={props.workspaceId}
                path={props.path}
                knownFiles={knownFiles}
                onOpenWikilink={openWikilink}
                onOpenWorkspaceLink={openWorkspaceLink}
                headingTarget={props.headingTarget}
                pendingUndo={editorPendingUndo}
                onPendingUndoConsumed={props.onPendingUndoConsumed}
                readOnly={readOnly}
                collab={null}
              />
              <MarkdownRenderCommitted onRendered={onMarkdownRendered} />
            </Suspense>
          </EditorErrorBoundary>
          {backlinks}
        </div>
      ) : props.truncated ? (
        // A truncated read is already a bounded prefix and is permanently
        // read-only. Rendering that prefix as rich Markdown used to schedule
        // every remaining block for idle backfill, growing a 3 MiB document
        // past 136,000 DOM nodes after the first window painted. CodeMirror
        // keeps the source readable with a viewport-bounded DOM and makes the
        // partial-file boundary explicit instead of presenting it as a whole
        // rich document. Keep view-markdown: callers use it as the mounted
        // document surface regardless of which read representation owns it.
        <div data-testid="view-markdown" className="flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center text-xs text-subtle">
                Loading source...
              </div>
            }
          >
            <LazySourceCodeEditor
              testId="markdown-source-view"
              value={props.body}
              valueRevision={props.contentReadTicket}
              language="markdown"
              path={props.path}
              readOnly
              onChange={() => undefined}
              onSave={() => undefined}
            />
            <MarkdownRenderCommitted onRendered={onMarkdownRendered} />
          </Suspense>
          {backlinks}
        </div>
      ) : (
        <div
          ref={localDocPaneRef}
          data-testid="view-markdown"
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="dohc-page-topmatter">
            {/* Title, icon and properties autosave through the same disk write
                as the body, so the opening refusal covers them too. */}
            <PageIdentity
              body={draft}
              onChange={onPropertiesDraft}
              filenameStem={filenameStem(props.path)}
              readOnly={readOnly || opening}
            />
            {!readOnly && !opening ? (
              <Suspense fallback={<PropertiesFallback />}>
                <LazyPropertiesPanel body={draft} onChange={onPropertiesDraft} />
              </Suspense>
            ) : null}
            <FrontmatterComments markdown={draft} />
          </div>
          <div
            ref={readDocumentRef}
            className="dohc-readable-text p-6 text-[15px]"
          >
            {renderedDocument}
          </div>
          {backlinks}
        </div>
      )}
    </div>
  );
}
