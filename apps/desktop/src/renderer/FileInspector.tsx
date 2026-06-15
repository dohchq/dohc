import {
  FileText,
  Image as ImageIcon,
  Music,
  Share2,
  SlidersHorizontal,
  Table,
} from "lucide-react";
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type LazyExoticComponent,
  type RefAttributes,
} from "react";
import { rendererMarks } from "../performance/rendererMarks";
import { IncrementalMarkdownDocument } from "./markdown/IncrementalMarkdownDocument";
import { bridge } from "./bridge";
import { useCollabDoc } from "./collab/useCollabDoc";
import { parseFrontmatter } from "./markdown/frontmatter";
import type {
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from "./editor/MarkdownEditor";
import type { PropertiesPanelProps } from "./PropertiesPanel";
import type { WikilinkFile } from "./editor/wikilinkPlugin";

// Builds the privileged URL the dohc-file protocol serves bytes from. The
// main process resolves <workspaceId> to a real workspace root and enforces
// path containment, so this URL can't escape the workspace.
function assetUrl(workspaceId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `dohc-file://${workspaceId}/${encoded}`;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

// A search result landing in the editor (Phase E5.0). nonce distinguishes
// repeated jumps to the same path+line; the shell clears the target once a
// mounted view consumed it, so later plain opens of the same file never
// re-trigger the jump.
export interface ScrollTarget {
  path: string;
  line: number;
  nonce: number;
}

// [start, end) character span of 1-based `line` within `text` (end excludes
// the newline). Lines past the end clamp to the last line. Pure — unit
// tested; the editor uses it to select the landed-on line.
export function lineSpanInText(
  text: string,
  line: number,
): { start: number; end: number } {
  let start = 0;
  let current = 1;
  while (current < line) {
    const nextBreak = text.indexOf("\n", start);
    if (nextBreak === -1) break;
    start = nextBreak + 1;
    current += 1;
  }
  const lineEnd = text.indexOf("\n", start);
  return { start, end: lineEnd === -1 ? text.length : lineEnd };
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "wav", "ogg"]);
const DB_EXT = new Set(["sqlite", "sqlite3", "db"]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "csv", "json", "html", "tsx", "ts", "css", "js"]);
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
const LazyDatabaseStudioView = lazy(() =>
  import("./DatabaseStudioView").then((mod) => ({
    default: mod.DatabaseStudioView,
  })),
);
const LazyAppPackageView = lazy(() =>
  import("./AppPackageView").then((mod) => ({
    default: mod.AppPackageView,
  })),
);

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

export function mergeMarkdownEditorBody(sourceMarkdown: string, body: string): string {
  const split = splitRawFrontmatter(sourceMarkdown);
  if (!split.frontmatter) return body;
  const separator = split.body.startsWith("\n") && !body.startsWith("\n") ? "\n" : "";
  return `${split.frontmatter}${separator}${body}`;
}

export type FileViewKind =
  | "markdown"
  | "csv"
  | "json"
  | "text"
  | "image"
  | "audio"
  | "pdf"
  | "database"
  | "app-source"
  | "binary";

// Pure classifier: every file resolves to exactly one view kind. Exported so
// the E2E and unit tests pin the dispatch table directly.
export function classifyForView(path: string): FileViewKind {
  if (path.includes("/.apps/") || path.startsWith(".apps/")) return "app-source";
  const ext = extensionOf(path);
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
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
) {
  const [text, setText] = useState<string | null>(null);
  // Which path `text` belongs to. Consumers must not render text under a
  // different path: switching files otherwise shows the PREVIOUS file's
  // content under the new header for one render (and corrupts the
  // open-latency measure with a near-zero stale sample).
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(false);
  const lastPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Blank only when switching FILES — an activity refresh of the open file
    // swaps content in place instead of flashing the document away.
    if (lastPathRef.current !== path) {
      lastPathRef.current = path;
      setText(null);
      setError(false);
    }
    void bridge()
      .readWorkspaceText({ workspaceId, relativePath: path })
      .then((r) => {
        if (cancelled) return;
        setText(r.text);
        setLoadedPath(path);
        setTruncated(r.truncated);
        setError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setText(null);
        setError(true);
      });
    return () => {
      cancelled = true;
    };
    // refreshKey bumps on workspace activity so an open file re-reads when it
    // changes on disk (e.g. an agent edits it).
  }, [workspaceId, path, enabled, refreshKey]);
  return { text, loadedPath, truncated, error };
}

