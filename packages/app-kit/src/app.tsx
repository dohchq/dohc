import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type BackendStatus = 400 | 404 | 409 | 413 | 429 | 503;

export interface BackendRefusal {
  readonly code: string;
  readonly message: string;
}

export interface InvokeReply<T = unknown> {
  readonly result: T;
  readonly revision: number;
  readonly replayed: boolean;
}

export interface UploadedFileMeta {
  readonly fileId: string;
  readonly name: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface UploadReply {
  readonly file: UploadedFileMeta;
  readonly replayed: boolean;
}

export interface FileReply {
  readonly file: UploadedFileMeta;
  readonly bytes: ArrayBuffer;
  blob(): Blob;
}

export interface FileUploadInput {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: ArrayBuffer | Uint8Array;
}

export type AttemptRequest =
  | { readonly action: "get" }
  | { readonly action: "save"; readonly idempotencyKey: string; readonly input: unknown }
  | { readonly action: "clear"; readonly token: string };

export interface RetainedAttempt {
  readonly token: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
}

export interface AttemptResult {
  readonly attempt: RetainedAttempt | null;
}

export interface PrintOptions {
  readonly height?: number;
}

export class AppBackendError extends Error {
  readonly status: BackendStatus;
  readonly refusal?: BackendRefusal;
  readonly retryAfterMs?: number;

<<<<<<< HEAD
  constructor(status: BackendStatus, refusal?: BackendRefusal, message?: string) {
    super(message ?? refusal?.message ?? `Request failed (${status}).`);
=======
  constructor(
    status: BackendStatus,
    refusal?: BackendRefusal,
    details?: { readonly message?: string; readonly retryAfterMs?: number },
  ) {
    super(
      refusal?.message ??
        details?.message ??
        (status === 429
          ? "Rate limit reached (HTTP 429). Wait a moment and try again."
          : `Request failed (${status}).`),
    );
>>>>>>> a45fcb8c9 (fix(app-runtime): add brokered copyText/print, query cancellation, and explicit 429s)
    this.name = "AppBackendError";
    this.status = status;
    this.refusal = refusal;
    this.retryAfterMs = details?.retryAfterMs;
  }

  get uncertain(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

export function isAppBackendError(error: unknown): error is AppBackendError {
  return error instanceof AppBackendError;
}

export interface DatasetChangeEvent {
  readonly dataset: string;
  readonly revision: number;
}

export interface AppClient {
  invoke<T = unknown>(
    operation: string,
    input?: unknown,
    idempotencyKey?: string,
    options?: { readonly readOnly?: boolean; readonly signal?: AbortSignal },
  ): Promise<InvokeReply<T>>;
  read<T = unknown>(
    operation: string,
    input?: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>;
  upload(file: File | FileUploadInput, idempotencyKey: string): Promise<UploadReply>;
  file(fileId: string, operation: string, input?: unknown): Promise<FileReply>;
  attempt(operation: string, request: AttemptRequest): Promise<AttemptResult>;
  copyText?(text: string): Promise<void>;
  print?(options?: PrintOptions): Promise<void>;
  dataset(alias: string): AppClient;
  subscribe?(listener: (event: DatasetChangeEvent) => void): () => void;
  close(): void;
}

export interface AppClientOptions {
  readonly invokeTimeoutMs?: number;
  readonly transferTimeoutMs?: number;
  readonly maxInFlight?: number;
  readonly port?: MessagePort;
}

const VALID_STATUSES: readonly number[] = [400, 404, 409, 413, 429, 503];
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_IN_FLIGHT = 3;
const DATASET_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function assertDatasetAlias(alias: string): string {
  if (
    typeof alias !== "string" ||
    !DATASET_ALIAS_PATTERN.test(alias) ||
    alias === "prototype" ||
    alias === "constructor"
  ) {
    throw new Error(`Invalid Collection alias "${String(alias)}".`);
  }
  return alias;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isFileMeta = (value: unknown): value is UploadedFileMeta =>
  isRecord(value) &&
  typeof value.fileId === "string" &&
  typeof value.name === "string" &&
  typeof value.contentType === "string" &&
  typeof value.byteLength === "number" &&
  typeof value.sha256 === "string";

const isAttemptResult = (value: unknown): value is AttemptResult => {
  if (!isRecord(value) || Object.keys(value).join() !== "attempt") return false;
  if (value.attempt === null) return true;
  const row = value.attempt;
  return (
    isRecord(row) &&
    typeof row.token === "string" &&
    typeof row.idempotencyKey === "string" &&
    "input" in row
  );
};

function parseStatusError(
  status: BackendStatus,
  error: unknown,
): { refusal?: BackendRefusal; details?: { message?: string; retryAfterMs?: number } } {
  if (!isRecord(error)) return {};
  const keys = Object.keys(error).sort().join();
  const validCode = typeof error.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(error.code);
  const validMessage =
    typeof error.message === "string" &&
    error.message.length > 0 &&
    new TextEncoder().encode(error.message).byteLength <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(error.message);
  if (!validCode || !validMessage) return {};
  if (status === 409) {
    return keys === "code,message"
      ? { refusal: { code: error.code as string, message: error.message as string } }
      : {};
  }
  if (status === 413) {
    return keys === "code,message" ? { details: { message: error.message as string } } : {};
  }
  if (status === 429) {
    if (keys === "code,message") return { details: { message: error.message as string } };
    if (
      keys === "code,message,retryAfterMs" &&
      typeof error.retryAfterMs === "number" &&
      Number.isSafeInteger(error.retryAfterMs) &&
      error.retryAfterMs >= 0 &&
      error.retryAfterMs <= 3_600_000
    ) {
      return {
        details: { message: error.message as string, retryAfterMs: error.retryAfterMs },
      };
    }
  }
  return {};
}

const MAX_PRINT_HEIGHT = 50_000;

function measurePrintHeight(): number | undefined {
  if (typeof document === "undefined") return undefined;
  const raw = Math.max(
    document.documentElement?.scrollHeight ?? 0,
    document.body?.scrollHeight ?? 0,
  );
  if (!Number.isFinite(raw) || raw < 1) return undefined;
  return Math.min(MAX_PRINT_HEIGHT, Math.ceil(raw));
}

function abortError(): Error {
  return new DOMException("The request was aborted.", "AbortError");
}

function safeFileName(name: string, contentType: string): string {
  const cleaned = name
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 120);
  if (cleaned && cleaned !== "." && cleaned !== "..") return cleaned;
  if (contentType === "application/pdf") return "file.pdf";
  if (contentType === "image/png") return "file.png";
  if (contentType === "image/jpeg") return "file.jpg";
  return "upload.bin";
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

async function normalizeUpload(
  file: File | FileUploadInput,
): Promise<{ name: string; contentType: string; bytes: ArrayBuffer }> {
  if (typeof File !== "undefined" && file instanceof File) {
    if (file.size < 1)
      throw new AppBackendError(400, undefined, "Attachment upload cannot be empty.");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new AppBackendError(
        413,
        undefined,
        `Attachment upload exceeded its limit of ${MAX_UPLOAD_BYTES} bytes. It used ${file.size} bytes.`,
      );
    }
    const contentType = file.type || "application/octet-stream";
    return {
      name: safeFileName(file.name, contentType),
      contentType,
      bytes: await file.arrayBuffer(),
    };
  }
  const input = file as FileUploadInput;
  const raw = input.bytes;
  if (!(raw instanceof Uint8Array) && !(raw instanceof ArrayBuffer))
    throw new AppBackendError(400, undefined, "Attachment upload cannot be empty.");
  if (raw.byteLength < 1)
    throw new AppBackendError(400, undefined, "Attachment upload cannot be empty.");
  if (raw.byteLength > MAX_UPLOAD_BYTES) {
    throw new AppBackendError(
      413,
      undefined,
      `Attachment upload exceeded its limit of ${MAX_UPLOAD_BYTES} bytes. It used ${raw.byteLength} bytes.`,
    );
  }
  const copy = raw instanceof Uint8Array ? raw.slice().buffer : raw.slice(0);
  return { name: input.name, contentType: input.contentType, bytes: copy };
}

export function mutationKey(kind: string): string {
  return `${kind}:${crypto.randomUUID()}`;
}

let capturedHostPort: MessagePort | null = null;
let capturedHostMaxInFlight: number | undefined;
const hostPortWaiters = new Set<(port: MessagePort, maxInFlight?: number) => void>();

function installHostChannelCapture() {
  if (typeof window === "undefined") return;
  const onMessage = (event: MessageEvent) => {
    if (capturedHostPort || event.source !== window.parent || event.source === window) return;
    if (
      !isRecord(event.data) ||
      event.data.kind !== "dohc-app-channel" ||
      event.data.version !== 1 ||
      event.ports.length !== 1
    ) {
      return;
    }
    capturedHostPort = event.ports[0]!;
    const hint = event.data.maxInFlight;
    capturedHostMaxInFlight =
      typeof hint === "number" && Number.isSafeInteger(hint) && hint >= 1 && hint <= 12
        ? hint
        : undefined;
    window.removeEventListener("message", onMessage);
    for (const waiter of hostPortWaiters) waiter(capturedHostPort, capturedHostMaxInFlight);
    hostPortWaiters.clear();
  };
  window.addEventListener("message", onMessage);
}

installHostChannelCapture();

type Pending = {
  message: Record<string, unknown>;
  transfer?: Transferable[];
  timeoutMs: number;
  counted: boolean;
  aborted: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  check(value: unknown): boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

const latestRevisionLookup = new WeakMap<AppClient, () => number | null>();

function createManagedClient(options: AppClientOptions, shared: boolean): AppClient {
  const invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  const transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  let maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

  let port: MessagePort | undefined;
  let closed = false;
  let inFlight = 0;
  const waiting: Pending[] = [];
  const waitingImmediate: Pending[] = [];
  const sent = new Map<string, Pending>();
  const latestRevisions = new Map<string, number>();
  const listeners = new Set<(event: DatasetChangeEvent) => void>();

  const recordDatasetChange = (dataset: string, revision: number) => {
    if (revision <= (latestRevisions.get(dataset) ?? -1)) return;
    latestRevisions.set(dataset, revision);
    for (const listener of [...listeners]) {
      try {
        listener({ dataset, revision });
      } catch {}
    }
  };

  const detachAbort = (item: Pending) => {
    if (item.signal && item.onAbort) {
      item.signal.removeEventListener("abort", item.onAbort);
      item.onAbort = undefined;
    }
  };

  const fail = (item: Pending, status: BackendStatus) => {
    clearTimeout(item.timer);
    detachAbort(item);
    if (!item.aborted) item.reject(new AppBackendError(status));
  };

  const dispatch = (item: Pending) => {
    const id = item.message.id as string;
    clearTimeout(item.timer);
    if (item.counted) inFlight += 1;
    sent.set(id, item);
    item.timer = setTimeout(() => {
      if (sent.delete(id)) {
        if (item.counted) inFlight -= 1;
        fail(item, 503);
        pump();
      }
    }, item.timeoutMs);
    try {
      if (item.transfer?.length) port!.postMessage(item.message, item.transfer);
      else port!.postMessage(item.message);
    } catch {
      sent.delete(id);
      if (item.counted) inFlight -= 1;
      fail(item, 503);
    }
  };

  const pump = () => {
    while (port && !closed && waitingImmediate.length > 0) {
      dispatch(waitingImmediate.shift()!);
    }
    while (port && !closed && inFlight < maxInFlight && waiting.length > 0) {
      dispatch(waiting.shift()!);
    }
  };

  const bindPort = (nextPort: MessagePort, hostMaxInFlight?: number) => {
    if (closed || port) return;
    if (options.maxInFlight === undefined && hostMaxInFlight !== undefined) {
      maxInFlight = hostMaxInFlight;
    }
    port = nextPort;
    port.onmessage = ({ data }: MessageEvent) => {
      if (!isRecord(data)) return;
      if (
        data.kind === "dataset.changed" &&
        typeof data.dataset === "string" &&
        typeof data.revision === "number" &&
        Number.isSafeInteger(data.revision) &&
        data.revision >= 0
      ) {
        recordDatasetChange(data.dataset, data.revision);
        return;
      }
      if (typeof data.id !== "string") return;
      const item = sent.get(data.id);
      if (!item) return;
      sent.delete(data.id);
      if (item.counted) inFlight -= 1;
      clearTimeout(item.timer);
      detachAbort(item);
      if (!item.aborted) {
        if (data.ok === true && item.check(data.value)) {
          item.resolve(data.value);
        } else {
          const status: BackendStatus =
            data.ok !== true && VALID_STATUSES.includes(data.status as number)
              ? (data.status as BackendStatus)
              : 503;
          const parsed = parseStatusError(status, data.error);
          item.reject(new AppBackendError(status, parsed.refusal, parsed.details));
        }
      }
      pump();
    };
    port.start();
    pump();
  };

  if (options.port) {
    bindPort(options.port);
  } else if (capturedHostPort) {
    bindPort(capturedHostPort, capturedHostMaxInFlight);
  } else {
    hostPortWaiters.add(bindPort);
  }

  const send = (
    message: Record<string, unknown>,
    timeoutMs: number,
    check: (value: unknown) => boolean,
    sendOptions?: {
      readonly immediate?: boolean;
      readonly signal?: AbortSignal;
      readonly transfer?: Transferable[];
    },
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new AppBackendError(503));
        return;
      }
      const signal = sendOptions?.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const queue = sendOptions?.immediate ? waitingImmediate : waiting;
      const item: Pending = {
        message: { id: crypto.randomUUID(), ...message },
        ...(sendOptions?.transfer?.length ? { transfer: sendOptions.transfer } : {}),
        timeoutMs,
        counted: !sendOptions?.immediate,
        aborted: false,
        signal,
        check,
        resolve,
        reject,
      };
      if (signal) {
        const onAbort = () => {
          if (item.aborted) return;
          item.aborted = true;
          detachAbort(item);
          const index = queue.indexOf(item);
          if (index >= 0) {
            queue.splice(index, 1);
            clearTimeout(item.timer);
          }
          reject(abortError());
        };
        item.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      item.timer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index >= 0) {
          queue.splice(index, 1);
          fail(item, 503);
        }
      }, timeoutMs);
      queue.push(item);
      pump();
    });

