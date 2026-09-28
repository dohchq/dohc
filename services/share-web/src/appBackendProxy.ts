import { readBoundedJson } from "@dohc/service-http";
import {opaqueLinkRefusal, relayLinkRefusal} from "./linkRefusal";
import { parseDatasetAttemptRequest, parseDatasetAttemptResult } from "@dohc/security-contract/dataset-attempts";
import {
  APP_BACKEND_REQUEST_BYTES, APP_BACKEND_RESULT_BYTES, APP_BACKEND_UPLOAD_REQUEST_BYTES, APP_BACKEND_REFUSAL_BYTES,
  parseAppBackendFile, parseAppBackendInvokeRequest, parseAppBackendJson, parseAppBackendUploadRequest, parseAppBackendRefusal,
} from "@dohc/security-contract/app-backend";

const responseHeaders = { "cache-control": "private, no-store", "cross-origin-resource-policy": "same-origin", "x-content-type-options": "nosniff" };
const appError = (status: number) => new Response(null, { status, headers: responseHeaders });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

/** The launch supplies authority. The sandbox supplies only operation input and retry identity. */
export async function forwardAppBackend(input: {
  request: Request; relayUrl: string; publicationId: string; authorityRevision: number;
  capability?: string; profileSecret?: string; signal: AbortSignal;
  fetchRelay(request: Request): Promise<Response>;
}): Promise<Response> {
  const error = input.capability ? (_status: number) => opaqueLinkRefusal() : appError;
  if (input.request.headers.get("content-type") !== "application/json") return error(400);
  let body: unknown;
  try { body = await readBoundedJson(input.request, APP_BACKEND_UPLOAD_REQUEST_BYTES, input.signal); }
  catch (cause) { return error(cause instanceof RangeError ? 413 : 400); }
  if (!record(body) || typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id) || body.id.includes("\n")) return error(400);
  let action: "invoke" | "upload" | "file" | "attempt", payload: unknown;
  try {
    if (body.op !== "backend.upload" && new TextEncoder().encode(JSON.stringify(body)).byteLength > APP_BACKEND_REQUEST_BYTES) return error(413);
    if (body.op === "backend.invoke") {
      if (!exact(body, ["id", "op", "operation", "idempotencyKey", "input"])) return error(400);
      action = "invoke";
      payload = parseAppBackendInvokeRequest({ authorityRevision: input.authorityRevision, operation: body.operation, idempotencyKey: body.idempotencyKey, input: body.input });
    } else if (body.op === "backend.attempt") {
      if (!exact(body, ["id", "op", "operation", "request"])) return error(400);
      action = "attempt";
      const checked = parseAppBackendInvokeRequest({ authorityRevision: input.authorityRevision, operation: body.operation, idempotencyKey: "attempt", input: null });
      payload = { authorityRevision: checked.authorityRevision, operation: checked.operation, ...parseDatasetAttemptRequest(body.request) };
    } else if (body.op === "backend.upload") {
      if (!exact(body, ["id", "op", "idempotencyKey", "name", "contentType", "bytesBase64"])) return error(400);
      action = "upload";
      payload = parseAppBackendUploadRequest({ authorityRevision: input.authorityRevision, idempotencyKey: body.idempotencyKey, name: body.name, contentType: body.contentType, bytesBase64: body.bytesBase64 });
    } else if (body.op === "backend.file") {
      if (!exact(body, ["id", "op", "fileId", "operation", "input"]) || typeof body.fileId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(body.fileId) || body.fileId.includes("\n")) return error(400);
      action = "file";
      const checked = parseAppBackendInvokeRequest({ authorityRevision: input.authorityRevision, operation: body.operation, idempotencyKey: "file-read", input: body.input });
      payload = { authorityRevision: checked.authorityRevision, fileId: body.fileId, operation: checked.operation, input: checked.input };
    } else return error(400);
  } catch { return error(400); }

  const url = new URL(`/sync/link/app-publications/${input.publicationId}/backend/${action}`, input.relayUrl);
  let relay: Response;
  try {
    relay = await input.fetchRelay(new Request(url, {
      method: "POST", body: JSON.stringify(payload), redirect: "manual", signal: input.signal,
      headers: { "content-type": "application/json", ...(input.capability && input.profileSecret ? { authorization: `LinkCapability ${input.capability}`, "x-dohc-link-profile-secret": input.profileSecret } : {}) },
    }));
  } catch { return error(503); }
  try {
    if (relay.status === 409 && !relay.redirected && !relay.headers.has("location") && relay.headers.get("content-type")?.split(";", 1)[0] === "application/json") {
      const refusal = parseAppBackendRefusal(await readBoundedJson(relay, APP_BACKEND_REFUSAL_BYTES, input.signal));
      input.signal.throwIfAborted();
      return Response.json(refusal, { status: 409, headers: responseHeaders });
    }
    if (relay.status !== 200 || relay.redirected || relay.headers.has("location")) return input.capability
      ? await relayLinkRefusal(relay, input.signal)
      : error(relay.status === 401 || relay.status === 403 ? 404 : [400, 404, 409, 413, 429].includes(relay.status) ? relay.status : 503);
    const value = await readBoundedJson(relay, action === "file" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : APP_BACKEND_RESULT_BYTES, input.signal);
    if (!record(value)) return error(503);
    let result: unknown;
    if (action === "invoke") {
      if (!exact(value, ["result", "revision", "replayed"]) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || typeof value.replayed !== "boolean") return error(503);
      result = { result: parseAppBackendJson(value.result), revision: value.revision, replayed: value.replayed };
    } else if (action === "attempt") {
      result = parseDatasetAttemptResult(value);
    } else if (action === "upload") {
      if (!exact(value, ["file", "replayed"]) || typeof value.replayed !== "boolean") return error(503);
      result = { file: parseAppBackendFile(value.file), replayed: value.replayed };
    } else {
      if (!exact(value, ["file", "bytesBase64"])) return error(503);
      const file = parseAppBackendFile(value.file);
      if (file.fileId !== body.fileId) return error(503);
      const checked = parseAppBackendUploadRequest({ authorityRevision: input.authorityRevision, idempotencyKey: "file-read", name: file.name, contentType: file.contentType, bytesBase64: value.bytesBase64 });
      const padding = checked.bytesBase64.endsWith("==") ? 2 : checked.bytesBase64.endsWith("=") ? 1 : 0;
      if (checked.bytesBase64.length / 4 * 3 - padding !== file.byteLength) return error(503);
      result = { file, bytesBase64: checked.bytesBase64 };
    }
    input.signal.throwIfAborted();
    return Response.json(result, { headers: responseHeaders });
  } catch { return error(503); }
  finally { await relay.body?.cancel().catch(() => {}); }
}
