import { createRequestLog } from "@dohc/service-http";
import { CRASH_REPORT_PATH } from "./crashReports";

// The sign-in endpoints a dohc client calls, each a fixed path. Any other
// path under /api/auth/, such as one carrying a reset token, logs as its prefix.
const AUTH_PATTERNS = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/sign-out",
  "/api/auth/get-session",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/auth/send-verification-email",
  "/api/auth/verify-email",
  "/api/auth/device",
  "/api/auth/device/code",
  "/api/auth/device/token",
  "/api/auth/device/approve",
  "/api/auth/device/deny",
  "/api/auth/account/deletion-preview",
  "/api/auth/account/delete",
] as const;
const AUTH_ROUTES: ReadonlySet<string> = new Set(AUTH_PATTERNS);

/** The pages and probes the router answers to GET, by their path. */
export const PAGE_PATTERNS = [
  "/health",
  "/ready",
  "/.well-known/dohc-server",
  "/",
  "/account",
  "/account/sign-in",
  "/account/sign-up",
  "/account/forgot-password",
  "/account/reset-password",
  "/account/verify-email",
  "/device",
] as const;

export const WORKSPACE_API_REQUEST_LOG = createRequestLog("workspace-api", [
  ...AUTH_PATTERNS,
  "/api/auth/*",
  ...PAGE_PATTERNS,
  "/account/assets/:asset",
  CRASH_REPORT_PATH,
  "/test/email/messages",
  "/test/device/approve",
]);

/** The pattern a path under /api/auth/ logs as. */
export function authPattern(path: string): (typeof AUTH_PATTERNS)[number] | "/api/auth/*" {
  return AUTH_ROUTES.has(path) ? path as (typeof AUTH_PATTERNS)[number] : "/api/auth/*";
}
