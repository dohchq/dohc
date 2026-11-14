import { fetchShareWeb } from "./apiVersion";
import { buildShareHandoffUrl } from "@dohc/workspace-contracts/deep-links";
import { OpenSharedApp } from "./OpenSharedApp";
import { PublishedApps, type AppsState } from "./PublishedApps";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { CommentsPanel } from "./CommentsPanel";
import { LinkChannelPanel } from "./LinkChannelPanel";
import { LinkDocumentEditor } from "./LinkDocumentEditor";
import { CollectionFileEditor, isCollectionOwnFile } from "./CollectionFileEditor";
import { showLinkDocument } from "./linkLive";
import { LinkAbout, LinkAgent } from "./LinkEntry";
import { DohcMark, Icon, fileIcon } from "./icons";
import { RETRY_INITIAL_MS, RETRY_MAX_MS } from "./retry";
import {
  filesFromAccumulator,
  type FileAccumulator,
  type ShareAccess,
  type SharedFile,
  type ViewMeta,
} from "./model";
import {
  EMPTY_PICTURE,
  EpochFloorChangedError,
  FileTree,
  FileView,
  MAX_LOG_PAGES,
  Opening,
  RetryExhaustedError,
  SESSION_HEADER,
  StatePage,
  VIEW_LOG_HOLD_MS,
  VersionMismatchError,
  ViewResponseError,
  fileTitle,
  fileTree,
  loadCurrentState,
  loadLog,
  loadMeta,
  useNarrow,
  versionMismatch,
  waitForRetry,
  withBoundedRetry,
  type LoadedCurrentState,
} from "./viewFiles";

const SESSION_PATH = /^\/s\/([A-Za-z0-9_-]{12})\/?$/u;
const HANDOFF_CODE = /^[A-Za-z0-9_-]{43}$/u;
const TERMINAL_HEARTBEAT_STATUSES = new Set([401, 403, 404]);

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

function isCurrentHandoffResponse(value: unknown, nowMs: number): value is HandoffResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  return (
    Object.keys(response).sort().join(",") === "code,expiresAtMs,ok,relayUrl" &&
    response.ok === true &&
    typeof response.code === "string" &&
    HANDOFF_CODE.test(response.code) &&
    typeof response.relayUrl === "string" &&
    response.relayUrl.length > 0 &&
    response.relayUrl.length <= 2048 &&
    typeof response.expiresAtMs === "number" &&
    Number.isSafeInteger(response.expiresAtMs) &&
    response.expiresAtMs > nowMs
  );
}

export const dohcNavigation = {
  urlForCode: buildShareHandoffUrl,
  openCode(code: string, relayUrl: string): void {
    location.assign(dohcNavigation.urlForCode(code, relayUrl));
  },
};

/** What stands where Edit would be, when this link can't edit the open file. */
function accessBadge(meta: ViewMeta): { label: string; reason?: string } {
  if (meta.access === "view") return { label: "View only" };
  if (meta.access === "comment") return { label: "Can comment" };
  return meta.effectiveSelector.versionId !== null
    ? {
        label: "Saved version, read-only",
        reason: "This link shows a saved version, which can't be edited.",
      }
    : {
        label: "Can edit",
        reason: "Pages can be edited here. Open another kind of file in dohc to edit it.",
      };
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
  const ranks = { view: 0, comment: 1, edit: 2 };
  return ranks[current.access] < ranks[incoming.access]
    ? metaAtAccess(incoming, current.access)
    : incoming;
}

function scrubFragment(): void {
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
}

// The link's secret leaves the address bar at once, but stays in `pending`
// until its exchange succeeds or is refused, so Try again can repeat the exchange.
async function establishSession(
  pending: { secret: string | null },
  agentLink: { secret: string | null },
  signal?: AbortSignal,
): Promise<string> {
  const fragment = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/u.test(fragment)) pending.secret = fragment;
  const secret = pending.secret;
  if (secret !== null) {
    agentLink.secret = null;
    const exchange = withBoundedRetry(
      () =>
        fetchShareWeb("/api/exchange", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret }),
          ...(signal ? { signal } : {}),
        }),
      (response) => response.status === 429 || (response.status >= 500 && response.status < 600),
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
  return Math.abs(now - lastSettledAtMs) < 60_000
    ? "Updated just now"
    : `Updated ${relativeTime(lastSettledAtMs, now)}`;
}

