import type { EmailMessage } from "@dohc/workspace-auth/smtp";
import { ACCOUNT_CSS, ACCOUNT_CSS_PATH, ACCOUNT_JS, ACCOUNT_JS_PATH } from "./assets";
import type { EmailTransport, ServerDescriptor } from "./config";
import {
  accountPage,
  devicePage,
  forgotPasswordPage,
  notFoundPage,
  resetPasswordPage,
  signInPage,
  signUpPage,
  verifyEmailPage,
} from "./pages";
import type { ReadinessReport } from "./readiness";

// Every route this service answers. main.ts owns the process (env, Postgres,
// sockets); this module owns request handling so the routes can be tested
// against a fake auth gateway.

/** The slice of Better Auth the routes use. main.ts adapts the real instance. */
export interface AuthGateway {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { name: string; email: string; emailVerified: boolean } } | null>;
    deviceVerify(input: {
      query: { user_code: string };
      headers: Headers;
    }): Promise<{ status?: string | null }>;
  };
}

export interface RouterOptions {
  auth: AuthGateway;
  readiness: () => Promise<ReadinessReport>;
  descriptor: ServerDescriptor;
  emailTransport: EmailTransport;
  /** Origins answered with CORS headers; everything else gets none. */
  allowedOrigins: string[];
  /** Development and test only. main.ts decides whether these exist. */
  seams?: {
    deviceApprove?: (request: Request) => Promise<Response>;
    sentEmails?: () => EmailMessage[];
  };
}

/** Routes that make Better Auth send mail, and so need a transport. */
const EMAIL_ROUTES = new Set([
  "/api/auth/sign-up/email",
  "/api/auth/request-password-reset",
  "/api/auth/forget-password",
  "/api/auth/send-verification-email",
]);

const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function createRouter(options: RouterOptions): (request: Request) => Promise<Response> {
  const allowed = new Set(options.allowedOrigins);

  return async function handle(request: Request): Promise<Response> {
    try {
      return await route(request);
    } catch {
      // Never the URL: a verification or reset link in a log is a live credential.
      console.error(`[workspace-api] ${request.method} request failed.`);
      return json({ ok: false, error: "internal error" }, 500);
    }
  };

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request.headers.get("origin"), allowed);

    if (request.method === "OPTIONS" && path.startsWith("/api/auth/")) {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path.startsWith("/api/auth/")) {
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin !== null && !allowed.has(requestOrigin)) {
        return json({ code: "INVALID_ORIGIN", message: "This origin is not allowed." }, 403, cors);
      }
      if (options.emailTransport === "none" && EMAIL_ROUTES.has(path) && request.method === "POST") {
        return json(
          {
            code: "EMAIL_DELIVERY_UNCONFIGURED",
            message:
              "This server cannot send email yet. Contact the server owner.",
          },
          503,
          cors,
        );
      }
      const response = await options.auth.handler(request);
      response.headers.set("cache-control", "no-store");
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
      return response;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      switch (path) {
        case "/health":
          return json({ ok: true, service: "workspace-api" });
        case "/ready":
          return readyResponse(await options.readiness());
        case "/.well-known/dohc-server":
          return descriptorResponse(options.descriptor, cors);
        case ACCOUNT_CSS_PATH:
          return asset(ACCOUNT_CSS, "text/css; charset=utf-8");
        case ACCOUNT_JS_PATH:
          return asset(ACCOUNT_JS, "text/javascript; charset=utf-8");
        case "/":
          return redirect("/account");
        case "/account/sign-in":
          return page(signInPage({ next: samePath(url.searchParams.get("next")) ?? undefined }));
        case "/account/sign-up":
          return page(signUpPage({ next: samePath(url.searchParams.get("next")) ?? undefined }));
        case "/account/forgot-password":
          return page(forgotPasswordPage());
        case "/account/reset-password":
          return page(resetPasswordPage({ token: url.searchParams.get("token") ?? undefined }));
        case "/account/verify-email": {
          const session = await options.auth.api.getSession({ headers: request.headers });
          return page(
            verifyEmailPage({
              token: url.searchParams.get("token") ?? undefined,
              email: session?.user.email,
              next: samePath(url.searchParams.get("next")) ?? undefined,
            }),
          );
        }
        case "/device":
          return devicePageFor(options.auth, request, url);
        case "/account": {
          const session = await options.auth.api.getSession({ headers: request.headers });
          if (!session) return redirect("/account/sign-in?next=%2Faccount");
          return page(accountPage(session.user));
        }
      }
      if (options.seams?.sentEmails && path === "/test/email/messages") {
        return json({ messages: options.seams.sentEmails() });
      }
    }

    if (request.method === "POST" && path === "/test/device/approve" && options.seams?.deviceApprove) {
      return options.seams.deviceApprove(request);
    }

    if (path.startsWith("/test/") || path.startsWith("/api/")) {
      return json({ ok: false, error: "route not found" }, 404);
    }
    return page(notFoundPage(), 404);
  }
}

