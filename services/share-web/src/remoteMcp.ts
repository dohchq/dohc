import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readBoundedJson } from "@dohc/service-http";
import { remoteLiveDocument } from "./remoteLiveDocument";
import type { createLinkLiveClient } from "./linkLiveClient";
import type { NamedLiveBrowserLimits } from "@dohc/ydoc-projection/named-live-browser-transport";

type RemoteRequest = (path: string, init?: RequestInit) => Promise<Response>;
type RemoteOptions = {
  discriminator: string;
  cookie: string;
  request: RemoteRequest;
  linkLive?: ReturnType<typeof createLinkLiveClient>;
  liveLimits?: NamedLiveBrowserLimits;
  signal: AbortSignal;
};

const text = (value: unknown): CallToolResult => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1024 * 1024) return error("The result exceeds the 1 MiB response limit.");
  return {content: [{type: "text", text: encoded}], ...(value && typeof value === "object" ? {structuredContent: value as Record<string, unknown>, ...("ok" in value && value.ok === false ? {isError: true} : {})} : {})};
};
const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const json = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (!response.ok) {await response.body?.cancel(); throw new Error(`Share link request failed (${response.status}).`);}
  return readBoundedJson(response, 1024 * 1024, signal);
};

function buildServer(options: RemoteOptions, metadata: Record<string, unknown>): McpServer {
  const jsonResponse = (response: Response) => json(response, options.signal);
  const server = new McpServer({ name: "dohc-share", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.registerTool("dohc_share_status", { description: "Read the current share permissions and release state.", inputSchema: z.object({}) }, async () => {
    return text(metadata);
  });
  server.registerTool("dohc_list_files", {
    description: "List files visible through this shared link. Paths are relative to the share.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      return text(await jsonResponse(await options.request("/api/view/current")));
    } catch (e) { return error(String(e)); }
  });
  server.registerTool("dohc_read_file", {
    description: "Read up to 256 KiB of settled file content using a hash from dohc_list_files. Markdown may lag the live document. Binary files are base64 encoded.",
    inputSchema: z.object({ blobSha256: z.string().regex(/^[0-9a-f]{64}$/i) }),
  }, async ({ blobSha256 }) => {
    try {
      const response = await options.request(`/api/view/blob/${blobSha256}`);
      if (!response.ok) {await response.body?.cancel(); return error(`Share link request failed (${response.status}).`);}
      const bytes = await boundedBytes(response, 256 * 1024, options.signal);
      try {return text({ok: true, source: "settled", encoding: "utf8", content: new TextDecoder("utf-8", {fatal: true}).decode(bytes)});}
      catch {return text({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});}
    } catch (e) { return error(String(e)); }
  });
  server.registerTool("dohc_read_discussion", {
    description: "Read the discussion attached to this shared link.", inputSchema: z.object({ cursor: z.string().optional(), limit: z.number().int().positive().max(200).optional() }),
  }, async ({ cursor, limit }) => {
    try { const query = new URLSearchParams(); if (cursor) query.set("cursor", cursor); if (limit) query.set("limit", String(limit)); return text(await jsonResponse(await options.request(`/api/view/discussion?${query}`))); }
    catch (e) { return error(String(e)); }
  });
  if (metadata.access === "comment" || metadata.access === "edit") server.registerTool("dohc_post_discussion", {
    description: "Post a discussion message to this shared link when its permissions allow comments.",
    inputSchema: z.object({ body: z.string().min(1).max(16_000), idempotencyKey: z.string().min(1).max(256), claimedName: z.string().max(120).optional() }),
  }, async ({ body, idempotencyKey, claimedName }) => {
    try {
      return text(await jsonResponse(await options.request("/api/view/discussion", { method: "POST", body: JSON.stringify({ body, idempotencyKey, ...(claimedName ? { claimedName } : {}) }) })));
    } catch (e) { return error(String(e)); }
  });
  const selector = metadata.effectiveSelector as {versionId?: string | null} | undefined;
  if (metadata.access === "edit" && selector?.versionId === null && options.linkLive && options.liveLimits) {
  const liveOptions = {client: options.linkLive, limits: options.liveLimits, discriminator: options.discriminator, cookie: options.cookie, request: options.request, signal: options.signal};
  server.registerTool("dohc_read_document", {
    description: "Read the current live Markdown document before editing. Requires an online document host and an Edit link.",
    inputSchema: z.object({path: z.string().max(1024).regex(/\.md$/i)}),
  }, async ({path}) => text(await remoteLiveDocument(liveOptions, path)));
  server.registerTool("dohc_edit_document", {
    description: "Replace text in an existing live Markdown document. Read it first. Text must occur once within one text block. On outcome unknown, re-read before retrying. Applied means durable host acknowledgement, not Markdown settlement.",
    inputSchema: z.object({ path: z.string().max(1024).regex(/\.md$/i), find: z.string().min(1).max(8_000), replacement: z.string().max(8_000) }),
  }, async ({ path, find, replacement }) => {
    return text(await remoteLiveDocument(liveOptions, path, {find, replacement}));
  });
  }
  return server;
}

export async function serveRemoteMcp(request: Request, options: RemoteOptions): Promise<{ body: BodyInit | null; status: number; headers: Headers }> {
  const metadata = await json(await options.request("/api/view/meta"), options.signal) as Record<string, unknown>;
  if (metadata.ok !== true) throw new Error("Share is unavailable.");
  const handler = createMcpHandler(() => buildServer(options, metadata), { responseMode: "json" });
  const parsedBody = request.method === "POST" ? await readBoundedJson(request, 32 * 1024, options.signal) : undefined;
  const response = await handler.fetch(request, {parsedBody});
  return { body: response.body ? await boundedBytes(response, 4 * 1024 * 1024, options.signal) : null, status: response.status, headers: response.headers };
}

async function boundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer<ArrayBuffer>> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener("abort", abort, {once: true});
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      size += next.value.length; if (size > maxBytes) throw new Error("The response exceeds the size limit.");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock();}
}
