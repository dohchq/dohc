import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { parseRedeemedLiveTicket, type RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import { createLiveGatewayRequestParser } from "./liveGatewayRequest.js";

export interface NamedLiveGatewaySession {
  readonly userId: string;
  readonly workspaceId: string;
  readonly shareId: string;
  readonly grantId: string;
}

export interface LiveGatewayHostRoute {
  readonly ticket: RedeemedLiveTicket;
  // Exclusively owned, open and paused. The router checks current host, binding
  // and fence before returning; invalidation precedes replacement or fencing.
  readonly socket: WebSocket;
  readonly invalidated: AbortSignal;
}

export interface LiveGatewayHostReceiveOptions {
  readonly maxPayload: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  readonly closeTimeout: number;
  readonly perMessageDeflate: false;
  readonly autoPong: false;
}

export interface LiveGatewayLimits {
  readonly maxConnections: number;
  readonly maxConnectionsPerSession: number;
  readonly maxConnectionsPerPrincipal: number;
  readonly maxConnectionsPerGrant: number;
  readonly maxFrameBytes: number;
  readonly maxPendingBytes: number;
  readonly maxPendingFrames: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  readonly upgradeTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly drainTimeoutMs: number;
}

export interface LiveGatewayOptions {
  readonly publicHosts: ReadonlySet<string>;
  readonly publicOrigin: string;
  readonly limits: LiveGatewayLimits;
  // The adapter resolves trusted route scope and the account cookie through
  // relay named authentication. The discriminator is a lookup key, not identity.
  resolveNamedSession(request: IncomingMessage, discriminator: string, signal: AbortSignal): Promise<NamedLiveGatewaySession | null>;
  redeem(token: string, session: NamedLiveGatewaySession, signal: AbortSignal): Promise<RedeemedLiveTicket | null>;
  // Apply these options when constructing or accepting the host socket, before
  // receiving any bytes. An already-open socket's decoder cannot be reconfigured.
  openHostRoute(ticket: RedeemedLiveTicket, signal: AbortSignal, receive: LiveGatewayHostReceiveOptions): Promise<LiveGatewayHostRoute | null>;
}

function copiedSession(value: NamedLiveGatewaySession): NamedLiveGatewaySession {
  const { userId, workspaceId, shareId, grantId } = value;
  if ([userId, workspaceId, shareId, grantId].some(id => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("Invalid named gateway session.");
  }
  return Object.freeze({ userId, workspaceId, shareId, grantId });
}

function untilCancelled<T>(pending: Promise<T>, signal: AbortSignal, dispose?: (value: T) => void): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const cancelled = () => resolve(null);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    pending.then(value => {
      if (signal.aborted) dispose?.(value); else resolve(value);
    }, reject).finally(() => signal.removeEventListener("abort", cancelled));
  });
}

