import {fetchShareWeb} from "./apiVersion";
import {normalizeShareLabel} from "@dohc/security-contract/share-labels";
import { buildShareHandoffUrl } from "@dohc/workspace-contracts/deep-links";
import { OpenSharedApp } from "./OpenSharedApp";
import { PublishedApps, type AppsState } from "./PublishedApps";
import {
  Component,
  lazy,
  Suspense,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { parsePublicExcalidrawScene } from "./excalidraw";
import { useImageRetryHandlers } from "./imageRetry";
import { MarkdownContent } from "./MarkdownContent";
import { CommentsPanel } from "./CommentsPanel";
import { LinkChannelPanel } from "./LinkChannelPanel";
import { LinkDocumentEditor } from "./LinkDocumentEditor";
import { CollectionFileEditor, isCollectionOwnFile } from "./CollectionFileEditor";
import { LinkAbout, LinkAgent } from "./LinkEntry";
import { DohcMark, Icon, fileIcon } from "./icons";
import {
  RETRY_BUDGET_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
} from "./retry";
import {
  accumulatorFromCurrentFiles,
  filesFromAccumulator,
  foldLogOps,
  isExcalidraw,
  isMarkdown,
  isRasterImage,
  isSvg,
  resolveSharedFile,
  resolveSharedImage,
  type FileAccumulator,
  type RelayOp,
  type ShareAccess,
  type SharedFile,
  type ViewMeta,
} from "./model";

const ExcalidrawView = lazy(() => import("./ExcalidrawView"));

class ExcalidrawRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const SESSION_HEADER = "x-dohc-link-session";
const SESSION_PATH = /^\/s\/([A-Za-z0-9_-]{12})\/?$/u;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{43}$/u;
const VIEW_LOG_HOLD_MS = 30_000;
const TERMINAL_HEARTBEAT_STATUSES = new Set([401, 403, 404]);
export const MAX_LOG_PAGES = 200;
export const TEXT_PREVIEW_BYTE_CAP = 2 * 1024 * 1024;

type ViewerState =
  | { status: "loading" }
  | { status: "refused" }
  | { status: "load-failed" }
  | { status: "version-mismatch" }
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

interface LoadedCurrentState extends LoadedLog {
  meta: ViewMeta;
}

class ViewResponseError extends Error {
  constructor(readonly status: number) {
    super("refused");
  }
}

// The server stayed busy or unreachable for the whole retry budget; the link may still open.
class RetryExhaustedError extends Error {
  constructor() {
    super("retry budget exhausted");
  }
}

// A share-web ingress refusal describes the viewer/server wire mismatch.
class VersionMismatchError extends Error {}

async function versionMismatch(response: Response): Promise<VersionMismatchError | null> {
  if (response.status !== 409) return null;
  const body = await response.clone().json().catch(() => null) as { api?: unknown; code?: unknown; error?: unknown } | null;
  return body?.api === "share-web" && (body.code === "api_version_too_old" || body?.code === "api_version_too_new") && typeof body.error === "string"
    ? new VersionMismatchError(body.error)
    : null;
}

class EpochFloorChangedError extends Error {
  constructor() {
    super("epoch floor changed");
  }
}

interface HandoffResponse {
  ok: true;
  code: string;
  relayUrl: string;
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
  return Object.keys(response).sort().join(",") === "code,expiresAtMs,ok,relayUrl" &&
    response.ok === true &&
    typeof response.code === "string" &&
    HANDOFF_CODE.test(response.code) &&
    typeof response.relayUrl === "string" &&
    response.relayUrl.length > 0 &&
    response.relayUrl.length <= 2048 &&
    typeof response.expiresAtMs === "number" &&
    Number.isSafeInteger(response.expiresAtMs) &&
    response.expiresAtMs > nowMs;
}

export const dohcNavigation = {
  urlForCode: buildShareHandoffUrl,
  openCode(code: string, relayUrl: string): void {
    location.assign(dohcNavigation.urlForCode(code, relayUrl));
  },
};

type TextPreview =
  | { status: "ready"; text: string }
  | { status: "download" };

async function api(
  session: string,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchShareWeb(path, {
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
      throw new RetryExhaustedError();
    }
    await waitForRetry(retryDelayMs, signal);
    retryWaitedMs += retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
  }
}

// Bytes a text file does not contain. NUL marks binary data and BOM-less
// UTF-16; a high share of other C0 controls marks binary data too. Tab, line
// breaks, form feed, and escape (terminal colors) are ordinary text.
function isStrayControlByte(byte: number): boolean {
  return (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0b &&
    byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) || byte === 0x7f;
}
const MAX_STRAY_CONTROL_SHARE = 0.01;

async function readTextPreview(response: Response): Promise<TextPreview> {
  if (!response.body) return { status: "ready", text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const textChunks: string[] = [];
  let bytesRead = 0;
  let strayControlBytes = 0;
  const stop = async (): Promise<TextPreview> => {
    try {
      await reader.cancel();
    } catch {
      // The preview stays a download even if the transport cannot cancel.
    }
    return { status: "download" };
  };
  // The fatal decoder refuses bytes that are not UTF-8.
  const decode = (value?: Uint8Array): string | null => {
    try {
      return value ? decoder.decode(value, { stream: true }) : decoder.decode();
    } catch {
      return null;
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decode();
        if (tail === null || strayControlBytes > bytesRead * MAX_STRAY_CONTROL_SHARE) {
          return { status: "download" };
        }
        textChunks.push(tail);
        return { status: "ready", text: textChunks.join("") };
      }
      bytesRead += value.byteLength;
      if (bytesRead > TEXT_PREVIEW_BYTE_CAP) return await stop();
      for (const byte of value) {
        if (byte === 0) return await stop();
        if (isStrayControlByte(byte)) strayControlBytes += 1;
      }
      const text = decode(value);
      if (text === null) return await stop();
      textChunks.push(text);
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
  expectedEpochLogFloor?: number,
  holdMs?: number,
  currentOnly = false,
): Promise<LoadedLog> {
  let cursor = initialCursor;
  let pageNumber = 0;
  let foldEpochLogFloor: number | undefined;
  while (maxPages === undefined || pageNumber < maxPages) {
    pageNumber += 1;
    const response = await apiWithThrottleRetry(
      session,
      `/api/view/log?since=${cursor}&limit=500${currentOnly ? "&current=true" : ""}${
        pageNumber === 1 && holdMs !== undefined ? `&hold=${String(holdMs)}` : ""
      }`,
      signal,
    );
    if (!response.ok) throw (await versionMismatch(response)) ?? new ViewResponseError(response.status);
    const page = (await response.json()) as {
      ops?: unknown;
      nextCursor?: unknown;
      hasMore?: unknown;
      epochLogFloor?: unknown;
    };
    if (
      !Array.isArray(page.ops) ||
      page.ops.some((op) => !relayOp(op, currentOnly)) ||
      typeof page.nextCursor !== "number" ||
      typeof page.hasMore !== "boolean" ||
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
    let previousRelaySeq = cursor;
    for (const op of page.ops as RelayOp[]) {
      if (op.relaySeq <= previousRelaySeq || op.relaySeq > page.nextCursor) {
        throw new Error("refused");
      }
      previousRelaySeq = op.relaySeq;
    }
    if (
      expectedEpochLogFloor !== undefined &&
      page.epochLogFloor !== expectedEpochLogFloor
    ) {
      throw new EpochFloorChangedError();
    }
    if (foldEpochLogFloor === undefined) {
      foldEpochLogFloor = page.epochLogFloor;
    } else if (page.epochLogFloor !== foldEpochLogFloor) {
      throw new EpochFloorChangedError();
    }
    if ((page.ops as RelayOp[]).some(op => op.opKind === "files.reset")) throw new EpochFloorChangedError();
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

function relayOp(value: unknown, currentOnly = false): value is RelayOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (currentOnly) {
    if (!Number.isSafeInteger(record.relaySeq) || Number(record.relaySeq) < 0) return false;
    if (record.opKind === "files.reset") return true;
    const payload = record.payload as {objectId?: unknown; file?: unknown} | null;
    if (record.opKind !== "file.current" || !payload || typeof payload.objectId !== "string") return false;
    if (payload.file === null) return true;
    const files = accumulatorFromCurrentFiles([payload.file]);
    return files !== null && [...files.values()][0]?.objectId === payload.objectId;
  }
  return (
    typeof record.relaySeq === "number" &&
    Number.isSafeInteger(record.relaySeq) &&
    record.relaySeq >= 0 &&
    (record.opKind === "workspace.init" ||
      record.opKind === "moment.append" ||
      record.opKind === "version.create") &&
    typeof record.recordedAtMs === "number" &&
    Number.isSafeInteger(record.recordedAtMs)
  );
}

function viewMeta(value: unknown): ViewMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const selector = record.effectiveSelector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return null;
  const selectorRecord = selector as Record<string, unknown>;
  const access = record.access;
  if (
    (access !== "view" && access !== "comment" && access !== "edit") ||
    selectorRecord.access !== access ||
    !Array.isArray(selectorRecord.paths) ||
    selectorRecord.paths.some((path) => typeof path !== "string") ||
    (selectorRecord.versionId !== null && typeof selectorRecord.versionId !== "string") ||
    typeof record.lastSettledKnown !== "boolean" ||
    (record.lastSettledAtMs !== null &&
      (typeof record.lastSettledAtMs !== "number" ||
        !Number.isSafeInteger(record.lastSettledAtMs)))
  ) {
    return null;
  }
  const channel = record.channel as Record<string, unknown> | null | undefined;
  if (channel !== undefined && (!channel || typeof channel !== "object" || typeof channel.channelWireId !== "string")) return null;
  return {
    ...(channel ? { channel: { channelWireId: channel.channelWireId as string } } : {}),
    access,
    subjectName: normalizeShareLabel(record.subjectName),
    effectiveSelector: {
      paths: selectorRecord.paths as string[],
      versionId: selectorRecord.versionId as string | null,
      access,
    },
    lastSettledAtMs: record.lastSettledAtMs as number | null,
    lastSettledKnown: record.lastSettledKnown,
  };
}

async function loadCurrentProjection(
  session: string,
  signal?: AbortSignal,
): Promise<LoadedCurrentState> {
  const response = await apiWithThrottleRetry(session, "/api/view/current", signal);
  if (!response.ok) throw (await versionMismatch(response)) ?? new ViewResponseError(response.status);
  const body = await response.json() as Record<string, unknown>;
  const meta = viewMeta(body);
  const fileAccumulator = accumulatorFromCurrentFiles(body.files);
  if (
    body.ok !== true ||
    !fileAccumulator ||
    typeof body.nextCursor !== "number" ||
    !Number.isSafeInteger(body.nextCursor) ||
    body.nextCursor < 0 ||
    typeof body.epochLogFloor !== "number" ||
    !Number.isSafeInteger(body.epochLogFloor) ||
    body.epochLogFloor < 0 ||
    body.nextCursor < body.epochLogFloor ||
    !meta
  ) {
    throw new Error("refused");
  }
  return {
    meta,
    fileAccumulator,
    nextCursor: body.nextCursor,
    epochLogFloor: body.epochLogFloor,
  };
}

export async function loadCurrentState(
  session: string,
  signal?: AbortSignal,
): Promise<LoadedCurrentState> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const projection = await loadCurrentProjection(session, signal);
    if (projection.meta.access !== "edit") return projection;
    try {
      const caughtUp = await loadLog(
        session,
        projection.nextCursor,
        projection.fileAccumulator,
        MAX_LOG_PAGES,
        signal,
        projection.epochLogFloor,
      );
      return { ...caughtUp, meta: projection.meta };
    } catch (error: unknown) {
      if (error instanceof ViewResponseError && error.status === 404) {
        const meta = await loadMeta(session, signal);
        if (meta.access !== "edit") continue;
      }
      if (!(error instanceof EpochFloorChangedError)) throw error;
    }
  }
  throw new Error("refused");
}

async function loadMeta(session: string, signal?: AbortSignal): Promise<ViewMeta> {
  const response = await apiWithThrottleRetry(session, "/api/view/meta", signal);
  if (!response.ok) throw (await versionMismatch(response)) ?? new ViewResponseError(response.status);
  const meta = viewMeta(await response.json());
  if (!meta) throw new Error("refused");
  return meta;
}

/** What stands where Edit would be, when this link can't edit the open file. */
function accessBadge(meta: ViewMeta): { label: string; reason?: string } {
  if (meta.access === "view") return { label: "View only" };
  if (meta.access === "comment") return { label: "Can comment" };
  return meta.effectiveSelector.versionId !== null
    ? { label: "Saved version, read-only", reason: "This link shows a saved version, which can't be edited." }
    : { label: "Can edit", reason: "Pages can be edited here. Open another kind of file in dohc to edit it." };
}

/** A file's title: its name, without the folders, and without the extension when it is a page. */
function fileTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return isMarkdown(path) ? name.replace(/\.(md|markdown)$/i, "") : name;
}

function metaAtAccess(meta: ViewMeta, access: ShareAccess): ViewMeta {
  return meta.access === access
    ? meta
    : {
        ...meta,
        access,
        effectiveSelector: { ...meta.effectiveSelector, access },
      };
}

function retainNarrowedAccess(current: ViewMeta, incoming: ViewMeta): ViewMeta {
  const ranks = {view: 0, comment: 1, edit: 2};
  return ranks[current.access] < ranks[incoming.access] ? metaAtAccess(incoming, current.access) : incoming;
}

function scrubFragment(): void {
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}

// The link's secret leaves the address bar at once, but stays in `pending`
// until its exchange succeeds or is refused, so Try again can repeat the exchange.
async function establishSession(pending: { secret: string | null }, agentLink: { secret: string | null }, signal?: AbortSignal): Promise<string> {
  const fragment = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/u.test(fragment)) pending.secret = fragment;
  const secret = pending.secret;
  if (secret !== null) {
    agentLink.secret = null;
    const exchange = withBoundedRetry(
      () => fetchShareWeb("/api/exchange", {
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
    if (location.hash) scrubFragment();
    const response = await exchange;
    if (!response.ok) {
      // A 429 is retried above, so any 4xx here is a refusal.
      if (response.status >= 400 && response.status < 500) pending.secret = null;
      throw (await versionMismatch(response)) ?? new Error("refused");
    }
    const body = (await response.json()) as { session?: unknown };
    if (typeof body.session !== "string" || !/^[A-Za-z0-9_-]{12}$/u.test(body.session)) {
      throw new Error("refused");
    }
    agentLink.secret = secret;
    pending.secret = null;
    history.replaceState(null, "", `/s/${body.session}${location.search}`);
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

/** When the shared files last changed, in words. Empty while the server can't say. */
function useUpdated(lastSettledAtMs: number | null, lastSettledKnown: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lastSettledKnown || lastSettledAtMs === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [lastSettledAtMs, lastSettledKnown]);
  if (!lastSettledKnown) return "";
  if (lastSettledAtMs === null) return "No changes yet";
  return Math.abs(now - lastSettledAtMs) < 60_000 ? "Updated just now" : `Updated ${relativeTime(lastSettledAtMs, now)}`;
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
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <Icon name="folder" />
        <span>{props.node.name}</span>
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
                <Icon name={fileIcon(file.path)} />
                <span>{file.path.split("/").at(-1)}</span>
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
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewIsDownload, setPreviewIsDownload] = useState(false);
  const [fileStatus, setFileStatus] = useState<
    "ready" | "refreshing" | "unavailable"
  >("ready");
  const [readAttempt, setReadAttempt] = useState(0);
  const rendersMarkdown = props.file.contentKind === "text" && isMarkdown(props.file.path);
  const rendersExcalidraw =
    props.file.contentKind === "text" && isExcalidraw(props.file.path);
  // Any other text file shows its source as plain text, never as markup.
  const rendersSourceText =
    props.file.contentKind === "text" &&
    !rendersMarkdown &&
    !rendersExcalidraw &&
    !isRasterImage(props.file.path);
  const rendersTextPreview = rendersMarkdown || rendersExcalidraw || rendersSourceText;
  const fileMap = useMemo(
    () => new Map(props.files.map((file) => [file.path, file])),
    [props.files],
  );
  useEffect(() => {
    let current = true;
    setPreviewText(null);
    setPreviewIsDownload(false);
    setFileStatus("ready");
    if (!rendersTextPreview) return () => { current = false; };
    const abortController = new AbortController();
    void apiWithThrottleRetry(
      props.session,
      `/api/view/blob/${props.file.blobSha256}`,
      abortController.signal,
    )
      .then(async (response) => {
        if (!response.ok) throw new ViewResponseError(response.status);
        const preview = await readTextPreview(response);
        if (!current) return;
        if (preview.status === "download") {
          setPreviewIsDownload(true);
        } else {
          setPreviewText(preview.text);
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
    readAttempt,
    rendersTextPreview,
  ]);

  if (fileStatus === "refreshing") {
    return <p className="file-status muted">This file changed. Refreshing.</p>;
  }
  if (fileStatus === "unavailable") {
    return (
      <div role="alert">
        <p className="file-status muted">This file isn't available right now.</p>
        <button
          className="handoff-button secondary"
          type="button"
          onClick={() => setReadAttempt((attempt) => attempt + 1)}
        >
          Try again
        </button>
      </div>
    );
  }
  if (rendersMarkdown) {
    if (previewIsDownload) {
      return <DownloadCard file={props.file} session={props.session} />;
    }
    if (previewText === null) return <p className="muted">Loading file</p>;
    return (
      <MarkdownContent
        markdown={previewText}
        resolveImage={(href) =>
          resolveSharedImage(href, props.file.path, fileMap, props.session)
        }
        resolveLink={(href) =>
          resolveSharedFile(href, props.file.path, fileMap)?.path ?? null
        }
        onNavigate={props.onSelect}
        collapseProperties
      />
    );
  }
  if (rendersExcalidraw) {
    if (previewIsDownload) {
      return <DownloadCard file={props.file} session={props.session} />;
    }
    if (previewText === null) return <p className="muted">Loading file</p>;
    const scene = parsePublicExcalidrawScene(previewText);
    if (!scene) return <DownloadCard file={props.file} session={props.session} />;
    return (
      <ExcalidrawRenderBoundary
        key={props.file.blobSha256}
        fallback={<DownloadCard file={props.file} session={props.session} />}
      >
        <Suspense fallback={<p className="muted">Loading file</p>}>
          <ExcalidrawView scene={scene} />
        </Suspense>
      </ExcalidrawRenderBoundary>
    );
  }
  if (rendersSourceText) {
    if (previewIsDownload) {
      return <DownloadCard file={props.file} session={props.session} />;
    }
    if (previewText === null) return <p className="muted">Loading file</p>;
    return (
      <pre className="source-text">
        <code>{previewText}</code>
      </pre>
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
      <span className="tile"><Icon name="file" size={20} /></span>
      <p>{isSvg(props.file.path) ? "SVG files open as downloads." : "This file opens as a download."}</p>
      <a
        className="handoff-button secondary"
        href={visibleDownloadPath}
        download={fileName}
        onClick={(event) => {
          event.preventDefault();
          void download();
        }}
      >
        <Icon name="download" size={14} />
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

/** A page that stands alone: the mark, what happened, and the next step when there is one. */
function StatePage(props: { icon: "unlink" | "alert" | "refresh"; failed?: boolean; title: string; children?: ReactNode }) {
  return (
    <div className="state-page">
      <span className="bar-mark"><DohcMark /></span>
      <main className="state">
        <div className="state-message" role={props.failed ? "alert" : undefined}>
          <span className={props.failed ? "tile bad" : "tile"}><Icon name={props.icon} size={20} /></span>
          <h1>{props.title}</h1>
          {props.children}
        </div>
      </main>
    </div>
  );
}

function Unavailable() {
  return (
    <StatePage icon="unlink" title="This link isn't available.">
      <p>Ask the person who shared it to send the link again. The address in a browser's address bar works only in that browser.</p>
    </StatePage>
  );
}

// The page's shape while it loads. It stays blank for its first 150 ms, so a fast link never flashes it.
function Opening() {
  return (
    <div className="state-page">
      <span className="bar-mark"><DohcMark /></span>
      <main className="state opening" aria-busy="true">
        <p className="sr-only">Opening shared files</p>
        <div className="skeleton" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
      </main>
    </div>
  );
}

const EMPTY_PICTURE = (
  <svg aria-hidden="true" width="72" height="88" viewBox="0 0 72 88" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <rect x="1" y="1" width="70" height="86" rx="6" strokeDasharray="5 6" /><path d="M16 22h26M16 36h40M16 48h40M16 60h28" />
  </svg>
);

// Narrow windows show the file list and the panels over the page, not beside it.
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.("(max-width: 720px)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 720px)");
    if (!query) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

type Surface = "comments" | "agent" | "about" | "apps" | "more";
/** Where each surface lives in the page. Opening one moves focus there, and closing returns it to the button. */
const SURFACE_ID: Record<Surface, string> = {
  comments: "link-discussion", agent: "link-agent", about: "link-about", apps: "link-apps", more: "link-more",
};

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
      response = await fetchShareWeb("/api/handoff", {
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
    dohcNavigation.openCode(handoff.code, handoff.relayUrl);
  }, [props.session]);

  const cancelOpening = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setHandoffState("idle");
  }, []);

  if (handoffState === "idle") {
    return (
      <button
        className="handoff-button secondary handoff-open"
        type="button"
        onClick={() => setHandoffState("confirming")}
      >
        <DohcMark size={14} />
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  const pendingExchange = useRef<{ secret: string | null }>({ secret: null });
  const agentLink = useRef<{ secret: string | null }>({ secret: null });
  const [selectedPath, setSelectedPath] = useState("");
  const [editing, setEditing] = useState<{discriminator: string; path: string; blobSha256: string} | null>(null);
  // The bar's place for an editor's Done, Save and saved state, and whether the live editor has the file.
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // What is open beside or over the page. Nothing is, until the person opens it.
  const [surface, setSurface] = useState<Surface | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [filesToggled, setFilesToggled] = useState(false);
  const [comments, setComments] = useState({ count: 0, more: false });
  const [apps, setApps] = useState<AppsState>("none");
  const narrow = useNarrow();
  const countComments = useCallback((count: number, more: boolean) => {
    setComments((current) => current.count === count && current.more === more ? current : { count, more });
  }, []);
  const closeSurface = useCallback(() => {
    setSurface(null);
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (surface === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSurface();
    };
    window.addEventListener("keydown", closeOnEscape);
    document.getElementById(SURFACE_ID[surface])?.focus();
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [surface, closeSurface]);
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
  const applyDiscussionAccess = useCallback(
    (session: string, access: ShareAccess): void => {
      const previous = readyStateRef.current;
      if (!previous || previous.session !== session) return;
      const meta = retainNarrowedAccess(previous.meta, metaAtAccess(previous.meta, access));
      if (meta === previous.meta) return;
      const nextState = { ...previous, meta };
      readyStateRef.current = nextState;
      setState((value) =>
        value.status === "ready" && value.session === session
          ? { ...value, meta }
          : value
      );
    },
    [],
  );
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await establishSession(pendingExchange.current, agentLink.current, controller.signal);
        const log = await loadCurrentState(session, controller.signal);
        const files = filesFromAccumulator(log.fileAccumulator);
        if (current) {
          setSelectedPath(files[0]?.path ?? "");
          setState({
            status: "ready",
            session,
            meta: log.meta,
            fileAccumulator: log.fileAccumulator,
            files,
            nextCursor: log.nextCursor,
            epochLogFloor: log.epochLogFloor,
          });
        }
      } catch (error) {
        if (current) {
          setState(error instanceof VersionMismatchError
            ? { status: "version-mismatch" }
            // A lost answer, a lost connection or a server that stayed busy says nothing about the link.
            : (error instanceof ViewResponseError && error.status >= 500) ||
                error instanceof TypeError || error instanceof RetryExhaustedError
              ? { status: "load-failed" }
              : { status: "refused" });
        }
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [loadAttempt]);

  const updated = useUpdated(
    state.status === "ready" ? state.meta.lastSettledAtMs : null,
    state.status === "ready" && state.meta.lastSettledKnown,
  );
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
    let operationVersion = 0;
    let refreshInFlight: Promise<ReadyState | null> | null = null;
    let followerController: AbortController | null = null;
    const sessionController = new AbortController();
    const refuseIfTerminal = (error: unknown): boolean => {
      // A version mismatch lasts until the server is updated, so the open
      // page stops following and says so.
      if (current && error instanceof VersionMismatchError) {
        readyStateRef.current = null;
        setState({ status: "version-mismatch" });
        return true;
      }
      if (
        current &&
        error instanceof ViewResponseError &&
        TERMINAL_HEARTBEAT_STATUSES.has(error.status)
      ) {
        readyStateRef.current = null;
        setState({ status: "refused" });
        return true;
      }
      return false;
    };
    const commit = (
      previous: ReadyState,
      loaded: LoadedCurrentState,
      expectedVersion: number,
    ): ReadyState | null => {
      if (!current || operationVersion !== expectedVersion) return null;
      const latest = readyStateRef.current;
      if (!latest || latest.session !== readySession) return null;
      const nextState: ReadyState = {
        ...previous,
        meta: retainNarrowedAccess(latest.meta, loaded.meta),
        fileAccumulator: loaded.fileAccumulator,
        files: filesFromAccumulator(loaded.fileAccumulator),
        nextCursor: loaded.nextCursor,
        epochLogFloor: loaded.epochLogFloor,
      };
      readyStateRef.current = nextState;
      setState((value) =>
        value.status === "ready" && value.session === readySession
          ? nextState
          : value
      );
      return nextState;
    };
    const refresh = (): Promise<ReadyState | null> => {
      if (refreshInFlight) return refreshInFlight;
      const previous = readyStateRef.current;
      if (previous === null || previous.session !== readySession) {
        return Promise.resolve(null);
      }
      operationVersion += 1;
      const expectedVersion = operationVersion;
      followerController?.abort();
      const refreshPromise = (async (): Promise<ReadyState | null> => {
        try {
          const reloaded = await loadCurrentState(
            readySession,
            sessionController.signal,
          );
          return commit(previous, reloaded, expectedVersion);
        } catch (error: unknown) {
          refuseIfTerminal(error);
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
    void (async () => {
      let retryDelayMs = RETRY_INITIAL_MS;
      for (;;) {
        if (!current) return;
        if (refreshInFlight) {
          await refreshInFlight;
          continue;
        }
        const previous = readyStateRef.current;
        if (!previous || previous.session !== readySession) return;
        const expectedVersion = operationVersion;
        const requestController = new AbortController();
        followerController = requestController;
        const requestStartedAtMs = Date.now();
        let readingLog = true;
        try {
          const log = await loadLog(
            readySession,
            previous.nextCursor,
            new Map(previous.fileAccumulator),
            MAX_LOG_PAGES,
            requestController.signal,
            previous.epochLogFloor,
            VIEW_LOG_HOLD_MS,
            previous.meta.access !== "edit",
          );
          readingLog = false;
          const meta = await loadMeta(readySession, requestController.signal);
          if (commit(previous, { ...log, meta }, expectedVersion) === null) {
            continue;
          }
          retryDelayMs = RETRY_INITIAL_MS;
          const elapsedMs = Date.now() - requestStartedAtMs;
          if (
            log.nextCursor === previous.nextCursor &&
            elapsedMs < VIEW_LOG_HOLD_MS
          ) {
            await waitForRetry(
              VIEW_LOG_HOLD_MS - elapsedMs,
              sessionController.signal,
            );
          }
        } catch (error: unknown) {
          if (!current || operationVersion !== expectedVersion) continue;
          if (error instanceof ViewResponseError && error.status === 404 && readingLog && previous.meta.access === "edit") {
            try {
              const meta = await loadMeta(readySession, sessionController.signal);
              if (meta.access !== "edit" && await refresh()) continue;
            } catch { /* The terminal response below handles removed access. */ }
          }
          if (error instanceof EpochFloorChangedError) {
            const reloaded = await refresh();
            if (reloaded) {
              retryDelayMs = RETRY_INITIAL_MS;
              continue;
            }
            const latest = readyStateRef.current;
            if (!latest || latest.session !== readySession) return;
            try {
              await waitForRetry(retryDelayMs, sessionController.signal);
            } catch {
              return;
            }
            retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
            continue;
          }
          if (refuseIfTerminal(error)) return;
          try {
            await waitForRetry(retryDelayMs, sessionController.signal);
          } catch {
            return;
          }
          retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
        } finally {
          if (followerController === requestController) {
            followerController = null;
          }
        }
      }
    })();
    return () => {
      current = false;
      operationVersion += 1;
      if (refreshReadyStateRef.current === refresh) {
        refreshReadyStateRef.current = null;
      }
      followerController?.abort();
      sessionController.abort();
    };
  }, [readySession]);

  const ready = state.status === "ready" ? state : null;
  // An open editor stays through every state, so its draft remains recoverable.
  if (!editing) {
    if (state.status === "refused") return <Unavailable />;
    if (state.status === "load-failed") {
      return (
        <StatePage icon="alert" failed title="dohc couldn't open the shared files.">
          <p>Check your connection, then choose Try again.</p>
          <button
            className="handoff-button secondary"
            type="button"
            onClick={() => {
              setState({ status: "loading" });
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Try again
          </button>
        </StatePage>
      );
    }
    if (state.status === "version-mismatch") {
      return (
        // The server serves this page, so a reload brings the version it expects, whichever side is older.
        <StatePage icon="refresh" title="This page does not match its server.">
          <p>Reload it to get the version the server expects.</p>
          <button className="handoff-button secondary" type="button" onClick={() => location.reload()}>Reload</button>
        </StatePage>
      );
    }
    if (state.status === "loading") return <Opening />;
  }
  const meta = ready?.meta ?? null;
  const files = ready?.files ?? [];
  const selected = editing
    ? files.find((file) => file.path === editing.path)
    : files.find((file) => file.path === selectedPath) ?? files[0];
  const tree = fileTree(files);
  const several = files.length > 1;
  const filesShown = several && !editing && (narrow ? filesToggled : !filesToggled);
  const selectFile = (path: string) => {
    setSelectedPath(path);
    if (narrow) setFilesToggled(false);
  };
  // Markdown edits live; a Collection's own files save through the direct lane.
  const canEditFile = !editing && meta?.access === "edit" && meta.effectiveSelector.versionId === null &&
    selected?.contentKind === "text" && (/\.md$/i.test(selected.path) || isCollectionOwnFile(selected.path));
  const badge = meta && !editing && !canEditFile ? accessBadge(meta) : null;
  const segments = selected?.path.split("/") ?? [];
  const subject = meta?.subjectName ?? null;
  // The link's own name, unless the open file or its first folder already says it.
  const namesLink = subject !== null && subject !== segments.at(-1) && subject !== segments[0];
  const toggle = (name: Surface) => (event: MouseEvent<HTMLButtonElement>) => {
    trigger.current = event.currentTarget;
    setSurface((current) => current === name ? null : name);
  };
  const stopEditing = () => {
    setEditing(null);
    setEditorOpen(false);
  };
  const editingCollectionFile = editing !== null && isCollectionOwnFile(editing.path);
  const available = editing !== null && ready !== null && ready.session === editing.discriminator && ready.meta.access === "edit" &&
    ready.meta.effectiveSelector.versionId === null && selected !== undefined;
  // The editor mounts once the bar has its place, so Done never shows anywhere else first.
  const editor = !editing || !barSlot ? null : editingCollectionFile
    ? <CollectionFileEditor key={`${editing.discriminator}:${editing.path}`} session={editing.discriminator} path={editing.path}
        blobSha256={editing.blobSha256} available={available} onClose={stopEditing} barSlot={barSlot} />
    : <LinkDocumentEditor key={`${editing.discriminator}:${editing.path}`} discriminator={editing.discriminator} path={editing.path}
        available={available} onClose={stopEditing} barSlot={barSlot} onOpenChange={setEditorOpen}
        otherWay={ready ? <OpenInDohc key={ready.session} session={ready.session} /> : undefined} />;
  // The read-only text stays while live editing opens or can't start. A Collection's file shows only its editor.
  const reads = selected !== undefined && ready !== null && !(editing && (editingCollectionFile || editorOpen));
  const appToOpen = new URLSearchParams(location.search).get("app");
  // A link that holds only apps leads with them, where its files would be.
  const appsLead = files.length === 0 && apps === "some" && !editing;
  const discussion = meta?.channel ? "Channel" : "Comments";
  return (
    <div className={editing ? "viewer link-page editing" : "viewer link-page"}>
      {several && !editing ? (
        <nav id="shared-files" aria-label="Shared files" hidden={!filesShown}>
          <ul className="tree">
            {tree.folders.map((folder) => (
              <Folder
                key={folder.path}
                node={folder}
                selected={selected?.path ?? ""}
                onSelect={(file) => selectFile(file.path)}
              />
            ))}
            {tree.files.map((file) => (
              <li key={file.path}>
                <button
                  className={selected?.path === file.path ? "file selected" : "file"}
                  type="button"
                  onClick={() => selectFile(file.path)}
                >
                  <Icon name={fileIcon(file.path)} />
                  <span>{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {filesShown && narrow ? <div className="backdrop" onClick={() => setFilesToggled(false)} /> : null}
      <div className="page">
        <header>
          <div className="bar-left">
            {several && !editing ? (
              <button
                className={filesShown ? "icon-button on" : "icon-button"}
                type="button"
                aria-label="Files"
                title="Files"
                aria-expanded={filesShown}
                aria-controls="shared-files"
                onClick={() => setFilesToggled((value) => !value)}
              >
                <Icon name="panel-left" />
              </button>
            ) : null}
            <span className="bar-mark"><DohcMark /></span>
            {namesLink || selected ? (
              <div className="crumbs">
                {namesLink ? <span>{subject}</span> : null}
                {segments.slice(0, -1).map((folder, index) => <span key={index}>{folder}</span>)}
                {selected && (several || editing) ? <b>{segments.at(-1)}</b> : null}
                {/* A link to one file has no list to open, so its file list is this one name. */}
                {selected && !several && !editing ? (
                  <nav aria-label="Shared files">
                    <button className="file selected" type="button" onClick={() => selectFile(selected.path)}>
                      <Icon name={fileIcon(selected.path)} />
                      <span>{segments.at(-1)}</span>
                    </button>
                  </nav>
                ) : null}
              </div>
            ) : null}
          </div>
          {editing ? <div className="header-actions" ref={setBarSlot} /> : (
            <div className="header-actions">
              <span className="freshness">{updated}</span>
              <button
                className={surface === "comments" ? "icon-button on" : "icon-button"}
                type="button"
                aria-label={discussion}
                title={discussion}
                aria-expanded={surface === "comments"}
                aria-controls="link-discussion"
                onClick={toggle("comments")}
              >
                <Icon name="message" />
                {!meta?.channel && comments.count > 0 ? <span>{comments.count}{comments.more ? "+" : ""}</span> : null}
              </button>
              {apps === "some" ? (
                <button
                  className={surface === "apps" ? "icon-button on" : "icon-button"}
                  type="button"
                  aria-label="Apps"
                  title="Apps"
                  aria-expanded={surface === "apps" || appsLead}
                  aria-controls="link-apps"
                  // Leading apps are already open, so the button takes the reader to them.
                  onClick={appsLead ? () => document.getElementById(SURFACE_ID.apps)?.focus() : toggle("apps")}
                >
                  <Icon name="grid" />
                </button>
              ) : null}
              <button
                className={surface === "agent" ? "icon-button agent on" : "icon-button agent"}
                type="button"
                aria-label="Use with an agent"
                title="Use with an agent"
                aria-expanded={surface === "agent"}
                aria-controls="link-agent"
                onClick={toggle("agent")}
              >
                <Icon name="sparkles" />
              </button>
              <button
                className={surface === "more" || surface === "about" ? "icon-button on" : "icon-button"}
                type="button"
                aria-label="More"
                title="More"
                aria-expanded={surface === "more"}
                aria-controls="link-more"
                onClick={toggle("more")}
              >
                <Icon name="ellipsis" />
              </button>
              {badge ? <span className="badge" title={badge.reason}>{badge.label}</span> : null}
              {canEditFile && selected && ready ? (
                <button
                  className="handoff-button primary"
                  type="button"
                  onClick={() => {
                    setSurface(null);
                    setEditing({ discriminator: ready.session, path: selected.path, blobSha256: selected.blobSha256 });
                  }}
                >
                  <Icon name="pencil" size={14} />
                  {/* The button's name stays Edit file. Its second word is for screen readers only. */}
                  Edit<span className="sr-only"> file</span>
                </button>
              ) : null}
            </div>
          )}
        </header>
        <div className="layout">
          <div className="scroller">
            <div className="column">
              {appToOpen !== null && ready && !editing ? (
                <OpenSharedApp key={ready.session} session={ready.session} publicationId={appToOpen} />
              ) : null}
              {selected ? <h1 className="page-title">{fileTitle(selected.path)}</h1> : null}
              <main className="content">
                {editor}
                {reads && ready && selected ? (
                  <FileView
                    // A new file starts with empty preview state, so one file's text
                    // never renders under another file's kind.
                    key={`${ready.session}\n${selected.path}\n${selected.blobSha256}`}
                    session={ready.session}
                    file={selected}
                    files={files}
                    onSelect={setSelectedPath}
                    onStaleBlob={refreshStaleBlob}
                  />
                ) : !editing && apps === "none" ? (
                  <div className="empty-state">
                    {EMPTY_PICTURE}
                    <p>No files on this link yet. This page shows them as soon as they arrive.</p>
                  </div>
                ) : null}
              </main>
            </div>
          </div>
          {ready && !editing ? (
            <div className="side-panel" id="link-discussion" tabIndex={-1} data-open={surface === "comments"} inert={surface !== "comments"}>
              <button className="icon-button panel-close" type="button" aria-label={`Close ${discussion.toLowerCase()}`} title="Close" onClick={closeSurface}>
                <Icon name="x" />
              </button>
              {/* A Group share's conversation is its channel; any other share's is its discussion. */}
              <LinkChannelPanel
                session={ready.session}
                channelWireId={ready.meta.channel?.channelWireId ?? null}
                fallback={<CommentsPanel
                  access={ready.meta.access}
                  session={ready.session}
                  onAccessChange={applyDiscussionAccess}
                  onCount={countComments}
                />}
              />
            </div>
          ) : null}
        </div>
        {ready && !editing ? (
          <>
            {surface !== null ? <div className={surface === "comments" ? "backdrop narrow-only" : "backdrop"} onClick={closeSurface} /> : null}
            <div className="popover" id="link-agent" tabIndex={-1} hidden={surface !== "agent"}>
              <LinkAgent secret={agentLink.current.secret} />
            </div>
            <div className="popover" id="link-about" tabIndex={-1} hidden={surface !== "about"}>
              <LinkAbout meta={ready.meta} fileCount={files.length} updated={updated} />
            </div>
            <div className={appsLead ? "popover apps-lead" : "popover"} id="link-apps" tabIndex={-1} hidden={surface !== "apps" && !appsLead}>
              <PublishedApps session={ready.session} onState={setApps} />
            </div>
            <div className="popover link-more" id="link-more" tabIndex={-1} hidden={surface !== "more"}>
              <button className="menu-item" type="button" onClick={() => setSurface("about")}>
                <Icon name="info" />
                About this link
              </button>
              <OpenInDohc key={ready.session} session={ready.session} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
