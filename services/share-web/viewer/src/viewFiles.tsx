import { fetchShareWeb } from "./apiVersion";
import { normalizeShareLabel } from "@dohc/security-contract/share-labels";
import {
  Component,
  lazy,
  Suspense,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parsePublicExcalidrawScene } from "./excalidraw";
import { useImageRetryHandlers } from "./imageRetry";
import { MarkdownContent } from "./MarkdownContent";
import { DohcMark, Icon, fileIcon } from "./icons";
import { RETRY_BUDGET_MS, RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";
import {
  accumulatorFromCurrentFiles,
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

// A shared view's reads and parts: the share link page and a member's
// workspace page read the same routes and show files the same way.

export const ExcalidrawView = lazy(() => import("./ExcalidrawView"));

export class ExcalidrawRenderBoundary extends Component<
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

export const SESSION_HEADER = "x-dohc-link-session";

export const VIEW_LOG_HOLD_MS = 30_000;

export const MAX_LOG_PAGES = 200;
export const TEXT_PREVIEW_BYTE_CAP = 2 * 1024 * 1024;

export interface LoadedLog {
  fileAccumulator: FileAccumulator;
  nextCursor: number;
  epochLogFloor: number;
}

export interface LoadedCurrentState extends LoadedLog {
  meta: ViewMeta;
  /** A member's level on each file the current read listed, which varies by folder. */
  levels: ReadonlyMap<string, ShareAccess>;
}

const LEVELS: readonly unknown[] = ["view", "comment", "edit"];
function fileLevels(files: unknown): Map<string, ShareAccess> {
  const levels = new Map<string, ShareAccess>();
  if (!Array.isArray(files)) return levels;
  for (const file of files as unknown[]) {
    const { path, access } = (file ?? {}) as Record<string, unknown>;
    if (typeof path === "string" && LEVELS.includes(access))
      levels.set(path, access as ShareAccess);
  }
  return levels;
}

export class ViewResponseError extends Error {
  constructor(readonly status: number) {
    super("refused");
  }
}

// The server stayed busy or unreachable for the whole retry budget; the link may still open.
export class RetryExhaustedError extends Error {
  constructor() {
    super("retry budget exhausted");
  }
}

// A share-web ingress refusal describes the viewer/server wire mismatch.
export class VersionMismatchError extends Error {}

export async function versionMismatch(response: Response): Promise<VersionMismatchError | null> {
  if (response.status !== 409) return null;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { api?: unknown; code?: unknown; error?: unknown } | null;
  return body?.api === "share-web" &&
    (body.code === "api_version_too_old" || body?.code === "api_version_too_new") &&
    typeof body.error === "string"
    ? new VersionMismatchError(body.error)
    : null;
}

export class EpochFloorChangedError extends Error {
  constructor() {
    super("epoch floor changed");
  }
}

export type TextPreview = { status: "ready"; text: string } | { status: "download" };

export async function api(session: string, path: string, signal?: AbortSignal): Promise<Response> {
  return fetchShareWeb(path, {
    credentials: "same-origin",
    headers: { [SESSION_HEADER]: session },
    ...(signal ? { signal } : {}),
  });
}

export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
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

export async function apiWithThrottleRetry(
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

export async function withBoundedRetry(
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
export function isStrayControlByte(byte: number): boolean {
  return (
    (byte < 0x20 &&
      byte !== 0x09 &&
      byte !== 0x0a &&
      byte !== 0x0b &&
      byte !== 0x0c &&
      byte !== 0x0d &&
      byte !== 0x1b) ||
    byte === 0x7f
  );
}
export const MAX_STRAY_CONTROL_SHARE = 0.01;

export async function readTextPreview(response: Response): Promise<TextPreview> {
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
    if (!response.ok)
      throw (await versionMismatch(response)) ?? new ViewResponseError(response.status);
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
    if (expectedEpochLogFloor !== undefined && page.epochLogFloor !== expectedEpochLogFloor) {
      throw new EpochFloorChangedError();
    }
    if (foldEpochLogFloor === undefined) {
      foldEpochLogFloor = page.epochLogFloor;
    } else if (page.epochLogFloor !== foldEpochLogFloor) {
      throw new EpochFloorChangedError();
    }
    if ((page.ops as RelayOp[]).some((op) => op.opKind === "files.reset"))
      throw new EpochFloorChangedError();
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

export function relayOp(value: unknown, currentOnly = false): value is RelayOp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (currentOnly) {
    if (!Number.isSafeInteger(record.relaySeq) || Number(record.relaySeq) < 0) return false;
    if (record.opKind === "files.reset") return true;
    const payload = record.payload as { objectId?: unknown; file?: unknown } | null;
    if (record.opKind !== "file.current" || !payload || typeof payload.objectId !== "string")
      return false;
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

export function viewMeta(value: unknown): ViewMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const selector = record.effectiveSelector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) return null;
  const selectorRecord = selector as Record<string, unknown>;
  const access = record.access;
  if (
    (access !== "view" && access !== "comment" && access !== "edit") ||
    // A member's selector names no level: theirs varies by folder.
    ("access" in selectorRecord && selectorRecord.access !== access) ||
    !Array.isArray(selectorRecord.paths) ||
    selectorRecord.paths.some((path) => typeof path !== "string") ||
    (selectorRecord.versionId !== null && typeof selectorRecord.versionId !== "string") ||
    typeof record.lastSettledKnown !== "boolean" ||
    (record.lastSettledAtMs !== null &&
      (typeof record.lastSettledAtMs !== "number" || !Number.isSafeInteger(record.lastSettledAtMs)))
  ) {
    return null;
  }
  const channel = record.channel as Record<string, unknown> | null | undefined;
  if (
    channel !== undefined &&
    (!channel || typeof channel !== "object" || typeof channel.channelWireId !== "string")
  )
    return null;
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
    ...(typeof record.levelChangedBy === "string" && record.levelChangedBy.trim()
      ? { levelChangedBy: record.levelChangedBy.trim() }
      : {}),
    ...(typeof record.reach === "string" ? { reach: record.reach } : {}),
  };
}

export async function loadCurrentProjection(
  session: string,
  signal?: AbortSignal,
): Promise<LoadedCurrentState> {
  const response = await apiWithThrottleRetry(session, "/api/view/current", signal);
  if (!response.ok)
    throw (await versionMismatch(response)) ?? new ViewResponseError(response.status);
  const body = (await response.json()) as Record<string, unknown>;
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
    levels: fileLevels(body.files),
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
      return { ...caughtUp, meta: projection.meta, levels: projection.levels };
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

export async function loadMeta(session: string, signal?: AbortSignal): Promise<ViewMeta> {
  const response = await apiWithThrottleRetry(session, "/api/view/meta", signal);
  if (!response.ok)
    throw (await versionMismatch(response)) ?? new ViewResponseError(response.status);
  const meta = viewMeta(await response.json());
  if (!meta) throw new Error("refused");
  return meta;
}

/** A file's title: its name, without the folders, and without the extension when it is a page. */
export function fileTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return isMarkdown(path) ? name.replace(/\.(md|markdown)$/i, "") : name;
}

export interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  files: SharedFile[];
}

export interface FolderBuilder {
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
    files: [...folder.files].sort((left, right) => left.path.localeCompare(right.path)),
  });
  return complete(root);
}

