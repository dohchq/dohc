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
import {createLiveValidationExecutor} from "../../sync-relay/src/liveValidation.js";
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
import {createLinkLiveResolver} from "../../sync-relay/src/linkLiveBrowserAuth.js";
import {createLinkLiveHttp} from "../../sync-relay/src/linkLiveHttp.js";
import {chatMessageAppend, chatThreadCreate, sequenced, type ChatOp} from "../../sync-relay/src/testing/index.js";
import {agentChannelWireId} from "@dohc/security-contract/chat-wire-ids";
import {signInAgent, tokenRequest, type ShareWebSend} from "./mcpSignIn.test-helper.js";
import {listening, signInPersonalAgent, TestAccounts, type TestAccount} from "./mcpPersonalSignIn.test-helper.js";
import {createShareWebApplication} from "./server.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Small test bounds, not a production capacity or release admission.
const validationPolicy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const frames = {receive: {maxFrameBytes: 65536, maxStateVectorBytes: 100000, maxUpdateBytes: 1000000, maxSyncBytes: 2000000},
  maxQueuedBytes: 2000000, maxQueuedFrames: 64, maxControlBytes: 131072, maxControlFrames: 8, maxAssemblyBytes: 2000000};
const requests = {maxPendingRequests: 4, maxRequestBytes: 32768, maxResponseBytes: 65536, timeoutMs: 10000};
const routeLimits = {maxConnections: 4, maxConnectionsPerWorkspace: 96, reservedOwnerConnections: 0, maxConnectionsPerSession: 3, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4, maxBufferedBytes: 134217728,
  maxPendingRequests: 4, maxRequestBytes: 32768, maxResponseBytes: 65536, maxPendingBytes: 2000000, maxFragments: 8, maxBufferedChunks: 64,
  upgradeTimeoutMs: 10000, idleTimeoutMs: 60000, drainTimeoutMs: 1000};
const audience = "https://share.example.test", exchangeKey = "mcp-native-exchange-".repeat(2), ticketKey = "mcp-native-tickets-".repeat(2), linkKey = "mcp-native-links-".repeat(2);

