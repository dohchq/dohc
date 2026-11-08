import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readBoundedJson } from "@dohc/service-http";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { asRecord } from "@dohc/workspace-core";

// The standard MCP sign-in for a share link (MCP 2025-06-18 authorization):
// the two metadata documents, dynamic client registration, the consent page
// and its decision, and the token endpoint. The relay keeps every durable
// part, so a share-web restart changes nothing for a signed-in agent.

export const MCP_PATH_PREFIX = "/mcp/s/";
const RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource/mcp/s/";
const AUTHORIZATION_SERVER_METADATA = "/.well-known/oauth-authorization-server";
const REGISTER = "/oauth/register";
const AUTHORIZE = "/oauth/authorize";
const DECISION = "/oauth/authorize/decision";
const TOKEN = "/oauth/token";

const MAX_SIGN_IN_BODY_BYTES = 8 * 1024;
const MAX_RELAY_ANSWER_BYTES = 16 * 1024;
const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CONSENT_SECRET = /^[A-Za-z0-9_-]{43}$/u;

// Browser MCP clients call these paths from their own origin. The bearer is
// the credential, never a cookie, so no credentials are allowed.
export const MCP_CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
});

/** Whether a path answers browser MCP clients across origins. `/oauth/authorize` is a navigation, so it is not one. */
export function isMcpCorsPath(pathname: string): boolean {
  return pathname.startsWith(MCP_PATH_PREFIX) || pathname.startsWith(RESOURCE_METADATA_PREFIX) ||
    pathname === AUTHORIZATION_SERVER_METADATA || pathname === REGISTER || pathname === TOKEN;
}

/** The link secret an MCP address names, or null. */
export function mcpLinkSecret(pathname: string): string | null {
  const secret = pathname.startsWith(MCP_PATH_PREFIX) ? pathname.slice(MCP_PATH_PREFIX.length) : "";
  return LINK_SECRET_PATTERN.test(secret) ? secret : null;
}

/** The 401 that sends an MCP client to sign in. */
export function mcpChallenge(origin: string, secret: string, invalidToken: boolean): Response {
  const metadata = `${origin}${RESOURCE_METADATA_PREFIX}${secret}`;
  return new Response(null, {status: 401, headers: {
    "www-authenticate": `Bearer resource_metadata="${metadata}"${invalidToken ? ', error="invalid_token"' : ""}`,
  }});
}

