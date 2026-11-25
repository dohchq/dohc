import { readBoundedBytes, readBoundedJson } from "@dohc/service-http";
import { opaqueLinkRefusal, relayLinkRefusal, unavailableLinkRefusal } from "./linkRefusal";
import {
  parseDatasetAttemptRequest,
  parseDatasetAttemptResult,
} from "@dohc/security-contract/dataset-attempts";
import {
  APP_BACKEND_REQUEST_BYTES,
  APP_BACKEND_RESULT_BYTES,
  APP_BACKEND_UPLOAD_BYTES,
  APP_BACKEND_UPLOAD_REQUEST_BYTES,
  APP_BACKEND_REFUSAL_BYTES,
  assertAppBackendUploadBytes,
  parseAppBackendFile,
  parseAppBackendInvokeRequest,
  parseAppBackendJson,
  parseAppBackendUploadMeta,
  parseAppBackendUploadRequest,
  parseAppBackendRefusal,
} from "@dohc/security-contract/app-backend";

const responseHeaders = {
  "cache-control": "private, no-store",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};
const appError = (status: number) => new Response(null, { status, headers: responseHeaders });
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[], optional: string[] = []) => {
  const actual = Object.keys(value);
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => keys.includes(key) || optional.includes(key))
  );
};

/** The launch supplies authority. The sandbox supplies only operation input and retry identity. */
export async function forwardAppBackend(input: {
  request: Request;
  relayUrl: string;
  publicationId: string;
  authorityRevision: number;
  capability?: string;
  profileSecret?: string;
  fileRoute: boolean;
  signal: AbortSignal;
  fetchRelay(request: Request): Promise<Response>;
}): Promise<Response> {
  const error = input.capability ? (_status: number) => opaqueLinkRefusal() : appError;
  const contentType = input.request.headers.get("content-type");
  const isBinaryUpload = contentType === "application/octet-stream";
  if (!isBinaryUpload && contentType !== "application/json") return error(400);
  const readError = (cause: unknown) => {
    const reason = input.signal.reason as { name?: unknown } | undefined;
    const timedOut = input.signal.aborted && reason?.name === "TimeoutError";
    if (timedOut) {
      return input.capability
        ? new Response(null, { status: 408, headers: responseHeaders })
        : Response.json(
            {
              error: isBinaryUpload
                ? "App backend upload exceeded the 90000 ms timeout limit."
                : "App backend request exceeded the 15000 ms timeout limit.",
            },
            { status: 408, headers: responseHeaders },
          );
    }
    if (cause instanceof RangeError) {
      return input.capability
        ? error(413)
        : Response.json({ error: cause.message }, { status: 413, headers: responseHeaders });
    }
    return error(400);
  };
  let body: unknown;
  try {
    if (isBinaryUpload) {
      const rawMeta = input.request.headers.get("x-dohc-app-meta");
      if (!rawMeta || rawMeta.length > 4096) return error(400);
      body = JSON.parse(decodeURIComponent(rawMeta));
    } else {
      body = await readBoundedJson(input.request, APP_BACKEND_REQUEST_BYTES, input.signal);
    }
  } catch (cause) {
    return readError(cause);
  }
  if (
    !record(body) ||
    typeof body.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(body.id) ||
    body.id.includes("\n") ||
    input.fileRoute !== (body.op === "backend.file")
  )
    return error(400);
  let action: "invoke" | "upload" | "file" | "attempt", payload: unknown;
  try {
    const datasetField = Object.hasOwn(body, "dataset") ? { dataset: body.dataset } : {};
    if (isBinaryUpload) {
      if (
        body.op !== "backend.upload" ||
        !exact(body, ["id", "op", "idempotencyKey", "name", "contentType"], ["dataset"])
      )
        return error(400);
      const parsedMeta = parseAppBackendUploadMeta({
        authorityRevision: input.authorityRevision,
        idempotencyKey: body.idempotencyKey,
        name: body.name,
        contentType: body.contentType,
        ...datasetField,
      });
      const uploadBytes = await readBoundedBytes(
        input.request,
        APP_BACKEND_UPLOAD_BYTES,
        input.signal,
      );
      assertAppBackendUploadBytes(uploadBytes.byteLength);
      action = "upload";
      payload = { ...parsedMeta, bytesBase64: Buffer.from(uploadBytes).toString("base64") };
    } else if (body.op === "backend.invoke") {
      if (
        !exact(
          body,
          ["id", "op", "operation", "idempotencyKey", "input"],
          ["dataset", "readOnly"],
        ) ||
        (Object.hasOwn(body, "readOnly") && body.readOnly !== true)
      )
        return error(400);
      action = "invoke";
      const parsed = parseAppBackendInvokeRequest({
        authorityRevision: input.authorityRevision,
        operation: body.operation,
        idempotencyKey: body.idempotencyKey,
        input: body.input,
        ...datasetField,
      });
      payload = body.readOnly === true ? { ...parsed, readOnly: true } : parsed;
    } else if (body.op === "backend.attempt") {
      if (!exact(body, ["id", "op", "operation", "request"], ["dataset"])) return error(400);
      action = "attempt";
      const checked = parseAppBackendInvokeRequest({
        authorityRevision: input.authorityRevision,
        operation: body.operation,
        idempotencyKey: "attempt",
        input: null,
        ...datasetField,
      });
      payload = {
        authorityRevision: checked.authorityRevision,
        operation: checked.operation,
        ...(checked.dataset === undefined ? {} : { dataset: checked.dataset }),
        ...parseDatasetAttemptRequest(body.request),
      };
    } else if (body.op === "backend.file") {
      if (
        !exact(body, ["id", "op", "fileId", "operation", "input"], ["dataset"]) ||
        typeof body.fileId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(body.fileId) ||
        body.fileId.includes("\n")
      )
        return error(400);
      action = "file";
      const checked = parseAppBackendInvokeRequest({
        authorityRevision: input.authorityRevision,
        operation: body.operation,
        idempotencyKey: "file-read",
        input: body.input,
        ...datasetField,
      });
      payload = {
        authorityRevision: checked.authorityRevision,
        fileId: body.fileId,
        operation: checked.operation,
        input: checked.input,
        ...(checked.dataset === undefined ? {} : { dataset: checked.dataset }),
      };
    } else return error(400);
  } catch (cause) {
    return readError(cause);
  }

  const url = new URL(
    `/sync/link/app-publications/${input.publicationId}/backend/${action}`,
    input.relayUrl,
  );
  let relay: Response;
  try {
    relay = await input.fetchRelay(
      new Request(url, {
        method: "POST",
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: input.signal,
        headers: {
          "content-type": "application/json",
          ...(input.capability && input.profileSecret
            ? {
                authorization: `LinkCapability ${input.capability}`,
                "x-dohc-link-profile-secret": input.profileSecret,
              }
            : {}),
        },
      }),
    );
  } catch {
    return error(503);
  }
  try {
    if (
      relay.status === 409 &&
      !relay.redirected &&
      !relay.headers.has("location") &&
      relay.headers.get("content-type")?.split(";", 1)[0] === "application/json"
    ) {
      const refusal = parseAppBackendRefusal(
        await readBoundedJson(relay, APP_BACKEND_REFUSAL_BYTES, input.signal),
      );
      input.signal.throwIfAborted();
      return Response.json(refusal, {
        headers: { ...responseHeaders, "x-dohc-app-refusal": "1" },
      });
    }
    if (relay.status !== 200 || relay.redirected || relay.headers.has("location"))
      return input.capability || relay.status === 410
        ? await relayLinkRefusal(relay, input.signal)
        : error(
            relay.status === 401 || relay.status === 403
              ? 404
              : [400, 404, 409, 413, 429].includes(relay.status)
                ? relay.status
                : 503,
          );
    const value = await readBoundedJson(
      relay,
      action === "file" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : APP_BACKEND_RESULT_BYTES,
      input.signal,
    );
    if (!record(value)) return error(503);
    let result: unknown;
    if (action === "invoke") {
      if (
        !exact(value, ["result", "revision", "replayed"]) ||
        !Number.isSafeInteger(value.revision) ||
        (value.revision as number) < 0 ||
        typeof value.replayed !== "boolean"
      )
        return error(503);
      result = {
        result: parseAppBackendJson(value.result),
        revision: value.revision,
        replayed: value.replayed,
      };
    } else if (action === "attempt") {
      result = parseDatasetAttemptResult(value);
    } else if (action === "upload") {
      if (!exact(value, ["file", "replayed"]) || typeof value.replayed !== "boolean")
        return error(503);
      result = { file: parseAppBackendFile(value.file), replayed: value.replayed };
    } else {
      if (!exact(value, ["file", "bytesBase64"])) return error(503);
      const file = parseAppBackendFile(value.file);
      if (file.fileId !== body.fileId) return error(503);
      const checked = parseAppBackendUploadRequest({
        authorityRevision: input.authorityRevision,
        idempotencyKey: "file-read",
        name: file.name,
        contentType: file.contentType,
        bytesBase64: value.bytesBase64,
      });
      const rawBytes = Buffer.from(checked.bytesBase64, "base64");
      if (rawBytes.byteLength !== file.byteLength) return error(503);
      input.signal.throwIfAborted();
      return new Response(rawBytes, {
        headers: {
          ...responseHeaders,
          "content-type": "application/octet-stream",
          "x-dohc-app-file": encodeURIComponent(JSON.stringify(file)),
        },
      });
    }
    input.signal.throwIfAborted();
    return Response.json(result, { headers: responseHeaders });
  } catch {
    return error(503);
  } finally {
    await relay.body?.cancel().catch(() => {});
  }
}