// `actions` puts a view's controls (edit toggle, save state, presence) in the
// ONE document header — views never stack a second near-empty toolbar.
function ViewHeader(props: {
  icon: React.ReactNode;
  path: string;
  label: string;
  onShare?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[13px]">
      {props.icon}
      <span className="font-mono text-ink">{props.path}</span>
      <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">
        {props.label}
      </span>
      {props.onShare ? (
        <button
          type="button"
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={props.onShare}
          className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <Share2 size={13} aria-hidden />
        </button>
      ) : null}
      {props.actions}
    </header>
  );
}

function PropertiesFallback() {
  return (
    <div className="border-b border-line bg-panel px-4 py-2 text-[11px] text-subtle">
      Loading properties...
    </div>
  );
}

// Rendered markdown document — headings, lists, code, emphasis read as a
// document, not raw source. react-markdown renders to React nodes (no raw
// HTML execution); links render as inert styled text since the renderer's
// navigation is locked down (external open is an explicit affordance instead).
const MARKDOWN_COMPONENTS = {
  h1: (p: { children?: React.ReactNode }) => (
    <h1 className="mb-3 mt-1 text-2xl font-semibold tracking-tight text-ink">{p.children}</h1>
  ),
  h2: (p: { children?: React.ReactNode }) => (
    <h2 className="mb-2 mt-4 text-xl font-semibold tracking-tight text-ink">{p.children}</h2>
  ),
  h3: (p: { children?: React.ReactNode }) => (
    <h3 className="mb-1.5 mt-3 text-base font-semibold text-ink">{p.children}</h3>
  ),
  p: (p: { children?: React.ReactNode }) => (
    <p className="mb-3 leading-relaxed text-ink">{p.children}</p>
  ),
  ul: (p: { children?: React.ReactNode }) => (
    <ul className="mb-3 list-disc pl-5 text-ink">{p.children}</ul>
  ),
  ol: (p: { children?: React.ReactNode }) => (
    <ol className="mb-3 list-decimal pl-5 text-ink">{p.children}</ol>
  ),
  code: (p: { children?: React.ReactNode }) => (
    <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[13px]">{p.children}</code>
  ),
  a: (p: { children?: React.ReactNode }) => (
    <span className="text-accent underline">{p.children}</span>
  ),
};

