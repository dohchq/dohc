export type AppBrokerOp =
  | "collection.list"
  | "collection.create"
  | "backend.invoke"
  | "backend.attempt"
  | "backend.upload"
  | "backend.file"
  | "host.copy"
  | "host.print"
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
  | { kind: "started"; id: string; op: AppBrokerOp; operation?: string }
  | {
      kind: "completed";
      id: string;
      op: AppBrokerOp;
      operation?: string;
      status: number;
      ok: boolean;
      refusalCode?: string;
    }
  | { kind: "aborted"; id: string; op: AppBrokerOp; operation?: string };

export interface AppBrokerLimits {
  readonly maxPending?: number;
  readonly backendBurst?: number;
  readonly backendRefillMs?: number;
  readonly fileBurst?: number;
  readonly fileRefillMs?: number;
  readonly invokeRequestBytes?: number;
  readonly invokeResultBytes?: number;
  readonly trustRateLimitDetails?: boolean;
}

export interface AppBrokerHostActions {
  copyText?(text: string): Promise<void>;
  print?(options: { height?: number }): Promise<void>;
}

export interface AppBrokerHandle {
  notifyDatasetChanged(dataset: string, revision: number): void;
}

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
  limits?: AppBrokerLimits,
  hostActions?: AppBrokerHostActions,
): AppBrokerHandle {
  const bounded = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fallback;
  const maxPending = bounded(limits?.maxPending, 1, 16, 4),
    backendBurst = bounded(limits?.backendBurst, 1, 240, 30),
    backendRefillMs = bounded(limits?.backendRefillMs, 10, 10_000, 2000),
    fileBurst = bounded(limits?.fileBurst, 1, 240, 120),
    fileRefillMs = bounded(limits?.fileRefillMs, 10, 10_000, 250),
    invokeRequestBytes = bounded(limits?.invokeRequestBytes, 131_072, 2_097_152, 131_072),
    invokeResultBytes = bounded(limits?.invokeResultBytes, 1_048_576, 4_198_400, 1_048_576),
    trustRateLimitDetails = limits?.trustRateLimitDetails === true,
    collectionBurst = 12,
    collectionRefillMs = 5000,
    maxCopyBytes = 65_536,
    copyCooldownMs = 1000,
    printCooldownMs = 5500,
    maxPrintHeight = 50_000;
  let closed = false,
    loaded = false,
    pending = 0,
    backendTokens = backendBurst,
    fileTokens = fileBurst,
    collectionTokens = collectionBurst,
    updated = Date.now(),
    copying = false,
    nextCopyAt = 0,
    printing = false,
    nextPrintAt = 0;
  const channel = new MessageChannel(),
    controller = new AbortController(),
    ids = new Set<string>();
  const emit = (event: AppBrokerObservation) => {
    try {
      observe?.(event);
    } catch {}
  };
  const formatDuration = (ms: number) => {
    const rounded = Math.max(1, Math.ceil(ms));
    if (rounded < 1000) return `${rounded} ms`;
    const seconds = rounded / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1).replace(/\.0$/, "")} s`;
  };
  const validDatasetKey = (v: unknown): v is string =>
    typeof v === "string" &&
    (v === "" || (/^[a-z][a-z0-9_-]{0,63}$/.test(v) && v !== "prototype" && v !== "constructor"));
  const knownOp = (v: unknown): AppBrokerOp =>
    v === "collection.list" ||
    v === "collection.create" ||
    v === "backend.invoke" ||
    v === "backend.attempt" ||
    v === "backend.upload" ||
    v === "backend.file" ||
    v === "host.copy" ||
    v === "host.print"
      ? v
      : "unknown";
  const knownOperation = (v: unknown): string | undefined =>
    typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v) ? v : undefined;
  const defaultCopyText = async (text: string) => {
    if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {}
    }
    if (typeof document === "undefined" || typeof document.execCommand !== "function")
      throw Error("Clipboard unavailable");
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none";
    document.body.append(area);
    try {
      area.focus({ preventScroll: true });
      area.select();
      if (!document.execCommand("copy")) throw Error("Clipboard copy failed");
    } finally {
      area.remove();
      try {
        frame.focus({ preventScroll: true });
      } catch {}
    }
  };
  const defaultPrint = (options: { height?: number }) => {
    let cleaned = false,
      afterFired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      printing = false;
      window.removeEventListener("afterprint", onAfter);
      lifetime.removeEventListener("abort", cleanup);
      document.body?.classList.remove("dohc-printing");
      document.documentElement?.style.removeProperty("--dohc-print-h");
    };
    const onAfter = () => {
      afterFired = true;
      cleanup();
    };
    window.addEventListener("afterprint", onAfter, { once: true });
    lifetime.addEventListener("abort", cleanup, { once: true });
    if (options.height !== undefined) {
      document.documentElement?.style.setProperty("--dohc-print-h", `${options.height}px`);
    }
    document.body?.classList.add("dohc-printing");
    try {
      window.print();
    } catch {
      cleanup();
      return;
    }
    if (afterFired) cleanup();
    else timer = setTimeout(cleanup, 1000);
  };
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
    const budget = {
      maxInFlight: maxPending,
      calls: { burst: backendBurst, refillMs: backendRefillMs },
      files: { burst: fileBurst, refillMs: fileRefillMs },
    };
    const handshake =
      maxPending > 4
        ? { kind: "dohc-app-channel", version: 1, maxInFlight: Math.min(maxPending, 8), budget }
        : { kind: "dohc-app-channel", version: 1, budget };
    frame.contentWindow?.postMessage(handshake, "*", [channel.port2]);
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
      reject = (
        status: number,
        error?: { code: string; message: string; retryAfterMs?: number },
      ) => {
        if (!closed)
          channel.port1.postMessage(
            error ? { id, ok: false, status, error } : { id, ok: false, status },
          );
      },
      rejectLocal = (
        reason: AppBrokerLocalRejectionReason,
        status: number,
        error?: { code: string; message: string; retryAfterMs?: number },
      ) => {
        reject(status, error);
        emit({ kind: "rejected", reason, status, op, ...opMeta });
      };
    if (ids.has(id))
      return rejectLocal("duplicate_id", 429, {
        code: "duplicate_id",
        message:
          "Duplicate request id: at most 1 in-flight request per id (1 already active). Wait for it to finish or use a new id.",
      });
    const maxFileBytes = 20 * 1024 * 1024;
    const upload = body.op === "backend.upload",
      hostCopy = body.op === "host.copy",
      hostPrint = body.op === "host.print",
      backend = typeof body.op === "string" && body.op.startsWith("backend.");
    const keys = Object.keys(body).sort().join();
    const refuseHost = (code: string, message: string, started = false) => {
      if (!started) emit({ kind: "started", id, op });
      reject(409, { code, message });
      emit({ kind: "completed", id, op, status: 409, ok: false, refusalCode: code });
    };
    if (hostCopy) {
      if (keys !== "id,op,text" || typeof body.text !== "string")
        return rejectLocal("invalid_keys", 400);
      if (body.text.length > maxCopyBytes * 4)
        return rejectLocal("payload_too_large", 413, {
          code: "payload_too_large",
          message: `Clipboard text exceeded its limit of ${maxCopyBytes} bytes (over ${body.text.length} bytes).`,
        });
      const textBytes = new TextEncoder().encode(body.text).byteLength;
      if (textBytes > maxCopyBytes)
        return rejectLocal("payload_too_large", 413, {
          code: "payload_too_large",
          message: `Clipboard text exceeded its limit of ${maxCopyBytes} bytes (used ${textBytes} bytes).`,
        });
      const now = Date.now();
      if (!activated)
        return refuseHost(
          "user_activation_required",
          "Clipboard copy requires a recent click or key press.",
        );
      if (copying || now < nextCopyAt) {
        const retryAfterMs = copying ? copyCooldownMs : Math.max(1, nextCopyAt - now);
        return rejectLocal("rate_limited", 429, {
          code: "rate_limited",
          message: `Rate limit reached: at most 1 clipboard copy per ${formatDuration(copyCooldownMs)} (1 already used). Try again in ${formatDuration(retryAfterMs)}.`,
          retryAfterMs,
        });
      }
      copying = true;
      nextCopyAt = now + copyCooldownMs;
      ids.add(id);
      emit({ kind: "started", id, op });
      let finished = false;
      try {
        await (hostActions?.copyText
          ? hostActions.copyText(body.text)
          : defaultCopyText(body.text));
        if (closed) return;
        channel.port1.postMessage({ id, ok: true, value: { copied: true } });
        finished = true;
        emit({ kind: "completed", id, op, status: 200, ok: true });
      } catch {
        if (closed) return;
        finished = true;
        refuseHost("clipboard_unavailable", "Clipboard copy is unavailable in this browser.", true);
      } finally {
        if (!finished) emit({ kind: "aborted", id, op });
        copying = false;
        ids.delete(id);
      }
      return;
    }
    if (hostPrint) {
      const validPrintHeight =
        !Object.hasOwn(body, "height") ||
        (typeof body.height === "number" &&
          Number.isSafeInteger(body.height) &&
          body.height >= 1 &&
          body.height <= maxPrintHeight);
      if (!["id,op", "height,id,op"].includes(keys) || !validPrintHeight)
        return rejectLocal("invalid_keys", 400);
      const now = Date.now();
      if (!activated)
        return refuseHost(
          "user_activation_required",
          "Printing requires a recent click or key press.",
        );
      if (printing || now < nextPrintAt) {
        const retryAfterMs = printing ? printCooldownMs : Math.max(1, nextPrintAt - now);
        return rejectLocal("rate_limited", 429, {
          code: "rate_limited",
          message: printing
            ? "Rate limit reached: at most 1 print dialog at a time (1 already open). Close the current print dialog, then try again."
            : `Rate limit reached: at most 1 print request per ${formatDuration(printCooldownMs)} (1 already used). Try again in ${formatDuration(retryAfterMs)}.`,
          retryAfterMs,
        });
      }
      const printHeight = typeof body.height === "number" ? body.height : undefined;
      if (
        !hostActions?.print &&
        (typeof window === "undefined" || typeof window.print !== "function")
      )
        return refuseHost("print_unavailable", "Printing is unavailable in this browser.");
      printing = true;
      nextPrintAt = now + printCooldownMs;
      emit({ kind: "started", id, op });
      if (!closed) channel.port1.postMessage({ id, ok: true, value: { printed: true } });
      emit({ kind: "completed", id, op, status: 200, ok: true });
      if (hostActions?.print) {
        try {
          await hostActions.print(printHeight === undefined ? {} : { height: printHeight });
        } finally {
          printing = false;
        }
      } else {
        defaultPrint(printHeight === undefined ? {} : { height: printHeight });
      }
      return;
    }
    if (upload) {
      if (!(body.bytes instanceof ArrayBuffer)) return rejectLocal("invalid_keys", 400);
      if (body.bytes.byteLength > maxFileBytes) return rejectLocal("payload_too_large", 413);
      if (body.bytes.byteLength < 1) return rejectLocal("invalid_keys", 400);
    }
    let encoded: string;
    try {
      const checkTarget = upload
        ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "bytes"))
        : body;
      encoded = JSON.stringify(checkTarget);
    } catch {
      return rejectLocal("unserializable", 400);
    }
    const requestBytes = upload
      ? 4096
      : body.op === "backend.invoke"
        ? invokeRequestBytes
        : backend
          ? 128 * 1024
          : 16_384;
    if (new TextEncoder().encode(encoded).byteLength > requestBytes)
      return rejectLocal("payload_too_large", 413);
    const validAlias =
      !Object.hasOwn(body, "dataset") || (validDatasetKey(body.dataset) && body.dataset !== "");
    const validReadOnly = !Object.hasOwn(body, "readOnly") || body.readOnly === true;
    const valid =
      validAlias &&
      validReadOnly &&
      (body.op === "collection.list"
        ? ["id,limit,op", "afterPath,id,limit,op"].includes(keys)
        : body.op === "collection.create"
          ? keys === "fields,id,idempotencyKey,op"
          : body.op === "backend.invoke"
            ? [
                "id,idempotencyKey,input,op,operation",
                "dataset,id,idempotencyKey,input,op,operation",
                "id,idempotencyKey,input,op,operation,readOnly",
                "dataset,id,idempotencyKey,input,op,operation,readOnly",
              ].includes(keys)
            : body.op === "backend.attempt"
              ? ["id,op,operation,request", "dataset,id,op,operation,request"].includes(keys)
              : body.op === "backend.upload"
                ? [
                    "bytes,contentType,id,idempotencyKey,name,op",
                    "bytes,contentType,dataset,id,idempotencyKey,name,op",
                  ].includes(keys)
                : body.op === "backend.file"
                  ? [
                      "fileId,id,input,op,operation",
                      "dataset,fileId,id,input,op,operation",
                    ].includes(keys)
                  : false);
    if (!valid) return rejectLocal("invalid_keys", 400);
    const now = Date.now();
    backendTokens = Math.min(backendBurst, backendTokens + (now - updated) / backendRefillMs);
    fileTokens = Math.min(fileBurst, fileTokens + (now - updated) / fileRefillMs);
    collectionTokens = Math.min(
      collectionBurst,
      collectionTokens + (now - updated) / collectionRefillMs,
    );
    updated = now;
    if (pending >= maxPending)
      return rejectLocal("rate_limited", 429, {
        code: "rate_limited",
        message: `Rate limit reached: at most ${maxPending} concurrent requests allowed (${pending} currently in flight). Wait for an active request to finish, then try again.`,
      });
    const fileRead = body.op === "backend.file";
    const activeTokens = fileRead ? fileTokens : backend ? backendTokens : collectionTokens;
    if (activeTokens < 1) {
      const burst = fileRead ? fileBurst : backend ? backendBurst : collectionBurst;
      const refillMs = fileRead ? fileRefillMs : backend ? backendRefillMs : collectionRefillMs;
      const retryAfterMs = Math.max(1, Math.ceil((1 - activeTokens) * refillMs));
      const kind = fileRead ? "file" : backend ? "backend" : "collection";
      return rejectLocal("rate_limited", 429, {
        code: "rate_limited",
        message: `Rate limit reached: ${burst} of ${burst} ${kind} requests used in the ${formatDuration(burst * refillMs)} burst window (refills 1 request every ${formatDuration(refillMs)}). Try again in ${formatDuration(retryAfterMs)}.`,
        retryAfterMs,
      });
    }
    if (fileRead) fileTokens--;
    else if (backend) backendTokens--;
    else collectionTokens--;
    pending++;
    ids.add(id);
    emit({ kind: "started", id, op, ...opMeta });
    let finished = false;
    const finish = (status: number, ok: boolean, refusalCode?: string) => {
      finished = true;
      emit({
        kind: "completed",
        id,
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
        response.status === 200 &&
        response.headers.get("x-dohc-app-refusal") === "1" &&
        response.headers.get("content-type")?.split(";", 1)[0] === "application/json";
      if (!response.ok && !refusal) {
        const status = [400, 404, 409, 413, 429].includes(response.status) ? response.status : 503;
        if (status === 429) {
          let trustedError: { code: string; message: string; retryAfterMs?: number } | undefined;
          if (
            trustRateLimitDetails &&
            response.headers.get("content-type")?.split(";", 1)[0] === "application/json" &&
            response.body
          ) {
            const reader429 = response.body.getReader();
            const chunks429: Uint8Array[] = [];
            let size429 = 0;
            try {
              while (true) {
                const item = await reader429.read();
                if (closed) return;
                if (item.done) break;
                size429 += item.value.byteLength;
                if (size429 > 2048) throw Error();
                chunks429.push(item.value);
              }
              const raw = new Uint8Array(size429);
              let pos = 0;
              for (const chunk of chunks429) {
                raw.set(chunk, pos);
                pos += chunk.byteLength;
              }
              const parsed: unknown = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(raw),
              );
              if (record(parsed)) {
                const errKeys = Object.keys(parsed).sort().join();
                const validMsg =
                  parsed.code === "rate_limited" &&
                  typeof parsed.message === "string" &&
                  parsed.message.length > 0 &&
                  new TextEncoder().encode(parsed.message).byteLength <= 512 &&
                  !/[\u0000-\u001f\u007f]/.test(parsed.message);
                if (validMsg && errKeys === "code,message") {
                  trustedError = { code: "rate_limited", message: parsed.message as string };
                } else if (
                  validMsg &&
                  errKeys === "code,message,retryAfterMs" &&
                  typeof parsed.retryAfterMs === "number" &&
                  Number.isSafeInteger(parsed.retryAfterMs) &&
                  parsed.retryAfterMs >= 0 &&
                  parsed.retryAfterMs <= 3_600_000
                ) {
                  trustedError = {
                    code: "rate_limited",
                    message: parsed.message as string,
                    retryAfterMs: parsed.retryAfterMs,
                  };
                }
              }
            } catch {
              if (closed) return;
            } finally {
              await reader429.cancel().catch(() => {});
            }
          } else {
            await response.body?.cancel().catch(() => {});
          }
          if (trustedError) {
            reject(429, trustedError);
          } else {
            const retryHeader = response.headers.get("retry-after")?.trim() ?? "";
            const retrySec = /^\d{1,4}$/.test(retryHeader) ? Number(retryHeader) : null;
            const retryAfterMs =
              retrySec !== null && retrySec >= 1 && retrySec <= 3600 ? retrySec * 1000 : undefined;
            reject(429, {
              code: "rate_limited",
              message:
                retryAfterMs !== undefined
                  ? `Rate limit reached by app host (HTTP 429). Try again in ${formatDuration(retryAfterMs)}.`
                  : "Rate limit reached by app host (HTTP 429). Wait a moment and try again.",
              ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            });
          }
        } else {
          await response.body?.cancel().catch(() => {});
          reject(status);
        }
        return finish(status, false);
      }
      const binaryFile = !refusal && body.op === "backend.file";
      const responseBytes = refusal
        ? 8192
        : binaryFile
          ? maxFileBytes
          : body.op === "backend.invoke"
            ? invokeResultBytes
            : 1024 * 1024;
      let fileMeta: Record<string, unknown> | undefined;
      if (binaryFile) {
        const mime = response.headers.get("content-type")?.split(";", 1)[0];
        const rawMeta = response.headers.get("x-dohc-app-file");
        let parsedMeta: unknown = null;
        if (mime === "application/octet-stream" && rawMeta && rawMeta.length <= 4096) {
          try {
            parsedMeta = JSON.parse(decodeURIComponent(rawMeta));
          } catch {
            parsedMeta = null;
          }
        }
        if (
          !record(parsedMeta) ||
          Object.keys(parsedMeta).sort().join() !== "byteLength,contentType,fileId,name,sha256" ||
          typeof parsedMeta.fileId !== "string" ||
          typeof parsedMeta.name !== "string" ||
          typeof parsedMeta.contentType !== "string" ||
          typeof parsedMeta.sha256 !== "string" ||
          typeof parsedMeta.byteLength !== "number" ||
          !Number.isSafeInteger(parsedMeta.byteLength) ||
          parsedMeta.byteLength < 1 ||
          parsedMeta.byteLength > maxFileBytes
        ) {
          await response.body?.cancel().catch(() => {});
          reject(503);
          return finish(503, false);
        }
        fileMeta = parsedMeta;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        reject(503);
        return finish(503, false);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
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
      if (binaryFile) {
        if (!fileMeta || size !== fileMeta.byteLength) {
          reject(503);
          return finish(503, false);
        }
        if (!closed)
          channel.port1.postMessage(
            { id, ok: true, value: { file: fileMeta, bytes: bytes.buffer } },
            [bytes.buffer],
          );
        return finish(200, true);
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
      if (!finished) emit({ kind: "aborted", id, op, ...opMeta });
      pending--;
      ids.delete(id);
    }
  };
  channel.port1.start();
  return {
    notifyDatasetChanged(dataset: string, revision: number) {
      if (
        closed ||
        !loaded ||
        !validDatasetKey(dataset) ||
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      )
        return;
      channel.port1.postMessage({ kind: "dataset.changed", dataset, revision });
    },
  };
}
