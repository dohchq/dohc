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
  useCallback,
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
import {
  useEngineDoc,
  type EngineDocSaveState,
  type UseEngineDoc,
} from "./collab/useEngineDoc";
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
import { blockIndexForLine } from "./editor/lineBlocks";
import type { HeadingNavigationTarget } from "./editor/OutlinePanel";
import type { PropertiesPanelProps } from "./PropertiesPanel";
import { PageIdentity } from "./PageIdentity";
import {
  captureOrphanedDraft,
  dismissOrphanedDraft,
  useOrphanedDrafts,
} from "./orphanedDrafts";
import { DismissDraftControls } from "./RecoveryList";
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
// The markdown autosave debounce. Named because the rearm on unblock has to
// use the SAME window the keystroke armed — two literals would drift.
const AUTOSAVE_DEBOUNCE_MS = 800;

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
  // Bumped once per ANSWERED read. The dispatcher uses it to tell "the reread
  // a version switch triggered has landed" from "the pre-switch body is still
  // on screen" — the window the plain-text autosave used to write into
  // (#579 adversarial review, F1).
  const [readSeq, setReadSeq] = useState(0);
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
        setReadSeq((seq) => seq + 1);
      })
      .catch(() => {
        if (cancelled) return;
        setText(null);
        setError(true);
        // A failed reread still ANSWERS: leaving writes refused forever would
        // strand every later save on a file the user can still edit.
        setReadSeq((seq) => seq + 1);
      });
    return () => {
      cancelled = true;
    };
    // refreshKey bumps on workspace activity so an open file re-reads when it
    // changes on disk (e.g. an agent edits it).
  }, [workspaceId, path, enabled, refreshKey]);
  return { text, loadedPath, truncated, error, readSeq };
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
function CopySourceButton(props: {
  getSource: () => string | null;
  // The default is pinned by e2e; the orphaned-draft notice (#567) renders its
  // own copy control beside a possible source view, so it needs its own name.
  testId?: string;
}) {
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
      data-testid={props.testId ?? "markdown-source-copy"}
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

// The restore half of #567's cancel-and-restore: one row per set-aside
// draft, oldest first, because a second reopen must not cost the first draft
// its row (#579 review, P2). Self-contained on the module store, so every
// surface where the keyed document view dies — the editor branches AND the
// not-in-version refusal — can show the same recovery.
function OrphanedDraftNotices(props: { workspaceId: string; path: string }) {
  const drafts = useOrphanedDrafts(props.workspaceId, props.path);
  if (drafts.length === 0) return null;
  return (
    <div>
      {drafts.map((draft) => (
        <div
          key={draft.id}
          data-testid="orphaned-draft-notice"
          className="flex items-center justify-between gap-2 border-b border-line bg-panel px-4 py-1 text-[11px]"
        >
          <span className="text-danger">
            This document reopened before your last edit saved. Copy your text
            to keep it.
          </span>
          <div className="flex items-center gap-2">
            <CopySourceButton
              testId="orphaned-draft-copy"
              getSource={() => draft.text}
            />
            {/* Deleting the only copy needs the explicit confirm step (#579
                review, r6) — the same control the recovery list uses. */}
            <DismissDraftControls
              onDismiss={() =>
                dismissOrphanedDraft(props.workspaceId, props.path, draft.id)
              }
            />
          </div>
        </div>
      ))}
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

// The plain-text autosave, used by every NON-markdown editable view (CSV,
// JSON, text). It carries the same three write seams as MarkdownView — an
// armed timer, an unmount flush, and the shell's flush — and until #579's
// adversarial review it carried none of the opening gate, because `opening`
// only ever existed inside MarkdownView. A version switch bumps `reopenKey`,
// the reread it triggers leaves the PRE-switch body on screen, and the armed
// timer landed that body on the POST-switch tree. That is #567's exact
// mechanism on the surfaces #567 never covered.
//
// Every gate here reads a REF at call time, never a prop. Routing the signal
// through `disabled` (or any dep) is actively worse: the unmount-flush effect
// would re-run on the flip, and its PREVIOUS cleanup — whose closure still
// says writes are allowed — would issue the very write the flip was meant to
// stop.
function useAutosavedTextDraft(props: {
  body: string;
  workspaceId: string;
  path: string;
  disabled?: boolean;
  // Bumped when the active version changes. The transition sets a pending
  // draft aside exactly as MarkdownView's render-phase capture does.
  reopenKey?: number;
  // Live refusal from the parent: a version switch whose reread has not
  // answered yet. Reactive, because the hook must also see it LIFT.
  writesRefused?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  registerDraftFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [draft, setDraft] = useState(props.body);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const latestDraft = useRef(props.body);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsavedDraft = useRef(false);
  // Assigned during render, read at call time — `readOnlyRef` precedent.
  const disabledRef = useRef(props.disabled);
  disabledRef.current = props.disabled;
  const writesRefusedRef = useRef(props.writesRefused);
  writesRefusedRef.current = props.writesRefused;
  const writesBlocked = () =>
    disabledRef.current === true || writesRefusedRef.current === true;

  useEffect(() => {
    props.onSaveStateChange?.(saveState);
  }, [saveState, props.onSaveStateChange]);

  useEffect(() => {
    if (unsavedDraft.current) return;
    setDraft(props.body);
    latestDraft.current = props.body;
    setSaveState("saved");
  }, [props.body, props.path]);

  // Cancel-and-restore, during the render that first sees the new version
  // (#567, extended to these views by #579's adversarial review). The armed
  // write would land the previous version's text on the tree the switch just
  // bound; dropping it silently would lose keystrokes. So it is set aside into
  // the same store the markdown notice reads, and the surface goes back to the
  // document.
  const reopenKeyRef = useRef(props.reopenKey);
  const wasRefused = useRef(props.writesRefused);
  // Two moments, one transition: the switch itself, and the reread landing
  // with something typed while writes were refused. Both leave a draft built
  // on the version the user has left.
  const refusalLifted =
    wasRefused.current === true && props.writesRefused !== true;
  wasRefused.current = props.writesRefused;
  if (props.reopenKey !== reopenKeyRef.current || refusalLifted) {
    reopenKeyRef.current = props.reopenKey;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (unsavedDraft.current) {
      unsavedDraft.current = false;
      captureOrphanedDraft(props.workspaceId, props.path, latestDraft.current);
      setSaveState("saved");
      setDraft(props.body);
      latestDraft.current = props.body;
    }
  }

  async function writeDraftNow(options: { rejectOnError?: boolean } = {}): Promise<void> {
    if (writesBlocked()) return;
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
    // Deliberately NOT gated on writesBlocked(): swallowing the keystroke here
    // would lose it silently when the reread lands and the sync effect
    // repaints. It arms as normal, the write seams refuse it, and the capture
    // below sets it aside when the refusal lifts.
    if (disabledRef.current === true) return;
    unsavedDraft.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 800);
  }

  const { workspaceId, path, registerDraftFlush } = props;
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (!unsavedDraft.current) return;
      // A pending draft that cannot be written is SET ASIDE, never dropped
      // (#579 adversarial review, F3). A reread that REJECTS selects the error
      // branch in the same commit that lifts the refusal, so this view is gone
      // before it can render again and act on the lift — waiting to observe it
      // loses the user's text with no notice. Capturing here needs nothing to
      // survive: it is the last moment this draft exists.
      unsavedDraft.current = false;
      if (writesBlocked()) {
        captureOrphanedDraft(workspaceId, path, latestDraft.current);
        return;
      }
      void bridge()
        .writeWorkspaceText({
          workspaceId,
          relativePath: path,
          text: latestDraft.current,
        })
        .catch(() => undefined);
    };
    // `disabled` is deliberately NOT a dep: as one it made every flip run this
    // cleanup with the PREVIOUS render's value captured, so turning writes off
    // was itself a write (#534's lesson, and #579's adversarial review found
    // the same trap waiting here). The ref carries the current value to a real
    // unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path]);

  useEffect(() => {
    if (!registerDraftFlush) return;
    registerDraftFlush(async () => {
      if (!unsavedDraft.current || writesBlocked()) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await writeDraftNow({ rejectOnError: true });
    });
    return () => registerDraftFlush(null);
    // writeDraftNow uses refs for the draft; workspace/path are stable per keyed inspector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush]);

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
// What the engine save-state chip says, one row per state. A `Record` over the
// state union rather than a ternary chain, so a new save state is a
// compile-time omission instead of one that silently renders "Couldn't save".
// `recovery` is the shell's own state (#579), not an engine one: an unresolved
// set-aside draft beside a settled document.
//
// `title` is absent where the label already says everything.
const ENGINE_CHIP: Record<
  EngineDocSaveState | "recovery",
  { label: string; title?: string }
> = {
  saved: { label: "Saved" },
  saving: { label: "Saving…" },
  error: {
    label: "Couldn't save",
    title:
      "Your edits are still here, but dohc can't confirm the file on disk matches them. Keep this document open and try another edit.",
  },
  "file-locked": {
    label: "File in use",
    title:
      "Another program has this file open, so dohc can't update it on disk. dohc has your edits saved and retries until the file is free.",
  },
  "read-only": {
    label: "Read-only",
    title:
      "This document is shared with you to read. Your changes stay on screen but are not saved.",
  },
  "changed-on-disk": {
    label: "Changed on disk",
    title:
      "This file changed outside dohc while it was open. Open History to restore your text.",
  },
  recovery: {
    label: "Edit set aside",
    title:
      "A set-aside edit is not saved. Copy or dismiss it in the notice below.",
  },
};

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
  chatMentionsAvailable?: boolean;
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
  // The engine refused the open because the path is not in this workspace's
  // version (#534). `discardedEdit` is true when the user had typed and that
  // draft was thrown away rather than written — the inspector owes them that
  // fact, because nothing else will tell them.
  // Whether an unsaved draft is pending, reported on every render. The
  // inspector needs this AT REFUSAL TIME, and by then this component is gone:
  // the commit that learns of the refusal is the one that replaces it, so a
  // callback fired from here at that moment would never run. Reporting
  // continuously means the inspector already holds the answer. The setter bails
  // out when the value is unchanged, so this costs a comparison per render.
  onPendingDraftChange?: (pending: boolean) => void;
  // The engine open, opened by the INSPECTOR and passed down. It deliberately
  // does not live here: this component is unmounted by the inspector's own
  // loading/error branch, and a version switch that removes the file makes the
  // reread fail before the queued open answers — so an open owned here would be
  // cancelled by the very race its refusal exists to name (#534, codex P2).
  engine: UseEngineDoc;
  // Reopen the engine session after `engine.openTimedOut` (#564). Owned by
  // the inspector, like the open itself. REQUIRED: the timeout notice must
  // never render without its retry, and the one caller always passes it.
  onRetryEngineOpen: () => void;
  // Set by the inspector the instant the engine refuses this path. Read by
  // every write guard BESIDE `readOnlyRef`, because the refusal arrives in the
  // same commit that unmounts this component — there is no render of it here to
  // fold into `readOnly` (#534).
  writesRefusedRef: { current: boolean };
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

  const engine = props.engine;
  // #533. The engine open runs ON the capture chain, so a document opened
  // while that chain is busy (startup reconciliation of a 1,000-file
  // workspace, a version switch) waits before dohc knows whether it is
  // engine-backed. `available: false` alone cannot tell that wait apart from
  // "not engine-backed", so this surface used to answer it with the plain
  // editor — writable, autosaving STRAIGHT TO DISK — while the session about
  // to bind seeded from the engine head. Keystrokes in that window took a path
  // that session never sees. Nothing here is writable until the open answers.
  const opening = engine.opening;
  // What the user SEES, as against `mode`, which is what the user CHOSE. An
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
  // Search lands HERE. ONE jump at a time, in one of two states: the LINE the
  // result named, and — once the engine editor has something to map it
  // against — the BLOCK holding that line (#661). Whichever surface owns the
  // document consumes it: the plain source textarea selects the line, the
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
  // against yet (#533) — because both states live here.
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
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const wysiwygRef = useRef<MarkdownEditorHandle | null>(null);
  const latestDraft = useRef(props.body);
  const serializeDraftRef = useRef<() => string>(() => props.body);
  const editing = surfaceMode !== "read";
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True from the keystroke until a write for that draft has been ISSUED.
  // The unmount flush keys off this — never off the timer handle, which stays
  // set (already fired) after a completed autosave and would double-write.
  const unsavedDraft = useRef(false);
  // ONE queue, joined at ENTRY (#579 review, r15). The earlier design tracked
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
  // Writers that have ENTERED and not yet finished. Zero means the queue is
  // idle and the next writer can run without deferring (see writeDraftNow).
  const writersLive = useRef(0);
  // Armed while the flush drains. A writer arriving now holds text from the
  // version (or path) the caller is about to leave: running it before the
  // change races the flush, and running it after IS the clobber #567 is
  // about. So it is REFUSED rather than re-armed — re-arming would write
  // pre-switch text onto the post-switch tree. The draft stays unsaved, and
  // the reopen's render-phase capture above sets it aside.
  const flushBarrier = useRef(false);

  // #567 cancel-and-restore: the moment `opening` flips true, the pending
  // draft leaves the save pipeline. Writing it would land the previous
  // version's text on the tree the reopen is binding; dropping it would lose
  // keystrokes silently. So the armed autosave is cancelled, the draft is set
  // aside, and the notice below surfaces it for the user to copy.
  //
  // The drafts live in a module store keyed by workspace + path, not in this
  // component's state: the notice promises the text stays recoverable, and
  // this view unmounts on every tab switch (#579 review, P1). The hook
  // subscribes; the capture appends.
  //
  // The capture runs DURING RENDER, not in an effect, for two reasons. The
  // armed 800ms timer can fire between this commit and a passive effect — by
  // then it has written. And `serializeDraftRef` still holds the PREVIOUS
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
      captureOrphanedDraft(
        props.workspaceId,
        props.path,
        serializeDraftRef.current(),
      );
      // The armed save will never issue, so "saving" must not stand. The
      // set-aside edit's own signal is DERIVED from the store below — that
      // way Dismiss retires it (#579 review, P2) instead of stranding an
      // error chip on a draft that no longer exists.
      setSaveState("saved");
      // The surface goes back to the document. Clearing the flag lets the
      // props.body sync effect take over when a dependency fires — but in
      // READ mode `editing` never flips and the reopened body can be
      // byte-identical, so that effect has nothing to fire on and the
      // set-aside title/property edit would keep painting the view and ride
      // into the next property save (#579 review, r7). Reset here.
      setDraft(props.body);
      setSavedBody(props.body);
      latestDraft.current = props.body;
    }
  }
  openingRef.current = opening;
  // What the header chip shows: a real pending/failed save wins; otherwise an
  // unresolved set-aside draft gets its OWN state (#579 review, P2). The
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

  serializeDraftRef.current = () => {
    // WYSIWYG mode: the Tiptap editor owns the body while inline PageIdentity /
    // PropertiesPanel own the frontmatter (both write frontmatter through
    // latestDraft.current). Merge the live editor body over that frontmatter so
    // a save never emits the stale mount-time body. Source mode edits the full
    // markdown directly in the textarea, so latestDraft.current is canonical.
    if (surfaceMode === "wysiwyg") {
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
  const serializeEngineDraft = (): string | null => {
    // The mounted editor is the ONLY serializer of the canonical Y.Doc, so
    // without it there is no honest body to emit for an engine-backed
    // document: `props.body` is the markdown CACHE beside that doc. It lags
    // every edit the Y.Doc has taken since the read, and on the recovery path
    // (a failed read whose retry bound the document, #564) it is empty. Both
    // export a file that is not the user's document while reporting success,
    // and emptiness was never the thing that made it wrong — the Y.Doc being
    // canonical is. Refuse; the menu says the document is not ready.
    const editorBody = wysiwygRef.current?.getMarkdown();
    if (editorBody === undefined && engine.doc !== null) return null;
    const body = editorBody ?? markdownEditorBody(props.body);
    const liveMeta = engine.doc
      ? (Object.fromEntries(
          engine.doc.getMap(ENGINE_FRONTMATTER_FIELD).entries(),
        ) as Record<string, unknown>)
      : parseFrontmatter(latestDraft.current).meta;
    return applyFrontmatter(body, orderFrontmatter(liveMeta));
  };

  useEffect(() => {
    if (surfaceMode === "read") void loadMarkdownEditor();
  }, [surfaceMode, props.path]);

  useEffect(() => {
    if (jump?.kind !== "line" || surfaceMode !== "source") return;
    const textarea = editorRef.current;
    if (!textarea) return;
    const { start, end } = lineSpanInText(textarea.value, jump.line);
    textarea.focus();
    textarea.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 21;
    textarea.scrollTop = Math.max(
      0,
      (jump.line - 1) * lineHeight - textarea.clientHeight / 3,
    );
    setJump(null);
  }, [jump, surfaceMode]);

  const { onSaveStateChange } = props;

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

  // The engine refused because the path is not in the version this workspace is
  // on (#534). The plain editor is writable too, so falling back to it would
  // autosave the file the version switch removed back into the version as a
  // phantom. Hand the refusal up; the caller replaces the document.
  //
  // A pending draft reached disk by two routes, and turning the document
  // read-only closed NEITHER, because both held a stale `readOnly`: the armed
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
    // Set-aside drafts (#567) deliberately do NOT count: they are not
    // discarded — the store outlives this view and the refusal screen renders
    // their notice itself, Copy included.
    onPendingDraftChange?.(unsavedDraft.current);
  });
  const readOnly =
    !!props.forceReadOnly ||
    engine.notInVersion ||
    // #564: the engine open hit its retry deadline. The plain editor stays
    // read-only — its autosave would race the session the engine may still
    // bind — and the notice below states the reason and offers the retry.
    engine.openTimedOut ||
    (props.truncated && !engine.available);
  // Every write guard reads THIS, never the captured `readOnly`. Assigned
  // during render so a cleanup or an armed timer that runs after the flip sees
  // the flip. See writeDraftNow and the unmount flush.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // The single question all three write paths ask. Both refs, because they
  // close different gaps: `readOnlyRef` a flip this component rendered,
  // `writesRefusedRef` a refusal it never got to render.
  const { writesRefusedRef } = props;
  const writesBlocked = useCallback(
    () => readOnlyRef.current || writesRefusedRef.current,
    [writesRefusedRef],
  );
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
  // The engine branch's scroller. It holds the top-matter (title, properties)
  // ABOVE the editor, which is where a frontmatter search hit actually lives.
  const engineDocPaneRef = useRef<HTMLDivElement | null>(null);
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
      // The heading is the reader's newest destination, so a search jump that
      // has not landed yet is over. Left pending it lands the moment the lazy
      // editor arrives and pulls them off the heading they just chose.
      setJump(null);
      return;
    }
    const source = surfaceMode === "source" ? latestDraft.current : savedBody;
    const markdown = markdownEditorBody(source);
    const headings = extractWorkspaceHeadings(markdown);
    const heading = resolveWorkspaceHeadingAnchorTarget(headings, props.headingTarget);
    if (!heading) return;
    if (surfaceMode === "source") {
      // Local source is an intentional editing/viewing mode. Keep it visible
      // and select the heading's real markdown line instead of replacing it
      // with the rich editor merely to navigate.
      setJump({ kind: "line", line: heading.line + frontmatterLineCount(source) });
      return;
    }
    if (readOnly || surfaceMode === "read") {
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
  // The engine editor's line-jump seam (#661). Engine mode renders no source
  // textarea, so before this every engine-backed search result opened at the
  // top of the document. The jump is retired HERE, once, for every engine-
  // backed open — including the recovery path, whose `props.body` is empty
  // (the failed read, #564) and therefore resolves to the first block.
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
      // rendered by PageIdentity/PropertiesPanel ABOVE the editor, so there is
      // no body block to reveal — and revealing the first one would scroll the
      // real match off the top. Show the top of the document instead — after
      // the pane is visible, because `setShowSource` above only SCHEDULES the
      // unhide and a hidden element cannot be scrolled.
      setJump({ kind: "top" });
    } else {
      // The line BECOMES the block, which is what retires it: a jump still
      // waiting on the lazy editor names the result before this one, and
      // would land the moment that editor arrives.
      setJump({
        kind: "block",
        index: blockIndexForLine(body, bodyLine),
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
    if (surfaceMode === "source") {
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
      // The REAL save state only — a set-aside draft is deliberately not
      // lifted here (#579 review, P2). Lifting it as "error" made the shell's
      // save-first machinery promise a save the flush cannot deliver; the
      // shell reads the store itself for the tab dot instead.
      onSaveStateChange?.(saveState);
      return;
    }
    // The shell's dot has three states; a read-only, file-locked, or
    // changed-on-disk refusal is an unsaved document as far as the tab is
    // concerned.
    onSaveStateChange?.(
      engine.saveState === "read-only" ||
        engine.saveState === "file-locked" ||
        engine.saveState === "changed-on-disk"
        ? "error"
        : engine.saveState,
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

  async function writeDraftNow(
    options: { rejectOnError?: boolean; fromFlush?: boolean } = {},
  ): Promise<void> {
    // Refused, not queued (see flushBarrier): a writer that joined behind the
    // barrier could only ever land stale text. Silent, because the flush owns
    // the save state from here — it either lands this same draft itself or
    // the reopen sets it aside.
    if (flushBarrier.current && !options.fromFlush) return;
    const run = async (): Promise<void> => {
      // The REFS, not captured values. The 800ms autosave timer holds the
      // closure from the render that armed it, where readOnly was false — so
      // a document that turned read-only after the keystroke still wrote
      // (#534). And this runs after everything ahead of it in the queue, so
      // `readOnly`/`opening` may have flipped meanwhile; the refs carry the
      // current answer. Writes are blocked (a read-only view, or the version
      // refusal). The edit does NOT reach disk — and the indicator must stop
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
        setSaveState("error");
        return;
      }
      // Serialized HERE, not at enqueue: a writer that waited reads the
      // newest text, so an older queued write can never land over a newer one
      // (#579 review, r4).
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
    };
    // Synchronous when the queue is idle. Callers like the source-mode toggle
    // serialize-then-switch-mode in ONE tick, and switching re-points
    // serializeDraftRef at the Tiptap parse — deferring the serialize by even
    // a microtask would write that lossy parse instead of the typed source.
    // Only a writer that must actually wait is deferred.
    const runsNow = writersLive.current === 0;
    writersLive.current += 1;
    const queued = (runsNow ? run() : writeChain.current.then(run)).finally(
      () => {
        writersLive.current -= 1;
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
    saveTimer.current = setTimeout(() => void saveNow(), AUTOSAVE_DEBOUNCE_MS);
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
    // `opening` too, so Ctrl+/ answers the same as the disabled button (#533).
    if (readOnly || opening) return;
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
  //
  // `readOnly` is READ FROM A REF and is deliberately not a dependency. As a
  // dependency it made every read-only transition run this cleanup with the
  // PREVIOUS render's value captured, so turning the document read-only was
  // itself a write (#534). The ref carries the current value to a real unmount.
  const { workspaceId, path } = props;
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // `opening` too (#567): unmounting mid-reopen must not land the
      // previous version's draft on the tree the reopen is binding.
      if (!unsavedDraft.current) return;
      unsavedDraft.current = false;
      const text = serializeDraftRef.current();
      // Same invariant as the plain-text hook (#579 adversarial review, F3):
      // a draft this unmount may not write is set aside rather than dropped.
      // The render-phase capture normally runs first, but it cannot when the
      // branch above replaces this view in the very commit that flips
      // `opening` — and this cleanup is already willing to WRITE this exact
      // value, so keeping it can only be safer than losing it.
      //
      // DECLARED UNPINNED, and it stays that way after #564. No test enters
      // this branch with a draft the render-phase capture did not already
      // take: reaching it needs the engine open and the file read to land in
      // the same batch. Both conditions are conservative on purpose —
      // `openingRef` holds the last RENDERED value and `writesBlocked` reads
      // the parent's ref, so neither depends on this view living long enough
      // to observe the refusal. Kept as a backstop, not as covered code.
      if (writesBlocked() || openingRef.current) {
        captureOrphanedDraft(workspaceId, path, text);
        return;
      }
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
      // A write already past the guards is the same obligation as an armed
      // timer (#579 review, r3): the caller is about to move paths or switch
      // versions, and must not proceed while the previous state's text is
      // still landing. If that write FAILS, `unsavedDraft` is true again by
      // the time this resumes, and the seam's own write below lands it before
      // the move.
      //
      // A BARRIER in the write queue, not a poll of it (#579 review, r15).
      // Arming and reading the tail are one synchronous step, so no writer
      // can slip between them.
      flushBarrier.current = true;
      try {
        // Everything already enqueued — in flight OR parked behind it — runs
        // to completion ahead of this point, and nothing can join behind.
        await writeChain.current;
        // This seam is now the only writer that can exist. Land the draft, so
        // the keystrokes reach disk while this path and this version still
        // mean what the editor shows. The REFS, not captured values: the
        // shell can call this between the refusal and the re-registration,
        // and `opening` (#567) means a flush arriving mid-reopen must not
        // write the previous version's draft. A write that FAILS leaves
        // `unsavedDraft` true, and the unmount flush gets the next shot.
        if (!unsavedDraft.current || writesBlocked() || openingRef.current) {
          return;
        }
        if (saveTimer.current) clearTimeout(saveTimer.current);
        await writeDraftNow({ rejectOnError: true, fromFlush: true });
      } finally {
        flushBarrier.current = false;
      }
      // INVARIANT at return: the queue is empty. No writer — in flight,
      // parked, or arriving during the drain — survives this seam holding
      // text from before the caller's change.
    });
    return () => registerDraftFlush(null);
    // writeDraftNow reads refs (latestDraft) + per-mount-stable props only, so the
    // first render's closure stays correct for the whole mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerDraftFlush]);

  // The restore half of #567: each set-aside draft stays copyable until the
  // user takes it or dismisses it. Rendered in both branches below — the
  // reopen can resolve into either editor.
  const orphanedDraftNotice = (
    <OrphanedDraftNotices workspaceId={props.workspaceId} path={props.path} />
  );

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
                title={ENGINE_CHIP[engineChipState].title}
                className={`font-mono text-[11px] ${
                  engineChipState === "saved" || engineChipState === "saving"
                    ? "text-subtle"
                    : "text-danger"
                }`}
              >
                {ENGINE_CHIP[engineChipState].label}
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
        {orphanedDraftNotice}
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
                blockTarget={jump?.kind === "block" ? jump : undefined}
                onBlockTargetConsumed={retireJump}
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
            {/* The wait has its own word (#533): an opening document is not a
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
                // browser does not reliably draw a tooltip over a DISABLED
                // control. This span is not disabled, so hovering the state
                // always explains it.
                title="You can edit this document when it finishes opening."
                className="font-mono text-[11px] text-subtle"
              >
                Opening…
              </span>
            ) : null}
            {/* Independent of "Opening…", not its else-branch (#567): a save
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
                // document, or refuse. This branch shows the DISK, and until
                // the engine open ANSWERS there is no telling whether the
                // disk is the document — a session that binds a moment later
                // may hold replicated updates the file has never seen (#564,
                // codex r19/r21). Refuse for the whole unresolved window,
                // which the editor beside this menu already spends read-only
                // or opening. The refusal reads "Document not open", and the
                // notice below offers the retry that resolves it.
                //
                // `opening` is the wait and `openTimedOut` is the wait giving
                // up; both mean the same thing to an export. Once the open
                // answers "not engine-backed", the file IS the document and
                // this lifts.
                getMarkdown={() =>
                  engine.opening || engine.openTimedOut
                    ? null
                    : serializeDraftRef.current()
                }
              />
            ) : null}
          </>
        }
      />
      {props.truncatedNotice}
      {/* "Try again" after a timed-out open (#564). It retries and nothing
          else: the retry changes the request key, so `opening` flips true in
          that same render and the capture above sets a draft typed before the
          timeout aside — where the user can copy it — instead of letting it
          reach disk over the artifact the engine is binding (#567). */}
      {engine.openTimedOut ? (
        <EngineOpenTimedOutNotice onRetry={props.onRetryEngineOpen} contentShown />
      ) : null}
      {orphanedDraftNotice}
      {surfaceMode === "source" ? (
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
      ) : surfaceMode === "wysiwyg" ? (
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
            {/* Title, icon and properties autosave through the SAME disk write
                as the body, so the opening refusal covers them too (#533). */}
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
  reopenKey,
  writesRefused,
  onSaveStateChange,
  registerDraftFlush,
}: {
  reopenKey?: number;
  writesRefused?: boolean;
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
    reopenKey,
    writesRefused,
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
  reopenKey,
  writesRefused,
  onSaveStateChange,
  registerDraftFlush,
  pendingUndo,
  onPendingUndoConsumed,
}: {
  reopenKey?: number;
  writesRefused?: boolean;
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
    reopenKey,
    writesRefused,
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

// #564: the engine open hit its retry deadline. The document stays read-only
// — never the writable plain editor — with the reason stated and the retry
// offered where the user is looking.
function EngineOpenTimedOutNotice(props: {
  onRetry: () => void;
  // Is the document's content on screen? When the read failed too, it is
  // not — and "It is read-only for now" would promise read access to
  // content the user cannot see.
  contentShown: boolean;
}) {
  return (
    <div
      data-testid="engine-open-timeout-notice"
      className="flex items-center justify-between gap-2 border-b border-line bg-panel-2 px-4 py-1 text-[11px] text-warning"
    >
      {/* "document", the noun the editing controls beside this already use
          ("You can edit this document when it finishes opening.").

          No "in time": this notice answers every refusal `main` maps to
          `openTimedOut`, and only one of them is a timeout. A session the
          daemon would not release refuses IMMEDIATELY, and naming a cause the
          user did not hit sends them looking for a slow machine (#564, codex
          r20). What is true of all of them is the sentence below, and the
          retry is the same either way. */}
      <span>
        dohc could not open this document for editing.
        {props.contentShown ? " It is read-only for now." : ""}
      </span>
      <button
        type="button"
        onClick={props.onRetry}
        className="text-subtle hover:text-ink"
      >
        Try again
      </button>
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
  // Whether this workspace has the capture Chats calls need (#615). The
  // linked-mentions panel asks main for chat mentions, which goes through
  // requireEngineCapture — so a shared view must not ask. Same name and same
  // fact GraphView's chat-mentions toggle reads.
  chatMentionsAvailable?: boolean;
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
  // Whether an unsaved draft is pending. Only MarkdownView knows (it owns the
  // draft), so it reports every render and this holds the answer BEFORE the
  // refusal arrives — which is the only way to have it, since the refusal
  // unmounts the reporter.
  const [pendingDraft, setPendingDraft] = useState(false);
  const { text, loadedPath, truncated, error, readSeq } = useTextContent(
    props.workspaceId,
    props.path,
    isText,
    props.refreshKey ?? 0,
  );
  // THE ENGINE OPEN LIVES HERE, above every branch that swaps the body out.
  // It used to live in MarkdownView, which the loading/error branch below
  // unmounts — and a version switch that removes the file bumps refreshKey and
  // engineVersionKey together, so the reread ENOENTs before the queued open
  // answers. The child went with the branch, the refusal landed on nobody, and
  // the user was told "Couldn't read this file": true of the read, silent about
  // the version (#534, codex P2).
  //
  // `enabled` waits for the read to ANSWER, so this opens no earlier than it
  // used to (and never for a truncated file). It deliberately does NOT go false
  // when that answer is a failure: a failed reread is exactly when the refusal
  // is on its way, and dropping `enabled` would cancel the open that carries it.
  const readAnswered = text !== null || error;
  // "Try again" after an open that hit its retry deadline (#564): part of the
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
      kind === "markdown" && readAnswered && !truncated && !props.readOnly,
    reopenKey: props.engineVersionKey,
    retryKey: engineRetryNonce,
  });
  // DERIVED, never stored. #565 keys the hook's outcome to the request that
  // asked for it, so a refusal for the version the user just LEFT cannot repaint
  // the one they just entered — which is what a sticky flag here used to risk.
  // DISCLOSED: a file that reappears in the SAME version (an agent recreates it)
  // leaves this notice up until the request changes. Reopening a daemon session
  // on every activity tick would churn the capture chain for no gain.
  const notInVersion = engine.notInVersion;
  // A version switch bumps engineVersionKey, and the reread it triggers leaves
  // the PRE-switch body on screen until it answers. Markdown has the engine
  // open to tell it so; the plain-text views have nothing, so this window is
  // where their autosave landed pre-switch text on the post-switch tree
  // (#579 adversarial review, F1). True from the switch until the next read
  // ANSWERS — success or failure, so a failed reread cannot strand writes.
  const switchReadPending = useRef(false);
  const seenVersionKey = useRef(props.engineVersionKey);
  const seenReadSeq = useRef(readSeq);
  if (seenVersionKey.current !== props.engineVersionKey) {
    seenVersionKey.current = props.engineVersionKey;
    seenReadSeq.current = readSeq;
    switchReadPending.current = true;
  }
  if (switchReadPending.current && readSeq !== seenReadSeq.current) {
    switchReadPending.current = false;
  }
  // Every engine state that is not a bound document, carried for a child that
  // might never render it. This component has exactly two branches that
  // replace the document — path-not-in-version (#534) and the failed read
  // below — and each one replaces the child in the same commit that learns of
  // the state, so the child's own refs still hold the pre-refusal value when
  // its unmount flush runs. A guard that works because a child observes a
  // state is defeated by unmounting that child, which is why these are
  // carried here rather than derived there. A REF the PARENT assigns during
  // render is what crosses that gap: the object identity is stable, so even
  // the child's first-render closures read the live value.
  const writesRefusedRef = useRef(false);
  writesRefusedRef.current =
    notInVersion || engine.opening || engine.openTimedOut;
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
  // describes was live (#564, codex round 3).
  const engineDocBound = engine.available && engine.doc !== null;
  // Consume the jump AFTER the child view's own effects applied it (child
  // effects run before this parent effect). Text views wait for the loaded
  // text; every other kind has nowhere to land, so consume immediately.
  //
  // A bound Y.Doc counts as the text, because it IS the document: the branch
  // below is bypassed and this commit shows the user everything it is ever
  // going to show for this jump. Asking only about DISK text left the jump
  // pending on the one path that has none, and the shell replayed it on a
  // later open of that path (#564, codex r15).
  const { scrollTarget, onScrollConsumed } = props;
  const textReady =
    !isText || engineDocBound || (text !== null && loadedPath === props.path);
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
  // Recovery follows the PATH, not the file kind (#579 review, r4): an
  // extension-changing rename remaps a markdown draft onto a text/CSV/binary
  // view, and Copy/Dismiss must exist wherever the marker shows. The markdown
  // branch renders its own copy inside its header layout.
  const recoveryNotices = (
    <OrphanedDraftNotices workspaceId={props.workspaceId} path={props.path} />
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
        {/* A reopen's set-aside drafts (#567) survive this refusal in the
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
        {engine.openTimedOut ? (
          // #564, codex round 2: a failed read returns HERE, before
          // MarkdownView mounts — without this the timeout had no notice and
          // no retry on exactly the path where the engine session is the only
          // way back to the content.
          <EngineOpenTimedOutNotice onRetry={retryEngineOpen} contentShown={false} />
        ) : null}
        {/* A failed read is exactly when the set-aside text matters most —
            the marker and the close warning must not point at actions this
            branch withholds (#579 review, r5). */}
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
            workspaceId={props.workspaceId}
            path={props.path}
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
            refreshKey={props.refreshKey}
            registerSourceToggle={props.registerSourceToggle}
            onPendingDraftChange={setPendingDraft}
            engine={engine}
            onRetryEngineOpen={retryEngineOpen}
            writesRefusedRef={writesRefusedRef}
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
          {recoveryNotices}
          <CsvView
            body={text ?? ""}
            workspaceId={props.workspaceId}
            path={props.path}
            onOpenPath={props.onOpenPath}
            truncated={truncated || !!props.readOnly}
            reopenKey={props.engineVersionKey}
            writesRefused={switchReadPending.current}
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
          {recoveryNotices}
          <TextEditorView
            body={text ?? ""}
            testId={kind === "json" ? "view-json" : "view-text"}
            language={kind === "json" ? "json" : extensionOf(props.path) || "text"}
            workspaceId={props.workspaceId}
            path={props.path}
            truncated={truncated || !!props.readOnly}
            reopenKey={props.engineVersionKey}
            writesRefused={switchReadPending.current}
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
}
