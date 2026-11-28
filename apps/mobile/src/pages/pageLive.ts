import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-limits";
import { segment } from "../server/api";
import { ServerError, type LiveSocket, type ServerClient } from "../server/client";
import { openPage, type PageOpen } from "../server/pageOpen";
import {
  frameWindow,
  fromBase64,
  incoming,
  outgoing,
  readFromPage,
  toBase64,
  type Body,
  type FromPage,
  type LiveFacts,
  type ToPage,
} from "./liveBridge";
import type { MarkKey } from "./pageParts";

// A page edited live from the phone. The app opens the page, then its owner connection, and passes protocol frames to
// and from the web view, which runs the provider. The token stays in the server client and the ticket in `connect`.
// A lost connection keeps the provider, so Try again reconnects it with its waiting edits' IDs; a quarantined provider
// or a refused page never reconnects.

export interface PageLiveState {
  /** `lost`: Try again may work. `ended`: the session ended for good. */
  readonly phase: "opening" | "open" | "lost" | "refused" | "ended";
  /** A server problem or `connection` when lost; the server's or the provider's reason when refused. */
  readonly reason: string | null;
  /** The provider's last report on the current connection; null until it makes one. */
  readonly facts: LiveFacts | null;
  /** The provider's last report said it holds edits the server hasn't applied. Outlives the connection. */
  readonly unsent: boolean;
  /** The page shows the live document, not the text the app read. */
  readonly shown: boolean;
  /** The object identity of the live document opened by `openPage`, once bound. */
  readonly objectId?: string;
}

export interface PageLive {
  state(): PageLiveState;
  subscribe(listener: () => void): () => void;
  /** Opens the page and connects. Call once the web view can take messages. */
  start(): void;
  /** Opens the page again after a lost connection. */
  retry(): void;
  /** A message the web view posted. */
  receive(message: unknown): void;
  /** Closes the socket, stops the page's editing, and ignores every later message. */
  end(): Promise<void>;
}

interface Stream {
  readonly objectId: string;
  readonly toPage: (body: Body<ToPage>) => void;
  readonly check: (message: FromPage) => "next" | "stale" | "broken";
  readonly window: ReturnType<typeof frameWindow>;
  readonly limits: NamedLiveBrowserLimits;
}

const FIRST_RETRY_MS = 500;
const LONGEST_RETRY_MS = 8_000;

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new ServerError("cancelled"));
    });
  });

