// Framed stdio transport to the workspace engine daemon.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import { parseRelayAcceptedLiveUpdate, parseLiveUpdateIdentifier, parseLiveUpdateDigest, parseLiveUpdateHostApplicationAck, type LiveUpdateHostApplicationAck, type AdmittedLiveUpdate, parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract";
import type { BlobStart, Envelope, Event, Request, Response, WireError } from "../protocol";
import type { EngineTransport } from "../ydoc/ydocLiveAdapter";
import type { OwnerYDocOutboxAppendResult } from "../ydoc/ownerYDocOutbox";
import { parseNativeOwnerActivation, type NativeOwnerActivation } from "./nativeOwnerActivation";

const FRAME_MAGIC = Buffer.from("DOP1", "ascii");
const FRAME_HEADER_BYTES = 12;
const BLOB_STREAM_ID_BYTES = 8;
const BLOB_FIN_FLAG = 0b0000_0001;
const MAX_U32 = 0xffff_ffff;
const MAX_WIRE_INTEGER = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BLOB_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const NATIVE_RESTORE_STATUS = { prepare: "prepared", apply: "applied", settle: "settled", resume: "resumed" } as const;
const MAX_CONCURRENT_BLOB_STREAMS = 64;
// Global cap on chunks received by active streams. Unknown-length streams retain
// those Buffers; known-length streams do not, but keep the same tiny-chunk flood
// refusal until FIN.
const MAX_BUFFERED_BLOB_CHUNKS = 8192;
// Bounds per-stream tiny-chunk work and, for the unknown-length fallback,
// retained Buffer overhead. A max-size blob at the default chunk size is ~256
// chunks, so this leaves ample headroom for legitimate chunking.
const MAX_BLOB_CHUNKS_PER_STREAM = 4096;
// Blob streaming gates on this negotiated hello/helloAck capability, never on
// frame sniffing.
const BLOB_CAPABILITY = "blobs";
// A request can ask for progress only on a session that negotiated this.
const PROGRESS_CAPABILITY = "progress";
// Leaves headroom for handshake and small control envelopes.
const MIN_NEGOTIABLE_MAX_FRAME_BYTES = 64 * 1024;
// Mirrors MIN_NEGOTIABLE_FRAME_BYTES in crates/dohc-engine-protocol/src/limits.rs:
// the engine clamps a requested limit up to this, so a client that configured
// less would have its receive cap raised by the ack; refuse it at connect.
const MIN_REQUESTABLE_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_ORDINARY_REQUESTS = 1024;
const MAX_ORDINARY_REQUEST_BYTES = 64 * 1024 * 1024;
const ENGINE_AUTH_TOKEN_ENV = "DOHC_ENGINE_AUTH_TOKEN";
const MAX_LIVE_UPDATE_BYTES = 20 * 1024 * 1024;
const PACKED_LIVE_RANGE_BYTES = 16;

interface PrivateLiveApplicationConfig {
  /** Client upload buffers; the daemon configures its own application reserve. */
  readonly aggregateBytes: number;
  readonly maxUploads: number;
}

function capturePrivateLiveApplicationConfig(value: PrivateLiveApplicationConfig | undefined): PrivateLiveApplicationConfig | undefined {
  if (value === undefined) return undefined;
  const { aggregateBytes, maxUploads } = value;
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes <
    MAX_LIVE_UPDATE_BYTES + Math.floor((MAX_LIVE_UPDATE_BYTES - 2) / 5) * PACKED_LIVE_RANGE_BYTES + 3 * 1024 * 1024 ||
    !Number.isSafeInteger(maxUploads) || maxUploads < 1) throw new TypeError("Invalid private live-application budget.");
  return Object.freeze({ aggregateBytes, maxUploads });
}

interface LiveApplicationRequest {
  id: number;
  workspace: string;
  registrationId: number;
  deadlineMs: number;
}

export type OwnerYDocDeliveryRequest = Omit<LiveApplicationRequest, "registrationId">;
export interface OwnerYDocDeliveryTarget { readonly binding: LiveObjectBinding; readonly relayDatabaseNamespace: string }
export interface OwnerYDocDeliveryPosition { readonly revision: number; readonly acceptedCursor: number; readonly nativeHeadSequence: number }
export interface OwnerYDocDeliveryApplyInput extends OwnerYDocDeliveryTarget {
  readonly expectedRevision: number; readonly expectedNativeHeadSequence: number;
  readonly previousAcceptedCursor: number; readonly journalCursor: number; readonly updateBytes: Uint8Array;
}
export interface OwnerYDocDeliveryReceipt { readonly deliveryId: string; readonly updateDigest: string; readonly journalCursor: number; readonly acceptingHostEpoch: number }
export interface OwnerYDocDraftCursor { readonly mainVersionId:string; readonly objectId:string; readonly lineageClaimId:string }
export interface OwnerYDocDraftDescriptor extends OwnerYDocDeliveryTarget, OwnerYDocDeliveryPosition {
  readonly outboxId:string|null; readonly pendingBytes:number; readonly state:"active"|"sealed"|"quarantined"|null;
}

function ownerDraftCursor(value: OwnerYDocDraftCursor): OwnerYDocDraftCursor {
  if (!value || Object.keys(value).sort().join()!=="lineageClaimId,mainVersionId,objectId") throw new TypeError("Invalid draft cursor.");
  return {mainVersionId:parseLiveUpdateIdentifier(value.mainVersionId,"main version ID"),objectId:parseLiveUpdateIdentifier(value.objectId,"object ID"),lineageClaimId:parseLiveUpdateDigest(value.lineageClaimId)};
}
function ownerDraftDescriptor(value: unknown): OwnerYDocDraftDescriptor {
  if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).sort().join()!=="acceptedCursor,binding,nativeHeadSequence,outboxId,pendingBytes,relayDatabaseNamespace,revision,state") throw new TypeError("Invalid draft descriptor.");
  const row=value as OwnerYDocDraftDescriptor;
  if (!Number.isSafeInteger(row.pendingBytes) || row.pendingBytes<0 || ![null,"active","sealed","quarantined"].includes(row.state) || (row.outboxId===null)!==(row.state===null)) throw new TypeError("Invalid draft queue state.");
  return {...ownerDeliveryTarget(row),...ownerDeliveryPosition(row),outboxId:row.outboxId===null?null:parseLiveUpdateIdentifier(row.outboxId,"outbox ID"),pendingBytes:row.pendingBytes,state:row.state};
}

function ownerDeliveryTarget(target: OwnerYDocDeliveryTarget) {
  const binding=parseLiveObjectBinding(target.binding);
  return {binding: {...binding,selectorPaths:[...binding.selectorPaths]}, relayDatabaseNamespace: parseLiveUpdateIdentifier(target.relayDatabaseNamespace, "relay namespace")};
}
function ownerDeliveryPosition(value: unknown): OwnerYDocDeliveryPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid owner delivery position.");
  const row=value as OwnerYDocDeliveryPosition;
  if (!Number.isSafeInteger(row.revision) || row.revision<1 || !Number.isSafeInteger(row.acceptedCursor) || row.acceptedCursor<0 || !Number.isSafeInteger(row.nativeHeadSequence) || row.nativeHeadSequence<0) throw new TypeError("Invalid owner delivery position.");
  return {revision:row.revision,acceptedCursor:row.acceptedCursor,nativeHeadSequence:row.nativeHeadSequence};
}

export interface NativeAppliedPosition { readonly eventCount:number; readonly journalCursor:number; readonly evidenceDigest:string }
function appliedPosition(value: unknown): NativeAppliedPosition {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "eventCount,evidenceDigest,journalCursor") throw new TypeError("Invalid applied position.");
  const row=value as NativeAppliedPosition;
  if (!Number.isSafeInteger(row.eventCount) || row.eventCount<0 || !Number.isSafeInteger(row.journalCursor) || row.journalCursor<0 || (row.eventCount===0)!==(row.journalCursor===0)) throw new TypeError("Invalid applied position.");
  return Object.freeze({eventCount:row.eventCount,journalCursor:row.journalCursor,evidenceDigest:parseLiveUpdateDigest(row.evidenceDigest)});
}

interface PrivateLiveOutput {
  readonly maxBytes: number;
  readonly status: "prepared" | "applied" | "settled" | "resumed" | "sync" | "update" | "state" | "draft" | "captured";
  readonly allowEmpty?: boolean;
  wireId?: number;
  started: boolean;
  blob?: CompletedBlob;
}

