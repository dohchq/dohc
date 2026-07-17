// Dormant R13b transport for the future Rust workspace-engine sidecar.
// No shipping desktop entry point imports this module; process creation happens
// only through createEngineClient, and the later cutover owns that wiring.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import type {
  EngineTransport,
  Envelope,
  Event,
  Request,
  Response,
  WireError,
} from "@dohc/workspace-engine-client";

const FRAME_MAGIC = Buffer.from("DOP1", "ascii");
const FRAME_HEADER_BYTES = 12;
const MAX_U32 = 0xffff_ffff;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const ENGINE_AUTH_TOKEN_ENV = "DOHC_ENGINE_AUTH_TOKEN";

export const enum FrameType {
  Control = 1,
  BlobChunk = 2,
}

export type Frame = { kind: "control"; payload: Buffer };

export type FrameCodecErrorCode =
  | "bad-magic"
  | "frame-too-large"
  | "invalid-flags"
  | "non-zero-reserved"
  | "truncated-frame"
  | "unsupported-frame"
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
  type: FrameType,
  flags: number,
  payload: Buffer,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
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
  if (type === FrameType.BlobChunk) {
    throw new FrameCodecError(
      "unsupported-frame",
      "BlobChunk streaming is deferred and is not supported by this adapter build.",
    );
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
  if (payload.length > maxFrameBytes || payload.length > MAX_U32) {
    throw new FrameCodecError(
      "frame-too-large",
      `Control frame payload is ${payload.length} bytes; maximum is ${maxFrameBytes}.`,
    );
  }

  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  FRAME_MAGIC.copy(frame, 0);
  frame[4] = type;
  frame[5] = flags;
  frame.writeUInt16LE(0, 6);
  frame.writeUInt32LE(payload.length, 8);
  payload.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private payload: Buffer | null = null;
  private payloadBytes = 0;
  private poisoned: FrameCodecError | null = null;

  constructor(private maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.assertValidLimit(maxFrameBytes);
  }

  setMaxFrameBytes(maxFrameBytes: number): void {
    this.assertHealthy();
    this.assertValidLimit(maxFrameBytes);
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): Frame[] {
    this.assertHealthy();
    const frames: Frame[] = [];
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    try {
      while (offset < bytes.length) {
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
            frames.push({ kind: "control", payload: Buffer.alloc(0) });
            this.resetFrame();
          }
        }

        if (this.payload !== null && this.payload.length > 0) {
          const count = Math.min(
            this.payload.length - this.payloadBytes,
            bytes.length - offset,
          );
          bytes.copy(this.payload, this.payloadBytes, offset, offset + count);
          this.payloadBytes += count;
          offset += count;
          if (this.payloadBytes === this.payload.length) {
            frames.push({ kind: "control", payload: this.payload });
            this.resetFrame();
          }
        }
      }
      return frames;
    } catch (error) {
      throw this.poison(error);
    }
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
    if (type === FrameType.BlobChunk) {
      throw new FrameCodecError(
        "unsupported-frame",
        "BlobChunk streaming is deferred and is not supported by this adapter build.",
      );
    }
    if (type !== FrameType.Control) {
      throw new FrameCodecError(
        "unknown-frame-type",
        `Unknown frame type: ${type}.`,
      );
    }
    if (flags !== 0) {
      throw new FrameCodecError(
        "invalid-flags",
        "Control frames must have zero flags.",
      );
    }
    const payloadLength = this.header.readUInt32LE(8);
    if (payloadLength > this.maxFrameBytes) {
      throw new FrameCodecError(
        "frame-too-large",
        `Control frame payload is ${payloadLength} bytes; maximum is ${this.maxFrameBytes}.`,
      );
    }
    // Header-derived bounds are now proven, so this is the first point at
    // which allocating the peer-advertised payload is safe.
    this.payload = Buffer.allocUnsafe(payloadLength);
    this.payloadBytes = 0;
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
  onStderr?: (text: string) => void;
}

export interface EngineClientConnectOptions {
  authToken: string;
  protocolVersion: number;
  capabilities: string[];
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
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
}

type HelloAckEnvelope = Extract<Envelope, { type: "helloAck" }>;

export class EngineClient implements EngineTransport {
  private readonly decoder: FrameDecoder;
  private readonly eventHandlers = new Set<(event: Event) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });
  private readonly readyPromise: Promise<EngineClient>;
  private readyResolve!: (client: EngineClient) => void;
  private readyReject!: (error: EngineClientError) => void;
  private nextRequestId = 1;
  private readyState = false;
  private closed = false;
  private maxFrameBytes: number;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  helloAck: HelloAckEnvelope | undefined;

  constructor(
    private readonly connection: EngineClientConnection,
    private readonly connectOptions: EngineClientConnectOptions,
    private readonly terminate: () => void = () => connection.close(),
  ) {
    this.maxFrameBytes =
      connectOptions.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.decoder = new FrameDecoder(this.maxFrameBytes);
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
      throw new EngineClientError("closed", "The engine client is closed.");
    }
    if (!this.readyState) {
      throw new EngineClientError(
        "handshake-incomplete",
        "The engine client cannot send requests before helloAck.",
      );
    }

    const wireId = this.nextRequestId++;
    return new Promise<Response>((resolve, reject) => {
      this.pending.set(wireId, { callerId: request.id, resolve, reject });
      void this.writeEnvelope({
        type: "request",
        ...request,
        id: wireId,
        workspace: request.workspace ?? null,
        deadlineMs: request.deadlineMs ?? null,
        idempotencyKey: request.idempotencyKey ?? null,
      }).catch((cause: unknown) => {
        const pending = this.pending.get(wireId);
        if (!pending) return;
        this.pending.delete(wireId);
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

  onEvent(handler: (event: Event) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.fail(new EngineClientError("closed", "The engine client was closed."));
  }

  dispose(): void {
    this.close();
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
      for (const frame of this.decoder.push(chunk)) this.receiveFrame(frame);
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

  private receiveFrame(frame: Frame): void {
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
      default:
        throw new EngineClientError(
          "protocol-error",
          `Unexpected inbound envelope type: ${envelope.type}.`,
        );
    }
  }

  private acceptHelloAck(envelope: HelloAckEnvelope): void {
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
      envelope.limits.maxFrameBytes < 0 ||
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
    this.maxFrameBytes = Math.min(
      this.maxFrameBytes,
      envelope.limits.maxFrameBytes,
    );
    this.decoder.setMaxFrameBytes(this.maxFrameBytes);
    this.helloAck = envelope;
    this.readyState = true;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.readyResolve(this);
  }

  private resolveResponse(response: Response): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      throw new EngineClientError(
        "protocol-error",
        `Received response for unknown request ${response.id}.`,
      );
    }
    this.pending.delete(response.id);
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
      throw new EngineClientError(
        "protocol-error",
        `Received error for unknown request ${id}.`,
      );
    }
    this.pending.delete(id);
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

  private fail(error: EngineClientError): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = false;
    if (this.connectTimer !== undefined) clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    this.connection.offData(this.handleData);
    this.connection.offError(this.handleStreamError);
    this.connection.offClose(this.handleStreamClose);
    this.readyReject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try {
      this.terminate();
    } catch {
      this.connection.close();
    }
  }
}

class DuplexEngineClientConnection implements EngineClientConnection {
  constructor(private readonly duplex: Duplex) {}

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
  const clientConnection = new DuplexEngineClientConnection(connection);
  const client = new EngineClient(
    clientConnection,
    options,
    () => {
      connection.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
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
  child.on("exit", (code, signal) => client.notifyProcessExit(code, signal));

  try {
    await client.ready();
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