// The loopback listener at `listener()` stands behind the public host, as in the deployed proxy.
function behindPublicHost(listener: () => string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    request.headers.set("host", new URL(audience).host);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(listener() + url.pathname + url.search, {method: request.method,
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
}

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
    ingress: {aggregateBytes: 512 * 1024 * 1024, applicationWorkingReserveBytes: 8 * 1024 * 1024, maxUploads: 4, uploadDeadlineMs: 30000},
    client: {aggregateBytes: 200000000, maxUploads: 4, connectTimeoutMs: 30000, requestDeadlineMs: 30000}}));
  const ownerDoc = markdownToYDoc("Hello **world**."), frameChanges = createNamedFrameChanges(16);
  const clients: Client[] = [], closes: (() => Promise<void>)[] = [], upgrades: Promise<void>[] = [];
  let active: Awaited<ReturnType<typeof startServiceLiveHost>> | undefined;
  let acknowledgement: unknown;
  try {
    const validationExecutor = createLiveValidationExecutor();
    closes.push(() => validationExecutor.close());
    const validate = validationExecutor.validator(validationPolicy);
    const {storage} = deployment;
    expect(storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1})).toBe("created");
    expect(storage.provisionLiveHostControl({mode: "service", hostId: "service", updatedAtMs: 1, guard: storage.captureStanding()}).ok).toBe(true);
    active = await startServiceLiveHost({trustedAccount: (accountId: string) => ({accountId, name: accountId}), configPath: serviceConfig, ...deployment, frameChanges});
    const baseline = Y.encodeStateAsUpdate(ownerDoc), document = {workspaceId: "workspace", mainVersionId: mainVersionId!, objectId: "object", lineageClaimId: hash(baseline)};
    const registration = createLiveMarkdownRegistrationValidator(validationPolicy)({document, currentPath: "docs/a.md", checkpoint: baseline});
    if (registration.kind !== "accepted") throw new Error(JSON.stringify(registration));
    const evidence = registration.evidence, markdown = Buffer.from("Hello **world**.\n");
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
      validate, sessions: createLinkLiveResolver({publicEditRelease:{version:1},storage, linkKey, linkAuthority: relayApp.linkAuthority}), tickets, captureNative});
    linkHttp = createLinkLiveHttp({publicEditRelease:{version:1},storage, linkKey, hosts, publicOrigin: audience, exchangeKey, limits: routeLimits,
      linkAuthority: relayApp.linkAuthority});
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
    const publicFetch = behindPublicHost(() => publicUrl);
    async function ownerRequest(path: string, body: unknown) {
      const response = await fetch(relayUrl + path, {method: "POST", headers: {authorization: "Bearer test-owner", "content-type": "application/json"}, body: JSON.stringify(body)});
      const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value;
    }
    async function openLink(access: "view" | "edit") {
      const link = await ownerRequest("/sync/workspace/shares/links", {paths: ["docs/a.md"], access});
      const agent = await signInAgent((path, init) => publicFetch(audience + path, init), audience, new URL(link.url).hash.slice(1), "Test agent");
      const client = new Client({name: "native-proof-agent", version: "1"}); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(agent.resource), {requestInit: {headers: {authorization: `Bearer ${agent.accessToken}`}}, fetch: publicFetch}));
      return {client, link};
    }
    const edit = await openLink("edit"), view = await openLink("view");
    const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({name, arguments: args});
    expect(await call(edit.client, "dohc_list_files")).toMatchObject({structuredContent: {files: [{path: "a.md", blobSha256: hash(markdown)}]}});
    expect(await call(edit.client, "dohc_read_file", {blobSha256: hash(markdown)})).toMatchObject({structuredContent: {ok: true, content: "Hello **world**.\n"}});
    expect(await call(edit.client, "dohc_post_discussion", {body: "Agent reviewed the document.", idempotencyKey: "mcp-proof-comment"})).not.toMatchObject({isError: true});
    expect(JSON.stringify(await call(edit.client, "dohc_read_discussion"))).toContain("Agent reviewed the document.");
    expect(await call(edit.client, "dohc_read_document", {path: "a.md"})).toMatchObject({structuredContent: {ok: true, markdown: "Hello **world**.\n"}});
    const edited = await call(edit.client, "dohc_edit_document", {path: "a.md", find: "world", replacement: "agent"});
    expect(edited).toMatchObject({structuredContent: {ok: true, outcome: "applied"}});
    const ack = (edited.structuredContent as {acknowledgement: {deliveryId: string; updateDigest: string}}).acknowledgement;
    const db = new DatabaseSync(join(workspace, ".dohc/engine/engine.db"), {readOnly: true});
    try {expect(db.prepare("SELECT delivery_id, update_digest FROM live_device_update_applications").all()).toEqual([{delivery_id: ack.deliveryId, update_digest: ack.updateDigest}]);}
    finally {db.close();}
    expect(await call(edit.client, "dohc_read_document", {path: "a.md"})).toMatchObject({structuredContent: {ok: true, markdown: "Hello **agent**.\n"}});
    expect(await active.settle(document)).toMatchObject({materialized: true});
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello **agent**.\n");
    // Ordinary file replication is separate from live settlement in this fixture.
    expect(await call(view.client, "dohc_read_file", {blobSha256: hash(markdown)})).toMatchObject({structuredContent: {ok: true, content: "Hello **world**.\n"}});
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
    expect(await call(edit.client, "dohc_read_file", {blobSha256: hash(markdown)})).toMatchObject({structuredContent: {ok: true, content: "Hello **world**.\n"}});
    expect(readFileSync(join(workspace, "docs/a.md"), "utf8")).toBe("Hello **agent**.\n");
    expect(hash(readFileSync(executable))).toBe(expectedHash);
    acknowledgement = ack;
  } finally {
    const errors: unknown[] = [];
    for (const close of [
      ...clients.map(client => () => client.close()), ...closes.reverse(),
      () => Promise.all(upgrades), () => active?.close(),
      () => deployment.storage.close(), () => ownerDoc.destroy(),
    ]) {
      try {await close();} catch (error) {errors.push(error);}
    }
    if (errors.length) throw new AggregateError(errors, "Native MCP cleanup failed.");
  }
  writeFileSync(join(root, "result.json"), JSON.stringify({verdict: "PASS", executable, sha256: expectedHash,
    scope: "Real MCP HTTP, relay HTTP/WS, native service host, disk settlement; test owner identity", acknowledgement}, null, 2));
}, 90000);

