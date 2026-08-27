import { useEffect, useMemo, useRef, useState } from "react";
import { useImageRetryHandlers } from "./imageRetry";
import { MarkdownContent } from "./MarkdownContent";
import {
  RETRY_BUDGET_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
} from "./retry";
import {
  filesFromAccumulator,
  foldLogOps,
  isMarkdown,
  isRasterImage,
  isSvg,
  resolveSharedFile,
  resolveSharedImage,
  type FileAccumulator,
  type RelayOp,
  type SharedFile,
  type ViewMeta,
} from "./model";

const SESSION_HEADER = "x-dohc-link-session";
const SESSION_PATH = /^\/s\/([A-Za-z0-9_-]{12})\/?$/u;
const VIEW_HEARTBEAT_INTERVAL_MS = 4 * 60_000;
const TERMINAL_HEARTBEAT_STATUSES = new Set([401, 403, 404]);
export const MAX_LOG_PAGES = 200;
export const MARKDOWN_PREVIEW_BYTE_CAP = 2 * 1024 * 1024;

type ViewerState =
  | { status: "loading" }
  | { status: "refused" }
  | {
      status: "ready";
      session: string;
      meta: ViewMeta;
      fileAccumulator: FileAccumulator;
      files: SharedFile[];
      nextCursor: number;
      epochLogFloor: number;
    };

type ReadyState = Extract<ViewerState, { status: "ready" }>;

interface LoadedLog {
  fileAccumulator: FileAccumulator;
  nextCursor: number;
  epochLogFloor: number;
}

class ViewResponseError extends Error {
  constructor(readonly status: number) {
    super("refused");
  }
}

type MarkdownPreview =
  | { status: "ready"; markdown: string }
  | { status: "too-large" };

