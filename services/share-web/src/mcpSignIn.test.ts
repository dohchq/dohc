import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import {
  appendLog, claimWorkspace, closeTestStorages, createShare, json, jsonBody, linkSecret, moment, putBlob,
  RELAY_EXCHANGE_KEY, request, testHandler, testStorage,
} from "../../sync-relay/src/testing";
import { COLLECTION_WRITES_PATH } from "./collectionWrites";
import { MCP_CORS_HEADERS, signInPageCsp } from "./mcpSignIn";
import {
  authorizePath, consentForm, decide, LOOPBACK_REDIRECT, pkce, register, registeredClient, signInAgent, tokenRequest,
  type ShareWebSend,
} from "./mcpSignIn.test-helper";
import { createShareWebApplication, streamsRequestBody } from "./server";

// The standard MCP sign-in through the real share-web and the real relay:
// an agent finds the sign-in from a 401, registers, a person allows it on the
// consent page, and the agent trades the code for tokens. share-web keeps
// none of it, so a restart changes nothing for the agent.

const HOST = "share.example.test", ORIGIN = `https://${HOST}`;
const OWNER = "sign-in-owner", WORKSPACE = "sign-in-web", CONTENT = "Packing list";
const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await closeTestStorages();
});

const resourceOf = (secret: string) => `${ORIGIN}/mcp/s/${secret}`;

function expectCors(response: Response) {
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) expect(response.headers.get(name), name).toBe(value);
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
}

// A page that cannot go back to the agent: no form, no redirect, no CORS.
async function expectErrorPage(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBe(signInPageCsp("'none'"));
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.has("location")).toBe(false);
  expect(response.headers.has("access-control-allow-origin")).toBe(false);
  expect(await response.text()).toContain("dohc could not connect this agent");
}

async function stack(options: { exchangeKey?: boolean } = {}) {
  const storage = await testStorage();
  const relay = testHandler(storage, { relayExchangeKey: RELAY_EXCHANGE_KEY });
  const relayCalls: string[] = [];
  let consentRefused = false;
  const fetchRelay = async (relayRequest: Request) => {
    const path = new URL(relayRequest.url).pathname;
    relayCalls.push(path);
    // Stands in for a link that ends between the relay accepting the sign-in and the page reading it.
    return consentRefused && path === "/sync/link/agent-authorizations/consent" ? new Response(null, { status: 404 }) : relay(relayRequest);
  };
  await claimWorkspace(relay, OWNER, WORKSPACE);
  const blob = await putBlob(relay, OWNER, WORKSPACE, CONTENT);
  await appendLog(relay, OWNER, WORKSPACE, [moment("docs/list.md", CONTENT)]);
  const link = async (paths: string[]) => {
    const shareId = await createShare(relay, OWNER, WORKSPACE, { recipientUserId: "seed-recipient", paths });
    const created = await relay(request(OWNER, `/sync/${WORKSPACE}/shares/${shareId}/links`, jsonBody({ access: "view" })));
    expect(created.status).toBe(200);
    return linkSecret((await json(created)).url);
  };
  const secret = await link(["docs"]), otherSecret = await link(["notes"]);
  const application = () => createShareWebApplication({
    relayUrl: "https://relay.example.test", publicRelayUrl: "https://relay.example.test",
    ...(options.exchangeKey === false ? {} : { relayExchangeKey: RELAY_EXCHANGE_KEY }),
    publicHosts: new Set([HOST]), nowMs: () => 2_000, fetchRelay,
  });
  let app = application();
  const send: ShareWebSend = (path, init = {}) => app.handle(new Request(ORIGIN + path, { ...init, headers: { host: HOST, ...init.headers } }));
  const mcp = (linkSecretValue: string, headers: Record<string, string> = {}) => send(`/mcp/s/${linkSecretValue}`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  async function connect(accessToken: string, linkSecretValue: string) {
    const client = new Client({ name: "sign-in-agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(resourceOf(linkSecretValue)), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      fetch: async (input, init) => {
        const forwarded = new Request(input, init);
        forwarded.headers.set("host", HOST);
        return app.handle(forwarded);
      },
    }));
    clients.push(client);
    return client;
  }
  // A code for `clientId`, allowed on the consent page.
  async function code(clientId: string, redirectUri = LOOPBACK_REDIRECT) {
    const { verifier, challenge } = pkce();
    const form = await consentForm(await send(authorizePath({ clientId, resource: resourceOf(secret), challenge, redirectUri, state: "token" })));
    const decided = await decide(send, ORIGIN, form, "allow");
    const value = new URL(decided.headers.get("location") ?? "", LOOPBACK_REDIRECT).searchParams.get("code");
    if (decided.status !== 303 || !value) throw new Error(`No code: ${decided.status}`);
    return { code: value, verifier };
  }
  return {
    send, mcp, connect, code, secret, otherSecret, blob, relayCalls,
    refuseConsent() { consentRefused = true; },
    restart() { app = application(); },
  };
}

