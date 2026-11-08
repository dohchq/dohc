import { createHash, randomBytes } from "node:crypto";

// The standard MCP sign-in as a client and a person run it: register,
// open the consent page, allow, and trade the code for tokens. Each step
// is separate, so a test can break one; signInAgent runs them all.

/** Sends one request to share-web at a path, as its public host. */
export type ShareWebSend = (path: string, init?: RequestInit) => Promise<Response>;

export const LOOPBACK_REDIRECT = "http://127.0.0.1:33418/callback";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function register(send: ShareWebSend, metadata: Record<string, unknown>): Promise<Response> {
  return send("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) });
}

export async function registeredClient(send: ShareWebSend, clientName?: string, redirectUri = LOOPBACK_REDIRECT): Promise<string> {
  const response = await register(send, { redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...(clientName === undefined ? {} : { client_name: clientName }) });
  if (response.status !== 201) throw new Error(`Registration failed: ${response.status} ${await response.text()}`);
  return String(((await response.json()) as { client_id: unknown }).client_id);
}

export function authorizePath(input: { clientId: string; resource: string; challenge: string; redirectUri?: string; state?: string }): string {
  return `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: input.clientId,
    redirect_uri: input.redirectUri ?? LOOPBACK_REDIRECT, code_challenge: input.challenge, code_challenge_method: "S256",
    resource: input.resource, ...(input.state === undefined ? {} : { state: input.state }) })}`;
}

/** The consent page's form fields and the cookie it set, as the browser holds them. */
export async function consentForm(page: Response) {
  const html = await page.text();
  const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`, "u").exec(html)?.[1];
  const requestId = field("request"), secret = field("secret");
  const cookie = page.headers.get("set-cookie")?.split(";", 1)[0];
  if (page.status !== 200 || !requestId || !secret || !cookie) throw new Error(`No consent page: ${page.status} ${html}`);
  return { requestId, secret, cookie, html };
}

export function decide(send: ShareWebSend, origin: string, form: { requestId: string; secret: string; cookie: string },
  decision: "allow" | "cancel", headers: Record<string, string> = {}): Promise<Response> {
  return send("/oauth/authorize/decision", { method: "POST",
    headers: { origin, cookie: form.cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ request: form.requestId, secret: form.secret, decision }).toString() });
}

export function tokenRequest(send: ShareWebSend, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return send("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString() });
}

/** What an MCP client holds after it signs in to one share link. */
export interface SignedInAgent {
  clientId: string;
  resource: string;
  accessToken: string;
  refreshToken: string;
}

/** Signs an agent in to the share link `secret` names, with a person allowing it. */
export async function signInAgent(send: ShareWebSend, origin: string, secret: string, clientName?: string): Promise<SignedInAgent> {
  const resource = `${origin}/mcp/s/${secret}`;
  const clientId = await registeredClient(send, clientName);
  const { verifier, challenge } = pkce();
  const form = await consentForm(await send(authorizePath({ clientId, resource, challenge, state: "sign-in" })));
  const decided = await decide(send, origin, form, "allow");
  const location = new URL(decided.headers.get("location") ?? "", LOOPBACK_REDIRECT);
  const code = location.searchParams.get("code");
  if (decided.status !== 303 || !code || location.searchParams.get("state") !== "sign-in") {
    throw new Error(`No code: ${decided.status} ${location.href}`);
  }
  const tokens = await tokenRequest(send, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier,
    redirect_uri: LOOPBACK_REDIRECT, resource });
  const value = (await tokens.json()) as { access_token?: unknown; refresh_token?: unknown };
  if (tokens.status !== 200 || typeof value.access_token !== "string" || typeof value.refresh_token !== "string") {
    throw new Error(`No tokens: ${tokens.status} ${JSON.stringify(value)}`);
  }
  return { clientId, resource, accessToken: value.access_token, refreshToken: value.refresh_token };
}
