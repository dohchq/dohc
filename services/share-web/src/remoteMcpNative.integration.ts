import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc} from "@dohc/ydoc-projection";
import {createLiveMarkdownJournalValidator} from "@dohc/ydoc-projection/live-journal-validation";
import {createLiveMarkdownRegistrationValidator} from "../../../packages/ydoc-projection/src/liveDocumentValidation.js";
import {createEngineClient} from "../../../packages/workspace-engine-client/src/daemon/engineClient.js";
import {serveFetchHandler} from "@dohc/service-http";
import {UnauthorizedError} from "@dohc/workspace-auth/session";
import {initializeRelayDeployment, openRelayDeployment} from "../../sync-relay/src/relayDeployment.js";
import {startServiceLiveHost} from "../../sync-relay/src/serviceLiveHost.js";
import {createSyncRelayHandler} from "../../sync-relay/src/server.js";
import {createNamedLiveRoutes} from "../../sync-relay/src/namedLiveRoutes.js";
import {createLiveTickets} from "../../sync-relay/src/liveTickets.js";
import {createLiveHostReports} from "../../sync-relay/src/namedLiveHostReports.js";
import {createNamedFrameChanges} from "../../sync-relay/src/liveHostChanges.js";
import {createLinkLiveBrowserResolver} from "../../sync-relay/src/linkLiveBrowserAuth.js";
import {createLinkLiveHttp} from "../../sync-relay/src/linkLiveHttp.js";
import {createShareWebApplication} from "./server.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Small test bounds, not a production capacity or release admission.
const validationPolicy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const frames = {receive: {maxFrameBytes: 65536, maxStateVectorBytes: 100000, maxUpdateBytes: 1000000, maxSyncBytes: 2000000},
  maxQueuedBytes: 2000000, maxQueuedFrames: 64, maxControlBytes: 131072, maxControlFrames: 8, maxAssemblyBytes: 2000000};
const requests = {maxPendingRequests: 4, maxRequestBytes: 32768, maxResponseBytes: 65536, timeoutMs: 10000};
const routeLimits = {maxConnections: 4, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 32768, maxResponseBytes: 65536, maxPendingBytes: 2000000, maxFragments: 8, maxBufferedChunks: 64,
  upgradeTimeoutMs: 10000, idleTimeoutMs: 60000, drainTimeoutMs: 1000};
const audience = "https://share.example.test", exchangeKey = "mcp-native-exchange-".repeat(2), ticketKey = "mcp-native-tickets-".repeat(2), linkKey = "mcp-native-links-".repeat(2);

