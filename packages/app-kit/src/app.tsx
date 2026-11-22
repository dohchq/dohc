import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  readonly bytesBase64: string;
}

export interface FileUploadInput {
  readonly name: string;
  readonly contentType: string;
  readonly bytesBase64: string;
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

export class AppBackendError extends Error {
  readonly status: BackendStatus;
  readonly refusal?: BackendRefusal;

  constructor(status: BackendStatus, refusal?: BackendRefusal) {
    super(refusal?.message ?? `Request failed (${status}).`);
    this.name = "AppBackendError";
    this.status = status;
    this.refusal = refusal;
  }

  get uncertain(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

export function isAppBackendError(error: unknown): error is AppBackendError {
  return error instanceof AppBackendError;
}

export interface AppClient {
  invoke<T = unknown>(
    operation: string,
    input?: unknown,
    idempotencyKey?: string,
  ): Promise<InvokeReply<T>>;
  read<T = unknown>(operation: string, input?: unknown): Promise<T>;
  upload(file: File | FileUploadInput, idempotencyKey: string): Promise<UploadReply>;
  file(fileId: string, operation: string, input?: unknown): Promise<FileReply>;
  attempt(operation: string, request: AttemptRequest): Promise<AttemptResult>;
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

function parseRefusal(status: BackendStatus, error: unknown): BackendRefusal | undefined {
  if (
    status !== 409 ||
    !isRecord(error) ||
    Object.keys(error).sort().join() !== "code,message" ||
    typeof error.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(error.code) ||
    typeof error.message !== "string" ||
    error.message.length === 0 ||
    new TextEncoder().encode(error.message).byteLength > 1024 ||
    /[\u0000-\u001f\u007f]/.test(error.message)
  ) {
    return undefined;
  }
  return { code: error.code, message: error.message };
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

async function normalizeUpload(file: File | FileUploadInput): Promise<FileUploadInput> {
  if (typeof File !== "undefined" && file instanceof File) {
    const contentType = file.type || "application/octet-stream";
    return {
      name: safeFileName(file.name, contentType),
      contentType,
      bytesBase64: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    };
  }
  return file as FileUploadInput;
}

export function mutationKey(kind: string): string {
  return `${kind}:${crypto.randomUUID()}`;
}

// Capture the host's one-shot channel port at module load so late or remounted providers never miss it.
let capturedHostPort: MessagePort | null = null;
const hostPortWaiters = new Set<(port: MessagePort) => void>();

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
    window.removeEventListener("message", onMessage);
    for (const waiter of hostPortWaiters) waiter(capturedHostPort);
    hostPortWaiters.clear();
  };
  window.addEventListener("message", onMessage);
}

installHostChannelCapture();

type Pending = {
  message: Record<string, unknown>;
  timeoutMs: number;
  check(value: unknown): boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

function createManagedClient(options: AppClientOptions, shared: boolean): AppClient {
  const invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
  const transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

  let port: MessagePort | undefined;
  let closed = false;
  let inFlight = 0;
  const waiting: Pending[] = [];
  const sent = new Map<string, Pending>();

  const fail = (item: Pending, status: BackendStatus) => {
    clearTimeout(item.timer);
    item.reject(new AppBackendError(status));
  };

  const pump = () => {
    while (port && !closed && inFlight < maxInFlight && waiting.length > 0) {
      const item = waiting.shift()!;
      const id = item.message.id as string;
      clearTimeout(item.timer);
      inFlight += 1;
      sent.set(id, item);
      item.timer = setTimeout(() => {
        if (sent.delete(id)) {
          inFlight -= 1;
          fail(item, 503);
          pump();
        }
      }, item.timeoutMs);
      try {
        port.postMessage(item.message);
      } catch {
        sent.delete(id);
        inFlight -= 1;
        fail(item, 503);
      }
    }
  };

  const bindPort = (nextPort: MessagePort) => {
    if (closed || port) return;
    port = nextPort;
    port.onmessage = ({ data }: MessageEvent) => {
      if (!isRecord(data) || typeof data.id !== "string") return;
      const item = sent.get(data.id);
      if (!item) return;
      sent.delete(data.id);
      inFlight -= 1;
      clearTimeout(item.timer);
      if (data.ok === true && item.check(data.value)) {
        item.resolve(data.value);
      } else {
        const status: BackendStatus =
          data.ok !== true && VALID_STATUSES.includes(data.status as number)
            ? (data.status as BackendStatus)
            : 503;
        item.reject(new AppBackendError(status, parseRefusal(status, data.error)));
      }
      pump();
    };
    port.start();
    pump();
  };

  if (options.port) {
    bindPort(options.port);
  } else if (capturedHostPort) {
    bindPort(capturedHostPort);
  } else {
    hostPortWaiters.add(bindPort);
  }

  const send = (
    message: Record<string, unknown>,
    timeoutMs: number,
    check: (value: unknown) => boolean,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new AppBackendError(503));
        return;
      }
      const item: Pending = {
        message: { id: crypto.randomUUID(), ...message },
        timeoutMs,
        check,
        resolve,
        reject,
      };
      item.timer = setTimeout(() => {
        const index = waiting.indexOf(item);
        if (index >= 0) {
          waiting.splice(index, 1);
          fail(item, 503);
        }
      }, timeoutMs);
      waiting.push(item);
      pump();
    });

