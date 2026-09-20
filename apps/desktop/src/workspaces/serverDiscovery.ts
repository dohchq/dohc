import { canonicalCloudOrigin, isServerDisplayName } from "./cloudConfiguration";

const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

export type ServerDescriptor = {
  version: 1;
  authUrl: string;
  relayUrl: string;
  shareUrl: string;
  name?: string;
  networkAccess?: "private" | "public";
};

export async function discoverServer(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<ServerDescriptor> {
  const origin = canonicalCloudOrigin(serverUrl);
  if (!origin) throw new Error("Enter an HTTPS server address. HTTP is only available on this machine.");
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/.well-known/dohc-server`, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    throw new Error("dohc could not reach this server. Check the address and connection, then try again.");
  }
  if (!response.ok || response.redirected) {
    await response.body?.cancel();
    throw new Error("This address does not provide a dohc server connection. Check the server setup.");
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
    await response.body?.cancel();
    throw new Error("This server returned an invalid connection description. Check the server setup.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let value: unknown;
  try {
    while (true) {
      const { value: bytes, done } = await reader.read();
      if (done) break;
      size += bytes.byteLength;
      if (size > MAX_DESCRIPTOR_BYTES) throw new Error("descriptor too large");
      chunks.push(bytes);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    throw new Error("This server returned an invalid connection description. Check the server setup.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("This server returned an invalid connection description. Check the server setup.");
  }
  const descriptor = value as Record<string, unknown>;
  const authUrl = typeof descriptor.authUrl === "string" ? canonicalCloudOrigin(descriptor.authUrl) : null;
  const relayUrl = typeof descriptor.relayUrl === "string" ? canonicalCloudOrigin(descriptor.relayUrl) : null;
  const shareUrl = typeof descriptor.shareUrl === "string" ? canonicalCloudOrigin(descriptor.shareUrl) : null;
  if (descriptor.version !== 1 || !authUrl || !relayUrl || !shareUrl ||
      authUrl !== origin || relayUrl !== origin || shareUrl !== origin ||
      (descriptor.name !== undefined && !isServerDisplayName(descriptor.name)) ||
      (descriptor.networkAccess !== undefined && !["private", "public"].includes(descriptor.networkAccess as string)) ||
      Object.keys(descriptor).some(key => !["version", "authUrl", "relayUrl", "shareUrl", "name", "networkAccess"].includes(key))) {
    throw new Error("This server returned an unsupported connection description. Check the server setup.");
  }
  return {
    version: 1, authUrl, relayUrl, shareUrl,
    ...(isServerDisplayName(descriptor.name) ? { name: descriptor.name } : {}),
    ...(descriptor.networkAccess === "private" || descriptor.networkAccess === "public" ? { networkAccess: descriptor.networkAccess } : {}),
  };
}