export interface LiveApplicationBootstrap {
  readonly bootstrapId: string;
  readonly bootstrapMomentId: string;
  readonly baselineMomentRelaySequence: number;
  readonly baselineRegisteredAtMs: number;
  readonly baselineDigest: string;
  readonly projectedMarkdownDigest: string;
  readonly projectedMarkdownByteLength: number;
  readonly baselineBytes: Uint8Array;
}

/** Trusted main-process evidence acquired from the authenticated relay journal. */
export interface LiveOwnerAdoptionCut {
  readonly relayDatabaseNamespace: string;
  readonly adoptionId: string;
  readonly sourceMomentId: string;
  readonly sourceDigest: string;
  readonly sourceByteLength: number;
  readonly baselineMomentRelaySequence: number;
  readonly baselineRegisteredAtMs: number;
  readonly expectedLocalSequence: number;
  readonly terminalReceipt: AdmittedLiveUpdate["metadata"]["accepted"]["receipt"] | null;
  readonly baselineBytes: Uint8Array;
  readonly events: readonly AdmittedLiveUpdate[];
}

interface LiveApplicationBootstrapAck {
  readonly bootstrapId: string;
  readonly bootstrapMomentId: string;
  readonly baselineDigest: string;
  readonly baselineMomentRelaySequence: number;
  readonly localYDocSequence: number;
  readonly bootstrapReplayed: boolean;
}

interface LiveUpload {
  params: Request["params"];
  streams: readonly { streamId: number; bytes: Buffer; digest: string }[];
}

export const enum FrameType {
  Control = 1,
  BlobChunk = 2,
}

export type Frame =
  | { kind: "control"; payload: Buffer }
  | { kind: "blobChunk"; streamId: number; fin: boolean; payload: Buffer };

interface BlobChunkPayload {
  readonly streamId: number;
  readonly bytes: Buffer;
}

type FrameCodecErrorCode =
  | "bad-magic"
  | "blob-chunk-missing-stream-id"
  | "blob-chunk-too-large"
  | "blob-stream-id-out-of-range"
  | "frame-too-large"
  | "invalid-flags"
  | "non-zero-reserved"
  | "truncated-frame"
  | "unknown-frame-type";

class FrameCodecError extends Error {
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
  // whole batch materialize first. It is invoked outside the decode try/catch so
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

export const ENGINE_CLIENT_ERROR_CODES = [
  "closed",
  "connect-timeout",
  "handshake-incomplete",
  "handshake-failed",
  "protocol-error",
  "request-too-large",
  "transport-error",
  "wire-error",
] as const;
type EngineClientErrorCode = (typeof ENGINE_CLIENT_ERROR_CODES)[number];

/**
 * The envelope a caller’s request becomes on the wire.
 *
 * Normalize before MEASURING. The client stamps its own wire id and fills
 * every nullable field explicitly — the canonical form the wire contract
 * requires (`wire.rs`) and the form the daemon re-encodes when it measures.
 * A caller-shaped request measured as it stands is a different envelope: no
 * `type`, no `deadlineMs: null`, no `idempotencyKey: null`, about sixty bytes
 * short. At the frame boundary that gap is the difference between accepting a
 * request and refusing it, so anything that models this bound builds the
 * envelope here rather than measuring what it was handed.
 */
export function requestEnvelope(
  request: Request,
  wireId: number,
  progress = false,
): Envelope {
  return {
    type: "request",
    ...request,
    id: wireId,
    workspace: request.workspace ?? null,
    deadlineMs: request.deadlineMs ?? null,
    idempotencyKey: request.idempotencyKey ?? null,
    // Absent unless asked, as the engine encodes it, so a request that does
    // not ask for progress is unchanged on the wire.
    ...(progress ? { progress: true } : {}),
  };
}

/** What one control frame has to hold for this envelope. */
export function encodedEnvelopeBytes(envelope: Envelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

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

/**
 * A request the caller deadlined ran out of time before the daemon answered.
 *
 * Expiry can precede transmission. The code remains `transport-error` for
 * callers that recover by rebinding; this class lets them distinguish their
 * own deadline from a socket failure without matching message text.
 */
export class EngineRequestDeadlineError extends EngineClientError {
  readonly requestId: number;
  readonly method: string;
  readonly deadlineMs: number;

  constructor(requestId: number, method: string, deadlineMs: number) {
    super(
      "transport-error",
      `engine-request-deadline-exceeded: request ${requestId} (${method}) carries ` +
        `a deadline of ${deadlineMs} ms and the daemon did not answer inside it.`,
    );
    this.name = "EngineRequestDeadlineError";
    this.requestId = requestId;
    this.method = method;
    this.deadlineMs = deadlineMs;
  }
}

type BlobStreamErrorCode =
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

class BlobStreamError extends Error {
  readonly code: BlobStreamErrorCode;

  constructor(code: BlobStreamErrorCode, message: string) {
    super(message);
    this.name = "BlobStreamError";
    this.code = code;
  }
}

export type CompletedBlob = BlobStart & { readonly bytes: Buffer };

export interface EngineClientSpawnOptions {
  authorContextSecret?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  authToken: string;
  protocolVersion: number;
  capabilities: string[];
  privateLiveApplication?: PrivateLiveApplicationConfig;
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
  /** Explicit private host setup; ordinary clients leave this absent. */
  privateLiveApplication?: PrivateLiveApplicationConfig;
}

export interface EngineClientConnection {
  write(buffer: Buffer): boolean;
  onData(handler: (chunk: Buffer | Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
  onDrain(handler: () => void): void;
  offData(handler: (chunk: Buffer | Uint8Array) => void): void;
  offClose(handler: () => void): void;
  offError(handler: (error: unknown) => void): void;
  offDrain(handler: () => void): void;
  close(): void;
}

interface PendingRequest {
  readonly callerId: number;
  readonly request: Request;
  readonly resolve: (response: Response) => void;
  readonly reject: (error: EngineClientError) => void;
  readonly deadlineTimer?: ReturnType<typeof setTimeout>;
  readonly restoreOutput?: PrivateLiveOutput;
  readonly cancelUnsent?: () => boolean;
  // Present only when the request asked the engine for progress.
  readonly onProgress?: () => void;
}

interface PendingWrite {
  send(): Promise<void> | null;
  reject(error: unknown): void;
}

interface PendingBlob {
  readonly start: BlobStart;
  // Captured when the stream is announced so response/chunk ordering cannot
  // change the blob's request identity after resolveResponse clears pending.
  readonly callerRequestId: number;
  // A known-length stream writes straight into its final destination. Only the
  // bounded unknown-length fallback retains chunks for FIN concatenation.
  readonly destination: Buffer | null;
  readonly chunks: Buffer[] | null;
  readonly hash: Hash | null;
  receivedBytes: number;
  receivedChunks: number;
  retainedBytes: number;
}

type HelloAckEnvelope = Extract<Envelope, { type: "helloAck" }>;

export class EngineClient implements EngineTransport {
  async ownerYDocListDrafts(request:OwnerYDocDeliveryRequest, input:{after:OwnerYDocDraftCursor|null;limit:number}, signal?:AbortSignal):Promise<{drafts:readonly OwnerYDocDraftDescriptor[];next:OwnerYDocDraftCursor|null}> {
    if (!Number.isSafeInteger(input.limit) || input.limit<1 || input.limit>64) throw new TypeError("Invalid draft page size.");
    const after=input.after===null?null:ownerDraftCursor(input.after),limit=input.limit;
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.listDrafts",16*1024*1024,()=>({params:{after:after&&{...after},limit},streams:[]}),signal);
    const row=response.result as {drafts?:unknown;next?:OwnerYDocDraftCursor|null};
    if (!row || Object.keys(row).sort().join()!=="drafts,next" || !Array.isArray(row.drafts) || row.drafts.length>limit) throw new TypeError("Invalid draft page.");
    const drafts=row.drafts.map(ownerDraftDescriptor),next=row.next===null?null:ownerDraftCursor(row.next!);
    if (next && (!drafts.length || next.mainVersionId!==drafts.at(-1)!.binding.mainVersionId || next.objectId!==drafts.at(-1)!.binding.objectId || next.lineageClaimId!==drafts.at(-1)!.binding.lineageClaimId)) throw new TypeError("Draft cursor differs from page.");
    return {drafts,next};
  }

  async ownerYDocOpenDraft(request:OwnerYDocDeliveryRequest, input:{binding:LiveObjectBinding;expectedRevision:number}, signal?:AbortSignal):Promise<{draft:OwnerYDocDraftDescriptor;initialUpdate:Buffer}> {
    const binding=parseLiveObjectBinding(input.binding),expectedRevision=input.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision<1) throw new TypeError("Invalid draft revision.");
    const output:PrivateLiveOutput={status:"draft",maxBytes:MAX_LIVE_UPDATE_BYTES,started:false};
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.openDraft",MAX_LIVE_UPDATE_BYTES+3*1024*1024,()=>({params:{binding:{...binding,selectorPaths:[...binding.selectorPaths]},expectedRevision},streams:[]}),signal,output);
    if (Object.keys(response.result as object).sort().join()!=="byteLength,digest,draft,status,streamId") throw new TypeError("Invalid draft open response.");
    const draft=ownerDraftDescriptor((response.result as Record<string,unknown>).draft);
    if (JSON.stringify(draft.binding)!==JSON.stringify(binding) || draft.revision!==expectedRevision) throw new TypeError("Draft open differs from requested binding.");
    return {draft,initialUpdate:output.blob!.bytes};
  }

  async ownerYDocAppendDraft(request:OwnerYDocDeliveryRequest, input:{binding:LiveObjectBinding;expectedRevision:number;appendKey:string;updateBytes:Uint8Array}, signal?:AbortSignal):Promise<OwnerYDocOutboxAppendResult> {
    const binding=parseLiveObjectBinding(input.binding),expectedRevision=input.expectedRevision,appendKey=parseLiveUpdateIdentifier(input.appendKey,"append key");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision<1 || input.updateBytes.byteLength<2 || input.updateBytes.byteLength>MAX_LIVE_UPDATE_BYTES) throw new TypeError("Invalid draft update.");
    let digest="";
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.appendDraft",input.updateBytes.byteLength+3*1024*1024,()=>{
      const bytes=Buffer.from(input.updateBytes),streamId=this.nextLiveStreamId++;
      if (!Number.isSafeInteger(streamId)) throw new TypeError("Owner stream identifiers exhausted.");
      digest=createHash("sha256").update(bytes).digest("hex");
      return {params:{binding:{...binding,selectorPaths:[...binding.selectorPaths]},expectedRevision,appendKey,streamId,byteLength:bytes.length,digest},streams:[{streamId,bytes,digest}]};
    },signal);
    const row=response.result as unknown as OwnerYDocOutboxAppendResult;
    if (!row || Object.keys(row).sort().join()!=="deliveryId,oldestEntryAtMs,outboxId,pendingBytes,sequence,state,updateDigest" || row.updateDigest!==digest || !["active","sealed"].includes(row.state)
      || !Number.isSafeInteger(row.sequence) || row.sequence<1 || !Number.isSafeInteger(row.pendingBytes) || row.pendingBytes<1 || !Number.isSafeInteger(row.oldestEntryAtMs) || row.oldestEntryAtMs<0) throw new TypeError("Invalid draft append response.");
    return {...row,outboxId:parseLiveUpdateIdentifier(row.outboxId,"outbox ID"),deliveryId:parseLiveUpdateIdentifier(row.deliveryId,"delivery ID")};
  }