it("challenges an MCP request without a token, and publishes both metadata documents to any origin", async () => {
  const s = await stack();
  const challenged = await s.mcp(s.secret, { origin: "https://inspector.example.test" });
  expect(challenged.status).toBe(401);
  expect(challenged.headers.get("www-authenticate"))
    .toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/s/${s.secret}"`);
  expectCors(challenged);

  const resource = await s.send(`/.well-known/oauth-protected-resource/mcp/s/${s.secret}`);
  expect(resource.status).toBe(200);
  expect(await resource.json()).toEqual({ resource: resourceOf(s.secret), authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
  expectCors(resource);

  const server = await s.send("/.well-known/oauth-authorization-server");
  expect(server.status).toBe(200);
  expect(await server.json()).toEqual({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: ["none"],
  });
  expectCors(server);

  const unknown = await s.send("/.well-known/oauth-protected-resource/mcp/s/not-a-link-secret");
  expect(unknown.status).toBe(404);
  expectCors(unknown);
});

it("answers a preflight on the MCP and sign-in API paths, and not on the consent page", async () => {
  const s = await stack();
  const preflight = { method: "OPTIONS", headers: { origin: "https://inspector.example.test", "access-control-request-method": "POST" } };
  for (const path of [`/mcp/s/${s.secret}`, `/.well-known/oauth-protected-resource/mcp/s/${s.secret}`,
    "/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/token"]) {
    const answer = await s.send(path, preflight);
    expect(answer.status, path).toBe(204);
    expectCors(answer);
  }
  const page = await s.send("/oauth/authorize", preflight);
  expect(page.status).toBe(405);
  expect(page.headers.has("access-control-allow-origin")).toBe(false);
});

it("registers a public client, and refuses metadata it cannot use", async () => {
  const s = await stack();
  const created = await register(s.send, {
    redirect_uris: [LOOPBACK_REDIRECT, LOOPBACK_REDIRECT], client_name: "Planner", token_endpoint_auth_method: "none",
  });
  expect(created.status).toBe(201);
  expectCors(created);
  expect(await created.json()).toEqual({
    client_id: expect.stringMatching(AGENT_TOKEN), client_id_issued_at: 2, redirect_uris: [LOOPBACK_REDIRECT], client_name: "Planner",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  });
  const refusals: Array<[Record<string, unknown>, string]> = [
    [{ redirect_uris: [] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["http://agent.example.test/callback"] }, "invalid_redirect_uri"],
    [{ redirect_uris: [`${LOOPBACK_REDIRECT}#fragment`] }, "invalid_redirect_uri"],
    [{ redirect_uris: [LOOPBACK_REDIRECT, "https://user:pass@agent.example.test/callback"] }, "invalid_redirect_uri"],
    [{ redirect_uris: [LOOPBACK_REDIRECT], client_name: "Planner\u0007" }, "invalid_client_metadata"],
    [{ redirect_uris: [LOOPBACK_REDIRECT], token_endpoint_auth_method: "client_secret_basic" }, "invalid_client_metadata"],
    [{ redirect_uris: [LOOPBACK_REDIRECT], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [{ redirect_uris: [LOOPBACK_REDIRECT], response_types: ["token"] }, "invalid_client_metadata"],
  ];
  for (const [metadata, error] of refusals) {
    const refused = await register(s.send, metadata);
    expect(refused.status, JSON.stringify(metadata)).toBe(400);
    expect(await refused.json()).toMatchObject({ error });
    expectCors(refused);
  }
  const notJson = await s.send("/oauth/register", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  expect(notJson.status).toBe(400);
  expect(await notJson.json()).toMatchObject({ error: "invalid_client_metadata" });
});

it("shows an error page, and never redirects, until the relay accepts the redirect URI", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send);
  const { challenge } = pkce();
  const valid = { clientId, resource: resourceOf(s.secret), challenge };
  const refusals = [
    authorizePath({ ...valid, resource: `${ORIGIN}/mcp` }),
    authorizePath({ ...valid, resource: `https://other.example.test/mcp/s/${s.secret}` }),
    authorizePath({ ...valid, resource: resourceOf("A".repeat(43)) }),
    authorizePath({ ...valid, clientId: "unregistered-client" }),
    authorizePath({ ...valid, redirectUri: "http://127.0.0.1:33418/elsewhere" }),
    authorizePath(valid).replace("code_challenge_method=S256", "code_challenge_method=plain"),
    authorizePath(valid).replace("response_type=code", "response_type=token"),
    `${authorizePath(valid)}&client_id=${clientId}`,
  ];
  for (const path of refusals) await expectErrorPage(await s.send(path), 400);
  expect((await s.send(authorizePath(valid))).status).toBe(200);
});

it("sends a cancel, and a request that ends before its page, back to the agent with its state", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send);
  const form = await consentForm(await s.send(authorizePath({ clientId, resource: resourceOf(s.secret), challenge: pkce().challenge, state: "kept" })));
  const cancelled = await decide(s.send, ORIGIN, form, "cancel");
  expect(cancelled.status).toBe(303);
  expect(cancelled.headers.get("location")).toBe(`${LOOPBACK_REDIRECT}?error=access_denied&state=kept`);

  s.refuseConsent();
  const ended = await s.send(authorizePath({ clientId, resource: resourceOf(s.secret), challenge: pkce().challenge, state: "kept" }));
  expect(ended.status).toBe(303);
  expect(ended.headers.get("location")).toBe(`${LOOPBACK_REDIRECT}?error=access_denied&state=kept`);
  expect(ended.headers.has("set-cookie")).toBe(false);
});

it("serves the consent page with its own headers and a cookie for this request only", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send, "Planner <script>");
  const page = await s.send(authorizePath({ clientId, resource: resourceOf(s.secret), challenge: pkce().challenge }));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  // The form posts here and follows its 303 to the agent's redirect URI. A
  // same-origin referrer makes the post carry an Origin the decision accepts.
  expect(page.headers.get("content-security-policy")).toBe(signInPageCsp("'self' http://127.0.0.1:33418"));
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://127.0.0.1:33418;");
  expect(page.headers.get("referrer-policy")).toBe("same-origin");
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("cache-control")).toBe("private, no-store");
  expect(page.headers.has("access-control-allow-origin")).toBe(false);
  // Host-only, for the request's remaining life: ten minutes on this fixed clock.
  expect(page.headers.get("set-cookie"))
    .toMatch(/^__Host-dohc_consent_[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Strict$/u);
  const form = await consentForm(page);
  expect(form.cookie.split("=")[1]).toBe(form.secret);
  expect(form.html).toContain('<meta name="referrer" content="same-origin">');
  expect(form.html).toContain("<bdi>Planner &#60;script&#62;</bdi><span class=\"note\">Name reported by the agent</span>");
  expect(form.html).not.toContain("<script>");
  expect(form.html).toContain("Can view");
  expect(form.html).toContain("127.0.0.1:33418");
  expect(form.html).not.toContain(s.secret);
});

