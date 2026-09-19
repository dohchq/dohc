const MAX_CLOUD_ORIGIN_LENGTH = 2048;

export function isServerDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function canonicalCloudOrigin(value: string): string | null {
  const raw = value.trim();
  if (raw.length === 0 || raw.length > MAX_CLOUD_ORIGIN_LENGTH) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    if (!url.hostname) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}