type TreeRow = { path: string; level: number; parent: string | null } & (
  | { folder: FolderNode }
  | { file: SharedFile }
);

function treeRows(
  node: FolderNode,
  closed: ReadonlySet<string>,
  level = 1,
  parent: string | null = null,
): TreeRow[] {
  return [
    ...node.folders.flatMap((folder): TreeRow[] => [
      { path: folder.path, level, parent, folder },
      ...(closed.has(folder.path) ? [] : treeRows(folder, closed, level + 1, folder.path)),
    ]),
    ...node.files.map((file): TreeRow => ({ path: file.path, level, parent, file })),
  ];
}

/**
 * Shared files as a WAI-ARIA tree. One item takes Tab. Up and Down move, Right
 * opens a folder or enters it, Left closes it or goes to its folder, Home and
 * End jump, and Enter opens a file.
 */
export function FileTree(props: {
  tree: FolderNode;
  label: string;
  selected: string;
  onSelect: (file: SharedFile) => void;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLButtonElement>());
  const rows = useMemo(() => treeRows(props.tree, closed), [props.tree, closed]);
  const tabbable =
    rows.find((row) => row.path === focused)?.path ??
    rows.find((row) => row.path === props.selected)?.path ??
    rows[0]?.path;
  const fold = (path: string, open: boolean) =>
    setClosed((value) => {
      const next = new Set(value);
      if (open) next.delete(path);
      else next.add(path);
      return next;
    });
  const keyDown = (event: KeyboardEvent, row: TreeRow) => {
    const at = rows.indexOf(row),
      open = "folder" in row && !closed.has(row.path);
    let target: TreeRow | undefined;
    switch (event.key) {
      case "ArrowDown":
        target = rows[at + 1];
        break;
      case "ArrowUp":
        target = rows[at - 1];
        break;
      case "Home":
        target = rows[0];
        break;
      case "End":
        target = rows.at(-1);
        break;
      case "ArrowRight":
        if ("folder" in row && !open) fold(row.path, true);
        else if (open && rows[at + 1]?.parent === row.path) target = rows[at + 1];
        break;
      case "ArrowLeft":
        if (open) fold(row.path, false);
        else target = rows.find((item) => item.path === row.parent);
        break;
      // Handled here, so the button does not also click.
      case "Enter":
        if ("file" in row) props.onSelect(row.file);
        else fold(row.path, !open);
        break;
      default:
        return;
    }
    event.preventDefault();
    if (target) items.current.get(target.path)?.focus();
  };
  const item = (row: TreeRow) => {
    const open = "folder" in row && !closed.has(row.path),
      selected = props.selected === row.path;
    return (
      <button
        ref={(node) => {
          if (node) items.current.set(row.path, node);
          else items.current.delete(row.path);
        }}
        role="treeitem"
        aria-level={row.level}
        aria-expanded={"folder" in row ? open : undefined}
        aria-selected={"file" in row ? selected : undefined}
        aria-current={selected ? "page" : undefined}
        className={"folder" in row ? "folder" : selected ? "file selected" : "file"}
        tabIndex={row.path === tabbable ? 0 : -1}
        type="button"
        onFocus={() => setFocused(row.path)}
        onKeyDown={(event) => keyDown(event, row)}
        onClick={() => ("file" in row ? props.onSelect(row.file) : fold(row.path, !open))}
      >
        {"folder" in row ? (
          <>
            <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
            <Icon name="folder" />
            <span>{row.folder.name}</span>
          </>
        ) : (
          <>
            <Icon name={fileIcon(row.file.path)} />
            <span>{row.file.path.split("/").at(-1)}</span>
          </>
        )}
      </button>
    );
  };
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const children = (node: FolderNode): ReactNode => (
    <>
      {node.folders.map((folder) => (
        <li key={folder.path} role="none">
          {item(byPath.get(folder.path)!)}
          {closed.has(folder.path) ? null : <ul role="group">{children(folder)}</ul>}
        </li>
      ))}
      {node.files.map((file) => (
        <li key={file.path} role="none">
          {item(byPath.get(file.path)!)}
        </li>
      ))}
    </>
  );
  return (
    <ul className="tree" role="tree" aria-label={props.label}>
      {children(props.tree)}
    </ul>
  );
}

