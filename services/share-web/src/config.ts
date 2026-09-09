import { canonicalRelayUrl } from "@dohc/workspace-contracts/relay-values";
import type { AccountAuthConfig } from "./accountAuth";
import { parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits } from "./namedLiveBrowserClient";
import {parseLiveGatewayLimits, type LiveGatewayLimits} from "./liveGateway";
import {parseNamedLiveBrowserLimits, type NamedLiveBrowserLimits} from "../viewer/src/namedLiveBrowserTransport";

export interface ShareWebConfig {
  relayUrl: string;
  publicRelayUrl: string;
  relayExchangeKey?: string;
  publicHosts: Set<string>;
  trustedProxies: Set<string>;
  port: number;
  bind: string;
  devMode: boolean;
  accountAuth?: AccountAuthConfig;
  namedBrowserSessionLimits?: NamedLiveBrowserClientLimits;
  namedLiveGatewayLimits?: LiveGatewayLimits;
  namedRecipientBrowserLimits?: NamedLiveBrowserLimits;
  linkLive?: {publicOrigin: string; gateway: LiveGatewayLimits; requests: NamedLiveBrowserClientLimits; editor: NamedLiveBrowserLimits};
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function exactList(value: string, errorMessage: string): string[] {
  const entries = value.split(",");
  if (entries.some((entry) => entry.length === 0 || entry !== entry.trim())) {
    throw new Error(errorMessage);
  }
  return entries;
}

export function loadShareWebConfig(env: NodeJS.ProcessEnv): ShareWebConfig {
  const relayValue = required(env, "DOHC_SHARE_WEB_RELAY_URL");
  let relayUrl: URL;
  try {
    relayUrl = new URL(relayValue);
  } catch {
    throw new Error("DOHC_SHARE_WEB_RELAY_URL must be an absolute HTTP or HTTPS URL.");
  }
  if (
    (relayUrl.protocol !== "http:" && relayUrl.protocol !== "https:") ||
    relayUrl.username ||
    relayUrl.password
  ) {
    throw new Error("DOHC_SHARE_WEB_RELAY_URL must be an absolute HTTP or HTTPS URL without credentials.");
  }

  const publicRelayUrl = canonicalRelayUrl(
    required(env, "DOHC_SHARE_WEB_PUBLIC_RELAY_URL"),
  );
  if (publicRelayUrl === null) {
    throw new Error(
      "DOHC_SHARE_WEB_PUBLIC_RELAY_URL must be an absolute HTTP or HTTPS URL of at most 2048 characters without credentials, query, or fragment.",
    );
  }

  const hostValue = required(env, "DOHC_SHARE_WEB_PUBLIC_HOSTS");
  const hosts = exactList(
    hostValue,
    "DOHC_SHARE_WEB_PUBLIC_HOSTS must contain exact comma-separated Host values.",
  ).map((host) => host.toLowerCase());
  const trustedProxyValue = env.DOHC_SHARE_WEB_TRUSTED_PROXIES;
  const trustedProxies = new Set(
    trustedProxyValue === undefined || trustedProxyValue === ""
      ? []
      : exactList(
          trustedProxyValue,
          "DOHC_SHARE_WEB_TRUSTED_PROXIES must contain exact comma-separated peer addresses.",
        ),
  );

  const portValue = env.DOHC_SHARE_WEB_PORT ?? "1790";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`DOHC_SHARE_WEB_PORT must be an integer in 0-65535, got "${portValue}".`);
  }

  const nodeEnv = env.NODE_ENV;
  const isDevOrTest = nodeEnv === "development" || nodeEnv === "test";
  const relayExchangeKey = env.DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY || undefined;
  if (relayExchangeKey !== undefined && relayExchangeKey.length < 32) {
    throw new Error(
      "DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY must be at least 32 characters.",
    );
  }
  if (!isDevOrTest && relayExchangeKey === undefined) {
    throw new Error(
      "DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY must be set outside development/test.",
    );
  }
  const devMode = env.DOHC_SHARE_WEB_DEV === "1";
  if (devMode && nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("DOHC_SHARE_WEB_DEV=1 requires NODE_ENV=development or test.");
  }

  let accountAuth: AccountAuthConfig | undefined;
  const authUpstream = env.DOHC_SHARE_WEB_AUTH_URL;
  if (authUpstream !== undefined) {
    const publicOrigin = required(env, "DOHC_SHARE_WEB_PUBLIC_ORIGIN");
    let origin: URL;
    let upstream: URL;
    try {
      origin = new URL(publicOrigin);
      upstream = new URL(authUpstream);
    } catch {
      throw new Error("Account authentication requires valid public and upstream URLs.");
    }
    if (origin.protocol !== "https:" || publicOrigin !== origin.origin ||
        !hosts.includes(origin.host)) {
      throw new Error("DOHC_SHARE_WEB_PUBLIC_ORIGIN must be a canonical HTTPS origin with an exact configured public Host.");
    }
    if ((upstream.protocol !== "http:" && upstream.protocol !== "https:") ||
        upstream.username || upstream.password || upstream.pathname !== "/" ||
        upstream.search || upstream.hash) {
      throw new Error("DOHC_SHARE_WEB_AUTH_URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment.");
    }
    accountAuth = { upstreamUrl: upstream.origin, publicOrigin };
  }

  let namedBrowserSessionLimits: NamedLiveBrowserClientLimits | undefined;
  if (env.DOHC_SHARE_WEB_NAMED_BROWSER_SESSION_LIMITS !== undefined) {
    if (!accountAuth || !relayExchangeKey) throw new Error("Named browser sessions require account auth and relay exchange configuration.");
    namedBrowserSessionLimits = parseNamedLiveBrowserClientLimits(JSON.parse(env.DOHC_SHARE_WEB_NAMED_BROWSER_SESSION_LIMITS));
  }

  let namedLiveGatewayLimits: LiveGatewayLimits | undefined;
  if (env.DOHC_SHARE_WEB_NAMED_LIVE_LIMITS !== undefined) {
    if (!namedBrowserSessionLimits || !accountAuth || !relayExchangeKey) throw new Error("Named live transport requires named browser sessions and relay exchange configuration.");
    namedLiveGatewayLimits = parseLiveGatewayLimits(JSON.parse(env.DOHC_SHARE_WEB_NAMED_LIVE_LIMITS));
  }
  let namedRecipientBrowserLimits: NamedLiveBrowserLimits | undefined;
  if (env.DOHC_SHARE_WEB_NAMED_EDITOR_LIMITS !== undefined) {
    if (!namedLiveGatewayLimits) throw new Error("Named browser editing requires the named live gateway.");
    namedRecipientBrowserLimits = parseNamedLiveBrowserLimits(JSON.parse(env.DOHC_SHARE_WEB_NAMED_EDITOR_LIMITS));
    if (namedRecipientBrowserLimits.provider.frames.receive.maxFrameBytes > namedLiveGatewayLimits.maxFrameBytes) {
      throw new Error("Named browser frames exceed gateway capacity.");
    }
  }

  let linkLive: ShareWebConfig["linkLive"];
  if (env.DOHC_SHARE_WEB_LINK_LIVE_LIMITS !== undefined) {
    const publicOrigin = required(env, "DOHC_SHARE_WEB_PUBLIC_ORIGIN"), origin = new URL(publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== publicOrigin || !hosts.includes(origin.host) || !relayExchangeKey) throw new Error("Link live editing requires an exact HTTPS public origin and relay exchange configuration.");
    const value: unknown = JSON.parse(env.DOHC_SHARE_WEB_LINK_LIVE_LIMITS);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "editor,gateway,requests") throw new Error("Invalid link live limits.");
    const fields = value as Record<string, unknown>;
    linkLive = {publicOrigin, gateway: parseLiveGatewayLimits(fields.gateway), requests: parseNamedLiveBrowserClientLimits(fields.requests), editor: parseNamedLiveBrowserLimits(fields.editor)};
    if (linkLive.editor.provider.frames.receive.maxFrameBytes > linkLive.gateway.maxFrameBytes) throw new Error("Link browser frames exceed gateway capacity.");
  }

  return {
    relayUrl: relayUrl.href,
    publicRelayUrl,
    relayExchangeKey,
    publicHosts: new Set(hosts),
    trustedProxies,
    port,
    bind: env.DOHC_SHARE_WEB_BIND ?? (devMode ? "127.0.0.1" : "0.0.0.0"),
    devMode,
    ...(accountAuth ? { accountAuth } : {}),
    ...(namedBrowserSessionLimits ? { namedBrowserSessionLimits } : {}),
    ...(namedLiveGatewayLimits ? {namedLiveGatewayLimits} : {}),
    ...(namedRecipientBrowserLimits ? {namedRecipientBrowserLimits} : {}),
    ...(linkLive ? {linkLive} : {}),
  };
}
