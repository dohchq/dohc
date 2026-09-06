import { describe, expect, it } from "vitest";
import vectors from "../vectors/live-frame-vectors.json";
import { parseHostEpoch } from "./hostControl.js";
import {
  LIVE_FRAME_MINIMUM_MAX_BYTES,
  LiveFrameError,
  createLiveFrameSession,
  decodeLiveFrame,
  decodeLiveFrameSync,
  encodeLiveFrame,
  encodeLiveFrameSync,
  type LiveFrame,
  type LiveFrameBegin,
  type LiveFrameReceivePolicy,
  type LiveFrameSessionPolicy,
} from "./liveFrame.js";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const digest = "00".repeat(32);
const receivePolicy: LiveFrameReceivePolicy = { maxFrameBytes: 586, maxStateVectorBytes: 2048, maxUpdateBytes: 4096, maxSyncBytes: 8192 };
const limits: LiveFrameSessionPolicy = { receive: receivePolicy, maxQueuedBytes: 586, maxQueuedFrames: 2, maxControlBytes: 1172, maxControlFrames: 4, maxAssemblyBytes: 8192 };
type Session = ReturnType<typeof createLiveFrameSession>;
function fixture(frame: unknown): LiveFrame {
  const copy = structuredClone(frame) as LiveFrame;
  if (copy.kind === "chunk") return { ...copy, bytes: Uint8Array.from(copy.bytes) };
  return copy;
}
const begin = (purpose: "client-vector" | "submit-update", id = 1, totalBytes = 2): LiveFrameBegin =>
  purpose === "client-vector" ? { kind: "begin", purpose, transferId: id, totalBytes, digest }
    : { kind: "begin", purpose, transferId: id, totalBytes, digest, deliveryId: "d" };
function deliver(sender: Session, receiver: Session, frame: LiveFrame) {
  const sent = sender.send(frame);
  try { return receiver.receive(sent.value); } finally { sent.release(); }
}
function consume(sender: Session, receiver: Session, frame: LiveFrame) {
  const received = deliver(sender, receiver, frame);
  received.value.transfer?.release(); received.release();
}
function pair(serverLimits = limits) {
  const client = createLiveFrameSession("client", limits), server = createLiveFrameSession("server", serverLimits);
  consume(server, client, { kind: "welcome", hostEpoch: parseHostEpoch(1), receivePolicy: serverLimits.receive });
  consume(client, server, { kind: "hello", receivePolicy: limits.receive });
  return { client, server };
}
function grant(sender: Session, receiver: Session, bytesGranted = 586, framesGranted = 2) {
  consume(sender, receiver, { kind: "credit", grantedBytes: bytesGranted, grantedFrames: framesGranted });
}
function makeLive() {
  const { client, server } = pair();
  grant(server, client);
  consume(client, server, begin("client-vector"));
  consume(client, server, { kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array([0, 0]) });
  grant(client, server);
  consume(server, client, { kind: "begin", purpose: "initial-sync", transferId: 1, totalBytes: 2, digest, appliedThroughJournalCursor: 7 });
  consume(server, client, { kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array([0, 0]) });
  consume(client, server, { kind: "sync-applied", appliedThroughJournalCursor: 7 });
  grant(server, client, 677, 4);
  return { client, server };
}