// Document + source-mode editor. Edits autosave on a short settle (and
// Ctrl/Cmd+S) through the bounded write IPC; the watcher then records the
// change into history like any other file change — the editor is just another
// writer, never a privileged one. Live co-editing (Yjs) layers onto this
// surface for shared workspaces in the collab step.
function MarkdownView(props: {
  body: string;
  workspaceId: string;
  path: string;
  truncated?: boolean;
  truncatedNotice?: React.ReactNode;
  // A pending search-result jump for this path (Phase E5.0).
  scrollTarget?: ScrollTarget;
  onOpenPath?: (path: string) => void;
  onSharePath?: (path: string) => void;
  onSaveStateChange?: (state: "saved" | "saving" | "error") => void;
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [mode, setMode] = useState<"read" | "wysiwyg" | "source">(() =>
    props.body.length <= WYSIWYG_MARKDOWN_THRESHOLD_BYTES ? "wysiwyg" : "read",
  );
  const [draft, setDraft] = useState(props.body);
  const [savedBody, setSavedBody] = useState(props.body);
  const [knownFiles, setKnownFiles] = useState<WikilinkFile[]>([]);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  // Search lands HERE (Phase E5.0): the rendered document has no per-line DOM
  // to anchor, so the smallest honest seam is opening SOURCE mode and
  // selecting the matched line. Phase E4's WYSIWYG editor takes this seam
  // over with a real in-document scroll-to-position once it owns the surface.
  const [pendingScrollLine, setPendingScrollLine] = useState<number | null>(null);
  const scrollTargetNonce = props.scrollTarget?.nonce;
  useEffect(() => {
    if (!props.scrollTarget || props.scrollTarget.path !== props.path) return;
    setMode("source");
    setPendingScrollLine(props.scrollTarget.line);
    // Applied once per jump: nonce is the identity of one click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTargetNonce]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const wysiwygRef = useRef<MarkdownEditorHandle | null>(null);
  const latestDraft = useRef(props.body);
  const serializeDraftRef = useRef<() => string>(() => props.body);
  const editing = mode !== "read";

  serializeDraftRef.current = () => {
    if (mode === "wysiwyg" && !propertiesOpen) {
      const body = wysiwygRef.current?.getMarkdown() ?? markdownEditorBody(draft);
      return mergeMarkdownEditorBody(latestDraft.current, body);
    }
    return latestDraft.current;
  };

  useEffect(() => {
    if (mode === "read") void loadMarkdownEditor();
  }, [mode, props.path]);

  useEffect(() => {
    if (pendingScrollLine === null || mode !== "source") return;
    const textarea = editorRef.current;
    if (!textarea) return;
    const { start, end } = lineSpanInText(textarea.value, pendingScrollLine);
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    textarea.scrollTop = Math.max(
      0,
      (pendingScrollLine - 1) * lineHeight - textarea.clientHeight / 3,
    );
    setPendingScrollLine(null);
  }, [pendingScrollLine, mode]);

  useEffect(() => {
    let cancelled = false;
    void bridge()
      .listWorkspaceFiles({ workspaceId: props.workspaceId })
      .then((result) => {
        if (cancelled) return;
        setKnownFiles(
          result.files
            .filter((file) => /\.(md|markdown)$/i.test(file.path))
            .map((file) => {
              const pathNoExt = file.path.replace(/\.md$/i, "");
              return {
                path: file.path,
                title: pathNoExt.split("/").pop() ?? file.path,
                fileId: null,
              };
            }),
        );
      })
      .catch(() => {
        if (!cancelled) setKnownFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId]);

  // Lift the save state to the shell (smallest seam): the active editor tab
  // shows a dirty dot while this is not "saved".
  const { onSaveStateChange } = props;
  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the keystroke until a write for that draft has been ISSUED.
  // The unmount flush keys off this — never off the timer handle, which stays
  // set (already fired) after a completed autosave and would double-write.
  const unsavedDraft = useRef(false);

  // Parse-once + visible-first (Phase 16): the memo stops re-parses on
  // unrelated re-renders (collab status flips, save-state ticks), and the
  // incremental document commits only the opening window up front, idle-
  // backfilling the rest — a 250KB doc opens in tens of ms, not ~575ms.
  const renderedDocument = useMemo(
    () => (
      <IncrementalMarkdownDocument body={savedBody} components={MARKDOWN_COMPONENTS} />
    ),
    [savedBody],
  );
  const onShareCurrentPath = props.onSharePath
    ? () => props.onSharePath?.(props.path)
    : undefined;

  // Live co-editing only ever activates for SHARED cloud workspaces with a
  // signed-in session (the collabToken IPC returns available:false otherwise).
  // When it does, Tiptap is driven by the shared rich Y.Doc instead of the
  // local autosave path — personal/local-only stays byte-identical to today.
  const collab = useCollabDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    // The on-disk text so the collab session can reconcile external changes
    // (agent edits, sync pulls) into the live doc instead of clobbering them.
    onDiskText: props.body,
    enabled: !props.truncated,
  });

  useEffect(() => {
    if (props.truncated && !collab.enabled) setPropertiesOpen(false);
  }, [props.truncated, collab.enabled]);

  // Performance measure: MarkdownView only mounts once the document body is
  // loaded, so this post-commit effect brackets click → IPC read → markdown
  // parse → rendered document.
  useEffect(() => {
    rendererMarks.measureSince("markdown-open", "file-open-start");
    // Last-wins: readers poll this epoch to know the measure above belongs to
    // the open they triggered (never a stale value from the previous file).
    rendererMarks.mark("markdown-opened");
  }, [props.path]);

  // External changes (agent edits, sync pulls) flow into the open document
  // only while NOT editing — mid-edit, the user's draft wins until saved.
  useEffect(() => {
    if (!editing) {
      setDraft(props.body);
      setSavedBody(props.body);
      latestDraft.current = props.body;
    }
  }, [props.body, editing]);

  async function saveNow(): Promise<void> {
    const text = serializeDraftRef.current();
    latestDraft.current = text;
    unsavedDraft.current = false;
    setSaveState("saving");
    try {
      await bridge().writeWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.path,
        text,
      });
      setDraft(text);
      setSavedBody(text);
      setSaveState("saved");
    } catch {
      // The write failed: the draft is still unsaved, so the unmount flush
      // gets another shot at landing it.
      unsavedDraft.current = true;
      setSaveState("error");
    }
  }

  function onDraft(next: string) {
    setDraft(next);
    latestDraft.current = next;
    scheduleSave();
  }

  function onPropertiesDraft(next: string) {
    setDraft(next);
    latestDraft.current = next;
    if (mode === "read") setSavedBody(next);
    scheduleSave();
  }

  function scheduleSave() {
    unsavedDraft.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 800);
  }

  function switchMode(next: "read" | "wysiwyg" | "source") {
    const current =
      mode === "wysiwyg" && !unsavedDraft.current
        ? latestDraft.current
        : serializeDraftRef.current();
    latestDraft.current = current;
    setDraft(current);
    if (next !== "source" && propertiesOpen && !collab.enabled) {
      setPropertiesOpen(false);
    }
    setMode(next);
  }

  function toggleEditorMode() {
    if (mode === "read") {
      switchMode("wysiwyg");
      return;
    }
    if (mode === "wysiwyg") {
      switchMode("source");
      return;
    }
    switchMode("wysiwyg");
  }

  function togglePropertiesPanel() {
    const opening = !propertiesOpen;
    if (opening && props.truncated && !collab.enabled) return;
    if (opening && mode !== "source" && !collab.enabled) {
      switchMode("source");
    }
    setPropertiesOpen(opening);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "/") return;
      event.preventDefault();
      toggleEditorMode();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function openWikilink(target: string) {
    const normalized = target.replace(/\.md$/i, "");
    const match =
      knownFiles.find((file) => file.path.replace(/\.md$/i, "") === normalized) ??
      knownFiles.find((file) => file.path === target);
    props.onOpenPath?.(match?.path ?? `${normalized}.md`);
  }

  // Unmount flush — silent loss is never acceptable. Closing/switching the
  // tab (the inspector is keyed by the active tab) unmounts mid-autosave;
  // clearing the timer alone would drop the draft. Fire the pending draft
  // write-through here: the component is gone, but the write (same bounded
  // IPC as saveNow) still lands and the watcher records it like any save.
  // props are stable for a mount (keyed remount per path), so the captured
  // workspaceId/path always belong to the draft being flushed.
  const { workspaceId, path } = props;
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!unsavedDraft.current) return;
      unsavedDraft.current = false;
      const text = serializeDraftRef.current();
      void bridge()
        .writeWorkspaceText({
          workspaceId,
          relativePath: path,
          text,
        })
        .catch(() => undefined);
    };
  }, [workspaceId, path]);

  // Imperative flush seam: the shell awaits this BEFORE an explorer op that
  // moves/deletes paths. A rename of the open file remounts the keyed
  // inspector AFTER the disk rename — by then the unmount flush above writes
  // to the renamed-away OLD path (ENOENT, swallowed) and the draft is lost.
  // Flushing through here lands the keystrokes while the path still exists.
  const { registerDraftFlush } = props;
  useEffect(() => {
    if (!registerDraftFlush) return;
    registerDraftFlush(async () => {
      if (!unsavedDraft.current) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await saveNow();
    });
    return () => registerDraftFlush(null);
    // saveNow reads refs (latestDraft) + per-mount-stable props only, so the
    // first render's closure stays correct for the whole mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush]);

  // Materialization of the converged CRDT back to the file lives inside
  // useCollabDoc, gated on sync and routed through the canonical-state model
  // (collabSession.ts) so a stale/empty doc folds the on-disk text in rather
  // than clobbering it — never a blind write of the live text over the file.

  // Collab mode: the shared rich Y.Doc drives Tiptap. There is no local save
  // state (the CRDT is canonical; main materializes to disk at settle points),
  // so the toolbar shows live presence instead. Co-editing has no separate
  // "Edit" gate once the provider has synced.
  if (collab.enabled && collab.ydoc) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader
          icon={<FileText size={13} aria-hidden />}
          path={props.path}
          label="document"
          onShare={onShareCurrentPath}
          actions={
            <>
              <button
                type="button"
                data-testid="markdown-properties-toggle"
                aria-label="Toggle properties"
                title="Toggle properties"
                onClick={togglePropertiesPanel}
                className={`grid size-6 place-items-center rounded ${
                  propertiesOpen
                    ? "bg-line/60 text-ink"
                    : "text-subtle hover:bg-line/50 hover:text-ink"
                }`}
              >
                <SlidersHorizontal size={13} aria-hidden />
              </button>
              <span
                data-testid="collab-presence"
                data-peer-count={collab.peerCount}
                className="flex items-center gap-1 text-[11px] text-accent"
              >
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-success"
                />
                {collab.peerCount === 0
                  ? "Live · just you"
                  : `${collab.peerCount + 1} editing`}
              </span>
            </>
          }
        />
        {propertiesOpen ? (
          <Suspense fallback={<PropertiesFallback />}>
            <LazyPropertiesPanel ydoc={collab.ydoc} />
          </Suspense>
        ) : null}
        {props.truncatedNotice}
        <div
          data-testid="view-markdown"
          className="min-h-0 flex-1 overflow-auto bg-bg text-[15px]"
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
              collab={{
                ydoc: collab.ydoc,
                status: collab.status,
                peerCount: collab.peerCount,
                synced: collab.synced,
              }}
            />
          </Suspense>
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
            {editing ? (
              <span
                data-testid="markdown-save-state"
                data-state={saveState}
                className={`text-[11px] ${saveState === "error" ? "text-danger" : "text-subtle"}`}
              >
                {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Couldn't save"}
              </span>
            ) : null}
            {!props.truncated ? (
              <button
                type="button"
                data-testid="markdown-properties-toggle"
                aria-label="Toggle properties"
                title="Toggle properties"
                onClick={togglePropertiesPanel}
                className={`grid size-6 place-items-center rounded ${
                  propertiesOpen
                    ? "bg-line/60 text-ink"
                    : "text-subtle hover:bg-line/50 hover:text-ink"
                }`}
              >
                <SlidersHorizontal size={13} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              data-testid="markdown-edit-toggle"
              onClick={() => {
                if (mode === "source" && saveTimer.current) {
                  clearTimeout(saveTimer.current);
                  void saveNow();
                }
                toggleEditorMode();
              }}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
            >
              {mode === "read" ? "Edit" : mode === "wysiwyg" ? "Source" : "WYSIWYG"}
            </button>
          </>
        }
      />
      {propertiesOpen && !props.truncated ? (
        <Suspense fallback={<PropertiesFallback />}>
          <LazyPropertiesPanel
            body={latestDraft.current}
            onChange={onPropertiesDraft}
          />
        </Suspense>
      ) : null}
      {props.truncatedNotice}
      {mode === "source" ? (
        <textarea
          data-testid="markdown-editor"
          ref={editorRef}
          autoFocus
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              if (saveTimer.current) clearTimeout(saveTimer.current);
              void saveNow();
            }
          }}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-bg p-6 font-mono text-[14px] leading-relaxed text-ink outline-none"
        />
      ) : mode === "wysiwyg" ? (
        <div
          data-testid="view-markdown"
          className="min-h-0 flex-1 overflow-auto bg-bg text-[15px]"
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
              value={markdownEditorBody(draft)}
              onDirty={scheduleSave}
              workspaceId={props.workspaceId}
              path={props.path}
              knownFiles={knownFiles}
              onOpenWikilink={openWikilink}
              collab={null}
            />
          </Suspense>
        </div>
      ) : (
        <div
          data-testid="view-markdown"
          className="min-h-0 flex-1 overflow-auto p-6 text-[15px]"
        >
          {renderedDocument}
        </div>
      )}
    </div>
  );
}

