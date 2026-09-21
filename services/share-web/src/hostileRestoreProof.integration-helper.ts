import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WebSocket} from "ws";
import type {BrowserContext} from "@playwright/test";
import {expect} from "vitest";
import * as Y from "yjs";
import {yDocToMarkdown} from "@dohc/ydoc-projection";
import {createLiveFrameSession, decodeLiveFrameSync, encodeLiveFrame, type LiveFrame,
  type LiveFrameSessionPolicy} from "@dohc/live-session-contract/live-frame";
import {ensureLocalhostTls} from "./testing/device-control/localhostTls.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Ticket = {discriminator: string; token: string; expiresAtMs: number};
type Outcome = Extract<LiveFrame, {kind: "result"}> | {kind: "socket-closed"; code: number};

/** Opt-in wire proof. Authentication, restore, admission and native application use real services. */
export async function prepareHostileRestoreProof(input: {
  audience: string; root: string; workspace: string; frames: LiveFrameSessionPolicy;
  stoppedContext: BrowserContext; allowedContext: BrowserContext;
}) {
  const {audience, root, workspace, frames} = input;
  const sockets = new Set<WebSocket>(), documents = new Set<Y.Doc>();
  const events: unknown[] = [], cases: Record<string, unknown> = {};
  const deliveryIds = {partial: "hostile-old-partial", continued: "hostile-old-continued",
    accepted: "hostile-accepted-replay", offline: "hostile-offline-tail", fresh: "hostile-fresh-control"};
  const save = () => writeFileSync(join(root, "hostile-evidence.json"), JSON.stringify({
    version: 1, deliveryIds, cases, events,
    scope: "Private named HTTPS/WSS hostile stop/restore. Draft files are retained proof inputs, not a product quarantine UI.",
  }, null, 2) + "\n");
  const retain = (name: string, bytes: Uint8Array) => {
    const path = join(root, name); writeFileSync(path, bytes);
    const pin = {path, sha256: hash(bytes), byteLength: bytes.length}; events.push({retained: pin}); save(); return pin;
  };
  async function ticket(context: BrowserContext, grantId: string): Promise<Ticket> {
    const post = async (path: string, data: unknown) => {
      const response = await context.request.post(`${audience}${path}`, {data, headers: {origin: audience}});
      expect(response.status()).toBe(200); return response.json();
    };
    const session = await post("/api/live/named-session", {grantId});
    const minted = await post("/api/live/named-ticket", {discriminator: session.discriminator, objectId: "object"});
    expect(Number.isSafeInteger(minted.expiresAtMs)).toBe(true);
    expect(minted.expiresAtMs).toBeGreaterThan(Date.now());
    return {discriminator: session.discriminator, token: minted.token, expiresAtMs: minted.expiresAtMs};
  }
  async function connect(context: BrowserContext, minted: Ticket, label: string) {
    const cookies = (await context.cookies(audience)).map(row => `${row.name}=${row.value}`).join("; ");
    const url = new URL("/api/live", audience); url.protocol = "wss:"; url.searchParams.set("session", minted.discriminator);
    const ws = new WebSocket(url, ["dohc-live-v1", `dohc-live-ticket.${minted.token}`], {
      headers: {origin: audience, cookie: cookies}, perMessageDeflate: false,
      ca: readFileSync((await ensureLocalhostTls()).certificate),
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
        const timeout = setTimeout(() => finish(new Error(`${label}: condition deadline`)), 30000);
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
        const {frame, transfer} = lease.value; received.push(frame);
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
      send(start(bytes, deliveryId));
      await until(() => closed !== undefined || received.some(frame => frame.kind === "result" &&
        (frame.result === "success" ? frame.ack.deliveryId : frame.deliveryId) === deliveryId));
      return received.find((frame): frame is Extract<LiveFrame, {kind: "result"}> => frame.kind === "result" &&
        (frame.result === "success" ? frame.ack.deliveryId : frame.deliveryId) === deliveryId) ?? {kind: "socket-closed", code: closed!};
    }
    async function hostileSend(frame: LiveFrame, requireOpen = false) {
      const bytes = encodeLiveFrame(frame, frames.receive.maxFrameBytes), state = ws.readyState;
      const error = await new Promise<string | null>(resolve => ws.send(bytes, error => resolve(error ? String(error) : null)));
      events.push({label, hostileSend: frame.kind, transferId: "transferId" in frame ? frame.transferId : undefined,
        readyState: state, byteLength: bytes.length, sha256: hash(bytes), error, at: Date.now()}); save();
      if (requireOpen) {expect(state).toBe(WebSocket.OPEN); expect(error).toBeNull();}
    }
    async function close() {if (closed === undefined) {ws.close(); await until(() => closed !== undefined);} protocol.close(); doc.destroy(); documents.delete(doc);}
    return {ws, status, sync, doc, partial, submit, hostileSend, close, until,
      get deliveryResults() {return received.filter((frame): frame is Extract<LiveFrame, {kind: "result"}> => frame.kind === "result");},
      get binding() {return initialBinding;}, get closed() {return closed;}};
  }
  function persisted(label: string) {
    const relay = new DatabaseSync(join(root, "relay", "relay.sqlite"), {readOnly: true});
    const native = new DatabaseSync(join(workspace, ".dohc", "engine", "engine.db"), {readOnly: true});
    try {
      const ids = Object.values(deliveryIds), placeholders = ids.map(() => "?").join(",");
      const columns = "delivery_id,update_digest,journal_cursor,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation";
      const journal = relay.prepare(`SELECT ${columns} FROM sync_relay_live_update_journal WHERE delivery_id IN (${placeholders}) ORDER BY journal_cursor`).all(...ids);
      const applications = native.prepare(`SELECT ${columns},first_seen_count FROM live_device_update_applications WHERE delivery_id IN (${placeholders}) ORDER BY journal_cursor`).all(...ids);
      const history = relay.prepare(`SELECT ${columns} FROM sync_relay_live_update_journal ORDER BY journal_cursor`).all();
      const provenance = relay.prepare("SELECT * FROM sync_relay_live_update_struct_provenance ORDER BY journal_cursor,client_id,start_clock").all();
      const nativeProvenance = native.prepare("SELECT * FROM live_device_application_first_seen ORDER BY delivery_id,ordinal").all();
      const snapshot = {label, journal, applications, history, provenance, nativeProvenance,
        markdown: readFileSync(join(workspace, "docs/a.md"), "utf8")};
      events.push({persisted: snapshot}); save(); return snapshot;
    } finally {relay.close(); native.close();}
  }
  try {
  const old = await connect(input.stoppedContext, await ticket(input.stoppedContext, "grant-0"), "old-generation");
  await old.sync();
  const originalBinding = old.binding;
  expect(originalBinding?.restoreFenceGeneration).toBe(1);
  const accepted = Y.encodeStateAsUpdate(old.doc); retain("hostile-accepted-before-restore.yjs", accepted);
  const originalVector = retain("hostile-before-restore-vector.yjs", Y.encodeStateVector(old.doc));
  const offline = new Y.Doc({gc: false}); Y.applyUpdate(offline, accepted);
  offline.getMap("frontmatter").set("offlineProbe", "authored before restore");
  const offlineBytes = Y.encodeStateAsUpdate(offline); retain("hostile-offline-before-restore.yjs", offlineBytes);
  retain("hostile-offline-delta.yjs", Y.encodeStateAsUpdate(offline, Y.encodeStateVector(old.doc)));
  offline.destroy();
  const unusedOldTicket = await ticket(input.allowedContext, "grant-1");
  const partial = await old.partial(offlineBytes, deliveryIds.partial);
  const beforeStop = persisted("before-stop"); cases.beforeStop = beforeStop; save();
  expect(beforeStop.provenance.length).toBeGreaterThan(0); expect(beforeStop.nativeProvenance.length).toBeGreaterThan(0);
  return {
    async stopped() {
      events.push({authorityInvalidationObservedAt: Date.now()}); save();
      await old.hostileSend(partial, true);
      const id = partial.transferId + 1;
      await old.hostileSend({kind: "begin", purpose: "submit-update", transferId: id,
        totalBytes: offlineBytes.length, digest: hash(offlineBytes), deliveryId: deliveryIds.continued});
      await old.hostileSend({kind: "chunk", transferId: id, offset: 0, bytes: offlineBytes});
      await old.until(() => old.closed !== undefined);
      const snapshot = persisted("after-stop");
      cases.oldGeneration = {closed: old.closed, snapshot, deliveryResults: old.deliveryResults,
        observation: "An acknowledged partial transfer was active before invalidation. The client attempted its remaining bytes while locally OPEN; the connection then closed without journal or native admission.",
        postInvalidationServerReadProven: false, commitRecheckProven: false,
        pass: old.closed !== undefined && snapshot.journal.length === 0 && snapshot.applications.length === 0}; save();
    },
    async restored(settle: () => Promise<unknown>) {
      const oldTicketConnectAt = Date.now();
      const unexpiredAtConnect = oldTicketConnectAt < unusedOldTicket.expiresAtMs;
      cases.oldTicket = {expiresAtMs: unusedOldTicket.expiresAtMs, connectAt: oldTicketConnectAt,
        unexpiredAtConnect, classification: "NOT_OBSERVED", pass: false}; save();
      expect(unexpiredAtConnect, "Old-ticket invalidation cannot be proved with an expired ticket.").toBe(true);
      const stale = await connect(input.allowedContext, unusedOldTicket, "unused-old-ticket");
      const oldTicketStatus = await stale.status;
      const oldTicketResponseAt = Date.now(), unexpiredAtResponse = oldTicketResponseAt < unusedOldTicket.expiresAtMs;
      cases.oldTicket = {status: oldTicketStatus, expiresAtMs: unusedOldTicket.expiresAtMs,
        connectAt: oldTicketConnectAt, responseAt: oldTicketResponseAt, unexpiredAtConnect, unexpiredAtResponse,
        classification: unexpiredAtResponse ? "OBSERVED" : "NOT_OBSERVED", pass: unexpiredAtResponse && oldTicketStatus === 404}; save();
      await stale.close();
      const replay = await connect(input.allowedContext, await ticket(input.allowedContext, "grant-1"), "accepted-history-only");
      await replay.sync(); expect(yDocToMarkdown(replay.doc)).toBe("Hello");
      const acceptedOutcome = await replay.submit(accepted, deliveryIds.accepted);
      await settle(); const acceptedSnapshot = persisted("accepted-history-replay");
      const originalProvenanceRetained = beforeStop.provenance.every(row => acceptedSnapshot.provenance.some(after => JSON.stringify(after) === JSON.stringify(row))) &&
        beforeStop.nativeProvenance.every(row => acceptedSnapshot.nativeProvenance.some(after => JSON.stringify(after) === JSON.stringify(row)));
      const originalHistoryRetained = beforeStop.history.every(row => acceptedSnapshot.history.some(after => JSON.stringify(after) === JSON.stringify(row)));
      cases.acceptedHistory = {originalBinding, currentBinding: replay.binding, outcome: acceptedOutcome, snapshot: acceptedSnapshot, originalProvenanceRetained, originalHistoryRetained,
        pass: acceptedOutcome.kind === "result" && acceptedOutcome.result === "success" && acceptedSnapshot.markdown === "Hello" && originalProvenanceRetained && originalHistoryRetained &&
          acceptedSnapshot.applications.some(row => row.delivery_id === deliveryIds.accepted) &&
          acceptedSnapshot.applications.filter(row => row.delivery_id === deliveryIds.accepted).every(row => row.first_seen_count === 0)}; save();
      await replay.close();
      const staleDraft = await connect(input.allowedContext, await ticket(input.allowedContext, "grant-1"), "novel-offline-tail");
      await staleDraft.sync();
      const currentBinding = staleDraft.binding;
      const currentVector = retain("hostile-current-generation-vector.yjs", Y.encodeStateVector(staleDraft.doc));
      const offlineOutcome = await staleDraft.submit(offlineBytes, deliveryIds.offline);
      await settle(); const offlineSnapshot = persisted("novel-offline-tail");
      cases.novelOffline = {classification: "OBSERVATION_REQUIRING_ROOT_ANALYSIS", originalBinding, currentBinding, originalVector, currentVector,
        declaredBasisChanged: JSON.stringify(originalBinding) !== JSON.stringify(currentBinding),
        interpretation: "The raw peer submits retained pre-restore bytes through a fresh current-generation ticket. This does not prove the server can infer when unseen structs were authored. It is separate from an unchanged stale client reconnecting and quarantining its draft.",
        outcome: offlineOutcome, snapshot: offlineSnapshot,
        retainedDraft: {path: join(root, "hostile-offline-before-restore.yjs"), sha256: hash(offlineBytes)},
        journalAdmitted: offlineSnapshot.journal.some(row => row.delivery_id === deliveryIds.offline),
        nativeApplied: offlineSnapshot.applications.some(row => row.delivery_id === deliveryIds.offline),
        contentChanged: offlineSnapshot.markdown !== "Hello"}; save();
      await staleDraft.close();
      const fresh = await connect(input.allowedContext, await ticket(input.allowedContext, "grant-1"), "fresh-baseline-control");
      await fresh.sync(); expect(fresh.binding?.restoreFenceGeneration).toBe(2); const before = Y.encodeStateVector(fresh.doc);
      fresh.doc.getMap("frontmatter").set("freshProbe", "authored after restore");
      const freshBytes = Y.encodeStateAsUpdate(fresh.doc, before); retain("hostile-fresh-control.yjs", freshBytes);
      const freshOutcome = await fresh.submit(freshBytes, deliveryIds.fresh);
      await settle(); const freshSnapshot = persisted("fresh-baseline-control");
      cases.freshControl = {outcome: freshOutcome, snapshot: freshSnapshot, pass: freshOutcome.kind === "result" && freshOutcome.result === "success" &&
        freshSnapshot.journal.some(row => row.delivery_id === deliveryIds.fresh && row.update_digest === hash(freshBytes) && row.restore_fence_generation === 2 && row.principal_kind === "named" && row.grant_id === "grant-1") &&
        freshSnapshot.applications.some(row => row.delivery_id === deliveryIds.fresh && row.update_digest === hash(freshBytes) && row.restore_fence_generation === 2 && row.first_seen_count === 1) &&
        freshSnapshot.markdown.includes("freshProbe")}; save();
      await fresh.close();
      const verdict = ["oldGeneration", "oldTicket", "acceptedHistory", "freshControl"].every(key => (cases[key] as {pass: boolean}).pass) ? "PASS" : "BEHAVIOR_GAP";
      cases.verdict = verdict; save(); return {verdict, novelOfflineRequiresRootAnalysis: true,
        staleClientQuarantineProven: false, postInvalidationServerReadProven: false, commitRecheckProven: false,
        evidence: join(root, "hostile-evidence.json")};
    },
    async close() {for (const ws of sockets) ws.terminate(); await old.close(); for (const doc of documents) doc.destroy();},
  };
  } catch (error) {for (const ws of sockets) ws.terminate(); for (const doc of documents) doc.destroy(); throw error;}
}
