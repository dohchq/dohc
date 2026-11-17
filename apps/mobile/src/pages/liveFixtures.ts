// Tests only: a server that opens pages, its sockets, and the page's side of the bridge.
import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-limits";
import { createServerClient, type LiveSocket, type OpenSocket } from "../server/client";
import { testServer, type Answer } from "../server/testServer";
import { outgoing, type FromPage, type LiveFacts } from "./liveBridge";
import type { PageLive } from "./pageLive";

export const TOKEN = "account-token-secret";
export const TICKET = "ticket-secret-123";
export const OPEN = "POST /sync/ws-1/ops/openPage";

export function liveLimits(
  queue: { frames?: number; bytes?: number } = {},
): NamedLiveBrowserLimits {
  return {
    provider: {
      frames: {
        receive: {
          maxFrameBytes: 1024,
          maxStateVectorBytes: 4096,
          maxUpdateBytes: 8192,
          maxSyncBytes: 16384,
        },
        maxQueuedBytes: queue.bytes ?? 16384,
        maxQueuedFrames: queue.frames ?? 64,
        maxControlBytes: 4096,
        maxControlFrames: 8,
        maxAssemblyBytes: 16384,
      },
      maxPendingUpdateBytes: 16384,
      maxPendingUpdates: 8,
      maxDeliveryAttempts: 4,
    },
    maxHttpResponseBytes: 65536,
    maxSocketBufferedBytes: 4096,
    connectTimeoutMs: 30_000,
    sendTimeoutMs: 10_000,
    drainPollMs: 50,
  };
}

export const answer = (result: unknown): Answer => ({ status: 200, body: { ok: true, result } });
export const ready = (limits = liveLimits()) =>
  answer({
    status: "ready",
    objectId: "obj-1",
    lineageClaimId: "claim-1",
    ticket: TICKET,
    expiresAtMs: 1,
    editorLimits: limits,
  });
export const facts = (
  status: LiveFacts["status"],
  pendingUpdates = 0,
  unsent = pendingUpdates > 0,
): LiveFacts => ({ status, reason: null, pendingUpdates, unsent });

export class FakeSocket implements LiveSocket {
  binaryType = "blob";
  protocol = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Uint8Array[] = [];
  readonly closing: (() => void)[] = [];
  closes = 0;
  get closed() {
    return this.closes > 0;
  }
  send(data: ArrayBuffer) {
    this.sent.push(new Uint8Array(data));
  }
  close() {
    this.closes++;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
    for (const listener of this.closing) listener();
  }
  addEventListener(_type: "close", listener: () => void) {
    this.closing.push(listener);
  }
  open(protocol = "dohc-live-v1") {
    this.protocol = protocol;
    this.readyState = 1;
    this.onopen?.();
  }
  frame(...bytes: number[]) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }
}

/** A server whose openPage gives `answers` in turn, and the sockets its client opens. */
export function liveServer(...answers: Answer[]) {
  const server = testServer();
  server.on("POST", "/sync/ws-1/ops/openPage", ...answers);
  const sockets: { url: string; protocols: string[]; headers: object; socket: FakeSocket }[] = [];
  const openSocket: OpenSocket = (url, protocols, options) => {
    const socket = new FakeSocket();
    sockets.push({ url, protocols: [...protocols], headers: options.headers, socket });
    return socket;
  };
  const signIn = new AbortController();
  const client = createServerClient({
    origin: server.origin,
    token: TOKEN,
    fetch: server.fetch,
    signal: signIn.signal,
    openSocket,
  });
  return { server, sockets, latest: () => sockets.at(-1)!.socket, client, signIn };
}

/** The page's side of the stream, numbered as the editor numbers it: one sender for each open. */
export function pageSide(live: Pick<PageLive, "receive">) {
  const senders = new Map<number, ReturnType<typeof outgoing<FromPage>>>();
  return (gen: number) => {
    const sender = senders.get(gen) ?? outgoing<FromPage>(gen, (message) => live.receive(message));
    senders.set(gen, sender);
    return sender;
  };
}
