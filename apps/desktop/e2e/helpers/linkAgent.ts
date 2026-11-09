import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { expect, type Browser } from "@playwright/test";

// An agent that signs in to a share link with the standard MCP sign-in, as
// services/share-web/e2e/mcp-sign-in.spec.ts does it: discovery from the
// endpoint's 401, registration, a person's Allow on the consent page, and the
// code exchange. Its HTTP goes straight to share-web's handler with the public
// Host, so no host name has to resolve; the consent page runs in the shared
// browser, which maps the viewer host to share-web.

export type ShareWebHandle = (request: Request) => Promise<Response>;

const CONSENT_HEADING = "Allow this agent to use the share link?";
const CALLBACK_HEADING = "Back at the agent";

type AgentCallbackAnswer = { query: URLSearchParams };

export type AgentCallback = {
  origin: string;
  redirectUri: string;
  // Every request to /callback, in order: the code or error, and the state.
  received: AgentCallbackAnswer[];
  server: Server;
};

/**
 * The agent's loopback redirect URI, as a desktop MCP client opens one, on a
 * port the OS picks. The consent page's Allow answers 303 to it, and the
 * browser follows that to this listener. Close it with stopAgentCallback.
 */
export async function startAgentCallback(): Promise<AgentCallback> {
  const received: AgentCallbackAnswer[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/callback") received.push({ query: url.searchParams });
    request.resume();
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><title>Agent callback</title><h1>${CALLBACK_HEADING}</h1>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("agent callback did not bind a loopback TCP port");
  }
  const origin = `http://127.0.0.1:${String(address.port)}`;
  return { origin, received, redirectUri: `${origin}/callback`, server };
}

export async function stopAgentCallback(callback: AgentCallback | null): Promise<void> {
  if (!callback?.server.listening) return;
  callback.server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    callback.server.close((error) => (error ? reject(error) : resolve()));
  });
}

export type LinkAgent = {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenEndpoint: string;
  // One JSON-RPC call to the link's MCP endpoint, with this agent's token
  // unless another is given.
  rpc(method: string, params?: Record<string, unknown>, accessToken?: string): Promise<Response>;
  // One tools/call: its HTTP status, and the tool's structured result when it answered.
  tool(name: string, args?: Record<string, unknown>, accessToken?: string): Promise<{ status: number; result: Record<string, unknown> | null }>;
  // A refresh_token grant at the token endpoint, naming this link's address unless another is given.
  refresh(refreshToken: string, resource?: string): Promise<Response>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${field}`);
  return value;
}

export function shareWebRequest(
  handle: ShareWebHandle,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const target = new URL(url);
  const headers = new Headers(init.headers);
  headers.set("host", target.host);
  return handle(new Request(target.href, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  }));
}

async function json(response: Response, status: number): Promise<Record<string, unknown>> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return record(JSON.parse(body));
}

// A Streamable HTTP answer is JSON, or one SSE event that carries it.
export async function rpcResult(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  const message = (response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length) ?? ""
    : body;
  return record(record(JSON.parse(message)).result);
}

// share-web serves MCP without transport sessions: each request builds its
// own server, so a call needs no initialize first. remoteMcp.test.ts proves
// that a real SDK client's initialize works there too.
function rpc(handle: ShareWebHandle, resource: string, method: string, params: Record<string, unknown> | undefined, accessToken: string | undefined) {
  return shareWebRequest(handle, resource, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}

export async function signInLinkAgent(input: {
  handle: ShareWebHandle;
  browser: Browser;
  // The address Copy for an agent puts on the clipboard.
  address: string;
  // What the agent's client reports as its name; none when undefined.
  clientName?: string;
  // The test's loopback listener, which the consent page's Allow returns to.
  callback: AgentCallback;
}): Promise<LinkAgent> {
  const { handle, address: resource, callback } = input;
  const { redirectUri } = callback;
  const unsigned = await rpc(handle, resource, "tools/list", undefined, undefined);
  expect(unsigned.status).toBe(401);
  const metadataUrl = text(/resource_metadata="([^"]+)"/u.exec(unsigned.headers.get("www-authenticate") ?? "")?.[1], "resource_metadata");
  const protectedResource = await json(await shareWebRequest(handle, metadataUrl), 200);
  expect(protectedResource.resource).toBe(resource);
  const servers = protectedResource.authorization_servers;
  const issuer = text(Array.isArray(servers) ? servers[0] : undefined, "authorization_servers");
  const server = await json(await shareWebRequest(handle, `${issuer}/.well-known/oauth-authorization-server`), 200);
  const registered = await json(await shareWebRequest(handle, text(server.registration_endpoint, "registration_endpoint"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri],...(input.clientName === undefined ? {} : { client_name: input.clientName }) }),
  }), 201);
  const clientId = text(registered.client_id, "client_id");

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(text(server.authorization_endpoint, "authorization_endpoint"));
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    resource,
  })) authorize.searchParams.set(name, value);

  // A fresh context, so no consent cookie carries over from another agent.
  const context = await input.browser.newContext();
  let code: string;
  try {
    const page = await context.newPage();
    await page.goto(authorize.href);
    await expect(page.getByRole("heading", { name: CONSENT_HEADING })).toBeVisible();
    await expect(page.getByText(input.clientName === undefined ? "The agent reported no name" : "Name reported by the agent")).toBeVisible();
    // Allow posts the form, and the browser follows the 303 to the listener.
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.waitForURL((url) =>
      url.origin === callback.origin && url.pathname === "/callback" && url.searchParams.get("state") === state);
    await expect(page.getByRole("heading", { name: CALLBACK_HEADING })).toBeVisible();
    const answers = callback.received.filter((answer) => answer.query.get("state") === state);
    expect(answers).toHaveLength(1);
    expect(answers[0]!.query.get("error")).toBeNull();
    code = text(answers[0]!.query.get("code"), "code");
  } finally {
    await context.close();
  }

  const tokenEndpoint = text(server.token_endpoint, "token_endpoint");
  const tokens = await json(await shareWebRequest(handle, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }).toString(),
  }), 200);
  expect(tokens.token_type).toBe("Bearer");
  const accessToken = text(tokens.access_token, "access_token");
  const call = (method: string, params: Record<string, unknown> | undefined, token: string | undefined) =>
    rpc(handle, resource, method, params, token ?? accessToken);
  return {
    clientId,
    accessToken,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
    tokenEndpoint,
    rpc: call,
    async tool(name, args = {}, token) {
      const response = await call("tools/call", { name, arguments: args }, token);
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, result: null };
      }
      const result = await rpcResult(response);
      return { status: response.status, result: result.structuredContent === undefined ? null : record(result.structuredContent) };
    },
    refresh: (refreshToken, target = resource) => shareWebRequest(handle, tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: target }).toString(),
    }),
  };
}
