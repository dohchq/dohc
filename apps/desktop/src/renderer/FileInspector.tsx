import {
  FileText,
  Image as ImageIcon,
  Music,
  Plus,
  Share2,
  Table,
  Trash2,
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
import type * as Y from "yjs";
import type { ChatFileMentionRecord } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { IncrementalMarkdownDocument } from "./markdown/IncrementalMarkdownDocument";
import { bridge } from "./bridge";
import { useEngineDoc } from "./collab/useEngineDoc";
import {
  applyFrontmatter,
  orderFrontmatter,
  parseFrontmatter,
} from "./markdown/frontmatter";
import type {
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from "./editor/MarkdownEditor";
import type { HeadingNavigationTarget } from "./editor/OutlinePanel";
import type { PropertiesPanelProps } from "./PropertiesPanel";
import { PageIdentity } from "./PageIdentity";
import { BacklinksPanel } from "./BacklinksPanel";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import { IconButton, SectionLabel } from "./ui/controls";
import { DocumentMenu } from "./DocumentMenu";
import { EditorErrorBoundary } from "./editor/EditorErrorBoundary";
import {
  extractWorkspaceHeadings,
  resolveWorkspaceHeadingAnchorTarget,
} from "../workspaces/workspaceHeadings";

const EMPTY_WIKILINK_FILES: ReadonlyArray<WikilinkFile> = [];

// The engine Y.Doc frontmatter map field name — the same key PageIdentity and
// PropertiesPanel use for title, icon, and properties. Read it directly so
// engine-mode export/copy reflects live frontmatter edits.
const ENGINE_FRONTMATTER_FIELD = "frontmatter";

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

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

// The filename without its directory or extension — the Notion-style empty
// title placeholder ("2026-plan.md" -> "2026-plan").
function filenameStem(path: string): string {
  const slash = path.lastIndexOf("/");
  const leaf = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
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

export type HeadingTarget = HeadingNavigationTarget;

export type WikilinkNavigation = {
  path: string;
  headingTarget?: HeadingTarget;
};

function normalizeWikilinkPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/gu, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function wikilinkPathCandidates(target: string, currentPath: string): string[] {
  const slashed = target.replace(/\\/gu, "/");
  const currentDirectory = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/"))
    : "";
  const direct = normalizeWikilinkPath(slashed);
  const relative = normalizeWikilinkPath(
    currentDirectory ? `${currentDirectory}/${slashed}` : slashed,
  );
  const explicitlyRelative = slashed.startsWith("./") || slashed.startsWith("../");
  return [...new Set(explicitlyRelative ? [relative, direct] : [direct, relative])];
}

function findKnownWikilinkFile(
  target: string,
  currentPath: string,
  knownFiles: ReadonlyArray<WikilinkFile>,
): WikilinkFile | undefined {
  const candidates = wikilinkPathCandidates(target, currentPath);
  for (const candidate of candidates) {
    const match = knownFiles.find((file) => {
      const knownPath = normalizeWikilinkPath(file.path);
      const knownWithoutExtension = knownPath.replace(/\.md$/iu, "");
      const withoutExtension = candidate.replace(/\.md$/iu, "");
      return candidate === knownPath || withoutExtension === knownWithoutExtension;
    });
    if (match) return match;
  }
  return undefined;
}

/** Resolve a rich-editor wikilink. A complete known-file path is authoritative
 * even when it contains `#`; only unmatched suffixes become heading fragments.
 * Fragment-only links stay in the current file, and unknown links retain the
 * existing `.md` fallback after path normalization. */
export function resolveWikilinkNavigation(
  target: string,
  currentPath: string,
  knownFiles: ReadonlyArray<WikilinkFile>,
  nonce: number,
): WikilinkNavigation {
  // A leading hash is the explicit same-file heading form. A file whose name
  // begins with `#` remains addressable through a path such as `./#notes`.
  if (target.startsWith("#")) {
    const fragment = target.slice(1);
    return {
      path: currentPath,
      ...(fragment
        ? { headingTarget: { anchor: fragment, nonce } }
        : {}),
    };
  }

  const fullTargetMatch = findKnownWikilinkFile(target, currentPath, knownFiles);
  if (fullTargetMatch) return { path: fullTargetMatch.path };

  // Prefer the longest known filename before a `#`. This keeps an explicit
  // heading navigable for files that themselves contain one or more hashes,
  // e.g. `notes/release#1.md#decisions`.
  for (let hashIndex = target.lastIndexOf("#"); hashIndex > 0;) {
    const fileTarget = target.slice(0, hashIndex);
    const fragment = target.slice(hashIndex + 1);
    const match = findKnownWikilinkFile(fileTarget, currentPath, knownFiles);
    if (match) {
      return {
        path: match.path,
        ...(fragment
          ? { headingTarget: { anchor: fragment, nonce } }
          : {}),
      };
    }
    hashIndex = target.lastIndexOf("#", hashIndex - 1);
  }

  const hashIndex = target.indexOf("#");
  const fileTarget = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  let path = currentPath;
  if (fileTarget) {
    const match = findKnownWikilinkFile(fileTarget, currentPath, knownFiles);
    const fallback = wikilinkPathCandidates(fileTarget, currentPath)[0] ?? fileTarget;
    path = match?.path ?? `${fallback.replace(/\.md$/iu, "")}.md`;
  }
  return {
    path,
    ...(fragment
      ? { headingTarget: { anchor: fragment, nonce } }
      : {}),
  };
}

export type PendingFileUndo = {
  token: number;
  path: string;
  restoredText: string;
  undoText: string;
};

type PendingTextUndo = Omit<PendingFileUndo, "path">;

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
const LazySourceCodeEditor = lazy(() =>
  import("./SourceCodeEditor").then((mod) => ({
    default: mod.SourceCodeEditor,
  })),
);

// yDocToMarkdown lives in editor/import-export, which statically pulls the
// Tiptap schema/KaTeX stack the lazy MarkdownEditor split keeps out of this
// eager chunk — load it on demand (first source-view toggle), documentExport
// precedent. Cached: every later toggle reuses the loaded module.
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
  | "binary";

// Pure classifier: every file resolves to exactly one view kind. Exported so
// the E2E and unit tests pin the dispatch table directly.
export function classifyForView(path: string): FileViewKind {
  const ext = extensionOf(path);
  if (ext === "md" || ext === "markdown") return "markdown";
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
  // Breadcrumb weighting: the folder path recedes, the file name carries ink.
  const slash = props.path.lastIndexOf("/");
  const dir = slash >= 0 ? props.path.slice(0, slash + 1) : "";
  const leaf = slash >= 0 ? props.path.slice(slash + 1) : props.path;
  return (
    <header className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-[13px]">
      {props.icon}
      <span className="min-w-0 truncate font-mono">
        {dir ? <span className="text-subtle">{dir}</span> : null}
        <span className="font-medium text-ink">{leaf}</span>
      </span>
      <SectionLabel className="ml-auto shrink-0">
        {props.label}
      </SectionLabel>
      {props.onShare ? (
        <IconButton
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={props.onShare}
        >
          <Share2 size={13} aria-hidden />
        </IconButton>
      ) : null}
      {props.actions}
    </header>
  );
}

// The source view's explicit copy affordance ("view source" implies "grab the
// text"): quiet inline "Copied" confirmation, same swap-and-restore rhythm as
// DocumentMenu / the code-block copy button (FEEDBACK_MS there is 1200 too).
function CopySourceButton(props: { getSource: () => string | null }) {
  const [label, setLabel] = useState<"Copy" | "Copied" | "Couldn't copy">("Copy");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      type="button"
      data-testid="markdown-source-copy"
      onClick={() => {
        const source = props.getSource();
        const write = source === null ? undefined : navigator.clipboard?.writeText(source);
        if (!write) return;
        void write
          .then(() => setLabel("Copied"))
          .catch(() => setLabel("Couldn't copy"))
          .then(() => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setLabel("Copy"), 1200);
          });
      }}
      className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
    >
      {label}
    </button>
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

type SaveState = "saved" | "saving" | "error";

function useAutosavedTextDraft(props: {
  body: string;
  workspaceId: string;
  path: string;
  disabled?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [draft, setDraft] = useState(props.body);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const latestDraft = useRef(props.body);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsavedDraft = useRef(false);

  useEffect(() => {
    props.onSaveStateChange?.(saveState);
  }, [saveState, props.onSaveStateChange]);

  useEffect(() => {
    if (unsavedDraft.current) return;
    setDraft(props.body);
    latestDraft.current = props.body;
    setSaveState("saved");
  }, [props.body, props.path]);

  async function writeDraftNow(options: { rejectOnError?: boolean } = {}): Promise<void> {
    if (props.disabled) return;
    const text = latestDraft.current;
    unsavedDraft.current = false;
    setSaveState("saving");
    try {
      await bridge().writeWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.path,
        text,
      });
      setDraft(text);
      setSaveState("saved");
    } catch (error) {
      unsavedDraft.current = true;
      setSaveState("error");
      if (options.rejectOnError) throw error;
    }
  }

  async function saveNow(): Promise<void> {
    await writeDraftNow();
  }

  function scheduleSave(next: string) {
    setDraft(next);
    latestDraft.current = next;
    if (props.disabled) return;
    unsavedDraft.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 800);
  }

  const { workspaceId, path, registerDraftFlush } = props;
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!unsavedDraft.current || props.disabled) return;
      unsavedDraft.current = false;
      void bridge()
        .writeWorkspaceText({
          workspaceId,
          relativePath: path,
          text: latestDraft.current,
        })
        .catch(() => undefined);
    };
  }, [workspaceId, path, props.disabled]);

  useEffect(() => {
    if (!registerDraftFlush) return;
    registerDraftFlush(async () => {
      if (!unsavedDraft.current || props.disabled) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await writeDraftNow({ rejectOnError: true });
    });
    return () => registerDraftFlush(null);
    // writeDraftNow uses refs for the draft; workspace/path are stable per keyed inspector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush, props.disabled]);

  return {
    draft,
    saveState,
    setDraft: scheduleSave,
    saveNow,
    getDraft: () => latestDraft.current,
  };
}

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
  headingTarget?: HeadingTarget;
  onOpenPath?: (path: string, headingTarget?: HeadingTarget) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
  onSharePath?: (path: string) => void;
  onSaveStateChange?: (state: "saved" | "saving" | "error") => void;
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
  knownFiles?: ReadonlyArray<WikilinkFile>;
  pendingUndo?: PendingTextUndo;
  onPendingUndoConsumed?: (token: number) => void;
  // Read-only shared views (PR 18): editing is disabled regardless of size,
  // and live collab never activates.
  forceReadOnly?: boolean;
  // G2-C-3 version-switch re-bind token (the shell's versionEpoch), forwarded
  // to useEngineDoc so switching the active version reopens the engine session
  // against the new version's lineage.
  reopenKey?: number;
  // Workspace-activity token: bumps after saves / external edits so the linked
  // mentions section recomputes without polling.
  refreshKey?: number;
  // Registers the mounted document's "view source" toggle with the shell so
  // the command palette can flip it (registerDraftFlush precedent). Engine
  // docs toggle the read-only source projection; the legacy autosave editor
  // switches its existing (editable) source mode.
  registerSourceToggle?: (toggle: (() => void) | null) => void;
}) {
  const [mode, setMode] = useState<"read" | "wysiwyg" | "source">(() =>
    props.truncated || props.body.length > WYSIWYG_MARKDOWN_THRESHOLD_BYTES
      ? "read"
      : "wysiwyg",
  );
  const [draft, setDraft] = useState(props.body);
  const [savedBody, setSavedBody] = useState(props.body);
  const knownFiles = props.knownFiles ?? EMPTY_WIKILINK_FILES;
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
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
    // WYSIWYG mode: the Tiptap editor owns the body while inline PageIdentity /
    // PropertiesPanel own the frontmatter (both write frontmatter through
    // latestDraft.current). Merge the live editor body over that frontmatter so
    // a save never emits the stale mount-time body. Source mode edits the full
    // markdown directly in the textarea, so latestDraft.current is canonical.
    if (mode === "wysiwyg") {
      const body = wysiwygRef.current?.getMarkdown() ?? markdownEditorBody(draft);
      return mergeMarkdownEditorBody(latestDraft.current, body);
    }
    return latestDraft.current;
  };

  // Engine-mode export/serialize: in the engine branch the WYSIWYG editor is
  // ALWAYS mounted and collab-bound to the engine Y.Doc, so its live body is
  // the canonical current markdown. serializeDraftRef can't be reused here
  // because it falls back to the stale (possibly truncated) props.body whenever
  // the properties panel is open or the doc opened in read mode, neither of
  // which reflects the live edit. This reads the editor on demand at click time
  // so the exported source is fresh.
  //
  // Frontmatter (title / icon / properties) is edited through PageIdentity and
  // PropertiesPanel, which write straight into the engine Y.Doc's frontmatter
  // MAP — NOT into latestDraft.current, which stays at this mount's initial
  // markdown. Reading latestDraft.current for the frontmatter therefore exports
  // a stale title. Serialize the LIVE map instead. Reading it directly (rather
  // than yDocToMarkdown) keeps import-export's heavy schema/KaTeX stack out of
  // this eager chunk — the mounted WYSIWYG editor already owns the body.
  const serializeEngineDraft = () => {
    const body =
      wysiwygRef.current?.getMarkdown() ?? markdownEditorBody(props.body);
    const liveMeta = engine.doc
      ? (Object.fromEntries(
          engine.doc.getMap(ENGINE_FRONTMATTER_FIELD).entries(),
        ) as Record<string, unknown>)
      : parseFrontmatter(latestDraft.current).meta;
    return applyFrontmatter(body, orderFrontmatter(liveMeta));
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

  const { onSaveStateChange } = props;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the keystroke until a write for that draft has been ISSUED.
  // The unmount flush keys off this — never off the timer handle, which stays
  // set (already fired) after a completed autosave and would double-write.
  const unsavedDraft = useRef(false);

  // Parse-once + visible-first (Phase 16): the memo stops re-parses on
  // unrelated re-renders (collab status flips, save-state ticks), and the
  // incremental document commits only the opening window up front, idle-
  // backfilling the rest — a 250KB doc opens in tens of ms, not ~575ms.
  // Strip YAML frontmatter before rendering the read view: the title/icon it
  // encodes is already surfaced by <PageIdentity> above the document, so the
  // raw `---`/`title:`/`icon:` block must not also render as body content (the
  // WYSIWYG editor uses the same `markdownEditorBody` split — keep read mode in
  // lockstep so both show the document body, not its metadata).
  const renderedDocument = useMemo(
    () => (
      <IncrementalMarkdownDocument
        body={markdownEditorBody(savedBody)}
        components={MARKDOWN_COMPONENTS}
      />
    ),
    [savedBody],
  );
  const onShareCurrentPath = props.onSharePath
    ? () => props.onSharePath?.(props.path)
    : undefined;

  // WS-G2-C-2: a rich (markdown) file on an engine-flagged workspace binds
  // Tiptap to the engine-native Y.Doc (recordUpdate + debounced settle). Solo
  // runs entirely on the engine with no relay, and a shared workspace co-edits
  // through the same
  // ydoc.update replication. available:false (unflagged workspace, secret path,
  // missing file, already live) keeps the plain local autosave editor.
  const engine = useEngineDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: !props.truncated && !props.forceReadOnly,
    reopenKey: props.reopenKey,
  });
  const readOnly = !!props.forceReadOnly || (props.truncated && !engine.available);
  const engineMode = engine.available && engine.doc !== null;

  // "View markdown as source" (engine mode): a READ-ONLY projection of the
  // canonical Y.Doc through the same yDocToMarkdown the settle uses to write
  // the .md — the source view shows exactly what lands on disk. Deliberately
  // not editable: `atoms.body` markdown is a DERIVED cache of the Y.Doc, and
  // an editable raw surface would have to round-trip through full-body
  // markdown patching (the invariant this must never become).
  const [showSource, setShowSource] = useState(false);
  const [sourceMarkdown, setSourceMarkdown] = useState<string | null>(null);
  const readDocumentRef = useRef<HTMLDivElement | null>(null);
  const [pendingRenderedHeadingIndex, setPendingRenderedHeadingIndex] = useState<
    number | null
  >(null);
  const headingTargetNonce = props.headingTarget?.nonce;
  useEffect(() => {
    if (!props.headingTarget || props.truncated) return;
    // Search-line jumps intentionally keep their established source-mode
    // behavior when both targets are present.
    if (props.scrollTarget?.path === props.path) return;
    if (engineMode) {
      // The engine editor owns canonical live content (which may be newer than
      // the markdown cache below). Reveal it and let OutlinePanel resolve the
      // target against that live Y.Doc.
      setShowSource(false);
      return;
    }
    const source = mode === "source" ? latestDraft.current : savedBody;
    const markdown = markdownEditorBody(source);
    const headings = extractWorkspaceHeadings(markdown);
    const heading = resolveWorkspaceHeadingAnchorTarget(headings, props.headingTarget);
    if (!heading) return;
    if (mode === "source") {
      // Local source is an intentional editing/viewing mode. Keep it visible
      // and select the heading's real markdown line instead of replacing it
      // with the rich editor merely to navigate.
      const bodyOffset = source.length - markdown.length;
      const frontmatterLineCount = (
        source.slice(0, bodyOffset).match(/\n/g) ?? []
      ).length;
      setPendingScrollLine(heading.line + frontmatterLineCount);
      return;
    }
    if (readOnly || mode === "read") {
      // Read-only documents do not mount Tiptap, so navigate the rendered
      // heading with the same document-order identity used by the parser.
      setPendingRenderedHeadingIndex(headings.indexOf(heading));
      return;
    }
    setMode("wysiwyg");
    // Applied once per jump; nonce permits repeating the same anchor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headingTargetNonce]);
  useEffect(() => {
    if (pendingRenderedHeadingIndex === null || mode !== "read") return;
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
  }, [mode, pendingRenderedHeadingIndex]);
  useEffect(() => {
    if (!showSource || !engine.doc) {
      setSourceMarkdown(null);
      return;
    }
    const doc = engine.doc;
    let cancelled = false;
    let serialize: ((doc: Y.Doc) => string) | null = null;
    let frame: number | null = null;
    const recompute = () => {
      if (cancelled || !serialize) return;
      setSourceMarkdown(serialize(doc));
    };
    void loadImportExport().then((mod) => {
      serialize = mod.yDocToMarkdown;
      recompute();
    });
    // Live: agent edits / co-editors keep flowing into the mirror doc while
    // the source view is up — re-project on updates. A co-editor's keystroke
    // burst forwards one delta per keystroke, so coalesce to one full-document
    // serialize per frame instead of one per delta.
    const scheduleRecompute = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        recompute();
      });
    };
    doc.on("update", scheduleRecompute);
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      doc.off("update", scheduleRecompute);
    };
  }, [showSource, engine.doc]);

  // One toggle for both branches (the shell's palette command and Ctrl/Cmd+/
  // route through it): engine mode flips the read-only source projection; the
  // legacy autosave editor switches its existing source mode — editable where
  // the .md on disk IS the source of truth, readOnly-textarea on read-only
  // docs (shared views / truncated reads), so "view source" works everywhere
  // a markdown document renders.
  function toggleSourceView() {
    if (engineMode) {
      setShowSource((current) => !current);
      return;
    }
    if (mode === "source") {
      // Leaving editable source with an autosave still pending: flush the RAW
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
      onSaveStateChange?.(saveState);
      return;
    }
    // The shell's dot has three states; a read-only refusal is an unsaved
    // document as far as the tab is concerned.
    onSaveStateChange?.(
      engine.saveState === "read-only" ? "error" : engine.saveState,
    );
  }, [saveState, engine.available, engine.saveState, onSaveStateChange]);

  useEffect(() => {
    if (!readOnly) return;
    setMode("read");
  }, [readOnly]);

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
  // only while NOT editing AND with no unsaved draft — mid-edit, the user's
  // draft wins until saved. Read mode now edits frontmatter inline (title/icon
  // via PageIdentity, properties via PropertiesPanel) without switching to an
  // "editing" mode, so a pending property save must be guarded here too or an
  // external refresh mid-edit would clobber the unsaved change.
  useEffect(() => {
    if (!editing && !unsavedDraft.current) {
      setDraft(props.body);
      setSavedBody(props.body);
      latestDraft.current = props.body;
    }
  }, [props.body, editing]);

  async function writeDraftNow(options: { rejectOnError?: boolean } = {}): Promise<void> {
    if (readOnly) return;
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
    } catch (error) {
      // The write failed: the draft is still unsaved, so the unmount flush
      // gets another shot at landing it.
      unsavedDraft.current = true;
      setSaveState("error");
      if (options.rejectOnError) throw error;
    }
  }

  async function saveNow(): Promise<void> {
    await writeDraftNow();
  }

  function onDraft(next: string) {
    if (readOnly) return;
    setDraft(next);
    latestDraft.current = next;
    scheduleSave();
  }

  function onPropertiesDraft(next: string) {
    if (readOnly) return;
    setDraft(next);
    latestDraft.current = next;
    if (mode === "read") setSavedBody(next);
    scheduleSave();
  }

  function scheduleSave() {
    if (readOnly) return;
    unsavedDraft.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 800);
  }

  function switchMode(next: "read" | "wysiwyg" | "source") {
    // Read-only docs (shared views, truncated reads) still allow SOURCE — the
    // textarea renders with the readOnly attribute, so it is a view, not an
    // edit surface (search jumps already force source mode this way). Only
    // the editable WYSIWYG mode is off-limits.
    if (readOnly && next === "wysiwyg") return;
    const current =
      mode === "wysiwyg" && !unsavedDraft.current
        ? latestDraft.current
        : serializeDraftRef.current();
    latestDraft.current = current;
    setDraft(current);
    setMode(next);
  }

  function toggleEditorMode() {
    if (readOnly) return;
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

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "/") return;
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

  const wikilinkNavigationNonce = useRef(0);
  function openWikilink(target: string) {
    const navigation = resolveWikilinkNavigation(
      target,
      props.path,
      knownFiles,
      ++wikilinkNavigationNonce.current,
    );
    props.onOpenPath?.(navigation.path, navigation.headingTarget);
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
      if (!unsavedDraft.current || readOnly) return;
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
  }, [workspaceId, path, readOnly]);

  // Imperative flush seam: the shell awaits this BEFORE an explorer op that
  // moves/deletes paths. A rename of the open file remounts the keyed
  // inspector AFTER the disk rename — by then the unmount flush above writes
  // to the renamed-away OLD path (ENOENT, swallowed) and the draft is lost.
  // Flushing through here lands the keystrokes while the path still exists.
  const { registerDraftFlush } = props;
  useEffect(() => {
    if (!registerDraftFlush) return;
    registerDraftFlush(async () => {
      if (!unsavedDraft.current || readOnly) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await writeDraftNow({ rejectOnError: true });
    });
    return () => registerDraftFlush(null);
    // writeDraftNow reads refs (latestDraft) + per-mount-stable props only, so the
    // first render's closure stays correct for the whole mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush, readOnly]);

  // Linked mentions live at the BOTTOM of the document, inside the reading
  // measure, in every markdown branch (engine / wysiwyg / read). Hidden when a
  // file has none, so it only ever adds chrome when there's something to show.
  const backlinks = (
    <BacklinksPanel
      workspaceId={props.workspaceId}
      path={props.path}
      refreshKey={props.refreshKey}
      onOpenPath={props.onOpenPath}
      onOpenChatMention={props.onOpenChatMention}
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
                data-state={engine.saveState}
                title={
                  engine.saveState === "error"
                    ? "Your edits are still here, but the file on disk is behind them. Keep this document open and try another edit."
                    : engine.saveState === "read-only"
                      ? "This document is shared with you to read. Your changes stay on screen but are not saved."
                      : undefined
                }
                className={`font-mono text-[11px] ${
                  engine.saveState === "error" || engine.saveState === "read-only"
                    ? "text-danger"
                    : "text-subtle"
                }`}
              >
                {engine.saveState === "saved"
                  ? "Saved"
                  : engine.saveState === "saving"
                    ? "Saving…"
                    : engine.saveState === "read-only"
                      ? "Read-only"
                      : "Couldn't save"}
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
        {showSource ? (
          // Raw markdown, monospaced and read-only — frontmatter included, so
          // the top-matter zone (which renders the same metadata as chrome)
          // steps aside, like the legacy editor's source mode.
          <div data-testid="view-markdown-source" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-line bg-panel px-4 py-1 text-[11px] text-subtle">
              <span>Read-only markdown source — switch back to Editor to make changes.</span>
              <CopySourceButton getSource={() => sourceMarkdown} />
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
        {/* data-dohc-doc-pane: the WHOLE pane is the editor's image drop zone,
            top-matter included — MarkdownEditor finds it with closest(). See
            the drop-zone comment in imagePaste.ts.

            HIDDEN (not unmounted) while source is shown: unmounting Tiptap
            destroys the Collaboration extension's Yjs UndoManager and the
            cursor/selection, and would leave the DocumentMenu serializing a
            stale mount-time body. The hidden editor stays bound to the Y.Doc,
            so toggling back restores the exact editing state. */}
        <div
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
              onEnterBody={() => wysiwygRef.current?.focus("start")}
            />
            <Suspense fallback={<PropertiesFallback />}>
              <LazyPropertiesPanel ydoc={engine.doc} />
            </Suspense>
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
                headingTarget={props.headingTarget}
                pendingUndo={editorPendingUndo}
                onPendingUndoConsumed={props.onPendingUndoConsumed}
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
            {/* Read mode hides the "Saved" idle chip, but PageIdentity stays
                editable here and autosaves title/icon edits — so a pending or
                failed save (saveState !== "saved") must surface even when not
                `editing`, or a failed title/icon save is invisible while the
                optimistic value keeps showing. */}
            {editing || saveState !== "saved" ? (
              <span
                data-testid="markdown-save-state"
                data-state={saveState}
                className={`font-mono text-[11px] ${saveState === "error" ? "text-danger" : "text-subtle"}`}
              >
                {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Couldn't save"}
              </span>
            ) : null}
            <button
              type="button"
              data-testid="markdown-edit-toggle"
              disabled={readOnly}
              onClick={() => {
                if (readOnly) return;
                if (mode === "source" && saveTimer.current) {
                  clearTimeout(saveTimer.current);
                  void saveNow();
                }
                toggleEditorMode();
              }}
              className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mode === "read" ? "Edit" : mode === "wysiwyg" ? "Source" : "WYSIWYG"}
            </button>
            {/* A truncated doc only loaded a bounded prefix into
                serializeDraftRef — copying/exporting it would silently emit a
                partial document. Hide the menu until the full file is loaded
                (same gate as the inline properties below). */}
            {!props.truncated ? (
              <DocumentMenu
                workspaceId={props.workspaceId}
                suggestedName={filenameStem(props.path)}
                getMarkdown={() => serializeDraftRef.current()}
              />
            ) : null}
          </>
        }
      />
      {props.truncatedNotice}
      {mode === "source" ? (
        <textarea
          data-testid="markdown-editor"
          ref={editorRef}
          autoFocus
          value={draft}
          readOnly={readOnly}
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
        // data-dohc-doc-pane: see the note on the engine pane above.
        <div
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
                ref={wysiwygRef}
                value={markdownEditorBody(draft)}
                onDirty={scheduleSave}
                workspaceId={props.workspaceId}
                path={props.path}
                knownFiles={knownFiles}
                onOpenWikilink={openWikilink}
                headingTarget={props.headingTarget}
                pendingUndo={editorPendingUndo}
                onPendingUndoConsumed={props.onPendingUndoConsumed}
                collab={null}
              />
            </Suspense>
          </EditorErrorBoundary>
          {backlinks}
        </div>
      ) : (
        <div
          data-testid="view-markdown"
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="dohc-page-topmatter">
            <PageIdentity
              body={draft}
              onChange={onPropertiesDraft}
              filenameStem={filenameStem(props.path)}
              readOnly={readOnly}
            />
            {!readOnly ? (
              <Suspense fallback={<PropertiesFallback />}>
                <LazyPropertiesPanel body={draft} onChange={onPropertiesDraft} />
              </Suspense>
            ) : null}
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
  truncated,
  onSaveStateChange,
  registerDraftFlush,
}: {
  body: string;
  workspaceId: string;
  path: string;
  onOpenPath?: (path: string) => void;
  truncated?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [raw, setRaw] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const draft = useAutosavedTextDraft({
    body,
    workspaceId,
    path,
    disabled: truncated,
    onSaveStateChange,
    registerDraftFlush,
  });
  const delimiter = delimiterForPath(path);
  const rows = useMemo(
    () => parseDelimitedRows(draft.draft, delimiter),
    [draft.draft, delimiter],
  );
  const [header, ...data] = rows;
  // Bounded preview (Phase 16): an unbounded <table> over 10,000+ rows
  // freezes the renderer for tens of seconds. The first rows are enough to
  // inspect and edit common CSVs; working with all of them is what Import to
  // SQLite or raw mode is for.
  const MAX_PREVIEW_ROWS = 500;
  const previewRows = data.length > MAX_PREVIEW_ROWS ? data.slice(0, MAX_PREVIEW_ROWS) : data;
  const columnCount = Math.max(
    header?.length ?? 0,
    ...previewRows.map((row) => row.length),
  );

  function currentRows() {
    return parseDelimitedRows(draft.getDraft(), delimiter);
  }

  function setRows(next: string[][]) {
    draft.setDraft(stringifyDelimitedRows(next, delimiter));
  }

  function columnName(index: number): string {
    return index === 0 ? "column" : `column_${index + 1}`;
  }

  function columnCountFor(nextRows: string[][]): number {
    return Math.max(
      nextRows[0]?.length ?? 0,
      ...nextRows.slice(1, MAX_PREVIEW_ROWS + 1).map((row) => row.length),
      0,
    );
  }

  function updateCell(rowIndex: number, cellIndex: number, value: string) {
    const next = currentRows().map((row) => [...row]);
    while (next.length <= rowIndex) next.push([]);
    while (next[rowIndex]!.length <= cellIndex) next[rowIndex]!.push("");
    next[rowIndex]![cellIndex] = value;
    setRows(next);
  }

  function addRow() {
    const nextRows = currentRows();
    if (nextRows.length === 0) {
      setRows([["column"], [""]]);
      return;
    }
    const width = Math.max(1, columnCountFor(nextRows));
    setRows([...nextRows, Array.from({ length: width }, () => "")]);
  }

  function addColumn() {
    const nextRows = currentRows();
    if (nextRows.length === 0) {
      setRows([["column"]]);
      return;
    }
    const width = columnCountFor(nextRows);
    const next = nextRows.map((row, index) => {
      const cells = [...row];
      while (cells.length < width) cells.push("");
      cells.push(index === 0 ? columnName(width) : "");
      return cells;
    });
    setRows(next);
  }

  function deleteRow(rowIndex: number) {
    const next = currentRows().filter((_, index) => index !== rowIndex);
    setRows(next);
  }

  function deleteColumn(cellIndex: number) {
    const next = currentRows().map((row) => row.filter((_, index) => index !== cellIndex));
    if (next.every((row) => row.length === 0)) {
      draft.setDraft("");
      return;
    }
    setRows(next);
  }

  async function importToSqlite() {
    if (importing || truncated) return;
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
        <span
          data-testid="csv-save-state"
          data-state={draft.saveState}
          className={`mr-auto font-mono text-[11px] ${draft.saveState === "error" ? "text-danger" : "text-subtle"}`}
        >
          {truncated
            ? "Read-only"
            : draft.saveState === "saved"
              ? "Saved"
              : draft.saveState === "saving"
                ? "Saving..."
                : "Couldn't save"}
        </span>
        {importError ? (
          <span data-testid="csv-import-error" className="px-1 text-[11px] text-danger">
            {importError}
          </span>
        ) : null}
        {!raw && !truncated ? (
          <>
            <button
              type="button"
              onClick={addRow}
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
              data-testid="csv-add-row"
            >
              <Plus size={12} aria-hidden />
              Row
            </button>
            <button
              type="button"
              onClick={addColumn}
              className="inline-flex h-7 items-center gap-1 rounded px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
              data-testid="csv-add-column"
            >
              <Plus size={12} aria-hidden />
              Column
            </button>
          </>
        ) : null}
        {onOpenPath ? (
          <button
            type="button"
            onClick={() => void importToSqlite()}
            disabled={importing || truncated}
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
        <textarea
          data-testid="csv-raw-editor"
          value={draft.draft}
          onChange={(event) => draft.setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "s") {
              event.preventDefault();
              void draft.saveNow();
            }
          }}
          readOnly={truncated}
          spellCheck={false}
          className="dohc-csv-raw-editor min-h-0 flex-1 resize-none bg-bg p-4 font-mono text-[13px] leading-relaxed text-ink outline-none read-only:text-muted"
        />
      ) : !header ? (
        <div
          data-testid="csv-empty-table"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <Table size={22} aria-hidden className="text-subtle" />
          <div className="flex flex-col gap-1">
            <span className="text-sm text-ink">Empty table</span>
            <span className="text-xs text-subtle">No rows or columns</span>
          </div>
          {!truncated ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addRow}
                className="inline-flex h-7 items-center gap-1 rounded border border-line px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
                data-testid="csv-empty-add-row"
              >
                <Plus size={12} aria-hidden />
                Row
              </button>
              <button
                type="button"
                onClick={addColumn}
                className="inline-flex h-7 items-center gap-1 rounded border border-line px-2 text-[11px] text-subtle hover:bg-line/50 hover:text-ink"
                data-testid="csv-empty-add-column"
              >
                <Plus size={12} aria-hidden />
                Column
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* Same table voice as the document editor: rounded frame, tinted
              header band, quiet inner hairlines, whisper row hover. */}
          <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-line text-[13px]">
            <thead>
              <tr>
                {!truncated ? (
                  <th
                    aria-label="Row actions"
                    className="w-9 bg-panel px-1 py-1.5"
                  />
                ) : null}
                {Array.from({ length: columnCount }, (_, i) => (
                  <th
                    key={i}
                    className={`bg-panel px-2.5 py-1.5 text-left text-[12px] font-semibold text-muted ${
                      i > 0 || !truncated ? "border-l border-line" : ""
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <input
                        data-testid="csv-cell"
                        aria-label={`Header column ${i + 1}`}
                        value={header[i] ?? ""}
                        readOnly={truncated}
                        onChange={(event) => updateCell(0, i, event.target.value)}
                        className="dohc-csv-cell min-w-24 flex-1 bg-transparent text-ink outline-none read-only:text-muted"
                      />
                      {!truncated ? (
                        <button
                          type="button"
                          data-testid="csv-delete-column"
                          aria-label={`Delete column ${i + 1}`}
                          title="Delete column"
                          onClick={() => deleteColumn(i)}
                          className="grid size-5 shrink-0 place-items-center rounded text-subtle transition-colors hover:bg-line/60 hover:text-danger"
                        >
                          <Trash2 size={11} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, r) => (
                <tr key={r} className="group transition-colors hover:bg-panel-2/60">
                  {!truncated ? (
                    <td className="border-t border-line px-1 py-1 text-center">
                      <button
                        type="button"
                        data-testid="csv-delete-row"
                        aria-label={`Delete row ${r + 1}`}
                        title="Delete row"
                        onClick={() => deleteRow(r + 1)}
                        className="grid size-5 place-items-center rounded text-subtle opacity-0 transition-colors hover:bg-line/60 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 size={11} aria-hidden />
                      </button>
                    </td>
                  ) : null}
                  {Array.from({ length: columnCount }, (_, c) => (
                    <td
                      key={c}
                      className={`border-t border-line px-2.5 py-1.5 ${
                        c > 0 || !truncated ? "border-l" : ""
                      }`}
                    >
                      <input
                        data-testid="csv-cell"
                        aria-label={`Row ${r + 1} column ${c + 1}`}
                        value={row[c] ?? ""}
                        readOnly={truncated}
                        onChange={(event) => updateCell(r + 1, c, event.target.value)}
                        className="dohc-csv-cell w-full min-w-24 bg-transparent text-ink outline-none read-only:text-muted"
                      />
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

function delimiterForPath(path: string): "," | "\t" {
  const ext = extensionOf(path);
  return ext === "tsv" || ext === "tab" ? "\t" : ",";
}

function parseDelimitedRows(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        cellStarted = true;
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
        cellStarted = true;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      cellStarted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
      cellStarted = false;
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStarted = false;
    } else if (char !== "\r") {
      cell += char;
      cellStarted = true;
    }
  }

  if (cellStarted || cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function stringifyDelimitedRows(rows: string[][], delimiter: "," | "\t"): string {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          (cell === "" && row.length === 1) ||
          cell.includes(delimiter) ||
          /["\r\n]/.test(cell)
            ? `"${cell.replace(/"/g, '""')}"`
            : cell,
        )
        .join(delimiter),
    )
    .join("\n");
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

function TextEditorView({
  body,
  testId,
  language,
  scrollLine,
  workspaceId,
  path,
  truncated,
  onSaveStateChange,
  registerDraftFlush,
  pendingUndo,
  onPendingUndoConsumed,
}: {
  body: string;
  testId: string;
  language: string;
  workspaceId: string;
  path: string;
  truncated?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
  pendingUndo?: PendingTextUndo;
  onPendingUndoConsumed?: (token: number) => void;
  // Search-result landing for read-only text views (Phase E5.0): scroll the
  // pre so the matched line sits in the upper third.
  scrollLine?: number;
}) {
  const editor = useAutosavedTextDraft({
    body,
    workspaceId,
    path,
    disabled: truncated,
    onSaveStateChange,
    registerDraftFlush,
  });
  return (
    <div
      data-testid={testId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="font-mono text-[11px] uppercase tracking-wide text-subtle">
          {language}
        </span>
        <span
          data-testid={`${testId}-save-state`}
          data-state={editor.saveState}
          className={`ml-auto text-[11px] ${editor.saveState === "error" ? "text-danger" : "text-subtle"}`}
        >
          {truncated
            ? "Read-only"
            : editor.saveState === "saved"
              ? "Saved"
              : editor.saveState === "saving"
                ? "Saving..."
                : "Couldn't save"}
        </span>
      </div>
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-subtle">
            Loading editor...
          </div>
        }
      >
        <LazySourceCodeEditor
          testId={`${testId}-editor`}
          value={editor.draft}
          language={language}
          path={path}
          readOnly={truncated}
          scrollLine={scrollLine}
          pendingUndo={pendingUndo}
          onPendingUndoConsumed={onPendingUndoConsumed}
          onChange={editor.setDraft}
          onSave={() => void editor.saveNow()}
        />
      </Suspense>
    </div>
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
  onOpenPath?: (path: string, headingTarget?: HeadingTarget) => void;
  onOpenChatMention?: (mention: ChatFileMentionRecord) => void;
  // A pending search-result jump (Phase E5.0). Consumed (onScrollConsumed)
  // once a mounted view applied it, so plain re-opens never re-jump.
  scrollTarget?: ScrollTarget;
  // A pending file/section mention or fragment-link jump. Unlike a search
  // target this stays in the rich editor and lands on the rendered heading.
  headingTarget?: HeadingTarget;
  onScrollConsumed?: () => void;
  // Editor save-state seam for the tab strip's dirty indicator. Editable
  // source/table/document views all report through the same small contract.
  onSaveStateChange?: (state: "saved" | "saving" | "error") => void;
  // Registers the active editor's draft flush with the shell: explorer ops
  // await it before re-pathing files.
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
  knownMarkdownFiles?: ReadonlyArray<WikilinkFile>;
  onSharePath?: (path: string) => void;
  pendingUndo?: PendingFileUndo;
  onPendingUndoConsumed?: (token: number) => void;
  // Read-only shared views (PR 18): every editable view refuses edits.
  readOnly?: boolean;
  // G2-C-3: a monotonic token that changes when the ACTIVE VERSION of this
  // workspace changes while the SAME file stays open (the shell's versionEpoch).
  // Threaded to the engine editor so a version switch re-binds it to the new
  // version's Y.Doc lineage. Distinct from refreshKey, which ALSO bumps on
  // ordinary history growth (which must NOT reopen the live engine session).
  engineVersionKey?: number;
  // Registers the mounted markdown view's "view source" toggle with the shell
  // (command palette seam) — registerDraftFlush precedent.
  registerSourceToggle?: (toggle: (() => void) | null) => void;
}) {
  const kind = classifyForView(props.path);
  const isText = kind === "markdown" || kind === "csv" || kind === "json" || kind === "text";
  const { text, loadedPath, truncated, error } = useTextContent(
    props.workspaceId,
    props.path,
    isText,
    props.refreshKey ?? 0,
  );
  const pendingTextUndo =
    props.pendingUndo?.path === props.path &&
    text === props.pendingUndo.restoredText
      ? {
          token: props.pendingUndo.token,
          restoredText: props.pendingUndo.restoredText,
          undoText: props.pendingUndo.undoText,
        }
      : undefined;
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
  const url = assetUrl(props.workspaceId, props.path, props.refreshKey ?? 0);
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
            headingTarget={props.headingTarget}
            onOpenPath={props.onOpenPath}
            onOpenChatMention={props.onOpenChatMention}
            onSharePath={props.onSharePath}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
            knownFiles={props.knownMarkdownFiles}
            pendingUndo={pendingTextUndo}
            onPendingUndoConsumed={props.onPendingUndoConsumed}
            forceReadOnly={props.readOnly}
            reopenKey={props.engineVersionKey}
            refreshKey={props.refreshKey}
            registerSourceToggle={props.registerSourceToggle}
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
            truncated={truncated || !!props.readOnly}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
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
          <TextEditorView
            body={text ?? ""}
            testId={kind === "json" ? "view-json" : "view-text"}
            language={kind === "json" ? "json" : extensionOf(props.path) || "text"}
            workspaceId={props.workspaceId}
            path={props.path}
            truncated={truncated || !!props.readOnly}
            onSaveStateChange={props.onSaveStateChange}
            registerDraftFlush={props.registerDraftFlush}
            scrollLine={
              props.scrollTarget?.path === props.path
                ? props.scrollTarget.line
                : undefined
            }
            pendingUndo={pendingTextUndo}
            onPendingUndoConsumed={props.onPendingUndoConsumed}
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
            readOnly={props.readOnly}
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
