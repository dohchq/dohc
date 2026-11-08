import { createHash, randomBytes } from "node:crypto";
import { expect, type Browser } from "@playwright/test";

// An agent that signs in to a share link with the standard MCP sign-in, as
// services/share-web/e2e/mcp-sign-in.spec.ts does it: discovery from the
// endpoint's 401, registration, a person's Allow on the consent page, and the
// code exchange. Its HTTP goes straight to share-web's handler with the public
// Host, so no host name has to resolve; the consent page runs in the shared
// browser, which maps the viewer host to share-web.

export type ShareWebHandle = (request: Request) => Promise<Response>;

// The agent's loopback redirect URI. The browser's route answers it, so no
// listener is needed.
const CALLBACK = "http://127.0.0.1:9/callback";
const CONSENT_HEADING = "Allow this agent to use the share link?";

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
}): Promise<LinkAgent> {
  const { handle, address: resource } = input;
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
    body: JSON.stringify({ redirect_uris: [CALLBACK], ...(input.clientName === undefined ? {} : { client_name: input.clientName }) }),
  }), 201);
  const clientId = text(registered.client_id, "client_id");

  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorize = new URL(text(server.authorization_endpoint, "authorization_endpoint"));
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
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
    await page.route((url) => url.href.startsWith(CALLBACK), (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Agent callback</title>" }));
    await page.goto(authorize.href);
    await expect(page.getByRole("heading", { name: CONSENT_HEADING })).toBeVisible();
    await expect(page.getByText(input.clientName === undefined ? "The agent reported no name" : "Name reported by the agent")).toBeVisible();
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.waitForURL((url) => url.href.startsWith(CALLBACK));
    const answer = new URL(page.url());
    expect(answer.searchParams.get("state")).toBe(state);
    code = text(answer.searchParams.get("code"), "code");
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
      redirect_uri: CALLBACK,
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
