import {
  FileText,
  Image as ImageIcon,
  Music,
  Table,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { AppPackageView } from "./AppPackageView";
import { DatabaseStudioView } from "./DatabaseStudioView";
import { bridge } from "./bridge";
import { useCollabDoc } from "./collab/useCollabDoc";

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

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const AUDIO_EXT = new Set(["m4a", "mp3", "wav", "ogg"]);
const DB_EXT = new Set(["sqlite", "sqlite3", "db"]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "csv", "json", "html", "tsx", "ts", "css", "js"]);

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
  return { text, truncated, error };
}

function ViewHeader(props: { icon: React.ReactNode; path: string; label: string }) {
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[13px]">
      {props.icon}
      <span className="font-mono text-ink">{props.path}</span>
      <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">
        {props.label}
      </span>
    </header>
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
function MarkdownView(props: { body: string; workspaceId: string; path: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.body);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraft = useRef(props.body);

  // Live co-editing only ever activates for SHARED cloud workspaces with a
  // signed-in session (the collabToken IPC returns available:false otherwise).
  // When it does, the textarea is driven by the shared Y.Text instead of the
  // local autosave path — personal/local-only stays byte-identical to today.
  const collab = useCollabDoc({
    workspaceId: props.workspaceId,
    path: props.path,
    enabled: true,
  });

  // External changes (agent edits, sync pulls) flow into the open document
  // only while NOT editing — mid-edit, the user's draft wins until saved.
  useEffect(() => {
    if (!editing) {
      setDraft(props.body);
      latestDraft.current = props.body;
    }
  }, [props.body, editing]);

  async function saveNow(): Promise<void> {
    setSaveState("saving");
    try {
      await bridge().writeWorkspaceText({
        workspaceId: props.workspaceId,
        relativePath: props.path,
        text: latestDraft.current,
      });
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  function onDraft(next: string) {
    setDraft(next);
    latestDraft.current = next;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), 800);
  }

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Materialize the converged CRDT back to the file on settle: while a live
  // session is canonical in-memory, the FILE is what enters history and cloud
  // sync, so every settle writes the shared text through the bounded write IPC.
  // No feedback loop — the collab editor is driven by Y.Text, not the file, so
  // the resulting watcher event never re-enters the doc. Idempotent across
  // peers (identical converged bytes → same sha → sync no-ops).
  useEffect(() => {
    if (!collab.enabled) return;
    const timer = setTimeout(() => {
      void bridge()
        .writeWorkspaceText({
          workspaceId: props.workspaceId,
          relativePath: props.path,
          text: collab.text,
        })
        .catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [collab.enabled, collab.text, props.workspaceId, props.path]);

  // Collab mode: the shared Y.Text drives the editor. There is no local save
  // state (the CRDT is canonical; main materializes to disk at settle points),
  // so the toolbar shows live presence instead. The textarea is always
  // editable — co-editing has no separate "Edit" gate.
  if (collab.enabled) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-end gap-2 border-b border-line px-3 py-1">
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
        </div>
        <textarea
          data-testid="collab-editor"
          value={collab.text}
          onChange={(e) => collab.setText(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-bg p-6 font-mono text-[13px] leading-relaxed text-ink outline-none"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-2 border-b border-line px-3 py-1">
        {editing ? (
          <span
            data-testid="markdown-save-state"
            data-state={saveState}
            className={`text-[11px] ${saveState === "error" ? "text-danger" : "text-subtle"}`}
          >
            {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Couldn't save"}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="markdown-edit-toggle"
          onClick={() => {
            if (editing && saveTimer.current) {
              clearTimeout(saveTimer.current);
              void saveNow();
            }
            setEditing((e) => !e);
          }}
          className="rounded px-2 py-0.5 text-[11px] text-subtle hover:text-ink"
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      {editing ? (
        <textarea
          data-testid="markdown-editor"
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
          className="min-h-0 flex-1 resize-none bg-bg p-6 font-mono text-[13px] leading-relaxed text-ink outline-none"
        />
      ) : (
        <div
          data-testid="view-markdown"
          className="min-h-0 flex-1 overflow-auto p-6 text-[14px]"
        >
          <Markdown components={MARKDOWN_COMPONENTS}>{props.body}</Markdown>
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
              {data.map((row, r) => (
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

function CodeView({ body, testId }: { body: string; testId: string }) {
  return (
    <pre
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
}) {
  const kind = classifyForView(props.path);
  const isText = kind === "markdown" || kind === "csv" || kind === "json" || kind === "text";
  const { text, truncated, error } = useTextContent(
    props.workspaceId,
    props.path,
    isText,
    props.refreshKey ?? 0,
  );
  const url = assetUrl(props.workspaceId, props.path);
  const truncatedNotice =
    isText && truncated ? (
      <TruncatedNotice workspaceId={props.workspaceId} path={props.path} />
    ) : null;

  if (isText && text === null) {
    // Keep the inspector frame mounted while loading/erroring so the surface
    // is stable (and testable) rather than flickering between containers.
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <ViewHeader icon={<FileText size={13} aria-hidden />} path={props.path} label="file" />
        <Empty>{error ? "Couldn't read this file." : "Loading…"}</Empty>
      </div>
    );
  }

  switch (kind) {
    case "markdown":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<FileText size={13} aria-hidden />} path={props.path} label="document" />
          {truncatedNotice}
          <MarkdownView body={text ?? ""} workspaceId={props.workspaceId} path={props.path} />
        </div>
      );
    case "csv":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<Table size={13} aria-hidden />} path={props.path} label="data" />
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
          <ViewHeader icon={<FileText size={13} aria-hidden />} path={props.path} label={kind === "json" ? "json" : "text"} />
          {truncatedNotice}
          <CodeView body={text ?? ""} testId={kind === "json" ? "view-json" : "view-text"} />
        </div>
      );
    case "image":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<ImageIcon size={13} aria-hidden />} path={props.path} label="image" />
          <ImageView url={url} path={props.path} />
        </div>
      );
    case "audio":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<Music size={13} aria-hidden />} path={props.path} label="audio" />
          <div className="flex flex-1 items-center justify-center p-4">
            <audio data-testid="view-audio" controls src={url} />
          </div>
        </div>
      );
    case "pdf":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<FileText size={13} aria-hidden />} path={props.path} label="pdf" />
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
        <DatabaseStudioView
          workspaceId={props.workspaceId}
          path={props.path}
          refreshKey={props.refreshKey}
        />
      );
    case "app-source":
      return <AppPackageView workspaceId={props.workspaceId} path={props.path} />;
    default:
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<FileText size={13} aria-hidden />} path={props.path} label="file" />
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