async function api(
  session: string,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(path, {
    credentials: "same-origin",
    headers: { [SESSION_HEADER]: session },
    ...(signal ? { signal } : {}),
  });
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let timeoutId = 0;
    const cancel = () => {
      window.clearTimeout(timeoutId);
      reject(new Error("cancelled"));
    };
    timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function apiWithThrottleRetry(
  session: string,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  let retryDelayMs = RETRY_INITIAL_MS;
  let retryWaitedMs = 0;
  while (true) {
    if (signal?.aborted) throw new Error("cancelled");
    const response = await api(session, path, signal);
    if (response.status !== 429) return response;
    if (retryWaitedMs + retryDelayMs > RETRY_BUDGET_MS) {
      throw new Error("refused");
    }
    await waitForRetry(retryDelayMs, signal);
    retryWaitedMs += retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }
}

async function readMarkdownPreview(response: Response): Promise<MarkdownPreview> {
  if (!response.body) return { status: "ready", markdown: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        textChunks.push(decoder.decode());
        return { status: "ready", markdown: textChunks.join("") };
      }
      bytesRead += value.byteLength;
      if (bytesRead > MARKDOWN_PREVIEW_BYTE_CAP) {
        try {
          await reader.cancel();
        } catch {
          // The preview remains too large even if the transport cannot cancel.
        }
        return { status: "too-large" };
      }
      textChunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

export async function loadLog(
  session: string,
  initialCursor: number,
  fileAccumulator: FileAccumulator,
  maxPages?: number,
  signal?: AbortSignal,
): Promise<LoadedLog> {
  let cursor = initialCursor;
  let pageNumber = 0;
  let foldEpochLogFloor: number | undefined;
  while (maxPages === undefined || pageNumber < maxPages) {
    pageNumber += 1;
    const response = await apiWithThrottleRetry(
      session,
      `/api/view/log?since=${cursor}&limit=500`,
      signal,
    );
    if (!response.ok) throw new ViewResponseError(response.status);
    const page = (await response.json()) as {
      ops?: unknown;
      nextCursor?: unknown;
      hasMore?: unknown;
      epochLogFloor?: unknown;
    };
    if (
      !Array.isArray(page.ops) ||
      typeof page.nextCursor !== "number" ||
      typeof page.epochLogFloor !== "number" ||
      !Number.isSafeInteger(page.epochLogFloor) ||
      page.epochLogFloor < 0
    ) {
      throw new Error("refused");
    }
    if (
      !Number.isSafeInteger(page.nextCursor) ||
      page.nextCursor < cursor ||
      (page.hasMore === true && page.nextCursor === cursor)
    ) {
      throw new Error("refused");
    }
    if (foldEpochLogFloor === undefined) {
      foldEpochLogFloor = page.epochLogFloor;
    } else if (page.epochLogFloor !== foldEpochLogFloor) {
      fileAccumulator = new Map();
      cursor = page.epochLogFloor;
      foldEpochLogFloor = page.epochLogFloor;
      continue;
    }
    foldLogOps(fileAccumulator, page.ops as RelayOp[]);
    if (page.hasMore !== true) {
      return {
        fileAccumulator,
        nextCursor: page.nextCursor,
        epochLogFloor: foldEpochLogFloor,
      };
    }
    cursor = page.nextCursor;
  }
  throw new Error("refused");
}

async function loadMeta(session: string): Promise<ViewMeta> {
  const response = await api(session, "/api/view/meta");
  if (!response.ok) throw new ViewResponseError(response.status);
  const meta = (await response.json()) as ViewMeta;
  if (meta.access !== "view" || meta.effectiveSelector.access !== "view") {
    throw new Error("refused");
  }
  return meta;
}

function scrubFragment(): void {
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
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
    scrubFragment();
    const response = await exchange;
    if (!response.ok) throw new Error("refused");
    const body = (await response.json()) as { session?: unknown };
    if (typeof body.session !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(body.session)) {
      throw new Error("refused");
    }
    history.replaceState(null, "", `/s/${body.session}`);
    return body.session;
  }
  if (location.hash) scrubFragment();
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

function Freshness(props: {
  lastSettledAtMs: number | null;
  lastSettledKnown: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!props.lastSettledKnown || props.lastSettledAtMs === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [props.lastSettledAtMs, props.lastSettledKnown]);
  return (
    <div className="freshness">
      {!props.lastSettledKnown
        ? "Last settled time isn't available."
        : props.lastSettledAtMs === null
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
      <button aria-expanded={open} className="folder" type="button" onClick={() => setOpen((value) => !value)}>
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
  const [markdownTooLarge, setMarkdownTooLarge] = useState(false);
  const [failed, setFailed] = useState(false);
  const rendersMarkdown = props.file.contentKind === "text" && isMarkdown(props.file.path);
  const fileMap = useMemo(
    () => new Map(props.files.map((file) => [file.path, file])),
    [props.files],
  );
  useEffect(() => {
    let current = true;
    setMarkdown(null);
    setMarkdownTooLarge(false);
    setFailed(false);
    if (!rendersMarkdown) return () => { current = false; };
    const abortController = new AbortController();
    void apiWithThrottleRetry(
      props.session,
      `/api/view/blob/${props.file.blobSha256}`,
      abortController.signal,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("refused");
        const preview = await readMarkdownPreview(response);
        if (!current) return;
        if (preview.status === "too-large") {
          setMarkdownTooLarge(true);
        } else {
          setMarkdown(preview.markdown);
        }
      })
      .catch(() => {
        if (current && !abortController.signal.aborted) setFailed(true);
      });
    return () => {
      current = false;
      abortController.abort();
    };
  }, [props.file, props.session, rendersMarkdown]);

  if (failed) return <Unavailable />;
  if (rendersMarkdown) {
    if (markdownTooLarge) {
      return <DownloadCard file={props.file} session={props.session} />;
    }
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
    const source = `/api/view/blob/${props.file.blobSha256}?session=${props.session}`;
    return (
      <RasterImage
        source={source}
        alt={props.file.path.split("/").at(-1) ?? "Shared image"}
      />
    );
  }
  return <DownloadCard file={props.file} session={props.session} />;
}

function RasterImage(props: { source: string; alt: string }) {
  const { retryImage, stopImageRetry } = useImageRetryHandlers(props.source);
  return (
    <img
      className="preview-image"
      src={props.source}
      alt={props.alt}
      onError={retryImage}
      onLoad={stopImageRetry}
    />
  );
}

function DownloadCard(props: { file: SharedFile; session: string }) {
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
  const readyStateRef = useRef<ReadyState | null>(null);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await establishSession();
        const [meta, log] = await Promise.all([
          loadMeta(session),
          loadLog(session, 0, new Map(), MAX_LOG_PAGES, controller.signal),
        ]);
        const files = filesFromAccumulator(log.fileAccumulator);
        if (current) {
          setSelectedPath(files[0]?.path ?? "");
          setState({
            status: "ready",
            session,
            meta,
            fileAccumulator: log.fileAccumulator,
            files,
            nextCursor: log.nextCursor,
            epochLogFloor: log.epochLogFloor,
          });
        }
      } catch {
        if (current) setState({ status: "refused" });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, []);

  const readySession = state.status === "ready" ? state.session : null;
  const readyFiles = state.status === "ready" ? state.files : null;
  useEffect(() => {
    readyStateRef.current = state.status === "ready" ? state : null;
  }, [state]);
  useEffect(() => {
    if (readyFiles === null) return;
    setSelectedPath((path) => readyFiles.some((file) => file.path === path)
      ? path
      : readyFiles[0]?.path ?? "");
  }, [readyFiles]);

  useEffect(() => {
    if (readySession === null) return;
    let current = true;
    let refreshInFlight = false;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      const previous = readyStateRef.current;
      if (
        refreshInFlight ||
        previous === null ||
        previous.session !== readySession
      ) {
        return;
      }
      refreshInFlight = true;
      const fileAccumulator = new Map(previous.fileAccumulator);
      void Promise.all([
        loadMeta(readySession),
        loadLog(
          readySession,
          previous.nextCursor,
          fileAccumulator,
          MAX_LOG_PAGES,
          controller.signal,
        ),
      ])
        .then(async ([meta, log]) => {
          if (!current) return;
          const currentLog = log.epochLogFloor === previous.epochLogFloor
            ? log
            : await loadLog(
                readySession,
                log.epochLogFloor,
                new Map(),
                MAX_LOG_PAGES,
                controller.signal,
              );
          if (!current) return;
          const nextState: ReadyState = {
            ...previous,
            meta,
            fileAccumulator: currentLog.fileAccumulator,
            files: filesFromAccumulator(currentLog.fileAccumulator),
            nextCursor: currentLog.nextCursor,
            epochLogFloor: currentLog.epochLogFloor,
          };
          readyStateRef.current = nextState;
          setState((value) =>
            value.status === "ready" && value.session === readySession
              ? nextState
              : value
          );
        })
        .catch((error: unknown) => {
          if (
            current &&
            error instanceof ViewResponseError &&
            TERMINAL_HEARTBEAT_STATUSES.has(error.status)
          ) {
            setState({ status: "refused" });
          }
        })
        .finally(() => {
          refreshInFlight = false;
        });
    }, VIEW_HEARTBEAT_INTERVAL_MS);
    return () => {
      current = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [readySession]);

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
      <Freshness
        lastSettledAtMs={state.meta.lastSettledAtMs}
        lastSettledKnown={state.meta.lastSettledKnown}
      />
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
