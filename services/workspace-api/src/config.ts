import { smtpSettingsFromEnv, SmtpConfigError, isLoopback, type SmtpSettings } from "@dohc/workspace-auth/smtp";
import { trustedAuthProxies } from "./clientAddress";

// Every environment variable this service reads, validated in one place. A
// misconfigured self-host stops at startup with the variable named, instead of
// discovering the problem when a person cannot receive a password reset.

/** The operator's configuration cannot run; the server must not start. */
export class ConfigError extends Error {}

export interface ServerDescriptor {
  name?: string;
  networkAccess?: "private" | "public";
  /** The auth origin: WORKSPACE_API_BASE_URL. */
  authUrl: string;
  /** The sync relay origin: DOHC_SERVER_RELAY_URL. */
  relayUrl: string | null;
  /** The share origin: DOHC_WEB_ORIGIN. */
  shareUrl: string | null;
}

export type EmailTransport = "smtp" | "capture" | "none";

export interface WorkspaceApiConfig {
  port: number;
  /** Loopback whenever a test seam is on, so a seam is never reachable off-host. */
  bindHost: string;
  baseURL: string;
  secret: string;
  postgresUrl: string;
  /** Origins Better Auth accepts browser auth from. */
  trustedOrigins: string[];
  /** Origins answered with CORS headers. */
  allowedOrigins: string[];
  descriptor: ServerDescriptor;
  smtp: SmtpSettings | null;
  emailTransport: EmailTransport;
  /** Proxy addresses whose X-Forwarded-For this server may believe. */
  trustedProxies: Set<string>;
  /** The device-approval impersonation seam (development and test only). */
  testAuthSeam: boolean;
}

const DEFAULT_PORT = 1786;
const DEFAULT_POSTGRES_URL = "postgres://dohc:dohc@localhost:54329/dohc";
const DEV_SEAM_SECRET = "dev-test-only-secret-0123456789abcdef";

export function readConfig(env: NodeJS.ProcessEnv): WorkspaceApiConfig {
  const nodeEnv = env.NODE_ENV;
  const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";

  // The /test/device/approve impersonation seam is fail-CLOSED: it requires an
  // explicit dev/test signal, never merely "not production". An operator who
  // copies a dev .env (DOHC_TEST_AUTH=1) into a real deployment must crash the
  // server, not silently expose a full-impersonation endpoint with a
  // source-visible secret.
  const testAuthSeam = env.DOHC_TEST_AUTH === "1" && isDevOrTest;
  if (env.DOHC_TEST_AUTH === "1" && !isDevOrTest) {
    throw new ConfigError(
      `DOHC_TEST_AUTH=1 requires NODE_ENV=development or test, got NODE_ENV=${nodeEnv ?? "(unset)"}. ` +
        "This is a dangerous impersonation seam — refusing to start.",
    );
  }

  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (!testAuthSeam && secret.length < 32) {
    throw new ConfigError(
      "BETTER_AUTH_SECRET must be set (>=32 chars) — generate one with `openssl rand -base64 32`.",
    );
  }

  const port = readPort(env.WORKSPACE_API_PORT);
  const baseURL = env.WORKSPACE_API_BASE_URL
    ? readOrigin(env.WORKSPACE_API_BASE_URL, "WORKSPACE_API_BASE_URL")
    : `http://localhost:${port}`;
  const shareUrl = env.DOHC_WEB_ORIGIN ? readOrigin(env.DOHC_WEB_ORIGIN, "DOHC_WEB_ORIGIN") : null;
  const relayUrl = env.DOHC_SERVER_RELAY_URL
    ? readOrigin(env.DOHC_SERVER_RELAY_URL, "DOHC_SERVER_RELAY_URL")
    : null;
  if ((relayUrl !== null && relayUrl !== baseURL) || (shareUrl !== null && shareUrl !== baseURL)) {
    throw new ConfigError("WORKSPACE_API_BASE_URL, DOHC_SERVER_RELAY_URL, and DOHC_WEB_ORIGIN must use one public origin.");
  }

  const name = env.DOHC_SERVER_NAME?.trim();
  if (name && (name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))) throw new ConfigError("DOHC_SERVER_NAME must be at most 100 characters without control characters.");
  const networkAccess = env.DOHC_SERVER_NETWORK_ACCESS;
  if (networkAccess && networkAccess !== "private" && networkAccess !== "public") throw new ConfigError("DOHC_SERVER_NETWORK_ACCESS must be private or public.");

  let smtp: SmtpSettings | null;
  try {
    smtp = smtpSettingsFromEnv(env);
  } catch (error) {
    throw new ConfigError(error instanceof SmtpConfigError ? error.message : String(error));
  }

  // Outside NODE_ENV=test there is no substitute for a real transport: a
  // server with no SMTP refuses the routes that would send mail.
  const emailTransport: EmailTransport = smtp ? "smtp" : nodeEnv === "test" ? "capture" : "none";
  const seamActive = testAuthSeam || emailTransport === "capture";

  return {
    port,
    bindHost: seamActive ? "127.0.0.1" : "0.0.0.0",
    baseURL,
    secret: secret.length >= 32 ? secret : DEV_SEAM_SECRET,
    postgresUrl: env.POSTGRES_URL ?? DEFAULT_POSTGRES_URL,
    trustedOrigins: shareUrl ? [shareUrl] : [],
    allowedOrigins: [...new Set([baseURL, ...(shareUrl ? [shareUrl] : [])])],
    descriptor: { authUrl: baseURL, relayUrl, shareUrl, ...(name ? { name } : {}), ...(networkAccess === "private" || networkAccess === "public" ? { networkAccess } : {}) },
    smtp,
    emailTransport,
    trustedProxies: readTrustedProxies(env.DOHC_AUTH_TRUSTED_PROXIES),
    testAuthSeam,
  };
}

function readTrustedProxies(value: string | undefined): Set<string> {
  try {
    return trustedAuthProxies(value);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`WORKSPACE_API_PORT must be a port number from 1 to 65535, got "${value}".`);
  }
  return port;
}

/** An absolute http(s) origin: scheme and host only, no path, no credentials. */
function readOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) origin, got "${value}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https, got "${value}".`);
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new ConfigError(`${name} must be an origin with no path or credentials, got "${value}".`);
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) throw new ConfigError(`${name} must use HTTPS unless it is loopback.`);
  return url.origin;
}
