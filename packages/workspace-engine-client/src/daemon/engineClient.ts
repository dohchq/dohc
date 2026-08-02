// R13b transport for the opt-in Rust workspace-engine sidecar. The shipping
// desktop launches it only behind the temporary migration flag; real workspace
// consumers remain on the TypeScript engine until the atomic cutover.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import type { BlobStart } from "../ydoc/generated/BlobStart";
import type { Envelope } from "../ydoc/generated/Envelope";
import type { Event } from "../ydoc/generated/Event";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { WireError } from "../ydoc/generated/WireError";
import type { EngineTransport } from "../ydoc/ydocLiveAdapter";

const FRAME_MAGIC = Buffer.from("DOP1", "ascii");
const FRAME_HEADER_BYTES = 12;
const BLOB_STREAM_ID_BYTES = 8;
const BLOB_FIN_FLAG = 0b0000_0001;
const MAX_U32 = 0xffff_ffff;
const MAX_WIRE_INTEGER = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BLOB_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_BLOB_STREAMS = 64;
// Global cap on retained chunk Buffers across all streams, so tiny-chunk floods
// spread over many streams cannot amplify object overhead past the byte budget.
const MAX_BUFFERED_BLOB_CHUNKS = 8192;
// Bounds retained per-chunk object overhead so a tiny-chunk flood cannot amplify
// memory past the byte budget. A max-size blob at the default chunk size is ~256
// chunks, so this leaves ample headroom for legitimate chunking.
const MAX_BLOB_CHUNKS_PER_STREAM = 4096;
// Blob streaming gates on this negotiated hello/helloAck capability, never on
// frame sniffing (ENGINE_PROTOCOL.md row 13).
const BLOB_CAPABILITY = "blobs";
// Leaves headroom for handshake and small control envelopes.
const MIN_NEGOTIABLE_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const ENGINE_AUTH_TOKEN_ENV = "DOHC_ENGINE_AUTH_TOKEN";

export const enum FrameType {
  Control = 1,
  BlobChunk = 2,
}

export type Frame =
  | { kind: "control"; payload: Buffer }
  | { kind: "blobChunk"; streamId: number; fin: boolean; payload: Buffer };

export interface BlobChunkPayload {
  readonly streamId: number;
  readonly bytes: Buffer;
}

export type FrameCodecErrorCode =
  | "bad-magic"
  | "blob-chunk-missing-stream-id"
  | "blob-chunk-too-large"
  | "blob-stream-id-out-of-range"
  | "frame-too-large"
  | "invalid-flags"
  | "non-zero-reserved"
  | "truncated-frame"
  | "unknown-frame-type";

export class FrameCodecError extends Error {
  readonly code: FrameCodecErrorCode;

  constructor(code: FrameCodecErrorCode, message: string) {
    super(message);
    this.name = "FrameCodecError";
    this.code = code;
  }
}

export function encodeFrame(
  type: FrameType.Control,
  flags: number,
  payload: Buffer,
  maxFrameBytes?: number,
): Buffer;
export function encodeFrame(
  type: FrameType.BlobChunk,
  flags: number,
  payload: BlobChunkPayload,
  maxBlobChunkBytes?: number,
): Buffer;
export function encodeFrame(
  type: FrameType,
  flags: number,
  payload: Buffer | BlobChunkPayload,
  maxPayloadBytes?: number,
): Buffer {
  const payloadLimit =
    maxPayloadBytes ??
    (type === FrameType.BlobChunk
      ? DEFAULT_MAX_BLOB_CHUNK_BYTES
      : DEFAULT_MAX_FRAME_BYTES);
  if (
    !Number.isSafeInteger(payloadLimit) ||
    payloadLimit < 0 ||
    payloadLimit > MAX_U32
  ) {
    throw new FrameCodecError(
      "frame-too-large",
      "Maximum frame bytes must be an unsigned 32-bit integer.",
    );
  }
  if (type === FrameType.BlobChunk) {
    if (Buffer.isBuffer(payload)) {
      throw new FrameCodecError(
        "blob-chunk-missing-stream-id",
        "BlobChunk encoding requires a stream id and raw bytes.",
      );
    }
    if (
      !Number.isSafeInteger(payload.streamId) ||
      payload.streamId < 0 ||
      payload.streamId > MAX_WIRE_INTEGER
    ) {
      throw new FrameCodecError(
        "blob-stream-id-out-of-range",
        "BlobChunk stream id must be a non-negative wire integer.",
      );
    }
    if (flags !== 0 && flags !== BLOB_FIN_FLAG) {
      throw new FrameCodecError(
        "invalid-flags",
        "BlobChunk frames only support the FIN flag.",
      );
    }
    if (payload.bytes.length > payloadLimit) {
      throw new FrameCodecError(
        "blob-chunk-too-large",
        `Blob chunk is ${payload.bytes.length} bytes; maximum is ${payloadLimit}.`,
      );
    }
    const payloadLength = BLOB_STREAM_ID_BYTES + payload.bytes.length;
    if (payloadLength > MAX_U32) {
      throw new FrameCodecError(
        "frame-too-large",
        `BlobChunk frame payload is ${payloadLength} bytes; maximum is ${MAX_U32}.`,
      );
    }
    const frame = beginFrame(type, flags, payloadLength);
    frame.writeBigUInt64LE(BigInt(payload.streamId), FRAME_HEADER_BYTES);
    payload.bytes.copy(frame, FRAME_HEADER_BYTES + BLOB_STREAM_ID_BYTES);
    return frame;
  }
  if (type !== FrameType.Control) {
    throw new FrameCodecError("unknown-frame-type", `Unknown frame type: ${type}.`);
  }
  if (flags !== 0) {
    throw new FrameCodecError(
      "invalid-flags",
      "Control frames must have zero flags.",
    );
  }
  if (!Buffer.isBuffer(payload)) {
    throw new FrameCodecError(
      "truncated-frame",
      "Control frame payload must be a Buffer.",
    );
  }
  if (payload.length > payloadLimit || payload.length > MAX_U32) {
    throw new FrameCodecError(
      "frame-too-large",
      `Control frame payload is ${payload.length} bytes; maximum is ${payloadLimit}.`,
    );
  }

  const frame = beginFrame(type, flags, payload.length);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

function beginFrame(type: FrameType, flags: number, payloadLength: number): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payloadLength);
  FRAME_MAGIC.copy(frame, 0);
  frame[4] = type;
  frame[5] = flags;
  frame.writeUInt16LE(0, 6);
  frame.writeUInt32LE(payloadLength, 8);
  return frame;
}

