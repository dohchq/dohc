import type {IncomingMessage} from "node:http";
import {WebSocket} from "ws";
import type {LiveGatewayOptions, LiveGatewayHostRoute} from "./liveGateway";
import {namedAccountCookie} from "./namedAccountCookie";

export function namedLiveGatewayRequest(request: IncomingMessage, publicOrigin: string, signal: AbortSignal): Request | null {
  const cookies: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === "cookie") cookies.push(request.rawHeaders[index + 1]!);
  }
  if (cookies.length !== 1) return null;
  const cookie = namedAccountCookie(cookies[0]!, publicOrigin);
  if (!cookie) return null;
  return new Request(new URL("/api/live", publicOrigin), {signal, headers: {cookie, origin: publicOrigin, host: new URL(publicOrigin).host}});
}

/** Only the configured relay can redeem the token and admit this paused socket. */
export function createNamedLiveRelayRoute(options: {
  relayUrl: string; publicOrigin: string; exchangeKey: string; handshakeTimeoutMs: number;
}): LiveGatewayOptions["openHostRoute"] {
  const relay = new URL(options.relayUrl), origin = new URL(options.publicOrigin);
  if (!["http:", "https:"].includes(relay.protocol) || relay.username || relay.password || relay.search || relay.hash ||
    origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32 ||
    !Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs < 1 || options.handshakeTimeoutMs > 2_147_483_647) {
    throw new TypeError("Invalid named relay route configuration.");
  }
  return (input, signal, receive) => new Promise<LiveGatewayHostRoute | null>(resolve => {
    const request = namedLiveGatewayRequest(input.request, options.publicOrigin, signal);
    if (!request || signal.aborted) {resolve(null); return;}
    const url = new URL("/sync/live/named", relay);
    url.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("session", input.discriminator);
    const invalidated = new AbortController();
    let socket: WebSocket;
    let settled = false;
    const finish = (route: LiveGatewayHostRoute | null) => {if (!settled) {settled = true; resolve(route);}};
    const stop = () => {invalidated.abort(); socket?.terminate(); finish(null);};
    try {
      socket = new WebSocket(url, ["dohc-live-v1", `dohc-live-ticket.${input.ticketToken}`], {
        ...receive, followRedirects: false, handshakeTimeout: options.handshakeTimeoutMs,
        headers: {origin: options.publicOrigin, cookie: request.headers.get("cookie")!, "x-dohc-relay-exchange-key": options.exchangeKey},
      });
      socket.on("error", stop);
      socket.once("close", () => {invalidated.abort(); signal.removeEventListener("abort", stop); finish(null);});
      socket.once("unexpected-response", (_request, response) => {response.destroy(); stop();});
      signal.addEventListener("abort", stop, {once: true});
      if (signal.aborted) {stop(); return;}
      socket.once("open", () => {
        socket.pause();
        if (signal.aborted || socket.protocol !== "dohc-live-v1" || socket.extensions) {stop(); return;}
        finish({socket, invalidated: invalidated.signal});
      });
    } catch {stop();}
  });
}
