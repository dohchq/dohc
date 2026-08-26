export interface ShareWebConfig {
  relayUrl: string;
  relayExchangeKey?: string;
  publicHosts: Set<string>;
  trustedProxies: Set<string>;
  port: number;
  bind: string;
  devMode: boolean;
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

  const hostValue = required(env, "DOHC_SHARE_WEB_PUBLIC_HOSTS");
  const hosts = exactList(
    hostValue,
    "DOHC_SHARE_WEB_PUBLIC_HOSTS must contain exact comma-separated Host values.",
  );
  const trustedProxyValue = env.DOHC_SHARE_WEB_TRUSTED_PROXIES;
  const trustedProxies = new Set(
    trustedProxyValue === undefined
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
  if (!isDevOrTest && relayExchangeKey === undefined) {
    throw new Error(
      "DOHC_SHARE_WEB_RELAY_EXCHANGE_KEY must be set outside development/test.",
    );
  }
  const devMode = env.DOHC_SHARE_WEB_DEV === "1";
  if (devMode && nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("DOHC_SHARE_WEB_DEV=1 requires NODE_ENV=development or test.");
  }

  return {
    relayUrl: relayUrl.href,
    relayExchangeKey,
    publicHosts: new Set(hosts),
    trustedProxies,
    port,
    bind: env.DOHC_SHARE_WEB_BIND ?? (devMode ? "127.0.0.1" : "0.0.0.0"),
    devMode,
  };
}