describe("live frame codec", () => {
  it.each(vectors.frames)("matches independent literal $name bytes", vector => {
    const expected = fixture(vector.frame), literal = bytes(vector.hex);
    expect(encodeLiveFrame(expected, 586)).toEqual(literal);
    expect(decodeLiveFrame(literal, 586)).toEqual(expected);
    expect(hex(encodeLiveFrame(decodeLiveFrame(literal, 586), 586))).toBe(vector.hex);
  });
  it.each(vectors.frames)("refuses every truncated $name vector and extra bytes", vector => {
    const literal = bytes(vector.hex);
    for (let index = 0; index < literal.length; index++) expect(() => decodeLiveFrame(literal.slice(0, index), 586)).toThrow();
    expect(() => decodeLiveFrame(new Uint8Array([...literal, 0]), 586)).toThrow();
  });
  it("derives the mandatory maximum from the largest canonical identifier", () => {
    // Independent byte count: 12 header, 4 string length, 512 identifier, 32 digest,
    // 1 result tag, three 8-byte fields, 1 boolean. BEGIN submit is 577 bytes.
    expect(LIVE_FRAME_MINIMUM_MAX_BYTES).toBe(586);
    const frame: LiveFrame = { kind: "result", result: "success", ack: {
      deliveryId: "x".repeat(512), updateDigest: digest, journalCursor: 1,
      acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: 1, applicationReplayed: false,
    } };
    expect(encodeLiveFrame(frame, 586)).toHaveLength(586);
    expect(() => encodeLiveFrame(frame, 585)).toThrow();
    expect(() => createLiveFrameSession("client", { ...limits, receive: { ...receivePolicy, maxFrameBytes: 585 } })).toThrow();
    expect(encodeLiveFrame({ ...begin("submit-update"), deliveryId: "x".repeat(512) } as LiveFrame, 586)).toHaveLength(577);
  });
  it("rejects corrupt headers, unsafe integers and unchecked announcements", () => {
    const literal = bytes(vectors.frames.find(v => v.name === "chunk")!.hex);
    for (const [offset, value] of [[0, 0], [4, 2], [5, 255], [6, 1], [7, 1], [8, 255]]) {
      const corrupt = literal.slice(); corrupt[offset] = value;
      expect(() => decodeLiveFrame(corrupt, 586)).toThrow();
    }
    const unsafe = literal.slice(); new DataView(unsafe.buffer).setBigUint64(12, 9007199254740992n);
    expect(() => decodeLiveFrame(unsafe, 586)).toThrow();
    expect(() => decodeLiveFrame(literal, literal.length - 1)).toThrow();
    expect(decodeLiveFrame(literal, literal.length)).toEqual(fixture(vectors.frames.find(v => v.name === "chunk")!.frame));
    expect(() => encodeLiveFrame({ kind: "chunk", transferId: 0, offset: 0, bytes: new Uint8Array([1]) }, 586)).toThrow();
  });
  it("preserves BOM bytes in identifiers and rejects malformed UTF-8", () => {
    const frame = { ...begin("submit-update"), deliveryId: "\ufeffd" } as LiveFrame;
    const encoded = encodeLiveFrame(frame, 586);
    expect(decodeLiveFrame(encoded, 586)).toEqual(frame);
    expect(hex(encoded).endsWith("00000004efbbbf64")).toBe(true);
    const malformed = bytes(vectors.frames.find(v => v.name === "submit-update")!.hex);
    malformed[malformed.length - 1] = 0xff;
    expect(() => decodeLiveFrame(malformed, 586)).toThrow();
  });
  it("snapshots own fields without invoking accessors and owns returned bytes", () => {
    let calls = 0;
    for (const field of ["kind", "purpose", "deliveryId", "digest"]) {
      const source = { ...begin("submit-update") };
      Object.defineProperty(source, field, { enumerable: true, get() { calls++; return "submit-update"; } });
      expect(() => encodeLiveFrame(source, 586)).toThrow();
    }
    const source = new Uint8Array([1, 2]);
    Object.defineProperty(source, "byteLength", { get() { calls++; return 999; } });
    const encoded = encodeLiveFrame({ kind: "chunk", transferId: 1, offset: 0, bytes: source }, 586);
    source[0] = 9;
    const decoded = decodeLiveFrame(encoded, 586);
    expect(decoded.kind).toBe("chunk");
    encoded[encoded.length - 1] = 8;
    if (decoded.kind === "chunk") expect(decoded.bytes).toEqual(new Uint8Array([1, 2]));
    expect(calls).toBe(0);
    expect(() => encodeLiveFrame({ kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array(new SharedArrayBuffer(2)) }, 586)).toThrow();
    const detached = new Uint8Array(2); structuredClone(detached.buffer, { transfer: [detached.buffer] });
    expect(() => encodeLiveFrame({ kind: "chunk", transferId: 1, offset: 0, bytes: detached }, 586)).toThrow();
    expect(() => encodeLiveFrame(Object.create(begin("client-vector")), 586)).toThrow();
  });
});