it("uses shared links over MCP with native durable edits, View restrictions, revocation, and an offline host", async () => {
  const executable = process.env.DOHC_SERVICE_HOST_PROOF_BINARY && resolve(process.env.DOHC_SERVICE_HOST_PROOF_BINARY);
  const expectedHash = process.env.DOHC_SERVICE_HOST_PROOF_SHA256?.toLowerCase(), output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!executable || !expectedHash || !output) throw new Error("Pinned native binary, digest, and output are required.");
  expect(hash(readFileSync(executable))).toBe(expectedHash);
  mkdirSync(output, {recursive: true});
  const root = mkdtempSync(join(resolve(output), "mcp-native-")), workspace = join(root, "workspace"); mkdirSync(workspace);
  const seed = await createEngineClient({command: executable, authToken: "mcp-proof-seed", protocolVersion: 2, capabilities: ["core"], connectTimeoutMs: 30000});
  let mainVersionId: string;
  try {
    const opened = await seed.sendRequest({id: 1, method: "workspace.open", params: {rootDir: workspace, workspaceId: "workspace", captureMode: "none"}, deadlineMs: 30000});
    const main = await seed.sendRequest({id: 2, method: "versions.ensureMain", workspace: (opened.result as {workspace: string}).workspace, params: {}, deadlineMs: 30000});
    mainVersionId = (main.result as {id: string}).id;
  } finally {seed.close(); await seed.waitForExit();}
  const configPath = join(root, "deployment.json");
  initializeRelayDeployment({configPath, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity")});
  const deployment = openRelayDeployment(configPath, {liveTickets: {retainedTicketsPerPrincipalGrant: 4, expiredTicketCleanupBatchSize: 2, now: Date.now}});
  const serviceConfig = join(root, "service.json");
  writeFileSync(serviceConfig, JSON.stringify({version: 1, engineExecutable: executable, hostId: "service", instanceId: "instance",
    workspaces: [{root: workspace, workspaceId: "workspace", maxRegistrations: 8}], settlement: {maxApplicationsPerSettlement: 8},
    sync: {policy: {maxClientVectorBytes: 100000, maxHostVectorBytes: 100000, maxOutputBytes: 1000000, maxReadBytes: 4000000}, workingReserveBytes: 4000000},
    ingress: {aggregateBytes: 400000000, applicationWorkingReserveBytes: 1000000, maxUploads: 4, uploadDeadlineMs: 30000},
    client: {aggregateBytes: 200000000, maxUploads: 4, connectTimeoutMs: 30000, requestDeadlineMs: 30000}}));
  const ownerDoc = markdownToYDoc("Hello **world**."), frameChanges = createNamedFrameChanges(16);
  const clients: Client[] = [], closes: (() => Promise<void>)[] = [], upgrades: Promise<void>[] = [];
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  try {
    const {storage} = deployment;
    expect(storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1})).toBe("created");
    expect(storage.provisionLiveHostControl({mode: "service", hostId: "service", updatedAtMs: 1, guard: storage.captureStanding()}).ok).toBe(true);
    active = await startServiceLiveHost({configPath: serviceConfig, ...deployment, frameChanges});
    const baseline = Y.encodeStateAsUpdate(ownerDoc), document = {workspaceId: "workspace", mainVersionId: mainVersionId!, objectId: "object", lineageClaimId: hash(baseline)};
    const registration = createLiveMarkdownRegistrationValidator(validationPolicy)({document, currentPath: "docs/a.md", checkpoint: baseline});
    if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
    const evidence = registration.evidence, markdown = Buffer.from("Hello **world**.");
    expect(hash(markdown)).toBe(evidence.projectedMarkdownSha256);
    storage.putBlob({workspaceId: "workspace", sha256: hash(markdown), content: markdown, createdAtMs: 2});
    storage.appendLogBatch({workspaceId: "workspace", originId: "owner", ops: [{originSeq: 0, opKind: "moment.append", recordedAtMs: 2,
      payloadJson: JSON.stringify({objectId: "object", momentId: "baseline", versionId: mainVersionId!, recordedAtMs: 2, operation: "write", path: "docs/a.md",
        metadata: {origin: "sync"}, beforePresent: "absent", payloadAfterPath: "docs/a.md", payloadAfterBlobSha256: hash(markdown),
        payloadAfterContentKind: "text", payloadAfterByteLength: markdown.length})}]});
    expect(storage.registerLiveDocumentBaseline({host: active.coordinate, evidence, baselineBytes: baseline, registeredAtMs: 3}).kind).toBe("registered");
    const relayApp = createSyncRelayHandler({storage, publicEditRelease: {version: 1}, linkKey, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      namedBrowserSessionLimits: {...requests, maxSessions: 8, retentionMs: 120000},
      resolveActor: async request => {if (request.headers.get("authorization") !== "Bearer test-owner") throw new UnauthorizedError(); return {userId: "owner", workspaceId: "workspace"};}});
    let routes!: ReturnType<typeof createNamedLiveRoutes>, linkHttp!: ReturnType<typeof createLinkLiveHttp>;
    const relayHttp = serveFetchHandler({handler: request => {
      const path = new URL(request.url).pathname;
      return path === "/sync/live/link-tickets" ? routes.handle(request)
        : ["/sync/live/link-session", "/sync/live/link-document"].includes(path) ? linkHttp(request) : relayApp(request);
    }, maxBodyBytes: () => 32768, oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`, hosts = new Set([new URL(relayUrl).host]);
    const captureNative: Parameters<typeof createLiveHostReports>[0]["captureNative"] = async binding => {
      if (!active) throw new Error("Native host unavailable."); return active.captureNative(binding);
    };
    const tickets = createLiveTickets({storage, audience, key: ticketKey, hostReports: createLiveHostReports({storage, captureNative})});
    routes = createNamedLiveRoutes({kind: "link", storage, hosts, publicOrigin: audience, exchangeKey, frames, limits: routeLimits,
      bounds: {maxClientVectorBytes: 100000, maxSyncOutputBytes: 1000000, maxAppliedUpdateBytes: 1000000, maxSubmissionBytes: 1000000, maxAdmissionBytes: 4000000},
      validate: createLiveMarkdownJournalValidator(validationPolicy), sessions: createLinkLiveBrowserResolver({storage, linkKey}), tickets, captureNative});
    linkHttp = createLinkLiveHttp({storage, linkKey, hosts, publicOrigin: audience, exchangeKey, limits: routeLimits});
    closes.push(async () => routes.close());
    relayHttp.on("upgrade", (request, socket, head) => {upgrades.push(routes.handleUpgrade(request, socket, head));});
    const application = createShareWebApplication({publicEditRelease: {version: 1}, relayUrl, publicRelayUrl: audience,
      relayExchangeKey: exchangeKey, publicHosts: new Set([new URL(audience).host]),
      linkLive: {publicOrigin: audience, requests, editor: {provider: {frames, maxPendingUpdateBytes: 2000000, maxPendingUpdates: 4, maxDeliveryAttempts: 3},
        maxHttpResponseBytes: 65536, maxSocketBufferedBytes: 2000000, connectTimeoutMs: 10000, sendTimeoutMs: 10000, drainPollMs: 10}}});
    const publicHttp = serveFetchHandler({handler: application.handle, maxBodyBytes: () => 32768,
      oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
    publicHttp.listen(0, "127.0.0.1"); await once(publicHttp, "listening");
    closes.push(() => new Promise<void>(done => publicHttp.close(() => done())));
    const publicUrl = `http://127.0.0.1:${(publicHttp.address() as {port: number}).port}`;
    // The loopback listener stands behind the public host, as in the deployed proxy.
    const publicFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      request.headers.set("host", new URL(audience).host);
      const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      return new Promise((resolve, reject) => {
        const outgoing = httpRequest(publicUrl + url.pathname + url.search, {method: request.method,
          headers: Object.fromEntries(request.headers), signal: request.signal}, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.once("error", reject);
          response.once("end", () => {
            const headers = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
            resolve(new Response([204, 205, 304].includes(response.statusCode!) ? null : Buffer.concat(chunks), {status: response.statusCode, headers}));
          });
        });
        outgoing.once("error", reject); outgoing.end(body);
      });
    };
    async function ownerRequest(path: string, body: unknown) {
      const response = await fetch(relayUrl + path, {method: "POST", headers: {authorization: "Bearer test-owner", "content-type": "application/json"}, body: JSON.stringify(body)});
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value;
    }
    async function openLink(access: "view" | "edit") {
      const link = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/a.md"], access});
      const exchange = await publicFetch(audience + "/api/mcp/exchange", {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({secret: new URL(link.url).hash.slice(1)})});
      expect(exchange.status).toBe(200);
      const {bearer} = await exchange.json() as {bearer: string};
      const client = new Client({name: "native-proof-agent", version: "1"}); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(audience + "/mcp"), {requestInit: {headers: {authorization: `Bearer ${bearer}`}}, fetch: publicFetch}));
      return {client, link};
    }
    const edit = await openLink("edit"), view = await openLink("view");
    const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({name, arguments: args});
    expect(await call(edit.client, "dohc_list_files")).toMatchObject({structuredContent: {files: [{path: "a.md", blobSha256: hash(markdown)}]}});
    expect(await call(edit.client, "dohc_read_file", {blobSha256: hash(markdown)})).toMatchObject({structuredContent: {ok: true, content: "Hello **world**."}});
    expect(await call(edit.client, "dohc_post_discussion", {body: "Agent reviewed the document.", idempotencyKey: "mcp-proof-comment", claimedName: "Test agent"})).not.toMatchObject({isError: true});
    expect(JSON.stringify(await call(edit.client, "dohc_read_discussion"))).toContain("Agent reviewed the document.");
    expect(await call(edit.client, "dohc_read_document", {path: "a.md"})).toMatchObject({structuredContent: {ok: true, markdown: "Hello **world**."}});
    const edited = await call(edit.client, "dohc_edit_document", {path: "a.md", find: "world", replacement: "agent"});
    expect(edited).toMatchObject({structuredContent: {ok: true, outcome: "applied"}});
    const ack = (edited.structuredContent as {acknowledgement: {deliveryId: string; updateDigest: string}}).acknowledgement;
    const db = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {expect(db.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications").all()).toEqual([{delivery_id: ack.deliveryId, update_digest: ack.updateDigest}]);}
    finally {db.close();}
    expect(await call(edit.client, "dohc_read_document", {path: "a.md"})).toMatchObject({structuredContent: {ok: true, markdown: "Hello **agent**."}});
    expect((await active.settle(document)).materialized).toBe(true);
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello **agent**.");
    // Ordinary file replication is separate from live settlement in this fixture.
    expect(await call(view.client, "dohc_read_file", {blobSha256: hash(markdown)})).toMatchObject({structuredContent: {ok: true, content: "Hello **world**."}});
    const viewTools = (await view.client.listTools()).tools.map(tool => tool.name);
    expect(viewTools).not.toContain("dohc_edit_document"); expect(viewTools).not.toContain("dohc_post_discussion");
    await expect(call(view.client, "dohc_edit_document", {path: "a.md", find: "agent", replacement: "forbidden"})).rejects.toThrow("not found");
    await expect(call(view.client, "dohc_post_discussion", {body: "forbidden", idempotencyKey: "view-denied"})).rejects.toThrow("not found");
    expect(await call(view.client, "dohc_list_files")).not.toMatchObject({isError: true});
    await ownerRequest(`/sync/shares/${view.link.shareId}/revoke`, {grantId: view.link.grantId, workspaceId: "workspace", expectedDependentGrantIds: []});
    await expect(call(view.client, "dohc_list_files")).rejects.toThrow();
    await active.close(); active = undefined;
    expect(await call(edit.client, "dohc_edit_document", {path: "a.md", find: "agent", replacement: "offline"})).toMatchObject({isError: true, structuredContent: {ok: false, outcome: "not-applied"}});
    expect(await call(edit.client, "dohc_list_files")).not.toMatchObject({isError: true});
    expect(await call(edit.client, "dohc_read_file", {blobSha256: hash(markdown)})).toMatchObject({structuredContent: {ok: true, content: "Hello **world**."}});
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello **agent**.");
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
      scope: "Real MCP HTTP, relay HTTP/WS, native service host, disk settlement; test owner identity", acknowledgement: ack}, null, 2));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    for (const close of closes.reverse()) await close();
    await Promise.allSettled(upgrades);
    await active?.close(); deployment.storage.close(); ownerDoc.destroy();
  }
}, 90000);
