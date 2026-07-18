import { Buffer } from "node:buffer";
import { Duplex, PassThrough } from "node:stream";
import type { Envelope, Request } from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import {
  EngineClient,
  DuplexEngineClientConnection,
  EngineFrameError,
  EngineRequestError,
  FrameDecoder,
  FrameType,
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

function helloAck(
  limits: typeof LIMITS = LIMITS,
): Extract<Envelope, { type: "helloAck" }> {
  return {
    type: "helloAck",
    protocolVersion: 1,
    sessionGeneration: 7,
    capabilities: ["core"],
    limits,
  };
}

function event(seq = 1): Extract<Envelope, { type: "event" }> {
  return {
    type: "event",
    seq,
    sessionGeneration: 7,
    name: "workspace.changed",
    payload: { paths: ["note.md"] },
  };
}

function envelopeFrame(
  envelope: Envelope,
  maxFrameBytes = LIMITS.maxFrameBytes,
): Buffer {
  return encodeFrame(
    1,
    0,
    Buffer.from(JSON.stringify(envelope), "utf8"),
    maxFrameBytes,
  );
}

function blobChunkFrame(
  streamId: number,
  bytes: Buffer,
  fin: boolean,
  maxBlobChunkBytes = LIMITS.maxBlobChunkBytes,
): Buffer {
  return encodeFrame(
    FrameType.BlobChunk,
    fin ? 1 : 0,
    { streamId, bytes },
    maxBlobChunkBytes,
  );
}

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
    const frame = envelopeFrame(envelope);
    for (let offset = 0; offset < frame.byteLength; offset += chunkSize) {
      const chunk = frame.subarray(offset, Math.min(frame.byteLength, offset + chunkSize));
      for (const handler of [...this.dataHandlers]) handler(chunk);
    }
  }

  sendRaw(chunk: Buffer): void {
    for (const handler of [...this.dataHandlers]) handler(chunk);
  }

  acknowledge(): void {
    this.send(helloAck());
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

function realStreamClient(connectTimeoutMs = 5_000): {
  transport: EngineClient;
  readable: PassThrough;
} {
  const readable = new PassThrough();
  const writable = new PassThrough();
  writable.resume();
  const duplex = Duplex.from({ readable, writable });
  return {
    transport: new EngineClient(
      new DuplexEngineClientConnection(duplex),
      {
        authToken: "parent-secret",
        protocolVersion: 1,
        capabilities: ["core"],
        connectTimeoutMs,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
    ),
    readable,
  };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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

  it("round-trips ordered multi-chunk BlobChunk frames and preserves FIN", () => {
    const decoder = new FrameDecoder(128, 8);
    const streamId = 0x0001_0203_0405_0607;
    const first = Buffer.from("blob-");
    const second = Buffer.from("bytes");
    const firstFrame = blobChunkFrame(streamId, first, false, 8);
    const finalFrame = blobChunkFrame(streamId, second, true, 8);

    expect(firstFrame[4]).toBe(FrameType.BlobChunk);
    expect(firstFrame[5]).toBe(0);
    expect(finalFrame[5]).toBe(1);
    expect(firstFrame.subarray(12, 20)).toEqual(
      Buffer.from([0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01, 0x00]),
    );

    expect(
      decoder.push(
        Buffer.concat([firstFrame, finalFrame]),
      ),
    ).toEqual([
      { kind: "blobChunk", streamId, fin: false, payload: first },
      { kind: "blobChunk", streamId, fin: true, payload: second },
    ]);
    decoder.finish();
  });

  it("rejects over-limit BlobChunk bytes while encoding and decoding", () => {
    expect(() => blobChunkFrame(9, Buffer.alloc(9), true, 8)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-too-large",
      }),
    );

    const oversized = blobChunkFrame(9, Buffer.alloc(9), true, 9);
    expect(() => new FrameDecoder(128, 8).push(oversized)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-too-large",
      }),
    );
  });

  it("rejects a short BlobChunk payload with a typed error", () => {
    const header = Buffer.alloc(12);
    header.write("DOP1", 0, "ascii");
    header[4] = 2;
    header.writeUInt32LE(7, 8);
    expect(() => new FrameDecoder(128).push(header)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-chunk-missing-stream-id",
      }),
    );
  });
});