  async ownerYDocPrepareEnrollment(request: OwnerYDocDeliveryRequest, target: OwnerYDocDeliveryTarget, signal?: AbortSignal): Promise<
    {status:"capture";captured:{nativeHeadSequence:number;localStateDigest:string}} | {status:"observed";draft:OwnerYDocDraftDescriptor}
  > {
    const params=ownerDeliveryTarget(target);
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.prepareEnrollment",3*1024*1024,()=>({params,streams:[]}),signal);
    const row=response.result as Record<string,unknown>;
    if (row.status==="observed" && Object.keys(row).sort().join()==="draft,status") {
      const draft=ownerDraftDescriptor(row.draft);
      if (JSON.stringify(draft.binding)!==JSON.stringify(params.binding) || draft.relayDatabaseNamespace!==params.relayDatabaseNamespace) throw new TypeError("Owner enrollment target changed.");
      return {status:"observed",draft};
    }
    if (row.status!=="capture" || Object.keys(row).sort().join()!=="captured,status") throw new TypeError("Invalid owner capture response.");
    const captured=row.captured as {nativeHeadSequence:number;localStateDigest:string};
    if (!captured || Object.keys(captured).sort().join()!=="localStateDigest,nativeHeadSequence" || !Number.isSafeInteger(captured.nativeHeadSequence) || captured.nativeHeadSequence<0) throw new TypeError("Invalid owner capture.");
    return {status:"capture",captured:{nativeHeadSequence:captured.nativeHeadSequence,localStateDigest:parseLiveUpdateDigest(captured.localStateDigest)}};
  }

