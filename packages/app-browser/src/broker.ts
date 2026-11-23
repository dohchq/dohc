export type AppBrokerOp =
  | "collection.list"
  | "collection.create"
  | "backend.invoke"
  | "backend.attempt"
  | "backend.upload"
  | "backend.file"
  | "unknown";

export type AppBrokerLocalRejectionReason =
  | "invalid_id"
  | "duplicate_id"
  | "unserializable"
  | "payload_too_large"
  | "invalid_keys"
  | "rate_limited";

export type AppBrokerObservation =
  | { kind: "handshake-delivered" }
  | {
      kind: "rejected";
      reason: AppBrokerLocalRejectionReason;
      status: number | null;
      op: AppBrokerOp;
      operation?: string;
    }
  | { kind: "started"; op: AppBrokerOp; operation?: string }
  | {
      kind: "completed";
      op: AppBrokerOp;
      operation?: string;
      status: number;
      ok: boolean;
      refusalCode?: string;
    }
  | { kind: "aborted"; op: AppBrokerOp; operation?: string };

/**
 * Runs only in the trusted bootstrap. The app receives this one frame-bound port.
 * `activated` is this window's transient user activation when the request arrived: a real click or key
 * press in the app frame grants it to this window for about 5 seconds. The app's message never sets it.
 * A browser can open this page already activated, so activation counts only after this window has been without it.
 */
