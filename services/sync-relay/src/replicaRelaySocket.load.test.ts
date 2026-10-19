import {EventEmitter} from "node:events";
import {Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {serveReplicaRelay} from "./replicaRelaySocket";
import type {Server} from "node:http";
import type {ReplicaReadLease} from "./replicaReadPrincipal";

type Handler = (incoming: {method: string; url: string; headers: Record<string, string>}, outgoing: Writable) => Promise<void>;
const mock = vi.hoisted(() => ({handler: undefined as Handler | undefined, server: undefined as (Pick<Server, "maxConnections"> & {setTimeout: ReturnType<typeof vi.fn>}) | undefined}));
vi.mock("node:fs/promises", () => ({chmod: async () => {}}));
vi.mock("node:http", async original => ({...await original<typeof import("node:http")>(),
  createServer: (_: unknown, handler: Handler) => {
    mock.handler = handler;
    mock.server = Object.assign(new EventEmitter(), {maxConnections: 0, listen: (_: unknown, done: () => void) => done(),
      close: (done: () => void) => done(), closeAllConnections: () => {}, setTimeout: vi.fn()});
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
  const serving = mock.handler!({method: "GET", url: "/sync/w/bootstrap", headers: {authorization: "Bearer lease"}}, outgoing);
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
  try {expect(mock.server!.maxConnections).toBeGreaterThan(1); expect(mock.server!.maxConnections).toBeLessThanOrEqual(8);}
  finally {await socket.close();}
});
it("sets a send/idle timeout for a child that stops reading", async () => {
  const socket = await serveReplicaRelay("private", {bearer: "lease"} as ReplicaReadLease, async () => new Response());
  try {expect(mock.server!.setTimeout).toHaveBeenCalledWith(10_000, expect.any(Function));}
  finally {await socket.close();}
});
