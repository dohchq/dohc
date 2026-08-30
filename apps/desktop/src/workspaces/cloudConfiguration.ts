const MAX_CLOUD_ORIGIN_LENGTH = 2048;

export const MANAGED_CLOUD_SERVER_ENV = "DOHC_CLOUD_URL";
export const MANAGED_CLOUD_RELAY_ENV = "DOHC_CLOUD_RELAY_URL";

export type ManagedCloudConfiguration =
  | { status: "ready"; serverUrl: string; relayUrl: string }
  | { status: "unconfigured" }
  | { status: "invalid" };

export function canonicalCloudOrigin(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_CLOUD_ORIGIN_LENGTH) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveManagedCloudConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): ManagedCloudConfiguration {
  const rawServerUrl = env[MANAGED_CLOUD_SERVER_ENV]?.trim();
  const rawRelayUrl = env[MANAGED_CLOUD_RELAY_ENV]?.trim();

  if (!rawServerUrl && !rawRelayUrl) return { status: "unconfigured" };
  if (!rawServerUrl || !rawRelayUrl) return { status: "invalid" };

  const serverUrl = canonicalCloudOrigin(rawServerUrl);
  const relayUrl = canonicalCloudOrigin(rawRelayUrl);
  if (!serverUrl || !relayUrl) return { status: "invalid" };

  return { status: "ready", serverUrl, relayUrl };
}
