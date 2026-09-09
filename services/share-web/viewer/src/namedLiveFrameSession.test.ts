import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { decodeLiveFrame, encodeLiveFrame, encodeLiveFrameSync, type LiveFrame } from "@dohc/live-session-contract/live-frame";
import { createNamedLiveFrameSession, type NamedFrameAppliedUpdate, type NamedFrameHostSession,
  type NamedFrameSubmissionResult } from "../../../sync-relay/src/namedLiveFrameSession.js";
import { createNamedLiveProvider } from "./namedLiveProvider";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const frames = { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384 },
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384 };
const binding = { workspaceId: "workspace", mainVersionId: "main", objectId: "document", lineageClaimId: "lineage",
  currentPath: "document.md", selectorPaths: ["document.md"], restoreFenceGeneration: 0 };
const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(result: "success" | "retry" | "refused" = "success", limitCredit = false) {
  const provider = createNamedLiveProvider({ frames, maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4 });
  const doc = new Y.Doc();
  const content = new Y.XmlText(); content.insert(0, "base");
  const paragraph = new Y.XmlElement("paragraph"); paragraph.insert(0, [content]); getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  const invalidated = new AbortController(), watchers = new Set<() => void>();
  const pulse = () => { for (const watch of [...watchers]) watch(); };
  function until(condition: () => boolean) {
    if (condition()) return Promise.resolve();
    return new Promise<void>(resolve => { const watch = () => { if (condition()) { watchers.delete(watch); resolve(); } }; watchers.add(watch); });
  }
  provider.subscribe(pulse);
  const serverReady = deferred<ReturnType<typeof createNamedLiveFrameSession>>();
  const clientReady = deferred<ReturnType<typeof provider.connect>>();
  const sent: LiveFrame[] = [], submitted: { deliveryId: string; updateDigest: string; updateBytes: Uint8Array }[] = [];
  const initialBytes = encodeLiveFrameSync({ binding, hostVector: Y.encodeStateVector(doc), missingStateUpdate: Y.encodeStateAsUpdate(doc) }, frames.receive);
  const initialCredit = encodeLiveFrame({ kind: "begin", purpose: "initial-sync", transferId: 1, totalBytes: initialBytes.length,
    digest: hash(initialBytes), appliedThroughJournalCursor: 0 }, 1024).length +
    encodeLiveFrame({ kind: "chunk", transferId: 1, offset: 0, bytes: initialBytes }, 1024).length;
  let latestCredit: Uint8Array | undefined;
  let pull = deferred<NamedFrameAppliedUpdate>(), pulls = 0, leased = 0, releases = 0, cursor = 0;
  let stall: ((frame: LiveFrame) => boolean) | undefined, stalled: ReturnType<typeof deferred<void>> | undefined;
  let blockedOpen: ReturnType<typeof deferred<void>> | undefined, blockedSubmit: ReturnType<typeof deferred<void>> | undefined;
  const syncClosed = vi.fn(), hostClosed = vi.fn();
  const wait = async (block: ReturnType<typeof deferred<void>> | undefined, signal: AbortSignal) => {
    if (!block) return;
    const aborted = () => block.reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    try { signal.throwIfAborted(); await block.promise; } finally { signal.removeEventListener("abort", aborted); }
  };
  const host: NamedFrameHostSession = {
    hostEpoch: parseHostEpoch(1),
    invalidated: invalidated.signal, assertCurrent() { invalidated.signal.throwIfAborted(); }, close: hostClosed,
    async openSync(vector, signal) {
      await wait(blockedOpen, signal);
      return { binding, hostVector: Y.encodeStateVector(doc), missingStateUpdate: Y.encodeStateAsUpdate(doc, vector), appliedThroughJournalCursor: cursor,
        close: syncClosed,
        async nextApplied(signal) {
          pulls++; pulse();
          const held = pull;
          const aborted = () => held.reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          try {
            signal.throwIfAborted(); const value = await held.promise; pull = deferred(); leased++; pulse();
            let released = false;
            return { value, release() { if (!released) { released = true; leased--; releases++; pulse(); } } };
          } finally { signal.removeEventListener("abort", aborted); }
        },
      };
    },
    async submit(input, signal): Promise<NamedFrameSubmissionResult> {
      submitted.push({ ...input, updateBytes: input.updateBytes.slice() }); pulse();
      await wait(blockedSubmit, signal);
      expect(hash(input.updateBytes)).toBe(input.updateDigest);
      if (result === "retry") return { result, reason: "application-pending" };
      if (result === "refused") return { result, reason: "restore-fenced" };
      Y.applyUpdate(doc, input.updateBytes);
      return { result, ack: { deliveryId: input.deliveryId, updateDigest: input.updateDigest, journalCursor: ++cursor,
        acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: cursor + 5, applicationReplayed: false } };
    },
  };
  const route = provider.connect({ async send(bytes) {
    const server = await serverReady.promise;
    if (limitCredit && decodeLiveFrame(bytes, 1024).kind === "credit") {
      const first = !latestCredit;
      latestCredit = bytes.slice();
      if (first) server.receive(encodeLiveFrame({ kind: "credit", grantedBytes: initialCredit, grantedFrames: 2 }, 1024));
    } else server.receive(bytes);
    pulse();
  }, close() { serverReady.promise.then(server => server.close()); } });
  clientReady.resolve(route);
  const server = createNamedLiveFrameSession({ host, frames, transport: {
    async send(bytes) {
      const frame = decodeLiveFrame(bytes, frames.receive.maxFrameBytes); sent.push(frame);
      if (stall?.(frame)) { stalled = deferred(); pulse(); await stalled.promise; stalled = undefined; }
      await (await clientReady.promise).receive(bytes); pulse();
    },
    close() { stalled?.resolve(); route.disconnect(); pulse(); },
  } });
  serverReady.resolve(server);
  stops.push(async () => { server.close(); provider.close(); await server.settled(); await route.settled(); doc.destroy(); provider.doc.destroy(); });
  return { provider, doc, route, server, submitted, sent, until, invalidated, syncClosed, hostClosed,
    metrics: () => ({ pulls, leased, releases, stalled: !!stalled }),
    edit(text: string) { const content = (provider.body.get(0) as Y.XmlElement).get(0) as Y.XmlText; content.insert(content.length, text); },
    peerEdit(text: string) { const vector = Y.encodeStateVector(doc); content.insert(content.length, text); pull.resolve({ journalCursor: ++cursor, updateBytes: Y.encodeStateAsUpdate(doc, vector) }); },
    stall(predicate: (frame: LiveFrame) => boolean) { stall = predicate; },
    release() { stall = undefined; stalled?.resolve(); },
    grantCredit() { limitCredit = false; server.receive(latestCredit!); },
    blockOpen() { blockedOpen = deferred(); }, blockSubmit() { blockedSubmit = deferred(); },
  };
}

