import { Buffer } from "node:buffer";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Envelope } from "../ydoc/generated/Envelope";
import type { Request } from "../ydoc/generated/Request";
import { isDaemonReconnectError } from "../live/daemonLiveAdapter";
import {
  EngineClient,
  EngineClientError,
  DuplexEngineClientConnection,
  EngineFrameError,
  EngineRequestDeadlineError,
  EngineRequestError,
  FrameDecoder,
  FrameType,
  encodeFrame,
  type EngineClientConnectOptions,
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
  capabilities: string[] = ["core", "blobs"],
): Extract<Envelope, { type: "helloAck" }> {
  return {
    type: "helloAck",
    protocolVersion: 1,
    sessionGeneration: 7,
    capabilities,
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

function client(
  peer: FakePeerConnection,
  options: Partial<EngineClientConnectOptions> = {},
): EngineClient {
  return new EngineClient(peer, {
    authToken: "parent-secret",
    protocolVersion: 1,
    capabilities: ["core", "ydoc", "blobs"],
    connectTimeoutMs: 5_000,
    maxFrameBytes: LIMITS.maxFrameBytes,
    ...options,
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

describe("a request that cannot be framed", () => {
  it("is refused by name, is not a transport failure, and leaves the session up", async () => {
    // A combined conflict resolution is the request that reaches this size in
    // practice. Before this check it died inside `encodeFrame` and surfaced as
    // `transport-error: Failed to send engine request N` — no limit, no size,
    // and a classification that sends a HEALTHY session into the reconnect
    // machinery for a failure no reconnect can fix.
    //
    // MUTATION: classify it `transport-error` again -> `isDaemonReconnectError`
    // turns true and this fails.
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const requests: Array<Extract<Envelope, { type: "request" }>> = [];
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") requests.push(envelope);
    };

    const refusal = await transport
      .sendRequest({
        id: 1,
        method: "conflicts.resolve",
        params: { local: { mergedText: "x".repeat(LIMITS.maxFrameBytes) } },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(EngineClientError);
    const error = refusal as EngineClientError;
    expect(error.code).toBe("request-too-large");
    expect(error.message).toContain(
      `at most ${LIMITS.maxFrameBytes} encoded bytes`,
    );
    expect(error.message).toMatch(
      /observed \d+ encoded bytes for conflicts\.resolve/,
    );
    // The reconnect machinery must not read this as a daemon that went away.
    expect(isDaemonReconnectError(error)).toBe(false);

    // Nothing was written, and the session is untouched: the next request goes
    // out and is answered.
    expect(requests).toHaveLength(0);
    const answered = transport.sendRequest(request(2, "engine.ping"));
    expect(requests).toHaveLength(1);
    peer.send({ type: "response", id: requests[0]!.id, result: { ok: true } });
    await expect(answered).resolves.toMatchObject({ result: { ok: true } });
    transport.close();
  });
});

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

  it("rejects non-byte BlobChunk flags while encoding", () => {
    for (const flags of [Number.NaN, 0.5, 2 ** 32]) {
      expect(() =>
        encodeFrame(
          FrameType.BlobChunk,
          flags,
          { streamId: 1, bytes: Buffer.alloc(0) },
          8,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<EngineFrameError>>({
          code: "invalid-flags",
        }),
      );
    }
  });

  it("rejects a decoded BlobChunk stream id at 2^53", () => {
    const frame = Buffer.alloc(20);
    frame.write("DOP1", 0, "ascii");
    frame[4] = FrameType.BlobChunk;
    frame.writeUInt32LE(8, 8);
    frame.writeBigUInt64LE(2n ** 53n, 12);

    expect(() => new FrameDecoder(128).push(frame)).toThrowError(
      expect.objectContaining<Partial<EngineFrameError>>({
        code: "blob-stream-id-out-of-range",
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
        capabilities: ["core", "ydoc", "blobs"],
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

  it("cancels the wire request behind a caller id", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const envelopes: Envelope[] = [];
    peer.onEnvelope = (envelope) => envelopes.push(envelope);

    const operation = transport.sendRequest(request(4_242, "slow.open"));
    await transport.cancelRequest(4_242);

    expect(envelopes).toMatchObject([
      { type: "request", id: 1, method: "slow.open" },
      { type: "cancel", id: 1 },
    ]);
    peer.send({
      type: "error",
      id: 1,
      error: {
        code: "CANCELLED",
        message: "request cancelled",
        retry: "no",
      },
    });
    await expect(operation).rejects.toMatchObject({
      wireError: { code: "CANCELLED" },
    });
    transport.close();
  });

  it("times out only the expired request and ignores its late reply", async () => {
    // MUTATION: call fail() from the deadline timer -> the unrelated request and
    // every later request reject because the shared client is closed.
    vi.useFakeTimers();
    try {
      const peer = new FakePeerConnection();
      const transport = client(peer);
      peer.acknowledge();
      await transport.ready();
      const requests: Array<Extract<Envelope, { type: "request" }>> = [];
      peer.onEnvelope = (envelope) => {
        if (envelope.type === "request") requests.push(envelope);
      };

      const expired = transport.sendRequest({
        ...request(55, "silent.method"),
        deadlineMs: 25,
      });
      const unrelated = transport.sendRequest(request(56, "unrelated.method"));
      // Its own class, and still `transport-error`: the request left and
      // nothing came back, so every caller that rebinds on a dropped socket
      // must keep rebinding here. The class is what lets the ONE caller that
      // set the deadline — `ydoc.open` (#616) — tell its own limit firing apart
      // from a socket that died, which a message match cannot do safely.
      const rejection = expect(expired).rejects.toMatchObject({
        name: "EngineRequestDeadlineError",
        code: "transport-error",
        method: "silent.method",
        deadlineMs: 25,
        message:
          "engine-request-deadline-exceeded: request 1 (silent.method) carries " +
          "a deadline of 25 ms and the daemon did not answer inside it.",
      });

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      await expect(expired).rejects.toBeInstanceOf(EngineRequestDeadlineError);
      peer.send({ type: "response", id: requests[0]!.id, result: "late" });
      peer.send({ type: "response", id: requests[1]!.id, result: "unrelated" });
      await expect(unrelated).resolves.toEqual({
        id: 56,
        result: "unrelated",
      });

      const afterTimeout = transport.sendRequest(
        request(57, "after.timeout"),
      );
      peer.send({ type: "response", id: requests[2]!.id, result: "alive" });
      await expect(afterTimeout).resolves.toEqual({ id: 57, result: "alive" });
      transport.close();
    } finally {
      vi.useRealTimers();
    }
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
    void transport.sendRequest(request(4, "blob.reassembly")).catch(() => {});
    peer.send({
      type: "blobStart",
      requestId: 1,
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

  it("maps a completed blob wire request id back to the caller id", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(9_001, "blob.with.adapter.id"));

    peer.send({
      type: "blobStart",
      requestId: wireId,
      streamId: 26,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(26, Buffer.from("x"), true));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 9_001 }),
    );
    peer.send({ type: "response", id: wireId, result: "done" });
    await expect(operation).resolves.toEqual({ id: 9_001, result: "done" });
    transport.close();
  });

  it("preserves the caller id when the response resolves before the final chunk", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    let wireId = 0;
    peer.onEnvelope = (envelope) => {
      if (envelope.type === "request") wireId = envelope.id;
    };
    const operation = transport.sendRequest(request(9_002, "blob.after.response"));

    peer.send({
      type: "blobStart",
      requestId: wireId,
      streamId: 28,
      totalBytes: 1,
      sha256: null,
    });
    peer.send({ type: "response", id: wireId, result: "done" });
    await expect(operation).resolves.toEqual({ id: 9_002, result: "done" });
    peer.sendRaw(blobChunkFrame(28, Buffer.from("x"), true));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 9_002 }),
    );
    transport.close();
  });

  it("rejects blob streams when the session did not negotiate the blobs capability", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(helloAck(LIMITS, ["core"]));
    await transport.ready();
    const pending = transport.sendRequest(request(11, "await.no.capability"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 60,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects blob streams the client did not request even if the ack offers them", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { capabilities: ["core"] });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(15, "await.unrequested"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 62,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol-error" });
  });

  it("rejects a blobStart that references an unknown request", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(16, "await.unknown.request"));
    peer.send({
      type: "blobStart",
      requestId: 99,
      streamId: 63,
      totalBytes: 1,
      sha256: null,
    });

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-request" },
    });
  });

  it("caps buffered chunks across all streams", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(17, "await.global.chunks"));
    const oneByte = Buffer.from("x");
    // Two streams at exactly the per-stream cap (4096 each) fill the global cap
    // (8192); a third stream's FIRST chunk then trips the global check while
    // its own per-stream count is zero.
    for (const streamId of [70, 71, 72]) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: null,
        sha256: null,
      });
    }
    for (const streamId of [70, 71]) {
      const flood: Buffer[] = [];
      for (let i = 0; i < 4096; i++) {
        flood.push(blobChunkFrame(streamId, oneByte, false));
      }
      peer.sendRaw(Buffer.concat(flood));
    }
    peer.sendRaw(blobChunkFrame(72, oneByte, false));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("accepts blob chunks larger than the negotiated control-frame limit", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck({
        ...LIMITS,
        maxFrameBytes: 64 * 1024,
        maxBlobChunkBytes: 256 * 1024,
      }),
    );
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(12, "blob.large.chunk")).catch(() => {});
    // Larger than maxFrameBytes (control-frame bound) but within the blob bound.
    const bytes = Buffer.alloc(100_000, 7);
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 61,
      totalBytes: bytes.length,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(61, bytes, true, 256 * 1024));

    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 61, bytes }),
    );
    transport.close();
  });

  it("aborts decoding the rest of a coalesced buffer when onFrame returns false", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame(FrameType.Control, 0, Buffer.from("{}"));
    const seen = vi.fn(() => false);

    decoder.push(Buffer.concat([frame, frame, frame]), seen);

    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("accepts matching blob SHA-256 and rejects a digest mismatch", async () => {
    const digest =
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const matchingPeer = new FakePeerConnection();
    const matching = client(matchingPeer);
    matchingPeer.acknowledge();
    await matching.ready();
    const onBlob = vi.fn();
    matching.onBlob(onBlob);
    void matching.sendRequest(request(13, "blob.sha.match")).catch(() => {});
    matchingPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 31,
      totalBytes: 5,
      sha256: digest,
    });
    matchingPeer.sendRaw(blobChunkFrame(31, Buffer.from("hello"), true));
    expect(onBlob).toHaveBeenCalledOnce();
    matching.close();

    const mismatchPeer = new FakePeerConnection();
    const mismatch = client(mismatchPeer);
    mismatchPeer.acknowledge();
    await mismatch.ready();
    const pending = mismatch.sendRequest(request(2, "await.bad.blob"));
    mismatchPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 32,
      totalBytes: 5,
      sha256: "0".repeat(64),
    });
    mismatchPeer.sendRaw(blobChunkFrame(32, Buffer.from("hello"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-digest-mismatch" },
    });
  });

  it("clamps a peer's huge blob chunk limit to the client cap", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobChunkBytes: 4 });
    peer.send(
      helloAck({
        ...LIMITS,
        maxBlobChunkBytes: 0xffff_ffff,
      }),
    );
    await transport.ready();
    const pending = transport.sendRequest(request(3, "await.oversized.chunk"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 33,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(33, Buffer.from("12345"), true, 5));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-chunk-too-large" },
    });
  });

  it("rejects a flood of concurrent never-final blob streams", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(4, "await.stream.flood"));

    for (let streamId = 1; streamId <= 65; streamId += 1) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: null,
        sha256: null,
      });
    }

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "too-many-blob-streams" },
    });
  });

  it("enforces a global buffered blob byte budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, { maxBlobBytes: 5 });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(5, "await.blob.backpressure"));
    for (const streamId of [34, 35]) {
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes: 5,
        sha256: null,
      });
    }
    peer.sendRaw(blobChunkFrame(34, Buffer.from("123"), false));
    peer.sendRaw(blobChunkFrame(35, Buffer.from("456"), false));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("caps buffered chunk count per stream to bound tiny-chunk floods", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(7, "await.blob.chunkflood"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 51,
      totalBytes: null,
      sha256: null,
    });
    // One coalesced data event carrying 4097 one-byte chunks — under the byte
    // budget (64MB default) but past the per-stream chunk cap. The inline decode
    // path must halt mid-buffer rather than materialize the whole batch first.
    const oneByte = Buffer.from("x");
    const flood: Buffer[] = [];
    for (let i = 0; i <= 4096; i++) {
      flood.push(blobChunkFrame(51, oneByte, false));
    }
    peer.sendRaw(Buffer.concat(flood));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-backpressure-exceeded" },
    });
  });

  it("drops a failed request's blob streams so a late FIN cannot dispatch", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    const failing = transport.sendRequest(request(18, "await.request.error"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 80,
      totalBytes: 11,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(80, Buffer.from("hello "), false));
    peer.send({
      type: "error",
      id: 1,
      error: { code: "INTERNAL", message: "nope", retry: "no" },
    });
    await expect(failing).rejects.toMatchObject({ code: "wire-error" });

    const witness = transport.sendRequest(request(19, "await.late.fin"));
    peer.sendRaw(blobChunkFrame(80, Buffer.from("world"), true));

    expect(onBlob).not.toHaveBeenCalled();
    await expect(witness).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-stream" },
    });
  });

  it("fails the handshake on malformed helloAck capabilities", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.send(
      helloAck(LIMITS, "not-blobs" as unknown as string[]),
    );

    await expect(transport.ready()).rejects.toMatchObject({
      code: "handshake-failed",
    });
  });

  it("clamps the local chunk cap to the blob budget", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer, {
      maxBlobBytes: 5,
      maxBlobChunkBytes: 1024 * 1024,
    });
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(20, "await.clamped.cap"));
    // 10 bytes exceeds the blob budget (5), so the decode-level bound must trip
    // even though the requested chunk cap was 1 MiB.
    peer.sendRaw(blobChunkFrame(81, Buffer.alloc(10), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-chunk-too-large" },
    });
  });

  it("rejects a duplicate blobStart for a still-active stream", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(6, "await.live.duplicate"));
    const start = {
      type: "blobStart" as const,
      requestId: 1,
      streamId: 36,
      totalBytes: 0,
      sha256: null,
    };
    peer.send(start);
    peer.send(start);
    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "duplicate-blob-stream" },
    });
  });

  it("accepts unique blob stream ids announced out of order", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const onBlob = vi.fn();
    transport.onBlob(onBlob);
    void transport.sendRequest(request(6, "await.out.of.order")).catch(() => {});
    // A higher id announced before a lower one is valid: ids are unique, not
    // ordered. Neither should tear down the session.
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 10,
      totalBytes: 1,
      sha256: null,
    });
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 9,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(10, Buffer.from("a"), true));
    peer.sendRaw(blobChunkFrame(9, Buffer.from("b"), true));

    expect(onBlob).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("rejects invalid and over-limit blobStart totalBytes", async () => {
    // 1.5 is a JSON-representable non-integer (unlike NaN, which serializes to
    // null), so it exercises the invalid-integer guard through the real wire.
    for (const [streamId, totalBytes, code] of [
      [40, -1, "invalid-blob-start"],
      [41, 1.5, "invalid-blob-start"],
      [46, 6, "blob-too-large"],
    ] as const) {
      const peer = new FakePeerConnection();
      const transport = client(peer, { maxBlobBytes: 5 });
      peer.acknowledge();
      await transport.ready();
      const pending = transport.sendRequest(request(8, "await.invalid.start"));
      peer.send({
        type: "blobStart",
        requestId: 1,
        streamId,
        totalBytes,
        sha256: null,
      });
      await expect(pending).rejects.toMatchObject({
        code: "protocol-error",
        cause: { code },
      });
    }
  });

  it("rejects FIN before the announced blob size is reached", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const pending = transport.sendRequest(request(9, "await.short.blob"));
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 49,
      totalBytes: 5,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(49, Buffer.from("1234"), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "blob-size-mismatch" },
    });
  });

  it("rejects empty non-final chunks and accepts an empty final chunk", async () => {
    const emptyPeer = new FakePeerConnection();
    const empty = client(emptyPeer);
    emptyPeer.acknowledge();
    await empty.ready();
    const pending = empty.sendRequest(request(10, "await.empty.chunk"));
    emptyPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 50,
      totalBytes: null,
      sha256: null,
    });
    emptyPeer.sendRaw(blobChunkFrame(50, Buffer.alloc(0), false));
    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "empty-blob-chunk" },
    });

    const finalPeer = new FakePeerConnection();
    const final = client(finalPeer);
    finalPeer.acknowledge();
    await final.ready();
    const onBlob = vi.fn();
    final.onBlob(onBlob);
    void final.sendRequest(request(14, "blob.empty.final")).catch(() => {});
    finalPeer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 51,
      totalBytes: 0,
      sha256: null,
    });
    finalPeer.sendRaw(blobChunkFrame(51, Buffer.alloc(0), true));
    expect(onBlob).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: Buffer.alloc(0) }),
    );
    final.close();
  });

  it("rejects a BlobChunk arriving before helloAck", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.sendRaw(blobChunkFrame(52, Buffer.alloc(0), true));

    await expect(transport.ready()).rejects.toMatchObject({
      code: "protocol-error",
    });
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
    void transport.sendRequest(request(7, "blob.then.finish")).catch(() => {});
    peer.send({
      type: "blobStart",
      requestId: 1,
      streamId: 29,
      totalBytes: 1,
      sha256: null,
    });
    peer.sendRaw(blobChunkFrame(29, Buffer.from("x"), true));
    const pending = transport.sendRequest(request(8, "after.blob"));
    // The completed stream is gone; a late FIN is an unknown stream (fail-closed
    // teardown), with no per-id completed set retained.
    peer.sendRaw(blobChunkFrame(29, Buffer.alloc(0), true));

    await expect(pending).rejects.toMatchObject({
      code: "protocol-error",
      cause: { code: "unknown-blob-stream" },
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
      { code: "handshake-failed", message: expect.stringContaining("is closed") },
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
      { code: "protocol-error", message: expect.stringContaining("is closed") },
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
      { code: "protocol-error", message: expect.stringContaining("is closed") },
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
      { code: "handshake-failed", message: expect.stringContaining("is closed") },
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
      { code: "protocol-error", message: expect.stringContaining("is closed") },
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

  // AUDIT-KILLREC. A client that died because the daemon crashed and a client
  // the desktop deliberately closed are NOT the same condition: the first is a
  // relaunching daemon that callers must retry through (isTransportError gates
  // every rebind path), the second is a shutdown they must not. Reporting a
  // bare "closed" for both made a hard daemon kill abandon a recoverable
  // restart and permanently kill the editor's Y.Doc session.
  it("keeps reporting the transport failure that closed it, not a bare closed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    peer.closeFromPeer();

    await expect(
      transport.sendRequest(request(200, "after.daemon.death")),
    ).rejects.toMatchObject({ code: "transport-error" });
  });

  // The supervisor's wedge kill, on the REAL client. A wedged daemon never
  // exits on its own, so the supervisor kills it — and once this client is
  // closed, `notifyProcessExit` returns early, so the exit that follows can no
  // longer re-cause these rejections. Whatever is recorded here is final.
  it("reports a wedge kill as a transport failure so callers retry the replacement", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    const inFlight = transport.sendRequest(request(300, "wedged.work"));

    transport.closeUnresponsive();

    await expect(inFlight).rejects.toMatchObject({ code: "transport-error" });
    // And the later process exit cannot upgrade it, which is why the cause
    // above has to be right the first time.
    transport.notifyProcessExit(null, "SIGTERM");
    await expect(
      transport.sendRequest(request(301, "after.kill")),
    ).rejects.toMatchObject({ code: "transport-error" });
  });

  // The wedge detector's ONE production input. A daemon draining a large
  // backlog answers no probe — the probe cannot overtake its output queue — so
  // this counter is the only thing that tells the supervisor it is alive. If it
  // never advanced, every busy daemon would be killed as wedged.
  // MUTATION: delete `this.inboundFrames += 1` from receiveFrame and this
  // fails. Nothing else in the suite notices, which is why it is asserted here.
  it("counts every frame it receives, which is what proves a busy daemon alive", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    const beforeWork = transport.inboundActivity();
    const pending = transport.sendRequest(request(400, "bulk.work"));
    const sent = peer.received.at(-1);
    peer.send({
      type: "response",
      id: (sent as { id: number }).id,
      result: "bulk",
    });
    await pending;

    // Traffic for an ordinary caller, not a probe: exactly the frames that
    // arrive while a probe waits its turn behind them.
    expect(transport.inboundActivity()).toBeGreaterThan(beforeWork);
  });

  // A wedge kill cannot be left on the 2-second timer that a deliberate close
  // uses. The supervisor reports the terminal failure immediately afterwards,
  // and the desktop answers that report with a modal; the event loop stops
  // there, so a deferred kill would wait for the user to dismiss it while the
  // wedged child kept running.
  it("forces termination for a wedge kill and defers it for a deliberate close", async () => {
    const forced: Array<boolean | undefined> = [];
    const wedged = new FakePeerConnection();
    const killedNow = new EngineClient(
      wedged,
      {
        authToken: "parent-secret",
        protocolVersion: 1,
        capabilities: ["core"],
        connectTimeoutMs: 5_000,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
      (force) => forced.push(force),
    );
    wedged.acknowledge();
    await killedNow.ready();
    killedNow.closeUnresponsive();

    const shutdown = new FakePeerConnection();
    const closedNormally = new EngineClient(
      shutdown,
      {
        authToken: "parent-secret",
        protocolVersion: 1,
        capabilities: ["core"],
        connectTimeoutMs: 5_000,
        maxFrameBytes: LIMITS.maxFrameBytes,
      },
      (force) => forced.push(force),
    );
    shutdown.acknowledge();
    await closedNormally.ready();
    closedNormally.close();

    // Only the wedge kill forces it. A deliberate close still gets the stdin
    // EOF and the grace period the Rust host needs to drain its actors.
    expect(forced).toEqual([true, false]);
  });

  it("still reports a deliberate close as closed", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();

    transport.close();

    await expect(
      transport.sendRequest(request(201, "after.shutdown")),
    ).rejects.toMatchObject({ code: "closed" });
  });

  it("turns malformed peer bytes into a terminal typed client failure", async () => {
    const peer = new FakePeerConnection();
    const transport = client(peer);
    peer.acknowledge();
    await transport.ready();
    peer.sendRaw(Buffer.alloc(12));
    await expect(transport.sendRequest(request(1, "after.bad.frame"))).rejects.toMatchObject({
      code: "protocol-error",
      message: expect.stringContaining("is closed"),
    });
  });
});
