// The site's Cloudflare Worker. wrangler.jsonc runs it first for /ingest/*
// (site cookieless analytics) and /telemetry/* (hardened desktop and Drive
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

async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  if (!request.body) return "";
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
        return null;
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
  return new TextDecoder().decode(merged);
}

function stripIp(record: Record<string, unknown>): Record<string, unknown> {
  const { $ip: _ignored, ...rest } = record;
  return rest;
}

function sanitizeBatchEvent(item: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(item)) return null;
  const cleaned = stripIp(item);
  if (isPlainRecord(cleaned.properties)) cleaned.properties = stripIp(cleaned.properties);
  return cleaned;
}

async function forwardTelemetryBatch(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const allowedKeys = parseAllowedTelemetryKeys(env.ALLOWED_TELEMETRY_KEYS);
  if (allowedKeys.size === 0)
    return new Response("Telemetry proxy is not configured", { status: 503 });
  const rawBody = await readBoundedText(request, MAX_TELEMETRY_BODY_BYTES);
  if (rawBody === null) return new Response("Payload Too Large", { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!isPlainRecord(parsed)) return new Response("Invalid batch payload", { status: 400 });
  const apiKey = typeof parsed.api_key === "string" ? parsed.api_key.trim() : "";
  if (!POSTHOG_KEY_PATTERN.test(apiKey) || !Array.isArray(parsed.batch))
    return new Response("Invalid batch payload", { status: 400 });
  if (!allowedKeys.has(apiKey)) return new Response("Forbidden", { status: 403 });
  if (parsed.batch.length === 0 || parsed.batch.length > MAX_TELEMETRY_BATCH_EVENTS)
    return new Response("Invalid batch size", { status: 400 });
  const batch: Record<string, unknown>[] = [];
  for (const item of parsed.batch) {
    const cleaned = sanitizeBatchEvent(item);
    if (!cleaned) return new Response("Invalid batch item", { status: 400 });
    batch.push(cleaned);
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
