import { segment } from "../server/api";
import { ServerError, type LiveSocket, type ServerClient } from "../server/client";
import { openPage } from "../server/pageOpen";
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

// A page edited live from the phone. The app opens the page (openPage), then its owner connection with the sign-in's
// token and the page's one-use ticket, and passes protocol frames to and from the page's web view, which runs the
// provider. Neither the token nor the ticket reaches the web view: the token stays in the server client, the ticket in
// `connect` below.
//
// A lost connection keeps the provider, so Try again opens the page again and reconnects it with its waiting edits'
// IDs. A provider that quarantined, or a page the server refused, never reconnects. Unconfirmed text lives only in the
// web view's memory.

export interface PageLiveState {
  /** `lost`: the connection ended or the open failed, and Try again may work. `ended`: the session ended for good. */
  readonly phase: "opening" | "open" | "lost" | "refused" | "ended";
  /** Why it's lost (a server problem or `connection`) or refused (the server's or the provider's reason). */
  readonly reason: string | null;
  /** The provider's last report, or null before the page made one. */
  readonly facts: LiveFacts | null;
}

export interface PageLive {
  state(): PageLiveState;
  subscribe(listener: () => void): () => void;
  /** Opens the page and connects. Call once the web view can take messages. */
  start(): void;
  /** Opens the page again after a lost connection. Does nothing once refused or ended. */
  retry(): void;
  /** A message the web view posted. */
  receive(message: unknown): void;
  /** Closes the socket and ignores every later message. */
  end(): void;
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
  let state: PageLiveState = { phase: "opening", reason: null, facts: null };
  let gen = 0;
  // The current open: its abort, its timer and its socket.
  let open: {
    readonly controller: AbortController;
    socket?: LiveSocket;
    /** The socket opened and the page heard `connect`. */
    connected?: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null = null;
  // The last connection's messages, both ways. They outlive its socket, so the page's reports after a loss still
  // arrive, until the next connection replaces them.
  let stream: {
    readonly toPage: (body: Body<ToPage>) => void;
    readonly check: (message: FromPage) => "next" | "stale" | "broken";
    readonly window: ReturnType<typeof frameWindow>;
  } | null = null;

  const set = (next: Partial<PageLiveState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  /** Ends the current open: its requests, its timer, and its socket. */
  function close() {
    if (!open) return;
    open.controller.abort();
    clearTimeout(open.timer);
    const socket = open.socket;
    open = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  /** The connection ended. The page hears it, so its provider stops and keeps its waiting edits. */
  function lose(reason: string) {
    if (state.phase === "ended" || state.phase === "refused") return;
    const connected = open?.connected === true;
    close();
    if (connected) stream?.toPage({ type: "lost" });
    set({ phase: "lost", reason });
  }

  function refuse(reason: string) {
    const connected = open?.connected === true;
    close();
    if (connected) stream?.toPage({ type: "lost" });
    set({ phase: "refused", reason });
  }

  async function begin() {
    close();
    const held = { controller: new AbortController() };
    open = held;
    set({ phase: "opening", reason: null });
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
        // The live host is still waking the page.
        await sleep(delay, held.controller.signal);
        if (!current()) return;
        delay = Math.min(LONGEST_RETRY_MS, delay * 2);
      }
    } catch (error) {
      if (!current()) return;
      lose(error instanceof ServerError ? error.problem : "invalid");
    }
  }

  function connect(answer: Extract<Awaited<ReturnType<typeof openPage>>, { status: "ready" }>) {
    const held = open!;
    const query = `objectId=${encodeURIComponent(answer.objectId)}&lineageClaimId=${encodeURIComponent(answer.lineageClaimId)}`;
    const socket = options.client.liveSocket(
      `/sync/workspaces/${segment(options.workspaceId)}/live/owner?${query}`,
      ["dohc-live-v1", `dohc-live-ticket.${answer.ticket}`],
    );
    held.socket = socket;
    socket.binaryType = "arraybuffer";
    const frames = answer.limits.provider.frames;
    // Each connection numbers its messages afresh; the page drops an earlier one's.
    const next = {
      toPage: outgoing<ToPage>(++gen, options.post),
      check: incoming(gen),
      window: frameWindow(frames.maxQueuedFrames, frames.maxQueuedBytes),
    };
    held.timer = setTimeout(() => lose("connection"), answer.limits.connectTimeoutMs);
    socket.onopen = () => {
      if (open !== held) return;
      clearTimeout(held.timer);
      // The server selects exactly the live protocol; anything else isn't the page's connection.
      if (socket.protocol !== "dohc-live-v1") return refuse("invalid-socket-protocol");
      stream = next;
      held.connected = true;
      set({ phase: "open", reason: null });
      next.toPage({
        type: "connect",
        limits: answer.limits,
        workspaceId: options.workspaceId,
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
    const held = stream;
    if (!message || !held || state.phase === "ended") return;
    const order = held.check(message);
    if (order === "stale") return;
    if (order === "broken") return lose("bridge-order");
    const socket = open?.socket;
    switch (message.type) {
      case "frame":
        // A frame the provider sent before it heard of the loss has nowhere to go.
        if (state.phase !== "open" || socket?.readyState !== 1) return;
        socket.send(fromBase64(message.data).buffer);
        held.toPage({ type: "sent" });
        return;
      case "took":
        if (!held.window.release()) lose("bridge-order");
        return;
      case "close":
        // Only the open connection's: a late one must not end the open Try again started.
        if (state.phase === "open") lose("connection");
        return;
      case "state":
        // A quarantined provider never reconnects; its edits stay on screen to copy.
        if (message.facts.status === "quarantined") {
          set({ facts: message.facts });
          return refuse(message.facts.reason ?? "quarantined");
        }
        set({ facts: message.facts });
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
      close();
      if (state.phase !== "ended") set({ phase: "ended" });
    },
  };
}

/**
 * The header's mark for a live page. Saved needs the provider live with no waiting update: each local update leaves
 * the provider only on the server's ACK that its host applied it. A socket send or a paint proves nothing.
 */
export function liveMark(state: PageLiveState): MarkKey {
  const facts = state.facts;
  switch (state.phase) {
    case "opening":
    case "open":
      if (facts?.status === "live") return facts.pendingUpdates > 0 ? "saving" : "saved";
      return facts && facts.pendingUpdates > 0 ? "saving" : "opening";
    case "lost":
      // The server answered the open, but not with the page; any other loss is the connection's.
      return ["server-busy", "refused", "invalid", "not-found"].includes(state.reason ?? "")
        ? "readOnlyRefused"
        : "readOnlyOffline";
    case "refused":
      return facts?.unsent
        ? "readOnlySetAside"
        : state.reason === "live-document-without-lineage"
          ? "readOnlyNeedsComputer"
          : "readOnlyRefused";
    case "ended":
      return "readOnlyPhone";
  }
}

/** Whether leaving the page would lose text the server hasn't applied. */
export const holdsUnsent = (state: PageLiveState) =>
  state.phase !== "ended" && state.facts !== null && state.facts.unsent;

/** One sign-in's and workspace's live pages, which the account ends with its apps (appTeardown). */
export interface PageScope {
  readonly signIn: object;
  readonly workspaceId: string;
}
export function createLivePages() {
  const open = new Map<{ readonly end: () => void }, PageScope>();
  return {
    /** Returns the removal. */
    add(scope: PageScope, live: { readonly end: () => void }) {
      open.set(live, scope);
      return () => void open.delete(live);
    },
    end(match: (scope: PageScope) => boolean = () => true) {
      for (const [live, scope] of [...open]) {
        if (!match(scope)) continue;
        open.delete(live);
        live.end();
      }
    },
  };
}
export type LivePages = ReturnType<typeof createLivePages>;
