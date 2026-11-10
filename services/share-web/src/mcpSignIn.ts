import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readBoundedJson } from "@dohc/service-http";
import {
  normalizeShareDiscussionDisplayName, SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT,
} from "@dohc/security-contract/share-discussion";
import { AGENT_REDIRECT_URI_LIMIT, isAgentRedirectUri, LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { isAgentHue, type AgentHue } from "@dohc/workspace-contracts/agent-hues";
import { handleForName } from "@dohc/workspace-contracts/chat-mentions";
import { asRecord } from "@dohc/workspace-core";
import { readsAccountEmail } from "./accountAuth";
import { namedAccountCookie } from "./namedAccountCookie";
import { DOHC_MARK } from "./workLinkPage";

// The standard MCP sign-in (MCP 2025-06-18 authorization) for two kinds of
// MCP address: a share link's, and a personal agent's, which names a
// workspace and signs the agent in as an account's own. Both use the two
// metadata documents, dynamic client registration and the token endpoint;
// each has its own consent page. The relay keeps every durable part, so a
// share-web restart changes nothing for a signed-in agent.

export const MCP_PATH_PREFIX = "/mcp/s/";
export const PERSONAL_MCP_PATH_PREFIX = "/mcp/agent/w/";
const RESOURCE_METADATA = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_METADATA = "/.well-known/oauth-authorization-server";
const REGISTER = "/oauth/register";
const AUTHORIZE = "/oauth/authorize";
const DECISION = "/oauth/authorize/decision";
// A personal sign-in's own forms: the browser's account sign-in and sign-out, and the consent.
const SIGN_IN = "/oauth/authorize/sign-in";
const SIGN_OUT = "/oauth/authorize/sign-out";
const PERSONAL_DECISION = "/oauth/authorize/agent";
const TOKEN = "/oauth/token";

const MAX_SIGN_IN_BODY_BYTES = 8 * 1024;
// A personal form carries its sign-in request's address, and the consent one a choice per workspace.
const MAX_PERSONAL_FORM_BYTES = 64 * 1024;
const MAX_RELAY_ANSWER_BYTES = 16 * 1024;
const MAX_PERSONAL_CONSENT_BYTES = 512 * 1024;
const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const CONSENT_SECRET = /^[A-Za-z0-9_-]{43}$/u;
const PERSONAL_AGENT_ID = /^p-[a-z2-7]{26}$/u;
// The relay's limits on a personal sign-in.
const PERSONAL_REACH_LIMIT = 20;
const AGENT_NAME_CHAR_LIMIT = 100;
const WORKSPACE_ID_CHAR_LIMIT = 256;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** The largest body a sign-in route reads, or null for any other path. */
export function signInBodyLimit(pathname: string): number | null {
  if (pathname === REGISTER || pathname === TOKEN || pathname === DECISION) return MAX_SIGN_IN_BODY_BYTES;
  return pathname === SIGN_IN || pathname === SIGN_OUT || pathname === PERSONAL_DECISION ? MAX_PERSONAL_FORM_BYTES : null;
}

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
  return pathname.startsWith(MCP_PATH_PREFIX) || pathname.startsWith(PERSONAL_MCP_PATH_PREFIX) ||
    pathname.startsWith(`${RESOURCE_METADATA}${MCP_PATH_PREFIX}`) || pathname.startsWith(`${RESOURCE_METADATA}${PERSONAL_MCP_PATH_PREFIX}`) ||
    pathname === AUTHORIZATION_SERVER_METADATA || pathname === REGISTER || pathname === TOKEN;
}

/** The link secret an MCP address names, or null. */
export function mcpLinkSecret(pathname: string): string | null {
  const secret = pathname.startsWith(MCP_PATH_PREFIX) ? pathname.slice(MCP_PATH_PREFIX.length) : "";
  return LINK_SECRET_PATTERN.test(secret) ? secret : null;
}

/**
 * The workspace a personal MCP address names, or null. The relay accepts one
 * spelling of each address, so this does too.
 */
