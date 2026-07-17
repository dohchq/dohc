import { Buffer } from "node:buffer";
import type { Envelope, Request } from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import {
  EngineClient,
  EngineFrameError,
  EngineRequestError,
  FrameDecoder,
  encodeFrame,
  type EngineClientConnection,
} from "./engineClient";

const LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxBlobChunkBytes: 64 * 1024,
  maxStringBytes: 64 * 1024,
  maxCollectionLen: 1024,
  maxBatchLen: 64,
  maxJsonDepth: 32,
};

class FakePeerConnection implements EngineClientConnection {
  readonly received: Envelope[] = [];
  onEnvelope: ((envelope: Envelope) => void) | null = null;
  private readonly decoder = new FrameDecoder(LIMITS.maxFrameBytes);
  private readonly dataHandlers = new Set<(chunk: Buffer | Uint8Array) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  private closed = false;

  write(buffer: Buffer): boolean {
    if (this.closed) throw new Error("fake peer is closed");
    for (const frame of this.decoder.push(buffer)) {
      const envelope = JSON.parse(frame.payload.toString("utf8")) as Envelope;
      this.received.push(envelope);
      this.onEnvelope?.(envelope);
    }
    return true;
  }

  send(envelope: Envelope, chunkSize = Number.POSITIVE_INFINITY): void {
    const frame = encodeFrame(
      1,
      0,
      Buffer.from(JSON.stringify(envelope), "utf8"),
      LIMITS.maxFrameBytes,
    );
    for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
      const chunk = frame.subarray(offset, Math.min(frame.byteLength, offset + chunkSize));
      for (const handler of [...this.dataHandlers]) handler(chunk);
    }
  }

  sendRaw(chunk: Buffer): void {
    for (const handler of [...this.dataHandlers]) handler(chunk);
  }

  acknowledge(): void {
    this.send({
      type: "helloAck",
      protocolVersion: 1,
      sessionGeneration: 7,
      capabilities: ["core"],
      limits: LIMITS,
    });
  }

  closeFromPeer(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler();
  }

  failFromPeer(error: unknown): void {
    for (const handler of [...this.errorHandlers]) handler(error);
  }

  onData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.dataHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.errorHandlers.add(handler);
  }

  offData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.dataHandlers.delete(handler);
  }

  offClose(handler: () => void): void {
    this.closeHandlers.delete(handler);
  }

  offError(handler: (error: unknown) => void): void {
    this.errorHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
  }
}

function client(peer: FakePeerConnection): EngineClient {
  return new EngineClient(peer, {
    authToken: "parent-secret",
    protocolVersion: 1,
    capabilities: ["core", "ydoc"],
    connectTimeoutMs: 5_000,
    maxFrameBytes: LIMITS.maxFrameBytes,
  });
}

function request(id: number, method: string): Request {
  return { id, method, params: { method } };
}

describe("R03 frame codec", () => {
  it("round-trips control payloads from zero bytes through the configured boundary", () => {
    const max = 1024;
    for (const payload of [
      Buffer.alloc(0),
      Buffer.from("hello", "utf8"),
      Buffer.alloc(max, 0xa5),
    ]) {
      const decoder = new FrameDecoder(max);
      expect(decoder.push(encodeFrame(1, 0, payload, max))).toEqual([
        { kind: "control", payload },
      ]);
      decoder.finish();
    }

    expect(() => encodeFrame(1, 0, Buffer.alloc(max + 1), max)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "frame-too-large" }),
    );
    const oversized = encodeFrame(1, 0, Buffer.alloc(max + 1), max + 1);
    expect(() => new FrameDecoder(max).push(oversized)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "frame-too-large" }),
    );
  });

  it("decodes a control frame fed one byte at a time", () => {
    const payload = Buffer.from("worst-case chunking", "utf8");
    const encoded = encodeFrame(1, 0, payload, 128);
    const decoder = new FrameDecoder(128);
    const frames = [];
    for (const byte of encoded) frames.push(...decoder.push(Buffer.from([byte])));
    expect(frames).toEqual([{ kind: "control", payload }]);
  });

  it("reports malformed/truncated input with typed errors and stays poisoned", () => {
    const decoder = new FrameDecoder(128);
    const bad = encodeFrame(1, 0, Buffer.from("bad"), 128);
    bad[0] = 0;
    expect(() => decoder.push(bad)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "bad-magic" }),
    );
    expect(() => decoder.push(encodeFrame(1, 0, Buffer.from("good"), 128))).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "bad-magic" }),
    );

    const truncated = new FrameDecoder(128);
    truncated.push(Buffer.from("DOP1"));
    expect(() => truncated.finish()).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "truncated-frame" }),
    );
    expect(() => truncated.push(encodeFrame(1, 0, Buffer.alloc(0), 128))).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "truncated-frame" }),
    );
  });

  it("rejects deferred BlobChunk frames with a typed error", () => {
    const header = Buffer.alloc(12);
    header.write("DOP1", 0, "ascii");
    header[4] = 2;
    header.writeUInt32LE(8, 8);
    expect(() => new FrameDecoder(128).push(header)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({ code: "unsupported-frame" }),
    );
  });
});