  const scopedViews = new Map<string, AppClient>();
  const closeRoot = () => {
    if (shared || closed) return;
    closed = true;
    hostPortWaiters.delete(bindPort);
    port?.close();
    for (const item of [...sent.values(), ...waitingImmediate, ...waiting]) {
      fail(item, 503);
    }
    sent.clear();
    waitingImmediate.length = 0;
    waiting.length = 0;
    listeners.clear();
  };
  const viewFor = (datasetAlias?: string): AppClient => {
    const scope = datasetAlias === undefined ? {} : { dataset: datasetAlias };
    const view: AppClient = {
      invoke<T = unknown>(
        operation: string,
        input: unknown = {},
        idempotencyKey = `read:${crypto.randomUUID()}`,
        invokeOptions?: { readonly readOnly?: boolean; readonly signal?: AbortSignal },
      ): Promise<InvokeReply<T>> {
        const readOnly = invokeOptions?.readOnly === true ? { readOnly: true } : {};
        return send(
          { op: "backend.invoke", ...scope, operation, idempotencyKey, input, ...readOnly },
          invokeTimeoutMs,
          (value) =>
            isRecord(value) &&
            "result" in value &&
            typeof value.revision === "number" &&
            typeof value.replayed === "boolean",
          invokeOptions?.signal ? { signal: invokeOptions.signal } : undefined,
        ) as Promise<InvokeReply<T>>;
      },
      async read<T = unknown>(
        operation: string,
        input: unknown = {},
        readOptions?: { readonly signal?: AbortSignal },
      ): Promise<T> {
        const reply = await this.invoke<T>(operation, input, `read:${crypto.randomUUID()}`, {
          readOnly: true,
          ...(readOptions?.signal ? { signal: readOptions.signal } : {}),
        });
        return reply.result;
      },
      async upload(file: File | FileUploadInput, idempotencyKey: string): Promise<UploadReply> {
        const payload = await normalizeUpload(file);
        return send(
          {
            op: "backend.upload",
            ...scope,
            idempotencyKey,
            name: payload.name,
            contentType: payload.contentType,
            bytes: payload.bytes,
          },
          transferTimeoutMs,
          (value) =>
            isRecord(value) && isFileMeta(value.file) && typeof value.replayed === "boolean",
          { transfer: [payload.bytes] },
        ) as Promise<UploadReply>;
      },
      async file(fileId: string, operation: string, input: unknown = {}): Promise<FileReply> {
        const raw = (await send(
          { op: "backend.file", ...scope, fileId, operation, input },
          transferTimeoutMs,
          (value) =>
            isRecord(value) &&
            isFileMeta(value.file) &&
            value.bytes instanceof ArrayBuffer &&
            value.bytes.byteLength === value.file.byteLength,
        )) as { file: UploadedFileMeta; bytes: ArrayBuffer };
        return {
          file: raw.file,
          bytes: raw.bytes,
          blob() {
            return new Blob([raw.bytes], { type: raw.file.contentType });
          },
        };
      },
      attempt(operation: string, request: AttemptRequest): Promise<AttemptResult> {
        return send(
          { op: "backend.attempt", ...scope, operation, request },
          invokeTimeoutMs,
          isAttemptResult,
        ) as Promise<AttemptResult>;
      },
      async copyText(text: string): Promise<void> {
        if (typeof text !== "string") throw new AppBackendError(400);
        await send(
          { op: "host.copy", text },
          invokeTimeoutMs,
          (value) => isRecord(value) && value.copied === true,
          { immediate: true },
        );
      },
      async print(printOptions?: PrintOptions): Promise<void> {
        let height: number | undefined;
        if (printOptions?.height !== undefined) {
          if (
            typeof printOptions.height !== "number" ||
            !Number.isSafeInteger(printOptions.height) ||
            printOptions.height < 1 ||
            printOptions.height > MAX_PRINT_HEIGHT
          ) {
            throw new AppBackendError(400);
          }
          height = printOptions.height;
        } else {
          height = measurePrintHeight();
        }
        await send(
          { op: "host.print", ...(height !== undefined ? { height } : {}) },
          invokeTimeoutMs,
          (value) => isRecord(value) && value.printed === true,
          { immediate: true },
        );
      },
      dataset(alias: string): AppClient {
        const checked = assertDatasetAlias(alias);
        let scoped = scopedViews.get(checked);
        if (!scoped) scopedViews.set(checked, (scoped = viewFor(checked)));
        return scoped;
      },
      subscribe(listener: (event: DatasetChangeEvent) => void): () => void {
        if (closed) return () => {};
        const wrapped =
          datasetAlias === undefined
            ? listener
            : (event: DatasetChangeEvent) => {
                if (event.dataset === datasetAlias) listener(event);
              };
        listeners.add(wrapped);
        return () => listeners.delete(wrapped);
      },
      close() {
        if (datasetAlias !== undefined) return;
        closeRoot();
      },
    };
    latestRevisionLookup.set(view, () =>
      datasetAlias !== undefined
        ? (latestRevisions.get(datasetAlias) ?? null)
        : latestRevisions.size > 0
          ? Math.max(...latestRevisions.values())
          : null,
    );
    return view;
  };
  return viewFor();
}

let sharedHostClient: AppClient | null = null;
let sharedPageHideWired = false;

function getSharedAppClient(options: AppClientOptions = {}): AppClient {
  if (!sharedHostClient) {
    sharedHostClient = createManagedClient(options, true);
    if (!sharedPageHideWired && typeof window !== "undefined") {
      sharedPageHideWired = true;
      const onPageHide = (event: PageTransitionEvent) => {
        if (event.persisted) return;
        window.removeEventListener("pagehide", onPageHide);
        const closing = sharedHostClient;
        sharedHostClient = null;
        sharedPageHideWired = false;
        if (closing && capturedHostPort) {
          capturedHostPort.close();
        }
      };
      window.addEventListener("pagehide", onPageHide);
    }
  }
  return sharedHostClient;
}

export function createAppClient(options: AppClientOptions = {}): AppClient {
  if (options.port) return createManagedClient(options, false);
  return getSharedAppClient(options);
}

export function copyText(text: string): Promise<void> {
  return getSharedAppClient().copyText!(text);
}

export function print(options?: PrintOptions): Promise<void> {
  return getSharedAppClient().print!(options);
}

const AppClientContext = createContext<AppClient | null>(null);

export interface AppProviderProps {
  readonly client?: AppClient;
  readonly children: ReactNode;
}

export function AppProvider({ client, children }: AppProviderProps) {
  const active = client ?? getSharedAppClient();
  return <AppClientContext.Provider value={active}>{children}</AppClientContext.Provider>;
}

export function useApp(): AppClient {
  const client = useContext(AppClientContext);
  if (!client) {
    throw new Error("Wrap your app in <AppProvider> before calling dohc/app hooks.");
  }
  return client;
}

export interface DatasetQueryOptions {
  readonly enabled?: boolean;
  readonly dataset?: string;
  readonly live?: boolean;
}

export interface DatasetMutationOptions {
  readonly dataset?: string;
}

export interface DatasetQueryState<T> {
  readonly data: T | undefined;
  readonly revision: number | null;
  readonly loading: boolean;
  readonly error: AppBackendError | null;
  reload(): void;
}

type ScopedQueryResult<T> = {
  readonly scope: string;
  readonly data: T | undefined;
  readonly revision: number | null;
  readonly loading: boolean;
  readonly error: AppBackendError | null;
};

let nextClientId = 1;
const clientIds = new WeakMap<AppClient, number>();
function clientIdOf(client: AppClient): number {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = nextClientId++;
    clientIds.set(client, id);
  }
  return id;
}

