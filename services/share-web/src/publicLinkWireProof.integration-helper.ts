import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {WebSocket} from "ws";
import type {BrowserContext} from "@playwright/test";
import {expect} from "vitest";
import * as Y from "yjs";
import {createLiveFrameSession, decodeLiveFrameSync, encodeLiveFrame, type LiveFrame, type LiveFrameSessionPolicy} from "@dohc/live-session-contract/live-frame";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Ticket = {discriminator: string; token: string};
type Outcome = Extract<LiveFrame, {kind: "result"}> | {kind: "socket-closed"; code: number};

// Wire transport adapted from admitted158; authentication is the production public cookie exchange.
export function createPublicLinkWireProof(input: {audience: string; root: string; frames: LiveFrameSessionPolicy; timeoutMs: number}) {
  const {audience, root, frames, timeoutMs} = input;
  const sockets = new Set<WebSocket>(), documents = new Set<Y.Doc>(), events: unknown[] = [];
  const save = () => writeFileSync(join(root, "public-wire-evidence.json"), JSON.stringify({events}, null, 2));
  async function ticket(context: BrowserContext, discriminator: string, objectId: string): Promise<Ticket> {
    const response = await context.request.post(audience + "/api/live/link-ticket", {data: {discriminator, objectId}, headers: {origin: audience}});
    expect(response.status()).toBe(200);
    const minted = await response.json();
    return {discriminator, token: minted.token};
  }
  async function connect(context: BrowserContext, minted: Ticket, label: string, origin: string | null = audience) {
    const cookies = (await context.cookies(audience)).map(row => `${row.name}=${row.value}`).join("; ");
    const url = new URL("/api/live/link", audience); url.protocol = "wss:"; url.searchParams.set("session", minted.discriminator);
    const ws = new WebSocket(url, ["dohc-live-v1", `dohc-live-ticket.${minted.token}`], {
      headers: {cookie: cookies, ...(origin === null ? {} : {origin})}, perMessageDeflate: false,
      ca: readFileSync(new URL("./testing/device-control/localhost-cert.pem", import.meta.url)),
    });
    sockets.add(ws);
    const protocol = createLiveFrameSession("client", frames), received: LiveFrame[] = [];
    let closed: number | undefined, failure: Error | undefined, synced = false, nextTransfer = 1;
    let grantedBytes = frames.maxQueuedBytes, grantedFrames = frames.maxQueuedFrames;
    let sentDataBytes = 0, sentDataFrames = 0;
    let initialServerCredit: Extract<LiveFrame, {kind: "credit"}> | undefined;
    let initialBinding: ReturnType<typeof decodeLiveFrameSync>["binding"] | undefined;
    const doc = new Y.Doc({gc: false}), waiters = new Set<() => void>(); documents.add(doc);
    const notify = () => {for (const waiter of [...waiters]) waiter();};
    function until(condition: () => boolean) {
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error(`${label}: condition deadline`)), timeoutMs);
        const finish = (error?: Error) => {clearTimeout(timeout); waiters.delete(check); error ? reject(error) : resolve();};
        const check = () => {if (condition()) finish(); else if (failure) finish(failure); else if (closed !== undefined) finish(new Error(`${label}: socket closed ${closed}`));};
        waiters.add(check); check();
      });
    }
    function send(frame: LiveFrame) {
      const lease = protocol.send(frame);
      try {
        ws.send(lease.value);
        if (frame.kind === "begin" || frame.kind === "chunk") {sentDataBytes += lease.value.length; sentDataFrames++;}
      } finally {lease.release();}
    }
    const status = new Promise<number>(resolve => {
      ws.once("open", () => resolve(101));
      ws.once("unexpected-response", (_request, response) => {response.resume(); resolve(response.statusCode!); ws.terminate();});
      ws.once("error", () => resolve(0));
    });
    ws.on("error", error => {events.push({label, socketError: String(error)}); save(); notify();});
    ws.on("close", (code, reason) => {closed = code; sockets.delete(ws); events.push({label, closed: code, reason: reason.toString()}); save(); notify();});
    ws.on("message", data => {
      try {
        const bytes = new Uint8Array(data as Buffer), lease = protocol.receive(bytes);
        const {frame, transfer} = lease.value;
        // Chunk payloads are held by the transfer and document, not the control history.
        if (frame.kind !== "chunk") received.push(frame);
        events.push({label, received: frame.kind === "chunk" ? {...frame, bytes: {sha256: hash(frame.bytes), byteLength: frame.bytes.length}} : frame});
        try {
          if (transfer) {
            const {begin, bytes: content} = transfer.value;
            expect(hash(content)).toBe(begin.digest);
            if (begin.purpose === "initial-sync") {
              const sync = decodeLiveFrameSync(content, frames.receive);
              initialBinding = sync.binding;
              Y.applyUpdate(doc, sync.missingStateUpdate);
              events.push({label, initialBinding: sync.binding, vectorSha256: hash(sync.hostVector)});
              send({kind: "sync-applied", appliedThroughJournalCursor: begin.appliedThroughJournalCursor}); synced = true;
            } else if (begin.purpose === "applied-update") Y.applyUpdate(doc, content);
          }
        } finally {transfer?.release(); lease.release();}
        if (frame.kind === "begin" || frame.kind === "chunk") {
          grantedBytes += bytes.length; grantedFrames++;
          send({kind: "credit", grantedBytes, grantedFrames});
        }
        save(); notify();
      } catch (error) {failure = error instanceof Error ? error : new Error(String(error)); events.push({label, protocolError: String(error)}); save(); notify();}
    });
    async function sync() {
      expect(await status).toBe(101);
      await until(() => received.some(frame => frame.kind === "credit"));
      initialServerCredit = received.find((frame): frame is Extract<LiveFrame, {kind: "credit"}> => frame.kind === "credit")!;
      send({kind: "hello", receivePolicy: frames.receive}); send({kind: "credit", grantedBytes, grantedFrames});
      const vector = Y.encodeStateVector(doc), id = nextTransfer++;
      send({kind: "begin", purpose: "client-vector", transferId: id, totalBytes: vector.length, digest: hash(vector)});
      send({kind: "chunk", transferId: id, offset: 0, bytes: vector});
      await until(() => synced);
    }
    function start(bytes: Uint8Array, deliveryId: string) {
      const id = nextTransfer++;
      send({kind: "begin", purpose: "submit-update", transferId: id, totalBytes: bytes.length, digest: hash(bytes), deliveryId});
      return {kind: "chunk" as const, transferId: id, offset: 0, bytes};
    }
    async function partial(bytes: Uint8Array, deliveryId: string) {
      const chunk = start(bytes, deliveryId);
      const target = {grantedBytes: initialServerCredit!.grantedBytes + sentDataBytes,
        grantedFrames: initialServerCredit!.grantedFrames + sentDataFrames};
      const coversBegin = (frame: LiveFrame): frame is Extract<LiveFrame, {kind: "credit"}> => frame.kind === "credit" &&
        frame.grantedBytes >= target.grantedBytes && frame.grantedFrames >= target.grantedFrames;
      await until(() => received.some(coversBegin));
      events.push({label, partialBeginAcknowledged: deliveryId, initialServerCredit, sentDataBytes, sentDataFrames,
        target, witnessedCredit: received.find(coversBegin), at: Date.now()}); save(); return chunk;
    }
    async function submit(bytes: Uint8Array, deliveryId: string): Promise<Outcome> {
      const welcome = received.find((frame): frame is Extract<LiveFrame, {kind: "welcome"}> => frame.kind === "welcome");
      if (!welcome) throw new Error("Server receive policy missing.");
      const maximum = welcome.receivePolicy.maxFrameBytes;
      const id = nextTransfer++;
      const begin: LiveFrame = {kind: "begin", purpose: "submit-update", transferId: id, totalBytes: bytes.length, digest: hash(bytes), deliveryId};
      await until(() => protocol.usage().outgoing.promisedFrames >= 1 &&
        protocol.usage().outgoing.promisedBytes >= encodeLiveFrame(begin, maximum).length);
      send(begin);
      const overhead = encodeLiveFrame({kind: "chunk", transferId: id, offset: 0, bytes: new Uint8Array(1)}, maximum).length - 1;
      for (let offset = 0; offset < bytes.length;) {
        await until(() => protocol.usage().outgoing.promisedFrames >= 1 && protocol.usage().outgoing.promisedBytes > overhead);
        const length = Math.min(maximum, frames.maxQueuedBytes, protocol.usage().outgoing.promisedBytes) - overhead;
        if (length < 1) throw new Error("No admitted chunk capacity.");
        const chunk = bytes.subarray(offset, offset + length);
        send({kind: "chunk", transferId: id, offset, bytes: chunk}); offset += chunk.length;
      }
      await until(() => closed !== undefined || received.some(frame => frame.kind === "result" &&
        (frame.result === "success" ? frame.ack.deliveryId : frame.deliveryId) === deliveryId));
      const outcome = received.find((frame): frame is Extract<LiveFrame, {kind: "result"}> => frame.kind === "result" &&
        (frame.result === "success" ? frame.ack.deliveryId : frame.deliveryId) === deliveryId);
      if (outcome?.result === "success") {Y.applyUpdate(doc, bytes); notify();}
      return outcome ?? {kind: "socket-closed", code: closed!};
    }
    async function hostileSend(frame: LiveFrame) {
      const bytes = encodeLiveFrame(frame, frames.receive.maxFrameBytes), state = ws.readyState;
      const error = await new Promise<string | null>(resolve => ws.send(bytes, error => resolve(error ? String(error) : null)));
      events.push({label, hostileSend: frame.kind, transferId: "transferId" in frame ? frame.transferId : undefined,
        readyState: state, byteLength: bytes.length, sha256: hash(bytes), error, at: Date.now()}); save();
    }
    async function close() {if (closed === undefined) {ws.close(); await until(() => closed !== undefined);} protocol.close(); doc.destroy(); documents.delete(doc);}
    return {ws, status, sync, doc, partial, submit, hostileSend, close, until,
      get binding() {return initialBinding;}, get hostEpoch() {return received.find((frame): frame is Extract<LiveFrame, {kind: "welcome"}> => frame.kind === "welcome")?.hostEpoch;}, get closed() {return closed;}};
  }

  return {ticket, connect, events, async close() {
    for (const socket of sockets) socket.terminate();
    for (const doc of documents) doc.destroy();
    save();
  }};
}
