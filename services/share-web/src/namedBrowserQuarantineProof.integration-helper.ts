import {createServer} from "node:http";
import {once} from "node:events";
import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WebSocket, WebSocketServer} from "ws";
import {expect as browserExpect, type Page, type Locator} from "@playwright/test";
import {expect} from "vitest";
import * as Y from "yjs";
import {decodeLiveFrame, decodeLiveFrameSync, type LiveFrameBegin, type LiveFrameSessionPolicy} from "@dohc/live-session-contract/live-frame";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Direction = "client" | "server";
type Transfer = {begin: LiveFrameBegin; bytes: Uint8Array; offset: number; dropped: boolean};
type Capture = {begin: LiveFrameBegin; bytes: Uint8Array; path: string; sha256: string};
type Connection = {id: number; discriminator: string; closed: boolean; initialBinding?: ReturnType<typeof decodeLiveFrameSync>["binding"];
  clientVector?: Uint8Array; submissions: {deliveryId: string; digest: string; forwarded: boolean}[]};

/** A task-local network fault boundary. Only the real relay authenticates and acknowledges edits. */
export async function createNamedBrowserQuarantineProof(input: {relayUrl: string; root: string; workspace: string;
  frames: LiveFrameSessionPolicy; timeoutMs: number}) {
  const {root, workspace, frames, timeoutMs} = input;
  const events: unknown[] = [], connections: Connection[] = [], failures: string[] = [], active = new Set<() => void>();
  const observations: Record<string, unknown> = {};
  let armed: string | undefined, captured: Capture | undefined, stopped = false, listenerClosed = false;
  const watchers = new Set<() => void>();
  const save = () => writeFileSync(join(root, "browser-quarantine-evidence.json"), JSON.stringify({
    pid: process.pid, listenerClosed, connections: connections.map(({clientVector, ...value}) => ({...value,
      clientVector: clientVector && {sha256: hash(clientVector), clients: [...Y.decodeStateVector(clientVector)]}})),
    observations, events, failures, scope: "Unchanged shipped browser/UI with real auth, relay and native restore; one dropped network submission.",
  }, null, 2) + "\n");
  const notify = () => {save(); for (const watcher of [...watchers]) watcher();};
  function until(condition: () => boolean) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Network proof condition deadline")), timeoutMs);
      const finish = (error?: Error) => {clearTimeout(timer); watchers.delete(check); error ? reject(error) : resolve();};
      const check = () => {if (failures.length) finish(new Error(failures.join("\n"))); else if (condition()) finish();};
      watchers.add(check); check();
    });
  }
  function retain(name: string, bytes: Uint8Array) {
    const path = join(root, name); writeFileSync(path, bytes); return {path, sha256: hash(bytes), byteLength: bytes.length};
  }
  const server = createServer((_request, response) => response.writeHead(404).end());
  const receive = {maxPayload: frames.receive.maxFrameBytes, maxFragments: 8, maxBufferedChunks: 64};
  const wsServer = new WebSocketServer({noServer: true, clientTracking: false, perMessageDeflate: false,
    ...receive,
    handleProtocols: protocols => protocols.has("dohc-live-v1") ? "dohc-live-v1" : false});
  server.on("upgrade", (request, raw, head) => {
    if (stopped || active.size >= 4) {raw.destroy(); return;}
    const url = new URL(request.url!, input.relayUrl);
    if (url.pathname !== "/sync/live/named") {raw.destroy(); return;}
    const discriminator = url.searchParams.get("session");
    if (!discriminator || !request.headers["sec-websocket-protocol"]) {raw.destroy(); return;}
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const upstream = new WebSocket(url, request.headers["sec-websocket-protocol"].split(",").map(value => value.trim()), {
      perMessageDeflate: false, ...receive, handshakeTimeout: timeoutMs,
      headers: {cookie: request.headers.cookie!, origin: request.headers.origin!,
        "x-dohc-relay-exchange-key": String(request.headers["x-dohc-relay-exchange-key"])},
    });
    let downstream: WebSocket | undefined, done = false;
    const connection: Connection = {id: connections.length + 1, discriminator, closed: false, submissions: []};
    connections.push(connection);
    const stop = () => {
      if (done) return; done = true; active.delete(stop); connection.closed = true;
      downstream?.terminate(); upstream.terminate(); raw.destroy(); notify();
    };
    active.add(stop); raw.on("error", stop); raw.once("close", stop);
    upstream.on("error", error => {events.push({connection: connection.id, upstreamError: String(error)}); stop();});
    upstream.once("close", stop);
    upstream.once("unexpected-response", (_request, response) => {
      response.resume(); events.push({connection: connection.id, upstreamStatus: response.statusCode});
      raw.end(`HTTP/1.1 ${response.statusCode ?? 502} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, stop);
    });
    upstream.once("open", () => {
      upstream.pause();
      if (done) return;
      wsServer.handleUpgrade(request, raw, head, socket => {
        downstream = socket;
        socket.on("error", stop); socket.once("close", stop);
        const transfers: Partial<Record<Direction, Transfer>> = {};
        function observe(direction: Direction, data: Buffer): boolean {
          const frame = decodeLiveFrame(data, frames.receive.maxFrameBytes);
          if (frame.kind === "begin") {
            expect(transfers[direction]).toBeUndefined();
            const maximum = frame.purpose === "initial-sync" ? frames.receive.maxSyncBytes :
              frame.purpose === "client-vector" ? frames.receive.maxStateVectorBytes : frames.receive.maxUpdateBytes;
            expect(frame.totalBytes).toBeLessThanOrEqual(maximum);
            const dropped = direction === "client" && frame.purpose === "submit-update" && armed === discriminator;
            if (dropped) {expect(captured).toBeUndefined(); armed = undefined;}
            transfers[direction] = {begin: frame, bytes: new Uint8Array(frame.totalBytes), offset: 0, dropped};
            if (frame.purpose === "submit-update") connection.submissions.push({deliveryId: frame.deliveryId, digest: frame.digest, forwarded: !dropped});
            notify(); return !dropped;
          }
          if (frame.kind !== "chunk") return true;
          const transfer = transfers[direction]; expect(transfer).toBeDefined();
          expect(frame.transferId).toBe(transfer!.begin.transferId); expect(frame.offset).toBe(transfer!.offset);
          expect(frame.bytes.length).toBeLessThanOrEqual(transfer!.bytes.length - transfer!.offset);
          transfer!.bytes.set(frame.bytes, transfer!.offset); transfer!.offset += frame.bytes.length;
          if (transfer!.offset === transfer!.bytes.length) {
            delete transfers[direction];
            expect(hash(transfer!.bytes)).toBe(transfer!.begin.digest);
            const pin = retain(`browser-wire-${connection.id}-${direction}-${frame.transferId}.yjs`, transfer!.bytes);
            events.push({connection: connection.id, direction, begin: transfer!.begin, dropped: transfer!.dropped, pin});
            if (transfer!.begin.purpose === "client-vector") connection.clientVector = transfer!.bytes;
            if (transfer!.begin.purpose === "initial-sync") connection.initialBinding = decodeLiveFrameSync(transfer!.bytes, frames.receive).binding;
            if (transfer!.dropped) {
              captured = {...pin, begin: transfer!.begin, bytes: transfer!.bytes};
              events.push({connection: connection.id, fault: "captured-complete-submission-and-closed", pid: process.pid});
              stop();
            }
            notify();
          }
          return !transfer!.dropped;
        }
        function writer(destination: WebSocket, direction: Direction) {
          let queuedBytes = 0, queuedFrames = 0;
          return (data: WebSocket.RawData, binary: boolean) => {
            if (done) return;
            try {
              expect(binary).toBe(true); expect(Buffer.isBuffer(data)).toBe(true);
              const bytes = Buffer.from(data as Buffer);
              if (!observe(direction, bytes) || done) return;
              expect(queuedBytes + bytes.length).toBeLessThanOrEqual(frames.maxQueuedBytes);
              expect(queuedFrames + 1).toBeLessThanOrEqual(frames.maxQueuedFrames);
              queuedBytes += bytes.length; queuedFrames++;
              destination.send(bytes, {binary: true, compress: false}, error => {
                queuedBytes -= bytes.length; queuedFrames--; if (error) stop();
              });
            } catch (error) {failures.push(String(error)); stop();}
          };
        }
        socket.on("message", writer(upstream, "client")); upstream.on("message", writer(socket, "server"));
        upstream.resume(); notify();
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const relayProxyUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  events.push({proxyStarted: relayProxyUrl, pid: process.pid}); save();
  function snapshot(label: string) {
    expect(captured?.begin.purpose).toBe("submit-update");
    const pending = captured!.begin as Extract<LiveFrameBegin, {purpose: "submit-update"}>;
    const relay = new DatabaseSync(join(root, "relay/relay.sqlite"), {readOnly: true});
    const native = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {
      const columns = "delivery_id,update_digest,journal_cursor,restore_fence_generation,principal_kind,principal_id,grant_id,grant_generation";
      const journal = relay.prepare(`SELECT ${columns} FROM sync_relay_live_update_journal WHERE delivery_id=? OR update_digest=? ORDER BY journal_cursor`).all(pending.deliveryId, pending.digest);
      const applications = native.prepare(`SELECT ${columns},first_seen_count FROM live_device_update_applications WHERE delivery_id=? OR update_digest=? ORDER BY journal_cursor`).all(pending.deliveryId, pending.digest);
      const history = relay.prepare(`SELECT ${columns} FROM sync_relay_live_update_journal ORDER BY journal_cursor`).all();
      const nativeHistory = native.prepare(`SELECT ${columns},first_seen_count FROM live_device_update_applications ORDER BY journal_cursor`).all();
      const value = {label, journal, applications, history, nativeHistory, markdown: readFileSync(join(workspace, "docs/a.md"), "utf8")};
      events.push({snapshot: value}); save(); return value;
    } finally {relay.close(); native.close();}
  }
  let original: Connection | undefined, draftText = "", draftUrl = "", oldConnectionCount = 0;
  const excerpt = " Recovered Bob draft.";
  function noPendingAdmission(label: string) {
    const state = snapshot(label); expect(state.journal).toEqual([]); expect(state.applications).toEqual([]); return state;
  }
  return {
    relayProxyUrl,
    async interrupt(peer: {page: Page; editor: Locator}, discriminator: string) {
      original = [...connections].reverse().find(connection => connection.discriminator === discriminator && !connection.closed);
      expect(original?.initialBinding).toBeDefined(); draftUrl = peer.page.url(); armed = discriminator;
      await peer.editor.click(); await peer.page.keyboard.press("Control+End"); await peer.page.keyboard.insertText(excerpt);
      await until(() => captured !== undefined && original!.closed);
      await browserExpect(peer.page.getByRole("button", {name: "Retry connection", exact: true})).toBeVisible({timeout: timeoutMs});
      await browserExpect(peer.editor).toHaveAttribute("contenteditable", "false");
      await browserExpect(peer.editor).toContainText(excerpt.trim());
      await browserExpect(peer.page.getByLabel("Draft recovery", {exact: true})).toBeVisible();
      draftText = await peer.editor.innerText(); oldConnectionCount = connections.length;
      observations.offlineDraft = {originalBinding: original!.initialBinding, originalConnection: original!.id, draftText,
        delivery: captured!.begin, retained: {path: captured!.path, sha256: captured!.sha256}, state: noPendingAdmission("offline-draft")}; save();
      await peer.page.screenshot({path: join(root, "browser-offline-draft.png"), fullPage: true});
    },
    async recover(peer: {page: Page; editor: Locator}, settle: () => Promise<unknown>) {
      expect(peer.page.url()).toBe(draftUrl); expect(await peer.editor.innerText()).toBe(draftText);
      expect(noPendingAdmission("after-owner-restore").markdown).toBe("Hello");
      await peer.page.getByRole("button", {name: "Retry connection", exact: true}).click();
      await browserExpect(peer.page.getByRole("status")).toHaveText("Editing stopped. Review your draft before opening the current file.", {timeout: timeoutMs});
      await until(() => connections.length === oldConnectionCount + 1 && connections.at(-1)!.closed);
      const retry = connections.at(-1)!; expect(retry.initialBinding).toBeDefined();
      expect(original!.initialBinding!.restoreFenceGeneration).toBe(1); expect(retry.initialBinding!.restoreFenceGeneration).toBe(2);
      expect({...retry.initialBinding, restoreFenceGeneration: original!.initialBinding!.restoreFenceGeneration}).toEqual(original!.initialBinding);
      expect(retry.initialBinding!.restoreFenceGeneration).toBeGreaterThan(original!.initialBinding!.restoreFenceGeneration);
      const vector = Y.decodeStateVector(retry.clientVector!);
      for (const struct of Y.decodeUpdate(captured!.bytes).structs) expect(vector.get(struct.id.client) ?? 0).toBeGreaterThanOrEqual(struct.id.clock + struct.length);
      expect(retry.submissions).toEqual([]); expect(await peer.editor.innerText()).toBe(draftText);
      await browserExpect(peer.editor).toHaveAttribute("contenteditable", "false");
      await browserExpect(peer.page.getByRole("button", {name: "Retry connection", exact: true})).toHaveCount(0);
      observations.quarantined = {originalBinding: original!.initialBinding, currentBinding: retry.initialBinding, retryConnection: retry.id,
        retainedDraft: await peer.editor.innerText(), pendingIncludedInReconnectVector: true, noResend: true, state: noPendingAdmission("quarantined")}; save();
      await peer.page.screenshot({path: join(root, "browser-quarantined-draft.png"), fullPage: true});
      await peer.page.getByRole("button", {name: "Open current file", exact: true}).click();
      await browserExpect(peer.page.getByRole("dialog", {name: "Discard this draft?", exact: true})).toBeVisible();
      await peer.page.getByRole("button", {name: "Keep reviewing", exact: true}).click();
      expect(await peer.editor.innerText()).toBe(draftText); expect(connections.length).toBe(oldConnectionCount + 1);
      observations.keepReviewing = {draftUnchanged: true, connectionUnchanged: true}; save();
      await peer.page.getByRole("button", {name: "Open current file", exact: true}).click();
      await peer.page.getByRole("button", {name: "Discard draft and continue", exact: true}).click();
      await browserExpect(peer.editor).toHaveAttribute("contenteditable", "true", {timeout: timeoutMs});
      await browserExpect(peer.editor).toHaveText("Hello");
      expect(connections.length).toBe(oldConnectionCount + 2); const fresh = connections.at(-1)!;
      expect(Y.decodeStateVector(fresh.clientVector!).size).toBe(0); expect(fresh.initialBinding).toEqual(retry.initialBinding);
      await browserExpect(peer.page.getByLabel("Draft recovery", {exact: true})).toHaveCount(0);
      observations.discarded = {explicitConfirmation: true, freshConnection: fresh.id, initialVectorEmpty: true,
        currentBinding: fresh.initialBinding, visibleText: await peer.editor.innerText(), state: noPendingAdmission("discarded-draft")}; save();
      await peer.page.screenshot({path: join(root, "browser-current-restored.png"), fullPage: true});
      await peer.editor.click(); await peer.page.keyboard.press("Control+End"); await peer.page.keyboard.insertText(excerpt);
      await browserExpect(peer.page.getByRole("status")).toHaveText("Changes saved", {timeout: timeoutMs});
      await settle(); const after = noPendingAdmission("fresh-text-reapplied"); expect(after.markdown).toBe("Hello" + excerpt);
      expect(fresh.submissions).toHaveLength(1); const submitted = fresh.submissions[0]!;
      expect(submitted.forwarded).toBe(true); expect(submitted.digest).not.toBe(captured!.sha256);
      expect(after.history.find(row => row.delivery_id === submitted.deliveryId)).toMatchObject({update_digest: submitted.digest,
        restore_fence_generation: fresh.initialBinding!.restoreFenceGeneration, principal_kind: "named", grant_id: "grant-1"});
      expect(after.nativeHistory.find(row => row.delivery_id === submitted.deliveryId)).toMatchObject({update_digest: submitted.digest,
        restore_fence_generation: fresh.initialBinding!.restoreFenceGeneration, first_seen_count: 1});
      const oldDelivery = (captured!.begin as Extract<LiveFrameBegin, {purpose: "submit-update"}>).deliveryId;
      expect(submitted.deliveryId).not.toBe(oldDelivery);
      expect(connections.flatMap(connection => connection.submissions).filter(row => row.deliveryId === oldDelivery || row.digest === captured!.sha256)).toEqual([
        {deliveryId: oldDelivery, digest: captured!.sha256, forwarded: false},
      ]);
      observations.reapplied = {freshDelivery: submitted, state: after, manualTextInsertion: true, clipboardTested: false};
      observations.verdict = "PASS"; save(); return {verdict: "PASS", evidence: join(root, "browser-quarantine-evidence.json")};
    },
    async close() {
      if (stopped) return; stopped = true;
      for (const stop of [...active]) stop();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await new Promise<void>(resolve => wsServer.close(() => resolve()));
      listenerClosed = true; save(); expect(active.size).toBe(0); expect(connections.every(connection => connection.closed)).toBe(true); expect(failures).toEqual([]);
    },
  };
}