export function mcpPersonalWorkspace(pathname: string): string | null {
  if (!pathname.startsWith(PERSONAL_MCP_PATH_PREFIX)) return null;
  const segment = pathname.slice(PERSONAL_MCP_PATH_PREFIX.length);
  let workspaceId: string;
  try {
    workspaceId = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return workspaceId.length > 0 && workspaceId.length <= WORKSPACE_ID_CHAR_LIMIT && workspaceId.trim() === workspaceId &&
    !CONTROL_CHARS.test(workspaceId) && encodeURIComponent(workspaceId) === segment ? workspaceId : null;
}

/** The 401 that sends an MCP client to sign in at the address `resourcePath` names. */
export function mcpChallenge(origin: string, resourcePath: string, invalidToken: boolean): Response {
  const metadata = `${origin}${RESOURCE_METADATA}${resourcePath}`;
  return new Response(null, {status: 401, headers: {
    "www-authenticate": `Bearer resource_metadata="${metadata}"${invalidToken ? ', error="invalid_token"' : ""}`,
  }});
}

// The pages' one style block, allowed by its hash. The pages run no script.
// The agent hues are the desktop's, so an agent keeps its color here.
const CONSENT_STYLE = `
:root{color-scheme:light dark;--bg:#faf9f5;--panel:#f3f1ea;--raised:#fff;--line:#e4e1d8;--ink:#1c1b18;--muted:#55524a;--subtle:#7f7b6e;--accent:#2d342e;--on-accent:#faf9f5;--danger:#9d3c28;--mark:#2d342e;--hue-olive:#666d2e;--hue-rust:#88412c;--hue-amber:#705012;--hue-teal:#22645a;--hue-blue:#285884;--hue-indigo:#4c528f;--hue-plum:#764580;--hue-rose:#8e3f5a;--agent:var(--hue-olive)}
@media (prefers-color-scheme:dark){:root{--bg:#131211;--panel:#181715;--raised:#1f1e1b;--line:#2a2925;--ink:#f6f4ee;--muted:#aba79b;--subtle:#7d7a6e;--accent:#d7d0c0;--on-accent:#131211;--danger:#e1866c;--mark:#e4e1d8;--hue-olive:#c0c585;--hue-rust:#dc9378;--hue-amber:#d9b05a;--hue-teal:#82c9bb;--hue-blue:#8fb8e2;--hue-indigo:#a7abee;--hue-plum:#d09fd9;--hue-rose:#e39bb2}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:8px;padding:16px 20px;font-weight:600}
.brand svg{display:block;width:18px;height:20px;color:var(--mark)}
.host{min-width:0;font-weight:400;color:var(--muted);overflow-wrap:anywhere}
main{max-width:440px;margin:24px auto 48px;padding:0 16px}
.card{padding:24px;background:var(--raised);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.06)}
.head{margin:0 0 20px;text-align:center}
.pair{display:flex;align-items:center;justify-content:center;gap:10px;margin:0 0 16px;color:var(--subtle)}
.tile{display:grid;place-items:center;width:48px;height:48px;border-radius:13px;font-size:19px;font-weight:600}
.tile.agent{color:var(--agent);background:color-mix(in srgb,var(--agent) 13%,var(--raised));border:1px dashed color-mix(in srgb,var(--agent) 45%,transparent)}
.tile.known{border-style:solid}
.tile.dohc{color:var(--mark);background:var(--panel);border:1px solid var(--line)}
.tile.dohc svg{width:24px;height:26px}
.hue-olive{--agent:var(--hue-olive)}
.hue-rust{--agent:var(--hue-rust)}
.hue-amber{--agent:var(--hue-amber)}
.hue-teal{--agent:var(--hue-teal)}
.hue-blue{--agent:var(--hue-blue)}
.hue-indigo{--agent:var(--hue-indigo)}
.hue-plum{--agent:var(--hue-plum)}
.hue-rose{--agent:var(--hue-rose)}
h1{margin:0;font-size:18px;font-weight:600;overflow-wrap:anywhere}
.lede{margin:4px 0 0;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
.sec{display:block;margin:18px 2px 6px;color:var(--subtle);font-size:12px;font-weight:500}
.box{margin:0;border:1px solid var(--line);border-radius:11px;overflow:hidden}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line)}
.row:last-child,.opt:last-child{border-bottom:0}
.k{flex:1;min-width:140px;overflow-wrap:anywhere}
dt{flex:none;width:64px;color:var(--muted)}
dd{margin:0}
.av{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:7px;background:var(--panel);color:var(--muted);font-size:11.5px;font-weight:600}
.av.agent{color:var(--agent)}
button,input{font:inherit;color:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;height:34px;padding:0 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg);font-size:13.5px;font-weight:500;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.wide{width:100%}
.link{padding:0;border:0;background:none;color:var(--muted);font-size:13px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.btn:focus-visible,.link:focus-visible,.text:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.text{display:block;width:100%;height:36px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}
.text[aria-invalid=true]{border-color:var(--danger);box-shadow:0 0 0 1px var(--danger)}
.cap,.error{margin:6px 2px 0;font-size:12.5px;overflow-wrap:anywhere}
.cap{color:var(--muted)}
.error{color:var(--danger)}
.msg{margin:0;color:var(--danger);text-align:center;overflow-wrap:anywhere}
.opt{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:10px 12px;border:0;border-bottom:1px solid var(--line);background:none;text-align:left;cursor:pointer}
.opt:hover{background:var(--panel)}
.opt:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.opt .k{min-width:0}
.tick{flex:none;width:16px;height:16px;border:1.5px solid var(--subtle);border-radius:50%}
.opt[aria-pressed=true] .tick{border:5px solid var(--accent)}
.sub{color:var(--muted)}
.seg{position:relative;display:inline-flex;padding:2px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
.seg input{position:absolute;width:1px;height:1px;margin:0;opacity:0}
.seg label{padding:3px 10px;border-radius:7px;color:var(--muted);font-size:12.5px;cursor:pointer}
.seg input:checked+label{background:var(--raised);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.seg input:focus-visible+label{outline:2px solid var(--accent);outline-offset:1px}
.note{display:flex;gap:10px;margin:18px 0 0;padding:10px 12px;border-radius:10px;background:var(--panel);color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
.note .i{flex:none;margin-top:1px}
.empty{padding:22px 12px;border:1px dashed var(--line);border-radius:11px;color:var(--muted);text-align:center;overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:20px}
.to{flex:1 1 140px;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
.btns{display:flex;gap:8px;margin-left:auto}
.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.tile .i{width:22px;height:22px}
`;
const CONSENT_STYLE_HASH = createHash("sha256").update(CONSENT_STYLE).digest("base64");

/** A sign-in page's own headers, which share-web sends in place of its defaults. */
export interface SignInPagePolicy {
  contentSecurityPolicy: string;
  referrerPolicy: "same-origin" | "no-referrer";
}

const pagePolicies = new WeakMap<Response, SignInPagePolicy>();
/** The policy of a page this module made, or null for any other answer. */
export function signInPagePolicy(answer: Response): SignInPagePolicy | null {
  return pagePolicies.get(answer) ?? null;
}

/** A page's style block, and where its form may post: `'none'` for a page with no form. */
export function signInPageCsp(formAction: string): string {
  return `default-src 'none'; style-src 'sha256-${CONSENT_STYLE_HASH}'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'`;
}

/**
 * The consent form posts here, and the browser follows its 303 to the
 * redirect URI the relay accepted, so both are form targets. CSP cannot name
 * an IPv6 address, so a redirect to `[::1]` allows its scheme.
 */
function consentFormAction(redirectUri: string): string {
  const target = new URL(redirectUri);
  return `'self' ${target.hostname.startsWith("[") ? target.protocol : target.origin}`;
}

// A page whose forms post only to this server, and whose posts carry its origin.
const SELF_FORMS: SignInPagePolicy = {contentSecurityPolicy: signInPageCsp("'self'"), referrerPolicy: "same-origin"};

const ACCESS_LABELS: Readonly<Record<string, string>> = {view: "Can view", comment: "Can comment", edit: "Can edit"};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

const LINK_ICON = "<svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7\"/>" +
  "<path d=\"M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7\"/></svg>";
const INFO_ICON = "<svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 16v-4M12 8h.01\"/></svg>";
const AGENT_ICON = "<svg class=\"i\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><rect x=\"5\" y=\"8\" width=\"14\" height=\"11\" rx=\"3\"/>" +
  "<path d=\"M12 4v4M9.5 13h.01M14.5 13h.01\"/></svg>";

const initial = (name: string) => ([...name][0] ?? "").toUpperCase();
const hueClass = (hue: AgentHue | null) => (hue ? ` hue-${hue}` : "");

// The agent beside dohc at the top of a consent page. A new agent's tile is
// dashed; one signing in again is solid, in its own color.
type AgentTile = {name: string | null; hue: AgentHue | null; known: boolean};

// What heads a page's card: the tiles, the title, and the line under it as markup.
type PageHead = {title: string; line?: string; agent?: AgentTile};

function tiles(agent: AgentTile | undefined): string {
  const dohc = `<span class="tile dohc">${DOHC_MARK}</span>`;
  if (!agent) return dohc;
  const letter = agent.name === null ? "" : initial(agent.name);
  return `<span class="tile agent${agent.known ? " known" : ""}${hueClass(agent.hue)}">${letter ? escapeHtml(letter) : AGENT_ICON}</span>` +
    LINK_ICON + dohc;
}

// The name the agent's client reported, which dohc cannot check.
function reportedLine(name: string | null): string {
  return name === null ? "" : `<p class="lede">"<bdi>${escapeHtml(name)}</bdi>" is the name the agent gave.</p>`;
}

function page(origin: string, head: PageHead, content: string, policy: SignInPagePolicy, status = 200, headers: HeadersInit = {}): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="referrer" content="${policy.referrerPolicy}"><title>${escapeHtml(head.title)}</title><style>${CONSENT_STYLE}</style></head>` +
    `<body><header class="brand"><span aria-hidden="true">${DOHC_MARK}</span>dohc <span class="host">${escapeHtml(new URL(origin).host)}</span></header>` +
    `<main><div class="card"><div class="head"><div class="pair" aria-hidden="true">${tiles(head.agent)}</div>` +
    `<h1>${escapeHtml(head.title)}</h1>${head.line ?? ""}</div>${content}</div></main></body></html>`;
  const result = new Response(html, {status, headers});
  result.headers.set("content-type", "text/html; charset=utf-8");
  result.headers.set("content-security-policy", policy.contentSecurityPolicy);
  result.headers.set("referrer-policy", policy.referrerPolicy);
  pagePolicies.set(result, policy);
  return result;
}

// A sign-in that cannot go back to the agent: before the relay accepted the
// redirect URI, a redirect could send the browser anywhere.
function errorPage(origin: string, message: string, status = 400): Response {
  return page(origin, {title: "dohc could not connect this agent"}, `<p class="msg">${escapeHtml(message)}</p>`,
    {contentSecurityPolicy: signInPageCsp("'none'"), referrerPolicy: "no-referrer"}, status);
}

// Where Allow sends the browser: an app on this computer for a loopback redirect, otherwise its host.
function returnsTo(redirectUri: string): string {
  const target = new URL(redirectUri);
  const loopback = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(target.hostname) || target.hostname === "[::1]" || target.hostname === "localhost";
  return loopback ? "Returns to an app on this computer" : `Returns to ${target.host}`;
}

function actions(returns: string, buttons: string): string {
  return `<div class="acts"><span class="to">${escapeHtml(returns)}</span><span class="btns">${buttons}</span></div>`;
}

function note(content: string): string {
  return `<div class="note">${INFO_ICON}<span>${content}</span></div>`;
}

const START_AGAIN = "Start the sign-in again from your agent.";
const TOO_MANY_SIGN_INS = "Too many sign-in requests came from this address. Try again in a few minutes.";
const NO_PERSONAL_SIGN_IN = "This server does not offer personal agent sign-in.";
const ACCOUNT_UNAVAILABLE = "dohc could not check your account right now. Try again shortly.";

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

async function formParams(request: Request, maxBytes = MAX_SIGN_IN_BODY_BYTES): Promise<Map<string, string> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  try {
    const body = await request.text();
    return Buffer.byteLength(body) > maxBytes ? null : singleParams(new URLSearchParams(body));
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

type RelayAnswer = {status: number; value: Record<string, unknown> | null; code: string | null};

// An agent's sign-in request, as its authorize address names it.
type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
  /** The workspace a personal address names; null for a share link's. */
  workspaceId: string | null;
};

function authorizeRequest(search: URLSearchParams, origin: string): AuthorizeRequest | string {
  const params = singleParams(search);
  if (!params) return "The sign-in request repeats a parameter.";
  if (params.get("response_type") !== "code") return "The sign-in request must ask for a code.";
  const resource = params.get("resource") ?? "";
  const path = resource.startsWith(`${origin}/`) ? resource.slice(origin.length) : "";
  const workspaceId = mcpPersonalWorkspace(path);
  if (mcpLinkSecret(path) === null && workspaceId === null) return "The sign-in request must name an MCP address on this server.";
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const codeChallenge = params.get("code_challenge");
  if (!clientId || !redirectUri || !codeChallenge || params.get("code_challenge_method") !== "S256") {
    return "The sign-in request is missing its client, redirect URI, or S256 code challenge.";
  }
  return {clientId, redirectUri, codeChallenge, state: params.get("state") ?? null, resource, workspaceId};
}

function authorizeQuery(auth: AuthorizeRequest): string {
  return new URLSearchParams({
    response_type: "code", client_id: auth.clientId, redirect_uri: auth.redirectUri, code_challenge: auth.codeChallenge,
    code_challenge_method: "S256", resource: auth.resource, ...(auth.state === null ? {} : {state: auth.state}),
  }).toString();
}

// The sign-in request a personal form returns to, read again from the form:
// it names a personal address on this server, so the return stays here.
function personalReturn(value: string | undefined, origin: string): string | null {
  if (value === undefined) return null;
  const auth = authorizeRequest(new URLSearchParams(value), origin);
  return typeof auth === "string" || auth.workspaceId === null ? null : authorizeQuery(auth);
}

// The levels the consent page names. Edit comes with Collection writes and live documents.
const LEVELS = ["view", "comment"] as const;
type PersonalLevel = (typeof LEVELS)[number];
const LEVEL_LABELS: Readonly<Record<PersonalLevel, string>> = {view: "View", comment: "Comment"};
const LEVEL_MEANINGS: Readonly<Record<PersonalLevel, string>> = {
  view: "View reads files and chats.", comment: "Comment also posts in chats and Comments.",
};
const isLevel = (value: unknown): value is PersonalLevel => value === "view" || value === "comment";

interface PersonalConsent {
  reportedClientName: string | null;
  redirectUri: string;
  expiresAtMs: number;
  /** The workspace in the agent's address. */
  workspaceId: string;
  levels: PersonalLevel[];
  workspaces: Array<{workspaceId: string; name: string | null}>;
  agents: Array<{
    agentId: string;
    name: string;
    /** The agent's color, or null when the relay sent none this page knows. */
    hue: AgentHue | null;
    signedOut: boolean;
    reach: Map<string, PersonalLevel>;
  }>;
}

function parsePersonalConsent(value: Record<string, unknown> | null): PersonalConsent | null {
  if (!value || (value.reportedClientName !== null && typeof value.reportedClientName !== "string") ||
      typeof value.redirectUri !== "string" || typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) ||
      typeof value.workspaceId !== "string" || !Array.isArray(value.levels) || !Array.isArray(value.workspaces) ||
      !Array.isArray(value.agents)) return null;
  const offered: unknown[] = value.levels;
  const workspaces: PersonalConsent["workspaces"] = [];
  for (const entry of value.workspaces) {
    const workspace = asRecord(entry);
    const name = typeof workspace?.name === "string" ? workspace.name : null;
    if (!workspace || typeof workspace.workspaceId !== "string" || (workspace.name !== null && name === null)) return null;
    workspaces.push({workspaceId: workspace.workspaceId, name});
  }
  const agents: PersonalConsent["agents"] = [];
  for (const entry of value.agents) {
    const agent = asRecord(entry);
    if (!agent || typeof agent.agentId !== "string" || !PERSONAL_AGENT_ID.test(agent.agentId) ||
        typeof agent.name !== "string" || !Array.isArray(agent.reach)) return null;
    const reach = new Map<string, PersonalLevel>();
    for (const row of agent.reach) {
      const entryReach = asRecord(row);
      if (!entryReach || typeof entryReach.workspaceId !== "string") return null;
      if (isLevel(entryReach.level)) reach.set(entryReach.workspaceId, entryReach.level);
    }
    agents.push({agentId: agent.agentId, name: agent.name, hue: isAgentHue(agent.hue) ? agent.hue : null,
      signedOut: agent.status === "signed_out", reach});
  }
  return {
    reportedClientName: typeof value.reportedClientName === "string" ? value.reportedClientName : null,
    redirectUri: value.redirectUri,
    expiresAtMs: value.expiresAtMs,
    workspaceId: value.workspaceId,
    levels: LEVELS.filter((level) => offered.includes(level)),
    workspaces,
    agents,
  };
}

type ConsentRead = {ok: true; consent: PersonalConsent} | {ok: false; status: number; code: string | null};

type ConsentErrors = {name?: string; reach?: string; form?: string};

// What the consent page shows: its request, the browser's account, and the choices so far.
interface ConsentView {
  requestId: string;
  secret: string;
  returnQuery: string;
  email: string;
  consent: PersonalConsent;
  /** "new", or the id of the agent to sign in as again. */
  as: string;
  name: string;
  reach: Map<string, PersonalLevel>;
  errors: ConsentErrors;
}

// A new agent starts with the address's workspace at the highest level
// offered, and the name its client reported. Signing in again starts from
// the agent's current reach.
function startingChoice(consent: PersonalConsent, as: string): {name: string; reach: Map<string, PersonalLevel>} {
  const listed = new Set(consent.workspaces.map((workspace) => workspace.workspaceId));
  const agent = consent.agents.find((entry) => entry.agentId === as);
  if (agent) return {name: agent.name, reach: new Map([...agent.reach].filter(([workspaceId]) => listed.has(workspaceId)))};
  const highest = consent.levels[consent.levels.length - 1];
  return {
    name: consent.reportedClientName ?? "",
    reach: new Map(highest && listed.has(consent.workspaceId) ? [[consent.workspaceId, highest]] : []),
  };
}

function nameChoice(value: string): {ok: true; name: string} | {ok: false; error: string} {
  const normalized = normalizeShareDiscussionDisplayName(value);
  if (!normalized.ok && normalized.reason === "empty") return {ok: false, error: "Enter a name for this agent."};
  if (!normalized.ok || normalized.value.length > AGENT_NAME_CHAR_LIMIT || CONTROL_CHARS.test(normalized.value)) {
    return {ok: false, error: `Use a name of at most ${String(SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT)} characters.`};
  }
  return {ok: true, name: normalized.value};
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

function fieldError(field: string, error: string | undefined): string {
  return error ? `<p class="error" id="${field}-error">${escapeHtml(error)}</p>` : "";
}

type ChosenAgent = {
  /** The agent signing in again, or null for a new one. */
  agent: PersonalConsent["agents"][number] | null;
  /** Its name: the existing agent's, or a new agent's as typed when that name is valid. */
  name: string | null;
};

function chosenAgent(view: ConsentView): ChosenAgent {
  const agent = view.consent.agents.find((entry) => entry.agentId === view.as) ?? null;
  if (agent) return {agent, name: agent.name};
  const typed = nameChoice(view.name);
  return {agent: null, name: typed.ok ? typed.name : null};
}

function consentContent(view: ConsentView, chosen: ChosenAgent, host: string): string {
  const {consent, errors} = view;
  const binding = hidden("request", view.requestId) + hidden("secret", view.secret) + hidden("return", view.returnQuery);
  const account = `<div class="box"><div class="row"><span class="av" aria-hidden="true">${escapeHtml(initial(view.email))}</span>` +
    `<bdi class="k">${escapeHtml(view.email)}</bdi><button type="submit" form="sign-out" class="link">Not you?</button></div></div>`;
  const forms = `<form id="cancel" method="post" action="${PERSONAL_DECISION}">${binding}</form>` +
    `<form id="sign-out" method="post" action="${SIGN_OUT}">${hidden("return", view.returnQuery)}</form>`;
  const cancel = "<button type=\"submit\" form=\"cancel\" name=\"decision\" value=\"cancel\" class=\"btn\">Cancel</button>";
  if (consent.workspaces.length === 0) {
    return account + `<div class="sec">What it can reach</div><div class="empty">Sync a workspace to ${escapeHtml(host)} first.</div>` +
      actions("", cancel) + forms;
  }
  // The first field with an error takes focus. A form error returns to the workspaces to check again.
  const focused = errors.name ? "name" : errors.reach || errors.form ? "reach" : null;
  const focus = (field: string) => (field === focused ? " autofocus" : "");
  const invalid = (field: string, error: string | undefined) =>
    error ? ` aria-invalid="true" aria-describedby="${field}-error"` : "";
  const {agent} = chosen;
  // The handle is the name's as the page was drawn: the page runs no script to follow typing.
  const handle = agent || chosen.name === null ? "" : handleForName(chosen.name);

  const name = agent ? "" :
    "<label class=\"sec\" for=\"name\">Name</label>" +
    `<input id="name" class="text" name="name" value="${escapeHtml(view.name)}" maxlength="${String(AGENT_NAME_CHAR_LIMIT)}" autocomplete="off"` +
    `${invalid("name", errors.name)}${focus("name")}>` +
    (handle ? `<p class="cap">@${escapeHtml(handle)}</p>` : "") +
    fieldError("name", errors.name);
  // Each choice posts the choose form, which draws the page again for that agent.
  const option = (value: string, label: string) =>
    `<button type="submit" form="choose" name="as" value="${escapeHtml(value)}" class="opt" aria-pressed="${String(value === view.as)}">` +
    `<span class="tick" aria-hidden="true"></span>${label}</button>`;
  const who = consent.agents.length === 0 ? "" :
    "<div class=\"sec\" id=\"who-label\">Who it is</div><div class=\"box\" role=\"group\" aria-labelledby=\"who-label\">" +
    option("new", "<span class=\"k\">New agent</span>") +
    consent.agents.map((entry) => option(entry.agentId,
      `<span class="av agent${hueClass(entry.hue)}" aria-hidden="true">${escapeHtml(initial(entry.name))}</span>` +
      `<span class="k"><bdi>${escapeHtml(entry.name)}</bdi> ` +
      `<span class="sub">@${escapeHtml(handleForName(entry.name))}${entry.signedOut ? " · Signed out" : ""}</span></span>`)).join("") +
    "</div>";
  // Each workspace is a row of radios named as the form posts them; None posts "none".
  const reach = `<div role="group" aria-labelledby="reach-label"${errors.reach ? " aria-describedby=\"reach-error\"" : ""}>` +
    "<div class=\"sec\" id=\"reach-label\">What it can reach</div><div class=\"box\">" +
    consent.workspaces.map((workspace, index) => {
      const id = `w-${String(index)}`;
      const level = view.reach.get(workspace.workspaceId);
      const current = level !== undefined && consent.levels.includes(level) ? level : "none";
      const radios = [{value: "none", label: "None"}, ...consent.levels.map((offered) => ({value: offered, label: LEVEL_LABELS[offered]}))]
        .map(({value, label}) => {
          const checked = value === current;
          return `<input type="radio" id="${id}-${value}" name="w:${escapeHtml(workspace.workspaceId)}" value="${value}"` +
            `${checked ? " checked" : ""}${checked && index === 0 ? focus("reach") : ""}><label for="${id}-${value}">${label}</label>`;
        }).join("");
      return `<div class="row"><bdi class="k" id="${id}">${escapeHtml(workspace.name ?? workspace.workspaceId)}</bdi>` +
        `<span class="seg" role="radiogroup" aria-labelledby="${id}">${radios}</span></div>`;
    }).join("") +
    `</div>${fieldError("reach", errors.reach)}</div>`;
  const meanings = consent.levels.length === 0 ? "" :
    `<p class="cap">${consent.levels.map((level) => LEVEL_MEANINGS[level]).join(" ")}</p>`;
  const allow = "<button type=\"submit\" name=\"decision\" value=\"allow\" class=\"btn primary\">Allow</button>";
  return account +
    `<form id="allow" method="post" action="${PERSONAL_DECISION}">${binding}${hidden("as", view.as)}` +
    who + name + reach + meanings +
    note(`${chosen.name === null ? "This agent" : `<bdi>${escapeHtml(chosen.name)}</bdi>`} runs outside dohc. ` +
      "dohc limits what it reaches here, not what it does elsewhere.") +
    (errors.form ? `<p class="error" role="alert">${escapeHtml(errors.form)}</p>` : "") +
    actions(returnsTo(consent.redirectUri), cancel + allow) +
    "</form>" +
    `<form id="choose" method="post" action="${PERSONAL_DECISION}">${binding}${hidden("decision", "choose")}</form>` +
    forms;
}

function consentPage(origin: string, view: ConsentView, status = 200, headers: HeadersInit = {}): Response {
  const {consent} = view;
  const chosen = chosenAgent(view);
  const head: PageHead = {
    title: `Sign in ${consent.reportedClientName ?? "this agent"} as your agent`,
    line: reportedLine(consent.reportedClientName),
    agent: {name: chosen.name ?? consent.reportedClientName, hue: chosen.agent?.hue ?? null, known: chosen.agent !== null},
  };
  // A same-origin referrer makes each form's post carry this origin, which
  // the decision requires. The cross-origin redirect still carries none.
  return page(origin, head, consentContent(view, chosen, new URL(origin).host),
    {contentSecurityPolicy: signInPageCsp(consentFormAction(consent.redirectUri)), referrerPolicy: "same-origin"}, status, headers);
}

type SignInErrors = {email?: string; password?: string; form?: string};

// The browser's account sign-in, which returns to the agent's sign-in request.
function signInPage(origin: string, returnQuery: string,
  state: {status?: number; email?: string; notice?: string; errors?: SignInErrors} = {}): Response {
  const errors = state.errors ?? {};
  const focused = errors.email || !state.email ? "email" : "password";
  const invalid = (field: string, error: string | undefined) =>
    error ? ` aria-invalid="true" aria-describedby="${field}-error"` : "";
  const content = (state.notice ? note(escapeHtml(state.notice)) : "") +
    `<form method="post" action="${SIGN_IN}" novalidate>${hidden("return", returnQuery)}` +
    "<label class=\"sec\" for=\"email\">Email</label>" +
    `<input id="email" class="text" name="email" type="email" autocomplete="username" value="${escapeHtml(state.email ?? "")}"` +
    `${invalid("email", errors.email)}${focused === "email" ? " autofocus" : ""}>${fieldError("email", errors.email)}` +
    "<label class=\"sec\" for=\"password\">Password</label>" +
    "<input id=\"password\" class=\"text\" name=\"password\" type=\"password\" autocomplete=\"current-password\"" +
    `${invalid("password", errors.password)}${focused === "password" ? " autofocus" : ""}>${fieldError("password", errors.password)}` +
    (errors.form ? `<p class="error" role="alert">${escapeHtml(errors.form)}</p>` : "") +
    "<div class=\"acts\"><button type=\"submit\" class=\"btn primary wide\">Sign in</button></div></form>";
  // The agent's name comes with its sign-in request, which begins after this sign-in.
  return page(origin, {title: "Sign in to dohc", line: "<p class=\"lede\">Then choose what this agent can reach.</p>"},
    content, SELF_FORMS, state.status ?? 200);
}

// The browser's account doesn't own the workspace in the agent's address.
// Right after the relay began the request that is the only reason it can
// refuse; later the request may also have ended, which the relay doesn't
// tell apart.
function ownershipPage(origin: string, returnQuery: string, email: string, justBegun: boolean): Response {
  const message = justBegun
    ? `${email} does not own the workspace in this agent's link. Sign in as the workspace's owner to continue.`
    : `${email} does not own the workspace in this agent's link, or this sign-in request ended. ` +
      `Sign in as the workspace's owner, or ${START_AGAIN.charAt(0).toLowerCase()}${START_AGAIN.slice(1)}`;
  return page(origin, {title: "dohc could not sign in this agent"}, `<p class="msg">${escapeHtml(message)}</p>` +
    `<form method="post" action="${SIGN_OUT}">${hidden("return", returnQuery)}` +
    "<div class=\"acts\"><button type=\"submit\" class=\"btn primary wide\">Sign in as someone else</button></div></form>", SELF_FORMS, 403);
}