describe("initial sync container", () => {
  const sync = () => ({ binding: structuredClone(vectors.sync.value.binding), hostVector: Uint8Array.from(vectors.sync.value.hostVector), missingStateUpdate: Uint8Array.from(vectors.sync.value.missingStateUpdate) });
  it("matches the independent binding/vector/update literal and owns payloads", () => {
    const source = sync(), literal = bytes(vectors.sync.hex);
    expect(encodeLiveFrameSync(source, receivePolicy)).toEqual(literal);
    const decoded = decodeLiveFrameSync(literal, receivePolicy);
    expect(decoded).toEqual(source);
    literal.fill(255); expect(decoded.hostVector).toEqual(new Uint8Array([0]));
    expect(decoded.missingStateUpdate).toEqual(new Uint8Array([0, 0]));
  });
  it("refuses truncation, length excess, noncanonical selectors and path normalization", () => {
    const literal = bytes(vectors.sync.hex);
    for (let n = 0; n < literal.length; n++) expect(() => decodeLiveFrameSync(literal.slice(0, n), receivePolicy)).toThrow();
    expect(() => decodeLiveFrameSync(literal, { ...receivePolicy, maxSyncBytes: literal.length - 1 })).toThrow();
    const two = encodeLiveFrameSync({ ...sync(), binding: { ...sync().binding, selectorPaths: ["a.md", "b.md"] } }, receivePolicy);
    // Equal-length path tokens let this test alter ordering without changing framing.
    const a = Buffer.from(two).lastIndexOf(Buffer.from("a.md")), b = Buffer.from(two).indexOf(Buffer.from("b.md"));
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
    const reversed = two.slice(); reversed[a] = 98; reversed[b] = 97;
    expect(() => decodeLiveFrameSync(reversed, receivePolicy)).toThrow();
    const duplicate = two.slice(); duplicate[b] = 97;
    expect(() => decodeLiveFrameSync(duplicate, receivePolicy)).toThrow();
    const normal = encodeLiveFrameSync({ ...sync(), binding: { ...sync().binding, currentPath: "a/b.md", selectorPaths: ["a/b.md"] } }, receivePolicy);
    const slash = Buffer.from(normal).indexOf(Buffer.from("a/b.md")) + 1;
    normal[slash] = 92;
    expect(() => decodeLiveFrameSync(normal, receivePolicy)).toThrow();
  });
  it("refuses nested binding accessors without evaluating them", () => {
    let calls = 0; const source = sync();
    Object.defineProperty(source.binding, "currentPath", { get() { calls++; return "a.md"; } });
    expect(() => encodeLiveFrameSync(source, receivePolicy)).toThrow(); expect(calls).toBe(0);
  });
  it("keeps full-state sync size independent of the submitted-update limit", () => {
    const p = { ...receivePolicy, maxUpdateBytes: 2 };
    const source = { ...sync(), missingStateUpdate: new Uint8Array(100) };
    expect(decodeLiveFrameSync(encodeLiveFrameSync(source, p), p)).toEqual(source);
  });
});