export function createPageLive(options: {
  readonly client: ServerClient;
  readonly workspaceId: string;
  readonly path: string;
  /** Delivers a message to the web view, in order. */
  readonly post: (message: ToPage) => void;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): PageLive {
  const sleep = options.sleep ?? wait;
  const listeners = new Set<() => void>();
  let state: PageLiveState = {
    phase: "opening",
    reason: null,
    facts: null,
    unsent: false,
    shown: false,
  };
  let gen = 0;
  let open: {
    readonly controller: AbortController;
    socket?: LiveSocket;
    /** The socket opened and the page heard `connect`. */
    connected?: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;
  // The last connection's messages both ways. They outlive its socket, so the page's reports after a loss arrive, until
  // the next open retires them.
  let stream: Stream | null = null;
  // The connection before Try again. Its late reports can't show Saved, but their unsent text still asks before leaving.
  let retired: Stream | null = null;

  const set = (next: Partial<PageLiveState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  /** Ends the current open, and tells a connected page so its provider stops taking edits. */
  function close(): Promise<void> {
    if (!open) return Promise.resolve();
    const { controller, timer, socket, connected } = open;
    open = null;
    controller.abort();
    clearTimeout(timer);
    let closed = Promise.resolve();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState !== 3) {
        closed = new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(fallback);
            socket.onclose = socket.onerror = null;
            resolve();
          };
          const fallback = setTimeout(done, 1_000);
          socket.onclose = socket.onerror = done;
        });
      }
      socket.close();
    }
    if (connected) stream?.toPage({ type: "lost" });
    return closed;
  }

  function lose(reason: string) {
    if (state.phase === "ended" || state.phase === "refused") return;
    void close();
    set({ phase: "lost", reason });
  }

  function refuse(reason: string) {
    void close();
    set({ phase: "refused", reason });
  }

  async function begin() {
    void close();
    const held = { controller: new AbortController() };
    open = held;
    // The last connection's reports say nothing of this one.
    retired = stream ?? retired;
    stream = null;
    set({ phase: "opening", reason: null, facts: null });
    const current = () => open === held;
    let delay = FIRST_RETRY_MS;
    try {
      while (true) {
        const answer = await openPage(
          options.client,
          options.workspaceId,
          options.path,
          held.controller.signal,
        );
        if (!current()) return;
        if (answer.status === "refused") return refuse(answer.reason);
        if (answer.status === "ready") return connect(answer);
        await sleep(delay, held.controller.signal);
        if (!current()) return;
        delay = Math.min(LONGEST_RETRY_MS, delay * 2);
      }
    } catch (error) {
      if (!current()) return;
      lose(error instanceof ServerError ? error.problem : "invalid");
    }
  }

  function connect(answer: Extract<PageOpen, { status: "ready" }>) {
    const held = open!;
    const socketPath =
      answer.mode === "named"
        ? `/sync/live/phone?session=${encodeURIComponent(answer.session)}`
        : `/sync/workspaces/${segment(options.workspaceId)}/live/owner?objectId=${encodeURIComponent(answer.objectId)}&lineageClaimId=${encodeURIComponent(answer.lineageClaimId)}`;
    const liveWorkspaceId = answer.mode === "named" ? answer.liveWorkspaceId : options.workspaceId;
    const socket = options.client.liveSocket(socketPath, [
      "dohc-live-v1",
      `dohc-live-ticket.${answer.ticket}`,
    ]);
    held.socket = socket;
    socket.binaryType = "arraybuffer";
    const frames = answer.limits.provider.frames;
    const next = {
      objectId: answer.objectId,
      toPage: outgoing<ToPage>(++gen, options.post),
      check: incoming(gen),
      window: frameWindow(frames.maxQueuedFrames, frames.maxQueuedBytes),
      limits: answer.limits,
    };
    held.timer = setTimeout(() => lose("connection"), answer.limits.connectTimeoutMs);
    socket.onopen = () => {
      if (open !== held) return;
      clearTimeout(held.timer);
      if (socket.protocol !== "dohc-live-v1") return refuse("invalid-socket-protocol");
      stream = next;
      held.connected = true;
      set({ phase: "open", reason: null });
      next.toPage({
        type: "connect",
        limits: answer.limits,
        workspaceId: liveWorkspaceId,
        objectId: answer.objectId,
      });
    };
    socket.onmessage = (event) => {
      if (open !== held) return;
      if (stream !== next || !(event.data instanceof ArrayBuffer))
        return refuse("invalid-socket-message");
      // The page takes frames as fast as the provider grants credit, so a full window is a broken stream.
      if (!next.window.add(event.data.byteLength)) return lose("bridge-full");
      next.toPage({ type: "frame", data: toBase64(new Uint8Array(event.data)) });
    };
    socket.onclose = socket.onerror = () => {
      if (open === held) lose("connection");
    };
  }

  function receive(raw: unknown) {
    const message = readFromPage(raw);
    if (!message || state.phase === "ended") return;
    const held = stream;
    const order = held?.check(message) ?? "stale";
    if (order === "stale") {
      if (retired?.check(message) === "next" && message.type === "state" && message.facts.unsent)
        set({ unsent: true });
      return;
    }
    if (order === "broken" || !held) return lose("bridge-order");
    const socket = open?.socket;
    switch (message.type) {
      case "frame": {
        // A frame the provider sent before it heard of the loss has nowhere to go.
        if (state.phase !== "open" || socket?.readyState !== 1) return;
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = fromBase64(message.data);
        } catch {
          return lose("bridge-order");
        }
        if (bytes.length > held.limits.provider.frames.receive.maxFrameBytes)
          return lose("bridge-order");
        socket.send(bytes.buffer);
        held.toPage({ type: "sent" });
        return;
      }
      case "took":
        if (!held.window.release()) lose("bridge-order");
        return;
      case "close":
        // Only the open connection's: a late one must not end the open Try again started.
        if (state.phase === "open") lose("connection");
        return;
      case "state": {
        const facts = message.facts;
        set({
          facts,
          unsent: facts.unsent,
          shown: state.shown || facts.status === "live",
          ...(facts.status === "live" ? { objectId: held.objectId } : {}),
        });
        if (facts.status !== "quarantined") return;
        if (facts.reason === "lineage-replaced" && !facts.unsent && state.phase === "lost")
          void begin();
        else refuse(facts.reason ?? "quarantined");
      }
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      if (gen === 0 && state.phase === "opening") void begin();
    },
    retry() {
      if (state.phase === "lost") void begin();
    },
    receive,
    end() {
      const closed = close();
      stream = retired = null;
      if (state.phase !== "ended") set({ phase: "ended" });
      return closed;
    },
  };
}

/**
 * The header's mark for a live page. Saved needs the current connection's provider live with no waiting update: each
 * local update leaves the provider only on the server's ACK that its host applied it.
 */
export function liveMark(state: PageLiveState): MarkKey {
  const facts = state.facts;
  switch (state.phase) {
    case "opening":
    case "open":
      if (facts?.status === "live") return facts.pendingUpdates > 0 ? "saving" : "saved";
      return state.unsent ? "saving" : "opening";
    case "lost":
      // The server answered the open, but not with the page; any other loss is the connection's.
      return ["server-busy", "refused", "invalid", "not-found"].includes(state.reason ?? "")
        ? "readOnlyRefused"
        : "readOnlyOffline";
    case "refused":
      return state.unsent
        ? "readOnlySetAside"
        : state.reason === "live-document-without-lineage"
          ? "readOnlyNeedsComputer"
          : state.reason === "read-only"
            ? "readOnlyShared"
            : state.reason === "live_paused_by_owner"
              ? "readOnlyPausedByOwner"
              : state.reason === "authority-refused"
                ? "readOnlyEnded"
                : "readOnlyRefused";
    case "ended":
      return "readOnlyPhone";
  }
}

/** Whether leaving the page would lose text the server hasn't applied. */
export const holdsUnsent = (state: PageLiveState) => state.phase !== "ended" && state.unsent;

/**
 * Whether the web view must stay: it shows the live document, or may yet. Text the app reads later never replaces it.
 */
export const holdsPage = (state: PageLiveState) =>
  state.phase !== "ended" && (state.phase !== "refused" || state.shown || state.unsent);

/** What one sign-in and workspace hold open, which the account ends with its apps (appTeardown). */
export interface WorkspaceScope {
  readonly signIn: object;
  readonly workspaceId: string;
}
export function createScopedEnds() {
  const open = new Map<{ end(): void }, WorkspaceScope>();
  return {
    /** Holds `held` until the returned removal: a page screen with or without a session yet, or a store. */
    add(scope: WorkspaceScope, held: { end(): void }) {
      open.set(held, scope);
      return () => void open.delete(held);
    },
    end(match: (scope: WorkspaceScope) => boolean = () => true) {
      for (const [held, scope] of [...open]) if (match(scope)) held.end();
    },
  };
}
export type ScopedEnds = ReturnType<typeof createScopedEnds>;