function resolveTargetClient(client: AppClient, dataset: string | undefined): AppClient | null {
  if (dataset === undefined) return client;
  try {
    return client.dataset(dataset);
  } catch {
    return null;
  }
}

export function useDatasetQuery<T = unknown>(
  operation: string,
  input?: unknown,
  options?: DatasetQueryOptions,
): DatasetQueryState<T> {
  const client = useApp();
  const datasetAlias = options?.dataset;
  const target = useMemo(() => resolveTargetClient(client, datasetAlias), [client, datasetAlias]);
  const enabled = options?.enabled ?? true;
  const live = options?.live ?? true;
  let serializedInput: string | null = null;
  if (enabled) {
    if (input === undefined) {
      serializedInput = "{}";
    } else {
      try {
        const encoded = JSON.stringify(input);
        serializedInput = encoded === undefined ? null : encoded;
      } catch {
        serializedInput = null;
      }
    }
  }
  const invalidInput = enabled && serializedInput === null;
  const invalidRequest = enabled && (target === null || invalidInput);
  const scope = `${target ? clientIdOf(target) : "invalid"}:${datasetAlias ?? ""}:${operation}:${
    !enabled ? "disabled" : invalidInput ? "invalid" : `s:${serializedInput}`
  }`;

  const [state, setState] = useState<ScopedQueryResult<T>>(() => ({
    scope,
    data: undefined,
    revision: null,
    loading: enabled && !invalidRequest,
    error: invalidRequest ? new AppBackendError(400) : null,
  }));
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  const syncLiveRef = useRef<(() => void) | null>(null);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    syncLiveRef.current?.();
  }, [live]);

  useEffect(() => {
    if (!enabled) {
      setState({ scope, data: undefined, revision: null, loading: false, error: null });
      return;
    }
    if (!target || serializedInput === null) {
      setState((current) =>
        current.scope === scope && current.error?.status === 400 && !current.loading
          ? current
          : {
              scope,
              data: undefined,
              revision: null,
              loading: false,
              error: new AppBackendError(400),
            },
      );
      return;
    }
    let alive = true,
      inFlight = false,
      currentRev: number | null = null,
      wantedRev: number | null = null,
      retryDelay = 250,
      retryTimer: ReturnType<typeof setTimeout> | undefined,
      activeController: AbortController | null = null;
    const clearRetry = () => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
    };
    const latestWanted = () =>
      Math.max(wantedRev ?? -1, latestRevisionLookup.get(target)?.() ?? -1);
    const parsedInput: unknown = JSON.parse(serializedInput);
    const runFetch = (background: boolean) => {
      if (!alive) return;
      clearRetry();
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      const token = ++generation.current;
      inFlight = true;
      if (!background) {
        retryDelay = 250;
        setState((current) =>
          current.scope === scope
            ? { ...current, loading: true, error: null }
            : { scope, data: undefined, revision: null, loading: true, error: null },
        );
      }
      target
        .invoke<T>(operation, parsedInput, undefined, { readOnly: true, signal: controller.signal })
        .then(
          (reply) => {
            if (!alive || token !== generation.current || controller.signal.aborted) return;
            inFlight = false;
            retryDelay = 250;
            currentRev = reply.revision;
            setState({
              scope,
              data: reply.result,
              revision: reply.revision,
              loading: false,
              error: null,
            });
            const wanted = latestWanted();
            if (wanted <= reply.revision) wantedRev = null;
            else if (liveRef.current) {
              wantedRev = wanted;
              runFetch(true);
            }
          },
          (caught: unknown) => {
            if (!alive || token !== generation.current || controller.signal.aborted) return;
            inFlight = false;
            const error = caught instanceof AppBackendError ? caught : new AppBackendError(503);
            setState((current) =>
              background && current.scope === scope
                ? { ...current, loading: false, error }
                : { scope, data: undefined, revision: null, loading: false, error },
            );
            if (
              background &&
              error.uncertain &&
              liveRef.current &&
              wantedRev !== null &&
              (currentRev === null || wantedRev > currentRev)
            ) {
              const delay = Math.max(retryDelay, Math.min(10_000, error.retryAfterMs ?? 0));
              retryDelay = Math.min(4_000, retryDelay * 2);
              retryTimer = setTimeout(() => {
                retryTimer = undefined;
                if (alive && liveRef.current && !inFlight) runFetch(true);
              }, delay);
            } else if (!background || !error.uncertain) {
              wantedRev = null;
            }
          },
        );
    };
    syncLiveRef.current = () => {
      if (!alive) return;
      if (!liveRef.current) {
        clearRetry();
        return;
      }
      const wanted = latestWanted();
      if (wanted >= 0 && (currentRev === null || wanted > currentRev) && !inFlight) {
        wantedRev = wanted;
        runFetch(true);
      }
    };
    const unsubscribe = target.subscribe?.((event) => {
      if (!alive) return;
      if (currentRev !== null && event.revision <= currentRev) return;
      wantedRev = Math.max(wantedRev ?? -1, event.revision);
      if (!liveRef.current || inFlight || retryTimer !== undefined) return;
      runFetch(true);
    });
    runFetch(false);
    return () => {
      alive = false;
      activeController?.abort();
      activeController = null;
      syncLiveRef.current = null;
      clearRetry();
      unsubscribe?.();
    };
  }, [enabled, operation, scope, serializedInput, target, version]);

  const matched = state.scope === scope;
  const invalidRequestError = invalidRequest ? new AppBackendError(400) : null;
  return {
    data: matched ? state.data : undefined,
    revision: matched ? state.revision : null,
    loading: matched ? state.loading : enabled && !invalidRequest,
    error: matched ? state.error : invalidRequestError,
    reload,
  };
}

