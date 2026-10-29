import { strict as assert } from "node:assert";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { createServer as createHttpServer, request as requestHttp, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { parseLiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import {
  ACCOUNT_TEST_SECRET,
  startAccountServer,
} from "../../../../services/workspace-api/e2e/harness";
import { mailLinks } from "../../../../services/workspace-api/e2e/smtpCapture";
import { mintLocalhostCa, type LocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { parseStoredShareSelectorJson } from "../../../../services/sync-relay/src/shareFilter";
import { resolveEngineBinary } from "../../src/testing/engineBinary";
import type { LaunchedDesktopApp } from "./desktopApp";
import { readLiveAuditRecord, type LiveAuditRecord } from "./engineDb";

const relayRoot = fileURLToPath(new URL("../../../../services/sync-relay/", import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * `live` serves the stack over HTTPS from a fixture CA and runs the self-host
 * live service with the native engine. `trustEnv` is the environment a desktop
 * needs to trust that CA: Node reads it, and the debug engine accepts it only
 * for an HTTPS loopback relay. `refuse` answers matching requests with 503
 * before they reach a service.
 */
export async function startSelfHostOnboardingStack(directory: string, options: {
  live?: boolean; signal: AbortSignal; refuse?: (method: string, path: string) => boolean;
}) {
  assert.ok(process.env.POSTGRES_URL, "Supply a disposable POSTGRES_URL.");
  assert.equal(process.env.DOHC_REQUIRE_POSTGRES, "1", "Require the real Postgres dependency.");
  const ca = options.live ? await mintLocalhostCa(directory) : undefined;
  // Desktop launches enable the plaintext loopback opt-in by default. A live
  // desktop turns it off, so only the test CA carries its relay traffic; the
  // engine refuses the two together.
  const trustEnv: Record<string, string> = ca
    ? { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1", DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" }
    : {};
  const proxy = await startServerProxy(ca, options.refuse ? { refuse: options.refuse } : {});
  let account: Awaited<ReturnType<typeof startAccountServer>> | undefined;
  let relay: Awaited<ReturnType<typeof startAuthenticatedRelay>> | undefined;
  try {
    // The account server applies the migrations whose tables the relay reads as it starts.
    account = await startAccountServer({ publicOrigin: proxy.origin, signal: options.signal });
    proxy.routeAuthTo(account.listenOrigin);
    relay = await startAuthenticatedRelay(directory, proxy.origin, ca ? { ...trustEnv, ...selfHostLiveEnv(directory, proxy.origin) } : {});
    proxy.routeRelayTo(relay.url);
    return {
      account,
      ca,
      trustEnv,
      relayUrl: proxy.origin,
      // The relay's recent console output, such as a failed service host pass,
      // for a failure report. Bearer values are removed.
      relayOutput: () => relay!.output().replace(/(bearer\s+)\S+/giu, "$1[redacted]"),
      // Counts and cursors only, for a failure report: the live settlements the
      // service host made, held for export, or journaled, and those the relay holds.
      settlementEvidence: () => settlementEvidence(directory),
      livePublication: (workspaceId: string, path: string) => livePublication(directory, workspaceId, path),
      // The document's accepted change just before a named account's first live
      // edit, the restore point that keeps everything the account did not write.
      acceptedCursorBefore: (workspaceId: string, path: string, principalId: string) =>
        acceptedCursorBefore(directory, workspaceId, path, principalId),
      // Where one declared agent's accepted changes stand: the relay journal,
      // the service host's accepted history and its durable audit. Read-only.
      hostedAgentEvidence: (workspaceId: string, path: string, agentId: string) =>
        hostedAgentEvidence(directory, workspaceId, path, agentId),
      ownerLiveBinding: (workspaceId: string, path: string) => ownerLiveBinding(directory, workspaceId, path),
      async close() {
        const results = await Promise.allSettled([proxy.close(), relay!.close(), account!.close()]);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Self-host services did not close.");
      },
    };
  } catch (error) {
    await Promise.allSettled([proxy.close(), relay?.close(), account?.close()]);
    throw error;
  }
}

// The same public origin routes to separate services, like the self-host proxy.
// Bodies, headers, and status codes pass through unchanged; no route mints credentials.
// With a certificate it terminates TLS, and it forwards live editing's WebSocket upgrades.
export interface ProxiedCollectionWriteResponse {
  requestBody: string;
  status: number;
  body: string;
}

export interface ProxiedHostedLogResponse {
  status: number;
  statusMessage: string;
  headers: string[];
  body: Buffer;
}

export interface HostedLogResponseBarrier {
  captured: Promise<ProxiedHostedLogResponse>;
  delivered: Promise<void>;
  release(): void;
  destroy(): void;
}

export class HostedLogClientClosedError extends Error {
  constructor() { super("Hosted-log client closed before the captured response was delivered."); }
}

interface PendingHostedLogResponse extends HostedLogResponseBarrier {
  workspaceId: string;
  hold(incoming: IncomingMessage, outgoing: ServerResponse): void;
  attach(outgoing: ServerResponse): void;
  receive(response: IncomingMessage): void;
  fail(error: Error): void;
}

export async function startServerProxy(tls?: Pick<LocalhostCa, "certificate" | "key">, options: {
  collectionWriteResponse?(response: ProxiedCollectionWriteResponse): "drop" | void | Promise<"drop" | void>;
  refuse?(method: string, path: string): boolean;
} = {}) {
  let authInternalUrl: string | undefined;
  let relayUrl: string | undefined;
  let nextHostedLog: PendingHostedLogResponse | undefined;
  let holdingHostedLog: PendingHostedLogResponse | undefined;
  const upstreams = new Set<ReturnType<typeof requestHttp>>();
  const upgraded = new Set<Duplex>();
  const route = (path: string) => path.startsWith("/sync/") || path === "/health" ? relayUrl : authInternalUrl;
  const forward: RequestListener = (incoming, outgoing) => {
    const path = incoming.url ?? "/";
    if (options.refuse?.(incoming.method ?? "GET", path)) { outgoing.writeHead(503).end(); return; }
    const hostedWorkspace = incoming.method === "GET"
      ? /^\/sync\/([^/]+)\/hosted\/log$/u.exec(new URL(path, "http://proxy.test").pathname)?.[1] : undefined;
    const holding = holdingHostedLog && encodeURIComponent(holdingHostedLog.workspaceId) === hostedWorkspace
      ? holdingHostedLog : undefined;
    if (holding) { holding.hold(incoming, outgoing); return; }
    const barrier = nextHostedLog && encodeURIComponent(nextHostedLog.workspaceId) === hostedWorkspace
      ? nextHostedLog : undefined;
    if (barrier) { nextHostedLog = undefined; barrier.attach(outgoing); }
    const target = route(path);
    if (!target) {
      if (barrier) { barrier.fail(new Error("Hosted-log proxy has no upstream route.")); return; }
      outgoing.writeHead(503).end();
      return;
    }
    const intercept = options.collectionWriteResponse && incoming.method === "POST"
      && /^\/sync\/shares\/[^/]+\/collection-writes$/u.test(path);
    const requestChunks: Buffer[] = [];
    if (intercept) incoming.on("data", chunk => requestChunks.push(Buffer.from(chunk)));
    const upstream = requestHttp(new URL(path, target), { method: incoming.method, headers: incoming.headers }, (response) => {
      if (barrier) { barrier.receive(response); return; }
      if (intercept) {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("error", () => outgoing.destroy());
        response.once("end", () => {
          const body = Buffer.concat(chunks);
          void Promise.resolve(options.collectionWriteResponse!({ requestBody: Buffer.concat(requestChunks).toString("utf8"),
            status: response.statusCode ?? 502, body: body.toString("utf8") })).then(action => {
            // The upstream has completed its commit before the client loses the answer.
            if (action === "drop") { outgoing.destroy(); return; }
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            outgoing.end(body);
          }).catch(() => outgoing.destroy());
        });
        return;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstreams.add(upstream);
    upstream.once("close", () => upstreams.delete(upstream));
    upstream.on("error", error => {
      if (barrier) { barrier.fail(error); outgoing.destroy(); return; }
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    outgoing.once("close", () => {
      upstream.destroy();
    });
    incoming.on("error", error => { barrier?.fail(error); upstream.destroy(); });
    incoming.pipe(upstream);
  };
  const server: Server = tls ? createHttpsServer({ cert: tls.certificate, key: tls.key }, forward) : createHttpServer(forward);
  server.on("upgrade", (incoming, socket, head) => {
    const target = route(incoming.url ?? "/");
    if (!target) { socket.destroy(); return; }
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    const upstream = requestHttp(new URL(incoming.url ?? "/", target), { method: incoming.method, headers: incoming.headers });
    const answer = (response: IncomingMessage) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      return `${lines.join("\r\n")}\r\n\r\n`;
    };
    upstream.once("upgrade", (response, relaySocket, relayHead) => {
      upgraded.add(relaySocket);
      relaySocket.once("close", () => { upgraded.delete(relaySocket); socket.destroy(); });
      socket.once("close", () => relaySocket.destroy());
      relaySocket.on("error", () => relaySocket.destroy());
      socket.write(answer(response));
      socket.write(relayHead);
      relaySocket.write(head);
      relaySocket.pipe(socket).pipe(relaySocket);
    });
    // A refused upgrade keeps the relay's status and body.
    upstream.once("response", (response) => { socket.write(answer(response)); response.pipe(socket); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`,
    routeAuthTo(url: string) { authInternalUrl = url; },
    routeRelayTo(url: string) { relayUrl = url; },
    /** Buffers the next real hosted-log response for this workspace until released. */
    holdNextHostedLogResponse(workspaceId: string): HostedLogResponseBarrier {
      assert.ok(!nextHostedLog, "A hosted-log response barrier is already waiting for a request.");
      let resolve!: (response: ProxiedHostedLogResponse) => void;
      let reject!: (error: Error) => void;
      const captured = new Promise<ProxiedHostedLogResponse>((done, fail) => { resolve = done; reject = fail; });
      let resolveDelivered!: () => void;
      let rejectDelivered!: (error: Error) => void;
      const delivered = new Promise<void>((done, fail) => { resolveDelivered = done; rejectDelivered = fail; });
      // Cleanup can destroy a barrier before its owner reaches the await.
      void captured.catch(() => undefined);
      void delivered.catch(() => undefined);
      let outgoing: ServerResponse | undefined;
      let buffered: ProxiedHostedLogResponse | undefined;
      let released = false;
      const held: Array<{ incoming: IncomingMessage; outgoing: ServerResponse }> = [];
      const barrier: PendingHostedLogResponse = {
        workspaceId, captured, delivered,
        hold(incoming, outgoing) { held.push({ incoming, outgoing }); },
        attach(destination) {
          outgoing = destination;
          if (!released) holdingHostedLog = barrier;
          destination.once("finish", resolveDelivered);
          destination.once("close", () => {
            if (destination.writableFinished) return;
            const error = new HostedLogClientClosedError();
            rejectDelivered(error);
            // A timed-out host can retry, but its pulls must stay held until release.
            if (!buffered) barrier.fail(error);
          });
        },
        receive(response) {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.once("error", error => barrier.fail(error));
          response.once("aborted", () => barrier.fail(new Error("Hosted-log upstream response aborted.")));
          response.once("end", () => {
            if (outgoing?.destroyed) { barrier.fail(new HostedLogClientClosedError()); return; }
            buffered = { status: response.statusCode ?? 502, statusMessage: response.statusMessage ?? "",
              headers: [...response.rawHeaders], body: Buffer.concat(chunks) };
            resolve(buffered);
            if (released) barrier.release();
          });
        },
        release() {
          released = true;
          if (holdingHostedLog === barrier) holdingHostedLog = undefined;
          if (buffered && outgoing) {
            if (outgoing.destroyed) rejectDelivered(new HostedLogClientClosedError());
            else {
              outgoing.writeHead(buffered.status, buffered.statusMessage, buffered.headers);
              outgoing.end(buffered.body);
            }
            buffered = undefined;
            outgoing = undefined;
          }
          for (const request of held.splice(0)) {
            if (!request.outgoing.destroyed) forward(request.incoming, request.outgoing);
          }
        },
        fail(error) {
          if (nextHostedLog === barrier) nextHostedLog = undefined;
          if (holdingHostedLog === barrier) holdingHostedLog = undefined;
          reject(error);
          rejectDelivered(error);
          outgoing?.destroy();
          for (const request of held.splice(0)) request.outgoing.destroy();
          buffered = undefined;
        },
        destroy() { barrier.fail(new Error("Hosted-log response barrier destroyed.")); },
      };
      nextHostedLog = barrier;
      return barrier;
    },
    async close() {
      nextHostedLog?.destroy();
      holdingHostedLog?.destroy();
      for (const request of upstreams) request.destroy();
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function acceptedCursorBefore(directory: string, workspaceId: string, path: string, principalId: string): number {
  const db = new DatabaseSync(join(directory, "relay-data", "relay.sqlite"), { readOnly: true });
  try {
    const row = db.prepare(
      `SELECT MAX(journal_cursor) AS cursor FROM sync_relay_live_update_journal WHERE workspace_id=? AND current_path=?
         AND journal_cursor < (SELECT MIN(journal_cursor) FROM sync_relay_live_update_journal
           WHERE workspace_id=? AND current_path=? AND principal_kind='named' AND principal_id=?)`,
    ).get(workspaceId, path, workspaceId, path, principalId);
    const cursor = Number(row?.cursor);
    assert.ok(Number.isSafeInteger(cursor) && cursor >= 1, "An accepted change precedes the account's first live edit.");
    return cursor;
  } finally { db.close(); }
}

/** The current binding of the fixture's retained owner enrollment, read in one relay snapshot. */
function ownerLiveBinding(directory: string, workspaceId: string, path: string) {
  const db = new DatabaseSync(join(directory, "relay-data", "relay.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT d.workspace_id, d.main_version_id, d.object_id, d.lineage_claim_id,
         d.current_path, d.restore_fence_generation, s.selector_json, a.relay_database_namespace
       FROM sync_relay_service_host_enrollments e
       JOIN sync_relay_workspaces w ON w.workspace_id=e.workspace_id
       JOIN sync_relay_shares s ON s.share_id=e.share_id
       JOIN sync_relay_live_documents d
         ON d.workspace_id=e.workspace_id AND d.main_version_id='main'
         AND d.object_id=e.object_id AND d.current_path=e.path
       JOIN sync_relay_service_activations a
         ON a.workspace_id=d.workspace_id AND a.main_version_id=d.main_version_id
         AND a.object_id=d.object_id AND a.lineage_claim_id=d.lineage_claim_id
       WHERE e.workspace_id=? AND e.path=? AND e.enabled=1 AND e.retired=0
         AND e.owner_user_id=w.owner_user_id
         AND e.replication_epoch=w.replication_epoch AND e.stream_identity=w.stream_identity
         AND s.workspace_id=e.workspace_id AND s.granter_user_id=e.owner_user_id
         AND a.owner_user_id=e.owner_user_id AND a.share_id=e.share_id
         AND a.completion_json IS NOT NULL
         AND d.lineage_state='current' AND d.admission_state='open'
         AND EXISTS (
           SELECT 1 FROM sync_relay_object_moments m
           WHERE m.workspace_id=d.workspace_id AND m.version_id='main'
             AND m.object_id=d.object_id AND m.path=d.current_path AND m.content_kind='text'
             AND m.relay_seq=(SELECT MAX(latest.relay_seq) FROM sync_relay_object_moments latest
               WHERE latest.workspace_id=m.workspace_id AND latest.object_id=m.object_id
                 AND latest.version_id=m.version_id)
         )
       LIMIT 2`,
    ).all(workspaceId, path);
    assert.ok(rows.length <= 1, "The fixture has more than one current owner enrollment for its document.");
    const row = rows[0];
    if (!row) return null;
    assert.equal(typeof row.selector_json, "string", "The owner share selector must be JSON text.");
    const selector = parseStoredShareSelectorJson(row.selector_json as string);
    assert.deepEqual(selector, { paths: [path], versionId: null }, "The fixture owner share selects only this main file.");
    const binding = parseLiveObjectBinding({
      workspaceId: row.workspace_id, mainVersionId: row.main_version_id,
      objectId: row.object_id, lineageClaimId: row.lineage_claim_id,
      currentPath: row.current_path, selectorPaths: selector!.paths,
      restoreFenceGeneration: row.restore_fence_generation,
    });
    const relayDatabaseNamespace = parseLiveUpdateIdentifier(row.relay_database_namespace, "relayDatabaseNamespace");
    return { binding, relayDatabaseNamespace };
  } finally { db.close(); }
}

// The relay's accepted changes that declared this agent, and the service
// host's copies. Accepted history can fold into a checkpoint, so its rows are
// reported as found; the durable audit record is what must remain.
function hostedAgentEvidence(directory: string, workspaceId: string, path: string, agentId: string) {
  const read = <T>(file: string, query: (db: InstanceType<typeof DatabaseSync>) => T) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return query(db); } finally { db.close(); }
  };
  const relay = read(join(directory, "relay-data", "relay.sqlite"), (db) => db.prepare(
    `SELECT j.journal_cursor AS cursor, j.delivery_id AS deliveryId, j.update_digest AS updateDigest,
       j.principal_kind AS principalKind, j.principal_id AS principalId, j.restore_fence_generation AS fence,
       j.accepted_event_count AS eventCount, j.accepted_evidence_digest AS evidenceDigest, j.author_snapshot_json AS authorSnapshot
     FROM sync_relay_live_update_journal j
     WHERE j.workspace_id=? AND j.current_path=? AND EXISTS (
       SELECT 1 FROM json_each(j.author_snapshot_json) a
       WHERE json_extract(a.value,'$.kind')='agent' AND json_extract(a.value,'$.agentId')=?) ORDER BY j.journal_cursor LIMIT 16`,
  ).all(workspaceId, path, agentId).map((row) => ({
    journalCursor: Number(row.cursor), deliveryId: String(row.deliveryId), updateDigest: String(row.updateDigest),
    principalKind: String(row.principalKind), principalId: String(row.principalId), restoreFenceGeneration: Number(row.fence),
    eventCount: Number(row.eventCount), evidenceDigest: String(row.evidenceDigest),
    authorSnapshot: JSON.parse(String(row.authorSnapshot)) as LiveAuditRecord["authorSnapshot"],
  })));
  // Every accepted change of the document by authenticated kind, and how many declared any agent. Counts only.
  const journal = read(join(directory, "relay-data", "relay.sqlite"), (db) => db.prepare(
    `SELECT j.principal_kind AS kind, COUNT(*) AS accepted, SUM(EXISTS (
       SELECT 1 FROM json_each(j.author_snapshot_json) a WHERE json_extract(a.value,'$.kind')='agent')) AS declared
     FROM sync_relay_live_update_journal j
     WHERE j.workspace_id=? AND j.current_path=? GROUP BY j.principal_kind ORDER BY j.principal_kind`,
  ).all(workspaceId, path).map((row) => ({ kind: String(row.kind), accepted: Number(row.accepted), declared: Number(row.declared) })));
  const hostRoot = join(directory, "relay-deployment", "live-host");
  // The relay makes a store's folder before the service host creates its engine database.
  const host = readdirSync(hostRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "automations")
    .map((entry) => join(hostRoot, entry.name, ".dohc", "engine", "engine.db")).filter((file) => existsSync(file))
    .flatMap((file) => read(file, (db) => relay.map((change) => ({
      deliveryId: change.deliveryId,
      accepted: db.prepare(`SELECT journal_cursor AS cursor, event_count AS eventCount, evidence_digest AS evidenceDigest,
          json_extract(metadata_json,'$.accepted') AS accepted, json_extract(metadata_json,'$.authorSnapshot') AS authorSnapshot FROM live_accepted_updates
          WHERE delivery_id=? AND json_extract(metadata_json,'$.accepted.binding.workspaceId')=?`)
        .all(change.deliveryId, workspaceId).map((row) => ({ journalCursor: Number(row.cursor), eventCount: Number(row.eventCount),
          evidenceDigest: String(row.evidenceDigest), accepted: JSON.parse(String(row.accepted)) as LiveAuditRecord["accepted"],
          authorSnapshot: JSON.parse(String(row.authorSnapshot)) as LiveAuditRecord["authorSnapshot"] })),
      audit: readLiveAuditRecord(db, change.deliveryId),
    }))));
  return { relay, host, journal };
}

function settlementEvidence(directory: string) {
  const read = <T>(path: string, query: (db: InstanceType<typeof DatabaseSync>) => T) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return query(db); } finally { db.close(); }
  };
  const cursors = (db: InstanceType<typeof DatabaseSync>, sql: string) => db.prepare(sql).all().map((row) => Number(row.cursor));
  const hostRoot = join(directory, "relay-deployment", "live-host");
  return {
    host: readdirSync(hostRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "automations")
      .map((entry) => join(hostRoot, entry.name, ".dohc", "engine", "engine.db")).filter((file) => existsSync(file))
      .map((file) => read(file, (db) => ({
        settled: cursors(db, "SELECT terminal_cursor AS cursor FROM live_device_settlements ORDER BY terminal_cursor"),
        heldForExport: Number(db.prepare("SELECT COUNT(*) AS n FROM live_audit_pending_exports").get()?.n ?? 0),
        journaled: cursors(db, `SELECT json_extract(payload_json,'$.record.terminalCursor') AS cursor FROM replication_log
          WHERE imported=0 AND op_kind='live.audit.settlement' ORDER BY cursor`),
        acceptedEvents: Number(db.prepare("SELECT COUNT(*) AS n FROM live_accepted_updates").get()?.n ?? 0),
        // The registration the publication proof reads, and whether the proof
        // rows agree on one binding.
        registrations: db.prepare(
          "SELECT available, restore_fence_generation AS fence, selector_paths_json AS selectors FROM live_device_application_bindings",
        ).all().map((row) => ({ available: Number(row.available) === 1, fence: Number(row.fence), selectors: String(row.selectors) })),
        ownerBound: Number(db.prepare("SELECT EXISTS(SELECT 1 FROM ydoc_owner_bindings) AS n").get()?.n ?? 0) === 1,
        proofBindings: Number(db.prepare(
          "SELECT COUNT(DISTINCT binding_json) AS n FROM (SELECT binding_json FROM live_device_settlements UNION ALL SELECT binding_json FROM live_owner_adoptions UNION ALL SELECT binding_json FROM live_device_bootstraps)",
        ).get()?.n ?? 0),
        // The first unpublished local operations, and which proof row holds each
        // digest a moment references. Digests and kinds only.
        unpublished: db.prepare(
          `SELECT l.origin_seq AS seq, l.op_kind AS kind, ${["payloadBeforeBlobSha256", "payloadAfterBlobSha256", "beforeBlobSha256"].map((field) => `
             (SELECT CASE WHEN json_extract(l.payload_json,'$.${field}') IS NULL THEN 'none'
               WHEN EXISTS(SELECT 1 FROM live_device_settlements s WHERE s.markdown_digest=json_extract(l.payload_json,'$.${field}')) THEN 'settlement'
               WHEN EXISTS(SELECT 1 FROM live_owner_adoptions a WHERE a.source_digest=json_extract(l.payload_json,'$.${field}')) THEN 'adoption'
               WHEN EXISTS(SELECT 1 FROM live_device_bootstraps b WHERE b.projected_markdown_digest=json_extract(l.payload_json,'$.${field}')) THEN 'bootstrap'
               ELSE 'unproved' END) AS ${field}`).join(",")}
           FROM replication_log l LEFT JOIN sync_relay_push_state p ON p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id
           WHERE l.imported=0 AND l.origin_seq>COALESCE(p.pushed_seq,-1) ORDER BY l.origin_seq LIMIT 4`,
        ).all(),
      }))),
    relay: read(join(directory, "relay-data", "relay.sqlite"), (db) => db.prepare(
      `SELECT json_extract(s.payload_json,'$.record.terminalCursor') AS cursor,
         EXISTS(SELECT 1 FROM sync_relay_log m WHERE m.workspace_id=s.workspace_id AND m.op_kind='moment.append'
           AND json_extract(m.payload_json,'$.momentId')=json_extract(s.payload_json,'$.record.momentId')) AS moment
       FROM sync_relay_log s WHERE s.op_kind='live.audit.settlement' ORDER BY s.relay_seq`,
    ).all().map((row) => ({ terminalCursor: Number(row.cursor), momentPublished: Number(row.moment) === 1 }))),
  };
}

// How far the server's live work on one document has gone: the relay's
// accepted head, the last cursor the service host settled, the host's
// operations not yet pushed, and each host origin's last operation in the
// relay log. Cursors and counts only.
function livePublication(directory: string, workspaceId: string, path: string) {
  const read = <T>(file: string, query: (db: InstanceType<typeof DatabaseSync>) => T) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return query(db); } finally { db.close(); }
  };
  const count = (db: InstanceType<typeof DatabaseSync>, sql: string, ...params: string[]) => Number(db.prepare(sql).get(...params)?.n ?? 0);
  const relay = read(join(directory, "relay-data", "relay.sqlite"), (db) => ({
    acceptedHead: count(db, "SELECT COALESCE(MAX(journal_cursor),0) AS n FROM sync_relay_live_update_journal WHERE workspace_id=? AND current_path=?", workspaceId, path),
    hostOrigins: Object.fromEntries(db.prepare(
      "SELECT origin_id AS origin, MAX(origin_seq) AS seq FROM sync_relay_log WHERE workspace_id=? AND origin_id LIKE 'service-host:%' GROUP BY origin_id",
    ).all(workspaceId).map((row) => [String(row.origin), Number(row.seq)])),
  }));
  const hostRoot = join(directory, "relay-deployment", "live-host");
  const hosts = readdirSync(hostRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "automations")
    .map((entry) => join(hostRoot, entry.name, ".dohc", "engine", "engine.db")).filter((file) => existsSync(file))
    .map((file) => read(file, (db) => ({
      settledThrough: count(db, "SELECT COALESCE(MAX(terminal_cursor),0) AS n FROM live_device_settlements"),
      unpushed: count(db, `SELECT COUNT(*) AS n FROM replication_log l LEFT JOIN sync_relay_push_state p ON p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id
        WHERE l.imported=0 AND l.origin_seq>COALESCE(p.pushed_seq,-1)`),
    })));
  return { ...relay, hosts };
}

// The supported self-host profile: an initialized deployment whose service
// host runs the native engine and replicates through the public HTTPS origin.
function selfHostLiveEnv(directory: string, origin: string): NodeJS.ProcessEnv {
  const deployment = join(directory, "relay-deployment");
  execFileSync(process.execPath, ["--import", "tsx/esm", "src/relayDeploymentCommand.ts", "initialize",
    "--config", join(deployment, "deployment.json"), "--database", join(directory, "relay-data", "relay.sqlite"), "--continuity-directory", join(deployment, "continuity")],
  { cwd: relayRoot, stdio: "pipe", windowsHide: true });
  mkdirSync(join(deployment, "live-host"));
  return {
    SYNC_RELAY_DB_PATH: undefined,
    DOHC_RELAY_DEPLOYMENT_CONFIG: join(deployment, "deployment.json"),
    DOHC_SELF_HOST_LIVE: "1",
    DOHC_RELAY_AUTOMATIONS: "0",
    // The live host requires canonical paths.
    DOHC_RELAY_SERVICE_HOST_ROOT: realpathSync.native(join(deployment, "live-host")),
    DOHC_RELAY_ENGINE_EXECUTABLE: realpathSync.native(resolveEngineBinary()),
    DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: "1",
    DOHC_RELAY_PUBLIC_ORIGIN: origin,
    DOHC_RELAY_SHARE_WEB_ORIGIN: origin,
    DOHC_RELAY_SHARE_WEB_URL: origin,
    DOHC_RELAY_NAMED_LIVE_HOSTS: new URL(origin).host,
    DOHC_RELAY_LINK_KEY: randomBytes(32).toString("hex"),
    DOHC_RELAY_EXCHANGE_KEY: randomBytes(32).toString("hex"),
  };
}

async function startAuthenticatedRelay(directory: string, authUrl: string, liveEnv: NodeJS.ProcessEnv) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    SYNC_RELAY_TEST_AUTH: undefined,
    DOHC_TEST_AUTH: undefined,
    DOHC_RELAY_DEPLOYMENT_CONFIG: undefined,
    DOHC_RELAY_SERVICE_HOST_CONFIG: undefined,
    DOHC_RELAY_DEVICE_DELIVERY_CONFIG: undefined,
    DOHC_RELAY_OWNER_ADMISSION_CONFIG: undefined,
    DOHC_RELAY_NAMED_LIVE_CONFIG: undefined,
    DOHC_RELAY_NAMED_BROWSER_SESSION_LIMITS: undefined,
    DOHC_RELAY_LINK_LIVE: undefined,
    DOHC_PUBLIC_EDIT_RELEASE: undefined,
    DOHC_RELAY_APP_PUBLICATIONS: undefined,
    DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT: undefined,
    SYNC_RELAY_PORT: "0",
    SYNC_RELAY_BIND: "127.0.0.1",
    SYNC_RELAY_DB_PATH: join(directory, "onboarding-relay.sqlite"),
    SYNC_RELAY_AUTH_BASE_URL: authUrl,
    BETTER_AUTH_SECRET: ACCOUNT_TEST_SECRET,
    FORCE_COLOR: "0",
    ...liveEnv,
  };
  // This assertion runs inside the service process, before its production entry.
  // IPC requests orderly shutdown on Windows too, where SIGTERM would skip closing the live host's engine.
  const bootstrap = 'import { strict as assert } from "node:assert"; assert.equal(process.env.SYNC_RELAY_TEST_AUTH, undefined); assert.equal(process.env.DOHC_TEST_AUTH, undefined); process.on("message", (message) => { if (message === "SIGTERM") process.emit("SIGTERM"); }); await import("./src/main.ts");';
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", bootstrap], {
    cwd: relayRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const { stdout, stderr } = child;
  assert.ok(stdout && stderr, "The relay's output pipes are configured.");
  // Enough to keep a service host failure that is logged once behind later engine output.
  let output = "";
  stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-262_144); });
  stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-262_144); });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = () => stopChild(child, exited);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Authenticated relay did not start. ${output}`)), 30_000);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`Authenticated relay exited (${code}). ${output}`)));
      stdout.on("data", () => {
        const match = /SYNC_RELAY_LISTENING host=([^\s]+) port=(\d+)/u.exec(output);
        if (!match) return;
        clearTimeout(timer);
        resolve(`http://${match[1]}:${match[2]}`);
      });
    });
    return { url, close, output: () => output };
  } catch (error) {
    await close();
    throw error;
  }
}

