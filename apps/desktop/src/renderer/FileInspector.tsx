import {
  Database,
  FileText,
  Image as ImageIcon,
  LayoutGrid,
  Music,
  Table,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { bridge } from "./bridge";

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
function useTextContent(workspaceId: string, path: string, enabled: boolean) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setText(null);
    setError(false);
    void bridge()
      .readWorkspaceText({ workspaceId, relativePath: path })
      .then((r) => !cancelled && setText(r.text))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, path, enabled]);
  return { text, error };
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

function MarkdownView({ body }: { body: string }) {
  return (
    <div
      data-testid="view-markdown"
      className="min-h-0 flex-1 overflow-auto p-6 text-[14px]"
    >
      <Markdown components={MARKDOWN_COMPONENTS}>{body}</Markdown>
    </div>
  );
}

function CsvView({ body }: { body: string }) {
  const [raw, setRaw] = useState(false);
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
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="view-csv">
      <div className="flex items-center justify-end border-b border-line px-3 py-1">
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

export function FileInspector(props: { workspaceId: string; path: string }) {
  const kind = classifyForView(props.path);
  const isText = kind === "markdown" || kind === "csv" || kind === "json" || kind === "text";
  const { text, error } = useTextContent(props.workspaceId, props.path, isText);
  const url = assetUrl(props.workspaceId, props.path);

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
          <MarkdownView body={text ?? ""} />
        </div>
      );
    case "csv":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<Table size={13} aria-hidden />} path={props.path} label="data" />
          <CsvView body={text ?? ""} />
        </div>
      );
    case "json":
    case "text":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<FileText size={13} aria-hidden />} path={props.path} label={kind === "json" ? "json" : "text"} />
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
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<Database size={13} aria-hidden />} path={props.path} label="database" />
          <AffordanceCard
            testId="view-database"
            title="SQLite database"
            body="Database Studio — browse and query tables — arrives with the SQLite phase."
          />
        </div>
      );
    case "app-source":
      return (
        <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
          <ViewHeader icon={<LayoutGrid size={13} aria-hidden />} path={props.path} label="app" />
          <AffordanceCard
            testId="view-app"
            title="App source"
            body="This file is part of a dohc app package. The app runtime arrives with the apps phase."
          />
        </div>
      );
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