it("round-trips canonical V1 bytes and exact application ACK identity through the real provider and server", async () => {
  const f = fixture(); await f.until(() => f.provider.state().status === "live");
  expect(f.provider.body.toString()).toBe(getDohcYDocBodyFragment(f.doc).toString());
  let original: Uint8Array | undefined;
  f.provider.doc.once("update", bytes => { original = bytes.slice(); });
  f.edit(" local"); await f.until(() => f.provider.state().lastApplied !== null);
  expect(f.submitted).toHaveLength(1); expect(f.submitted[0]!.updateBytes).toEqual(original);
  expect(f.provider.state().lastApplied).toMatchObject({ deliveryId: f.submitted[0]!.deliveryId, updateDigest: hash(original!), journalCursor: 1, localYDocSequence: 6 });
  expect(f.provider.state().pendingUpdates).toBe(0);
  await f.until(() => f.metrics().pulls === 1); f.peerEdit(" peer");
  await f.until(() => f.metrics().releases === 1);
  expect(f.provider.body.toString()).toBe(getDohcYDocBodyFragment(f.doc).toString());
  expect(f.submitted).toHaveLength(1);
});

it.each(["retry", "refused"] as const)("preserves the browser draft after a server %s", async result => {
  const f = fixture(result); await f.until(() => f.provider.state().status === "live"); f.edit(" draft");
  await f.until(() => f.provider.state().status === (result === "retry" ? "disconnected" : "quarantined"));
  expect(f.provider.state()).toMatchObject({ pendingUpdates: 1, lastApplied: null });
  expect(f.provider.body.toString()).toContain("draft"); await f.server.settled();
  expect(f.server.usage().closed).toBe(true); expect(f.hostClosed).toHaveBeenCalledTimes(1);
});

it("holds one native update and one transport send until a slow send releases its bytes", async () => {
  const f = fixture(); await f.until(() => f.metrics().pulls === 1);
  f.stall(frame => frame.kind === "chunk"); f.peerEdit(" peer");
  await f.until(() => f.metrics().stalled);
  expect(f.metrics()).toMatchObject({ pulls: 1, leased: 1, releases: 0 });
  expect(f.server.usage().outgoing.queuedFrames).toBe(1);
  f.release(); await f.until(() => f.metrics().pulls === 2);
  expect(f.metrics()).toMatchObject({ leased: 0, releases: 1 });
});

it("does not pull native output after initial sync consumes all frame credit", async () => {
  const f = fixture("success", true);
  await f.until(() => f.server.usage().live);
  await f.server.settled();
  expect(f.server.usage().outgoing.promisedFrames).toBe(0);
  expect(f.metrics().pulls).toBe(0);
  f.grantCredit(); await f.until(() => f.metrics().pulls === 1);
});

it.each(["initial", "submit", "send"] as const)("releases pending %s work on standing invalidation", async stage => {
  const f = fixture();
  if (stage === "initial") { f.blockOpen(); await f.until(() => f.server.usage().opening); }
  else {
    await f.until(() => f.metrics().pulls === 1);
    if (stage === "submit") { f.blockSubmit(); f.edit(" pending"); await f.until(() => f.submitted.length === 1); }
    else { f.stall(frame => frame.kind === "chunk"); f.peerEdit(" peer"); await f.until(() => f.metrics().stalled); }
  }
  f.invalidated.abort(new Error("Host changed.")); await f.server.settled(); await f.route.settled();
  expect(f.server.usage()).toMatchObject({ closed: true, pulling: false, submitting: false, opening: false });
  expect(f.metrics().leased).toBe(0); expect(f.hostClosed).toHaveBeenCalledTimes(1);
  if (stage === "submit") expect(f.provider.state().pendingUpdates).toBe(1);
});