describe("EngineClient", () => {
  it("keeps real Duplex.from teardown errors from reaching uncaughtException", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);

    try {
      const explicit = realStreamClient();
      explicit.readable.write(envelopeFrame(helloAck()));
      await explicit.transport.ready();
      explicit.transport.dispose();
      await nextImmediate();

      const timeout = realStreamClient(1);
      await expect(timeout.transport.ready()).rejects.toMatchObject({
        code: "connect-timeout",
      });
      await nextImmediate();

      const exited = realStreamClient();
      exited.readable.write(envelopeFrame(helloAck()));
      await exited.transport.ready();
      exited.transport.notifyProcessExit(17, null);
      await nextImmediate();

      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

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

  it("reassembles BlobChunk frames in order and dispatches only after FIN", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    peer.send({
      type: "blobStart",
      requestId: 4,
      streamId: 27,
      totalBytes: 11,
      sha256: null,
    });

    peer.sendRaw(blobChunkFrame(27, Buffer.from("hello "), false));
    expect(onBlob).not.toHaveBeenCalled();
    peer.sendRaw(blobChunkFrame(27, Buffer.from("world"), true));

    expect(onBlob).toHaveBeenCalledOnce();
    expect(onBlob).toHaveBeenCalledWith({
      requestId: 4,
      streamId: 27,
      totalBytes: 11,
      sha256: null,
      bytes: Buffer.from("hello world"),
    });
    transport.close();
  });

  it("terminally rejects a BlobChunk stream over its announced total", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(5, "await.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 28,
      totalBytes: 4,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(28, Buffer.from("12345"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-too-large" },
    });
  });

  it("terminally rejects a BlobChunk over the negotiated chunk limit", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck({
        ...LIMITS,
        maxBlobChunkBytes: 4,
      }),
    );
    await transport.ready();
    const pending = transport.sendRequest(request(6, "await.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 30,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(30, Buffer.from("12345"), true, 5));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-chunk-too-large" },
    });
  });

  it("terminally rejects a BlobChunk for an unknown stream id", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(6, "await.blob"));
    peer.sendRaw(blobChunkFrame(404, Buffer.from("orphan"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-stream" },
    });
  });

  it("terminally rejects duplicate FIN for a completed BlobChunk stream", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    transport.onBlob(() => undefined);
    peer.send({
      type: "blobStart",
      requestId: 7,
      streamId: 29,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(29, Buffer.from("x"), true));
    const pending = transport.sendRequest(request(7, "after.blob"));
    peer.sendRaw(blobChunkFrame(29, Buffer.alloc(0), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "duplicate-blob-fin" },
    });
  });

  it("does not resurrect or dispatch after a pre-ready error in the same chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    peer.sendRaw(
      Buffer.concat([
        envelopeFrame({
          type: "error",
          error: {
            code: "AUTH_FAILED",
            message: "bad token",
            retry: "no",
          },
        }),
        envelopeFrame(helloAck()),
        envelopeFrame(event()),
      ]),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
    expect(onEvent).not.toHaveBeenCalled();
    await expect(transport.sendRequest(request(1, "after.failure"))).rejects.toMatchObject(
      { code: "closed" },
    );
  });

  it("does not dispatch after a ready connection error in the same chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const pending = transport.sendRequest(request(2, "interrupted"));

    peer.sendRaw(
      Buffer.concat([
        envelopeFrame({
          type: "error",
          error: {
            code: "INTERNAL",
            message: "connection failed",
            retry: "no",
          },
        }),
        envelopeFrame(helloAck()),
        envelopeFrame(event()),
      ]),
    );

    await expect(pending).rejects.toMatchObject({ code: "wire-error" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("unwraps a bounded response and event batch in order", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const operation = transport.sendRequest(request(81, "batched"));

    peer.send({
      type: "batch",
      envelopes: [
        { type: "response", id: wireId, result: "done" },
        event(2),
      ],
    });

    await expect(operation).resolves.toEqual({ id: 81, result: "done" });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(event(2));
    transport.close();
  });

  it("terminally rejects batches over maxBatchLen", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(82, "pending"));
    const envelopes = Array.from(
      { length: LIMITS.maxBatchLen + 1 },
      (_, index): Envelope => event(index + 1),
    );

    peer.send({ type: "batch", envelopes });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
    await expect(transport.sendRequest(request(83, "after.batch"))).rejects.toMatchObject(
      { code: "closed" },
    );
  });

  it("terminally rejects nested batches", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(84, "pending"));

    peer.send({
      type: "batch",
      envelopes: [{ type: "batch", envelopes: [] }],
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
    await expect(transport.sendRequest(request(85, "after.batch"))).rejects.toMatchObject(
      { code: "closed" },
    );
  });

  it("rejects helloAck frame limits below the negotiation floor", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck({
        ...LIMITS,
        maxFrameBytes: 64 * 1024 - 1,
      }),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
    await expect(transport.sendRequest(request(86, "after.ack"))).rejects.toMatchObject(
      { code: "closed" },
    );
  });

  it("rejects an over-limit control frame co-chunked after helloAck", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    const onEvent = vi.fn();
    transport.onEvent(onEvent);
    const ack = helloAck({
      ...LIMITS,
      maxFrameBytes: 64 * 1024,
    });
    const oversizedEvent: Envelope = {
      ...event(),
      payload: { padding: "x".repeat(64 * 1024) },
    };

    peer.sendRaw(
      Buffer.concat([
        envelopeFrame(ack),
        envelopeFrame(oversizedEvent),
      ]),
    );

    await expect(transport.ready()).resolves.toBe(transport);
    expect(onEvent).not.toHaveBeenCalled();
    await expect(transport.sendRequest(request(87, "after.frame"))).rejects.toMatchObject(
      { code: "closed" },
    );
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