export interface DatasetMutationState<TInput, TResult> {
  mutate(input: TInput, idempotencyKey?: string): Promise<InvokeReply<TResult>>;
  retry(): Promise<InvokeReply<TResult> | null>;
  discardPending(): void;
  readonly pending: boolean;
  readonly uncertain: boolean;
  readonly error: AppBackendError | null;
}

type RetainedSubmission = {
  readonly id: number;
  readonly scopeKey: string;
  readonly client: AppClient;
  readonly operation: string;
  readonly key: string;
  readonly payloadJson: string;
};

export function useDatasetMutation<TInput = unknown, TResult = unknown>(
  operation: string,
  options?: DatasetMutationOptions,
): DatasetMutationState<TInput, TResult> {
  const client = useApp();
  const datasetAlias = options?.dataset;
  const target = useMemo(() => resolveTargetClient(client, datasetAlias), [client, datasetAlias]);
  const scopeKey = `${clientIdOf(client)}:${datasetAlias ?? ""}`;
  const [inFlightByScope, setInFlightByScope] = useState<Record<string, number>>({});
  const [errorByScope, setErrorByScope] = useState<Record<string, AppBackendError | null>>({});
  const [retainedByScope, setRetainedByScope] = useState<
    Record<string, readonly RetainedSubmission[]>
  >({});
  const retainedByScopeRef = useRef<Record<string, readonly RetainedSubmission[]>>({});
  const nextAttemptId = useRef(1);
  const discardFloorByScope = useRef(new Map<string, number>());
  const inFlightRetries = useRef(new Map<number, Promise<InvokeReply<TResult>>>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const updateRetainedForScope = useCallback(
    (
      targetScope: string,
      updater: (current: readonly RetainedSubmission[]) => readonly RetainedSubmission[],
    ) => {
      const existing = retainedByScopeRef.current[targetScope] ?? [];
      const nextList = updater(existing);
      const nextMap = { ...retainedByScopeRef.current, [targetScope]: nextList };
      retainedByScopeRef.current = nextMap;
      if (mounted.current) {
        setRetainedByScope(nextMap);
      }
    },
    [],
  );

  const execute = useCallback(
    async (submission: RetainedSubmission): Promise<InvokeReply<TResult>> => {
      const targetScope = submission.scopeKey;
      let payload: unknown;
      try {
        payload = JSON.parse(submission.payloadJson);
      } catch {
        const badInput = new AppBackendError(400);
        const floor = discardFloorByScope.current.get(targetScope) ?? 0;
        if (mounted.current && submission.id >= floor) {
          setErrorByScope((current) => ({ ...current, [targetScope]: badInput }));
        }
        updateRetainedForScope(targetScope, (current) =>
          current.filter((item) => item.id !== submission.id),
        );
        throw badInput;
      }
      setInFlightByScope((current) => ({
        ...current,
        [targetScope]: (current[targetScope] ?? 0) + 1,
      }));
      setErrorByScope((current) => ({ ...current, [targetScope]: null }));
      try {
        const reply = await submission.client.invoke<TResult>(
          submission.operation,
          payload,
          submission.key,
        );
        updateRetainedForScope(targetScope, (current) =>
          current.filter((item) => item.id !== submission.id),
        );
        return reply;
      } catch (caught) {
        const backendError = caught instanceof AppBackendError ? caught : new AppBackendError(503);
        const floor = discardFloorByScope.current.get(targetScope) ?? 0;
        const eligible = submission.id >= floor;
        if (mounted.current && eligible) {
          setErrorByScope((current) => ({ ...current, [targetScope]: backendError }));
        }
        if (backendError.uncertain && eligible) {
          updateRetainedForScope(targetScope, (current) =>
            current.some((item) => item.id === submission.id) ? current : [...current, submission],
          );
        } else {
          updateRetainedForScope(targetScope, (current) =>
            current.filter((item) => item.id !== submission.id),
          );
        }
        throw backendError;
      } finally {
        if (mounted.current) {
          setInFlightByScope((current) => ({
            ...current,
            [targetScope]: Math.max(0, (current[targetScope] ?? 0) - 1),
          }));
        }
      }
    },
    [updateRetainedForScope],
  );

  const mutate = useCallback(
    async (input: TInput, idempotencyKey?: string) => {
      if (!target) {
        const badAlias = new AppBackendError(400);
        if (mounted.current) {
          setErrorByScope((current) => ({ ...current, [scopeKey]: badAlias }));
        }
        throw badAlias;
      }
      let payloadJson: string | undefined;
      try {
        payloadJson = input === undefined ? "{}" : JSON.stringify(input);
      } catch {
        payloadJson = undefined;
      }
      if (payloadJson === undefined) {
        const badInput = new AppBackendError(400);
        if (mounted.current) {
          setErrorByScope((current) => ({ ...current, [scopeKey]: badInput }));
        }
        throw badInput;
      }
      const submission: RetainedSubmission = {
        id: nextAttemptId.current++,
        scopeKey,
        client: target,
        operation,
        key: idempotencyKey ?? mutationKey(operation),
        payloadJson,
      };
      return execute(submission);
    },
    [execute, operation, scopeKey, target],
  );

  const retainedForScope = retainedByScope[scopeKey] ?? [];

  const retry = useCallback(async () => {
    const floor = discardFloorByScope.current.get(scopeKey) ?? 0;
    const next = (retainedByScopeRef.current[scopeKey] ?? []).find((item) => item.id >= floor);
    if (!next) return null;
    const active = inFlightRetries.current.get(next.id);
    if (active) return active;
    const promise = execute(next).finally(() => {
      if (inFlightRetries.current.get(next.id) === promise) {
        inFlightRetries.current.delete(next.id);
      }
    });
    inFlightRetries.current.set(next.id, promise);
    return promise;
  }, [execute, scopeKey]);

  const discardPending = useCallback(() => {
    discardFloorByScope.current.set(scopeKey, nextAttemptId.current);
    for (const item of retainedByScopeRef.current[scopeKey] ?? []) {
      inFlightRetries.current.delete(item.id);
    }
    updateRetainedForScope(scopeKey, () => []);
    setErrorByScope((current) => ({ ...current, [scopeKey]: null }));
  }, [scopeKey, updateRetainedForScope]);

  return {
    mutate,
    retry,
    discardPending,
    pending: (inFlightByScope[scopeKey] ?? 0) > 0,
    uncertain: retainedForScope.length > 0,
    error: errorByScope[scopeKey] ?? null,
  };
}