it("accepts a choice only from the browser and origin that opened the page, and clears its cookie", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send);
  const form = await consentForm(await s.send(authorizePath({ clientId, resource: resourceOf(s.secret), challenge: pkce().challenge, state: "one" })));
  const name = form.cookie.split("=")[0]!;
  await expectErrorPage(await decide(s.send, ORIGIN, { ...form, cookie: `${name}=${"B".repeat(43)}` }, "allow"), 403);
  await expectErrorPage(await decide(s.send, ORIGIN, { ...form, cookie: "" }, "allow"), 403);
  await expectErrorPage(await decide(s.send, "https://evil.example.test", form, "allow"), 403);
  await expectErrorPage(await decide(s.send, ORIGIN, { ...form, secret: "B".repeat(43) }, "allow"), 403);

  const allowed = await decide(s.send, ORIGIN, form, "allow");
  expect(allowed.status).toBe(303);
  const location = new URL(allowed.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(LOOPBACK_REDIRECT);
  expect(location.searchParams.get("code")).toMatch(AGENT_TOKEN);
  expect(location.searchParams.get("state")).toBe("one");
  expect(allowed.headers.get("set-cookie")).toBe(`${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);

  const again = await decide(s.send, ORIGIN, form, "allow");
  await expectErrorPage(again.clone(), 400);
  expect(again.headers.get("set-cookie")).toBe(`${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`);
});

it("keeps two consent pages open at once apart", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send);
  const open = (state: string) => s.send(authorizePath({ clientId, resource: resourceOf(s.secret), challenge: pkce().challenge, state }));
  const first = await consentForm(await open("first")), second = await consentForm(await open("second"));
  expect(first.cookie.split("=")[0]).not.toBe(second.cookie.split("=")[0]);
  const both = `${first.cookie}; ${second.cookie}`;
  await expectErrorPage(await decide(s.send, ORIGIN, { ...first, cookie: second.cookie }, "allow"), 403);

  const secondAllowed = await decide(s.send, ORIGIN, { ...second, cookie: both }, "allow");
  const firstAllowed = await decide(s.send, ORIGIN, { ...first, cookie: both }, "allow");
  const answer = (response: Response) => new URL(response.headers.get("location")!).searchParams;
  expect([secondAllowed.status, firstAllowed.status]).toEqual([303, 303]);
  expect(answer(secondAllowed).get("state")).toBe("second");
  expect(answer(firstAllowed).get("state")).toBe("first");
  expect(answer(firstAllowed).get("code")).not.toBe(answer(secondAllowed).get("code"));
});

it("trades a code for tokens with or without redirect_uri, and never caches an answer", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send);
  const grant = (input: { code: string; verifier: string }, extra: Record<string, string> = {}) => tokenRequest(s.send, {
    grant_type: "authorization_code", client_id: clientId, code: input.code, code_verifier: input.verifier, resource: resourceOf(s.secret), ...extra,
  });
  const extras: Array<Record<string, string>> = [{ redirect_uri: LOOPBACK_REDIRECT }, {}];
  for (const extra of extras) {
    const tokens = await grant(await s.code(clientId), extra);
    expect(tokens.status).toBe(200);
    expectNoStore(tokens);
    expectCors(tokens);
    expect(await tokens.json()).toEqual({
      access_token: expect.stringMatching(AGENT_TOKEN), token_type: "Bearer", expires_in: 3600, refresh_token: expect.stringMatching(AGENT_TOKEN),
    });
  }
  const refusals = [
    grant(await s.code(clientId), { redirect_uri: "http://127.0.0.1:33418/other" }),
    grant({ ...await s.code(clientId), verifier: pkce().verifier }),
    tokenRequest(s.send, { grant_type: "authorization_code", client_id: clientId, code: "C".repeat(43), code_verifier: pkce().verifier, resource: resourceOf(s.secret) }),
  ];
  for (const refused of await Promise.all(refusals)) {
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_grant" });
    expectNoStore(refused);
    expectCors(refused);
  }
});

it("answers each malformed token request in the OAuth error shape", async () => {
  const s = await stack();
  const clientId = await registeredClient(s.send);
  const { code, verifier } = await s.code(clientId);
  const valid = { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, resource: resourceOf(s.secret) };
  const withoutVerifier = { grant_type: valid.grant_type, client_id: clientId, code, resource: valid.resource };
  // Each refusal: its answer, status, OAuth error, and WWW-Authenticate challenge.
  const refusals: Array<[Promise<Response>, number, string, string | null]> = [
    [tokenRequest(s.send, { ...valid, grant_type: "client_credentials" }), 400, "unsupported_grant_type", null],
    [tokenRequest(s.send, withoutVerifier), 400, "invalid_request", null],
    [tokenRequest(s.send, { ...valid, client_secret: "secret" }), 401, "invalid_client", null],
    [tokenRequest(s.send, valid, { authorization: `Basic ${Buffer.from(`${clientId}:secret`).toString("base64")}` }), 401, "invalid_client", "Basic"],
    [s.send("/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid) }), 400, "invalid_request", null],
    [s.send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `${new URLSearchParams(valid).toString()}&grant_type=refresh_token` }), 400, "invalid_request", null],
  ];
  for (const [pending, status, error, challenge] of refusals) {
    const refused = await pending;
    expect(refused.status, error).toBe(status);
    expect(refused.headers.get("content-type")).toContain("application/json");
    expect(await refused.json()).toMatchObject({ error });
    expect(refused.headers.get("www-authenticate")).toBe(challenge);
    expectNoStore(refused);
    expectCors(refused);
  }
  // None of them spent the code.
  expect((await tokenRequest(s.send, valid)).status).toBe(200);
});

it("refreshes, and ends the connection when a used refresh token comes back", async () => {
  const s = await stack();
  const agent = await signInAgent(s.send, ORIGIN, s.secret);
  const refresh = (refreshToken: string, resource = agent.resource) =>
    tokenRequest(s.send, { grant_type: "refresh_token", client_id: agent.clientId, refresh_token: refreshToken, resource });
  const wrongResource = await refresh(agent.refreshToken, resourceOf(s.otherSecret));
  expect(wrongResource.status).toBe(400);
  expect(await wrongResource.json()).toEqual({ error: "invalid_grant" });

  const refreshed = await refresh(agent.refreshToken);
  expect(refreshed.status).toBe(200);
  expectNoStore(refreshed);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  expect(next.refresh_token).not.toBe(agent.refreshToken);
  expect((await s.mcp(s.secret, { authorization: `Bearer ${next.access_token}` })).status).toBe(200);

  const reused = await refresh(agent.refreshToken);
  expect(reused.status).toBe(400);
  expect(await reused.json()).toEqual({ error: "invalid_grant" });
  const retired = await s.mcp(s.secret, { authorization: `Bearer ${next.access_token}` });
  expect(retired.status).toBe(401);
  expect(retired.headers.get("www-authenticate")).toContain('error="invalid_token"');
});

it("runs a tool call with the bearer at its link's address, and refuses it at another link's", async () => {
  const s = await stack();
  const agent = await signInAgent(s.send, ORIGIN, s.secret);
  expect(agent.resource).toBe(resourceOf(s.secret));
  const client = await s.connect(agent.accessToken, s.secret);
  expect(await client.callTool({ name: "dohc_list_files", arguments: {} }))
    .toMatchObject({ structuredContent: { files: [expect.objectContaining({ blobSha256: s.blob })] } });

  const elsewhere = await s.mcp(s.otherSecret, { authorization: `Bearer ${agent.accessToken}` });
  expect(elsewhere.status).toBe(401);
  expect(elsewhere.headers.get("www-authenticate"))
    .toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/s/${s.otherSecret}", error="invalid_token"`);
  expectCors(elsewhere);
  const malformed = await s.mcp(s.secret, { authorization: "Bearer not-a-token" });
  expect(malformed.status).toBe(401);
  expect(malformed.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expect((await s.mcp(s.secret, { authorization: `Bearer ${agent.accessToken}` })).status).toBe(200);
});

it("keeps a signed-in agent working after share-web restarts", async () => {
  const s = await stack();
  const agent = await signInAgent(s.send, ORIGIN, s.secret);
  s.restart();
  const client = await s.connect(agent.accessToken, s.secret);
  expect(await client.callTool({ name: "dohc_list_files", arguments: {} }))
    .toMatchObject({ structuredContent: { files: [expect.objectContaining({ blobSha256: s.blob })] } });
  const refreshed = await tokenRequest(s.send, { grant_type: "refresh_token", client_id: agent.clientId, refresh_token: agent.refreshToken, resource: agent.resource });
  expect(refreshed.status).toBe(200);
});

it("offers no sign-in without the relay exchange key", async () => {
  const s = await stack({ exchangeKey: false });
  const refused = await register(s.send, { redirect_uris: [LOOPBACK_REDIRECT] });
  expect(refused.status).toBe(404);
  expectCors(refused);
  await expectErrorPage(await s.send(authorizePath({ clientId: "client", resource: resourceOf(s.secret), challenge: pkce().challenge })), 404);
  expect((await s.mcp(s.secret, { authorization: `Bearer ${"C".repeat(43)}` })).status).toBe(404);
  expect(s.relayCalls.filter((path) => path.startsWith("/sync/link/agent"))).toEqual([]);
  expect((await register((await stack()).send, { redirect_uris: [LOOPBACK_REDIRECT] })).status).toBe(201);
});

it("streams only an MCP request and a Collection write past the request buffer", () => {
  expect(streamsRequestBody(new URL(resourceOf("A".repeat(43))))).toBe(true);
  expect(streamsRequestBody(new URL(ORIGIN + COLLECTION_WRITES_PATH))).toBe(true);
  for (const path of ["/mcp", "/oauth/token", "/oauth/register", "/oauth/authorize/decision", "/api/exchange"]) {
    expect(streamsRequestBody(new URL(ORIGIN + path)), path).toBe(false);
  }
});

it("answers 404 at the removed agent exchange and the bare MCP address", async () => {
  const s = await stack();
  const agent = await signInAgent(s.send, ORIGIN, s.secret);
  const removed = [
    s.send("/api/mcp/exchange", jsonBody({ secret: s.secret })),
    s.send("/mcp", { method: "POST", headers: { authorization: `Bearer ${agent.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
    s.send("/mcp", { headers: { authorization: `Bearer ${agent.accessToken}` } }),
  ];
  for (const response of await Promise.all(removed)) {
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not found" });
  }
  const discovery = await s.send("/api/mcp");
  expect(await discovery.json()).toMatchObject({ endpoint: "/mcp/s/<secret>", authorizationServer: "/.well-known/oauth-authorization-server" });
  expect((await s.send("/api/exchange", jsonBody({ secret: s.secret }))).status).toBe(200);
  expect((await s.mcp(s.secret, { authorization: `Bearer ${agent.accessToken}` })).status).toBe(200);
});
