import {
  checkApiVersion, SHARE_WEB_API_VERSION, SHARE_WEB_API_VERSION_HEADER, type ApiVersionRange,
} from "@dohc/workspace-contracts/relay-values";
import { SHARE_WEB_SECURITY_HEADERS } from "./securityHeaders";

export const SHARE_WEB_API_VERSIONS: ApiVersionRange = Object.freeze({min: 1, max: SHARE_WEB_API_VERSION});

const METHODS: Readonly<Record<string, readonly string[]>> = {
  "/api/exchange": ["POST"], "/api/handoff": ["POST"],
  "/api/view/meta": ["GET"], "/api/view/current": ["GET"], "/api/view/log": ["GET"],
  "/api/view/discussion": ["GET", "POST"], "/api/view/discussion/activity": ["GET"],
  "/api/view/collection-writes": ["POST"], "/api/view/chat/channels": ["GET"], "/api/view/chat/messages": ["GET", "POST"],
  "/api/account/session": ["GET"], "/api/account/sign-in": ["POST"], "/api/account/sign-out": ["POST"],
  "/api/live/link-document": ["POST"], "/api/live/link-ticket": ["POST"],
  "/api/live/named-session": ["POST"], "/api/live/named-ticket": ["POST"], "/api/live/named-documents": ["POST"],
  "/api/apps": ["GET"], "/api/apps/launch": ["POST"], "/api/apps/summary": ["POST"],
  "/api/mcp/exchange": ["POST"], "/mcp": ["GET", "POST", "DELETE"],
};

export function mcpApiVersions(versions: ApiVersionRange): ApiVersionRange {
  // Retiring headerless MCP v1 requires a separate product decision.
  return {min: 1, max: versions.max};
}

export function shareWebApiVersionRefusal(request: Request, versions: ApiVersionRange): Response | null {
  const path = new URL(request.url).pathname;
  if (!Object.hasOwn(METHODS, path) || !METHODS[path]!.includes(request.method)) return null;
  const range = path === "/mcp" || path === "/api/mcp/exchange" ? mcpApiVersions(versions) : versions;
  const check = checkApiVersion(request.headers.get(SHARE_WEB_API_VERSION_HEADER), range);
  if (check === "accepted") return null;
  const code = check === "malformed" ? "bad_request" : check === "too_old" ? "api_version_too_old" : "api_version_too_new";
  return Response.json({ok: false, code, api: "share-web", apiVersions: range, discovery: "/api/mcp",
    error: check === "malformed" ? "Invalid share-web API version header." : "Unsupported share-web API version.",
  }, {status: check === "malformed" ? 400 : 409, headers: SHARE_WEB_SECURITY_HEADERS});
}
