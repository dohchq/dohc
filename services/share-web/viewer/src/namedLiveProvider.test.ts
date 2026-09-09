import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { createLiveFrameSession, encodeLiveFrame, encodeLiveFrameSync,
  type LiveFrame, type LiveFrameBegin } from "@dohc/live-session-contract/live-frame";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { createNamedLiveProvider, type NamedLiveProviderLimits } from "./namedLiveProvider";

const limits = (): NamedLiveProviderLimits => ({
  frames: { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384 },
    maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384 },
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4,
});
const binding: LiveObjectBinding = { workspaceId: "workspace", mainVersionId: "main", objectId: "document",
  lineageClaimId: "lineage", currentPath: "document.md", selectorPaths: ["document.md"], restoreFenceGeneration: 0 };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Provider = ReturnType<typeof createNamedLiveProvider>;
type Received = { begin: LiveFrameBegin; bytes: Uint8Array };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });
function provider(options = limits()) {
  const value = createNamedLiveProvider(options);
  cleanup.push(() => { value.close(); value.doc.destroy(); });
  return value;
}
function document(text: string) {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph"), content = new Y.XmlText();
  content.insert(0, text); paragraph.insert(0, [content]); getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  cleanup.push(() => doc.destroy());
  return doc;
}
function edit(value: Provider, text: string) {
  const paragraph = value.body.get(0) as Y.XmlElement;
  const content = paragraph.get(0) as Y.XmlText;
  content.insert(content.length, text);
}
function peer(value: Provider, epoch = 1, options: { policy?: NamedLiveProviderLimits["frames"]; replenish?: boolean } = {}) {
  const policy = options.policy ?? limits().frames;
  const server = createLiveFrameSession("server", policy);
  cleanup.push(() => server.close());
  const frames: LiveFrame[] = [], transfers: Received[] = [];
  const frameBytes: number[] = [];
  const watchers = new Set<() => void>();
  let closed = false, nextTransfer = 1, vector: Uint8Array | undefined;
  let creditBytes = policy.maxQueuedBytes, creditFrames = policy.maxQueuedFrames;
  let stalled: (() => void) | undefined;
  let stall: false | "all" | "chunks" = false, sendsInFlight = 0;
  const route = value.connect({
    async send(bytes) {
      sendsInFlight++;
      try {
        const received = server.receive(bytes);
        try {
          frames.push(received.value.frame);
          frameBytes.push(bytes.length);
          if (received.value.transfer) {
            const transfer = received.value.transfer.value;
            transfers.push({ begin: transfer.begin, bytes: transfer.bytes.slice() });
            if (transfer.begin.purpose === "client-vector") vector = transfer.bytes.slice();
          }
        } finally { received.value.transfer?.release(); received.release(); }
        if (options.replenish && (received.value.frame.kind === "begin" || received.value.frame.kind === "chunk")) {
          creditBytes += bytes.length; creditFrames++;
          await send({ kind: "credit", grantedBytes: creditBytes, grantedFrames: creditFrames });
        }
        for (const notify of watchers) notify();
        if (stall === "all" || (stall === "chunks" && received.value.frame.kind === "chunk")) {
          await new Promise<void>(resolve => { stalled = resolve; });
        }
      } finally { sendsInFlight--; for (const notify of watchers) notify(); }
    },
    close() { closed = true; server.close(); stalled?.(); stalled = undefined; },
  });
  function until(check: () => boolean) {
    if (check()) return Promise.resolve();
    return new Promise<void>(resolve => { const watch = () => { if (check()) { watchers.delete(watch); resolve(); } }; watchers.add(watch); });
  }
  async function send(frame: LiveFrame) {
    const lease = server.send(frame);
    try { await route.receive(lease.value); } finally { lease.release(); }
  }
  async function transfer(purpose: "initial-sync" | "applied-update", bytes: Uint8Array, cursor: number, digest = hash(bytes)) {
    const id = nextTransfer++;
    await send({ kind: "begin", purpose, transferId: id, totalBytes: bytes.length, digest,
      ...(purpose === "initial-sync" ? { appliedThroughJournalCursor: cursor } : { journalCursor: cursor }) } as LiveFrameBegin);
    for (let offset = 0; offset < bytes.length; offset += 900) {
      await send({ kind: "chunk", transferId: id, offset, bytes: bytes.subarray(offset, offset + 900) });
    }
  }
  async function initial(doc: Y.Doc, selected = binding, cursor = 0, digest?: string) {
    await until(() => vector !== undefined);
    await transfer("initial-sync", encodeLiveFrameSync({ binding: selected, hostVector: Y.encodeStateVector(doc),
      missingStateUpdate: Y.encodeStateAsUpdate(doc, vector) }, policy.receive), cursor, digest);
    if (value.state().status === "live") await until(() => frames.some(frame => frame.kind === "sync-applied"));
  }
  const submissions = () => transfers.filter(item => item.begin.purpose === "submit-update");
  async function submitted(count = 1) { await until(() => submissions().length >= count); return submissions()[count - 1]!; }
  async function ack(item: Received, acceptingHostEpoch = epoch, cursor = 1) {
    if (item.begin.purpose !== "submit-update") throw new Error("Expected submit update.");
    await send({ kind: "result", result: "success", ack: { deliveryId: item.begin.deliveryId, updateDigest: item.begin.digest,
      journalCursor: cursor, acceptingHostEpoch: parseHostEpoch(acceptingHostEpoch), localYDocSequence: 1, applicationReplayed: false } });
  }
  return { route, server, frames, frameBytes, transfers, send, initial, transfer, submitted, submissions, ack,
    until,
    sendsInFlight: () => sendsInFlight,
    isClosed: () => closed,
    async greet(grant = true) {
      await send({ kind: "welcome", hostEpoch: parseHostEpoch(epoch), receivePolicy: policy.receive });
      if (grant) await send({ kind: "credit", grantedBytes: creditBytes, grantedFrames: creditFrames });
    },
    async credit(bytes = 16384, count = 64) { creditBytes += bytes; creditFrames += count; await send({ kind: "credit", grantedBytes: creditBytes, grantedFrames: creditFrames }); },
    stall() { stall = "all"; }, stallChunks() { stall = "chunks"; }, release() { stall = false; stalled?.(); stalled = undefined; },
  };
}
async function live(value = provider(), doc = document("base")) {
  const host = peer(value); await host.greet(); await host.initial(doc); return { value, host, doc };
}