export function FileView(props: {
  session: string;
  file: SharedFile;
  files: SharedFile[];
  onSelect: (path: string) => void;
  onStaleBlob: (path: string, blobSha256: string) => Promise<boolean>;
}) {
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewIsDownload, setPreviewIsDownload] = useState(false);
  const [fileStatus, setFileStatus] = useState<"ready" | "refreshing" | "unavailable">("ready");
  const [readAttempt, setReadAttempt] = useState(0);
  const rendersMarkdown = props.file.contentKind === "text" && isMarkdown(props.file.path);
  const rendersExcalidraw = props.file.contentKind === "text" && isExcalidraw(props.file.path);
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
    if (!rendersTextPreview)
      return () => {
        current = false;
      };
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
        const changed = await props.onStaleBlob(props.file.path, props.file.blobSha256);
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
        resolveImage={(href) => resolveSharedImage(href, props.file.path, fileMap, props.session)}
        resolveLink={(href) => resolveSharedFile(href, props.file.path, fileMap)?.path ?? null}
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
      <RasterImage source={source} alt={props.file.path.split("/").at(-1) ?? "Shared image"} />
    );
  }
  return <DownloadCard file={props.file} session={props.session} />;
}

export function RasterImage(props: { source: string; alt: string }) {
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

export function DownloadCard(props: { file: SharedFile; session: string }) {
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
    // No glyphs here: a file that opens as a download shows no SVG at all, so a shared SVG is plainly never drawn.
    <div className="download-card">
      <p>
        {isSvg(props.file.path) ? "SVG files open as downloads." : "This file opens as a download."}
      </p>
      <a
        className="handoff-button secondary"
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
        <p className="download-error muted">The download didn't finish. Try again.</p>
      ) : null}
    </div>
  );
}

/** A page that stands alone: the mark, what happened, and the next step when there is one. */
export function StatePage(props: {
  icon: "unlink" | "alert" | "refresh";
  failed?: boolean;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="state-page">
      <span className="bar-mark">
        <DohcMark />
      </span>
      <main className="state">
        <div className="state-message" role={props.failed ? "alert" : undefined}>
          <span className={props.failed ? "tile bad" : "tile"}>
            <Icon name={props.icon} size={20} />
          </span>
          <h1>{props.title}</h1>
          {props.children}
        </div>
      </main>
    </div>
  );
}

// The page's shape while it loads. It stays blank for its first 150 ms, so a fast link never flashes it.
export function Opening() {
  return (
    <div className="state-page">
      <span className="bar-mark">
        <DohcMark />
      </span>
      <main className="state opening" aria-busy="true">
        <p className="sr-only">Opening shared files</p>
        <div className="skeleton" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </main>
    </div>
  );
}

export const EMPTY_PICTURE = (
  <svg
    aria-hidden="true"
    width="72"
    height="88"
    viewBox="0 0 72 88"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
  >
    <rect x="1" y="1" width="70" height="86" rx="6" strokeDasharray="5 6" />
    <path d="M16 22h26M16 36h40M16 48h40M16 60h28" />
  </svg>
);

// Narrow windows show the file list and the panels over the page, not beside it.
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 720px)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 720px)");
    if (!query) return;
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
