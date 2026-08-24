export interface ShareWebConfig {
  relayUrl: string;
  publicHosts: Set<string>;
  port: number;
  bind: string;
  devMode: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
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
  const hosts = hostValue.split(",");
  if (hosts.some((host) => host.length === 0 || host !== host.trim())) {
    throw new Error("DOHC_SHARE_WEB_PUBLIC_HOSTS must contain exact comma-separated Host values.");
  }

  const portValue = env.DOHC_SHARE_WEB_PORT ?? "1790";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`DOHC_SHARE_WEB_PORT must be an integer in 0-65535, got "${portValue}".`);
  }

  const nodeEnv = env.NODE_ENV;
  const devMode = env.DOHC_SHARE_WEB_DEV === "1";
  if (devMode && nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("DOHC_SHARE_WEB_DEV=1 requires NODE_ENV=development or test.");
  }

  return {
    relayUrl: relayUrl.href,
    publicHosts: new Set(hosts),
    port,
    bind: env.DOHC_SHARE_WEB_BIND ?? (devMode ? "127.0.0.1" : "0.0.0.0"),
    devMode,
  };
}