export class FrameDecoder {
  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  private frameType: FrameType | null = null;
  private frameFlags = 0;
  private poisoned: FrameCodecError | null = null;

  constructor(
    private maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    private maxBlobChunkBytes = DEFAULT_MAX_BLOB_CHUNK_BYTES,
  ) {
    this.assertValidLimit(maxFrameBytes);
    this.assertValidLimit(maxBlobChunkBytes);
  }

  setMaxFrameBytes(maxFrameBytes: number): void {
    this.assertHealthy();
    this.assertValidLimit(maxFrameBytes);
    this.maxFrameBytes = maxFrameBytes;
  }

  setLimits(maxFrameBytes: number, maxBlobChunkBytes: number): void {
    this.assertHealthy();
    this.assertValidLimit(maxFrameBytes);
    this.assertValidLimit(maxBlobChunkBytes);
    this.maxFrameBytes = maxFrameBytes;
    this.maxBlobChunkBytes = maxBlobChunkBytes;
  }

  // onFrame lets the caller process each frame inline as it is decoded, so a
  // per-stream cap can halt a coalesced flood mid-buffer instead of letting the
  // whole batch materialize first. It is invoked OUTSIDE the decode try/catch so
  // a consumer error propagates verbatim rather than being poisoned into a
  // generic codec error. Returning false aborts decoding of the remaining bytes
  // (used when the client closes mid-buffer; the tail is discarded).
  push(chunk: Uint8Array, onFrame?: (frame: Frame) => boolean | void): Frame[] {
    this.assertHealthy();
    const frames: Frame[] = [];
    let aborted = false;
    const emit = (frame: Frame): void => {
      if (onFrame) aborted = onFrame(frame) === false;
      else frames.push(frame);
    };
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      let frame: Frame | null = null;
      try {
        if (this.headerBytes < FRAME_HEADER_BYTES) {
          const count = Math.min(
            FRAME_HEADER_BYTES - this.headerBytes,
            bytes.length - offset,
          );
          bytes.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes < FRAME_HEADER_BYTES) break;
          this.beginPayload();
          if (this.payload?.length === 0) {
            frame = this.completeFrame();
            this.resetFrame();
          }
        }

        if (frame === null && this.payload !== null && this.payload.length > 0) {
          const count = Math.min(
            this.payload.length - this.payloadBytes,
            bytes.length - offset,
          );
          bytes.copy(this.payload, this.payloadBytes, offset, offset + count);
          this.payloadBytes += count;
          offset += count;
          if (this.payloadBytes === this.payload.length) {
            frame = this.completeFrame();
            this.resetFrame();
          }
        }
      } catch (error) {
        throw this.poison(error);
      }
      if (frame !== null) {
        emit(frame);
        if (aborted) break;
      }
    }
    return frames;
  }

  finish(): Frame[] {
    this.assertHealthy();
    if (this.headerBytes === 0 && this.payload === null) return [];
    throw this.poison(
      new FrameCodecError(
        "truncated-frame",
        "Transport ended in the middle of a frame.",
      ),
    );
  }

  private beginPayload(): void {
    if (!this.header.subarray(0, 4).equals(FRAME_MAGIC)) {
      throw new FrameCodecError("bad-magic", "Frame magic is not DOP1.");
    }
    const type = this.header[4];
    const flags = this.header[5];
    if (this.header.readUInt16LE(6) !== 0) {
      throw new FrameCodecError(
        "non-zero-reserved",
        "Frame reserved bytes must be zero.",
      );
    }
    if (type !== FrameType.Control && type !== FrameType.BlobChunk) {
      throw new FrameCodecError(
        "unknown-frame-type",
        `Unknown frame type: ${type}.`,
      );
    }
    const payloadLength = this.header.readUInt32LE(8);
    if (type === FrameType.Control) {
      if (flags !== 0) {
        throw new FrameCodecError(
          "invalid-flags",
          "Control frames must have zero flags.",
        );
      }
      if (payloadLength > this.maxFrameBytes) {
        throw new FrameCodecError(
          "frame-too-large",
          `Control frame payload is ${payloadLength} bytes; maximum is ${this.maxFrameBytes}.`,
        );
      }
    } else {
      if ((flags & ~BLOB_FIN_FLAG) !== 0) {
        throw new FrameCodecError(
          "invalid-flags",
          "BlobChunk frames only support the FIN flag.",
        );
      }
      if (payloadLength < BLOB_STREAM_ID_BYTES) {
        throw new FrameCodecError(
          "blob-chunk-missing-stream-id",
          `BlobChunk payload is ${payloadLength} bytes; stream id requires ${BLOB_STREAM_ID_BYTES}.`,
        );
      }
      const chunkBytes = payloadLength - BLOB_STREAM_ID_BYTES;
      if (chunkBytes > this.maxBlobChunkBytes) {
        throw new FrameCodecError(
          "blob-chunk-too-large",
          `Blob chunk is ${chunkBytes} bytes; maximum is ${this.maxBlobChunkBytes}.`,
        );
      }
    }
    // Header-derived bounds are now proven, so this is the first point at
    // which allocating the peer-advertised payload is safe.
    this.payload = Buffer.allocUnsafe(payloadLength);
    this.payloadBytes = 0;
    this.frameType = type;
    this.frameFlags = flags;
  }

  private completeFrame(): Frame {
    if (this.payload === null || this.frameType === null) {
      throw new FrameCodecError("truncated-frame", "Frame payload is incomplete.");
    }
    if (this.frameType === FrameType.Control) {
      return { kind: "control", payload: this.payload };
    }
    const streamId = this.payload.readBigUInt64LE(0);
    if (streamId > BigInt(MAX_WIRE_INTEGER)) {
      throw new FrameCodecError(
        "blob-stream-id-out-of-range",
        "BlobChunk stream id exceeds the wire-integer bound.",
      );
    }
    return {
      kind: "blobChunk",
      streamId: Number(streamId),
      fin: (this.frameFlags & BLOB_FIN_FLAG) !== 0,
      payload: this.payload.subarray(BLOB_STREAM_ID_BYTES),
    };
  }

  private assertHealthy(): void {
    if (this.poisoned) throw this.poisoned;
  }

  private poison(error: unknown): FrameCodecError {
    if (this.poisoned) return this.poisoned;
    this.poisoned =
      error instanceof FrameCodecError
        ? error
        : new FrameCodecError("truncated-frame", "Frame decoding failed.");
    this.resetFrame();
    return this.poisoned;
  }

  private resetFrame(): void {
    this.headerBytes = 0;
    this.payload = null;
    this.payloadBytes = 0;
    this.frameType = null;
    this.frameFlags = 0;
  }

  private assertValidLimit(maxFrameBytes: number): void {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 0 ||
      maxFrameBytes > MAX_U32
    ) {
      throw new FrameCodecError(
        "frame-too-large",
        "Maximum frame bytes must be an unsigned 32-bit integer.",
      );
    }
  }
}