describe("named live browser provider", () => {
  it("retains the membership overflow marker without inventing departures", async () => {
    const { value, host } = await live();
    const first = "ab".repeat(16), second = "cd".repeat(16);
    await host.send({ kind: "membership", revision: 1, members: [first, second], overflow: false });
    expect(value.state().membership).toEqual({ kind: "membership", revision: 1, members: [first, second], overflow: false });
    await host.send({ kind: "membership", revision: 2, members: [first], overflow: true });
    expect(value.state().membership).toEqual({ kind: "membership", revision: 2, members: [first], overflow: true });
    (value.state().membership!.members as string[]).push("ef".repeat(16));
    expect(value.state().membership!.members).toEqual([first]);
    host.route.disconnect();
    expect(value.state().membership).toBeNull();
  });
  it("ignores membership arriving from a replaced route", async () => {
    const { value, host, doc } = await live();
    await host.send({ kind: "membership", revision: 1, members: ["ab".repeat(16)], overflow: false });
    host.route.disconnect(); await host.route.settled();
    const next = peer(value, 2); await next.greet(); await next.initial(doc);
    await next.send({ kind: "membership", revision: 1, members: ["cd".repeat(16)], overflow: false });
    await host.route.receive(encodeLiveFrame({ kind: "membership", revision: 2, members: ["ef".repeat(16)], overflow: false }, 586));
    expect(value.state().membership!.members).toEqual(["cd".repeat(16)]);
  });
  it("waits for the initial sync, uses the canonical body, and ignores remote echoes", async () => {
    const value = provider(), doc = document("initial"), host = peer(value);
    expect(value.state().status).toBe("connecting");
    await host.greet(); expect(value.state().status).toBe("syncing");
    await host.initial(doc);
    expect(value.body.toString()).toBe(getDohcYDocBodyFragment(doc).toString());
    expect(value.state()).toMatchObject({ status: "live", binding, pendingUpdates: 0 });
    expect(host.submissions()).toHaveLength(0);
  });
  it("holds exact local update bytes until a matched host application ACK", async () => {
    const { value, host } = await live(); edit(value, " local");
    const item = await host.submitted();
    expect(hash(item.bytes)).toBe(item.begin.digest);
    expect(value.state()).toMatchObject({ pendingUpdates: 1, pendingBytes: item.bytes.length, lastApplied: null });
    await host.ack(item);
    expect(value.state()).toMatchObject({ pendingUpdates: 0, pendingBytes: 0, lastApplied: { journalCursor: 1 } });
  });
  it.each([[586, 16384], [16384, 586], [586, 586]])("delivers and ACKs an update with local queue %i and peer queue %i below the frame limit", async (localBytes, peerBytes) => {
    const options = limits();
    const value = provider({ ...options, frames: { ...options.frames, maxQueuedBytes: localBytes } });
    const host = peer(value, 1, { policy: { ...options.frames, maxQueuedBytes: peerBytes }, replenish: true });
    const doc = document("base"); await host.greet(); await host.initial(doc);
    edit(value, "x".repeat(2048));
    const item = await host.submitted();
    expect(item.bytes.length).toBeGreaterThan(1024);
    expect(host.frames.filter(frame => frame.kind === "chunk").length).toBeGreaterThan(3);
    expect(Math.max(...host.frameBytes)).toBeLessThanOrEqual(Math.min(1024, localBytes, peerBytes));
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 1, pendingBytes: item.bytes.length, lastApplied: null });
    Y.applyUpdate(doc, item.bytes);
    expect(value.body.toString()).toBe(getDohcYDocBodyFragment(doc).toString());
    await host.ack(item);
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 0, pendingBytes: 0, lastApplied: { journalCursor: 1 } });
  }, 2000);
  it("uses remaining byte credit and waits for another frame before continuing a submission", async () => {
    const options = { policy: { ...limits().frames, maxQueuedBytes: 586, maxQueuedFrames: 2 }, replenish: false };
    const value = provider(), host = peer(value, 1, options);
    await host.greet(); await host.initial(document("base"));
    await host.credit(0, 1); edit(value, "x".repeat(2048));
    await host.until(() => host.frames.some(frame => frame.kind === "begin" && frame.purpose === "submit-update"));
    expect(host.frames.filter(frame => frame.kind === "chunk" && frame.transferId === 2)).toHaveLength(0);
    expect(host.server.usage().incoming.promisedFrames).toBe(0);
    await host.credit(0, 1);
    await host.until(() => host.frames.some(frame => frame.kind === "chunk" && frame.transferId === 2));
    const firstChunk = host.frames.findIndex(frame => frame.kind === "chunk" && frame.transferId === 2);
    expect(host.frameBytes[firstChunk]).toBeLessThan(586);
    expect(host.server.usage().incoming).toMatchObject({ promisedBytes: 0, promisedFrames: 0 });
    expect(host.submissions()).toHaveLength(0);
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 1, lastApplied: null });
    options.replenish = true; await host.credit(586, 2);
    await host.ack(await host.submitted());
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 0, pendingBytes: 0 });
  }, 2000);
  it("releases a partially sent small-queue update on cancellation and retries the same draft", async () => {
    const options = limits(), policy = { ...options.frames, maxQueuedBytes: 586 }, peerPolicy = { ...policy, maxQueuedFrames: 1 };
    const value = provider({ ...options, frames: policy }), doc = document("base");
    const host = peer(value, 1, { policy: peerPolicy, replenish: true }); await host.greet(); await host.initial(doc);
    host.stallChunks(); edit(value, "x".repeat(2048));
    await host.until(() => host.frames.some(frame => frame.kind === "chunk" && frame.transferId === 2));
    expect(host.submissions()).toHaveLength(0);
    const pendingBytes = value.state().pendingBytes;
    expect(host.server.usage().assemblyBytes).toBe(pendingBytes);
    host.route.disconnect(); await host.until(() => host.sendsInFlight() === 0); await host.route.settled();
    expect(host.isClosed()).toBe(true);
    expect(host.server.usage()).toMatchObject({ closed: true, assemblyBytes: 0, incoming: { queuedBytes: 0, queuedFrames: 0 } });
    expect(value.state()).toMatchObject({ status: "disconnected", pendingUpdates: 1, pendingBytes });
    const next = peer(value, 2, { policy: peerPolicy, replenish: true }); await next.greet(); await next.initial(doc);
    const retry = await next.submitted();
    expect(retry.begin).toMatchObject(host.frames.find(frame => frame.kind === "begin" && frame.purpose === "submit-update")!);
    await next.ack(retry);
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 0, pendingBytes: 0 });
  }, 2000);
  it("retries ambiguous delivery with its original identity and accepts historical host application", async () => {
    const { value, host, doc } = await live(); edit(value, " draft"); const first = await host.submitted();
    // The old host may have applied it before the connection vanished.
    Y.applyUpdate(doc, first.bytes); host.route.disconnect(); await host.route.settled();
    const second = peer(value, 2); await second.greet(); await second.initial(doc, binding, 1);
    const retry = await second.submitted();
    expect(retry.bytes).toEqual(first.bytes);
    expect(retry.begin).toMatchObject({ deliveryId: (first.begin as { deliveryId: string }).deliveryId, digest: first.begin.digest });
    expect(value.state().pendingUpdates).toBe(1);
    await second.ack(retry, 1); expect(value.state().pendingUpdates).toBe(0);
  });
  it("quarantines a changed restore binding before applying the fresh baseline", async () => {
    const { value, host } = await live(); edit(value, " unsent"); await host.submitted();
    host.route.disconnect(); await host.route.settled(); const before = value.body.toString();
    const second = peer(value, 2); await second.greet();
    await second.initial(document("RESTORED"), { ...binding, restoreFenceGeneration: 1 });
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "binding-changed", pendingUpdates: 1 });
    expect(value.body.toString()).toBe(before);
    expect(() => peer(value, 3)).toThrow("cannot reconnect");
  });
  it.each(["route-fenced", "protocol-invalid"] as const)("retains a draft on %s", async reason => {
    const { value, host } = await live(); edit(value, " draft"); await host.submitted();
    const before = value.body.toString(); await host.send({ kind: "close", reason });
    expect(value.state()).toMatchObject({ status: "quarantined", reason, pendingUpdates: 1 });
    expect(value.body.toString()).toBe(before); expect(host.isClosed()).toBe(true);
  });
  it.each(["retry", "refused"] as const)("preserves ownership after a %s result", async result => {
    const { value, host } = await live(); edit(value, " draft"); const item = await host.submitted();
    if (item.begin.purpose !== "submit-update") throw new Error("Expected submit.");
    await host.send(result === "retry"
      ? { kind: "result", result, deliveryId: item.begin.deliveryId, updateDigest: item.begin.digest, reason: "application-pending" }
      : { kind: "result", result, deliveryId: item.begin.deliveryId, updateDigest: item.begin.digest, reason: "restore-fenced" });
    expect(value.state()).toMatchObject({ status: result === "retry" ? "disconnected" : "quarantined", pendingUpdates: 1 });
  });
  it("does not skip peer updates when its own ACK has a later cursor", async () => {
    const { value, host, doc } = await live(); edit(value, " mine"); await host.ack(await host.submitted(), 1, 4);
    const before = Y.encodeStateVector(doc);
    const content = (getDohcYDocBodyFragment(doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    content.insert(content.length, " peer");
    await host.transfer("applied-update", Y.encodeStateAsUpdate(doc, before), 3);
    expect(value.body.toString()).toContain("peer"); expect(value.state().pendingUpdates).toBe(0);
  });
  it("refuses an ACK from an unattempted host epoch", async () => {
    const { value, host } = await live(); edit(value, " draft"); await host.ack(await host.submitted(), 2);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "foreign-ack-epoch", pendingUpdates: 1 });
  });
  it("keeps local edits when bounded pending count is exhausted", async () => {
    const options = { ...limits(), maxPendingUpdates: 1 };
    const { value, host } = await live(provider(options)); edit(value, " first"); await host.submitted(); edit(value, " second");
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "pending-update-limit", pendingUpdates: 1 });
    expect(value.body.toString()).toContain("second");
  });
  it("rejects a tampered initial sync without mutating the draft", async () => {
    const value = provider(), host = peer(value); await host.greet();
    await host.initial(document("untrusted"), binding, 0, "00".repeat(32));
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "digest-mismatch" });
    expect(value.body.length).toBe(0);
  });
  it("quarantines edits before initial sync", () => {
    const value = provider(); value.body.insert(0, [new Y.XmlElement("paragraph")]);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "edit-while-unavailable" });
    expect(value.body.length).toBe(1);
  });
  it("ignores late frames from a retired route", async () => {
    const { value, host, doc } = await live(); host.route.disconnect(); await host.route.settled();
    const second = peer(value, 2); await second.greet(); await second.initial(doc);
    await host.route.receive(encodeLiveFrame({ kind: "close", reason: "route-fenced" }, 1024));
    expect(value.state()).toMatchObject({ status: "live", hostEpoch: 2 });
  });
  it("snapshots caller budgets and returned binding state", async () => {
    const original = limits();
    const options = { ...original, frames: { ...original.frames, receive: { ...original.frames.receive } } };
    const value = provider(options); options.maxPendingUpdates = 0; options.frames.receive.maxUpdateBytes = 1;
    const { host } = await live(value); const snapshot = value.state();
    (snapshot.binding!.selectorPaths as string[])[0] = "evil.md";
    expect(value.state().binding).toEqual(binding);
    edit(value, " permitted"); await host.submitted(); expect(value.state().status).toBe("live");
  });
  it("bounds admitted inbound frame copies even before asynchronous work drains", async () => {
    const original = limits(); const options = { ...original, frames: { ...original.frames, maxQueuedFrames: 1 } };
    const value = provider(options), host = peer(value);
    const welcome = encodeLiveFrame({ kind: "welcome", hostEpoch: parseHostEpoch(1), receivePolicy: limits().frames.receive }, 1024);
    const first = host.route.receive(welcome), second = host.route.receive(welcome);
    await Promise.all([first, second]);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "inbound-limit" });
  });
  it("stops at route credit and resumes the same queued update after credit arrives", async () => {
    const value = provider(), host = peer(value); await host.greet(false);
    await host.send({ kind: "credit", grantedBytes: 120, grantedFrames: 2 });
    await host.initial(document("base")); edit(value, " waiting");
    expect(value.state().pendingUpdates).toBe(1); expect(host.submissions()).toHaveLength(0);
    await host.send({ kind: "credit", grantedBytes: 16384, grantedFrames: 64 }); await host.ack(await host.submitted());
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 0 });
  });
  it("keeps a stalled send owned and refuses reconnect until the adapter releases it", async () => {
    const { value, host } = await live(); host.stall(); edit(value, " stalled");
    await host.until(() => host.frames.some(frame => frame.kind === "begin" && frame.purpose === "submit-update"));
    expect(host.submissions()).toHaveLength(0); expect(value.state().pendingUpdates).toBe(1);
    expect(() => peer(value, 2)).toThrow("still owns work");
    host.release(); await host.ack(await host.submitted());
    expect(value.state().pendingUpdates).toBe(0);
  });
  it.each(["deliveryId", "updateDigest"] as const)("refuses an ACK with the wrong %s", async field => {
    const { value, host } = await live(); edit(value, " draft"); const item = await host.submitted();
    if (item.begin.purpose !== "submit-update") throw new Error("Expected submit.");
    // Bypass server validation to model a corrupt or malicious peer.
    await host.route.receive(encodeLiveFrame({ kind: "result", result: "success", ack: {
      deliveryId: item.begin.deliveryId, updateDigest: item.begin.digest, journalCursor: 1,
      acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: 1, applicationReplayed: false,
      [field]: field === "deliveryId" ? "different" : "00".repeat(32),
    } }, 1024));
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "invalid-frame", pendingUpdates: 1 });
  });
  it("bounds ambiguous delivery attempts across reconnects", async () => {
    const { value, host, doc } = await live(provider({ ...limits(), maxDeliveryAttempts: 1 }));
    edit(value, " draft"); await host.submitted(); host.route.disconnect(); await host.route.settled();
    const second = peer(value, 2); await second.greet(); await second.initial(doc);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "delivery-attempt-limit", pendingUpdates: 1 });
    expect(second.submissions()).toHaveLength(0);
  });
  it("quarantines a sync cut that predates observed host application", async () => {
    const { value, host, doc } = await live(); edit(value, " applied"); const item = await host.submitted();
    Y.applyUpdate(doc, item.bytes); await host.ack(item, 1, 8); host.route.disconnect(); await host.route.settled();
    const second = peer(value, 2); await second.greet(); await second.initial(doc, binding, 7);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "stale-sync-cut" });
  });
  it("refuses an older host epoch", async () => {
    const value = provider(), host = peer(value, 2), doc = document("base");
    await host.greet(); await host.initial(doc); host.route.disconnect(); await host.route.settled();
    const old = peer(value, 1); await old.greet(false);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "stale-host", hostEpoch: 2 });
  });
  it.each(["selectorPaths", "lineageClaimId", "currentPath"] as const)("fences changed %s before any merge", async field => {
    const { value, host } = await live(); host.route.disconnect(); await host.route.settled();
    const old = value.body.toString(), second = peer(value, 2); await second.greet();
    const selected = field === "selectorPaths" ? { ...binding, selectorPaths: ["document.md", "other.md"] }
      : field === "lineageClaimId" ? { ...binding, lineageClaimId: "other" }
      : { ...binding, currentPath: "other.md", selectorPaths: ["other.md"] };
    await second.initial(document("new document"), selected);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "binding-changed" });
    expect(value.body.toString()).toBe(old);
  });
  it("refuses a sync payload that does not cover its claimed host vector", async () => {
    const value = provider(), host = peer(value), doc = document("missing"); await host.greet();
    await host.until(() => host.transfers.some(item => item.begin.purpose === "client-vector"));
    await host.transfer("initial-sync", encodeLiveFrameSync({ binding, hostVector: Y.encodeStateVector(doc),
      missingStateUpdate: Y.encodeStateAsUpdate(provider().doc) }, limits().frames.receive), 0);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "incomplete-sync" });
  });
  it("attributes a baseline before synchronous retirement and fences a changed reconnect", async () => {
    const value = provider(), host = peer(value); await host.greet();
    value.doc.on("update", () => host.route.disconnect());
    await host.initial(document("base"), binding, 7);
    expect(value.state()).toMatchObject({ status: "disconnected", binding });
    expect(host.frames.some(frame => frame.kind === "sync-applied")).toBe(false);
    const before = value.body.toString();
    const second = peer(value, 2); await second.greet();
    await second.initial(document("restored"), { ...binding, restoreFenceGeneration: 1 }, 8);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "binding-changed", binding });
    expect(value.body.toString()).toBe(before);
  });
  it("retains the sync cursor when a document observer retires the route", async () => {
    const value = provider(), host = peer(value), doc = document("base"); await host.greet();
    value.doc.once("update", () => host.route.disconnect());
    await host.initial(doc, binding, 7);
    const second = peer(value, 2); await second.greet(); await second.initial(doc, binding, 6);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "stale-sync-cut", binding });
  });
  it("gives observers independent state snapshots and contains listener failures", async () => {
    const { value } = await live(); const received: string[] = [];
    const stop = value.subscribe(state => { (state.binding!.selectorPaths as string[])[0] = "changed.md"; throw new Error("view failed"); });
    value.subscribe(state => { received.push(state.binding!.selectorPaths[0]!); });
    edit(value, "one"); stop(); edit(value, "two");
    expect(received).toEqual(["document.md", "document.md"]);
    expect(value.state().binding).toEqual(binding);
  });
  it("drains queued edits in order while receiving peer updates", async () => {
    const { value, host, doc } = await live();
    edit(value, " first"); const first = await host.submitted(); edit(value, " second"); edit(value, " third");
    expect(value.state().pendingUpdates).toBe(3); expect(host.submissions()).toHaveLength(1);
    const before = Y.encodeStateVector(doc);
    const content = (getDohcYDocBodyFragment(doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    content.insert(content.length, " peer");
    await host.transfer("applied-update", Y.encodeStateAsUpdate(doc, before), 1);
    expect(value.body.toString()).toContain("peer"); expect(value.state().pendingUpdates).toBe(3);
    await host.ack(first, 1, 2); const second = await host.submitted(2);
    await host.ack(second, 1, 3); const third = await host.submitted(3);
    await host.ack(third, 1, 4);
    expect(value.state()).toMatchObject({ status: "live", pendingUpdates: 0 });
    for (const item of [first, second, third]) Y.applyUpdate(doc, item.bytes);
    expect(value.body.toString()).toBe(getDohcYDocBodyFragment(doc).toString());
  });
  it("records a peer update cursor before a synchronous observer disconnects", async () => {
    const { value, host, doc } = await live();
    const before = Y.encodeStateVector(doc);
    const content = (getDohcYDocBodyFragment(doc).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    content.insert(content.length, " peer");
    value.doc.once("update", () => host.route.disconnect());
    await host.transfer("applied-update", Y.encodeStateAsUpdate(doc, before), 7);
    expect(value.state().status).toBe("disconnected");
    const second = peer(value, 2); await second.greet(); await second.initial(doc, binding, 6);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "stale-sync-cut" });
  });
  it.each(["bytes", "frame"] as const)("retains the draft on an over-budget %s", async kind => {
    if (kind === "bytes") {
      const { value, host } = await live(provider({ ...limits(), maxPendingUpdateBytes: 1 }));
      edit(value, " larger than one byte");
      expect(value.state()).toMatchObject({ status: "quarantined", reason: "pending-update-limit" });
      expect(value.body.toString()).toContain("larger than one byte"); expect(host.submissions()).toHaveLength(0);
    } else {
      const { value, host } = await live(); const before = value.body.toString();
      await host.route.receive(new Uint8Array(1025));
      expect(value.state()).toMatchObject({ status: "quarantined", reason: "inbound-limit" });
      expect(value.body.toString()).toBe(before);
    }
  });
  it("refuses a malformed Yjs update before applying it", async () => {
    const { value, host } = await live(); const before = value.body.toString();
    await host.transfer("applied-update", new Uint8Array([255]), 1);
    expect(value.state()).toMatchObject({ status: "quarantined", reason: "invalid-frame" });
    expect(value.body.toString()).toBe(before);
  });
});