// The device page claims the code server-side: a person must be signed in, and
// GET /api/auth/device binds the code to their session before the browser may
// approve it. The page never sees a device code or a token, only the short
// user code the person is already reading off their device.
async function devicePageFor(auth: AuthGateway, request: Request, url: URL): Promise<Response> {
  const userCode = (url.searchParams.get("user_code") ?? "").trim();
  if (!userCode) return page(devicePage({ kind: "prompt" }));

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return redirect(`/account/sign-in?next=${encodeURIComponent(`/device?user_code=${encodeURIComponent(userCode)}`)}`);
  }

  let status: string | null | undefined;
  try {
    ({ status } = await auth.api.deviceVerify({ query: { user_code: userCode }, headers: request.headers }));
  } catch (error) {
    const kind = deviceErrorKind(error);
    if (!kind) throw error;
    return page(devicePage({ kind }), 400);
  }
  if (status !== "pending") {
    return page(devicePage({ kind: "handled", status: status ?? "unknown" }));
  }
  return page(devicePage({ kind: "review", userCode, email: session.user.email }));
}

function deviceErrorKind(error: unknown): "expired" | "invalid" | null {
  const body = (error as { body?: { error?: unknown } } | null)?.body;
  const code = body && typeof body.error === "string" ? body.error : null;
  if (code === "expired_token") return "expired";
  if (code === "invalid_request") return "invalid";
  return null;
}

function readyResponse(report: ReadinessReport): Response {
  return json(report, report.ok ? 200 : 503);
}

// The descriptor tells a desktop where this self-host's three origins are. It
// answers with all three or none: a half-filled descriptor would send clients
// at origins the operator never configured.
function descriptorResponse(descriptor: ServerDescriptor, cors: Record<string, string>): Response {
  const missing = [
    descriptor.relayUrl ? null : "DOHC_SERVER_RELAY_URL",
    descriptor.shareUrl ? null : "DOHC_WEB_ORIGIN",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    return json(
      {
        code: "SERVER_DESCRIPTOR_INCOMPLETE",
        message: `This dohc server has no ${missing.join(" and ")}. Set ${missing.length > 1 ? "them" : "it"} to an absolute http(s) origin and restart.`,
      },
      503,
      cors,
    );
  }
  return json(
    {
      version: 1,
      authUrl: descriptor.authUrl,
      relayUrl: descriptor.relayUrl,
      shareUrl: descriptor.shareUrl,
      ...(descriptor.name ? { name: descriptor.name } : {}),
      ...(descriptor.networkAccess ? { networkAccess: descriptor.networkAccess } : {}),
    },
    200,
    cors,
  );
}

function corsHeaders(origin: string | null, allowed: Set<string>): Record<string, string> {
  if (!origin || !allowed.has(origin)) return { vary: "Origin" };
  return {
    vary: "Origin",
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "600",
  };
}

// Only a path on this origin is a safe post-sign-in destination. `//host` and
// `/\host` both leave this origin once a browser resolves them.
function samePath(value: string | null): string | null {
  return value === "/account" || (value !== null && /^\/device\?user_code=[A-Za-z0-9%_-]+$/.test(value)) ? value : null;
}

function page(body: string, status = 200): Response {
  return new Response(body, { status, headers: PAGE_HEADERS });
}

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}