export interface PersonalSignInAccount {
  /** The origin the browser's account cookies belong to. Personal sign-in runs only there. */
  publicOrigin: string;
  /** share-web's account route: session, sign-in and sign-out. */
  handle(request: Request): Promise<Response>;
}

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
  /** The browser's account, which signs a personal agent in. Without it only share links sign in. */
  account?: PersonalSignInAccount;
}) {
  const newConsentSecret = options.newConsentSecret ?? (() => randomBytes(32).toString("base64url"));
  const clientIp = (request: Request) => request.headers.get("x-dohc-share-web-client-ip") ?? "unknown";

  async function relay(path: string, body: Record<string, unknown>, request: Request,
    extra: {cookie?: string; maxBytes?: number} = {}): Promise<RelayAnswer> {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)]);
    let answer: Response | undefined;
    try {
      answer = await options.fetchRelay(new Request(new URL(path, `${options.relayUrl.replace(/\/+$/u, "")}/`), {
        method: "POST", redirect: "manual", signal, body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "x-dohc-relay-exchange-key": options.exchangeKey ?? "",
          "x-dohc-relay-client-ip": clientIp(request),
          ...(extra.cookie ? {cookie: extra.cookie} : {}),
        },
      }));
      if (answer.status !== 200) {
        const refusal = asRecord(await readBoundedJson(answer, 4096, signal).catch(() => null));
        return {status: answer.status, value: null, code: typeof refusal?.code === "string" ? refusal.code : null};
      }
      const value = asRecord(await readBoundedJson(answer, extra.maxBytes ?? MAX_RELAY_ANSWER_BYTES, signal));
      return value?.ok === true ? {status: 200, value, code: null} : {status: 503, value: null, code: null};
    } catch {
      return {status: 503, value: null, code: null};
    } finally {
      await answer?.body?.cancel().catch(() => undefined);
    }
  }

  // Personal sign-in runs on the origin the account's cookies belong to.
  function personalAccount(origin: string): PersonalSignInAccount | null {
    return options.account && options.exchangeKey && options.account.publicOrigin === origin ? options.account : null;
  }

  function resourceMetadata(origin: string, pathname: string): Response {
    const resourcePath = pathname.slice(RESOURCE_METADATA.length);
    const named = mcpLinkSecret(resourcePath) !== null ||
      (mcpPersonalWorkspace(resourcePath) !== null && personalAccount(origin) !== null);
    if (!named) return oauthError(404, "invalid_request");
    return Response.json({resource: `${origin}${resourcePath}`, authorization_servers: [origin], bearer_methods_supported: ["header"]});
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
    // RFC 7591 section 3.2.2: a bad redirect URI has its own error.
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > AGENT_REDIRECT_URI_LIMIT) {
      return oauthError(400, "invalid_redirect_uri", `Send redirect_uris as a list of 1 to ${AGENT_REDIRECT_URI_LIMIT} URIs.`);
    }
    if (!redirectUris.every(isAgentRedirectUri)) {
      return oauthError(400, "invalid_redirect_uri", "Each redirect URI must use HTTPS, or HTTP to a loopback address, with no fragment or user name.");
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
    // The agent's details show the version as reported, so control characters go rather than refuse the agent.
    const softwareVersion = metadata.software_version;
    if (softwareVersion !== undefined && typeof softwareVersion !== "string") return invalid("software_version must be text.");
    const clientVersion = softwareVersion?.replace(new RegExp(CONTROL_CHARS, "gu"), "") ?? "";
    if (clientVersion.length > 100) return invalid("software_version must be at most 100 characters.");
    const answer = await relay("/sync/link/agent-clients", {
      registration: "registered", redirectUris, ...(clientName ? {clientName} : {}), ...(clientVersion ? {clientVersion} : {}),
    }, request);
    // The redirect URIs passed the relay's own rule above, so its refusal is the name.
    if (answer.status === 404) return invalid("client_name must be 1 to 100 characters without control characters.");
    if (!answer.value || typeof answer.value.clientId !== "string") return oauthError(503, "temporarily_unavailable");
    return Response.json({
      client_id: answer.value.clientId,
      client_id_issued_at: Math.floor(options.nowMs() / 1_000),
      redirect_uris: [...new Set(redirectUris)],
      ...(clientName ? {client_name: clientName} : {}),
      ...(clientVersion ? {software_version: clientVersion} : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, {status: 201});
  }

  // The relay checks the client, its redirect URI, the challenge, and the
  // address. Its refusal does not say which, so nothing redirects yet.
  function begin(request: Request, auth: AuthorizeRequest): Promise<RelayAnswer> {
    return relay("/sync/link/agent-authorizations", {
      clientId: auth.clientId, resource: auth.resource, redirectUri: auth.redirectUri, codeChallenge: auth.codeChallenge,
      codeChallengeMethod: "S256", ...(auth.state === null ? {} : {state: auth.state}),
    }, request);
  }

  async function authorize(request: Request, origin: string): Promise<Response> {
    const auth = authorizeRequest(new URL(request.url).searchParams, origin);
    if (typeof auth === "string") return errorPage(origin, `${auth} ${START_AGAIN}`);
    return auth.workspaceId === null ? authorizeLink(request, origin, auth) : authorizePersonal(request, origin, auth);
  }

  async function authorizeLink(request: Request, origin: string, auth: AuthorizeRequest): Promise<Response> {
    const {redirectUri, state} = auth;
    const begun = await begin(request, auth);
    if (begun.status === 429) return errorPage(origin, TOO_MANY_SIGN_INS, 429);
    if (begun.status === 404) {
      return errorPage(origin, `This share link has ended, or the agent's sign-in request does not match its registration. ${START_AGAIN}`);
    }
    const requestId = begun.value?.requestId;
    if (typeof requestId !== "string" || !AGENT_TOKEN.test(requestId)) return errorPage(origin, "dohc could not reach the share's server. Try again later.", 503);
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
      "<dl class=\"box\">" +
      `<div class="row"><dt>Share</dt><dd class="k">${escapeHtml(typeof value.subjectName === "string" ? value.subjectName : "Untitled share")}</dd></div>` +
      `<div class="row"><dt>Access</dt><dd class="k">${escapeHtml(ACCESS_LABELS[value.access] ?? value.access)}</dd></div>` +
      "</dl>" +
      `<form method="post" action="${DECISION}">${hidden("request", requestId)}${hidden("secret", secret)}` +
      actions(returnsTo(redirectUri),
        "<button type=\"submit\" name=\"decision\" value=\"cancel\" class=\"btn\">Cancel</button>" +
        "<button type=\"submit\" name=\"decision\" value=\"allow\" class=\"btn primary\">Allow</button>") +
      "</form>";
    const head: PageHead = {
      title: "Allow this agent to use the share link?", line: reportedLine(agentName), agent: {name: agentName, hue: null, known: false},
    };
    // A same-origin referrer makes the form's post carry this origin, which
    // the decision requires. The cross-origin redirect still carries none.
    return page(origin, head, content,
      {contentSecurityPolicy: signInPageCsp(consentFormAction(redirectUri)), referrerPolicy: "same-origin"}, 200, {
      "set-cookie": `${consentCookieName(requestId)}=${secret}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`,
    });
  }

  // The browser's account: its email, null when signed out, or unavailable.
  async function readAccount(request: Request, account: PersonalSignInAccount, cookie: string | null): Promise<{email: string} | null | "unavailable"> {
    if (cookie === null) return null;
    let answer: Response;
    try {
      answer = await account.handle(readsAccountEmail(new Request(new URL("/api/account/session", account.publicOrigin), {
        headers: {cookie, host: new URL(account.publicOrigin).host, "x-dohc-share-web-client-ip": clientIp(request)},
        signal: request.signal,
      })));
    } catch {
      return "unavailable";
    }
    const value = answer.status === 200 ? asRecord(await answer.json().catch(() => null)) : null;
    await answer.body?.cancel().catch(() => undefined);
    if (answer.status === 401 || answer.status === 404 || (value !== null && value.user === null)) return null;
    const user = asRecord(value?.user);
    return typeof user?.email === "string" && user.email.length > 0 ? {email: user.email} : "unavailable";
  }

  async function personalConsent(request: Request, cookie: string, requestId: string): Promise<ConsentRead> {
    const read = await relay("/sync/link/agent-authorizations/personal-consent", {requestId}, request,
      {cookie, maxBytes: MAX_PERSONAL_CONSENT_BYTES});
    if (read.status !== 200) return {ok: false, status: read.status, code: read.code};
    const consent = parsePersonalConsent(read.value);
    return consent ? {ok: true, consent} : {ok: false, status: 503, code: null};
  }

  function consentRefusal(origin: string, read: {status: number; code: string | null}, returnQuery: string, email: string, justBegun: boolean): Response {
    if (read.status === 401) return signInPage(origin, returnQuery);
    if (read.code === "sign_in_again") {
      return signInPage(origin, returnQuery, {notice: "This browser signed in before your password last changed. Sign in again."});
    }
    if (read.status === 404) return ownershipPage(origin, returnQuery, email, justBegun);
    if (read.status === 429) return errorPage(origin, TOO_MANY_SIGN_INS, 429);
    return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
  }

  // A personal request signs the browser in first, then begins at the relay,
  // so a signed-out view begins nothing.
  async function authorizePersonal(request: Request, origin: string, auth: AuthorizeRequest): Promise<Response> {
    const account = personalAccount(origin);
    if (!account) return errorPage(origin, NO_PERSONAL_SIGN_IN, 404);
    const returnQuery = authorizeQuery(auth);
    const cookie = namedAccountCookie(request.headers.get("cookie"), account.publicOrigin);
    const signedIn = await readAccount(request, account, cookie);
    if (signedIn === "unavailable") return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
    if (signedIn === null || cookie === null) return signInPage(origin, returnQuery);
    const begun = await begin(request, auth);
    if (begun.status === 429) return errorPage(origin, TOO_MANY_SIGN_INS, 429);
    if (begun.status === 404) {
      return errorPage(origin, `This agent's sign-in request does not match its registration, or this server does not sign agents in to that workspace. ${START_AGAIN}`);
    }
    const requestId = begun.value?.requestId;
    if (typeof requestId !== "string" || !AGENT_TOKEN.test(requestId)) return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
    const read = await personalConsent(request, cookie, requestId);
    if (!read.ok) return consentRefusal(origin, read, returnQuery, signedIn.email, true);
    const {consent} = read;
    if (consent.redirectUri !== auth.redirectUri) return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
    const secret = newConsentSecret();
    if (!CONSENT_SECRET.test(secret)) return redirectTo(auth.redirectUri, {error: "server_error", state: auth.state});
    const maxAge = Math.max(1, Math.ceil((consent.expiresAtMs - options.nowMs()) / 1_000));
    return consentPage(origin, {requestId, secret, returnQuery, email: signedIn.email, consent, as: "new", ...startingChoice(consent, "new"), errors: {}},
      200, {"set-cookie": `${consentCookieName(requestId)}=${secret}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`});
  }

  async function decide(request: Request, origin: string): Promise<Response> {
    if (request.headers.get("origin") !== origin) return errorPage(origin, `dohc accepts this choice only from its own consent page. ${START_AGAIN}`, 403);
    const form = await formParams(request);
    const requestId = form?.get("request") ?? "";
    const decision = form?.get("decision");
    if (!form || !AGENT_TOKEN.test(requestId) || (decision !== "allow" && decision !== "cancel")) {
      return errorPage(origin, `dohc could not read this choice. ${START_AGAIN}`);
    }
    const name = consentCookieName(requestId);
    const clear = {"set-cookie": `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`};
    const cookie = cookieValue(request.headers.get("cookie"), name);
    const secret = form.get("secret") ?? "";
    if (cookie === null || !CONSENT_SECRET.test(secret) || !sameSecret(cookie, secret)) {
      return errorPage(origin, `This choice did not come from the consent page this browser opened. ${START_AGAIN}`, 403);
    }
    const decided = await relay("/sync/link/agent-authorizations/decision", {requestId, decision}, request);
    const value = decided.value;
    if (!value || typeof value.redirectUri !== "string" || (value.state !== null && typeof value.state !== "string") ||
        (decision === "allow" && (typeof value.code !== "string" || !AGENT_TOKEN.test(value.code)))) {
      const refusal = decided.status === 404
        ? errorPage(origin, `This sign-in request expired or already has an answer. ${START_AGAIN}`)
        : errorPage(origin, "dohc could not reach the share's server. Try again later.", 503);
      refusal.headers.set("set-cookie", clear["set-cookie"]);
      return refusal;
    }
    const state = typeof value.state === "string" ? value.state : null;
    const answer = redirectTo(value.redirectUri, decision === "allow" ? {code: String(value.code), state} : {error: "access_denied", state});
    answer.headers.set("set-cookie", clear["set-cookie"]);
    return answer;
  }

  // The browser's account sign-in, through share-web's own account route.
  async function signIn(request: Request, origin: string, account: PersonalSignInAccount): Promise<Response> {
    if (request.headers.get("origin") !== origin) return errorPage(origin, `dohc accepts this sign-in only from its own page. ${START_AGAIN}`, 403);
    const form = await formParams(request, MAX_PERSONAL_FORM_BYTES);
    const returnQuery = personalReturn(form?.get("return"), origin);
    if (!form || returnQuery === null) return errorPage(origin, `dohc could not read this sign-in. ${START_AGAIN}`);
    const email = (form.get("email") ?? "").trim();
    const password = form.get("password") ?? "";
    if (!email) return signInPage(origin, returnQuery, {status: 400, errors: {email: "Enter your email address."}});
    if (!password) return signInPage(origin, returnQuery, {status: 400, email, errors: {password: "Enter your password."}});
    let answer: Response;
    try {
      answer = await account.handle(new Request(new URL("/api/account/sign-in", account.publicOrigin), {
        method: "POST", signal: request.signal, body: JSON.stringify({email, password}),
        headers: {
          host: new URL(account.publicOrigin).host, origin: account.publicOrigin, "content-type": "application/json",
          "x-dohc-share-web-client-ip": clientIp(request),
        },
      }));
    } catch {
      return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
    }
    const refusal = answer.status === 403 ? asRecord(await answer.json().catch(() => null)) : null;
    await answer.body?.cancel().catch(() => undefined);
    if (answer.status === 200) {
      const back = new Response(null, {status: 303, headers: {location: `${origin}${AUTHORIZE}?${returnQuery}`}});
      for (const line of answer.headers.getSetCookie()) back.headers.append("set-cookie", line);
      return back;
    }
    if (answer.status === 401) {
      return signInPage(origin, returnQuery, {status: 401, email,
        errors: {password: "dohc could not sign in with that email and password. Check both, then sign in again."}});
    }
    if (answer.status === 429) {
      return signInPage(origin, returnQuery, {status: 429, email, errors: {form: "Too many sign-in attempts. Try again in a few minutes."}});
    }
    if (refusal?.code === "EMAIL_NOT_VERIFIED") {
      return signInPage(origin, returnQuery, {status: 403, email, errors: {email: "Verify your email address, then sign in again."}});
    }
    return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
  }

  // "Not you?": signs the browser out, then returns to the sign-in request, which asks for an account again.
  async function signOut(request: Request, origin: string, account: PersonalSignInAccount): Promise<Response> {
    if (request.headers.get("origin") !== origin) return errorPage(origin, `dohc accepts this choice only from its own page. ${START_AGAIN}`, 403);
    const form = await formParams(request, MAX_PERSONAL_FORM_BYTES);
    const returnQuery = personalReturn(form?.get("return"), origin);
    if (!form || returnQuery === null) return errorPage(origin, `dohc could not read this choice. ${START_AGAIN}`);
    const back = new Response(null, {status: 303, headers: {location: `${origin}${AUTHORIZE}?${returnQuery}`}});
    const cookie = namedAccountCookie(request.headers.get("cookie"), account.publicOrigin);
    if (cookie === null) return back;
    let answer: Response;
    try {
      answer = await account.handle(new Request(new URL("/api/account/sign-out", account.publicOrigin), {
        method: "POST", signal: request.signal, body: "{}",
        headers: {
          host: new URL(account.publicOrigin).host, origin: account.publicOrigin, "content-type": "application/json",
          cookie, "x-dohc-share-web-client-ip": clientIp(request),
        },
      }));
    } catch {
      return errorPage(origin, "dohc could not sign this browser out. Try again shortly.", 503);
    }
    await answer.body?.cancel().catch(() => undefined);
    if (answer.status !== 200) return errorPage(origin, "dohc could not sign this browser out. Try again shortly.", 503);
    for (const line of answer.headers.getSetCookie()) back.headers.append("set-cookie", line);
    return back;
  }

  // The personal consent page's forms: Cancel, choosing who the agent is, and Allow.
  async function decidePersonal(request: Request, origin: string, account: PersonalSignInAccount): Promise<Response> {
    if (request.headers.get("origin") !== origin) return errorPage(origin, `dohc accepts this choice only from its own sign-in page. ${START_AGAIN}`, 403);
    const form = await formParams(request, MAX_PERSONAL_FORM_BYTES);
    const requestId = form?.get("request") ?? "";
    const decision = form?.get("decision");
    const returnQuery = personalReturn(form?.get("return"), origin);
    if (!form || !AGENT_TOKEN.test(requestId) || returnQuery === null ||
        (decision !== "allow" && decision !== "cancel" && decision !== "choose")) {
      return errorPage(origin, `dohc could not read this choice. ${START_AGAIN}`);
    }
    const cookieName = consentCookieName(requestId);
    const clear = `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
    const bound = cookieValue(request.headers.get("cookie"), cookieName);
    const secret = form.get("secret") ?? "";
    // The cookie lasts as long as the request, so without it the request expired.
    if (bound === null) return errorPage(origin, `This sign-in request expired. ${START_AGAIN}`, 403);
    if (!CONSENT_SECRET.test(secret) || !sameSecret(bound, secret)) {
      return errorPage(origin, `This choice did not come from the sign-in page this browser opened. ${START_AGAIN}`, 403);
    }
    const answered = (value: Record<string, unknown> | null): value is Record<string, unknown> & {redirectUri: string} =>
      value !== null && typeof value.redirectUri === "string" && (value.state === null || typeof value.state === "string");
    const finish = (value: Record<string, unknown> & {redirectUri: string}, values: Record<string, string | null>) => {
      const answer = redirectTo(value.redirectUri, {...values, state: typeof value.state === "string" ? value.state : null});
      answer.headers.set("set-cookie", clear);
      return answer;
    };
    if (decision === "cancel") {
      const cancelled = await relay("/sync/link/agent-authorizations/personal-decision", {requestId, decision: "cancel"}, request);
      if (answered(cancelled.value)) return finish(cancelled.value, {error: "access_denied"});
      if (cancelled.status !== 404) return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
      const refusal = errorPage(origin, `This sign-in request expired or already has an answer. ${START_AGAIN}`);
      refusal.headers.set("set-cookie", clear);
      return refusal;
    }
    const cookie = namedAccountCookie(request.headers.get("cookie"), account.publicOrigin);
    const signedIn = await readAccount(request, account, cookie);
    if (signedIn === "unavailable") return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
    if (signedIn === null || cookie === null) return signInPage(origin, returnQuery);
    const read = await personalConsent(request, cookie, requestId);
    if (!read.ok) return consentRefusal(origin, read, returnQuery, signedIn.email, false);
    const {consent} = read;
    const as = form.get("as") ?? "";
    const agent = consent.agents.find((entry) => entry.agentId === as) ?? null;
    if (as !== "new" && !agent) return errorPage(origin, `dohc could not read this choice. ${START_AGAIN}`);
    const base = {requestId, secret, returnQuery, email: signedIn.email, consent, as};
    if (decision === "choose") return consentPage(origin, {...base, ...startingChoice(consent, as), errors: {}});

    const listed = new Set(consent.workspaces.map((workspace) => workspace.workspaceId));
    const reach = new Map<string, PersonalLevel>();
    let listChanged = false;
    for (const [key, value] of form) {
      if (!key.startsWith("w:") || value === "none") continue;
      if (!isLevel(value) || !consent.levels.includes(value)) return errorPage(origin, `dohc could not read this choice. ${START_AGAIN}`);
      const workspaceId = key.slice("w:".length);
      if (listed.has(workspaceId)) reach.set(workspaceId, value);
      else listChanged = true;
    }
    const typedName = agent ? agent.name : form.get("name") ?? "";
    const named = agent ? null : nameChoice(typedName);
    const errors: ConsentErrors = {};
    if (named && !named.ok) errors.name = named.error;
    if (listChanged) errors.reach = "Your workspaces on this server changed. Check each one, then choose Allow again.";
    else if (reach.size === 0) errors.reach = "Choose at least one workspace.";
    else if (reach.size > PERSONAL_REACH_LIMIT) errors.reach = `Choose at most ${String(PERSONAL_REACH_LIMIT)} workspaces.`;
    const again = (status: number, shown: ConsentErrors) => consentPage(origin, {...base, name: typedName, reach, errors: shown}, status);
    if (Object.keys(errors).length > 0) return again(400, errors);

    const allowed = await relay("/sync/link/agent-authorizations/personal-decision", {
      requestId, decision: "allow",
      agent: agent ? {kind: "existing", agentId: agent.agentId} : {kind: "new", name: named && named.ok ? named.name : typedName},
      reach: [...reach].map(([workspaceId, level]) => ({workspaceId, level})),
    }, request, {cookie});
    const value = allowed.value;
    if (answered(value) && typeof value.code === "string" && AGENT_TOKEN.test(value.code)) return finish(value, {code: value.code});
    if (allowed.status === 401 || allowed.code === "sign_in_again") return consentRefusal(origin, allowed, returnQuery, signedIn.email, false);
    if (allowed.status === 429) return again(429, {form: TOO_MANY_SIGN_INS});
    if (allowed.status !== 404) return errorPage(origin, ACCOUNT_UNAVAILABLE, 503);
    // The relay doesn't say why. Read the request again: it may have ended, or the account lost a workspace.
    const reread = await personalConsent(request, cookie, requestId);
    if (!reread.ok) return consentRefusal(origin, reread, returnQuery, signedIn.email, false);
    return consentPage(origin, {...base, consent: reread.consent, name: typedName, reach, errors: {
      form: "dohc could not sign in this agent with these choices. Check that this account still owns each workspace, then choose Allow again.",
    }}, 409);
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
    // The relay issues a share link's tokens or a personal agent's by the resource, and binds them to it.
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
    const personalPage = pathname === SIGN_IN || pathname === SIGN_OUT || pathname === PERSONAL_DECISION;
    const isPage = pathname === AUTHORIZE || pathname === DECISION || personalPage;
    if (pathname.startsWith(`${RESOURCE_METADATA}${MCP_PATH_PREFIX}`) || pathname.startsWith(`${RESOURCE_METADATA}${PERSONAL_MCP_PATH_PREFIX}`)) {
      return request.method === "GET" && !search ? resourceMetadata(origin, pathname) : oauthError(405, "invalid_request");
    }
    if (pathname === AUTHORIZATION_SERVER_METADATA) {
      return request.method === "GET" && !search ? authorizationServerMetadata(origin) : oauthError(405, "invalid_request");
    }
    if (!isPage && pathname !== REGISTER && pathname !== TOKEN) return null;
    if (!options.exchangeKey) return isPage ? errorPage(origin, "This server does not offer agent sign-in.", 404) : oauthError(404, "invalid_request");
    if (!options.admit(clientIp(request))) {
      return isPage
        ? errorPage(origin, TOO_MANY_SIGN_INS, 429)
        : oauthError(429, "temporarily_unavailable", "Too many requests. Try again in a few minutes.", {"cache-control": "no-store", "retry-after": "60"});
    }
    if (pathname === AUTHORIZE) return request.method === "GET" ? authorize(request, origin) : errorPage(origin, `Open the sign-in link in a browser. ${START_AGAIN}`, 405);
    if (request.method !== "POST" || search) {
      return isPage ? errorPage(origin, `dohc could not read this choice. ${START_AGAIN}`, 405) : oauthError(405, "invalid_request");
    }
    if (pathname === REGISTER) return register(request);
    if (pathname === DECISION) return decide(request, origin);
    if (personalPage) {
      const account = personalAccount(origin);
      if (!account) return errorPage(origin, NO_PERSONAL_SIGN_IN, 404);
      if (pathname === SIGN_IN) return signIn(request, origin, account);
      if (pathname === SIGN_OUT) return signOut(request, origin, account);
      return decidePersonal(request, origin, account);
    }
    return token(request);
  }

  /** Whether personal agents sign in on this origin. */
  function offersPersonal(origin: string): boolean {
    return personalAccount(origin) !== null;
  }

  return {handle, offersPersonal};
}