export function attachAppCollectionBroker(
  frame: HTMLIFrameElement,
  send: (body: unknown, signal: AbortSignal, request: { activated: boolean }) => Promise<Response>,
  lifetime: AbortSignal,
  observe?: (event: AppBrokerObservation) => void,
): void {
  let closed = false,
    loaded = false,
    pending = 0,
    backendTokens = 30,
    collectionTokens = 12,
    updated = Date.now();
  const channel = new MessageChannel(),
    controller = new AbortController(),
    ids = new Set<string>();
  const emit = (event: AppBrokerObservation) => {
    try {
      observe?.(event);
    } catch {}
  };
  const knownOp = (v: unknown): AppBrokerOp =>
    v === "collection.list" ||
    v === "collection.create" ||
    v === "backend.invoke" ||
    v === "backend.attempt" ||
    v === "backend.upload" ||
    v === "backend.file"
      ? v
      : "unknown";
  const knownOperation = (v: unknown): string | undefined =>
    typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v) ? v : undefined;
  const close = () => {
    closed = true;
    controller.abort();
    channel.port1.close();
    channel.port2.close();
    ids.clear();
  };
  const active = () => navigator.userActivation?.isActive === true;
  let armed = !active();
  const arm = armed
    ? undefined
    : setInterval(() => {
        if (!active()) {
          armed = true;
          clearInterval(arm);
        }
      }, 250);
  lifetime.addEventListener(
    "abort",
    () => {
      clearInterval(arm);
      close();
    },
    { once: true },
  );
  if (lifetime.aborted) {
    clearInterval(arm);
    close();
  }
  frame.addEventListener("load", () => {
    if (closed) return;
    if (loaded) {
      close();
      return;
    }
    loaded = true;
    frame.contentWindow?.postMessage({ kind: "dohc-app-channel", version: 1 }, "*", [
      channel.port2,
    ]);
    emit({ kind: "handshake-delivered" });
  });
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  channel.port1.onmessage = async (event) => {
    if (closed || !loaded) return;
    const inputActive = active();
    if (!inputActive) armed = true;
    const activated = inputActive && armed;
    const body: unknown = event.data;
    const op = record(body) ? knownOp(body.op) : "unknown";
    const operation = record(body) ? knownOperation(body.operation) : undefined;
    const opMeta = operation ? { operation } : {};
    if (!record(body) || typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) {
      emit({ kind: "rejected", reason: "invalid_id", status: null, op, ...opMeta });
      return;
    }
    const id = body.id,
      reject = (status: number) => {
        if (!closed) channel.port1.postMessage({ id, ok: false, status });
      },
      rejectLocal = (reason: AppBrokerLocalRejectionReason, status: number) => {
        reject(status);
        emit({ kind: "rejected", reason, status, op, ...opMeta });
      };
    if (ids.has(id)) return rejectLocal("duplicate_id", 429);
    let encoded: string;
    try {
      encoded = JSON.stringify(body);
    } catch {
      return rejectLocal("unserializable", 400);
    }
    const upload = body.op === "backend.upload",
      backend = typeof body.op === "string" && body.op.startsWith("backend.");
    const requestBytes = upload ? 8 * 1024 * 1024 : backend ? 128 * 1024 : 16_384;
    if (new TextEncoder().encode(encoded).byteLength > requestBytes)
      return rejectLocal("payload_too_large", 413);
    const keys = Object.keys(body).sort().join();
    const validAlias =
      !Object.hasOwn(body, "dataset") ||
      (typeof body.dataset === "string" &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(body.dataset) &&
        body.dataset !== "prototype" &&
        body.dataset !== "constructor");
    const valid =
      validAlias &&
      (body.op === "collection.list"
        ? ["id,limit,op", "afterPath,id,limit,op"].includes(keys)
        : body.op === "collection.create"
          ? keys === "fields,id,idempotencyKey,op"
          : body.op === "backend.invoke"
            ? [
                "id,idempotencyKey,input,op,operation",
                "dataset,id,idempotencyKey,input,op,operation",
              ].includes(keys)
            : body.op === "backend.attempt"
              ? ["id,op,operation,request", "dataset,id,op,operation,request"].includes(keys)
              : body.op === "backend.upload"
                ? [
                    "bytesBase64,contentType,id,idempotencyKey,name,op",
                    "bytesBase64,contentType,dataset,id,idempotencyKey,name,op",
                  ].includes(keys)
                : body.op === "backend.file"
                  ? [
                      "fileId,id,input,op,operation",
                      "dataset,fileId,id,input,op,operation",
                    ].includes(keys)
                  : false);
    if (!valid) return rejectLocal("invalid_keys", 400);
    const now = Date.now();
    backendTokens = Math.min(30, backendTokens + (now - updated) / 2000);
    collectionTokens = Math.min(12, collectionTokens + (now - updated) / 5000);
    updated = now;
    if (pending >= 4 || (backend ? backendTokens : collectionTokens) < 1)
      return rejectLocal("rate_limited", 429);
    if (backend) backendTokens--;
    else collectionTokens--;
    pending++;
    ids.add(id);
    emit({ kind: "started", op, ...opMeta });
    let finished = false;
    const finish = (status: number, ok: boolean, refusalCode?: string) => {
      finished = true;
      emit({
        kind: "completed",
        op,
        ...opMeta,
        status,
        ok,
        ...(refusalCode ? { refusalCode } : {}),
      });
    };
    try {
      const response = await send(body, controller.signal, { activated });
      if (closed || controller.signal.aborted) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      const refusal =
        backend &&
        response.status === 409 &&
        response.headers.get("content-type")?.split(";", 1)[0] === "application/json";
      if (!response.ok && !refusal) {
        await response.body?.cancel().catch(() => {});
        const status = [400, 404, 409, 413, 429].includes(response.status) ? response.status : 503;
        reject(status);
        return finish(status, false);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        reject(503);
        return finish(503, false);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const responseBytes = refusal
        ? 8192
        : upload || body.op === "backend.file"
          ? 8 * 1024 * 1024
          : 1024 * 1024;
      try {
        while (true) {
          const item = await reader.read();
          if (closed) return;
          if (item.done) break;
          size += item.value.byteLength;
          if (size > responseBytes) throw Error();
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (refusal) {
        if (
          !record(value) ||
          Object.keys(value).sort().join() !== "code,message" ||
          typeof value.code !== "string" ||
          !/^[a-z][a-z0-9_]{0,63}$/.test(value.code) ||
          value.code.includes("\n") ||
          typeof value.message !== "string" ||
          new TextEncoder().encode(value.message).byteLength > 1024
        ) {
          reject(503);
          return finish(503, false);
        }
        if (!closed)
          channel.port1.postMessage({
            id,
            ok: false,
            status: 409,
            error: { code: value.code, message: value.message },
          });
        return finish(409, false, value.code);
      }
      if (!closed) channel.port1.postMessage({ id, ok: true, value });
      finish(200, true);
    } catch {
      reject(503);
      finish(503, false);
    } finally {
      if (!finished) emit({ kind: "aborted", op, ...opMeta });
      pending--;
      ids.delete(id);
    }
  };
  channel.port1.start();
}