async function stopChild(child: ChildProcess, exited: Promise<void>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Allow the relay's HTTP drain and live host close, then bound a wedged child.
  const force = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    if (child.connected) child.send("SIGTERM", (error) => { if (error) child.kill("SIGTERM"); });
    else child.kill("SIGTERM");
    await exited;
  } finally { clearTimeout(force); }
}

// The OS browser dispatcher is the only substituted boundary. Desktop discovery,
// IPC validation, device-code polling, browser approval, and credential storage run normally.
export async function openDesktopApproval(desktop: LaunchedDesktopApp, browserPage: Page, origin: string) {
  await desktop.app.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { onboardingBrowserUrl?: string; onboardingOpenExternal?: typeof shell.openExternal };
    state.onboardingBrowserUrl = undefined;
    state.onboardingOpenExternal = shell.openExternal;
    shell.openExternal = async (url) => { state.onboardingBrowserUrl = url; };
  });
  try {
    await desktop.page.getByTestId("cloud-server-url").fill(origin);
    await desktop.page.getByTestId("cloud-connect-start").click();
    await expect(desktop.page.getByTestId("cloud-user-code")).toBeVisible();
    await desktop.page.getByTestId("cloud-open-browser").click();
    // Opening the approval URL uses the same external-link confirmation as a
    // person sees. Accept it before observing the test OS-open seam.
    const openLink = desktop.page.getByRole("button", { name: "Open link", exact: true });
    const captured = () => desktop.app.evaluate(() => (globalThis as typeof globalThis & { onboardingBrowserUrl?: string }).onboardingBrowserUrl);
    await expect.poll(async () => await openLink.isVisible() || Boolean(await captured())).toBe(true);
    if (await openLink.isVisible()) await openLink.click();
    await expect.poll(captured).toBeTruthy();
    const url = (await captured())!;
    expect(new URL(url).origin).toBe(origin);
    await browserPage.goto(url);
    return url;
  } finally {
    await desktop.app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { onboardingBrowserUrl?: string; onboardingOpenExternal?: typeof shell.openExternal };
      shell.openExternal = state.onboardingOpenExternal!;
      delete state.onboardingOpenExternal;
      delete state.onboardingBrowserUrl;
    });
  }
}

