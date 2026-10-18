import {EventEmitter} from "node:events";
import {Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {serveReplicaRelay} from "./replicaRelaySocket";
import type {ReplicaReadLease} from "./replicaReadPrincipal";

const mock = vi.hoisted(() => ({handler: undefined as any, server: undefined as any}));
vi.mock("node:fs/promises", () => ({chmod: async () => {}}));
vi.mock("node:http", async original => ({...await original<typeof import("node:http")>(),
  createServer: (_: unknown, handler: unknown) => {
    mock.handler = handler;
    mock.server = Object.assign(new EventEmitter(), {listen: (_: unknown, done: () => void) => done(),
      close: (done: () => void) => done(), closeAllConnections: () => {}});
    return mock.server;
  },
}));
it("streams a response without collecting its body", async () => {
  const lease = {bearer: "lease"} as ReplicaReadLease;
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({start(controller) {
    source = controller; controller.enqueue(Buffer.from("streamed "));
  }}));
  const buffered = vi.spyOn(response, "arrayBuffer").mockRejectedValue(Error("must stream"));
  const socket = await serveReplicaRelay("private", lease, async () => response);
  const chunks: Buffer[] = [];
  let wrote!: () => void;
  const first = new Promise<void>(resolve => {wrote = resolve;});
  const outgoing = Object.assign(new Writable({write(chunk, _, done) {chunks.push(Buffer.from(chunk)); wrote(); done();}}),
    {setHeader() {}, writeHead() {}, headersSent: false});
  const ended = new Promise<never>((_, reject) => outgoing.once("finish", () => reject(Error("response ended before streaming"))));
  const serving = mock.handler({method: "GET", url: "/sync/w/bootstrap", headers: {authorization: "Bearer lease"}}, outgoing);
  try {
    await Promise.race([first, ended]);
    expect(Buffer.concat(chunks).toString()).toBe("streamed ");
    source.enqueue(Buffer.from("bytes")); source.close();
    await serving;
    expect(Buffer.concat(chunks).toString()).toBe("streamed bytes");
    expect(buffered).not.toHaveBeenCalled();
  } finally {source.error(Error("test finished")); await serving; await socket.close();}
});
it("caps connections above the child's serial request pattern", async () => {
  const socket = await serveReplicaRelay("private", {bearer: "lease"} as ReplicaReadLease, async () => new Response());
  try {expect(mock.server.maxConnections).toBeGreaterThan(1); expect(mock.server.maxConnections).toBeLessThanOrEqual(8);}
  finally {await socket.close();}
});
