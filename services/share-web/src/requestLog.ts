import { COLLECTION_WRITES_PATH } from "./collectionWrites";
import { MCP_ROUTE_PATTERNS } from "./mcpSignIn";
import { ACCOUNT_DELETION_PATH } from "@dohc/security-contract/account-deletion";
import { createRequestLog } from "@dohc/service-http";

/**
 * Every pattern share-web's request log can write. A share link's secret
 * follows /s/ or /mcp/s/, and a viewer's session rides in the query, so
 * neither path nor query is ever written. An app host's paths are its
 * author's, so every app request is the one word `app`.
 */
export const SHARE_WEB_REQUEST_LOG = createRequestLog("share-web", [
  ACCOUNT_DELETION_PATH, "app", "/api/apps/launch", "/api/apps/summary", "/api/mcp", ...MCP_ROUTE_PATTERNS, "/api/apps",
  "/api/live/link-document", "/api/live/link-ticket", "/api/live/named-session", "/api/live/named-ticket", "/api/live/named-documents",
  "/api/named-chat/*", "/api/push/*", "/api/account/*", "/api/members/join-preview", "/api/members/join", "/join", "/s", "/s/", "/s/assets/*", "/s/*", "/l", "/l/*",
  "/api/exchange", "/api/handoff", COLLECTION_WRITES_PATH, "/api/view/chat/channels", "/api/view/chat/messages",
  "/api/view/discussion", "/api/view/discussion/activity", "/api/view/meta", "/api/view/current", "/api/view/log", "/api/view/blob/:sha256",
]);
