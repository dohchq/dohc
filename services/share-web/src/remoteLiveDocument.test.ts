import {afterEach, expect, it} from "vitest";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {WebSocketServer} from "ws";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown} from "@dohc/ydoc-projection";
import {createLiveFrameSession, encodeLiveFrameSync, type LiveFrame} from "@dohc/live-session-contract/live-frame";
import {parseHostEpoch} from "@dohc/live-session-contract/host-control";
import {createLinkLiveClient} from "./linkLiveClient";
import {remoteLiveDocument} from "./remoteLiveDocument";
import {LIVE_UPDATE_REFUSAL_VALUES, type LiveUpdateRefusal} from "@dohc/live-session-contract/live-update-admission";

const limits = {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
  maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
  maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const stop of cleanup.splice(0)) await stop();});

async function fixture(acknowledge: boolean, maxPendingUpdateBytes = limits.provider.maxPendingUpdateBytes, result?: LiveUpdateRefusal | "application-pending") {
  const doc = markdownToYDoc("Hello **world**.\n");
  const server = new WebSocketServer({port: 0, host: "127.0.0.1", perMessageDeflate: false, handleProtocols: () => "dohc-live-v1"});
  await once(server, "listening");
  const address = server.address(); if (typeof address === "string" || !address) throw Error("No test listener");
  let submission!: () => void;
  const submitted = new Promise<void>(resolve => {submission = resolve;});
  let ack!: () => void;
  const ackGate = new Promise<void>(resolve => {ack = resolve;});
  const failures: unknown[] = [];
  const frames = limits.provider.frames;
  server.on("connection", (socket, request) => {
    expect(request.headers.authorization).toBe(`Bearer ${"A".repeat(43)}`);
    expect(request.headers["x-dohc-link-profile-secret"]).toBe("B".repeat(43));
    const protocol = createLiveFrameSession("server", frames);
    socket.on("close", () => protocol.close());
    let chain = Promise.resolve();
    async function send(frame: LiveFrame) {
      const lease = protocol.send(frame);
      try {await new Promise<void>((resolve, reject) => socket.send(lease.value, {binary: true}, error => error ? reject(error) : resolve()));}
      finally {lease.release();}
    }
    socket.on("message", bytes => {
      chain = chain.then(async () => {
        const lease = protocol.receive(bytes as Buffer);
        const frame = lease.value.frame;
        const transfer = lease.value.transfer && {begin: lease.value.transfer.value.begin, bytes: lease.value.transfer.value.bytes.slice()};
        lease.value.transfer?.release(); lease.release();
        if (frame.kind === "hello") {
          await send({kind: "welcome", hostEpoch: parseHostEpoch(1), receivePolicy: frames.receive});
          await send({kind: "credit", grantedBytes: frames.maxQueuedBytes, grantedFrames: frames.maxQueuedFrames});
        }
        if (transfer?.begin.purpose === "client-vector") {
          const sync = encodeLiveFrameSync({binding: {workspaceId: "workspace", mainVersionId: "main", objectId: "document", lineageClaimId: "lineage", currentPath: "doc.md", selectorPaths: ["doc.md"], restoreFenceGeneration: 0},
            hostVector: Y.encodeStateVector(doc), missingStateUpdate: Y.encodeStateAsUpdate(doc, transfer.bytes)}, frames.receive);
          await send({kind: "begin", purpose: "initial-sync", transferId: 1, totalBytes: sync.length, digest: createHash("sha256").update(sync).digest("hex"), appliedThroughJournalCursor: 0});
          for (let offset = 0; offset < sync.length; offset += 900) await send({kind: "chunk", transferId: 1, offset, bytes: sync.subarray(offset, offset + 900)});
        }
        if (transfer?.begin.purpose === "submit-update") {
          if (result) {
            await send(result === "application-pending"
              ? {kind: "result", result: "retry", deliveryId: transfer.begin.deliveryId, updateDigest: transfer.begin.digest, reason: result}
              : {kind: "result", result: "refused", deliveryId: transfer.begin.deliveryId, updateDigest: transfer.begin.digest, reason: result});
            submission(); return;
          }
          Y.applyUpdate(doc, transfer.bytes); submission();
          if (!acknowledge) {socket.terminate(); return;}
          await ackGate;
          await send({kind: "result", result: "success", ack: {deliveryId: transfer.begin.deliveryId, updateDigest: transfer.begin.digest,
            journalCursor: 1, acceptingHostEpoch: parseHostEpoch(1), localYDocSequence: 1, applicationReplayed: false}});
        }
      }).catch(error => {failures.push(error); socket.terminate();});
    });
  });
  cleanup.push(async () => {for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); doc.destroy(); expect(failures).toEqual([]);});
  // A loaded gate host can stall the real socket handshake past 1 s. The whole
  // edit gets 20 s so each 10 s step stays inside it.
  const client = createLinkLiveClient({relayUrl: `http://127.0.0.1:${address.port}`, publicOrigin: "https://share.example.test", exchangeKey: "test-exchange-key-at-least-thirty-two-bytes",
    limits: {maxPendingRequests: 4, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 10_000}, browserLimits: limits,
    async resolveMaterial() {return {ok: true, capabilityToken: "A".repeat(43), profileSecret: "B".repeat(43), setCookie: null, currentCapability: async () => "A".repeat(43)};},
    async fetchRelay() {throw Error("Not used");}});
  return {doc, submitted, ack, run: () => remoteLiveDocument({client, limits: {...limits, provider: {...limits.provider, maxPendingUpdateBytes}}, discriminator: "abcdefghijkl", cookie: "test=cookie", signal: AbortSignal.timeout(20_000),
    async request(path) {return Response.json(path.endsWith("document") ? {objectId: "document"} : {token: "ab".repeat(32)});}}, "doc.md", {find: "world", replacement: "friend"})};
}

it("waits for host acknowledgement over the real live socket", async () => {
  const f = await fixture(true); let finished = false;
  const result = f.run().then(value => {finished = true; return value;});
  await f.submitted;
  expect(finished).toBe(false); expect(yDocToMarkdown(f.doc)).toContain("**friend**");
  f.ack();
  expect(await result).toMatchObject({ok: true, outcome: "applied", acknowledgement: {journalCursor: 1}});
});

it("reports unknown when the host applies the edit but the acknowledgement is lost", async () => {
  const f = await fixture(false);
  expect(await f.run()).toMatchObject({ok: false, outcome: "unknown"});
  expect(yDocToMarkdown(f.doc)).toContain("**friend**");
});

it("reports a local size refusal as not applied and sends no edit", async () => {
  const f = await fixture(false, 1);
  expect(await f.run()).toMatchObject({ok: false, outcome: "not-applied", error: "pending-update-limit"});
  expect(yDocToMarkdown(f.doc)).toContain("**world**");
});

it.each(LIVE_UPDATE_REFUSAL_VALUES)("reports the host refusal %s as not applied", async reason => {
  const f = await fixture(false, limits.provider.maxPendingUpdateBytes, reason);
  expect(await f.run()).toMatchObject({ok: false, outcome: "not-applied", error: reason});
  expect(yDocToMarkdown(f.doc)).toContain("**world**");
});

it("keeps application-pending ambiguous", async () => {
  const f = await fixture(false, limits.provider.maxPendingUpdateBytes, "application-pending");
  expect(await f.run()).toMatchObject({ok: false, outcome: "unknown"});
});