describe("EngineClient", () => {
  it("sends hello first and rejects requests until helloAck unblocks it", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    expect(peer.received).toEqual([
      {
        type: "hello",
        protocolVersion: 1,
        authToken: "parent-secret",
        capabilities: ["core", "ydoc"],
        lastSessionGeneration: null,
      },
    ]);
    await expect(transport.sendRequest(request(41, "before.ack"))).rejects.toMatchObject({
      code: "handshake-incomplete",
    });
    peer.acknowledge();
    await expect(transport.ready()).resolves.toBe(transport);
    expect(transport.helloAck?.sessionGeneration).toBe(7);
    transport.close();
  });

  it("correlates concurrent out-of-order responses without crossing logical ids", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const requests: Array<Extract<Envelope, { type: "request" }>> = [];
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") requests.push(envelope);
    };

    const first = transport.sendRequest(request(1001, "first"));
    const second = transport.sendRequest(request(1001, "second-adapter-same-id"));
    expect(requests.map(({ id }) => id)).toEqual([1, 2]);
    peer.send({ type: "response", id: requests[1]!.id, result: "second" });
    peer.send({ type: "response", id: requests[0]!.id, result: "first" });

    await expect(first).resolves.toEqual({ id: 1001, result: "first" });
    await expect(second).resolves.toEqual({ id: 1001, result: "second" });
    transport.close();
  });

  it("rejects a matching wire error with the generated WireError payload", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(55, "missing.method"));
    peer.send({
      type: "error",
      id: wireId,
      error: {
        code: "METHOD_NOT_FOUND",
        message: "method is unavailable",
        retry: "no",
      },
    });
    await expect(operation).rejects.toBeInstanceOf(EngineRequestError);
    await expect(operation).rejects.toMatchObject({
      requestId: 55,
      wireError: { code: "METHOD_NOT_FOUND" },
    });
    transport.close();
  });

  it("dispatches events to multiple subscribers and honors unsubscribe", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = transport.onEvent(first);
    transport.onEvent(second);
    const event = {
      type: "event" as const,
      seq: 1,
      sessionGeneration: 7,
      name: "workspace.changed",
      payload: { paths: ["note.md"] },
    };
    peer.send(event, 1);
    unsubscribe();
    peer.send({ ...event, seq: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("rejects in-flight work when the peer closes or the client is disposed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inFlight = transport.sendRequest(request(9, "slow"));
    peer.closeFromPeer();
    await expect(inFlight).rejects.toMatchObject({
      code: "transport-error",
    });

    const secondPeer = new FakePeerConnection();
    const second = client(secondPeer);
    secondPeer.acknowledge();
    await second.ready();
    const pending = second.sendRequest(request(10, "slow"));
    second.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
  });

  it("turns malformed peer bytes into a terminal typed client failure", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    peer.sendRaw(Buffer.alloc(12));
    await expect(transport.sendRequest(request(1, "after.bad.frame"))).rejects.toMatchObject({
      code: "closed",
    });
  });
});
