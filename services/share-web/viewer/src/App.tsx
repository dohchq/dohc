import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const HANDOFF_CODE = /^[A-Za-z0-9_-]{43}$/u;
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

interface HandoffResponse {
  ok: true;
  code: string;
  expiresAtMs: number;
}

type HandoffState =
  | "idle"
  | "confirming"
  | "opening"
  | "opened"
  | "not-found"
  | "rate-limited"
  | "retryable";

function isCurrentHandoffResponse(
  value: unknown,
  nowMs: number,
): value is HandoffResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  return Object.keys(response).sort().join(",") === "code,expiresAtMs,ok" &&
    response.ok === true &&
    typeof response.code === "string" &&
    HANDOFF_CODE.test(response.code) &&
    typeof response.expiresAtMs === "number" &&
    Number.isSafeInteger(response.expiresAtMs) &&
    response.expiresAtMs > nowMs;
}

export const dohcNavigation = {
  urlForCode(code: string): string {
    if (!HANDOFF_CODE.test(code)) throw new Error("invalid handoff code");
    return `dohc://open/${code}`;
  },
  openCode(code: string): void {
    location.assign(dohcNavigation.urlForCode(code));
  },
};

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
  return withBoundedRetry(
    () => api(session, path, signal),
    (response) => response.status === 429,
    false,
    signal,
  );
}

async function withBoundedRetry(
  request: () => Promise<Response>,
  shouldRetryResponse: (response: Response) => boolean,
  retryThrownFailures: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let retryDelayMs = RETRY_INITIAL_MS;
  let retryWaitedMs = 0;
  while (true) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      const response = await request();
      if (!shouldRetryResponse(response)) return response;
    } catch (error: unknown) {
      if (!retryThrownFailures || signal?.aborted) throw error;
    }
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

async function loadMeta(session: string, signal?: AbortSignal): Promise<ViewMeta> {
  const response = await apiWithThrottleRetry(session, "/api/view/meta", signal);
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

async function establishSession(signal?: AbortSignal): Promise<string> {
  const secret = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/u.test(secret)) {
    const exchange = withBoundedRetry(
      () => fetch("/api/exchange", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret }),
        ...(signal ? { signal } : {}),
      }),
      (response) =>
        response.status === 429 ||
        (response.status >= 500 && response.status < 600),
      true,
      signal,
    );
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

interface FolderBuilder {
  name: string;
  path: string;
  children: Map<string, FolderBuilder>;
  files: SharedFile[];
}