// The page's one style block, allowed by its hash. The page runs no script.
const CONSENT_STYLE = `
:root{color-scheme:light dark;--bg:#faf9f5;--panel:#f3f1ea;--line:#e4e1d8;--ink:#1c1b18;--muted:#55524a;--accent:#2d342e;--on-accent:#faf9f5;--danger:#9d3c28}
@media (prefers-color-scheme:dark){:root{--bg:#131211;--panel:#181715;--line:#2a2925;--ink:#f6f4ee;--muted:#aba79b;--accent:#d7d0c0;--on-accent:#131211;--danger:#e1866c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:48px auto;padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:12px}
h1{margin:0 0 24px;font-size:16px;font-weight:600}
dl{margin:0 0 24px;display:grid;grid-template-columns:auto 1fr;gap:8px 16px}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
.note{display:block;color:var(--muted);font-size:12px}
.error{color:var(--danger)}
form{display:flex;justify-content:flex-end;gap:8px}
button{height:32px;padding:0 12px;border-radius:6px;font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
button[value=allow]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;
const CONSENT_STYLE_HASH = createHash("sha256").update(CONSENT_STYLE).digest("base64");
/** The consent page's own policy: its style block, and a form that posts only here. */
export const CONSENT_PAGE_CSP = `default-src 'none'; style-src 'sha256-${CONSENT_STYLE_HASH}'; base-uri 'none'; ` +
  "form-action 'self'; frame-ancestors 'none'";

const ACCESS_LABELS: Readonly<Record<string, string>> = {view: "Can view", comment: "Can comment", edit: "Can edit"};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function page(title: string, content: string, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${CONSENT_STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
  const result = new Response(html, {status, headers});
  result.headers.set("content-type", "text/html; charset=utf-8");
  result.headers.set("content-security-policy", CONSENT_PAGE_CSP);
  return result;
}

// A sign-in that cannot go back to the agent: before the relay accepted the
// redirect URI, a redirect could send the browser anywhere.
function errorPage(message: string, status = 400): Response {
  return page("dohc could not connect this agent", `<p class="error">${escapeHtml(message)}</p>`, status);
}

const START_AGAIN = "Start the sign-in again from your agent.";

function oauthError(status: number, error: string, description?: string, headers: Record<string, string> = {}): Response {
  return Response.json({error, ...(description ? {error_description: description} : {})}, {status, headers});
}

// One value per name: a repeated parameter is refused, as OAuth requires.
function singleParams(params: URLSearchParams): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}

async function formParams(request: Request): Promise<Map<string, string> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  try {
    const body = await request.text();
    return Buffer.byteLength(body) > MAX_SIGN_IN_BODY_BYTES ? null : singleParams(new URLSearchParams(body));
  } catch {
    return null;
  }
}

function consentCookieName(requestId: string): string {
  return `__Host-dohc_consent_${createHash("sha256").update(requestId).digest("base64url").slice(0, 16)}`;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function redirectTo(redirectUri: string, values: Record<string, string | null>): Response {
  const location = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) if (value !== null) location.searchParams.set(key, value);
  return new Response(null, {status: 303, headers: {location: location.href}});
}

type RelayAnswer = {status: number; value: Record<string, unknown> | null};

export function createMcpSignIn(options: {
  relayUrl: string;
  /** The relay exchange key. Without it every sign-in route refuses. */
  exchangeKey: string | undefined;
  fetchRelay(request: Request): Promise<Response>;
  nowMs(): number;
  timeoutMs: number;
  /** Admits one sign-in request from an address; false when it is over its budget. */
  admit(clientIp: string): boolean;
  newConsentSecret?: () => string;
}) {
  const newConsentSecret = options.newConsentSecret ?? (() => randomBytes(32).toString("base64url"));

  async function relay(path: string, body: Record<string, unknown>, request: Request): Promise<RelayAnswer> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)]);
    let answer: Response | undefined;
    try {
      answer = await options.fetchRelay(new Request(new URL(path, `${options.relayUrl.replace(/\/+$/u, "")}/`), {
        method: "POST", redirect: "manual", signal, body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": options.exchangeKey ?? "",
          "x-dohc-relay-client-ip": request.headers.get("x-dohc-share-web-client-ip") ?? "unknown",
        },
      }));
      if (answer.status !== 200) return {status: answer.status, value: null};
      const value = asRecord(await readBoundedJson(answer, MAX_RELAY_ANSWER_BYTES, signal));
      return value?.ok === true ? {status: 200, value} : {status: 503, value: null};
    } catch {
      return {status: 503, value: null};
    } finally {
      await answer?.body?.cancel().catch(() => undefined);
    }
  }

  function resourceMetadata(origin: string, pathname: string): Response {
    const secret = pathname.slice(RESOURCE_METADATA_PREFIX.length);
    if (!LINK_SECRET_PATTERN.test(secret)) return oauthError(404, "invalid_request");
    return Response.json({resource: `${origin}${MCP_PATH_PREFIX}${secret}`, authorization_servers: [origin], bearer_methods_supported: ["header"]});
  }

  function authorizationServerMetadata(origin: string): Response {
    return Response.json({
      issuer: origin,
      authorization_endpoint: `${origin}${AUTHORIZE}`,
      token_endpoint: `${origin}${TOKEN}`,
      registration_endpoint: `${origin}${REGISTER}`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  // RFC 7591, dynamic registration only.
  async function register(request: Request): Promise<Response> {
    const invalid = (description: string) => oauthError(400, "invalid_client_metadata", description);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return invalid("Send the client metadata as JSON.");
    }
    let metadata: Record<string, unknown> | null;
    try {
      metadata = asRecord(await readBoundedJson(request, MAX_SIGN_IN_BODY_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)])));
    } catch {
      return invalid("Send the client metadata as JSON, at most 8 KiB.");
    }
    if (!metadata) return invalid("Send the client metadata as a JSON object.");
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((uri) => typeof uri === "string")) {
      return oauthError(400, "invalid_redirect_uri", "Send redirect_uris as a list of one or more URIs.");
    }
    if (metadata.token_endpoint_auth_method !== undefined && metadata.token_endpoint_auth_method !== "none") {
      return invalid("token_endpoint_auth_method must be none.");
    }
    const grantTypes = metadata.grant_types;
    if (grantTypes !== undefined && (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code") ||
        grantTypes.some((grant) => grant !== "authorization_code" && grant !== "refresh_token"))) {
      return invalid("grant_types must be authorization_code, with refresh_token if you use it.");
    }
    const responseTypes = metadata.response_types;
    if (responseTypes !== undefined && (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code")) {
      return invalid("response_types must be code.");
    }
    const clientName = metadata.client_name;
    if (clientName !== undefined && typeof clientName !== "string") return invalid("client_name must be text.");
    const answer = await relay("/sync/link/agent-clients", {
      registration: "registered", redirectUris, ...(clientName ? {clientName} : {}),
    }, request);
    if (answer.status === 404) {
      return oauthError(400, "invalid_client_metadata",
        "Each redirect URI must use HTTPS, or HTTP to a loopback address, with no fragment. client_name must be 1 to 100 characters without control characters.");
    }
    if (!answer.value || typeof answer.value.clientId !== "string") return oauthError(503, "temporarily_unavailable");
    return Response.json({
      client_id: answer.value.clientId,
      client_id_issued_at: Math.floor(options.nowMs() / 1_000),
      redirect_uris: [...new Set(redirectUris)],
      ...(clientName ? {client_name: clientName} : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, {status: 201});
  }

  async function authorize(request: Request, origin: string): Promise<Response> {
    const params = singleParams(new URL(request.url).searchParams);
    if (!params) return errorPage(`The sign-in request repeats a parameter. ${START_AGAIN}`);
    if (params.get("response_type") !== "code") return errorPage(`The sign-in request must ask for a code. ${START_AGAIN}`);
    const resource = params.get("resource") ?? "";
    if (mcpLinkSecret(resource.startsWith(`${origin}/`) ? resource.slice(origin.length) : "") === null) {
      return errorPage(`The sign-in request must name this server's MCP address for the share link. ${START_AGAIN}`);
    }
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    const codeChallenge = params.get("code_challenge");
    if (!clientId || !redirectUri || !codeChallenge || params.get("code_challenge_method") !== "S256") {
      return errorPage(`The sign-in request is missing its client, redirect URI, or S256 code challenge. ${START_AGAIN}`);
    }
    const state = params.get("state") ?? null;
    // The relay checks the client, its redirect URI, the challenge, and the
    // link. Its refusal does not say which, so nothing redirects yet.
    const begun = await relay("/sync/link/agent-authorizations", {
      clientId, resource, redirectUri, codeChallenge, codeChallengeMethod: "S256", ...(state === null ? {} : {state}),
    }, request);
    if (begun.status === 429) return errorPage("Too many sign-in requests came from this address. Try again in a few minutes.", 429);
    if (begun.status === 404) {
      return errorPage(`This share link has ended, or the agent's sign-in request does not match its registration. ${START_AGAIN}`);
    }
    const requestId = begun.value?.requestId;
    if (typeof requestId !== "string" || !AGENT_TOKEN.test(requestId)) return errorPage("dohc could not reach the share's server. Try again later.", 503);
    // From here the relay has accepted the redirect URI, so errors go back to the agent.
    const consent = await relay("/sync/link/agent-authorizations/consent", {requestId}, request);
    const value = consent.value;
    if (!value || typeof value.access !== "string" || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) ||
        (value.subjectName !== null && typeof value.subjectName !== "string") ||
        (value.reportedClientName !== null && typeof value.reportedClientName !== "string") || value.redirectUri !== redirectUri) {
      return redirectTo(redirectUri, {error: consent.status === 404 ? "access_denied" : "temporarily_unavailable", state});
    }
    const secret = newConsentSecret();
    if (!CONSENT_SECRET.test(secret)) return redirectTo(redirectUri, {error: "server_error", state});
    const maxAge = Math.max(1, Math.ceil((value.expiresAtMs - options.nowMs()) / 1_000));
    const agentName = typeof value.reportedClientName === "string" ? value.reportedClientName : null;
    const content =
      "<dl>" +
      `<dt>Share</dt><dd>${escapeHtml(typeof value.subjectName === "string" ? value.subjectName : "Untitled share")}</dd>` +
      `<dt>Access</dt><dd>${escapeHtml(ACCESS_LABELS[value.access] ?? value.access)}</dd>` +
      `<dt>Agent</dt><dd>${agentName === null ? "Agent<span class=\"note\">The agent reported no name</span>"
        : `${escapeHtml(agentName)}<span class="note">Name reported by the agent</span>`}</dd>` +
      `<dt>Returns to</dt><dd>${escapeHtml(new URL(redirectUri).host)}</dd>` +
      "</dl>" +
      `<form method="post" action="${DECISION}">` +
      `<input type="hidden" name="request" value="${escapeHtml(requestId)}">` +
      `<input type="hidden" name="secret" value="${escapeHtml(secret)}">` +
      "<button type=\"submit\" name=\"decision\" value=\"cancel\">Cancel</button>" +
      "<button type=\"submit\" name=\"decision\" value=\"allow\">Allow</button>" +
      "</form>";
    return page("Allow this agent to use the share link?", content, 200, {
      "set-cookie": `${consentCookieName(requestId)}=${secret}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`,
    });
  }

  async function decide(request: Request, origin: string): Promise<Response> {
    if (request.headers.get("origin") !== origin) return errorPage(`dohc accepts this choice only from its own consent page. ${START_AGAIN}`, 403);
    const form = await formParams(request);
    const requestId = form?.get("request") ?? "";
    const decision = form?.get("decision");
    if (!form || !AGENT_TOKEN.test(requestId) || (decision !== "allow" && decision !== "cancel")) {
      return errorPage(`dohc could not read this choice. ${START_AGAIN}`);
    }
    const name = consentCookieName(requestId);
    const clear = {"set-cookie": `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`};
    const cookie = cookieValue(request.headers.get("cookie"), name);
    const secret = form.get("secret") ?? "";
    if (cookie === null || !CONSENT_SECRET.test(secret) || !sameSecret(cookie, secret)) {
      return errorPage(`This choice did not come from the consent page this browser opened. ${START_AGAIN}`, 403);
    }
    const decided = await relay("/sync/link/agent-authorizations/decision", {requestId, decision}, request);
    const value = decided.value;
    if (!value || typeof value.redirectUri !== "string" || (value.state !== null && typeof value.state !== "string") ||
        (decision === "allow" && (typeof value.code !== "string" || !AGENT_TOKEN.test(value.code)))) {
      const refusal = decided.status === 404
        ? errorPage(`This sign-in request expired or already has an answer. ${START_AGAIN}`)
        : errorPage("dohc could not reach the share's server. Try again later.", 503);
      refusal.headers.set("set-cookie", clear["set-cookie"]);
      return refusal;
    }
    const state = typeof value.state === "string" ? value.state : null;
    const answer = redirectTo(value.redirectUri, decision === "allow" ? {code: String(value.code), state} : {error: "access_denied", state});
    answer.headers.set("set-cookie", clear["set-cookie"]);
    return answer;
  }

  // RFC 6749 section 5: JSON answers, none of them cached.
  async function token(request: Request): Promise<Response> {
    const noStore = {"cache-control": "no-store", pragma: "no-cache"};
    // A public client authenticates with nothing; a client that sends a secret is not this client.
    if (request.headers.has("authorization")) {
      return oauthError(401, "invalid_client", "This server registers public clients only. Send no client authentication.",
        {...noStore, "www-authenticate": "Basic"});
    }
    const form = await formParams(request);
    if (!form) return oauthError(400, "invalid_request", "Send one form-encoded value for each parameter.", noStore);
    if (form.has("client_secret")) {
      return oauthError(401, "invalid_client", "This server registers public clients only. Send no client_secret.", noStore);
    }
    const clientId = form.get("client_id");
    const resource = form.get("resource");
    if (!clientId || !resource) return oauthError(400, "invalid_request", "Send client_id and resource.", noStore);
    const grantType = form.get("grant_type");
    let body: Record<string, unknown>;
    if (grantType === "authorization_code") {
      const code = form.get("code"), codeVerifier = form.get("code_verifier"), redirectUri = form.get("redirect_uri");
      if (!code || !codeVerifier) return oauthError(400, "invalid_request", "Send code and code_verifier.", noStore);
      body = {grantType, clientId, code, codeVerifier, resource, ...(redirectUri === undefined ? {} : {redirectUri})};
    } else if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) return oauthError(400, "invalid_request", "Send refresh_token.", noStore);
      body = {grantType, clientId, refreshToken, resource};
    } else {
      return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.", noStore);
    }
    const answer = await relay("/sync/link/agent-token", body, request);
    if (answer.status === 404) return oauthError(400, "invalid_grant", undefined, noStore);
    const value = answer.value;
    if (!value || typeof value.accessToken !== "string" || !AGENT_TOKEN.test(value.accessToken) ||
        typeof value.refreshToken !== "string" || !AGENT_TOKEN.test(value.refreshToken) ||
        typeof value.accessTokenExpiresAtMs !== "number" || !Number.isSafeInteger(value.accessTokenExpiresAtMs)) {
      return oauthError(503, "temporarily_unavailable", undefined, noStore);
    }
    return Response.json({
      access_token: value.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(0, Math.floor((value.accessTokenExpiresAtMs - options.nowMs()) / 1_000)),
      refresh_token: value.refreshToken,
    }, {headers: noStore});
  }

  /** Answers a sign-in route, or null when the path is not one. */
  async function handle(request: Request, origin: string): Promise<Response | null> {
    const {pathname, search} = new URL(request.url);
    const signInRoute = pathname === REGISTER || pathname === AUTHORIZE || pathname === DECISION || pathname === TOKEN;
    if (pathname.startsWith(RESOURCE_METADATA_PREFIX)) {
      return request.method === "GET" && !search ? resourceMetadata(origin, pathname) : oauthError(405, "invalid_request");
    }
    if (pathname === AUTHORIZATION_SERVER_METADATA) {
      return request.method === "GET" && !search ? authorizationServerMetadata(origin) : oauthError(405, "invalid_request");
    }
    if (!signInRoute) return null;
    if (!options.exchangeKey) return pathname === AUTHORIZE || pathname === DECISION
      ? errorPage("This server does not offer agent sign-in.", 404) : oauthError(404, "invalid_request");
    if (!options.admit(request.headers.get("x-dohc-share-web-client-ip") ?? "unknown")) {
      return pathname === AUTHORIZE || pathname === DECISION
        ? errorPage("Too many sign-in requests came from this address. Try again in a few minutes.", 429)
        : oauthError(429, "temporarily_unavailable", "Too many requests. Try again in a few minutes.", {"cache-control": "no-store", "retry-after": "60"});
    }
    if (pathname === AUTHORIZE) return request.method === "GET" ? authorize(request, origin) : errorPage(`Open the sign-in link in a browser. ${START_AGAIN}`, 405);
    if (request.method !== "POST" || search) {
      return pathname === DECISION ? errorPage(`dohc could not read this choice. ${START_AGAIN}`, 405) : oauthError(405, "invalid_request");
    }
    if (pathname === REGISTER) return register(request);
    if (pathname === DECISION) return decide(request, origin);
    return token(request);
  }

  return {handle};
}