export { FrameCodecError as EngineFrameError };

export type EngineClientErrorCode =
  | "closed"
  | "connect-timeout"
  | "handshake-incomplete"
  | "handshake-failed"
  | "protocol-error"
  | "request-too-large"
  | "transport-error"
  | "wire-error";

export class EngineClientError extends Error {
  readonly code: EngineClientErrorCode;
  readonly wireError?: WireError;
  override readonly cause?: unknown;

  constructor(
    code: EngineClientErrorCode,
    message: string,
    options?: { cause?: unknown; wireError?: WireError },
  ) {
    super(message);
    this.name = "EngineClientError";
    this.code = code;
    this.cause = options?.cause;
    this.wireError = options?.wireError;
  }
}

export class EngineRequestError extends EngineClientError {
  readonly requestId: number;

  constructor(requestId: number, wireError: WireError) {
    super("wire-error", wireError.message, { wireError });
    this.name = "EngineRequestError";
    this.requestId = requestId;
  }
}

export type BlobStreamErrorCode =
  | "blob-backpressure-exceeded"
  | "blob-digest-mismatch"
  | "blob-size-mismatch"
  | "blob-too-large"
  | "duplicate-blob-stream"
  | "empty-blob-chunk"
  | "invalid-blob-start"
  | "too-many-blob-streams"
  | "unknown-blob-request"
  | "unknown-blob-stream";

export class BlobStreamError extends Error {
  readonly code: BlobStreamErrorCode;

  constructor(code: BlobStreamErrorCode, message: string) {
    super(message);
    this.name = "BlobStreamError";
    this.code = code;
  }
}

export type CompletedBlob = BlobStart & { readonly bytes: Buffer };

