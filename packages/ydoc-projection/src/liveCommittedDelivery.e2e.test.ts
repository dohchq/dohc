import { spawn } from "node:child_process";
import {
  watch,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { createConnection } from "node:net";
import { once } from "node:events";
import * as Y from "yjs";
import {
  EngineClient,
  DuplexEngineClientConnection,
  FrameDecoder,
  FrameType,
  encodeFrame,
} from "../../workspace-engine-client/src/daemon/engineClient.js";
import type { EngineClientConnection } from "../../workspace-engine-client/src/daemon/engineClient.js";
import type { Envelope } from "../../workspace-engine-client/src/protocol.js";
import { LiveCommittedDelivery } from "../../../services/sync-relay/src/liveCommittedDelivery.js";

import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  registered,
  DatabaseSync,
  host,
  cleanupLiveDeliveryFixtures,
} from "./liveCommittedDeliveryTestSupport.js";
import { openSyncRelayStorage } from "../../../services/sync-relay/src/storage.js";
import { createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { assertOrderedDeliveryFixture } from "../../../scripts/verification/ordered-delivery-fixture.mjs";
afterEach(() => {
  vi.restoreAllMocks();
  cleanupLiveDeliveryFixtures();
});
class ObservedConnection implements EngineClientConnection {
  readonly incoming = new FrameDecoder(1024 * 1024);
  readonly outgoing = new FrameDecoder(1024 * 1024);
  readonly requests: Envelope[] = [];
  readonly responses: Envelope[] = [];
  readonly wrappers = new Map<
    (bytes: Buffer | Uint8Array) => void,
    (bytes: Buffer | Uint8Array) => void
  >();
  constructor(
    readonly base: DuplexEngineClientConnection,
    readonly observe: (envelope: Envelope) => boolean,
  ) {}
  write(bytes: Buffer): boolean {
    for (const frame of this.outgoing.push(bytes))
      if (frame.kind === "control")
        this.requests.push(JSON.parse(frame.payload.toString("utf8")));
    return this.base.write(bytes);
  }
  onData(handler: (bytes: Buffer | Uint8Array) => void): void {
    const wrapped = (bytes: Buffer | Uint8Array) => {
      for (const frame of this.incoming.push(bytes)) {
        if (frame.kind === "control") {
          const envelope = JSON.parse(
            frame.payload.toString("utf8"),
          ) as Envelope;
          this.responses.push(envelope);
          if (this.observe(envelope)) {
            this.base.close();
            return;
          }
          handler(
            encodeFrame(FrameType.Control, 0, frame.payload, 1024 * 1024),
          );
        } else
          handler(
            encodeFrame(
              FrameType.BlobChunk,
              frame.fin ? 1 : 0,
              { streamId: frame.streamId, bytes: frame.payload },
              64 * 1024,
            ),
          );
      }
    };
    this.wrappers.set(handler, wrapped);
    this.base.onData(wrapped);
  }
  offData(handler: (bytes: Buffer | Uint8Array) => void): void {
    const wrapped = this.wrappers.get(handler);
    if (wrapped) this.base.offData(wrapped);
    this.wrappers.delete(handler);
  }
  onClose(handler: () => void): void {
    this.base.onClose(handler);
  }
  offClose(handler: () => void): void {
    this.base.offClose(handler);
  }
  onError(handler: (error: unknown) => void): void {
    this.base.onError(handler);
  }
  offError(handler: (error: unknown) => void): void {
    this.base.offError(handler);
  }
  onDrain(handler: () => void): void {
    this.base.onDrain(handler);
  }
  offDrain(handler: () => void): void {
    this.base.offDrain(handler);
  }
  close(): void {
    this.base.close();
  }
}

async function launch(
  packet: string,
  exe: string,
  round: number,
  observe: (envelope: Envelope) => boolean,
) {
  const dir = packet + "/round-" + round;
  mkdirSync(dir, { recursive: true });
  const endpointPath = dir + "/endpoint.json",
    configPath = dir + "/config.json",
    log = dir + "/host.log";
  if (existsSync(endpointPath)) throw Error("Round endpoint already exists");
  writeFileSync(
    configPath,
    JSON.stringify({
      rootDir: packet + "/host",
      endpointPath,
      authToken: "consumer-fixture",
      workspaceId: "workspace",
      namespace: "history-one",
      host: {
        hostId: host.hostId,
        hostEpoch: host.hostEpoch,
        instanceId: host.instanceId,
        connectionId: host.connectionId,
      },
    }),
  );
  let ready!: (endpoint: {
      port: number;
      workspace: string;
      databasePath: string;
      pid: number;
    }) => void,
    fail!: (error: Error) => void;
  const endpointPromise = new Promise<{
    port: number;
    workspace: string;
    databasePath: string;
    pid: number;
  }>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  const watcher = watch(dir, () => {
    if (existsSync(endpointPath))
      try {
        ready(JSON.parse(readFileSync(endpointPath, "utf8")));
      } catch (error) {
        fail(error as Error);
      }
  });
  const child = spawn(
    exe,
    ["--exact", "tests::ordered_consumer_fixture", "--ignored", "--nocapture"],
    {
      env: { ...process.env, DOHC_ORDERED_CONSUMER_FIXTURE: configPath },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  writeFileSync(
    dir + "/process.json",
    JSON.stringify({
      pid: child.pid,
      startedAt: new Date().toISOString(),
      exe,
    }),
  );
  child.stdout.on("data", (bytes) => appendFileSync(log, bytes));
  child.stderr.on("data", (bytes) => appendFileSync(log, bytes));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("close", (code) => {
      if (!existsSync(endpointPath))
        fail(Error("Fixture exited before endpoint"));
      resolve(code);
    });
    child.once("error", (error) => { fail(error); reject(error); });
  });
  void exited.catch(() => undefined);
  const timer = setTimeout(
    () => fail(Error("Fixture endpoint timeout")),
    30000,
  );
  let endpoint;
  try {
    endpoint = await endpointPromise;
    expect(endpoint.pid).toBe(child.pid);
    expect(Number.isSafeInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535).toBe(true);
    expect(resolve(endpoint.databasePath)).toBe(resolve(packet, "host/.dohc/engine/engine.db"));
  } catch (error) {
    child.kill();
    await exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
  const socket = createConnection({ host: "127.0.0.1", port: endpoint.port });
  socket.setTimeout(30000, () => socket.destroy(new Error("Fixture connection timeout")));
  try { await once(socket, "connect"); }
  catch (error) { socket.destroy(); child.kill(); await exited; throw error; }
  socket.setTimeout(0);
  const connection = new ObservedConnection(
    new DuplexEngineClientConnection(socket),
    observe,
  );
  const client = new EngineClient(connection, {
    authToken: "consumer-fixture",
    protocolVersion: 2,
    capabilities: ["core", "ydoc", "blobs"],
    maxFrameBytes: 1024 * 1024,
    privateLiveApplication: {
      aggregateBytes: 128 * 1024 * 1024,
      maxUploads: 1,
    },
  });
  try { await client.ready(); }
  catch (error) { client.close(); child.kill(); await exited; throw error; }
  return {
    client,
    connection,
    endpoint,
    async close() {
      client.close();
      let forced = false;
      const timeout = setTimeout(() => { forced = true; child.kill(); }, 30000);
      let code;
      try { code = await exited; } finally { clearTimeout(timeout); }
      writeFileSync(
        dir + "/closed.json",
        JSON.stringify(
          {
            pid: child.pid,
            code,
            closedAt: new Date().toISOString(),
            requests: connection.requests,
            responses: connection.responses,
          },
          null,
          2,
        ),
      );
      expect(forced, "Fixture did not finish after its connection closed").toBe(false);
      expect(code, readFileSync(log, "utf8")).toBe(0);
    },
  };
}

it("reopens both durable stores after dropped host ACKs and an uncertain relay edge COMMIT", async () => {
  const fixture = assertOrderedDeliveryFixture();
  const packet = mkdtempSync(join(tmpdir(), "dohc-ordered-delivery-"));
  const f = registered();
  writeFileSync(packet + "/relay-path.json", JSON.stringify({ path: f.path }));
  for (let sequence = 1; sequence <= 3; sequence++)
    expect(
      f.storage.commitLiveUpdateJournal(
        f.capture(
          f.update("title", "version-" + sequence),
          "event-" + sequence,
        ),
      ).result.kind,
    ).toBe("accepted");
  const document = f.input.evidence.document;
  let relay = f.storage,
    raw = f.raw;
  const history = createLiveJournalHistoryAuthority({
    namespace: "history-one",
    reconciled: true,
  });
  const results: unknown[] = [];
  let originalBootstrap: Record<string, unknown> | undefined;
  let originalApplications: Record<string, unknown>[] = [];
  let active: Awaited<ReturnType<typeof launch>> | undefined;
  let arm = false;
  const original = DatabaseSync.prototype.exec;
  const uncertain = vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (
      this: InstanceType<typeof DatabaseSync>,
      sql: string,
    ) {
      const result = original.call(this, sql);
      if (arm && sql === "COMMIT") {
        arm = false;
        throw Error("lost relay edge COMMIT response");
      }
      return result;
    });
  try {
    for (let round = 1; round <= 4; round++) {
      if (round > 1) {
        raw.close();
        relay.close();
        relay = openSyncRelayStorage(f.path);
        raw = new DatabaseSync(f.path);
      }
      active = await launch(packet, fixture.path, round, (envelope) => {
        if (envelope.type !== "response") return false;
        const result = envelope.result as {
          status?: string;
          ack?: { deliveryId?: string };
        };
        if (round === 1 && result.status === "bootstrapped") return true;
        if (round === 2 && result.status === "applied") return true;
        if (
          round === 3 &&
          result.status === "applied" &&
          result.ack?.deliveryId === "event-2"
        )
          arm = true;
        return false;
      });
      let requestId = 1;
      const consumer = new LiveCommittedDelivery(relay, history, {
        client: active.client,
        workspace: active.endpoint.workspace,
        host,
        deadlineMs: 30000,
        nextRequestId: () => requestId++,
      });
      if (round === 4)
        await expect(consumer.drain(document)).resolves.toMatchObject({
          kind: "done",
          terminalReceipt: { journalCursor: 3 },
        });
      else
        await expect(consumer.drain(document)).rejects.toThrow(
          round === 3 ? "lost relay edge COMMIT response" : /closed|transport/i,
        );
      const databasePath = active.endpoint.databasePath,
        responses = active.connection.responses;
      await active.close();
      active = undefined;
      const engine = new DatabaseSync(databasePath);
      try {
        const bootstraps = engine
          .prepare("SELECT * FROM live_device_bootstraps")
          .all();
        const applications = engine
          .prepare(
            "SELECT * FROM live_device_update_applications ORDER BY journal_cursor",
          )
          .all();
        const edges = raw
          .prepare(
            "SELECT * FROM sync_relay_live_delivery_edges ORDER BY journal_cursor",
          )
          .all();
        const relayBootstrap = raw
          .prepare("SELECT * FROM sync_relay_live_delivery_bootstraps")
          .get()!;
        expect(bootstraps).toHaveLength(1);
        originalBootstrap ??= bootstraps[0];
        expect(bootstraps[0]).toEqual(originalBootstrap);
        expect(bootstraps[0]!.local_ydoc_sequence).toBe(0);
        expect(relayBootstrap.local_ydoc_sequence).toBe(round === 1 ? null : 0);
        expect(applications).toHaveLength(round - 1);
        expect(applications.slice(0, originalApplications.length)).toEqual(originalApplications);
        originalApplications = applications;
        expect(edges).toHaveLength(round <= 2 ? 0 : round - 1);
        expect(
          engine.prepare("SELECT COUNT(*) n FROM file_objects").get()!.n,
        ).toBe(1);
        expect(engine.prepare("SELECT COUNT(*) n FROM moments").get()!.n).toBe(1);
        expect(engine.prepare("SELECT COUNT(*) n FROM snapshots").get()!.n).toBe(1);
        expect(
          engine.prepare("SELECT head_update_seq FROM ydoc_docs").get()!
            .head_update_seq,
        ).toBe(round - 1);
        const restored = new Y.Doc();
        try {
          const baseline = engine.prepare("SELECT bytes FROM binary_blobs WHERE sha256=?").get(document.lineageClaimId)!;
          Y.applyUpdate(restored, baseline.bytes as Uint8Array);
          const updates = engine.prepare("SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 ORDER BY u.seq").all();
          for (const update of updates) Y.applyUpdate(restored, update.bytes as Uint8Array);
          expect(restored.getMap("frontmatter").get("title")).toBe(round === 1 ? undefined : `version-${round - 1}`);
        } finally { restored.destroy(); }
        if (round === 2)
          expect(responses).toContainEqual(
            expect.objectContaining({
              type: "response",
              result: expect.objectContaining({
                status: "bootstrapped",
                ack: expect.objectContaining({
                  bootstrapReplayed: true,
                  localYDocSequence: 0,
                }),
              }),
            }),
          );
        if (round === 3)
          expect(responses).toContainEqual(
            expect.objectContaining({
              type: "response",
              result: expect.objectContaining({
                status: "applied",
                ack: expect.objectContaining({
                  deliveryId: "event-1",
                  applicationReplayed: true,
                  localYDocSequence: 1,
                }),
              }),
            }),
          );
        results.push({ round, bootstraps, applications, edges, responses });
      } finally {
        engine.close();
      }
    }
    writeFileSync(
      packet + "/result.json",
      JSON.stringify({ verdict: "PASS", results }, null, 2),
    );
  } catch (error) {
    writeFileSync(
      packet + "/result.json",
      JSON.stringify(
        { verdict: "FAIL", error: String(error), results },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    uncertain.mockRestore();
    try { await active?.close(); }
    finally { raw.close(); relay.close(); f.doc.destroy(); rmSync(packet, { recursive: true, force: true }); }
  }
}, 180000);