/** Signs up from a desktop's approval page, or on its own when no approval is waiting. */
export async function createVerifiedAccount(page: Page, server: Awaited<ReturnType<typeof startAccountServer>>, account: { email: string; password: string; name?: string }, approvalUrl?: string) {
  const before = server.mail.messages.length;
  if (approvalUrl) await page.getByRole("link", { name: /create (an )?account|sign up/i }).click();
  else await page.goto(`${server.origin}/account/sign-up`);
  await page.getByLabel(/^name$/i).fill(account.name ?? "Self-host desktop proof");
  await page.getByLabel(/^email$/i).fill(account.email);
  await page.getByLabel(/^password$/i).fill(account.password);
  await page.getByRole("button", { name: /create account|sign up/i }).click();
  await expect(page).toHaveURL(/\/account\/verify-email\?next=/);
  await expect.poll(() => server.mail.messages.length).toBeGreaterThan(before);
  const verification = mailLinks(server.mail.messages[before]!).find(link => link.includes("verify-email"));
  expect(verification).toBeTruthy();
  await page.goto(verification!);
  if (!approvalUrl) {
    await expect(page.getByRole("link", { name: "Go to your account" })).toBeVisible();
    return;
  }
  await page.getByRole("link", { name: "Continue connecting your device" }).click();
  await expect(page).toHaveURL(approvalUrl);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);

