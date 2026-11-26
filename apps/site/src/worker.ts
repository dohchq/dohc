// The site's Cloudflare Worker. wrangler.jsonc runs it first for /discord,
// /discord/, /ingest/* (site analytics), and /telemetry/* (desktop and Drive
// JSON batch forwarding). The assets binding serves every other path.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  ALLOWED_TELEMETRY_KEYS?: string;
}

const PREFIX = "/ingest";
const TELEMETRY_PREFIX = "/telemetry";
const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";
const MAX_TELEMETRY_BODY_BYTES = 1_048_576;
const MAX_TELEMETRY_BATCH_EVENTS = 200;
const MAX_TELEMETRY_JSON_DEPTH = 32;
const POSTHOG_KEY_PATTERN = /^phc_\w{10,100}$/;
// Only what the browser SDK's requests need. Cookies, credentials, and the
// headers Cloudflare adds, such as the visitor's country, stay here.
const FORWARDED = [
  "accept",
  "accept-language",
  "content-encoding",
  "content-type",
  "origin",
  "user-agent",
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAllowedTelemetryKeys(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((key) => POSTHOG_KEY_PATTERN.test(key)),
  );
}

type BoundedBody = { ok: true; text: string } | { ok: false; bytes: number; truncated: boolean };

async function readBoundedText(request: Request, maxBytes: number): Promise<BoundedBody> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, bytes: contentLength, truncated: false };
  }
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, bytes: total, truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

const DEPTH_EXCEEDED = Symbol("depth-exceeded");

function stripIpDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_TELEMETRY_JSON_DEPTH) return DEPTH_EXCEEDED;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      const next = stripIpDeep(entry, depth + 1);
      if (next === DEPTH_EXCEEDED) return DEPTH_EXCEEDED;
      out.push(next);
    }
    return out;
  }
  if (!isPlainRecord(value)) return value;
  const cleaned = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ip") continue;
    const next = stripIpDeep(entry, depth + 1);
    if (next === DEPTH_EXCEEDED) return DEPTH_EXCEEDED;
    cleaned[key] = next;
  }
  return cleaned;
}

function sanitizeBatchEvent(
  item: unknown,
): { ok: true; event: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainRecord(item)) return { ok: false, error: "Invalid batch item" };
  const stripped = stripIpDeep(item);
  if (stripped === DEPTH_EXCEEDED) {
    return {
      ok: false,
      error: `Event nesting exceeds ${MAX_TELEMETRY_JSON_DEPTH} levels (reached ${MAX_TELEMETRY_JSON_DEPTH + 1} levels).`,
    };
  }
  if (!isPlainRecord(stripped)) return { ok: false, error: "Invalid batch item" };
  const properties = Object.create(null) as Record<string, unknown>;
  if (isPlainRecord(stripped.properties)) Object.assign(properties, stripped.properties);
  properties.$geoip_disable = true;
  stripped.properties = properties;
  return { ok: true, event: stripped };
}

function isJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

async function forwardTelemetryBatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const allowedKeys = parseAllowedTelemetryKeys(env.ALLOWED_TELEMETRY_KEYS);
  if (allowedKeys.size === 0)
    return new Response("Telemetry proxy is not configured", { status: 503 });
  if (!isJsonContentType(request)) return new Response("Unsupported Media Type", { status: 415 });
  const rawBody = await readBoundedText(request, MAX_TELEMETRY_BODY_BYTES);
  if (!rawBody.ok) {
    const observed = rawBody.truncated ? `at least ${rawBody.bytes}` : String(rawBody.bytes);
    return new Response(
      `Payload exceeds ${MAX_TELEMETRY_BODY_BYTES} bytes (got ${observed} bytes).`,
      { status: 413 },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.text);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!isPlainRecord(parsed)) return new Response("Invalid batch payload", { status: 400 });
  const apiKey = typeof parsed.api_key === "string" ? parsed.api_key.trim() : "";
  if (!POSTHOG_KEY_PATTERN.test(apiKey) || !Array.isArray(parsed.batch))
    return new Response("Invalid batch payload", { status: 400 });
  if (!allowedKeys.has(apiKey)) return new Response("Forbidden", { status: 403 });
  if (parsed.batch.length === 0 || parsed.batch.length > MAX_TELEMETRY_BATCH_EVENTS) {
    return new Response(
      `Batch must hold 1 to ${MAX_TELEMETRY_BATCH_EVENTS} events (got ${parsed.batch.length} events).`,
      { status: 400 },
    );
  }
  const batch: Record<string, unknown>[] = [];
  for (const item of parsed.batch) {
    const cleaned = sanitizeBatchEvent(item);
    if (!cleaned.ok) return new Response(cleaned.error, { status: 400 });
    batch.push(cleaned.event);
  }
  const body = JSON.stringify({
    api_key: apiKey,
    batch,
    ...(typeof parsed.sent_at === "string" ? { sent_at: parsed.sent_at } : {}),
  });
  // Never forward cookies, Cloudflare geo headers, or client IP headers.
  const response = await fetch(`https://${API_HOST}/batch/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    redirect: "manual",
  });
  const forwarded = new Response(response.body, response);
  forwarded.headers.delete("set-cookie");
  return forwarded;
}

async function forward(request: Request, path: string): Promise<Response> {
  const host = /^\/(static|array)\//.test(path) ? ASSET_HOST : API_HOST;
  const url = new URL(request.url);
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // PostHog's cookieless mode hashes the visitor's address, not the Worker's.
  headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "");
  const body =
    request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const response = await fetch(`https://${host}${path}${url.search}`, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  const forwarded = new Response(response.body, response);
  forwarded.headers.delete("set-cookie");
  return forwarded;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/discord" || pathname === "/discord/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Promise.resolve(
          new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } }),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "https://discord.gg/R9MH5TwdSD", "cache-control": "no-store" },
        }),
      );
    }
    if (pathname.startsWith(`${PREFIX}/`)) return forward(request, pathname.slice(PREFIX.length));
    if (pathname === `${TELEMETRY_PREFIX}/batch` || pathname === `${TELEMETRY_PREFIX}/batch/`) {
      return forwardTelemetryBatch(request, env);
    }
    if (pathname === TELEMETRY_PREFIX || pathname.startsWith(`${TELEMETRY_PREFIX}/`)) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    return env.ASSETS.fetch(request);
  },
};