function Unavailable() {
  return (
    <StatePage icon="unlink" title="This link isn't available.">
      <p>
        Ask the person who shared it to send the link again. The address in a browser's address bar
        works only in that browser.
      </p>
    </StatePage>
  );
}

type Surface = "comments" | "agent" | "about" | "apps" | "more";
/** Where each surface lives in the page. Opening one moves focus there, and closing returns it to the button. */
const SURFACE_ID: Record<Surface, string> = {
  comments: "link-discussion",
  agent: "link-agent",
  about: "link-about",
  apps: "link-apps",
  more: "link-more",
};

function OpenInDohc(props: { session: string }) {
  const [handoffState, setHandoffState] = useState<HandoffState>("idle");
  const requestRef = useRef<AbortController | null>(null);
  const attemptRef = useRef(0);

  useEffect(
    () => () => {
      attemptRef.current += 1;
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [props.session],
  );

  const mintAndOpen = useCallback(async () => {
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const isCurrent = () => attemptRef.current === attempt && !controller.signal.aborted;
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
          The person who shared it will see the email of the dohc account that opens it. dohc asks
          that account to agree first.
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
        <button className="handoff-button secondary" type="button" onClick={cancelOpening}>
          Cancel
        </button>
      </div>
    );
  }
  if (handoffState === "not-found") {
    return (
      <div className="handoff-panel" role="alert">
        <p>This link can't open in dohc right now. Reload the page to check the share.</p>
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
    <div className="handoff-panel" {...(handoffState === "retryable" ? { role: "alert" } : {})}>
      <p>
        {handoffState === "opened"
          ? "If dohc didn't open, install it, then choose Try again."
          : "dohc couldn't prepare the app handoff. Check your connection, then choose Try again."}
      </p>
      <button className="handoff-button secondary" type="button" onClick={() => void mintAndOpen()}>
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
  const [editing, setEditing] = useState<{
    discriminator: string;
    path: string;
    blobSha256: string;
  } | null>(null);
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
    setComments((current) =>
      current.count === count && current.more === more ? current : { count, more },
    );
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
  const refreshReadyStateRef = useRef<(() => Promise<ReadyState | null>) | null>(null);
  const refreshStaleBlob = useCallback(
    async (path: string, blobSha256: string): Promise<boolean> => {
      const refreshed = await refreshReadyStateRef.current?.();
      if (!refreshed) return false;
      const currentFile = refreshed.files.find((file) => file.path === path);
      return currentFile === undefined || currentFile.blobSha256 !== blobSha256;
    },
    [],
  );
  const applyDiscussionAccess = useCallback((session: string, access: ShareAccess): void => {
    const previous = readyStateRef.current;
    if (!previous || previous.session !== session) return;
    const meta = retainNarrowedAccess(previous.meta, metaAtAccess(previous.meta, access));
    if (meta === previous.meta) return;
    const nextState = { ...previous, meta };
    readyStateRef.current = nextState;
    setState((value) =>
      value.status === "ready" && value.session === session ? { ...value, meta } : value,
    );
  }, []);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await establishSession(
          pendingExchange.current,
          agentLink.current,
          controller.signal,
        );
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
          setState(
            error instanceof VersionMismatchError
              ? { status: "version-mismatch" }
              : // A lost answer, a lost connection or a server that stayed busy says nothing about the link.
                (error instanceof ViewResponseError && error.status >= 500) ||
                  error instanceof TypeError ||
                  error instanceof RetryExhaustedError
                ? { status: "load-failed" }
                : { status: "refused" },
          );
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
    setSelectedPath((path) =>
      readyFiles.some((file) => file.path === path) ? path : (readyFiles[0]?.path ?? ""),
    );
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
        value.status === "ready" && value.session === readySession ? nextState : value,
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
          const reloaded = await loadCurrentState(readySession, sessionController.signal);
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
          // oxlint-disable-next-line typescript/await-thenable -- await needed: refresh() assigns refreshInFlight, which TypeScript's narrowing misses
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
          if (log.nextCursor === previous.nextCursor && elapsedMs < VIEW_LOG_HOLD_MS) {
            await waitForRetry(VIEW_LOG_HOLD_MS - elapsedMs, sessionController.signal);
          }
        } catch (error: unknown) {
          if (!current || operationVersion !== expectedVersion) continue;
          if (
            error instanceof ViewResponseError &&
            error.status === 404 &&
            readingLog &&
            previous.meta.access === "edit"
          ) {
            try {
              const meta = await loadMeta(readySession, sessionController.signal);
              if (meta.access !== "edit" && (await refresh())) continue;
            } catch {
              /* The terminal response below handles removed access. */
            }
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
  const meta = ready?.meta ?? null;
  const files = ready?.files ?? [];
  const selected = editing
    ? files.find((file) => file.path === editing.path)
    : (files.find((file) => file.path === selectedPath) ?? files[0]);
  // A note an Edit link can change: the page fetches its state while it shows it, so a press soon after can type at
  // once. Pressing Edit keeps the same note, so the press can take that state.
  const shownNote =
    meta?.access === "edit" &&
    meta.effectiveSelector.versionId === null &&
    selected?.contentKind === "text" &&
    /\.md$/i.test(selected.path) &&
    !isCollectionOwnFile(selected.path)
      ? selected.path
      : null;
  const shownSession = ready?.session;
  useEffect(
    () => (shownSession && shownNote ? showLinkDocument(shownSession, shownNote) : undefined),
    [shownSession, shownNote],
  );
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
          <button
            className="handoff-button secondary"
            type="button"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </StatePage>
      );
    }
    if (state.status === "loading") return <Opening />;
  }
  const tree = fileTree(files);
  const several = files.length > 1;
  const filesShown = several && !editing && (narrow ? filesToggled : !filesToggled);
  const selectFile = (path: string) => {
    setSelectedPath(path);
    if (narrow) setFilesToggled(false);
  };
  // Markdown edits live; a Collection's own files save through the direct lane.
  const canEditFile =
    !editing &&
    meta?.access === "edit" &&
    meta.effectiveSelector.versionId === null &&
    selected?.contentKind === "text" &&
    (/\.md$/i.test(selected.path) || isCollectionOwnFile(selected.path));
  const badge = meta && !editing && !canEditFile ? accessBadge(meta) : null;
  const segments = selected?.path.split("/") ?? [];
  const subject = meta?.subjectName ?? null;
  // The link's own name, unless the open file or its first folder already says it.
  const namesLink = subject !== null && subject !== segments.at(-1) && subject !== segments[0];
  const toggle = (name: Surface) => (event: MouseEvent<HTMLButtonElement>) => {
    trigger.current = event.currentTarget;
    setSurface((current) => (current === name ? null : name));
  };
  const stopEditing = () => {
    setEditing(null);
    setEditorOpen(false);
  };
  const editingCollectionFile = editing !== null && isCollectionOwnFile(editing.path);
  const available =
    editing !== null &&
    ready !== null &&
    ready.session === editing.discriminator &&
    ready.meta.access === "edit" &&
    ready.meta.effectiveSelector.versionId === null &&
    selected !== undefined;
  // The editor mounts once the bar has its place, so Done never shows anywhere else first.
  const editor =
    !editing || !barSlot ? null : editingCollectionFile ? (
      <CollectionFileEditor
        key={`${editing.discriminator}:${editing.path}`}
        session={editing.discriminator}
        path={editing.path}
        blobSha256={editing.blobSha256}
        available={available}
        onClose={stopEditing}
        barSlot={barSlot}
      />
    ) : (
      <LinkDocumentEditor
        key={`${editing.discriminator}:${editing.path}`}
        discriminator={editing.discriminator}
        path={editing.path}
        available={available}
        onClose={stopEditing}
        barSlot={barSlot}
        onOpenChange={setEditorOpen}
        otherWay={ready ? <OpenInDohc key={ready.session} session={ready.session} /> : undefined}
      />
    );
  // The read-only text stays while live editing opens or cannot start, until the editor has the server's text: its
  // early state or a live sync. A Collection's file shows only its editor.
  const reads =
    selected !== undefined && ready !== null && !(editing && (editingCollectionFile || editorOpen));
  const appToOpen = new URLSearchParams(location.search).get("app");
  // A link that holds only apps leads with them, where its files would be.
  const appsLead = files.length === 0 && apps === "some" && !editing;
  const discussion = meta?.channel ? "Channel" : "Comments";
  return (
    <div className={editing ? "viewer link-page editing" : "viewer link-page"}>
      {several && !editing ? (
        <nav id="shared-files" aria-label="Shared files" hidden={!filesShown}>
          <FileTree tree={tree} label="Shared files" selected={selected?.path ?? ""} onSelect={(file) => selectFile(file.path)} />
        </nav>
      ) : null}
      {filesShown && narrow ? (
        <div className="backdrop" onClick={() => setFilesToggled(false)} />
      ) : null}
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
            <span className="bar-mark">
              <DohcMark />
            </span>
            {namesLink || selected ? (
              <div className="crumbs">
                {namesLink ? <span>{subject}</span> : null}
                {segments.slice(0, -1).map((folder, index) => (
                  <span key={index}>{folder}</span>
                ))}
                {selected && (several || editing) ? <b>{segments.at(-1)}</b> : null}
                {/* A link to one file has no list to open, so its file list is this one name. */}
                {selected && !several && !editing ? (
                  <nav aria-label="Shared files">
                    <button
                      className="file selected"
                      type="button"
                      onClick={() => selectFile(selected.path)}
                    >
                      <Icon name={fileIcon(selected.path)} />
                      <span>{segments.at(-1)}</span>
                    </button>
                  </nav>
                ) : null}
              </div>
            ) : null}
          </div>
          {editing ? (
            <div className="header-actions" ref={setBarSlot} />
          ) : (
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
                {!meta?.channel && comments.count > 0 ? (
                  <span>
                    {comments.count}
                    {comments.more ? "+" : ""}
                  </span>
                ) : null}
              </button>
              {apps === "some" ? (
                <button
                  className={surface === "apps" ? "icon-button on" : "icon-button"}
                  type="button"
                  aria-label="Apps"
                  title="Apps"
                  aria-expanded={surface === "apps" || appsLead}
                  aria-controls="link-apps"
                  // Leading apps are already open, so the button closes anything over them and takes the reader there.
                  onClick={
                    appsLead
                      ? () => {
                          setSurface(null);
                          document.getElementById(SURFACE_ID.apps)?.focus();
                        }
                      : toggle("apps")
                  }
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
                className={
                  surface === "more" || surface === "about" ? "icon-button on" : "icon-button"
                }
                type="button"
                aria-label="More"
                title="More"
                aria-expanded={surface === "more"}
                aria-controls="link-more"
                onClick={toggle("more")}
              >
                <Icon name="ellipsis" />
              </button>
              {badge ? (
                <span className="badge" title={badge.reason}>
                  {badge.label}
                </span>
              ) : null}
              {canEditFile && selected && ready ? (
                <button
                  className="handoff-button primary"
                  type="button"
                  onClick={() => {
                    setSurface(null);
                    setEditing({
                      discriminator: ready.session,
                      path: selected.path,
                      blobSha256: selected.blobSha256,
                    });
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
                <OpenSharedApp
                  key={ready.session}
                  session={ready.session}
                  publicationId={appToOpen}
                />
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
            <div
              className="side-panel"
              id="link-discussion"
              tabIndex={-1}
              data-open={surface === "comments"}
              inert={surface !== "comments"}
            >
              <button
                className="icon-button panel-close"
                type="button"
                aria-label={`Close ${discussion.toLowerCase()}`}
                title="Close"
                onClick={closeSurface}
              >
                <Icon name="x" />
              </button>
              {/* A Group share's conversation is its channel; any other share's is its discussion. */}
              <LinkChannelPanel
                session={ready.session}
                channelWireId={ready.meta.channel?.channelWireId ?? null}
                fallback={
                  <CommentsPanel
                    access={ready.meta.access}
                    session={ready.session}
                    onAccessChange={applyDiscussionAccess}
                    onCount={countComments}
                  />
                }
              />
            </div>
          ) : null}
        </div>
        {ready && !editing ? (
          <>
            {surface !== null ? (
              <div
                className={surface === "comments" ? "backdrop narrow-only" : "backdrop"}
                onClick={closeSurface}
              />
            ) : null}
            <div className="popover" id="link-agent" tabIndex={-1} hidden={surface !== "agent"}>
              <LinkAgent secret={agentLink.current.secret} />
            </div>
            <div className="popover" id="link-about" tabIndex={-1} hidden={surface !== "about"}>
              <LinkAbout meta={ready.meta} fileCount={files.length} updated={updated} />
            </div>
            <div
              className={appsLead ? "popover apps-lead" : "popover"}
              id="link-apps"
              tabIndex={-1}
              hidden={surface !== "apps" && !appsLead}
            >
              <PublishedApps session={ready.session} onState={setApps} />
            </div>
            <div
              className="popover link-more"
              id="link-more"
              tabIndex={-1}
              hidden={surface !== "more"}
            >
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