interface AppEventsRelay {
  relayUrl: string;
  publicationId: string;
  authorityRevision: number;
  signal: AbortSignal;
  fetchRelay(request: Request): Promise<Response>;
}

/** Waits for the link app's Collection to move past `since`, then answers its alias and revision. */
export async function forwardAppEvents(
  input: AppEventsRelay & { request: Request },
): Promise<Response> {
  let since: unknown;
  try {
    if (input.request.headers.get("content-type") !== "application/json") throw Error();
    const body = await readBoundedJson(input.request, 256, input.signal);
    if (!record(body) || !exact(body, ["since"])) throw Error();
    since = body.since;
  } catch {
    return opaqueLinkRefusal();
  }
  if (!Number.isSafeInteger(since) || (since as number) < 0) return opaqueLinkRefusal();
  return relayAppEvents(input, since as number, 25_000);
}

/** The relay's answer for the link app's Collection after `since`, held up to `hold` ms. */
export async function relayAppEvents(
  input: AppEventsRelay,
  since: number,
  hold: number,
): Promise<Response> {
  const url = new URL(
    `/sync/link/app-publications/${input.publicationId}/backend/events?authorityRevision=${input.authorityRevision}&since=${since}&hold=${hold}`,
    input.relayUrl,
  );
  let relay: Response;
  try {
    relay = await input.fetchRelay(new Request(url, { redirect: "manual", signal: input.signal }));
  } catch {
    return unavailableLinkRefusal();
  }
  try {
    if (relay.status !== 200 || relay.redirected || relay.headers.has("location"))
      return await relayLinkRefusal(relay, input.signal);
    let value: unknown;
    try {
      value = await readBoundedJson(relay, 256, input.signal);
    } catch (error) {
      return error instanceof RangeError || error instanceof SyntaxError
        ? opaqueLinkRefusal()
        : unavailableLinkRefusal();
    }
    if (
      !record(value) ||
      !exact(value, ["dataset", "revision"]) ||
      typeof value.dataset !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0
    )
      return opaqueLinkRefusal();
    return Response.json(
      { dataset: value.dataset, revision: value.revision },
      { headers: responseHeaders },
    );
  } finally {
    await relay.body?.cancel().catch(() => {});
  }
}
