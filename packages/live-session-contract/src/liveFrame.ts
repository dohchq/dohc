import { parseHostEpoch, type HostEpoch } from "./hostControl.js";
import {
  LIVE_OBJECT_BINDING_IDENTIFIER_MAX_BYTES,
  LIVE_OBJECT_BINDING_PATH_MAX_BYTES,
  LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT,
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "./liveObjectBinding.js";
import {
  LIVE_UPDATE_IDENTIFIER_MAX_BYTES,
  parseLiveUpdateDigest,
  parseLiveUpdateHostApplicationAck,
  parseLiveUpdateIdentifier,
  parseLiveUpdateRefusal,
  parseLiveUpdateRetry,
  type LiveUpdateHostApplicationAck,
  type LiveUpdateRefusal,
  type LiveUpdateRetry,
} from "./liveUpdateAdmission.js";

export const LIVE_FRAME_HEADER_BYTES = 12;
// RESULT success: header + string length/identifier + digest + tag + three u64 + bool.
export const LIVE_FRAME_MINIMUM_MAX_BYTES = 12 + 4 + LIVE_UPDATE_IDENTIFIER_MAX_BYTES + 32 + 1 + 24 + 1;

export interface LiveFrameReceivePolicy {
  readonly maxFrameBytes: number;
  readonly maxStateVectorBytes: number;
  readonly maxUpdateBytes: number;
  readonly maxSyncBytes: number;
}
export type LiveFrameBegin = {
  readonly kind: "begin";
  readonly transferId: number;
  readonly totalBytes: number;
  readonly digest: string;
} & (
  | { readonly purpose: "client-vector" }
  | { readonly purpose: "initial-sync"; readonly appliedThroughJournalCursor: number }
  | { readonly purpose: "submit-update"; readonly deliveryId: string }
  | { readonly purpose: "applied-update"; readonly journalCursor: number }
);
export type LiveFrame =
  | { readonly kind: "welcome"; readonly hostEpoch: HostEpoch; readonly receivePolicy: LiveFrameReceivePolicy }
  | { readonly kind: "hello"; readonly receivePolicy: LiveFrameReceivePolicy }
  | LiveFrameBegin
  | { readonly kind: "chunk"; readonly transferId: number; readonly offset: number; readonly bytes: Uint8Array }
  | { readonly kind: "credit"; readonly grantedBytes: number; readonly grantedFrames: number }
  | { readonly kind: "sync-applied"; readonly appliedThroughJournalCursor: number }
  | { readonly kind: "result"; readonly result: "success"; readonly ack: LiveUpdateHostApplicationAck }
  | { readonly kind: "result"; readonly result: "refused"; readonly deliveryId: string; readonly updateDigest: string; readonly reason: LiveUpdateRefusal }
  | { readonly kind: "result"; readonly result: "retry"; readonly deliveryId: string; readonly updateDigest: string; readonly reason: LiveUpdateRetry }
  | { readonly kind: "close"; readonly reason: "normal" | "protocol-invalid" | "route-fenced" | "resource-unavailable" | "idle" | "shutdown" };

export class LiveFrameError extends Error {
  constructor(readonly reason: "invalid" | "limit" | "state" | "credit" | "closed") {
    super(`Live frame ${reason}.`);
    this.name = "LiveFrameError";
  }
}
function requireFrame(condition: unknown, reason: LiveFrameError["reason"] = "invalid"): asserts condition {
  if (!condition) throw new LiveFrameError(reason);
}
function integer(value: unknown, positive = false): number {
  requireFrame(typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0));
  return value;
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  requireFrame(typeof value === "object" && value !== null && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireFrame(prototype === Object.prototype || prototype === null);
  const keys = Reflect.ownKeys(value);
  requireFrame(keys.length === fields.length && keys.every(key => typeof key === "string" && fields.includes(key)));
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    requireFrame(descriptor && "value" in descriptor);
    result[field] = descriptor.value;
  }
  return result;
}
function discriminant(value: unknown, field: string): unknown {
  requireFrame(typeof value === "object" && value !== null);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  requireFrame(descriptor && "value" in descriptor);
  return descriptor.value;
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
function byteView(value: unknown): Uint8Array {
  requireFrame(value instanceof Uint8Array);
  try {
    const buffer = bufferGetter.call(value) as ArrayBuffer;
    arrayBufferLength.call(buffer); // Reject SharedArrayBuffer without reading caller properties.
    return new Uint8Array(buffer, offsetGetter.call(value), lengthGetter.call(value));
  } catch { throw new LiveFrameError("invalid"); }
}
const policyFields = ["maxFrameBytes", "maxStateVectorBytes", "maxUpdateBytes", "maxSyncBytes"] as const;
function policy(value: unknown): LiveFrameReceivePolicy {
  const source = record(value, policyFields);
  const parsed = Object.fromEntries(policyFields.map(field => [field, integer(source[field], true)])) as unknown as LiveFrameReceivePolicy;
  requireFrame(parsed.maxFrameBytes >= LIVE_FRAME_MINIMUM_MAX_BYTES && parsed.maxFrameBytes <= 0xffff_ffff + 12);
  return parsed;
}
const refusalCodes: Record<LiveUpdateRefusal, number> = {
  "invalid-update": 1, "authority-refused": 2, "stale-session": 3,
  "stale-binding": 4, "restore-fenced": 5, "provenance-refused": 6,
  "baseline-missing": 7, "delivery-conflict": 8, "capacity-refused": 9,
};
const retryCodes: Record<LiveUpdateRetry, number> = {
  "admission-unavailable": 1, "host-unavailable": 2, "application-pending": 3,
};
const closeCodes = { normal: 0, "protocol-invalid": 1, "route-fenced": 2, "resource-unavailable": 3, idle: 4, shutdown: 5 } as const;
const purposeCodes = { "client-vector": 1, "initial-sync": 2, "submit-update": 3, "applied-update": 4 } as const;
const kindCodes = { welcome: 1, hello: 2, begin: 3, chunk: 4, credit: 5, "sync-applied": 6, result: 7, close: 8 } as const;
function fromCode<T extends string>(codes: Record<T, number>, code: number): T {
  const found = (Object.keys(codes) as T[]).find(key => codes[key] === code);
  requireFrame(found !== undefined);
  return found;
}

function snapshotFrame(value: unknown): LiveFrame {
  requireFrame(typeof value === "object" && value !== null && !Array.isArray(value));
  const keys = Reflect.ownKeys(value);
  requireFrame(keys.length <= 8 && keys.every(key => typeof key === "string"));
  value = record(value, keys as string[]);
  const kind = discriminant(value, "kind");
  switch (kind) {
    case "welcome": {
      const r = record(value, ["kind", "hostEpoch", "receivePolicy"]);
      return { kind, hostEpoch: parseHostEpoch(r.hostEpoch), receivePolicy: policy(r.receivePolicy) };
    }
    case "hello": return { kind, receivePolicy: policy(record(value, ["kind", "receivePolicy"]).receivePolicy) };
    case "begin": {
      const purpose = discriminant(value, "purpose");
      requireFrame(typeof purpose === "string" && Object.hasOwn(purposeCodes, purpose));
      const extra = purpose === "initial-sync" ? ["appliedThroughJournalCursor"] : purpose === "submit-update" ? ["deliveryId"] : purpose === "applied-update" ? ["journalCursor"] : [];
      const r = record(value, ["kind", "purpose", "transferId", "totalBytes", "digest", ...extra]);
      const common = { kind, transferId: integer(r.transferId, true), totalBytes: integer(r.totalBytes, true), digest: parseLiveUpdateDigest(r.digest) } as const;
      if (purpose === "initial-sync") return { ...common, purpose, appliedThroughJournalCursor: integer(r.appliedThroughJournalCursor) };
      if (purpose === "submit-update") return { ...common, purpose, deliveryId: parseLiveUpdateIdentifier(r.deliveryId) };
      if (purpose === "applied-update") return { ...common, purpose, journalCursor: integer(r.journalCursor, true) };
      return { ...common, purpose: "client-vector" };
    }
    case "chunk": {
      const r = record(value, ["kind", "transferId", "offset", "bytes"]);
      const bytes = byteView(r.bytes);
      requireFrame(bytes.length > 0);
      return { kind, transferId: integer(r.transferId, true), offset: integer(r.offset), bytes };
    }
    case "credit": {
      const r = record(value, ["kind", "grantedBytes", "grantedFrames"]);
      return { kind, grantedBytes: integer(r.grantedBytes), grantedFrames: integer(r.grantedFrames) };
    }
    case "sync-applied": return { kind, appliedThroughJournalCursor: integer(record(value, ["kind", "appliedThroughJournalCursor"]).appliedThroughJournalCursor) };
    case "result": {
      const result = discriminant(value, "result");
      if (result === "success") {
        const r = record(value, ["kind", "result", "ack"]);
        const ack = record(r.ack, ["deliveryId", "updateDigest", "journalCursor", "acceptingHostEpoch", "localYDocSequence", "applicationReplayed"]);
        return { kind, result, ack: parseLiveUpdateHostApplicationAck(ack) };
      }
      requireFrame(result === "refused" || result === "retry");
      const r = record(value, ["kind", "result", "deliveryId", "updateDigest", "reason"]);
      const common = { kind, deliveryId: parseLiveUpdateIdentifier(r.deliveryId), updateDigest: parseLiveUpdateDigest(r.updateDigest) } as const;
      return result === "refused" ? { ...common, result, reason: parseLiveUpdateRefusal(r.reason) } : { ...common, result, reason: parseLiveUpdateRetry(r.reason) };
    }
    case "close": {
      const reason = record(value, ["kind", "reason"]).reason;
      requireFrame(typeof reason === "string" && Object.hasOwn(closeCodes, reason));
      return { kind, reason: reason as keyof typeof closeCodes };
    }
    default: throw new LiveFrameError("invalid");
  }
}

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
class Writer {
  offset = 0;
  constructor(readonly limit: number, readonly bytes?: Uint8Array) {}
  room(size: number) { requireFrame(size <= this.limit - this.offset, "limit"); }
  number(value: number, width: 1 | 2 | 4 | 8) {
    this.room(width);
    if (this.bytes) {
      const view = new DataView(this.bytes.buffer);
      if (width === 8) view.setBigUint64(this.offset, BigInt(value));
      else if (width === 4) view.setUint32(this.offset, value);
      else if (width === 2) view.setUint16(this.offset, value);
      else view.setUint8(this.offset, value);
    }
    this.offset += width;
  }
  raw(bytes: Uint8Array) { this.room(bytes.length); this.bytes?.set(bytes, this.offset); this.offset += bytes.length; }
  string(value: string) { const bytes = utf8.encode(value); this.number(bytes.length, 4); this.raw(bytes); }
  digest(value: string) { for (let n = 0; n < 64; n += 2) this.number(Number.parseInt(value.slice(n, n + 2), 16), 1); }
  blob(value: Uint8Array) { this.number(value.length, 8); this.raw(value); }
}
function writeBytes(limit: number, write: (writer: Writer) => void): Uint8Array {
  const size = new Writer(limit);
  write(size);
  const bytes = new Uint8Array(size.offset);
  write(new Writer(size.offset, bytes));
  return bytes;
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  raw(size: number) {
    requireFrame(size <= this.bytes.length - this.offset);
    const result = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return result;
  }
  number(width: 1 | 2 | 4 | 8): number {
    const bytes = this.raw(width);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (width === 8) { const value = view.getBigUint64(0); requireFrame(value <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(value); }
    return width === 4 ? view.getUint32(0) : width === 2 ? view.getUint16(0) : view.getUint8(0);
  }
  string(max: number) {
    const size = this.number(4);
    requireFrame(size <= max, "limit");
    const bytes = this.raw(size);
    let value: string;
    try { value = strictUtf8.decode(bytes); } catch { throw new LiveFrameError("invalid"); }
    requireFrame(equalBytes(bytes, utf8.encode(value)));
    return value;
  }
  digest() { return Array.from(this.raw(32), byte => byte.toString(16).padStart(2, "0")).join(""); }
  blob(max: number) { const size = this.number(8); requireFrame(size > 0 && size <= max, "limit"); return this.raw(size).slice(); }
  end() { requireFrame(this.offset === this.bytes.length); }
}
function equalBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function writePolicy(w: Writer, p: LiveFrameReceivePolicy) { for (const field of policyFields) w.number(p[field], 8); }
function readPolicy(r: Reader) { return policy(Object.fromEntries(policyFields.map(field => [field, r.number(8)]))); }
function payload(w: Writer, frame: LiveFrame) {
  switch (frame.kind) {
    case "welcome": w.number(frame.hostEpoch, 8); writePolicy(w, frame.receivePolicy); break;
    case "hello": writePolicy(w, frame.receivePolicy); break;
    case "begin":
      w.number(frame.transferId, 8); w.number(purposeCodes[frame.purpose], 1); w.number(frame.totalBytes, 8); w.digest(frame.digest);
      if (frame.purpose === "initial-sync") w.number(frame.appliedThroughJournalCursor, 8);
      if (frame.purpose === "submit-update") w.string(frame.deliveryId);
      if (frame.purpose === "applied-update") w.number(frame.journalCursor, 8);
      break;
    case "chunk": w.number(frame.transferId, 8); w.number(frame.offset, 8); w.raw(frame.bytes); break;
    case "credit": w.number(frame.grantedBytes, 8); w.number(frame.grantedFrames, 8); break;
    case "sync-applied": w.number(frame.appliedThroughJournalCursor, 8); break;
    case "result": {
      const identity = frame.result === "success" ? frame.ack : frame;
      w.string(identity.deliveryId); w.digest(identity.updateDigest);
      if (frame.result === "success") {
        w.number(1, 1); w.number(frame.ack.journalCursor, 8); w.number(frame.ack.acceptingHostEpoch, 8);
        w.number(frame.ack.localYDocSequence, 8); w.number(frame.ack.applicationReplayed ? 1 : 0, 1);
      } else { w.number(frame.result === "refused" ? 2 : 3, 1); w.number(frame.result === "refused" ? refusalCodes[frame.reason] : retryCodes[frame.reason], 1); }
      break;
    }
    case "close": w.number(closeCodes[frame.reason], 1); break;
  }
}
function encodeOwned(frame: LiveFrame, maxFrameBytes: number) {
  const measure = new Writer(Math.min(maxFrameBytes - 12, 0xffff_ffff));
  payload(measure, frame);
  return writeBytes(maxFrameBytes, w => {
    w.number(0x444c4956, 4); w.number(1, 1); w.number(kindCodes[frame.kind], 1); w.number(0, 2); w.number(measure.offset, 4);
    payload(w, frame);
  });
}
export function encodeLiveFrame(value: LiveFrame, maxFrameBytes: number): Uint8Array {
  integer(maxFrameBytes, true);
  return encodeOwned(snapshotFrame(value), maxFrameBytes);
}
function decodeFrame(value: Uint8Array, maxFrameBytes: number, copyChunk: boolean): LiveFrame {
  integer(maxFrameBytes, true);
  const bytes = byteView(value);
  requireFrame(bytes.length <= maxFrameBytes, "limit");
  const r = new Reader(bytes);
  requireFrame(r.number(4) === 0x444c4956 && r.number(1) === 1);
  const kind = fromCode(kindCodes, r.number(1));
  requireFrame(r.number(2) === 0 && r.number(4) === bytes.length - 12);
  let frame: LiveFrame;
  switch (kind) {
    case "welcome": frame = { kind, hostEpoch: parseHostEpoch(r.number(8)), receivePolicy: readPolicy(r) }; break;
    case "hello": frame = { kind, receivePolicy: readPolicy(r) }; break;
    case "begin": {
      const transferId = integer(r.number(8), true);
      const purpose = fromCode(purposeCodes, r.number(1));
      const common = { kind, transferId, totalBytes: integer(r.number(8), true), digest: r.digest() } as const;
      if (purpose === "initial-sync") frame = { ...common, purpose, appliedThroughJournalCursor: r.number(8) };
      else if (purpose === "submit-update") frame = { ...common, purpose, deliveryId: parseLiveUpdateIdentifier(r.string(LIVE_UPDATE_IDENTIFIER_MAX_BYTES)) };
      else if (purpose === "applied-update") frame = { ...common, purpose, journalCursor: integer(r.number(8), true) };
      else frame = { ...common, purpose };
      break;
    }
    case "chunk": {
      const transferId = integer(r.number(8), true); const offset = r.number(8);
      const data = r.raw(bytes.length - r.offset);
      requireFrame(data.length > 0);
      frame = { kind, transferId, offset, bytes: copyChunk ? data.slice() : data }; break;
    }
    case "credit": frame = { kind, grantedBytes: r.number(8), grantedFrames: r.number(8) }; break;
    case "sync-applied": frame = { kind, appliedThroughJournalCursor: r.number(8) }; break;
    case "result": {
      const deliveryId = parseLiveUpdateIdentifier(r.string(LIVE_UPDATE_IDENTIFIER_MAX_BYTES));
      const updateDigest = r.digest(); const tag = r.number(1);
      if (tag === 1) {
        const journalCursor = r.number(8), acceptingHostEpoch = r.number(8), localYDocSequence = r.number(8), replay = r.number(1);
        requireFrame(replay <= 1);
        frame = { kind, result: "success", ack: parseLiveUpdateHostApplicationAck({ deliveryId, updateDigest, journalCursor, acceptingHostEpoch, localYDocSequence, applicationReplayed: replay === 1 }) };
      } else if (tag === 2) frame = { kind, result: "refused", deliveryId, updateDigest, reason: fromCode(refusalCodes, r.number(1)) };
      else { requireFrame(tag === 3); frame = { kind, result: "retry", deliveryId, updateDigest, reason: fromCode(retryCodes, r.number(1)) }; }
      break;
    }
    case "close": frame = { kind, reason: fromCode(closeCodes, r.number(1)) }; break;
  }
  r.end();
  return frame;
}
export function decodeLiveFrame(value: Uint8Array, maxFrameBytes: number): LiveFrame {
  return decodeFrame(value, maxFrameBytes, true);
}

export interface LiveFrameSync {
  readonly binding: LiveObjectBinding;
  readonly hostVector: Uint8Array;
  readonly missingStateUpdate: Uint8Array;
}
const bindingFields = ["workspaceId", "mainVersionId", "objectId", "lineageClaimId", "currentPath", "selectorPaths", "restoreFenceGeneration"] as const;
function bindingSnapshot(value: unknown) {
  const result = record(value, bindingFields);
  const paths = result.selectorPaths;
  requireFrame(Array.isArray(paths) && Object.getPrototypeOf(paths) === Array.prototype);
  const count = integer(Object.getOwnPropertyDescriptor(paths, "length")?.value, true);
  requireFrame(count <= LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT && Reflect.ownKeys(paths).length === count + 1);
  result.selectorPaths = Array.from({ length: count }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(paths, String(index));
    requireFrame(descriptor && "value" in descriptor); return descriptor.value;
  });
  return parseLiveObjectBinding(result);
}
function writeBinding(w: Writer, b: LiveObjectBinding) {
  w.string(b.workspaceId); w.string(b.mainVersionId); w.string(b.objectId); w.string(b.lineageClaimId); w.string(b.currentPath);
  w.number(b.selectorPaths.length, 4); for (const path of b.selectorPaths) w.string(path);
  w.number(b.restoreFenceGeneration, 8);
}
export function encodeLiveFrameSync(value: LiveFrameSync, receivePolicy: LiveFrameReceivePolicy): Uint8Array {
  const p = policy(receivePolicy); const r = record(value, ["binding", "hostVector", "missingStateUpdate"]);
  const binding = bindingSnapshot(r.binding), vector = byteView(r.hostVector), update = byteView(r.missingStateUpdate);
  requireFrame(vector.length > 0 && vector.length <= p.maxStateVectorBytes && update.length > 0 && update.length <= p.maxSyncBytes, "limit");
  return writeBytes(p.maxSyncBytes, w => { writeBinding(w, binding); w.blob(vector); w.blob(update); });
}
export function decodeLiveFrameSync(value: Uint8Array, receivePolicy: LiveFrameReceivePolicy): LiveFrameSync {
  const p = policy(receivePolicy), bytes = byteView(value);
  requireFrame(bytes.length <= p.maxSyncBytes, "limit");
  const r = new Reader(bytes), id = () => r.string(LIVE_OBJECT_BINDING_IDENTIFIER_MAX_BYTES), path = () => r.string(LIVE_OBJECT_BINDING_PATH_MAX_BYTES);
  const workspaceId = id(), mainVersionId = id(), objectId = id(), lineageClaimId = id(), currentPath = path();
  const count = r.number(4);
  requireFrame(count > 0 && count <= LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT, "limit");
  const selectorPaths = Array.from({ length: count }, path), restoreFenceGeneration = r.number(8);
  const bindingEnd = r.offset;
  const binding = parseLiveObjectBinding({ workspaceId, mainVersionId, objectId, lineageClaimId, currentPath, selectorPaths, restoreFenceGeneration });
  requireFrame(equalBytes(bytes.subarray(0, bindingEnd), writeBytes(bindingEnd, w => writeBinding(w, binding))));
  const hostVector = r.blob(p.maxStateVectorBytes), missingStateUpdate = r.blob(p.maxSyncBytes);
  r.end(); return { binding, hostVector, missingStateUpdate };
}

export interface LiveFrameSessionPolicy {
  readonly receive: LiveFrameReceivePolicy;
  /** Queue and control bounds apply separately to each direction. */
  readonly maxQueuedBytes: number;
  readonly maxQueuedFrames: number;
  readonly maxControlBytes: number;
  readonly maxControlFrames: number;
  readonly maxAssemblyBytes: number;
}
/** release relinquishes the value; callers must stop retaining or using it afterward. */
export interface LiveFrameLease<T> { readonly value: T; release(): void }
export interface LiveFrameTransfer {
  readonly begin: LiveFrameBegin;
  /** Opaque, unverified bytes. The consumer must verify the digest before use. */
  readonly bytes: Uint8Array;
}
export interface LiveFrameReceived {
  readonly frame: LiveFrame;
  readonly transfer?: LiveFrameLease<LiveFrameTransfer>;
}
type Side = "client" | "server";
interface Direction {
  greeted: boolean;
  receivePolicy?: LiveFrameReceivePolicy;
  nextTransferId: number;
  active?: { begin: LiveFrameBegin; offset: number; bytes?: Uint8Array };
  grantedBytes: number;
  grantedFrames: number;
  chargedBytes: number;
  chargedFrames: number;
  queuedBytes: number;
  queuedFrames: number;
  controlBytes: number;
  controlFrames: number;
}
function direction(): Direction {
  return { greeted: false, nextTransferId: 1, grantedBytes: 0, grantedFrames: 0, chargedBytes: 0, chargedFrames: 0, queuedBytes: 0, queuedFrames: 0, controlBytes: 0, controlFrames: 0 };
}
function opposite(side: Side): Side { return side === "client" ? "server" : "client"; }

/**
 * One ordered duplex route. The transport owns its borrowed receive buffer separately.
 * Queue accounting covers one owned frame; assembly accounting covers its copied chunks.
 * Callers own hashing and durable effects. A decoded RESULT proves neither.
 */
export function createLiveFrameSession(role: Side, input: LiveFrameSessionPolicy) {
  requireFrame(role === "client" || role === "server");
  const raw = record(input, ["receive", "maxQueuedBytes", "maxQueuedFrames", "maxControlBytes", "maxControlFrames", "maxAssemblyBytes"]);
  const limits: LiveFrameSessionPolicy = {
    receive: policy(raw.receive), maxQueuedBytes: integer(raw.maxQueuedBytes, true), maxQueuedFrames: integer(raw.maxQueuedFrames, true),
    maxControlBytes: integer(raw.maxControlBytes, true), maxControlFrames: integer(raw.maxControlFrames, true), maxAssemblyBytes: integer(raw.maxAssemblyBytes, true),
  };
  requireFrame(limits.maxControlBytes >= LIVE_FRAME_MINIMUM_MAX_BYTES && limits.maxQueuedBytes >= LIVE_FRAME_MINIMUM_MAX_BYTES);
  requireFrame(limits.maxAssemblyBytes >= Math.max(limits.receive.maxUpdateBytes,
    role === "client" ? limits.receive.maxSyncBytes : limits.receive.maxStateVectorBytes));
  const sides = { client: direction(), server: direction() };
  let terminal = false, vectorDone = false, syncDone = false, live = false, syncCursor = 0, assemblyBytes = 0;
  let pending: { deliveryId: string; updateDigest: string; complete: boolean } | undefined;
  function lease<T>(value: T, relinquish: () => void): LiveFrameLease<T> {
    let held = true;
    const release = () => { if (!held) return; held = false; relinquish(); };
    return { value, release };
  }
  function close() {
    if (terminal) return;
    terminal = true;
    for (const state of Object.values(sides)) {
      if (state.active?.bytes) assemblyBytes -= state.active.begin.totalBytes;
      state.active = undefined;
      state.grantedBytes = state.chargedBytes; state.grantedFrames = state.chargedFrames;
    }
    // Consumer-owned completed transfers and in-flight frames stay charged until released.
  }
  function checkOpen() { requireFrame(!terminal, "closed"); }
  function maximum(begin: LiveFrameBegin, p: LiveFrameReceivePolicy) {
    return begin.purpose === "client-vector" ? p.maxStateVectorBytes : begin.purpose === "initial-sync" ? p.maxSyncBytes : p.maxUpdateBytes;
  }
  function preflightChunk(sender: Side, frame: Extract<LiveFrame, { kind: "chunk" }>, size: number) {
    const state = sides[sender], peer = sides[opposite(sender)];
    requireFrame(state.greeted && peer.greeted, "state");
    requireFrame(size <= state.grantedBytes - state.chargedBytes && state.chargedFrames < state.grantedFrames, "credit");
    const active = state.active;
    requireFrame(active && frame.transferId === active.begin.transferId && frame.offset === active.offset && frame.bytes.length <= active.begin.totalBytes - active.offset, "state");
    return active;
  }
  function transition(sender: Side, frame: LiveFrame, size: number): LiveFrameLease<LiveFrameTransfer> | undefined {
    const state = sides[sender], peer = sides[opposite(sender)];
    Object.freeze(frame);
    if (frame.kind === "welcome" || frame.kind === "hello") Object.freeze(frame.receivePolicy);
    if (frame.kind === "result" && frame.result === "success") Object.freeze(frame.ack);
    if (frame.kind === "welcome" || frame.kind === "hello") {
      requireFrame(!state.greeted && (frame.kind === "welcome" ? sender === "server" : sender === "client"), "state");
      if (sender === role) requireFrame(policyFields.every(field => frame.receivePolicy[field] === limits.receive[field]), "state");
      state.greeted = true; state.receivePolicy = frame.receivePolicy; return;
    }
    requireFrame(state.greeted, "state");
    if (frame.kind === "close") { close(); return; }
    if (frame.kind === "credit") {
      // The sender grants the opposite data direction, including before that peer's greeting.
      requireFrame(frame.grantedBytes >= peer.grantedBytes && frame.grantedFrames >= peer.grantedFrames &&
        (frame.grantedBytes > peer.grantedBytes || frame.grantedFrames > peer.grantedFrames), "credit");
      if (sender === role) {
        requireFrame(frame.grantedBytes - peer.chargedBytes <= limits.maxQueuedBytes - peer.queuedBytes &&
          frame.grantedFrames - peer.chargedFrames <= limits.maxQueuedFrames - peer.queuedFrames, "credit");
      }
      peer.grantedBytes = frame.grantedBytes; peer.grantedFrames = frame.grantedFrames; return;
    }
    requireFrame(peer.greeted, "state");
    if (frame.kind === "sync-applied") {
      requireFrame(sender === "client" && syncDone && !live && frame.appliedThroughJournalCursor === syncCursor, "state");
      live = true; return;
    }
    if (frame.kind === "result") {
      const identity = frame.result === "success" ? frame.ack : frame;
      requireFrame(sender === "server" && live && pending?.complete && pending.deliveryId === identity.deliveryId && pending.updateDigest === identity.updateDigest, "state");
      pending = undefined;
      if (frame.result !== "success") close();
      return;
    }
    if (frame.kind === "begin") {
      requireFrame(size <= state.grantedBytes - state.chargedBytes && state.chargedFrames < state.grantedFrames, "credit");
      requireFrame(!state.active && frame.transferId === state.nextTransferId, "state");
      requireFrame(frame.totalBytes <= maximum(frame, limits.receive) && frame.totalBytes <= maximum(frame, peer.receivePolicy!), "limit");
      if (frame.purpose === "client-vector") requireFrame(sender === "client" && !vectorDone && !live, "state");
      else if (frame.purpose === "initial-sync") requireFrame(sender === "server" && vectorDone && !syncDone && !live, "state");
      else {
        requireFrame(live && (frame.purpose === "submit-update" ? sender === "client" && !pending : sender === "server"), "state");
      }
      let bytes: Uint8Array | undefined;
      if (sender !== role) {
        requireFrame(frame.totalBytes <= limits.maxAssemblyBytes - assemblyBytes, "limit");
        bytes = new Uint8Array(frame.totalBytes);
        assemblyBytes += frame.totalBytes;
      }
      state.active = { begin: frame, offset: 0, bytes };
      state.nextTransferId = frame.transferId === Number.MAX_SAFE_INTEGER ? 0 : frame.transferId + 1;
      if (frame.purpose === "submit-update") pending = { deliveryId: frame.deliveryId, updateDigest: frame.digest, complete: false };
    } else {
      const active = preflightChunk(sender, frame, size);
      active.bytes?.set(frame.bytes, active.offset);
      active.offset += frame.bytes.length;
      if (active.offset === active.begin.totalBytes) {
        state.active = undefined;
        if (active.begin.purpose === "client-vector") vectorDone = true;
        if (active.begin.purpose === "initial-sync") { syncDone = true; syncCursor = active.begin.appliedThroughJournalCursor; }
        if (active.begin.purpose === "submit-update") pending!.complete = true;
        state.chargedBytes += size; state.chargedFrames += 1;
        if (active.bytes) return lease({ begin: active.begin, bytes: active.bytes }, () => { assemblyBytes -= active.begin.totalBytes; });
        return;
      }
    }
    state.chargedBytes += size; state.chargedFrames += 1;
  }
  function holdFrame(sender: Side, data: boolean, size: number) {
    const state = sides[sender];
    const bytesField = data ? "queuedBytes" : "controlBytes", framesField = data ? "queuedFrames" : "controlFrames";
    requireFrame(size <= (data ? limits.maxQueuedBytes : limits.maxControlBytes) - state[bytesField] &&
      state[framesField] < (data ? limits.maxQueuedFrames : limits.maxControlFrames), "limit");
    state[bytesField] += size; state[framesField] += 1;
    return () => { state[bytesField] -= size; state[framesField] -= 1; };
  }
  return {
    send(value: LiveFrame): LiveFrameLease<Uint8Array> {
      checkOpen();
      // Local shape/encoding and pressure errors consume no protocol position. The
      // caller can repair or wait. An illegal protocol transition retires the route.
      const frame = snapshotFrame(value);
      const max = Math.min(limits.receive.maxFrameBytes, sides[opposite(role)].receivePolicy?.maxFrameBytes ?? limits.receive.maxFrameBytes);
      const measure = new Writer(max - 12); payload(measure, frame); const size = measure.offset + 12;
      const release = holdFrame(role, frame.kind === "begin" || frame.kind === "chunk", size);
      try {
        if (frame.kind === "chunk") preflightChunk(role, frame, size);
        const bytes = encodeOwned(frame, max);
        transition(role, frame, size);
        return lease(bytes, release);
      } catch (error) {
        release();
        if (!(error instanceof LiveFrameError) || (error.reason !== "credit" && error.reason !== "limit")) close();
        throw error;
      }
    },
    receive(value: Uint8Array): LiveFrameLease<LiveFrameReceived> {
      checkOpen();
      let release: (() => void) | undefined;
      let completed: LiveFrameLease<LiveFrameTransfer> | undefined;
      try {
        const bytes = byteView(value);
        requireFrame(bytes.length >= 12 && bytes.length <= limits.receive.maxFrameBytes, "limit");
        const data = bytes[5] === kindCodes.begin || bytes[5] === kindCodes.chunk;
        release = holdFrame(opposite(role), data, bytes.length);
        const borrowed = decodeFrame(bytes, limits.receive.maxFrameBytes, false);
        const transfer = transition(opposite(role), borrowed, bytes.length);
        completed = transfer;
        const frame = borrowed.kind === "chunk" ? Object.freeze({ ...borrowed, bytes: borrowed.bytes.slice() }) : borrowed;
        return lease({ frame, ...(transfer ? { transfer } : {}) }, release);
      } catch (error) { completed?.release(); release?.(); close(); throw error; }
    },
    close,
    usage() {
      const usage = (side: Direction) => ({ queuedBytes: side.queuedBytes, queuedFrames: side.queuedFrames,
        controlBytes: side.controlBytes, controlFrames: side.controlFrames,
        promisedBytes: side.grantedBytes - side.chargedBytes, promisedFrames: side.grantedFrames - side.chargedFrames });
      return { closed: terminal, live, assemblyBytes, incoming: usage(sides[opposite(role)]), outgoing: usage(sides[role]) };
    },
  };
}