export function fileTree(files: SharedFile[]): FolderNode {
  const root: FolderBuilder = {
    name: "",
    path: "",
    children: new Map(),
    files: [],
  };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const segment of parts.slice(0, -1)) {
      let child = folder.children.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: folder.path ? `${folder.path}/${segment}` : segment,
          children: new Map(),
          files: [],
        };
        folder.children.set(segment, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  const complete = (folder: FolderBuilder): FolderNode => ({
    name: folder.name,
    path: folder.path,
    folders: [...folder.children.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(complete),
    files: [...folder.files]
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  return complete(root);
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
  onStaleBlob: (path: string, blobSha256: string) => Promise<boolean>;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [markdownTooLarge, setMarkdownTooLarge] = useState(false);
  const [fileStatus, setFileStatus] = useState<
    "ready" | "refreshing" | "unavailable"
  >("ready");
  const rendersMarkdown = props.file.contentKind === "text" && isMarkdown(props.file.path);
  const fileMap = useMemo(
    () => new Map(props.files.map((file) => [file.path, file])),
    [props.files],
  );
  useEffect(() => {
    let current = true;
    setMarkdown(null);
    setMarkdownTooLarge(false);
    setFileStatus("ready");
    if (!rendersMarkdown) return () => { current = false; };
    const abortController = new AbortController();
    void apiWithThrottleRetry(
      props.session,
      `/api/view/blob/${props.file.blobSha256}`,
      abortController.signal,
    )
      .then(async (response) => {
        if (!response.ok) throw new ViewResponseError(response.status);
        const preview = await readMarkdownPreview(response);
        if (!current) return;
        if (preview.status === "too-large") {
          setMarkdownTooLarge(true);
        } else {
          setMarkdown(preview.markdown);
        }
      })
      .catch(async (error: unknown) => {
        if (!current || abortController.signal.aborted) return;
        if (!(error instanceof ViewResponseError) || error.status !== 404) {
          setFileStatus("unavailable");
          return;
        }
        setFileStatus("refreshing");
        const changed = await props.onStaleBlob(
          props.file.path,
          props.file.blobSha256,
        );
        if (current && !abortController.signal.aborted && !changed) {
          setFileStatus("unavailable");
        }
      });
    return () => {
      current = false;
      abortController.abort();
    };
  }, [
    props.file.blobSha256,
    props.file.path,
    props.onStaleBlob,
    props.session,
    rendersMarkdown,
  ]);

  if (fileStatus !== "ready") {
    return (
      <p className="file-status muted">
        {fileStatus === "refreshing"
          ? "This file changed. Refreshing."
          : "This file isn't available right now."}
      </p>
    );
  }
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
  const fileName = props.file.path.split("/").at(-1);
  const visibleDownloadPath = `/api/view/blob/${props.file.blobSha256}?session=${props.session}`;
  const downloadControllerRef = useRef<AbortController | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  useEffect(() => {
    setDownloadFailed(false);
    return () => {
      downloadControllerRef.current?.abort();
      downloadControllerRef.current = null;
    };
  }, [props.file.blobSha256, props.session]);
  const download = async () => {
    downloadControllerRef.current?.abort();
    const controller = new AbortController();
    downloadControllerRef.current = controller;
    setDownloadFailed(false);
    try {
      const response = await apiWithThrottleRetry(
        props.session,
        `/api/view/blob/${props.file.blobSha256}`,
        controller.signal,
      );
      if (!response.ok) throw new Error("refused");
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = fileName ?? "";
        anchor.hidden = true;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch {
      if (!controller.signal.aborted) setDownloadFailed(true);
    } finally {
      if (downloadControllerRef.current === controller) {
        downloadControllerRef.current = null;
      }
    }
  };
  return (
    <div className="download-card">
      <p>{isSvg(props.file.path) ? "SVG files open as downloads." : "This file opens as a download."}</p>
      <a
        href={visibleDownloadPath}
        download={fileName}
        onClick={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        Download file
      </a>
      {downloadFailed ? (
        <p className="download-error muted">
          The download didn't finish. Try again.
        </p>
      ) : null}
    </div>
  );
}

function Unavailable() {
  return <main className="state"><p>This link isn't available.</p></main>;
}

function OpenInDohc(props: { session: string }) {
  const [handoffState, setHandoffState] = useState<HandoffState>("idle");
  const requestRef = useRef<AbortController | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => () => {
    attemptRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }, [props.session]);

  const mintAndOpen = useCallback(async () => {
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const isCurrent = () =>
      attemptRef.current === attempt && !controller.signal.aborted;
    setHandoffState("opening");

    let response: Response;
    try {
      response = await fetch("/api/handoff", {
        method: "POST",
        credentials: "same-origin",
        headers: { [SESSION_HEADER]: props.session },
        signal: controller.signal,
      });
    } catch {
      if (isCurrent()) setHandoffState("retryable");
      return;
    }
    if (!isCurrent()) return;
    if (response.status === 404) {
      setHandoffState("not-found");
      return;
    }
    if (response.status === 429) {
      setHandoffState("rate-limited");
      return;
    }
    if (!response.ok) {
      setHandoffState("retryable");
      return;
    }

    let handoff: unknown;
    try {
      handoff = await response.json();
    } catch {
      if (isCurrent()) setHandoffState("retryable");
      return;
    }
    if (!isCurrent()) return;
    if (!isCurrentHandoffResponse(handoff, Date.now())) {
      setHandoffState("retryable");
      return;
    }

    requestRef.current = null;
    setHandoffState("opened");
    dohcNavigation.openCode(handoff.code);
  }, [props.session]);

  const cancelOpening = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setHandoffState("idle");
  }, []);

  if (handoffState === "idle") {
    return (
      <button
        className="handoff-button primary"
        type="button"
        onClick={() => setHandoffState("confirming")}
      >
        Open in dohc
      </button>
    );
  }
  if (handoffState === "confirming") {
    return (
      <div className="handoff-panel">
        <p>This opens the share in the dohc app on this computer.</p>
        <p>
          The person who shared it will see the email of the dohc account that
          opens it. dohc asks that account to agree first.
        </p>
        <div className="handoff-buttons">
          <button
            className="handoff-button primary"
            type="button"
            onClick={() => void mintAndOpen()}
          >
            Agree and open
          </button>
          <button
            className="handoff-button secondary"
            type="button"
            onClick={() => setHandoffState("idle")}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  if (handoffState === "opening") {
    return (
      <div className="handoff-panel" aria-live="polite">
        <p className="handoff-title">Opening in dohc…</p>
        <p>Your browser may ask for permission to open dohc.</p>
        <button
          className="handoff-button secondary"
          type="button"
          onClick={cancelOpening}
        >
          Cancel
        </button>
      </div>
    );
  }
  if (handoffState === "not-found") {
    return (
      <div className="handoff-panel" role="alert">
        <p>
          This link can't open in dohc right now. Reload the page to check the
          share.
        </p>
      </div>
    );
  }
  if (handoffState === "rate-limited") {
    return (
      <div className="handoff-panel" role="alert">
        <p>Too many attempts. Wait a minute, then choose Open in dohc again.</p>
        <button
          className="handoff-button secondary"
          type="button"
          onClick={() => void mintAndOpen()}
        >
          Open in dohc
        </button>
      </div>
    );
  }
  return (
    <div
      className="handoff-panel"
      {...(handoffState === "retryable" ? { role: "alert" } : {})}
    >
      <p>
        {handoffState === "opened"
          ? "If dohc didn't open, install it, then choose Try again."
          : "dohc couldn't prepare the app handoff. Check your connection, then choose Try again."}
      </p>
      <button
        className="handoff-button secondary"
        type="button"
        onClick={() => void mintAndOpen()}
      >
        Try again
      </button>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [selectedPath, setSelectedPath] = useState("");
  const readyStateRef = useRef<ReadyState | null>(null);
  const refreshReadyStateRef = useRef<
    (() => Promise<ReadyState | null>) | null
  >(null);
  const refreshStaleBlob = useCallback(
    async (path: string, blobSha256: string): Promise<boolean> => {
      const refreshed = await refreshReadyStateRef.current?.();
      if (!refreshed) return false;
      const currentFile = refreshed.files.find((file) => file.path === path);
      return currentFile === undefined || currentFile.blobSha256 !== blobSha256;
    },
    [],
  );
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await establishSession(controller.signal);
        const [meta, log] = await Promise.all([
          loadMeta(session, controller.signal),
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
    let refreshInFlight: Promise<ReadyState | null> | null = null;
    const controller = new AbortController();
    const refresh = (): Promise<ReadyState | null> => {
      if (refreshInFlight) return refreshInFlight;
      const previous = readyStateRef.current;
      if (
        previous === null ||
        previous.session !== readySession
      ) {
        return Promise.resolve(null);
      }
      const fileAccumulator = new Map(previous.fileAccumulator);
      const refreshPromise = (async (): Promise<ReadyState | null> => {
        try {
          const [meta, log] = await Promise.all([
            loadMeta(readySession, controller.signal),
            loadLog(
              readySession,
              previous.nextCursor,
              fileAccumulator,
              MAX_LOG_PAGES,
              controller.signal,
            ),
          ]);
          if (!current) return null;
          const currentLog = log.epochLogFloor === previous.epochLogFloor
            ? log
            : await loadLog(
                readySession,
                log.epochLogFloor,
                new Map(),
                MAX_LOG_PAGES,
                controller.signal,
              );
          if (!current) return null;
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
          return nextState;
        } catch (error: unknown) {
          if (
            current &&
            error instanceof ViewResponseError &&
            TERMINAL_HEARTBEAT_STATUSES.has(error.status)
          ) {
            setState({ status: "refused" });
          }
          return null;
        }
      })();
      refreshInFlight = refreshPromise;
      void refreshPromise.finally(() => {
        if (refreshInFlight === refreshPromise) refreshInFlight = null;
      });
      return refreshPromise;
    };
    refreshReadyStateRef.current = refresh;
    const interval = window.setInterval(() => {
      void refresh();
    }, VIEW_HEARTBEAT_INTERVAL_MS);
    return () => {
      current = false;
      if (refreshReadyStateRef.current === refresh) {
        refreshReadyStateRef.current = null;
      }
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
        <div className="header-actions">
          <span className="badge">View</span>
          <OpenInDohc key={state.session} session={state.session} />
        </div>
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
              onStaleBlob={refreshStaleBlob}
            />
          ) : (
            <p>No files in this share yet.</p>
          )}
        </main>
      </div>
    </div>
  );
}
