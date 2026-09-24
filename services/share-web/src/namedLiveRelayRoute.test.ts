import {createServer, type IncomingMessage} from "node:http";
import {once} from "node:events";
import {getCookies} from "better-auth/cookies";
import {WebSocket, WebSocketServer} from "ws";
import {afterEach, expect, it} from "vitest";
import {createNamedLiveRelayRoute, namedLiveGatewayRequest} from "./namedLiveRelayRoute";

const origin = "https://share.example.test", token = "ab".repeat(32), discriminator = "abcdefghijkl";
const cookieName = getCookies({baseURL: origin}).sessionToken.name;
const receive = {maxPayload: 1024, maxFragments: 8, maxBufferedChunks: 8, closeTimeout: 100, perMessageDeflate: false as const, autoPong: false as const};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0).reverse()) await cleanup();});
function request(cookie = `${cookieName}=account-secret; link-secret=not-forwarded`): IncomingMessage {
  return {rawHeaders: ["Host", "share.example.test", "Origin", origin, "Cookie", cookie]} as IncomingMessage;
}

async function fixture(reject = false) {
  const server = createServer(), accepted = new WebSocketServer({noServer: true, perMessageDeflate: false, handleProtocols: () => "dohc-live-v1"});
  let input: IncomingMessage | undefined;
  const sockets = new Set<WebSocket>();
  server.on("upgrade", (incoming, socket, head) => {
    input = incoming;
    if (reject) {socket.end("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;}
    accepted.handleUpgrade(incoming, socket, head, ws => {
      sockets.add(ws); ws.on("error", () => {});
      ws.send(Buffer.from("early host frame"));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => accepted.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const relayUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const open = createNamedLiveRelayRoute({relayUrl, publicOrigin: origin, exchangeKey: "x".repeat(32), handshakeTimeoutMs: 10_000});
  return {open, input: () => input, sockets};
}

it("passes only account credentials and preserves early binary data until the gateway resumes", async () => {
  const f = await fixture(), abort = new AbortController();
  const route = await f.open({request: request(), discriminator, ticketToken: token}, abort.signal, receive);
  expect(route).not.toBeNull();
  if (!route) throw new Error("Expected route.");
  expect(f.input()!.url).toBe(`/sync/live/named?session=${discriminator}`);
  expect(f.input()!.headers).toMatchObject({origin, cookie: `${cookieName}=account-secret`, "x-dohc-relay-exchange-key": "x".repeat(32)});
  expect(f.input()!.headers["sec-websocket-protocol"]).toBe(`dohc-live-v1,dohc-live-ticket.${token}`);
  expect(route.socket.isPaused).toBe(true);
  const message = once(route.socket, "message");
  route.socket.resume();
  expect((await message)[0]).toEqual(Buffer.from("early host frame"));
  const closed = once(route.socket, "close");
  abort.abort(); await closed;
  expect(route.invalidated.aborted).toBe(true);
});

it("refuses upstream redirects and already-cancelled acquisition", async () => {
  const f = await fixture(true), abort = new AbortController();
  expect(await f.open({request: request(), discriminator, ticketToken: token}, abort.signal, receive)).toBeNull();
  abort.abort();
  expect(await f.open({request: request(), discriminator, ticketToken: token}, abort.signal, receive)).toBeNull();
});

it("refuses anonymous and ambiguous account cookies before creating an upstream socket", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  for (const value of [request("link-secret=only"), request(`${cookieName}=one; ${cookieName}=two`),
    {rawHeaders: ["Cookie", `${cookieName}=one`, "Cookie", `${cookieName}=two`]} as IncomingMessage]) {
    expect(namedLiveGatewayRequest(value, origin, signal)).toBeNull();
    expect(await f.open({request: value, discriminator, ticketToken: token}, signal, receive)).toBeNull();
  }
  expect(f.input()).toBeUndefined();
});