// Derives where a CSV/JSON import materializes: a sibling .sqlite, table named
// after the file. Keeps the import one click and the result next to its source.
function deriveImportTarget(sourcePath: string): { dbPath: string; tableName: string } {
  const slash = sourcePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : sourcePath.slice(0, slash + 1);
  const base = sourcePath.slice(slash + 1).replace(/\.[^.]+$/, "");
  const tableName = base.replace(/[^a-zA-Z0-9_]/g, "_") || "imported";
  return { dbPath: `${dir}${base}.sqlite`, tableName };
}

function CsvView({
  body,
  workspaceId,
  path,
  onOpenPath,
}: {
  body: string;
  workspaceId: string;
  path: string;
  onOpenPath?: (path: string) => void;
}) {
  const [raw, setRaw] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      body
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => line.split(",")),
    [body],
  );
  const [header, ...data] = rows;
  // Bounded preview (Phase 16): an unbounded <table> over 10,000+ rows
  // freezes the renderer for tens of seconds. The first rows are enough to
  // inspect a CSV; working with all of them is what Import to SQLite is for.
  const MAX_PREVIEW_ROWS = 500;
  const previewRows = data.length > MAX_PREVIEW_ROWS ? data.slice(0, MAX_PREVIEW_ROWS) : data;

  async function importToSqlite() {
    if (importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const { dbPath, tableName } = deriveImportTarget(path);
      const result = await bridge().importToDatabase({
        workspaceId,
        sourceRelativePath: path,
        databaseRelativePath: dbPath,
        tableName,
      });
      onOpenPath?.(result.path);
    } catch (cause) {
      // Most common: the target database already exists (import never
      // overwrites a canonical file). Tell the user instead of failing mute.
      const message = cause instanceof Error ? cause.message : String(cause);
      setImportError(/already exists/i.test(message) ? "Database already exists" : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="view-csv">
      <div className="flex items-center justify-end gap-1 border-b border-line px-3 py-1">
        {importError ? (
          <span data-testid="csv-import-error" className="px-1 text-[11px] text-danger">
            {importError}
          </span>
        ) : null}
        {onOpenPath ? (
          <button
            type="button"
            onClick={() => void importToSqlite()}
            disabled={importing}
            className="rounded px-2 py-0.5 text-[11px] text-subtle hover:text-ink disabled:opacity-50"
            data-testid="csv-import-sqlite"
          >
            {importing ? "Importing…" : "Import to SQLite"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setRaw((r) => !r)}
          className="rounded px-2 py-0.5 text-[11px] text-subtle hover:text-ink"
          data-testid="csv-raw-toggle"
        >
          {raw ? "Table" : "Raw"}
        </button>
      </div>
      {raw ? (
        <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[13px] text-ink">
          {body}
        </pre>
      ) : !header ? (
        <Empty>Empty table</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {header.map((cell, i) => (
                  <th
                    key={i}
                    className="border border-line bg-panel-2 px-2 py-1 text-left font-medium"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-line px-2 py-1">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.length > previewRows.length ? (
            <p
              data-testid="csv-preview-bound"
              className="mb-0 mt-2 text-[11px] text-subtle"
            >
              Showing the first {MAX_PREVIEW_ROWS} of {data.length} rows — import
              to SQLite to work with all of them.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ImageView({ url, path }: { url: string; path: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const name = path.split("/").pop() ?? path;
  // Reset load state when switching to a different image, so stale
  // dimensions/error from the previous file don't linger.
  useEffect(() => {
    setDims(null);
    setFailed(false);
  }, [url]);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="view-image">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        {failed ? (
          <span className="text-sm text-subtle">Couldn't load this image.</span>
        ) : (
          // Checkerboard frame so a transparent or tiny image still reads as
          // "an image", not an empty pane.
          <div className="rounded border border-line bg-[repeating-conic-gradient(#0000000a_0_25%,transparent_0_50%)] [background-size:16px_16px] p-2">
            <img
              src={url}
              alt={name}
              className="block max-h-[60vh] max-w-full"
              style={{ minWidth: 48, minHeight: 48 }}
              onLoad={(e) =>
                setDims({
                  w: e.currentTarget.naturalWidth,
                  h: e.currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      <div className="border-t border-line px-4 py-1.5 text-[11px] text-subtle">
        {name}
        {dims ? ` · ${dims.w}×${dims.h}` : ""}
      </div>
    </div>
  );
}

function CodeView({
  body,
  testId,
  scrollLine,
}: {
  body: string;
  testId: string;
  // Search-result landing for read-only text views (Phase E5.0): scroll the
  // pre so the matched line sits in the upper third.
  scrollLine?: number;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (scrollLine === undefined) return;
    const pre = preRef.current;
    if (!pre) return;
    const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 20;
    pre.scrollTop = Math.max(0, (scrollLine - 1) * lineHeight - pre.clientHeight / 3);
  }, [scrollLine]);
  return (
    <pre
      ref={preRef}
      data-testid={testId}
      className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[13px] text-ink"
    >
      {body}
    </pre>
  );
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

function AffordanceCard(props: {
  testId: string;
  title: string;
  body: string;
  openExternally?: { workspaceId: string; path: string };
}) {
  return (
    <div
      data-testid={props.testId}
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <span className="text-sm text-ink">{props.title}</span>
      <span className="max-w-md text-xs text-muted">{props.body}</span>
      {props.openExternally ? (
        <button
          type="button"
          onClick={() =>
            void bridge().openFileExternally({
              workspaceId: props.openExternally!.workspaceId,
              relativePath: props.openExternally!.path,
            })
          }
          className="rounded border border-line bg-panel-2 px-2.5 py-1 text-xs text-muted hover:text-ink"
        >
          Open externally
        </button>
      ) : null}
    </div>
  );
}

export function FileInspector(props: {
  workspaceId: string;
  path: string;
  refreshKey?: number;
  onOpenPath?: (path: string) => void;
  // A pending search-result jump (Phase E5.0). Consumed (onScrollConsumed)
  // once a mounted view applied it, so plain re-opens never re-jump.
  scrollTarget?: ScrollTarget;
  onScrollConsumed?: () => void;
  // Editor save-state seam for the tab strip's dirty indicator. Only the
  // markdown editor saves locally, so it is the only dirty source.
  onSaveStateChange?: (state: "saved" | "saving" | "error") => void;
  // Registers the active editor's draft flush with the shell (same "only
  // dirty source" scoping): explorer ops await it before re-pathing files.
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
  onSharePath?: (path: string) => void;
}) {
  const kind = classifyForView(props.path);
  const isText = kind === "markdown" || kind === "csv" || kind === "json" || kind === "text";
  const { text, loadedPath, truncated, error } = useTextContent(
    props.workspaceId,
    props.path,
    isText,
    props.refreshKey ?? 0,
  );
  // Consume the jump AFTER the child view's own effects applied it (child
  // effects run before this parent effect). Text views wait for the loaded
  // text; every other kind has nowhere to land, so consume immediately.
  const { scrollTarget, onScrollConsumed } = props;
  const textReady = !isText || (text !== null && loadedPath === props.path);
  useEffect(() => {
    if (scrollTarget && scrollTarget.path === props.path && textReady) {
      onScrollConsumed?.();
    }
  }, [scrollTarget, props.path, textReady, onScrollConsumed]);
  const url = assetUrl(props.workspaceId, props.path);
  const truncatedNotice =
    isText && truncated ? (
      <TruncatedNotice workspaceId={props.workspaceId} path={props.path} />
    ) : null;
  const onShareCurrentPath = props.onSharePath
    ? () => props.onSharePath?.(props.path)
    : undefined;

  if (isText && (text === null || loadedPath !== props.path)) {
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
            workspaceId={props.workspaceId}
            path={props.path}
            truncated={truncated}
            truncatedNotice={truncatedNotice}
            scrollTarget={props.scrollTarget}
            onOpenPath={props.onOpenPath}
            onSharePath={props.onSharePath}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
          />
        </div>
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
          <CsvView
            body={text ?? ""}
            workspaceId={props.workspaceId}
            path={props.path}
            onOpenPath={props.onOpenPath}
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
          <CodeView
            body={text ?? ""}
            testId={kind === "json" ? "view-json" : "view-text"}
            scrollLine={
              props.scrollTarget?.path === props.path
                ? props.scrollTarget.line
                : undefined
            }
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
            refreshKey={props.refreshKey}
            onSharePath={props.onSharePath}
          />
        </Suspense>
      );
    case "app-source":
      return (
        <Suspense
          fallback={
            <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
              <ViewHeader
                icon={<FileText size={13} aria-hidden />}
                path={props.path}
                label="app"
                onShare={onShareCurrentPath}
              />
              <Empty>Loading app…</Empty>
            </div>
          }
        >
          <LazyAppPackageView
            workspaceId={props.workspaceId}
            path={props.path}
            onSharePath={props.onSharePath}
          />
        </Suspense>
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
          <AffordanceCard
            testId="view-binary"
            title="File"
            body="This file type doesn't have a preview yet."
            openExternally={{ workspaceId: props.workspaceId, path: props.path }}
          />
        </div>
      );
  }
}
