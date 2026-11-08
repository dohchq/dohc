import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import {
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
} from "@playwright/test";
import {
  expect,
  seedShare,
  stopServer,
  test,
} from "./harness";

// share-web names its sign-in addresses https://<Host>, so the browser and the
// agent reach it through the harness's HTTPS front and its self-signed certificate.
test.use({ httpsFront: true, ignoreHTTPSErrors: true });

const CONSENT_COOKIE_PREFIX = "__Host-dohc_consent_";
const CONSENT_HEADING = "Allow this agent to use the share link?";
const CALLBACK_HEADING = "Back at the agent";
const CLIENT_NAME = "Browser sign-in agent";

interface AgentCallback {
  headers: IncomingHttpHeaders;
  query: URLSearchParams;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${field}`);
  return value;
}

// The agent's loopback redirect URI, as a desktop MCP client opens one.
async function startAgentCallback() {
  const received: AgentCallback[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/callback") received.push({ headers: request.headers, query: url.searchParams });
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

function pkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { challenge: createHash("sha256").update(verifier).digest("base64url"), verifier };
}

async function consentCookieNames(context: BrowserContext, origin: string): Promise<string[]> {
  return (await context.cookies(origin))
    .map((cookie) => cookie.name)
    .filter((name) => name.startsWith(CONSENT_COOKIE_PREFIX));
}

async function jsonBody(response: APIResponse, status: number): Promise<Record<string, unknown>> {
  expect(response.status(), await response.text()).toBe(status);
  return record(await response.json()) ?? {};
}

// A Streamable HTTP answer is JSON, or one SSE event that carries it.
async function rpcResult(response: APIResponse): Promise<Record<string, unknown> | null> {
  const body = await response.text();
  const message = (response.headers()["content-type"] ?? "").startsWith("text/event-stream")
    ? body.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length) ?? ""
    : body;
  return record(record(JSON.parse(message))?.result);
}

function listTools(request: APIRequestContext, resource: string, accessToken?: string): Promise<APIResponse> {
  return request.post(resource, {
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
}

test("a person allows an agent from the consent page, and the agent reaches the share", async ({
  context,
  page,
  playwright,
  stack,
}) => {
  const front = stack.httpsUrl;
  if (!front) throw new Error("the MCP sign-in needs the harness's HTTPS front");
  const seeded = await seedShare({
    relayUrl: stack.relayUrl,
    files: [{ path: "docs/plan.md", content: "# Trip plan\n\nPack light." }],
  });
  const callback = await startAgentCallback();
  const request = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  try {
    // Discovery, as an MCP client does it: the endpoint's 401 names its metadata.
    const resource = `${front}/mcp/s/${seeded.secret}`;
    const unsigned = await listTools(request, resource);
    expect(unsigned.status()).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/u.exec(unsigned.headers()["www-authenticate"] ?? "")?.[1];
    expect(metadataUrl).toBe(`${front}/.well-known/oauth-protected-resource/mcp/s/${seeded.secret}`);
    const protectedResource = await jsonBody(await request.get(requiredText(metadataUrl, "resource_metadata")), 200);
    expect(protectedResource).toMatchObject({ resource, authorization_servers: [front] });
    const server = await jsonBody(await request.get(`${front}/.well-known/oauth-authorization-server`), 200);
    expect(server.issuer).toBe(front);
    const registered = await jsonBody(
      await request.post(requiredText(server.registration_endpoint, "registration_endpoint"), {
        data: { redirect_uris: [callback.redirectUri], client_name: CLIENT_NAME },
      }),
      201,
    );
    const clientId = requiredText(registered.client_id, "client_id");
    const authorizeUrl = (state: string, codeChallenge: string): string => {
      const url = new URL(requiredText(server.authorization_endpoint, "authorization_endpoint"));
      for (const [name, value] of Object.entries({
        response_type: "code",
        client_id: clientId,
        redirect_uri: callback.redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
        resource,
      })) url.searchParams.set(name, value);
      return url.href;
    };

    // Allow: the browser posts the real form and follows the 303 to the agent.
    const allowed = pkce();
    const allowState = randomBytes(16).toString("base64url");
    await page.goto(authorizeUrl(allowState, allowed.challenge));
    await expect(page.getByRole("heading", { name: CONSENT_HEADING })).toBeVisible();
    await expect(page.getByText(CLIENT_NAME, { exact: true })).toBeVisible();
    expect(await consentCookieNames(context, front)).toHaveLength(1);
    const decision = page.waitForRequest((sent) =>
      sent.method() === "POST" && sent.url() === `${front}/oauth/authorize/decision`
    );
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    expect(await (await decision).headerValue("origin")).toBe(front);
    await page.waitForURL((url) => url.origin === callback.origin && url.pathname === "/callback");
    await expect(page.getByRole("heading", { name: CALLBACK_HEADING })).toBeVisible();
    expect(callback.received).toHaveLength(1);
    const allowAnswer = callback.received[0]!;
    expect(allowAnswer.query.get("state")).toBe(allowState);
    expect(allowAnswer.query.get("error")).toBeNull();
    const code = requiredText(allowAnswer.query.get("code"), "code");
    // The consent page's same-origin referrer policy keeps its address off the redirect.
    expect(allowAnswer.headers.referer).toBeUndefined();
    expect(await consentCookieNames(context, front)).toEqual([]);

    const tokens = await jsonBody(
      await request.post(requiredText(server.token_endpoint, "token_endpoint"), {
        form: {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: allowed.verifier,
          redirect_uri: callback.redirectUri,
          resource,
        },
      }),
      200,
    );
    expect(tokens.token_type).toBe("Bearer");
    const listed = await listTools(request, resource, requiredText(tokens.access_token, "access_token"));
    expect(listed.status()).toBe(200);
    const tools = (await rpcResult(listed))?.tools;
    expect(Array.isArray(tools) ? tools.map((tool: unknown) => record(tool)?.name) : [])
      .toEqual(expect.arrayContaining(["dohc_read_file", "dohc_share_status"]));

    // Cancel: a fresh page sends the agent access_denied, with its state.
    const cancelState = randomBytes(16).toString("base64url");
    const cancelPage = await context.newPage();
    await cancelPage.goto(authorizeUrl(cancelState, pkce().challenge));
    await expect(cancelPage.getByRole("heading", { name: CONSENT_HEADING })).toBeVisible();
    expect(await consentCookieNames(context, front)).toHaveLength(1);
    await cancelPage.getByRole("button", { name: "Cancel", exact: true }).click();
    await cancelPage.waitForURL((url) =>
      url.origin === callback.origin && url.pathname === "/callback" && url.searchParams.get("state") === cancelState
    );
    await expect(cancelPage.getByRole("heading", { name: CALLBACK_HEADING })).toBeVisible();
    expect(callback.received).toHaveLength(2);
    const cancelAnswer = callback.received[1]!;
    expect(cancelAnswer.query.get("error")).toBe("access_denied");
    expect(cancelAnswer.query.get("state")).toBe(cancelState);
    expect(cancelAnswer.query.get("code")).toBeNull();
    expect(await consentCookieNames(context, front)).toEqual([]);
  } finally {
    await request.dispose();
    await stopServer(callback.server);
  }
});