/** Private transport: no production listener or admission defaults. */
export function createLiveGateway(options: LiveGatewayOptions) {
  const parseRequest = createLiveGatewayRequestParser(options);
  const publicOrigin = options.publicOrigin;
  const limits = { ...options.limits };
  const names: (keyof LiveGatewayLimits)[] = ["maxConnections", "maxConnectionsPerSession", "maxConnectionsPerPrincipal",
    "maxConnectionsPerGrant", "maxFrameBytes", "maxPendingBytes", "maxPendingFrames", "maxFragments", "maxBufferedChunks",
    "upgradeTimeoutMs", "idleTimeoutMs", "drainTimeoutMs"];
  for (const name of names) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0 ||
      ((name.endsWith("TimeoutMs") || name === "maxFrameBytes" || name === "maxFragments" || name === "maxBufferedChunks") &&
        limits[name] > 2_147_483_647)) throw new TypeError(`Invalid live gateway limit: ${name}.`);
  }
  const resolveNamedSession = options.resolveNamedSession.bind(options);
  const redeem = options.redeem.bind(options);
  const openHostRoute = options.openHostRoute.bind(options);
  const hostReceive: LiveGatewayHostReceiveOptions = Object.freeze({
    maxPayload: limits.maxFrameBytes, maxFragments: limits.maxFragments, maxBufferedChunks: limits.maxBufferedChunks,
    closeTimeout: limits.drainTimeoutMs, perMessageDeflate: false, autoPong: false,
  });
  const wsOptions = {
    ...hostReceive, noServer: true, clientTracking: false, handleProtocols: () => "dohc-live-v1",
  };
  const server = new WebSocketServer(wsOptions);
  const connections = new Map<() => void, () => void>();
  const heldSockets = new WeakSet<Duplex>();
  const counts = new Map<string, number>();
  let closed = false;

  function refuse(socket: Duplex) {
    if (socket.destroyed) return;
    if (socket.writableEnded || !socket.writable) { socket.destroy(); return; }
    socket.once("error", () => socket.destroy());
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
  }
  server.on("wsClientError", (_error, socket) => refuse(socket));

  function reserve(keys: [string, number][]): (() => void) | null {
    if (keys.some(([key, maximum]) => (counts.get(key) ?? 0) >= maximum)) return null;
    for (const [key] of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    return () => {
      for (const [key] of keys) {
        const next = counts.get(key)! - 1;
        if (next === 0) counts.delete(key); else counts.set(key, next);
      }
    };
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const parsed = parseRequest(request);
    if (heldSockets.has(socket)) { socket.destroy(); return; }
    if (!parsed || closed || connections.size >= limits.maxConnections || head.length > limits.maxPendingBytes) {
      refuse(socket); return;
    }
    heldSockets.add(socket);
    socket.pause();
    const abort = new AbortController();
    let browser: WebSocket | undefined;
    let route: LiveGatewayHostRoute | undefined;
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let draining = false;

    function stop() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      abort.abort();
      route?.invalidated.removeEventListener("abort", stop);
      release?.();
      connections.delete(stop);
      // Refusal and fencing discard queued work. No successful frame is synthesized.
      route?.socket.terminate();
      if (browser) browser.terminate(); else refuse(socket);
    }
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, limits.idleTimeoutMs);
      timer.unref();
    };
    connections.set(stop, () => {
      if (!browser) { stop(); return; }
      draining = true;
      clearTimeout(timer);
      timer = setTimeout(stop, limits.drainTimeoutMs);
      timer.unref();
      browser.close(1001);
      route?.socket.close(1001);
    });
    socket.once("close", stop);
    socket.on("error", stop);
    timer = setTimeout(stop, limits.upgradeTimeoutMs);
    timer.unref();

    try {
      const resolved = await untilCancelled(resolveNamedSession(request, parsed.session, abort.signal), abort.signal);
      if (done) return;
      if (resolved === null) { stop(); return; }
      const session = copiedSession(resolved);
      release = reserve([
        [JSON.stringify(["session", session.userId, session.workspaceId, session.grantId, parsed.session]), limits.maxConnectionsPerSession],
        [JSON.stringify(["principal", session.userId]), limits.maxConnectionsPerPrincipal],
        [JSON.stringify(["grant", session.workspaceId, session.grantId]), limits.maxConnectionsPerGrant],
      ]) ?? undefined;
      if (!release) { stop(); return; }
      const redeemed = await untilCancelled(redeem(parsed.ticketToken, session, abort.signal), abort.signal);
      if (done) return;
      if (redeemed === null) { stop(); return; }
      const ticket = parseRedeemedLiveTicket(redeemed);
      if (ticket.audience !== publicOrigin || ticket.authority.principalKind !== "named" ||
        ticket.authority.principalId !== session.userId || ticket.authority.grantId !== session.grantId ||
        ticket.binding.workspaceId !== session.workspaceId) { stop(); return; }
      const identity = JSON.stringify(ticket);
      const opened = await untilCancelled(openHostRoute(parseRedeemedLiveTicket(ticket), abort.signal, hostReceive), abort.signal, late => {
        if (late !== null) {
          late.socket.on("error", () => undefined);
          late.socket.terminate();
        }
      });
      if (opened === null) { stop(); return; }
      if (done) { opened.socket.terminate(); return; }
      route = { ticket: opened.ticket, socket: opened.socket, invalidated: opened.invalidated };
      route.socket.on("error", stop);
      route.socket.once("close", stop);
      if (JSON.stringify(parseRedeemedLiveTicket(route.ticket)) !== identity || route.socket.readyState !== WebSocket.OPEN || !route.socket.isPaused) {
        stop(); return;
      }
      route.socket.binaryType = "nodebuffer";
      route.invalidated.addEventListener("abort", stop, { once: true });
      if (route.invalidated.aborted || done || socket.destroyed || !socket.readable || !socket.writable) { stop(); return; }
      // No asynchronous step may separate this invalidation check from the 101.
      server.handleUpgrade(request, socket, head, accepted => {
        browser = accepted;
        if (done) { accepted.terminate(); return; }
        accepted.binaryType = "nodebuffer";
        const host = route!.socket;
        accepted.on("error", stop);
        accepted.once("close", stop);

        function writer(destination: WebSocket) {
          let pendingBytes = 0;
          let pendingFrames = 0;
          return (data: unknown, pong = false) => {
            if (done || draining) return;
            if (!Buffer.isBuffer(data)) { stop(); return; }
            const size = data.byteLength;
            if ((!pong && (size === 0 || size > limits.maxFrameBytes)) || size > limits.maxPendingBytes - pendingBytes ||
              pendingFrames >= limits.maxPendingFrames || destination.readyState !== WebSocket.OPEN ||
              destination.bufferedAmount > limits.maxPendingBytes - size) { stop(); return; }
            try {
              const bytes = Buffer.from(data);
              pendingBytes += size;
              pendingFrames += 1;
              touch();
              const completed = (error?: Error) => {
                pendingBytes -= size;
                pendingFrames -= 1;
                if (error) stop();
              };
              if (pong) destination.pong(bytes, undefined, completed);
              else destination.send(bytes, { binary: true, compress: false }, completed);
            } catch { stop(); }
          };
        }
        const toBrowser = writer(accepted), toHost = writer(host);
        accepted.on("message", (data, binary) => { if (binary) toHost(data); else stop(); });
        host.on("message", (data, binary) => { if (binary) toBrowser(data); else stop(); });
        accepted.on("ping", data => toBrowser(data, true));
        host.on("ping", data => toHost(data, true));
        touch();
        host.resume();
        socket.resume();
      });
      if (!browser) stop();
    } catch { stop(); }
  }

  return {
    handleUpgrade,
    close() {
      if (closed) return;
      closed = true;
      for (const drain of connections.values()) drain();
      server.close();
    },
  };
}