export interface EngineClientSpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  authToken: string;
  protocolVersion: number;
  capabilities: string[];
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  maxBlobChunkBytes?: number;
  maxBlobBytes?: number;
  signal?: AbortSignal;
  onStderr?: (text: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export interface EngineClientConnectOptions {
  authToken: string;
  protocolVersion: number;
  capabilities: string[];
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  maxBlobChunkBytes?: number;
  maxBlobBytes?: number;
}

export interface EngineClientConnection {
  write(buffer: Buffer): boolean;
  onData(handler: (chunk: Buffer | Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  offData(handler: (chunk: Buffer | Uint8Array) => void): void;
  offClose(handler: () => void): void;
  offError(handler: (error: unknown) => void): void;
  close(): void;
}

interface PendingRequest {
  readonly callerId: number;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: EngineClientError) => void;
  readonly deadlineTimer?: ReturnType<typeof setTimeout>;
}

interface PendingBlob {
  readonly start: BlobStart;
  // Captured when the stream is announced so response/chunk ordering cannot
  // change the blob's request identity after resolveResponse clears pending.
  readonly callerRequestId: number;
  readonly chunks: Buffer[];
  receivedBytes: number;
}

type HelloAckEnvelope = Extract<Envelope, { type: "helloAck" }>;

export class EngineClient implements EngineTransport {
  private readonly decoder: FrameDecoder;
  private readonly eventHandlers = new Set<(event: Event) => void>();
  private readonly blobHandlers = new Set<(blob: CompletedBlob) => void>();
  private readonly blobStreams = new Map<number, PendingBlob>();
  private bufferedBlobChunks = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly abandonedRequestIds = new Set<number>();
  private readonly abandonedBlobStreamIds = new Set<number>();
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });
  private readonly readyPromise: Promise<EngineClient>;
  private readyResolve!: (client: EngineClient) => void;
  private readyReject!: (error: EngineClientError) => void;
  private nextRequestId = 1;
  private readyState = false;
  private closed = false;
  // WHY the client closed, kept for every request that arrives afterwards. A
  // client whose transport died is a relaunching daemon (retriable); a client
  // the caller closed is not. Reporting a bare "closed" for both made callers
  // abandon a recoverable restart.
  private closeCause: EngineClientError | null = null;
  private maxFrameBytes: number;
  private maxBlobChunkBytes: number;
  private readonly maxBlobChunkBytesCap: number;
  private readonly maxBlobBytes: number;
  private bufferedBlobBytes = 0;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  helloAck: HelloAckEnvelope | undefined;
  private inboundFrames = 0;

  constructor(
    private readonly connection: EngineClientConnection,
    private readonly connectOptions: EngineClientConnectOptions,
    private readonly terminate: (force?: boolean) => void = () =>
      connection.close(),
    private readonly termination: Promise<void> = Promise.resolve(),
  ) {
    this.maxFrameBytes =
      connectOptions.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxBlobChunkBytesCap =
      connectOptions.maxBlobChunkBytes ?? DEFAULT_MAX_BLOB_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(this.maxBlobChunkBytesCap) ||
      this.maxBlobChunkBytesCap < 0 ||
      this.maxBlobChunkBytesCap > MAX_U32
    ) {
      throw new FrameCodecError(
        "blob-chunk-too-large",
        "Maximum blob chunk bytes must be an unsigned 32-bit integer.",
      );
    }
    this.maxBlobBytes = connectOptions.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
    if (
      !Number.isSafeInteger(this.maxBlobBytes) ||
      this.maxBlobBytes < 0 ||
      this.maxBlobBytes > DEFAULT_MAX_BLOB_BYTES
    ) {
      throw new BlobStreamError(
        "blob-too-large",
        `Maximum blob bytes must be between 0 and ${DEFAULT_MAX_BLOB_BYTES}.`,
      );
    }
    // maxFrameBytes bounds control-frame payloads only; blob chunks are bounded
    // solely by maxBlobChunkBytes, matching the Rust decoder — and a chunk can
    // never exceed a whole blob, so the local cap is clamped to the blob budget
    // before it seeds the decoder's pre-negotiation allocation bound.
    this.maxBlobChunkBytesCap = Math.min(
      this.maxBlobChunkBytesCap,
      this.maxBlobBytes,
    );
    this.maxBlobChunkBytes = this.maxBlobChunkBytesCap;
    this.decoder = new FrameDecoder(
      this.maxFrameBytes,
      this.maxBlobChunkBytes,
    );
    this.readyPromise = new Promise<EngineClient>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.readyPromise.catch(() => undefined);

    connection.onData(this.handleData);
    connection.onError(this.handleStreamError);
    connection.onClose(this.handleStreamClose);

    this.connectTimer = setTimeout(() => {
      this.fail(
        new EngineClientError(
          "connect-timeout",
          "Timed out waiting for the engine helloAck.",
        ),
      );
    }, connectOptions.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    void this.writeEnvelope({
      type: "hello",
      protocolVersion: connectOptions.protocolVersion,
      authToken: connectOptions.authToken,
      capabilities: [...connectOptions.capabilities],
      lastSessionGeneration: null,
    }).catch((cause: unknown) => {
      this.fail(
        new EngineClientError("transport-error", "Failed to send engine hello.", {
          cause,
        }),
      );
    });
  }

  ready(): Promise<EngineClient> {
    return this.readyPromise;
  }

  async sendRequest(request: Request): Promise<Response> {
    if (this.closed) {
      const cause = this.closeCause;
      throw new EngineClientError(
        cause?.code ?? "closed",
        `The engine client is closed: ${cause?.message ?? "closed by the caller"}`,
        cause ? { cause } : {},
      );
    }
    if (!this.readyState) {
      throw new EngineClientError(
        "handshake-incomplete",
        "The engine client cannot send requests before helloAck.",
      );
    }

    const wireId = this.nextRequestId++;
    const envelope: Envelope = {
      type: "request",
      ...request,
      id: wireId,
      workspace: request.workspace ?? null,
      deadlineMs: request.deadlineMs ?? null,
      idempotencyKey: request.idempotencyKey ?? null,
    };
    // MEASURED BEFORE FRAMING. `encodeFrame` refuses an oversized payload with
    // a codec error, and every failure on the write path reads as
    // `transport-error` — which is a lie twice over: nothing was transported,
    // and the classification sends a healthy session into the reconnect
    // machinery for a failure no reconnect can fix. A request that cannot be
    // framed is the caller’s to fix, so it is refused here, by name, with the
    // limit and the size that was asked for.
    const encodedRequest = Buffer.byteLength(JSON.stringify(envelope), "utf8");
    if (encodedRequest > this.maxFrameBytes) {
      return Promise.reject(
        new EngineClientError(
          "request-too-large",
          `request-exceeds-wire-limit: one control frame carries a request of ` +
            `at most ${this.maxFrameBytes} encoded bytes, observed ` +
            `${encodedRequest} encoded bytes for ${request.method}.`,
        ),
      );
    }
    return new Promise<Response>((resolve, reject) => {
      const deadlineTimer =
        request.deadlineMs !== undefined && request.deadlineMs !== null
          ? setTimeout(() => {
              const pending = this.pending.get(wireId);
              if (!pending) return;
              this.pending.delete(wireId);
              this.abandonedRequestIds.add(wireId);
              pending.reject(
                new EngineClientError(
                  "transport-error",
                  `Engine request ${wireId} timed out after ${request.deadlineMs}ms.`,
                ),
              );
            }, request.deadlineMs)
          : undefined;
      this.pending.set(wireId, {
        callerId: request.id,
        resolve,
        reject,
        ...(deadlineTimer ? { deadlineTimer } : {}),
      });
      void this.writeEnvelope(envelope).catch((cause: unknown) => {
        const pending = this.pending.get(wireId);
        if (!pending) return;
        this.pending.delete(wireId);
        if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
        pending.reject(
          new EngineClientError(
            "transport-error",
            `Failed to send engine request ${wireId}.`,
            { cause },
          ),
        );
      });
    });
  }

  async cancelRequest(callerId: number): Promise<void> {
    const pending = [...this.pending.entries()].find(
      ([, request]) => request.callerId === callerId,
    );
    if (!pending) return;
    await this.writeEnvelope({ type: "cancel", id: pending[0] });
  }

  onEvent(handler: (event: Event) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onBlob(handler: (blob: CompletedBlob) => void): () => void {
    this.blobHandlers.add(handler);
    return () => this.blobHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.fail(new EngineClientError("closed", "The engine client was closed."));
  }

  // AUDIT-KILLREC again, for the supervisor's wedge kill. Killing a daemon that
  // stopped answering is a REPLACEMENT, not a shutdown, and this cause is the
  // only one its in-flight callers will ever see: `notifyProcessExit` returns
  // early once the client is closed, so the process exit that follows cannot
  // re-cause these rejections. Reporting a bare `closed` here told every
  // retry-enabled caller the daemon went away on purpose, and they stayed
  // failed across a restart that was already under way.
  closeUnresponsive(): void {
    if (this.closed) return;
    // `force` because a wedged daemon must die NOW, not on a timer. The
    // ordinary close ends stdin and schedules the kill 2s later, and the
    // supervisor's next act is to report a terminal failure — which the
    // desktop answers with a modal that blocks the event loop. A timer cannot
    // run while that modal stands, so the deferred kill would wait for the
    // user and the wedged child would outlive the dialog.
    this.fail(
      new EngineClientError(
        "transport-error",
        "The engine stopped answering and was killed for replacement.",
      ),
      true,
    );
  }

  dispose(): void {
    this.close();
  }

  waitForExit(): Promise<void> {
    return this.termination;
  }

  notifyProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.fail(
      new EngineClientError(
        "transport-error",
        `The engine sidecar exited with ${detail}.`,
      ),
    );
  }

  private readonly handleData = (chunk: Buffer | Uint8Array): void => {
    try {
      this.decoder.push(chunk, (frame) => {
        if (this.closed) return false;
        this.receiveFrame(frame);
        return !this.closed;
      });
    } catch (cause) {
      this.fail(
        new EngineClientError("protocol-error", "Engine frame decoding failed.", {
          cause,
        }),
      );
    }
  };

  private readonly handleStreamError = (cause: unknown): void => {
    this.fail(
      new EngineClientError("transport-error", "Engine transport failed.", {
        cause,
      }),
    );
  };

  private readonly handleStreamClose = (): void => {
    if (!this.closed) {
      this.fail(
        new EngineClientError("transport-error", "Engine transport closed."),
      );
    }
  };

  // Every frame this client has decoded, of any kind. A liveness probe cannot
  // read its own reply as the only proof of life: the daemon writes ONE output
  // queue in order, so a probe can sit behind bulk egress it is not allowed to
  // overtake. Bytes arriving for anyone prove the daemon is turning.
  inboundActivity(): number {
    return this.inboundFrames;
  }

  private receiveFrame(frame: Frame): void {
    this.inboundFrames += 1;
    if (frame.kind === "blobChunk") {
      if (!this.readyState) {
        throw new EngineClientError(
          "protocol-error",
          "Received BlobChunk before helloAck.",
        );
      }
      this.assertBlobCapability();
      if (frame.payload.length > this.maxBlobChunkBytes) {
        throw new FrameCodecError(
          "blob-chunk-too-large",
          `Blob chunk is ${frame.payload.length} bytes; negotiated maximum is ${this.maxBlobChunkBytes}.`,
        );
      }
      this.receiveBlobChunk(frame);
      return;
    }
    if (this.readyState && frame.payload.length > this.maxFrameBytes) {
      throw new EngineClientError(
        "protocol-error",
        `Control frame payload is ${frame.payload.length} bytes; negotiated maximum is ${this.maxFrameBytes}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.textDecoder.decode(frame.payload));
    } catch (cause) {
      throw new EngineClientError(
        "protocol-error",
        "Control frame does not contain a valid UTF-8 JSON envelope.",
        { cause },
      );
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      throw new EngineClientError(
        "protocol-error",
        "Control frame does not contain a tagged envelope.",
      );
    }
    this.receiveEnvelope(parsed as Envelope);
  }

  private receiveEnvelope(envelope: Envelope): void {
    if (this.closed) return;
    if (!this.readyState) {
      if (envelope.type === "error") {
        this.fail(
          new EngineClientError(
            "handshake-failed",
            `Engine rejected the handshake: ${envelope.error.message}`,
            { wireError: envelope.error },
          ),
        );
        return;
      }
      if (envelope.type !== "helloAck") {
        throw new EngineClientError(
          "protocol-error",
          `Received ${envelope.type} before helloAck.`,
        );
      }
      this.acceptHelloAck(envelope);
      return;
    }

    switch (envelope.type) {
      case "response":
        this.resolveResponse(envelope);
        return;
      case "error":
        this.rejectWireError(envelope.id ?? null, envelope.error);
        return;
      case "event":
        for (const handler of this.eventHandlers) {
          try {
            handler(envelope);
          } catch {
            // Event subscribers are observer boundaries; one cannot interrupt
            // transport dispatch to the remaining subscribers.
          }
        }
        return;
      case "blobStart":
        this.receiveBlobStart(envelope);
        return;
      case "batch": {
        const maxBatchLen = this.helloAck?.limits.maxBatchLen;
        if (
          maxBatchLen === undefined ||
          envelope.envelopes.length > maxBatchLen
        ) {
          throw new EngineClientError(
            "protocol-error",
            `Inbound batch length ${envelope.envelopes.length} exceeds the negotiated maximum ${maxBatchLen ?? "unknown"}.`,
          );
        }
        if (envelope.envelopes.some((nested) => nested.type === "batch")) {
          throw new EngineClientError(
            "protocol-error",
            "Inbound batches must not contain nested batches.",
          );
        }
        // Batches are bounded, non-nesting, and unwrapped in order.
        for (const nested of envelope.envelopes) {
          if (this.closed) break;
          this.receiveEnvelope(nested);
        }
        return;
      }
      default:
        throw new EngineClientError(
          "protocol-error",
          `Unexpected inbound envelope type: ${envelope.type}.`,
        );
    }
  }

  private acceptHelloAck(envelope: HelloAckEnvelope): void {
    if (this.closed) return;
    if (envelope.protocolVersion !== this.connectOptions.protocolVersion) {
      this.fail(
        new EngineClientError(
          "handshake-failed",
          `Engine acknowledged protocol ${envelope.protocolVersion}; expected ${this.connectOptions.protocolVersion}.`,
        ),
      );
      return;
    }
    if (
      !Number.isSafeInteger(envelope.limits.maxFrameBytes) ||
      envelope.limits.maxFrameBytes < MIN_NEGOTIABLE_MAX_FRAME_BYTES ||
      envelope.limits.maxFrameBytes > MAX_U32
    ) {
      this.fail(
        new EngineClientError(
          "handshake-failed",
          "Engine advertised an invalid maximum frame size.",
        ),
      );
      return;
    }
    if (
      !Number.isSafeInteger(envelope.limits.maxBlobChunkBytes) ||
      envelope.limits.maxBlobChunkBytes < 0 ||
      envelope.limits.maxBlobChunkBytes > MAX_U32
    ) {
      this.fail(
        new EngineClientError(
          "handshake-failed",
          "Engine advertised an invalid maximum blob chunk size.",
        ),
      );
      return;
    }
    // Inbound JSON is only cast to Envelope; a non-array here would make the
    // capability gate a String.prototype.includes call.
    if (
      !Array.isArray(envelope.capabilities) ||
      !envelope.capabilities.every((cap) => typeof cap === "string")
    ) {
      this.fail(
        new EngineClientError(
          "handshake-failed",
          "Engine acknowledged malformed capabilities.",
        ),
      );
      return;
    }
    this.maxFrameBytes = Math.min(
      this.maxFrameBytes,
      envelope.limits.maxFrameBytes,
    );
    this.maxBlobChunkBytes = Math.min(
      this.maxBlobChunkBytesCap,
      envelope.limits.maxBlobChunkBytes,
    );
    this.decoder.setLimits(
      this.maxFrameBytes,
      this.maxBlobChunkBytes,
    );
    this.helloAck = envelope;
    this.readyState = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.readyResolve(this);
  }

  private receiveBlobStart(start: BlobStart): void {
    this.assertBlobCapability();
    if (
      !Number.isSafeInteger(start.requestId) ||
      start.requestId < 0 ||
      !Number.isSafeInteger(start.streamId) ||
      start.streamId < 0 ||
      (start.totalBytes !== undefined &&
        start.totalBytes !== null &&
        (!Number.isSafeInteger(start.totalBytes) || start.totalBytes < 0))
    ) {
      throw new BlobStreamError(
        "invalid-blob-start",
        "blobStart contains an invalid wire integer.",
      );
    }
    // Stream ids are unique per session generation but NOT ordered — concurrent
    // handlers may announce them out of order. Reject only an id that is still
    // active (a live reassembly collision); a completed id is gone from the map
    // and a reuse simply starts a fresh stream bound to its own known request.
    if (
      this.blobStreams.has(start.streamId) ||
      this.abandonedBlobStreamIds.has(start.streamId)
    ) {
      throw new BlobStreamError(
        "duplicate-blob-stream",
        `Blob stream ${start.streamId} is already active.`,
      );
    }
    if (
      start.totalBytes !== undefined &&
      start.totalBytes !== null &&
      start.totalBytes > this.maxBlobBytes
    ) {
      throw new BlobStreamError(
        "blob-too-large",
        `Blob stream ${start.streamId} announces ${start.totalBytes} bytes; maximum is ${this.maxBlobBytes}.`,
      );
    }
    if (
      start.sha256 !== undefined &&
      start.sha256 !== null &&
      (typeof start.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(start.sha256))
    ) {
      throw new BlobStreamError(
        "invalid-blob-start",
        "blobStart.sha256 must be a lowercase SHA-256 hex digest.",
      );
    }
    if (this.abandonedRequestIds.has(start.requestId)) {
      this.abandonedBlobStreamIds.add(start.streamId);
      return;
    }
    if (this.blobStreams.size >= MAX_CONCURRENT_BLOB_STREAMS) {
      throw new BlobStreamError(
        "too-many-blob-streams",
        `At most ${MAX_CONCURRENT_BLOB_STREAMS} blob streams may be active.`,
      );
    }
    const pendingEntry = this.pending.get(start.requestId);
    if (!pendingEntry) {
      throw new BlobStreamError(
        "unknown-blob-request",
        `Blob stream ${start.streamId} references unknown request ${start.requestId}.`,
      );
    }
    this.blobStreams.set(start.streamId, {
      start,
      callerRequestId: pendingEntry.callerId,
      chunks: [],
      receivedBytes: 0,
    });
  }

  private assertBlobCapability(): void {
    // Capabilities are intersection-negotiated: blob streaming requires that the
    // client requested it AND the engine acknowledged it.
    if (
      !this.connectOptions.capabilities.includes(BLOB_CAPABILITY) ||
      !this.helloAck?.capabilities.includes(BLOB_CAPABILITY)
    ) {
      throw new EngineClientError(
        "protocol-error",
        `Blob streaming requires the "${BLOB_CAPABILITY}" capability, which this session did not negotiate.`,
      );
    }
  }

  private receiveBlobChunk(
    frame: Extract<Frame, { kind: "blobChunk" }>,
  ): void {
    if (this.abandonedBlobStreamIds.has(frame.streamId)) {
      if (frame.fin) this.abandonedBlobStreamIds.delete(frame.streamId);
      return;
    }
    const stream = this.blobStreams.get(frame.streamId);
    if (!stream) {
      throw new BlobStreamError(
        "unknown-blob-stream",
        `Blob stream ${frame.streamId} was not announced by blobStart.`,
      );
    }
    if (frame.payload.length === 0 && !frame.fin) {
      throw new BlobStreamError(
        "empty-blob-chunk",
        `Blob stream ${frame.streamId} received an empty non-final chunk.`,
      );
    }
    const receivedBytes = stream.receivedBytes + frame.payload.length;
    const announcedBytes = stream.start.totalBytes ?? this.maxBlobBytes;
    if (receivedBytes > announcedBytes || receivedBytes > this.maxBlobBytes) {
      throw new BlobStreamError(
        "blob-too-large",
        `Blob stream ${frame.streamId} exceeded its ${Math.min(announcedBytes, this.maxBlobBytes)} byte bound.`,
      );
    }
    if (this.bufferedBlobBytes + frame.payload.length > this.maxBlobBytes) {
      throw new BlobStreamError(
        "blob-backpressure-exceeded",
        `Buffered blob bytes exceed the ${this.maxBlobBytes} byte global budget.`,
      );
    }
    if (stream.chunks.length >= MAX_BLOB_CHUNKS_PER_STREAM) {
      throw new BlobStreamError(
        "blob-backpressure-exceeded",
        `Blob stream ${frame.streamId} exceeded ${MAX_BLOB_CHUNKS_PER_STREAM} buffered chunks.`,
      );
    }
    if (this.bufferedBlobChunks >= MAX_BUFFERED_BLOB_CHUNKS) {
      throw new BlobStreamError(
        "blob-backpressure-exceeded",
        `Buffered blob chunks exceed the ${MAX_BUFFERED_BLOB_CHUNKS} global cap.`,
      );
    }
    stream.chunks.push(frame.payload);
    stream.receivedBytes = receivedBytes;
    this.bufferedBlobBytes += frame.payload.length;
    this.bufferedBlobChunks += 1;
    if (!frame.fin) return;
    if (
      stream.start.totalBytes !== undefined &&
      stream.start.totalBytes !== null &&
      receivedBytes !== stream.start.totalBytes
    ) {
      throw new BlobStreamError(
        "blob-size-mismatch",
        `Blob stream ${frame.streamId} ended at ${receivedBytes} bytes; expected ${stream.start.totalBytes}.`,
      );
    }

    const bytes = Buffer.concat(stream.chunks, receivedBytes);
    if (
      stream.start.sha256 !== undefined &&
      stream.start.sha256 !== null &&
      createHash("sha256").update(bytes).digest("hex") !== stream.start.sha256
    ) {
      throw new BlobStreamError(
        "blob-digest-mismatch",
        `Blob stream ${frame.streamId} does not match its announced SHA-256.`,
      );
    }

    this.blobStreams.delete(frame.streamId);
    this.bufferedBlobBytes -= receivedBytes;
    this.bufferedBlobChunks -= stream.chunks.length;
    const blob: CompletedBlob = {
      requestId: stream.callerRequestId,
      streamId: stream.start.streamId,
      totalBytes: stream.start.totalBytes,
      sha256: stream.start.sha256,
      bytes,
    };
    for (const handler of this.blobHandlers) {
      try {
        handler(blob);
      } catch {
        // Blob subscribers are observer boundaries, like event subscribers.
      }
    }
  }

  private resolveResponse(response: Response): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      if (this.abandonedRequestIds.delete(response.id)) return;
      throw new EngineClientError(
        "protocol-error",
        `Received response for unknown request ${response.id}.`,
      );
    }
    this.pending.delete(response.id);
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    pending.resolve({ id: pending.callerId, result: response.result });
  }

  private rejectWireError(id: number | null, wireError: WireError): void {
    if (id === null) {
      this.fail(
        new EngineClientError(
          "wire-error",
          `Engine connection error: ${wireError.message}`,
          { wireError },
        ),
      );
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      if (this.abandonedRequestIds.delete(id)) return;
      throw new EngineClientError(
        "protocol-error",
        `Received error for unknown request ${id}.`,
      );
    }
    this.pending.delete(id);
    if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
    // A failed request's announced blob streams are dead: free their budget and
    // drop them so a late FIN cannot dispatch a blob the caller saw fail.
    for (const [streamId, stream] of this.blobStreams) {
      if (stream.start.requestId !== id) continue;
      this.bufferedBlobBytes -= stream.receivedBytes;
      this.bufferedBlobChunks -= stream.chunks.length;
      this.blobStreams.delete(streamId);
    }
    pending.reject(new EngineRequestError(pending.callerId, wireError));
  }

  private writeEnvelope(envelope: Envelope): Promise<void> {
    let frame: Buffer;
    try {
      frame = encodeFrame(
        FrameType.Control,
        0,
        Buffer.from(JSON.stringify(envelope), "utf8"),
        this.maxFrameBytes,
      );
    } catch (error) {
      return Promise.reject(error);
    }
    try {
      this.connection.write(frame);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private fail(error: EngineClientError, force = false): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCause = error;
    this.readyState = false;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.connection.offData(this.handleData);
    this.connection.offError(this.handleStreamError);
    this.connection.offClose(this.handleStreamClose);
    this.readyReject(error);
    for (const pending of this.pending.values()) {
      if (pending.deadlineTimer) clearTimeout(pending.deadlineTimer);
      pending.reject(error);
    }
    this.pending.clear();
    this.abandonedRequestIds.clear();
    this.abandonedBlobStreamIds.clear();
    this.blobStreams.clear();
    this.bufferedBlobBytes = 0;
    this.bufferedBlobChunks = 0;
    try {
      this.terminate(force);
    } catch {
      this.connection.close();
    }
  }
}

export class DuplexEngineClientConnection implements EngineClientConnection {
  constructor(private readonly duplex: Duplex) {
    // Keep late destroy errors from becoming uncaught exceptions.
    this.duplex.on("error", () => undefined);
  }

  write(buffer: Buffer): boolean {
    return this.duplex.write(buffer);
  }

  onData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.duplex.on("data", handler);
  }

  onClose(handler: () => void): void {
    this.duplex.on("close", handler);
    this.duplex.on("end", handler);
  }

  onError(handler: (error: unknown) => void): void {
    this.duplex.on("error", handler);
  }

  offData(handler: (chunk: Buffer | Uint8Array) => void): void {
    this.duplex.off("data", handler);
  }

  offClose(handler: () => void): void {
    this.duplex.off("close", handler);
    this.duplex.off("end", handler);
  }

  offError(handler: (error: unknown) => void): void {
    this.duplex.off("error", handler);
  }

  close(): void {
    this.duplex.destroy();
  }
}

export async function connectEngineClient(
  connection: Duplex,
  options: EngineClientConnectOptions,
): Promise<EngineClient> {
  const client = new EngineClient(
    new DuplexEngineClientConnection(connection),
    options,
  );
  await client.ready();
  return client;
}

export async function createEngineClient(
  options: EngineClientSpawnOptions,
): Promise<EngineClient> {
  const child = spawn(options.command, options.args ?? [], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      ...options.env,
      [ENGINE_AUTH_TOKEN_ENV]: options.authToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  const connection = Duplex.from({
    readable: child.stdout,
    writable: child.stdin,
  });
  const termination = new Promise<void>((resolve) => {
    // "close" follows both a normal exit and a spawn failure, and proves the
    // process plus its stdio handles are gone before lifecycle shutdown settles.
    child.once("close", () => resolve());
  });
  const clientConnection = new DuplexEngineClientConnection(connection);
  const client = new EngineClient(
    clientConnection,
    options,
    (force) => {
      // Closing stdin lets the Rust host observe EOF, drain its workspace
      // actors, and exit normally. Keep a bounded kill fallback for a wedged
      // child so desktop shutdown cannot leak the sidecar.
      connection.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      // A forced kill cannot wait for the timer below. The caller already
      // proved this child answers nothing, and it is about to run code that
      // can block the event loop, which is where that timer lives. Signal now.
      if (force) {
        child.kill();
        return;
      }
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }, 2_000);
      killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
    },
    termination,
  );

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (!options.onStderr) {
      console.error(`[desktop] Rust engine sidecar: ${text.trimEnd()}`);
      return;
    }
    try {
      options.onStderr(text);
    } catch (error) {
      console.error("[desktop] Rust engine diagnostic handler failed:", error);
    }
  });
  child.on("error", (cause) => {
    connection.destroy(cause);
  });
  child.on("exit", (code, signal) => {
    client.notifyProcessExit(code, signal);
    options.onExit?.(code, signal);
  });

  const abortLaunch = (): void => client.close();
  if (options.signal?.aborted) {
    abortLaunch();
  } else {
    options.signal?.addEventListener("abort", abortLaunch, { once: true });
  }
  try {
    await client.ready();
    return client;
  } catch (error) {
    client.close();
    await client.waitForExit();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortLaunch);
  }
}