  return {
    invoke<T = unknown>(
      operation: string,
      input: unknown = {},
      idempotencyKey = `read:${crypto.randomUUID()}`,
    ): Promise<InvokeReply<T>> {
      return send(
        { op: "backend.invoke", operation, idempotencyKey, input },
        invokeTimeoutMs,
        (value) =>
          isRecord(value) &&
          "result" in value &&
          typeof value.revision === "number" &&
          typeof value.replayed === "boolean",
      ) as Promise<InvokeReply<T>>;
    },
    async read<T = unknown>(operation: string, input: unknown = {}): Promise<T> {
      const reply = await this.invoke<T>(operation, input, `read:${crypto.randomUUID()}`);
      return reply.result;
    },
    async upload(file: File | FileUploadInput, idempotencyKey: string): Promise<UploadReply> {
      const payload = await normalizeUpload(file);
      return send(
        { op: "backend.upload", idempotencyKey, ...payload },
        transferTimeoutMs,
        (value) => isRecord(value) && isFileMeta(value.file) && typeof value.replayed === "boolean",
      ) as Promise<UploadReply>;
    },
    file(fileId: string, operation: string, input: unknown = {}): Promise<FileReply> {
      return send(
        { op: "backend.file", fileId, operation, input },
        transferTimeoutMs,
        (value) =>
          isRecord(value) && isFileMeta(value.file) && typeof value.bytesBase64 === "string",
      ) as Promise<FileReply>;
    },
    attempt(operation: string, request: AttemptRequest): Promise<AttemptResult> {
      return send(
        { op: "backend.attempt", operation, request },
        invokeTimeoutMs,
        isAttemptResult,
      ) as Promise<AttemptResult>;
    },
    close() {
      // The shared host port belongs to the iframe lifetime; only explicit ports close on demand.
      if (shared || closed) return;
      closed = true;
      hostPortWaiters.delete(bindPort);
      port?.close();
      for (const item of [...sent.values(), ...waiting]) {
        fail(item, 503);
      }
      sent.clear();
      waiting.length = 0;
    },
  };
}

let sharedHostClient: AppClient | null = null;
let sharedPageHideWired = false;

function getSharedAppClient(options: AppClientOptions = {}): AppClient {
  if (!sharedHostClient) {
    sharedHostClient = createManagedClient(options, true);
    if (!sharedPageHideWired && typeof window !== "undefined") {
      sharedPageHideWired = true;
      window.addEventListener(
        "pagehide",
        () => {
          const closing = sharedHostClient;
          sharedHostClient = null;
          sharedPageHideWired = false;
          if (closing && capturedHostPort) {
            capturedHostPort.close();
          }
        },
        { once: true },
      );
    }
  }
  return sharedHostClient;
}

export function createAppClient(options: AppClientOptions = {}): AppClient {
  if (options.port) return createManagedClient(options, false);
  return getSharedAppClient(options);
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

export function useDatasetQuery<T = unknown>(
  operation: string,
  input?: unknown,
  options?: DatasetQueryOptions,
): DatasetQueryState<T> {
  const client = useApp();
  const enabled = options?.enabled ?? true;
  const serializedInput = input === undefined ? "{}" : JSON.stringify(input);
  const scope = `${clientIdOf(client)}:${operation}:${serializedInput}`;

  const [state, setState] = useState<ScopedQueryResult<T>>(() => ({
    scope,
    data: undefined,
    revision: null,
    loading: enabled,
    error: null,
  }));
  const [version, setVersion] = useState(0);
  const generation = useRef(0);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ scope, data: undefined, revision: null, loading: false, error: null });
      return;
    }
    let alive = true;
    const token = ++generation.current;
    const parsedInput: unknown = JSON.parse(serializedInput);
    setState((current) =>
      current.scope === scope
        ? { ...current, loading: true, error: null }
        : { scope, data: undefined, revision: null, loading: true, error: null },
    );
    client.invoke<T>(operation, parsedInput).then(
      (reply) => {
        if (!alive || token !== generation.current) return;
        setState({
          scope,
          data: reply.result,
          revision: reply.revision,
          loading: false,
          error: null,
        });
      },
      (caught: unknown) => {
        if (!alive || token !== generation.current) return;
        setState({
          scope,
          data: undefined,
          revision: null,
          loading: false,
          error: caught instanceof AppBackendError ? caught : new AppBackendError(503),
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [client, enabled, operation, scope, serializedInput, version]);

  const matched = state.scope === scope;
  return {
    data: matched ? state.data : undefined,
    revision: matched ? state.revision : null,
    loading: matched ? state.loading : enabled,
    error: matched ? state.error : null,
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
  readonly client: AppClient;
  readonly operation: string;
  readonly key: string;
  readonly payloadJson: string;
};

export function useDatasetMutation<TInput = unknown, TResult = unknown>(
  operation: string,
): DatasetMutationState<TInput, TResult> {
  const client = useApp();
  const [inFlightCount, setInFlightCount] = useState(0);
  const [error, setError] = useState<AppBackendError | null>(null);
  const [retained, setRetained] = useState<readonly RetainedSubmission[]>([]);
  const nextAttemptId = useRef(1);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const execute = useCallback(
    async (submission: RetainedSubmission): Promise<InvokeReply<TResult>> => {
      let payload: unknown;
      try {
        payload = JSON.parse(submission.payloadJson);
      } catch {
        const badInput = new AppBackendError(400);
        if (mounted.current) setError(badInput);
        throw badInput;
      }
      setInFlightCount((count) => count + 1);
      setError(null);
      try {
        const reply = await submission.client.invoke<TResult>(
          submission.operation,
          payload,
          submission.key,
        );
        if (mounted.current) {
          setRetained((current) => current.filter((item) => item.id !== submission.id));
        }
        return reply;
      } catch (caught) {
        const backendError = caught instanceof AppBackendError ? caught : new AppBackendError(503);
        if (mounted.current) {
          setError(backendError);
          if (backendError.uncertain) {
            setRetained((current) =>
              current.some((item) => item.id === submission.id)
                ? current
                : [...current, submission],
            );
          } else {
            setRetained((current) => current.filter((item) => item.id !== submission.id));
          }
        }
        throw backendError;
      } finally {
        if (mounted.current) {
          setInFlightCount((count) => Math.max(0, count - 1));
        }
      }
    },
    [],
  );

  const mutate = useCallback(
    async (input: TInput, idempotencyKey?: string) => {
      let payloadJson: string | undefined;
      try {
        payloadJson = input === undefined ? "{}" : JSON.stringify(input);
      } catch {
        payloadJson = undefined;
      }
      if (payloadJson === undefined) {
        const badInput = new AppBackendError(400);
        if (mounted.current) setError(badInput);
        throw badInput;
      }
      const submission: RetainedSubmission = {
        id: nextAttemptId.current++,
        client,
        operation,
        key: idempotencyKey ?? mutationKey(operation),
        payloadJson,
      };
      return execute(submission);
    },
    [client, execute, operation],
  );

  const retry = useCallback(async () => {
    const next = retained[0];
    if (!next) return null;
    return execute(next);
  }, [execute, retained]);

  const discardPending = useCallback(() => {
    setRetained([]);
    setError(null);
  }, []);

  return {
    mutate,
    retry,
    discardPending,
    pending: inFlightCount > 0,
    uncertain: retained.length > 0,
    error,
  };
}
