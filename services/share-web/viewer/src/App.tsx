import { useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import {
  filesFromLog,
  isMarkdown,
  isRasterImage,
  isSvg,
  resolveSharedFile,
  resolveSharedImage,
  type RelayOp,
  type SharedFile,
  type ViewMeta,
} from "./model";

const SESSION_HEADER = "x-dohc-link-session";
const SESSION_PATH = /^\/s\/([A-Za-z0-9_-]{12})\/?$/u;
const MAX_LOG_PAGES = 10_000;
const LOG_RETRY_INITIAL_MS = 1_000;
const LOG_RETRY_MAX_MS = 15_000;
const LOG_RETRY_BUDGET_MS = 120_000;

type ViewerState =
  | { status: "loading" }
  | { status: "refused" }
  | { status: "ready"; session: string; meta: ViewMeta; files: SharedFile[] };

async function api(session: string, path: string): Promise<Response> {
  return fetch(path, {
    credentials: "same-origin",
    headers: { [SESSION_HEADER]: session },
  });
}

async function loadLog(session: string): Promise<RelayOp[]> {
  let cursor = 0;
  const ops: RelayOp[] = [];
  for (let pageNumber = 0; pageNumber < MAX_LOG_PAGES; pageNumber += 1) {
    let retryDelayMs = LOG_RETRY_INITIAL_MS;
    let retryWaitedMs = 0;
    let response: Response;
    while (true) {
      response = await api(session, `/api/view/log?since=${cursor}&limit=500`);
      if (response.status !== 429) break;
      if (retryWaitedMs + retryDelayMs > LOG_RETRY_BUDGET_MS) {
        throw new Error("refused");
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelayMs));
      retryWaitedMs += retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, LOG_RETRY_MAX_MS);
    }
    if (!response.ok) throw new Error("refused");
    const page = (await response.json()) as {
      ops?: unknown;
      nextCursor?: unknown;
      hasMore?: unknown;
    };
    if (!Array.isArray(page.ops) || typeof page.nextCursor !== "number") {
      throw new Error("refused");
    }
    ops.push(...(page.ops as RelayOp[]));
    if (page.hasMore !== true) return ops;
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= cursor) {
      throw new Error("refused");
    }
    cursor = page.nextCursor;
  }
  throw new Error("refused");
}

async function establishSession(): Promise<string> {
  const secret = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    const exchange = fetch("/api/exchange", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    history.replaceState(null, "", "/s/");
    const response = await exchange;
    if (!response.ok) throw new Error("refused");
    const body = (await response.json()) as { session?: unknown };
    if (typeof body.session !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(body.session)) {
      throw new Error("refused");
    }
    history.replaceState(null, "", `/s/${body.session}`);
    return body.session;
  }
  if (location.hash) history.replaceState(null, "", "/s/");
  const pathSession = SESSION_PATH.exec(location.pathname)?.[1];
  if (!pathSession) throw new Error("refused");
  return pathSession;
}

function relativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((timestamp - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function Freshness(props: { lastSettledAtMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (props.lastSettledAtMs === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [props.lastSettledAtMs]);
  return (
    <div className="freshness">
      {props.lastSettledAtMs === null
        ? "No settled changes"
        : `Last settled ${relativeTime(props.lastSettledAtMs, now)}`}
    </div>
  );
}

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  files: SharedFile[];
}

function fileTree(files: SharedFile[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const segment of parts.slice(0, -1)) {
      let child = folder.folders.find((candidate) => candidate.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: folder.path ? `${folder.path}/${segment}` : segment,
          folders: [],
          files: [],
        };
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  const sort = (folder: FolderNode) => {
    folder.folders.sort((left, right) => left.name.localeCompare(right.name));
    folder.files.sort((left, right) => left.path.localeCompare(right.path));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function Folder(props: {
  node: FolderNode;
  selected: string;
  onSelect: (file: SharedFile) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li>
      <button className="folder" type="button" onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {props.node.name}
      </button>
      {open ? (
        <ul>
          {props.node.folders.map((folder) => (
            <Folder key={folder.path} {...props} node={folder} />
          ))}
          {props.node.files.map((file) => (
            <li key={file.path}>
              <button
                className={props.selected === file.path ? "file selected" : "file"}
                type="button"
                onClick={() => props.onSelect(file)}
              >
                {file.path.split("/").at(-1)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function FileView(props: {
  session: string;
  file: SharedFile;
  files: SharedFile[];
  onSelect: (path: string) => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rendersMarkdown = props.file.contentKind === "text" && isMarkdown(props.file.path);
  const fileMap = useMemo(
    () => new Map(props.files.map((file) => [file.path, file])),
    [props.files],
  );
  useEffect(() => {
    let current = true;
    setMarkdown(null);
    setFailed(false);
    if (!rendersMarkdown) return () => { current = false; };
    void api(props.session, `/api/view/blob/${props.file.blobSha256}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("refused");
        const text = await response.text();
        if (current) setMarkdown(text);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => { current = false; };
  }, [props.file, props.session, rendersMarkdown]);

  if (failed) return <Unavailable />;
  if (rendersMarkdown) {
    if (markdown === null) return <p className="muted">Loading file</p>;
    return (
      <MarkdownContent
        markdown={markdown}
        resolveImage={(href) =>
          resolveSharedImage(href, props.file.path, fileMap, props.session)
        }
        resolveLink={(href) =>
          resolveSharedFile(href, props.file.path, fileMap)?.path ?? null
        }
        onNavigate={props.onSelect}
      />
    );
  }
  if (isRasterImage(props.file.path)) {
    return (
      <img
        className="preview-image"
        src={`/api/view/blob/${props.file.blobSha256}?session=${props.session}`}
        alt={props.file.path.split("/").at(-1) ?? "Shared image"}
      />
    );
  }
  return (
    <div className="download-card">
      <p>{isSvg(props.file.path) ? "SVG files open as downloads." : "This file opens as a download."}</p>
      <a
        href={`/api/view/blob/${props.file.blobSha256}?session=${props.session}`}
        download={props.file.path.split("/").at(-1)}
      >
        Download file
      </a>
    </div>
  );
}

function Unavailable() {
  return <main className="state"><p>This link isn't available.</p></main>;
}

export function App() {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [selectedPath, setSelectedPath] = useState("");
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const session = await establishSession();
        const [metaResponse, ops] = await Promise.all([
          api(session, "/api/view/meta"),
          loadLog(session),
        ]);
        if (!metaResponse.ok) throw new Error("refused");
        const meta = (await metaResponse.json()) as ViewMeta;
        if (meta.access !== "view" || meta.effectiveSelector.access !== "view") {
          throw new Error("refused");
        }
        const files = filesFromLog(ops);
        if (current) {
          setSelectedPath(files[0]?.path ?? "");
          setState({ status: "ready", session, meta, files });
        }
      } catch {
        if (current) setState({ status: "refused" });
      }
    })();
    return () => { current = false; };
  }, []);

  if (state.status === "refused") return <Unavailable />;
  if (state.status === "loading") return <main className="state"><p>Opening shared files</p></main>;
  const selected = state.files.find((file) => file.path === selectedPath) ?? state.files[0];
  const tree = fileTree(state.files);
  return (
    <div className="viewer">
      <header>
        <div>
          <p className="eyebrow">Shared by a dohc user</p>
          <h1>{selected?.path ?? "Shared files"}</h1>
        </div>
        <span className="badge">View</span>
      </header>
      <Freshness lastSettledAtMs={state.meta.lastSettledAtMs} />
      <div className="layout">
        <nav aria-label="Shared files">
          <p className="section-label">Files</p>
          <ul className="tree">
            {tree.folders.map((folder) => (
              <Folder
                key={folder.path}
                node={folder}
                selected={selected?.path ?? ""}
                onSelect={(file) => setSelectedPath(file.path)}
              />
            ))}
            {tree.files.map((file) => (
              <li key={file.path}>
                <button
                  className={selected?.path === file.path ? "file selected" : "file"}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                >
                  {file.path}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="content">
          {selected ? (
            <FileView
              session={state.session}
              file={selected}
              files={state.files}
              onSelect={setSelectedPath}
            />
          ) : (
            <p>No files in this share yet.</p>
          )}
        </main>
      </div>
    </div>
  );
}