describe("live frame route ownership", () => {
  it("accepts server CREDIT before client HELLO and gates each direction independently", () => {
    const client = createLiveFrameSession("client", limits), server = createLiveFrameSession("server", limits);
    consume(server, client, { kind: "welcome", hostEpoch: parseHostEpoch(1), receivePolicy });
    expect(() => grant(server, client)).not.toThrow();
    expect(client.usage().outgoing.promisedBytes).toBe(586);
    consume(client, server, { kind: "hello", receivePolicy });
    consume(client, server, begin("client-vector"));
    client.close(); server.close();
    expect(server.usage().assemblyBytes).toBe(0);
    const beforeGreeting = createLiveFrameSession("client", limits);
    expect(() => beforeGreeting.receive(encodeLiveFrame({ kind: "credit", grantedBytes: 1, grantedFrames: 1 }, 586))).toThrow();
    expect(beforeGreeting.usage().closed).toBe(true);
  });
  it("pauses at zero credit, then resumes without losing the connection", () => {
    const { client, server } = pair();
    expect(() => client.send(begin("client-vector"))).toThrow(LiveFrameError);
    expect(client.usage().closed).toBe(false);
    expect(client.usage().outgoing.queuedBytes).toBe(0);
    grant(server, client); consume(client, server, begin("client-vector"));
    server.close(); client.close();
  });
  it("backs cumulative credit with queued bytes, frames and existing promises", () => {
    const { client, server } = pair(); grant(server, client);
    const held = deliver(client, server, begin("client-vector"));
    expect(server.usage().incoming).toMatchObject({ queuedBytes: 61, promisedBytes: 525 });
    expect(() => server.send({ kind: "credit", grantedBytes: 587, grantedFrames: 2 })).toThrow();
    expect(server.usage().closed).toBe(false);
    held.release(); held.release();
    grant(server, client, 647, 3);
    expect(server.usage().incoming).toMatchObject({ queuedBytes: 0, queuedFrames: 0, promisedBytes: 586, promisedFrames: 2 });
    for (const invalid of [{ grantedBytes: 647, grantedFrames: 3 }, { grantedBytes: 646, grantedFrames: 4 }]) {
      expect(() => server.send({ kind: "credit", ...invalid })).toThrow();
    }
    expect(server.usage().incoming.promisedBytes).toBe(586);
    server.close(); client.close();
  });
  it("accounts borrowed input, decoded CHUNK and assembly under their separate owners", () => {
    const { client, server } = pair(); grant(server, client); consume(client, server, begin("client-vector"));
    const sent = client.send({ kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array([3, 4]) });
    const received = server.receive(sent.value);
    // Transport retains the 30-byte input; server queue covers the owned decoded
    // frame and server assembly owns another two bytes at the same instant.
    expect(client.usage().outgoing.queuedBytes).toBe(30);
    expect(server.usage()).toMatchObject({ assemblyBytes: 2, incoming: { queuedBytes: 30, queuedFrames: 1 } });
    const frame = received.value.frame;
    expect(frame.kind).toBe("chunk");
    if (frame.kind !== "chunk") throw new Error("Expected CHUNK.");
    const transfer = received.value.transfer!;
    expect(frame.bytes.buffer).not.toBe(sent.value.buffer);
    expect(frame.bytes.buffer).not.toBe(transfer.value.bytes.buffer);
    sent.value.fill(255); expect(frame.bytes).toEqual(new Uint8Array([3, 4]));
    frame.bytes[0] = 9; expect(transfer.value.bytes).toEqual(new Uint8Array([3, 4]));
    sent.release(); received.release();
    expect(server.usage()).toMatchObject({ assemblyBytes: 2, incoming: { queuedBytes: 0 } });
    transfer.release(); expect(server.usage().assemblyBytes).toBe(0);
  });
  it("leaves local malformed encoding recoverable but retires invalid protocol transitions", () => {
    const { client, server } = pair();
    expect(() => client.send({ kind: "chunk", transferId: 0, offset: 0, bytes: new Uint8Array([1]) })).toThrow();
    expect(() => client.send({ kind: "chunk", transferId: 1, offset: 0, bytes: new Uint8Array(1000) })).toThrow();
    expect(client.usage()).toMatchObject({ closed: false, outgoing: { queuedBytes: 0, queuedFrames: 0 } });
    grant(server, client); consume(client, server, begin("client-vector"));
    expect(() => client.send({ kind: "chunk", transferId: 1, offset: 1, bytes: new Uint8Array([1]) })).toThrow();
    expect(client.usage()).toMatchObject({ closed: true, outgoing: { queuedBytes: 0, queuedFrames: 0 } });
    server.close();
  });
  it("completes a transfer larger than its queue window and retains consumer storage", () => {
    const { client, server } = pair({ ...limits, maxQueuedFrames: 1, maxAssemblyBytes: 1300 });
    let grantedBytes = 586, grantedFrames = 1, chargedBytes = 0, chargedFrames = 0;
    grant(server, client, grantedBytes, grantedFrames);
    consume(client, server, begin("client-vector", 1, 1200)); chargedBytes += 61; chargedFrames++;
    let complete: ReturnType<Session["receive"]> | undefined;
    for (let offset = 0; offset < 1200; offset += 400) {
      grantedBytes = chargedBytes + 586; grantedFrames = chargedFrames + 1;
      grant(server, client, grantedBytes, grantedFrames);
      complete = deliver(client, server, { kind: "chunk", transferId: 1, offset, bytes: new Uint8Array(400).fill(offset / 400 + 1) });
      expect(server.usage().incoming.queuedBytes).toBe(428);
      expect(server.usage().assemblyBytes).toBe(1200);
      complete.release(); chargedBytes += 428; chargedFrames++;
    }
    const transfer = complete!.value.transfer!;
    expect(transfer.value.bytes).toEqual(new Uint8Array([...new Uint8Array(400).fill(1), ...new Uint8Array(400).fill(2), ...new Uint8Array(400).fill(3)]));
    expect(server.usage().assemblyBytes).toBe(1200);
    server.close(); server.close(); client.close();
    expect(server.usage().assemblyBytes).toBe(1200);
    transfer.release(); transfer.release();
    expect(server.usage().assemblyBytes).toBe(0);
    expect(server.usage().incoming).toMatchObject({ queuedBytes: 0, queuedFrames: 0, promisedBytes: 0, promisedFrames: 0 });
    expect(() => server.receive(new Uint8Array())).toThrow();
  });
  it.each([
    { transferId: 1, offset: 1, bytes: new Uint8Array([0]) },
    { transferId: 2, offset: 0, bytes: new Uint8Array([0]) },
    { transferId: 1, offset: 0, bytes: new Uint8Array([0, 0, 0]) },
  ])("refuses corrupt chunk coordinates and releases partial assembly", chunk => {
    const { client, server } = pair(); grant(server, client); consume(client, server, begin("client-vector"));
    expect(() => server.receive(encodeLiveFrame({ kind: "chunk", ...chunk }, 586))).toThrow();
    expect(server.usage()).toMatchObject({ closed: true, assemblyBytes: 0, incoming: { queuedBytes: 0, queuedFrames: 0 } });
  });
  it("refuses overlapping, reused and out-of-phase transfers", () => {
    for (const frame of [begin("client-vector", 2), begin("submit-update", 2), { ...begin("client-vector"), transferId: 1 }]) {
      const { client, server } = pair(); grant(server, client); consume(client, server, begin("client-vector"));
      expect(() => server.receive(encodeLiveFrame(frame, 586))).toThrow();
      expect(server.usage().assemblyBytes).toBe(0);
    }
    const { client, server } = pair(); grant(server, client);
    expect(() => server.receive(encodeLiveFrame(begin("submit-update"), 586))).toThrow();
  });
  it("requires completed sync and the exact applied-through cursor", () => {
    const { client, server } = pair();
    expect(() => server.receive(encodeLiveFrame({ kind: "sync-applied", appliedThroughJournalCursor: 0 }, 586))).toThrow();
    const ready = makeLive();
    expect(ready.client.usage().live).toBe(true); expect(ready.server.usage().live).toBe(true);
    expect(() => ready.server.receive(encodeLiveFrame({ kind: "sync-applied", appliedThroughJournalCursor: 7 }, 586))).toThrow();
  });
  it("holds one unresolved submission through its correlated RESULT", () => {
    const { client, server } = makeLive();
    consume(client, server, begin("submit-update", 2));
    consume(client, server, { kind: "chunk", transferId: 2, offset: 0, bytes: new Uint8Array([0, 0]) });
    const success: LiveFrame = { kind: "result", result: "success", ack: { deliveryId: "d", updateDigest: digest, journalCursor: 19, acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: 3, applicationReplayed: true } };
    consume(server, client, success);
    grant(server, client, 773, 6);
    consume(client, server, { ...begin("submit-update", 3), deliveryId: "e" } as LiveFrame);
    const stale = encodeLiveFrame(success, 586);
    expect(() => client.receive(stale)).toThrow();
    expect(client.usage().closed).toBe(true);
    server.close();
  });
  it("cannot pass a submission predecessor or accept a forged identity", () => {
    for (const operation of ["next", "result"] as const) {
      const { client, server } = makeLive();
      consume(client, server, begin("submit-update", 2));
      consume(client, server, { kind: "chunk", transferId: 2, offset: 0, bytes: new Uint8Array([0, 0]) });
      grant(server, client, 773, 6);
      if (operation === "next") expect(() => server.receive(encodeLiveFrame(begin("submit-update", 3), 586))).toThrow();
      else expect(() => client.receive(encodeLiveFrame({ kind: "result", result: "retry", deliveryId: "other", updateDigest: digest, reason: "application-pending" }, 586))).toThrow();
    }
  });
  it("terminal retry leaves held frames charged until transport release", () => {
    const { client, server } = makeLive(); consume(client, server, begin("submit-update", 2));
    consume(client, server, { kind: "chunk", transferId: 2, offset: 0, bytes: new Uint8Array([0, 0]) });
    const sent = server.send({ kind: "result", result: "retry", deliveryId: "d", updateDigest: digest, reason: "application-pending" });
    expect(server.usage().closed).toBe(true); expect(server.usage().outgoing.controlBytes).toBe(sent.value.length);
    const received = client.receive(sent.value); expect(client.usage().closed).toBe(true);
    sent.release(); received.release(); expect(server.usage().outgoing.controlBytes).toBe(0); expect(client.usage().incoming.controlBytes).toBe(0);
  });
  it("bounds control queues and snapshots policies and retained metadata", () => {
    const mutable = { ...limits, receive: { ...limits.receive } }; const client = createLiveFrameSession("client", mutable);
    mutable.maxControlFrames = 1000; mutable.receive.maxFrameBytes = 1000;
    const hello = client.send({ kind: "hello", receivePolicy });
    const credits = [1, 2, 3].map(n => client.send({ kind: "credit", grantedBytes: n, grantedFrames: n < 3 ? 1 : 2 }));
    expect(() => client.send({ kind: "credit", grantedBytes: 4, grantedFrames: 2 })).toThrow();
    expect(client.usage().outgoing.controlFrames).toBe(4);
    hello.release(); credits.forEach(credit => credit.release()); client.close();
    expect(client.usage().outgoing.controlFrames).toBe(0);
  });
});