  async ownerYDocEnroll(request:OwnerYDocDeliveryRequest, input:OwnerYDocDeliveryTarget & {
    captured:{nativeHeadSequence:number;localStateDigest:string};journalCursor:number;hostVector:Uint8Array;checkpoint:Uint8Array
  }, signal?:AbortSignal):Promise<OwnerYDocDraftDescriptor> {
    const target=ownerDeliveryTarget(input), captured={nativeHeadSequence:input.captured.nativeHeadSequence,localStateDigest:parseLiveUpdateDigest(input.captured.localStateDigest)};
    if (!Number.isSafeInteger(captured.nativeHeadSequence) || captured.nativeHeadSequence<0 || !Number.isSafeInteger(input.journalCursor) || input.journalCursor<0 || input.hostVector.byteLength<1 || input.hostVector.byteLength>MAX_LIVE_UPDATE_BYTES || input.checkpoint.byteLength<2 || input.checkpoint.byteLength>MAX_LIVE_UPDATE_BYTES) throw new TypeError("Invalid owner enrollment cut.");
    const byteLength=input.hostVector.byteLength+input.checkpoint.byteLength;
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.enroll",byteLength+3*1024*1024,()=>{
      const bytes=Buffer.concat([input.hostVector,input.checkpoint],byteLength), digest=createHash("sha256").update(bytes).digest("hex"), streamId=this.nextLiveStreamId++;
      if (!Number.isSafeInteger(streamId)) throw new TypeError("Owner stream identifiers exhausted.");
      return {params:{...target,captured,journalCursor:input.journalCursor,hostVectorByteLength:input.hostVector.byteLength,streamId,byteLength,digest},streams:[{streamId,bytes,digest}]};
    },signal);
    if (Object.keys(response.result as object).join()!=="draft") throw new TypeError("Invalid owner enrollment response.");
    const draft=ownerDraftDescriptor((response.result as Record<string,unknown>).draft);
    if (JSON.stringify(draft.binding)!==JSON.stringify(target.binding) || draft.relayDatabaseNamespace!==target.relayDatabaseNamespace || draft.acceptedCursor!==input.journalCursor || draft.revision!==1) throw new TypeError("Owner enrollment differs from request.");
    return draft;
  }

  async ownerYDocReadState(request: OwnerYDocDeliveryRequest, target: OwnerYDocDeliveryTarget, signal?: AbortSignal): Promise<OwnerYDocDeliveryPosition & {stateVector: Buffer}> {
    const params=ownerDeliveryTarget(target);
    const output:PrivateLiveOutput={status:"state",maxBytes:MAX_LIVE_UPDATE_BYTES,started:false};
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.readState",MAX_LIVE_UPDATE_BYTES+3*1024*1024,()=>({params,streams:[]}),signal,output);
    if (Object.keys(response.result as object).sort().join()!=="acceptedCursor,byteLength,digest,nativeHeadSequence,revision,status,streamId") throw new TypeError("Invalid owner state response.");
    return {...ownerDeliveryPosition(response.result),stateVector:output.blob!.bytes};
  }

  async ownerYDocApplyAcceptedFrame(request: OwnerYDocDeliveryRequest, input: OwnerYDocDeliveryApplyInput, signal?: AbortSignal): Promise<OwnerYDocDeliveryPosition> {
    return this.ownerYDocApply(request,input,undefined,signal);
  }

  async ownerYDocApplyInitialSync(request: OwnerYDocDeliveryRequest, input: OwnerYDocDeliveryApplyInput & {readonly hostVector: Uint8Array}, signal?: AbortSignal): Promise<OwnerYDocDeliveryPosition> {
    return this.ownerYDocApply(request,input,input.hostVector,signal);
  }

  private async ownerYDocApply(request: OwnerYDocDeliveryRequest, input: OwnerYDocDeliveryApplyInput, vector: Uint8Array | undefined, signal?: AbortSignal): Promise<OwnerYDocDeliveryPosition> {
    const target=ownerDeliveryTarget(input);
    ownerDeliveryPosition({revision:input.expectedRevision,acceptedCursor:input.previousAcceptedCursor,nativeHeadSequence:input.expectedNativeHeadSequence});
    if (!Number.isSafeInteger(input.journalCursor) || input.journalCursor<input.previousAcceptedCursor || (!vector && input.journalCursor===input.previousAcceptedCursor)
      || input.updateBytes.byteLength<2 || input.updateBytes.byteLength>MAX_LIVE_UPDATE_BYTES
      || (vector && (vector.byteLength<1 || vector.byteLength>MAX_LIVE_UPDATE_BYTES))) throw new TypeError("Invalid owner accepted input.");
    const byteLength=input.updateBytes.byteLength+(vector?.byteLength??0);
    const params={...target,expectedRevision:input.expectedRevision,expectedNativeHeadSequence:input.expectedNativeHeadSequence,
      previousAcceptedCursor:input.previousAcceptedCursor,journalCursor:input.journalCursor,hostVectorByteLength:vector?.byteLength??null};
    const response=await this.sendLiveUpload(request,vector?"ydoc.ownerDelivery.applyInitialSync":"ydoc.ownerDelivery.applyAcceptedFrame",byteLength+3*1024*1024,()=>{
      const bytes=vector?Buffer.concat([vector,input.updateBytes],byteLength):Buffer.from(input.updateBytes);
      const digest=createHash("sha256").update(bytes).digest("hex"),streamId=this.nextLiveStreamId++;
      if (!Number.isSafeInteger(streamId)) throw new TypeError("Owner stream identifiers exhausted.");
      return {params:{...params,streamId,byteLength,digest},streams:[{streamId,bytes,digest}]};
    },signal);
    if (Object.keys(response.result as object).sort().join()!=="acceptedCursor,nativeHeadSequence,revision") throw new TypeError("Invalid owner apply response.");
    const position=ownerDeliveryPosition(response.result);
    if (position.acceptedCursor!==input.journalCursor || position.revision!==(input.journalCursor===input.previousAcceptedCursor?input.expectedRevision:input.expectedRevision+1)) throw new TypeError("Owner apply position differs from request.");
    return position;
  }

  async ownerYDocIsReceiptApplied(request: OwnerYDocDeliveryRequest, input: OwnerYDocDeliveryTarget & {readonly receipt:OwnerYDocDeliveryReceipt}, signal?: AbortSignal): Promise<boolean> {
    const receipt={deliveryId:parseLiveUpdateIdentifier(input.receipt.deliveryId,"delivery ID"),updateDigest:parseLiveUpdateDigest(input.receipt.updateDigest),journalCursor:input.receipt.journalCursor,acceptingHostEpoch:input.receipt.acceptingHostEpoch};
    if (!Number.isSafeInteger(receipt.journalCursor) || receipt.journalCursor<1 || !Number.isSafeInteger(receipt.acceptingHostEpoch) || receipt.acceptingHostEpoch<1) throw new TypeError("Invalid owner receipt.");
    const response=await this.sendLiveUpload(request,"ydoc.ownerDelivery.isReceiptApplied",3*1024*1024,()=>({params:{...ownerDeliveryTarget(input),receipt},streams:[]}),signal);
    const row=response.result as {applied?:unknown};
    if (!row || typeof row.applied!=="boolean" || Object.keys(row).join()!=="applied") throw new TypeError("Invalid owner receipt response.");
    return row.applied;
  }

  async captureOwnerActivation(
    request: Omit<LiveApplicationRequest, "registrationId">,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
    activationId?: string,
  ): Promise<NativeOwnerActivation> {
    if (typeof path !== "string" || path.length < 1 || path.length > 4096 || path.includes("\0") ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > this.maxBlobBytes) {
      throw new TypeError("Invalid owner activation capture bounds.");
    }
    if (activationId !== undefined && !/^ordinary-activation-[a-f0-9]{64}$/.test(activationId)) {
      throw new TypeError("Invalid retained activation ID.");
    }
    const output: PrivateLiveOutput = { status: "captured", maxBytes, started: false };
    const response = await this.sendLiveUpload(request, "liveApplication.captureOwnerActivation",
      maxBytes + 3 * 1024 * 1024, () => ({ params: { path, maxBytes, ...(activationId === undefined ? {} : {activationId}) }, streams: [] }), signal, output);
    return parseNativeOwnerActivation(response.result, output.blob!.bytes, path, maxBytes);
  }
  async openLiveAppliedSync(request:LiveApplicationRequest, clientVector:Uint8Array, bounds:{maxInputBytes:number;maxOutputBytes:number}, signal?:AbortSignal):Promise<{
    binding:LiveObjectBinding;position:NativeAppliedPosition;observedLocalYDocHeadSequence:number;hostVector:Buffer;missingStateUpdate:Buffer;
  }> {
    const {maxInputBytes,maxOutputBytes}=bounds;
    this.validateAppliedReadBounds(request,maxOutputBytes);
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes<1 || maxInputBytes>this.maxBlobBytes || clientVector.byteLength<1 || clientVector.byteLength>maxInputBytes) throw new TypeError("Invalid sync vector bounds.");
    const output:PrivateLiveOutput={status:"sync",maxBytes:maxOutputBytes,started:false};
    const response=await this.sendLiveUpload(request,"liveApplication.syncOpen",clientVector.byteLength+maxOutputBytes+3*1024*1024,()=>{
      const bytes=Buffer.from(clientVector),digest=createHash("sha256").update(bytes).digest("hex"),streamId=this.nextLiveStreamId++;
      if (!Number.isSafeInteger(streamId)) throw new TypeError("Live stream identifiers exhausted.");
      return {params:{registrationId:request.registrationId,streamId,byteLength:bytes.length,digest},streams:[{streamId,bytes,digest}]};
    },signal,output);
    const row=response.result as Record<string,unknown>,bytes=output.blob!.bytes;
    if (Object.keys(row).sort().join()!=="binding,byteLength,digest,hostVectorByteLength,observedLocalYDocHeadSequence,position,status,streamId" ||
      !Number.isSafeInteger(row.hostVectorByteLength) || (row.hostVectorByteLength as number)<1 || (row.hostVectorByteLength as number)>bytes.length-2 ||
      !Number.isSafeInteger(row.observedLocalYDocHeadSequence) || (row.observedLocalYDocHeadSequence as number)<0) throw new TypeError("Invalid applied sync response.");
    return {binding:parseLiveObjectBinding(row.binding),position:appliedPosition(row.position),observedLocalYDocHeadSequence:row.observedLocalYDocHeadSequence as number,
      hostVector:bytes.subarray(0,row.hostVectorByteLength as number),missingStateUpdate:bytes.subarray(row.hostVectorByteLength as number)};
  }
  async readNextLiveApplied(request:LiveApplicationRequest, after:NativeAppliedPosition, maxOutputBytes:number, signal?:AbortSignal):Promise<{
    position:NativeAppliedPosition;ack:LiveUpdateHostApplicationAck;updateBytes:Buffer;
  }|null> {
    this.validateAppliedReadBounds(request,maxOutputBytes);after=appliedPosition(after);
    const output:PrivateLiveOutput={status:"update",allowEmpty:true,maxBytes:maxOutputBytes,started:false};
    const response=await this.sendLiveUpload(request,"liveApplication.appliedRead",maxOutputBytes+3*1024*1024,
      ()=>({params:{registrationId:request.registrationId,after:{...after}},streams:[]}),signal,output);
    const row=response.result as Record<string,unknown>;
    if (row.status==="empty") {
      if (Object.keys(row).sort().join()!=="after,status" || JSON.stringify(appliedPosition(row.after))!==JSON.stringify(after)) throw new TypeError("Invalid empty applied read.");
      return null;
    }
    if (Object.keys(row).sort().join()!=="ack,byteLength,digest,position,status,streamId") throw new TypeError("Invalid applied update response.");
    const position=appliedPosition(row.position),ack=parseLiveUpdateHostApplicationAck(row.ack);
    if (position.eventCount!==after.eventCount+1 || position.journalCursor<=after.journalCursor || ack.journalCursor!==position.journalCursor ||
      !ack.applicationReplayed || ack.updateDigest!==output.blob!.sha256) throw new TypeError("Applied update differs from its requested position.");
    return {position,ack,updateBytes:output.blob!.bytes};
  }
  private validateAppliedReadBounds(request:LiveApplicationRequest,maxOutputBytes:number):void {
    if (!Number.isSafeInteger(request.registrationId) || request.registrationId<1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes<2 || maxOutputBytes>this.maxBlobBytes) throw new TypeError("Invalid applied read bounds.");
  }
  /** Reads retained host application evidence from an authenticated registration. */
  async readLiveApplicationAck(
    request: LiveApplicationRequest,
    identity: { readonly deliveryId: string; readonly updateDigest: string },
    signal?: AbortSignal,
  ): Promise<LiveUpdateHostApplicationAck | null> {
    const { id, workspace, registrationId, deadlineMs } = request;
    const deliveryId = parseLiveUpdateIdentifier(identity.deliveryId, "delivery ID");
    const updateDigest = parseLiveUpdateDigest(identity.updateDigest);
    if (!Number.isSafeInteger(registrationId) || registrationId < 1 || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new TypeError("Invalid application ACK request.");
    }
    const response = await this.sendRequest({ id, workspace, method: "liveApplication.ack",
      params: { registrationId, deliveryId, updateDigest }, deadlineMs }, signal);
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid application ACK response.");
    const row = result as Record<string, unknown>;
    if (row.status === "missing" && Object.keys(row).join() === "status") return null;
    if (row.status !== "applied" || Object.keys(row).sort().join() !== "ack,status") throw new Error("Invalid application ACK response.");
    const ack = parseLiveUpdateHostApplicationAck(row.ack);
    if (ack.deliveryId !== deliveryId || ack.updateDigest !== updateDigest || !ack.applicationReplayed) {
      throw new Error("Application ACK does not match the requested delivery.");
    }
    return ack;
  }

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
  // Why the client closed, kept for every request that arrives afterwards. A
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
  private readonly writeQueue = new Set<PendingWrite>();
  private writing = false;
  private ordinaryRequests = 0;
  private ordinaryRequestBytes = 0;
  private readonly writeWaiters = new Set<(error: unknown) => void>();
  private readonly liveConfig: PrivateLiveApplicationConfig | undefined;
  private liveUploadBytes = 0;
  private liveUploads = 0;
  private nextLiveStreamId = 1;

  constructor(
    private readonly connection: EngineClientConnection,
    private readonly connectOptions: EngineClientConnectOptions,
    private readonly terminate: (force?: boolean) => void = () =>
      connection.close(),
    private readonly termination: Promise<void> = Promise.resolve(),
  ) {
    this.liveConfig = capturePrivateLiveApplicationConfig(connectOptions.privateLiveApplication);
    this.maxFrameBytes =
      connectOptions.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (
      connectOptions.maxFrameBytes !== undefined &&
      (!Number.isSafeInteger(connectOptions.maxFrameBytes) ||
        connectOptions.maxFrameBytes < MIN_REQUESTABLE_MAX_FRAME_BYTES ||
        connectOptions.maxFrameBytes > MAX_U32)
    ) {
      throw new FrameCodecError(
        "frame-too-large",
        `Maximum frame bytes must be between ${MIN_REQUESTABLE_MAX_FRAME_BYTES} and ${MAX_U32}; the engine cannot honor less.`,
      );
    }
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
    this.decoder = new FrameDecoder(this.maxFrameBytes, this.maxBlobChunkBytes);
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
      // Tell the engine this client's receive limit; the engine clamps it
      // into its negotiable range and echoes the effective value in the ack.
      maxFrameBytes: connectOptions.maxFrameBytes ?? null,
    }).catch((cause: unknown) => {
      this.fail(
        new EngineClientError(
          "transport-error",
          "Failed to send engine hello.",
          {
            cause,
          },
        ),
      );
    });
  }

  ready(): Promise<EngineClient> {
    return this.readyPromise;
  }

  /**
   * `onProgress` runs each time the engine reports that this request's work
   * moved. It can run only when `reportsProgress()` is true, and only for a
   * method whose work reports (today `workspace.open`).
   */
  async sendRequest(
    request: Request,
    signal?: AbortSignal,
    onProgress?: () => void,
  ): Promise<Response> {
    return this.sendRequestWithInput(request, undefined, signal, undefined, true, onProgress);
  }

  /** Whether this session negotiated PROGRESS_CAPABILITY with the engine. */
  reportsProgress(): boolean {
    return (
      this.connectOptions.capabilities.includes(PROGRESS_CAPABILITY) &&
      (this.helloAck?.capabilities.includes(PROGRESS_CAPABILITY) ?? false)
    );
  }

  private async sendRequestWithInput(
    request: Request,
    writeInput?: (wireId: number) => Promise<void>,
    signal?: AbortSignal,
    restoreOutput?: PrivateLiveOutput,
    ordinary = false,
    onProgress?: () => void,
  ): Promise<Response> {
    const deadlineMs = request.deadlineMs ?? null;
    const expiresAt = deadlineMs === null ? null : performance.now() + deadlineMs;
    if (signal?.aborted) throw signal.reason;
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
    if (restoreOutput) restoreOutput.wireId = wireId;
    // A caller that asks on a session without the capability just hears
    // nothing; the engine would ignore the flag anyway.
    const progress = onProgress !== undefined && this.reportsProgress();
    const envelope = requestEnvelope(request, wireId, progress);
    // Measured before FRAMING. `encodeFrame` refuses an oversized payload with
    // a codec error, and every failure on the write path reads as
    // `transport-error` — which is a lie twice over: nothing was transported,
    // and the classification sends a healthy session into the reconnect
    // machinery for a failure no reconnect can fix. A request that cannot be
    // framed is the caller’s to fix, so it is refused here, by name, with the
    // limit and the size that was asked for.
    const serializedEnvelope = JSON.stringify(envelope);
    const encodedRequest = Buffer.byteLength(serializedEnvelope, "utf8");
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
    const retainedBytes = encodedRequest + FRAME_HEADER_BYTES;
    if (ordinary) {
      if (this.ordinaryRequests >= MAX_ORDINARY_REQUESTS || retainedBytes > MAX_ORDINARY_REQUEST_BYTES - this.ordinaryRequestBytes) {
        throw new EngineRequestError(request.id, { code: "OVERLOADED", message: "The engine request queue is full.", retry: "afterBackoff" });
      }
      this.ordinaryRequests++;
      this.ordinaryRequestBytes += retainedBytes;
    }
    const unsent = !writeInput ? new AbortController() : undefined;
    let transmitted = false;
    let writeTask: Promise<void> = Promise.resolve();
    let inputComplete = false;
    const cancellationError = () => writeInput
      ? new EngineClientError("closed", "Live application request was cancelled.")
      : signal?.reason;
    let cancellationSent = false;
    const abandon = (error: EngineClientError, cancel: boolean): void => {
      const pending = this.pending.get(wireId);
      this.pending.delete(wireId);
      if (pending && transmitted) this.abandonedRequestIds.add(wireId);
      if (pending?.deadlineTimer) clearTimeout(pending.deadlineTimer);
      pending?.reject(error);
      unsent?.abort(error);
      if (cancel && transmitted) void this.writeEnvelope({ type: "cancel", id: wireId }).catch(() => undefined);
    };
    const expire = (): void => abandon(new EngineRequestDeadlineError(wireId, request.method, deadlineMs!), false);
    const abort = (): void => {
      // Finish reserved input before cancelling so other requests retain valid framing.
      if ((writeInput && !inputComplete) || cancellationSent) return;
      const pending = this.pending.get(wireId);
      if (!pending && !writeInput) return;
      cancellationSent = true;
      abandon(cancellationError(), true);
    };
    const response = new Promise<Response>((resolve, reject) => {
      const deadlineTimer =
        deadlineMs !== null
          ? setTimeout(() => {
              // Give an inbound frame already queued by the transport one
              // event-loop turn to settle before expiring the request.
              setImmediate(() => {
                const pending = this.pending.get(wireId);
                if (!pending) return;
                expire();
              });
            }, Math.max(0, expiresAt! - performance.now()))
          : undefined;
      this.pending.set(wireId, {
        callerId: request.id,
        request,
        resolve,
        reject,
        ...(restoreOutput ? { restoreOutput } : {}),
        ...(deadlineTimer ? { deadlineTimer } : {}),
        ...(unsent ? { cancelUnsent: () => {
          if (transmitted) return false;
          abandon(new EngineRequestError(request.id, { code: "CANCELLED", message: "Request cancelled before transmission.", retry: "no" }), false);
          return true;
        } } : {}),
        ...(progress ? { onProgress } : {}),
      });
      signal?.addEventListener("abort", abort, { once: true });
      writeTask = this.writeFrame(() => {
        let payload = serializedEnvelope;
        if (ordinary && expiresAt !== null) {
          const remaining = Math.ceil(expiresAt - performance.now());
          if (remaining <= 0) {
            expire();
            throw new EngineRequestDeadlineError(wireId, request.method, deadlineMs!);
          }
          const captured = JSON.parse(serializedEnvelope) as Request;
          captured.deadlineMs = Math.min(deadlineMs!, remaining);
          payload = JSON.stringify(captured);
        }
        const frame = encodeFrame(FrameType.Control, 0, Buffer.from(payload, "utf8"), this.maxFrameBytes);
        if (ordinary && expiresAt !== null && performance.now() >= expiresAt) {
          expire();
          throw new EngineRequestDeadlineError(wireId, request.method, deadlineMs!);
        }
        transmitted = true;
        return frame;
      }, unsent?.signal).then(async () => {
        await writeInput?.(wireId);
        inputComplete = true;
        if (signal?.aborted) abort();
      });
      void writeTask.catch((cause: unknown) => {
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
    try {
      const result = await response;
      if (writeInput) await writeTask;
      if (writeInput && signal?.aborted) throw cancellationError();
      return result;
    } catch (error: unknown) {
      // Failed or expired input cannot leave a half-written stream on this connection.
      if (writeInput) {
        if (!inputComplete) this.close();
        await writeTask.catch(() => undefined);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (ordinary) {
        this.ordinaryRequests--;
        this.ordinaryRequestBytes -= retainedBytes;
      }
    }
  }

  /** Private admitted-event transport. The host has already provisioned registrationId. */
  async sendLiveApplication(
    request: LiveApplicationRequest,
    event: AdmittedLiveUpdate,
    signal?: AbortSignal,
  ): Promise<Response> {
    const byteLength = event.updateBytes.byteLength;
    const ranges = event.metadata.firstSeen;
    if (
      byteLength < 2 ||
      byteLength > MAX_LIVE_UPDATE_BYTES ||
      ranges.length > Math.floor((byteLength - 2) / 5)
    ) {
      throw new TypeError("Invalid live application attachment bounds.");
    }
    const accepted = parseRelayAcceptedLiveUpdate(event.metadata.accepted);
    const charge =
      byteLength + ranges.length * PACKED_LIVE_RANGE_BYTES + 3 * 1024 * 1024;
    return this.sendLiveUpload(
      request,
      "liveApplication.apply",
      charge,
      () => {
        // Capture bytes once. Caller mutations cannot change a queued upload.
        const update = Buffer.from(event.updateBytes);
        const packed = Buffer.allocUnsafe(
          ranges.length * PACKED_LIVE_RANGE_BYTES,
        );
        let previous = -1;
        let previousEnd = 0;
        for (let index = 0; index < ranges.length; index++) {
          const range = ranges[index]!;
          if (
            !Number.isSafeInteger(range.clientId) ||
            range.clientId < 0 ||
            range.clientId < previous ||
            (range.clientId === previous && range.startClock <= previousEnd) ||
            !Number.isInteger(range.startClock) ||
            range.startClock < 0 ||
            !Number.isInteger(range.endClock) ||
            range.endClock > MAX_U32 ||
            range.startClock >= range.endClock
          ) {
            throw new TypeError("Invalid live application range.");
          }
          previous = range.clientId;
          previousEnd = range.endClock;
          const offset = index * PACKED_LIVE_RANGE_BYTES;
          packed.writeBigUInt64LE(BigInt(range.clientId), offset);
          packed.writeUInt32LE(range.startClock, offset + 8);
          packed.writeUInt32LE(range.endClock, offset + 12);
        }
        if (
          createHash("sha256").update(update).digest("hex") !==
          accepted.receipt.updateDigest
        ) {
          throw new TypeError("Live application update digest mismatch.");
        }
        const rangeDigest = createHash("sha256").update(packed).digest("hex");
        const updateStreamId = this.nextLiveStreamId++;
        const rangeStreamId = this.nextLiveStreamId++;
        if (!Number.isSafeInteger(rangeStreamId))
          throw new TypeError("Live stream identifiers exhausted.");

        return {
          params: JSON.parse(
            JSON.stringify({
              accepted,
              registrationId: request.registrationId,
              rangeCount: ranges.length,
              rangeStreamId,
              rangeDigest,
              updateStreamId,
              updateByteLength: byteLength,
            }),
          ) as Request["params"],
          streams: [
            {
              streamId: updateStreamId,
              bytes: update,
              digest: accepted.receipt.updateDigest,
            },
            { streamId: rangeStreamId, bytes: packed, digest: rangeDigest },
          ],
        };
      },
      signal,
    );
  }

  /** Private baseline transport. The registration supplies the immutable binding. */
  async sendLiveBootstrap(
    request: LiveApplicationRequest,
    input: LiveApplicationBootstrap,
    signal?: AbortSignal,
  ): Promise<Response> {
    const baselineByteLength = input.baselineBytes.byteLength;
    if (baselineByteLength < 1 || baselineByteLength > MAX_LIVE_UPDATE_BYTES)
      throw new TypeError("Invalid live bootstrap attachment bounds.");
    const integer = (
      value: number,
      minimum: number,
      maximum = MAX_WIRE_INTEGER,
    ): number => {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new TypeError("Invalid live bootstrap coordinate.");
      return value;
    };
    const baseline = {
      bootstrapId: parseLiveUpdateIdentifier(input.bootstrapId, "bootstrap ID"),
      bootstrapMomentId: parseLiveUpdateIdentifier(
        input.bootstrapMomentId,
        "bootstrap moment ID",
      ),
      baselineMomentRelaySequence: integer(
        input.baselineMomentRelaySequence,
        1,
      ),
      baselineRegisteredAtMs: integer(input.baselineRegisteredAtMs, 0),
      baselineDigest: parseLiveUpdateDigest(input.baselineDigest),
      baselineByteLength,
      projectedMarkdownDigest: parseLiveUpdateDigest(
        input.projectedMarkdownDigest,
      ),
      projectedMarkdownByteLength: integer(
        input.projectedMarkdownByteLength,
        0,
        2_097_152,
      ),
    };
    return this.sendLiveUpload(
      request,
      "liveApplication.bootstrap",
      baselineByteLength + 3 * 1024 * 1024,
      () => {
        const bytes = Buffer.from(input.baselineBytes);
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          baseline.baselineDigest
        )
          throw new TypeError("Live bootstrap digest mismatch.");
        const baselineStreamId = this.nextLiveStreamId++;
        if (!Number.isSafeInteger(baselineStreamId))
          throw new TypeError("Live stream identifiers exhausted.");
        return {
          params: {
            registrationId: request.registrationId,
            baselineStreamId,
            baseline,
          },
          streams: [
            {
              streamId: baselineStreamId,
              bytes,
              digest: baseline.baselineDigest,
            },
          ],
        };
      },
      signal,
    );
  }

  async sendLiveOwnerAdoption(
    request: LiveApplicationRequest & { sessionId: string },
    cut: LiveOwnerAdoptionCut,
    bounds: { maxBytes: number; maxEvents: number },
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!Number.isSafeInteger(bounds.maxBytes) || bounds.maxBytes < 1 || !Number.isSafeInteger(bounds.maxEvents) || bounds.maxEvents < 1 ||
      cut.events.length > bounds.maxEvents || typeof request.sessionId !== "string" || !request.sessionId || request.sessionId.length > 256) {
      throw new TypeError("Invalid owner adoption bounds.");
    }
    // Reserve before serialization or copying evidence. The caller already owns the cut.
    return this.sendLiveUpload(request, "liveApplication.adoptOwner", bounds.maxBytes * 3, () => {
      const { baselineBytes, events, ...header } = cut;
      const fields: Buffer[] = [];
      let length = 0;
      const field = (value: Uint8Array): void => {
        if (value.byteLength > MAX_U32 || length + 4 + value.byteLength > bounds.maxBytes) throw new TypeError("Owner adoption byte limit exceeded.");
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32LE(value.byteLength);
        fields.push(prefix, Buffer.from(value));
        length += 4 + value.byteLength;
      };
      field(Buffer.from(JSON.stringify({ ...header, eventCount: events.length })));
      field(baselineBytes);
      for (const event of events) {
        field(Buffer.from(JSON.stringify(event.metadata)));
        field(event.updateBytes);
      }
      const bytes = Buffer.concat(fields, length);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const streamId = this.nextLiveStreamId++;
      if (!Number.isSafeInteger(streamId)) throw new TypeError("Live stream identifiers exhausted.");
      return { params: { registrationId: request.registrationId, sessionId: request.sessionId, streamId, byteLength: bytes.length, digest },
        streams: [{ streamId, bytes, digest }] };
    }, signal);
  }

  /** Bounded forwarding between the authenticated device bridge and its existing daemon. */
  async forwardLiveOwnerAdoption(
    request: LiveApplicationRequest & { sessionId: string }, bytes: Uint8Array, maxBytes: number, signal?: AbortSignal,
  ): Promise<Response> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength < 1 || bytes.byteLength > maxBytes || !request.sessionId || request.sessionId.length > 256) throw new TypeError("Invalid owner adoption forwarding bounds.");
    return this.sendLiveUpload(request, "liveApplication.adoptOwner", bytes.byteLength + 3 * 1024 * 1024, () => {
      const captured = Buffer.from(bytes), digest = createHash("sha256").update(captured).digest("hex"), streamId = this.nextLiveStreamId++;
      if (!Number.isSafeInteger(streamId)) throw new TypeError("Live stream identifiers exhausted.");
      return { params: { registrationId: request.registrationId, sessionId: request.sessionId, streamId, byteLength: captured.length, digest }, streams: [{ streamId, bytes: captured, digest }] };
    }, signal);
  }

  /** Private provisioned-host transport. Evidence is already serialized by its budgeted owner. */
  async sendLiveRestore(
    request: Omit<LiveApplicationRequest, "registrationId">,
    operation: "prepare" | "apply" | "settle" | "resume",
    bytes: Uint8Array,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ response: Response; bytes: Buffer }> {
    const status = NATIVE_RESTORE_STATUS[operation];
    if (!status || !Number.isSafeInteger(maxBytes) || maxBytes < 5 || maxBytes > this.maxBlobBytes ||
      bytes.byteLength < 5 || bytes.byteLength > maxBytes) throw new TypeError("Invalid native restore bounds.");
    const output: PrivateLiveOutput = { maxBytes, status, started: false };
    const response = await this.sendLiveUpload(request, `liveApplication.${operation}Restore`,
      bytes.byteLength + maxBytes + 3 * 1024 * 1024, () => {
        const captured = Buffer.from(bytes);
        const digest = createHash("sha256").update(captured).digest("hex");
        const streamId = this.nextLiveStreamId++;
        if (!Number.isSafeInteger(streamId)) throw new TypeError("Live stream identifiers exhausted.");
        return { params: { streamId, byteLength: captured.length, digest, maxOutputBytes: maxBytes }, streams: [{ streamId, bytes: captured, digest }] };
      }, signal, output);
    return { response, bytes: output.blob!.bytes };
  }

  private async sendLiveUpload(
    request: Omit<LiveApplicationRequest, "registrationId"> & { registrationId?: number },
    method: string,
    charge: number,
    prepare: () => LiveUpload,
    signal?: AbortSignal,
    restoreOutput?: PrivateLiveOutput,
  ): Promise<Response> {
    if (
      !this.liveConfig ||
      !this.helloAck?.capabilities.includes(BLOB_CAPABILITY)
    ) {
      throw new TypeError(
        "Private live application transport is not configured.",
      );
    }
    if (signal?.aborted) throw signal.reason;
    if (this.maxBlobChunkBytes === 0) {
      throw new TypeError("Private live application uploads require a positive blob chunk limit.");
    }
    if (
      (!restoreOutput && !["ydoc.ownerDelivery.applyAcceptedFrame","ydoc.ownerDelivery.applyInitialSync","ydoc.ownerDelivery.isReceiptApplied","ydoc.ownerDelivery.listDrafts","ydoc.ownerDelivery.appendDraft","ydoc.ownerDelivery.prepareEnrollment","ydoc.ownerDelivery.enroll"].includes(method) && (!Number.isSafeInteger(request.registrationId) ||
      request.registrationId! < 1)) ||
      !Number.isSafeInteger(request.deadlineMs) ||
      request.deadlineMs < 1 ||
      request.deadlineMs > MAX_U32
    ) {
      throw new TypeError("Invalid live application request.");
    }
    if (
      !Number.isSafeInteger(charge) || charge < 1 || this.liveUploads >= this.liveConfig.maxUploads ||
      charge > this.liveConfig.aggregateBytes - this.liveUploadBytes
    ) {
      throw new TypeError("Private live application upload capacity is full.");
    }
    this.liveUploadBytes += charge;
    this.liveUploads += 1;
    let stopped = false;
    let uploaded = false;
    const abort = (): void => {
      stopped = true;
      if (!uploaded) this.close();
    };
    // The reply timer ends when a response arrives. Keep the upload deadline
    // through the final drain so an early reply cannot strand retained input.
    const uploadDeadline = setTimeout(abort, request.deadlineMs);

    try {
      const upload = prepare();
      const outgoing: Request = {
        id: request.id, workspace: request.workspace, method, deadlineMs: request.deadlineMs,
        idempotencyKey: null, params: upload.params,
      };
      if (upload.streams.length === 0) {
        // No partial input stream exists. Cancelling this read must preserve the shared client.
        clearTimeout(uploadDeadline);
        return await this.sendRequestWithInput(outgoing, undefined, signal, restoreOutput);
      }
      const writeInput = async (wireId: number): Promise<void> => {
        const current = (): void => {
          if (
            stopped ||
            !this.pending.has(wireId) ||
            this.closed
          ) {
            throw new EngineClientError(
              "closed",
              "Live application upload is no longer current.",
            );
          }
        };
        for (const { streamId, bytes, digest } of upload.streams) {
          current();
          await this.writeEnvelope({
            type: "blobStart",
            requestId: wireId,
            streamId,
            totalBytes: bytes.byteLength,
            sha256: digest,
          });
          for (
            let offset = 0;
            offset < bytes.byteLength ||
            (offset === 0 && bytes.byteLength === 0);
            offset += this.maxBlobChunkBytes
          ) {
            const end = Math.min(
              offset + this.maxBlobChunkBytes,
              bytes.byteLength,
            );
            await this.writeFrame(() => {
              current();
              return encodeFrame(
                FrameType.BlobChunk,
                end === bytes.byteLength ? BLOB_FIN_FLAG : 0,
                { streamId, bytes: bytes.subarray(offset, end) },
                this.maxBlobChunkBytes,
              );
            });
          }
        }
        uploaded = true;
        clearTimeout(uploadDeadline);
      };

      return await this.sendRequestWithInput(
        outgoing,
        writeInput,
        signal,
        restoreOutput,
      );
    } finally {
      clearTimeout(uploadDeadline);
      if (restoreOutput?.wireId !== undefined) {
        for (const [streamId, stream] of this.blobStreams) {
          if (stream.start.requestId !== restoreOutput.wireId) continue;
          this.releaseBlobStream(streamId, stream);
          this.abandonedBlobStreamIds.add(streamId);
        }
      }
      this.liveUploadBytes -= charge;
      this.liveUploads -= 1;
    }
  }

  async cancelRequest(callerId: number): Promise<void> {
    const pending = [...this.pending.entries()].find(
      ([, request]) => request.callerId === callerId,
    );
    if (!pending) return;
    if (pending[1].cancelUnsent?.()) return;
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
  // stopped answering is a replacement, not a shutdown, and this cause is the
  // only one its in-flight callers will ever see: `notifyProcessExit` returns
  // early once the client is closed, so the process exit that follows cannot
  // re-cause these rejections. Reporting a bare `closed` here told every
  // retry-enabled caller the daemon went away on purpose, and they stayed
  // failed across a restart that was already under way.
  closeUnresponsive(): void {
    if (this.closed) return;
    // `force` because a wedged daemon must die now, not on a timer. The
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
        new EngineClientError(
          "protocol-error",
          "Engine frame decoding failed.",
          {
            cause,
          },
        ),
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
  // read its own reply as the only proof of life: the daemon writes one output
  // queue in order, so a probe can sit behind bulk egress it is not allowed to
  // overtake. Bytes arriving for anyone prove the daemon is turning.
  inboundActivity(): number {
    return this.inboundFrames;
  }

  // Requests still waiting for their answer that `match` selects, by the
  // object each caller sent. One the client cancelled or abandoned at its
  // deadline no longer counts.
  outstandingRequests(match: (request: Request) => boolean): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (match(pending.request)) count += 1;
    }
    return count;
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
      case "progress":
        this.receiveProgress(envelope.id);
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
    // The ack is the negotiated contract. A client that requested a lower
    // receive limit adopts the engine's clamped answer (the engine sizes its
    // responses to it); otherwise the engine's advertised bound caps ours.
    this.maxFrameBytes =
      this.connectOptions.maxFrameBytes !== undefined
        ? envelope.limits.maxFrameBytes
        : Math.min(this.maxFrameBytes, envelope.limits.maxFrameBytes);
    this.maxBlobChunkBytes = Math.min(
      this.maxBlobChunkBytesCap,
      envelope.limits.maxBlobChunkBytes,
    );
    this.decoder.setLimits(this.maxFrameBytes, this.maxBlobChunkBytes);
    this.helloAck = envelope;
    this.readyState = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.readyResolve(this);
  }

  // Progress only informs a waiting caller. Progress no caller is waiting for,
  // such as for a request that stopped waiting or never asked, is dropped: it
  // cannot corrupt any state, so it must not end the transport.
  private receiveProgress(id: number): void {
    const onProgress = this.pending.get(id)?.onProgress;
    if (!onProgress) return;
    try {
      onProgress();
    } catch {
      // A progress observer cannot interrupt transport dispatch.
    }
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
    // Stream ids are unique per session generation but not ordered — concurrent
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
      (typeof start.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(start.sha256))
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
    const announcedBytes = start.totalBytes ?? null;
    const restoreOutput = pendingEntry.restoreOutput;
    if (restoreOutput) {
      if (restoreOutput.started || start.streamId !== start.requestId || announcedBytes === null ||
        announcedBytes > restoreOutput.maxBytes || typeof start.sha256 !== "string") {
        throw new BlobStreamError("invalid-blob-start", "Native restore output violates its reserved bounds.");
      }
      restoreOutput.started = true;
    }
    if (
      announcedBytes !== null &&
      this.bufferedBlobBytes + announcedBytes > this.maxBlobBytes
    ) {
      throw new BlobStreamError(
        "blob-backpressure-exceeded",
        `Buffered blob bytes exceed the ${this.maxBlobBytes} byte global budget.`,
      );
    }
    const destination =
      announcedBytes === null ? null : Buffer.allocUnsafe(announcedBytes);
    if (announcedBytes !== null) this.bufferedBlobBytes += announcedBytes;
    this.blobStreams.set(start.streamId, {
      start,
      callerRequestId: pendingEntry.callerId,
      destination,
      chunks: destination === null ? [] : null,
      hash:
        start.sha256 === undefined || start.sha256 === null
          ? null
          : createHash("sha256"),
      receivedBytes: 0,
      receivedChunks: 0,
      retainedBytes: announcedBytes ?? 0,
    });
  }

  private assertBlobCapability(): void {
    // Capabilities are intersection-negotiated: blob streaming requires that the
    // client requested it and the engine acknowledged it.
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

  private receiveBlobChunk(frame: Extract<Frame, { kind: "blobChunk" }>): void {
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
    if (
      stream.destination === null &&
      this.bufferedBlobBytes + frame.payload.length > this.maxBlobBytes
    ) {
      throw new BlobStreamError(
        "blob-backpressure-exceeded",
        `Buffered blob bytes exceed the ${this.maxBlobBytes} byte global budget.`,
      );
    }
    if (stream.receivedChunks >= MAX_BLOB_CHUNKS_PER_STREAM) {
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
    if (stream.destination === null) {
      stream.chunks!.push(frame.payload);
      stream.retainedBytes += frame.payload.length;
      this.bufferedBlobBytes += frame.payload.length;
    } else {
      frame.payload.copy(stream.destination, stream.receivedBytes);
    }
    stream.hash?.update(frame.payload);
    stream.receivedBytes = receivedBytes;
    stream.receivedChunks += 1;
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

    const bytes =
      stream.destination ?? Buffer.concat(stream.chunks ?? [], receivedBytes);
    if (
      stream.hash !== null &&
      stream.hash.digest("hex") !== stream.start.sha256
    ) {
      throw new BlobStreamError(
        "blob-digest-mismatch",
        `Blob stream ${frame.streamId} does not match its announced SHA-256.`,
      );
    }

    this.releaseBlobStream(frame.streamId, stream);
    const blob: CompletedBlob = {
      requestId: stream.callerRequestId,
      streamId: stream.start.streamId,
      totalBytes: stream.start.totalBytes,
      sha256: stream.start.sha256,
      bytes,
    };
    const restoreOutput = this.pending.get(stream.start.requestId)?.restoreOutput;
    if (restoreOutput) {
      restoreOutput.blob = blob;
      return;
    }
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
    if (pending.restoreOutput) {
      const { blob, status } = pending.restoreOutput;
      const result = response.result as Record<string, unknown> | null;
      const empty = pending.restoreOutput.allowEmpty && result?.status === "empty" && !blob && !pending.restoreOutput.started;
      if (!empty && (!blob || !result || result.status !== status || result.streamId !== blob.streamId ||
        result.byteLength !== blob.bytes.length || result.digest !== blob.sha256)) {
        throw new EngineClientError("protocol-error", "Native restore response does not match its completed output.");
      }
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
      this.releaseBlobStream(streamId, stream);
    }
    pending.reject(new EngineRequestError(pending.callerId, wireError));
  }

  private releaseBlobStream(streamId: number, stream: PendingBlob): void {
    this.blobStreams.delete(streamId);
    this.bufferedBlobBytes -= stream.retainedBytes;
    this.bufferedBlobChunks -= stream.receivedChunks;
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
    return this.writeFrame(() => frame);
  }

  private writeFrame(encode: () => Buffer, signal?: AbortSignal): Promise<void> {
    let blocked = false;
    const send = (): Promise<void> => {
      if (this.closed) return Promise.reject(this.closeCause);
      return new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.connection.offDrain(drained);
          this.writeWaiters.delete(failed);
        };
        const drained = (): void => {
          cleanup();
          resolve();
        };
        const failed = (error: unknown): void => {
          cleanup();
          reject(error);
        };
        this.writeWaiters.add(failed);
        this.connection.onDrain(drained);
        try {
          if (this.connection.write(encode())) drained();
          else blocked = true;
        } catch (error) {
          failed(error);
        }
      });
    };
    if (this.closed) return Promise.reject(this.closeCause);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const removeAbort = (): void => signal?.removeEventListener("abort", abort);
      const entry: PendingWrite = {
        send: () => {
          removeAbort();
          const completion = send().then(resolve, reject);
          return blocked ? completion : null;
        },
        reject: error => { removeAbort(); reject(error); },
      };
      const abort = (): void => {
        if (this.writeQueue.delete(entry)) entry.reject(signal!.reason);
      };
      this.writeQueue.add(entry);
      signal?.addEventListener("abort", abort, { once: true });
      this.pumpWrites();
    });
  }

  private pumpWrites(): void {
    while (!this.writing && !this.closed) {
      const entry = this.writeQueue.values().next().value;
      if (!entry) return;
      this.writeQueue.delete(entry);
      this.writing = true;
      const completion = entry.send();
      if (completion) {
        void completion.then(() => {
          this.writing = false;
          this.pumpWrites();
        });
        return;
      }
      this.writing = false;
    }
  }

  private fail(error: EngineClientError, force = false): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCause = error;
    for (const entry of this.writeQueue) entry.reject(error);
    this.writeQueue.clear();
    for (const reject of [...this.writeWaiters]) reject(error);
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

  onDrain(handler: () => void): void {
    this.duplex.on("drain", handler);
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

  offDrain(handler: () => void): void {
    this.duplex.off("drain", handler);
  }

  close(): void {
    this.duplex.destroy();
  }
}

export async function createEngineClient(
  options: EngineClientSpawnOptions,
): Promise<EngineClient> {
  // Reject invalid host budgets before creating a process.
  options = { ...options, privateLiveApplication: capturePrivateLiveApplicationConfig(options.privateLiveApplication) };
  const child = spawn(options.command, options.args ?? [], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      ...options.env,
      DOHC_ENGINE_LIVE_HOST_CONFIG: options.env?.DOHC_ENGINE_LIVE_HOST_CONFIG,
      [ENGINE_AUTH_TOKEN_ENV]: options.authToken,
      DOHC_ENGINE_AUTHOR_CONTEXT_SECRET: options.authorContextSecret,
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