/**
 * Approval browsers stand in for each person's own browser. This test process
 * adds the fixture CA to its trusted roots and makes their requests to the
 * stack, verifying the certificate chain and address; Chromium never skips a
 * certificate check. `restore` puts this process's roots back.
 *
 * The fixture boundary: Chromium follows a fulfilled redirect itself, outside
 * the route, and would then meet the fixture CA it does not trust. So a GET
 * navigation the server redirects within its origin is answered with the
 * server's own headers and cookies and a page that navigates at once to the
 * same destination, which comes back through this route. Every other response
 * is the server's own, and any other redirect is refused.
 */
export function trustFixtureCa(ca: string) {
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, ca]);
  return {
    route: (context: BrowserContext, origin: string) => context.route(`${origin}/**`, async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      if (!REDIRECTS.has(response.status())) return route.fulfill({ response });
      const request = route.request();
      const location = response.headers()["location"];
      const target = location === undefined ? undefined : new URL(location, request.url());
      if (!target || target.origin !== origin || request.method() !== "GET" || !request.isNavigationRequest()) {
        return route.abort("blockedbyclient");
      }
      const headers: Record<string, string> = { ...response.headers(), "content-type": "text/html; charset=utf-8" };
      for (const name of ["location", "content-length", "content-encoding", "transfer-encoding"]) delete headers[name];
      return route.fulfill({ status: 200, headers,
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escapeHtml(target.href)}">` });
    }),
    restore: () => setDefaultCACertificates(previous),
  };
}

export async function approveDesktop(page: Page, account: { email: string; password: string }) {
  const password = page.getByLabel(/^password$/i);
  const approve = page.getByRole("button", { name: /^approve|allow/i });
  await expect(password.or(approve).first()).toBeVisible();
  if (await password.isVisible()) {
    await page.getByLabel(/^email$/i).fill(account.email);
    await password.fill(account.password);
    await page.getByRole("button", { name: /^sign in$/i }).click();
  }
  await approve.click();
  await expect(page.getByText(/approved|connected|return to dohc/i).first()).toBeVisible();
}
