import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { readBoundedJson } from "@dohc/service-http";
import { normalizeShareDiscussionBody, normalizeShareDiscussionDisplayName } from "@dohc/security-contract/share-discussion";
import { RELAY_VERSION_REFUSAL_STATUS, RelayVersionRefusalError, relayVersionRefusal } from "./relayVersion";
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

const MAX_DISCUSSION_ENVELOPE_BYTES = 16 * 1024;
const discussionPostSchema = z.object({
  body: z.string().describe("Nonempty text, at most 2,000 normalized code points and 8,000 UTF-8 input bytes; no NUL characters.").refine(value => normalizeShareDiscussionBody(value) !== null, "The body must fit 2,000 code points and 8,000 UTF-8 bytes."),
  idempotencyKey: z.string().min(1).max(64).regex(/^[\x20-\x7e]+$/u),
  claimedName: z.string().describe("A nonempty display name, at most 40 normalized code points and 160 UTF-8 bytes.").refine(value => normalizeShareDiscussionDisplayName(value).ok, "The name must fit 40 code points and 160 UTF-8 bytes.").optional(),
}).refine(value => Buffer.byteLength(JSON.stringify(value)) <= MAX_DISCUSSION_ENVELOPE_BYTES, "The discussion request exceeds 16 KiB.");
const fileInventorySchema = z.object({
  ok: z.literal(true),
  files: z.array(z.object({blobSha256: z.string(), contentKind: z.enum(["text", "binary"])})),
});

const text = (value: unknown): CallToolResult => {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 1024 * 1024) return error("The result exceeds the 1 MiB response limit.");
  return {content: [{type: "text", text: encoded}], ...(value && typeof value === "object" ? {structuredContent: value as Record<string, unknown>, ...("ok" in value && value.ok === false ? {isError: true} : {})} : {})};
};
const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const json = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (!response.ok) {
    const refusal = response.status === RELAY_VERSION_REFUSAL_STATUS
      ? relayVersionRefusal(await readBoundedJson(response, 4096, signal).catch(() => null))
      : null;
    await response.body?.cancel().catch(() => undefined);
    if (refusal) throw new RelayVersionRefusalError(refusal);
    throw new Error(`Share link request failed (${response.status}).`);
  }
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
    inputSchema: z.object({ blobSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  }, async ({ blobSha256 }) => {
    try {
      const inventory = fileInventorySchema.parse(await jsonResponse(await options.request("/api/view/current")));
      const files = inventory.files.filter(file => file.blobSha256 === blobSha256);
      if (files.length === 0) return error("The file is no longer in the shared inventory. List files again.");
      const response = await options.request(`/api/view/blob/${blobSha256}`);
      if (!response.ok) {await response.body?.cancel(); return error(`Share link request failed (${response.status}).`);}
      const bytes = await boundedBytes(response, 256 * 1024, options.signal);
      if (files.some(file => file.contentKind === "binary")) return text({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});
      try {return text({ok: true, source: "settled", encoding: "utf8", content: new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes)});}
      catch {return text({ok: true, source: "settled", encoding: "base64", content: bytes.toString("base64")});}
    } catch (e) { return error(String(e)); }
  });
  server.registerTool("dohc_read_discussion", {
    description: "Read the discussion attached to this shared link.", inputSchema: z.object({ cursor: z.string().optional(), limit: z.number().int().positive().max(100).optional() }),
  }, async ({ cursor, limit }) => {
    try { const query = new URLSearchParams(); if (cursor) query.set("cursor", cursor); if (limit) query.set("limit", String(limit)); return text(await jsonResponse(await options.request(`/api/view/discussion?${query}`))); }
    catch (e) { return error(String(e)); }
  });
  if (metadata.access === "comment" || metadata.access === "edit") server.registerTool("dohc_post_discussion", {
    description: "Post a discussion message to this shared link when its permissions allow comments.",
    inputSchema: discussionPostSchema,
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
    description: "Replace text in an existing live Markdown document. Read it first. Supply find as document text without Markdown syntax: use world for **world**. Text must occur once within one formatting run. On outcome unknown, re-read before retrying. Applied means durable host acknowledgement, not Markdown settlement.",
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
  const parsedBody = request.method === "POST" ? await readBoundedJson(request, 32 * 1024, options.signal) : undefined;
  if (parsedBody && typeof parsedBody === "object" && "method" in parsedBody && parsedBody.method === "subscriptions/listen") {
    const result = Response.json({jsonrpc: "2.0", id: "id" in parsedBody ? parsedBody.id : null, error: {code: -32601, message: "This endpoint does not offer subscriptions."}});
    return {body: result.body, status: result.status, headers: result.headers};
  }
  const handler = createMcpHandler(() => buildServer(options, metadata));
  try {
    const response = await handler.fetch(request, {parsedBody});
    return { body: response.body ? await boundedBytes(response, 4 * 1024 * 1024, options.signal) : null, status: response.status, headers: response.headers };
  } finally {await handler.close();}
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