it("signs a personal agent in over HTTP, and it posts, waits and refreshes across a share-web restart", async () => {
  const output = process.env.DOHC_SERVICE_HOST_PROOF_OUTPUT;
  if (!output) throw new Error("An output directory is required.");
  mkdirSync(output, {recursive: true});
  const root = mkdtempSync(join(resolve(output), "mcp-personal-"));
  const configPath = join(root, "deployment.json");
  initializeRelayDeployment({configPath, relayPath: join(root, "relay", "relay.sqlite"), continuityDirectory: join(root, "continuity")});
  const deployment = openRelayDeployment(configPath, {liveTickets: {retainedTicketsPerPrincipalGrant: 4, expiredTicketCleanupBatchSize: 2, now: Date.now}});
  // The account server is a test fixture; the relay, share-web, and the HTTP between them are real.
  const owner: TestAccount = {userId: "owner", name: "Ada", email: "ada@example.test", password: "owner password"};
  const accounts = new TestAccounts(audience, [owner]);
  const clients: Client[] = [], closes: (() => Promise<void>)[] = [];
  try {
    const {storage} = deployment;
    expect(storage.claimWorkspace({workspaceId: "trip", ownerUserId: owner.userId, createdAtMs: 1})).toBe("created");
    const relayApp = createSyncRelayHandler({storage, linkKey, shareWebOrigin: audience, relayExchangeKey: exchangeKey,
      credentialFence: accounts, resolveAccountSession: accounts.resolveAccountSession,
      resolveActor: async (request, workspaceId) => {
        if (request.headers.get("authorization") !== "Bearer test-owner") throw new UnauthorizedError();
        return {userId: owner.userId, workspaceId};
      }});
    closes.push(() => relayApp.dispose());
    await listening(relayApp, accounts);
    const relayHttp = serveFetchHandler({handler: relayApp, maxBodyBytes: () => 32768,
      oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
    relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
    closes.push(() => new Promise<void>(done => relayHttp.close(() => done())));
    const relayUrl = `http://127.0.0.1:${(relayHttp.address() as {port: number}).port}`;

    // Each share-web start is a new process's state; the relay holds every credential.
    let publicUrl = "";
    let stopShareWeb = async () => {};
    async function startShareWeb() {
      const application = createShareWebApplication({relayUrl, publicRelayUrl: audience, relayExchangeKey: exchangeKey,
        publicHosts: new Set([new URL(audience).host]),
        accountAuth: {publicOrigin: audience, upstreamUrl: "https://accounts.example.test"}, fetchAuth: accounts.fetchAuth});
      const publicHttp = serveFetchHandler({handler: application.handle, maxBodyBytes: () => 65536,
        oversized: () => new Response(null, {status: 413}), failure: () => new Response(null, {status: 500})});
      publicHttp.listen(0, "127.0.0.1"); await once(publicHttp, "listening");
      publicUrl = `http://127.0.0.1:${(publicHttp.address() as {port: number}).port}`;
      stopShareWeb = () => new Promise<void>(done => publicHttp.close(() => done()));
    }
    await startShareWeb();
    closes.push(() => stopShareWeb());
    const publicFetch = behindPublicHost(() => publicUrl);
    const send: ShareWebSend = (path, init) => publicFetch(audience + path, init);
    async function connect(accessToken: string, resource: string) {
      const client = new Client({name: "personal-proof-agent", version: "1"}); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(resource), {requestInit: {headers: {authorization: `Bearer ${accessToken}`}}, fetch: publicFetch}));
      return client;
    }
    let ownerSeq = 0;
    async function ownerSays(ops: ChatOp[]) {
      const response = await fetch(`${relayUrl}/sync/trip/log`, {method: "POST", headers: {authorization: "Bearer test-owner", "content-type": "application/json"},
        body: JSON.stringify({originId: "owner-computer", ops: sequenced(ops, ownerSeq)})});
      expect(response.status, await response.clone().text()).toBe(200);
      ownerSeq += ops.length;
    }
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({name, arguments: args})).structuredContent as Record<string, unknown>;

    // Register, sign the browser in, consent at Comment in the address's workspace, and trade the code for tokens.
    const agent = await signInPersonalAgent({send, origin: audience, workspaceId: "trip", account: owner, clientName: "Trip helper"});
    const {agentId} = await relayApp.linkAuthority.personal(new Request(`${relayUrl}/sync/link/personal-agent/workspaces`, {headers: {
      authorization: `DohcAgent ${agent.accessToken}`, "x-dohc-agent-resource": agent.resource, "x-dohc-relay-exchange-key": exchangeKey}}));
    const dm = agentChannelWireId(agentId);
    let client = await connect(agent.accessToken, agent.resource);
    expect(await call(client, "dohc_list_workspaces")).toMatchObject({ok: true, workspaces: [{workspace: "trip", level: "comment"}]});

    await ownerSays([
      chatThreadCreate("thread-dm", dm),
      chatMessageAppend("ask", "thread-dm", "Plan the first day?", {authorUserId: owner.userId, authorDisplayName: owner.name}),
    ]);
    const asked = await call(client, "dohc_wait_for_messages", {timeoutMs: 0});
    expect(asked).toMatchObject({more: false, messages: [{workspace: "trip", channel: dm, path: null, threadId: "thread-dm", messageId: "ask", text: "Plan the first day?"}]});
    expect(await call(client, "dohc_post_channel", {workspace: "trip", threadId: "thread-dm", body: "Museums in the morning.", idempotencyKey: "reply-1"}))
      .toMatchObject({ok: true, message: {workspace: "trip", channel: dm, path: null, authorKind: "agent", authorDisplayName: "Trip helper"}});

    // share-web restarts. The agent refreshes its token and holds a wait that its owner's next message ends.
    await stopShareWeb();
    await startShareWeb();
    const refreshed = await tokenRequest(send, {grant_type: "refresh_token", client_id: agent.clientId, refresh_token: agent.refreshToken, resource: agent.resource});
    expect(refreshed.status).toBe(200);
    const {access_token: accessToken} = await refreshed.json() as {access_token: string};
    client = await connect(accessToken, agent.resource);
    const held = call(client, "dohc_wait_for_messages", {cursor: asked.cursor, timeoutMs: 20_000});
    await ownerSays([chatMessageAppend("thanks", "thread-dm", "Thanks.", {authorUserId: owner.userId, authorDisplayName: owner.name})]);
    // Its own reply doesn't come back; the owner's next message does.
    expect(await held).toMatchObject({messages: [{workspace: "trip", channel: dm, threadId: "thread-dm", messageId: "thanks", text: "Thanks."}]});
  } finally {
    const errors: unknown[] = [];
    for (const close of [...clients.map(client => () => client.close()), ...closes.reverse(), async () => deployment.storage.close()]) {
      try {await close();} catch (error) {errors.push(error);}
    }
    if (errors.length) throw new AggregateError(errors, "Personal MCP cleanup failed.");
  }
}, 60000);
