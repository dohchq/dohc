import {createServer, type IncomingMessage} from "node:http";
import {once} from "node:events";
import {WebSocketServer, type WebSocket} from "ws";
import {afterEach, expect, it} from "vitest";
import {connectOwnerLiveTransport} from "./ownerLiveTransport";

const cleanups: (() => void)[] = [];
afterEach(() => {for (const close of cleanups.splice(0)) close();});
async function fixture(refused = false) {
  const server = createServer(), sockets = new WebSocketServer({noServer: true}), controller = new AbortController();
  const requests: IncomingMessage[] = [];
  let peer!: WebSocket;
  server.on("upgrade", (request, socket, head) => {
    requests.push(request);
    if (refused) {socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); return;}
    sockets.handleUpgrade(request, socket, head, accepted => {peer = accepted; sockets.emit("connection", accepted, request);});
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test address");
  cleanups.push(() => {controller.abort(); for (const client of sockets.clients) client.terminate(); sockets.close(); server.close();});
  return {url: new URL(`ws://127.0.0.1:${address.port}/sync/workspaces/workspace/live/owner?shareId=share`), controller, requests, peer: () => peer};
}

it("sends the owner bearer only as a header and exchanges ordered binary frames", async () => {
  const f = await fixture(), received: Uint8Array[] = [];
  let receivedFrame!: () => void;
  const incoming = new Promise<void>(resolve => {receivedFrame = resolve;});
  const transport = await connectOwnerLiveTransport({url: f.url, bearer: "owner-bearer", maxFrameBytes: 1024, signal: f.controller.signal,
    receive: bytes => {received.push(bytes.slice()); receivedFrame();}, closed() {}});
  const request = f.requests[0]!;
  expect(request.headers.authorization).toBe("Bearer owner-bearer");
  expect(request.headers["sec-websocket-protocol"]).toBe("dohc-live-v1");
  expect(request.url).not.toContain("owner-bearer"); expect(request.headers.cookie).toBeUndefined();
  const sent = once(f.peer(), "message"); await transport.send(new Uint8Array([1,2,3]));
  expect((await sent)[0]).toEqual(Buffer.from([1,2,3]));
  f.peer().send(Buffer.from([4,5])); await incoming;
  expect(received.map(bytes => [...bytes])).toEqual([[4,5]]); transport.close();
});

it("rejects404 upgrades without credentials in a retry URL", async () => {
  const f = await fixture(true);
  await expect(connectOwnerLiveTransport({url: f.url, bearer: "owner-bearer", maxFrameBytes: 1024, signal: f.controller.signal, receive() {}, closed() {}})).rejects.toThrow();
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.url).not.toContain("owner-bearer");
});

it("closes on text frames and an aborted send cannot report success", async () => {
  const f = await fixture(); let closed!: () => void;
  const stopped = new Promise<void>(resolve => {closed = resolve;});
  const transport = await connectOwnerLiveTransport({url: f.url, bearer: "owner-bearer", maxFrameBytes: 1024, signal: f.controller.signal,
    receive() {throw new Error("Text must not reach binary consumer");}, closed});
  f.peer().send("invalid text"); await stopped;
  await expect(transport.send(new Uint8Array([1]))).rejects.toThrow();
});
