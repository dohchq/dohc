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

export interface DatasetClient {
  invoke<T = unknown>(
    operation: string,
    input?: unknown,
    idempotencyKey?: string,
  ): Promise<InvokeReply<T>>;
  read<T = unknown>(operation: string, input?: unknown): Promise<T>;
  upload(file: File | FileUploadInput, idempotencyKey: string): Promise<UploadReply>;
  file(fileId: string, operation: string, input?: unknown): Promise<FileReply>;
  attempt(operation: string, request: AttemptRequest): Promise<AttemptResult>;
}

export interface AppClient extends DatasetClient {
  dataset(alias: string): DatasetClient;
  close(): void;
}

export interface AppClientOptions {
  readonly invokeTimeoutMs?: number;
  readonly transferTimeoutMs?: number;
  readonly maxInFlight?: number;
  readonly port?: MessagePort;
}

const VALID_STATUSES: readonly number[] = [400, 404, 409, 413, 429, 503];
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
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

type Pending = {
  message: Record<string, unknown>;
  timeoutMs: number;
  check(value: unknown): boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

export function createAppClient(options: AppClientOptions = {}): AppClient {
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

  const receiveChannel = (event: MessageEvent) => {
    if (closed || port || event.source !== window.parent || event.source === window) return;
    if (
      !isRecord(event.data) ||
      event.data.kind !== "dohc-app-channel" ||
      event.data.version !== 1 ||
      event.ports.length !== 1
    ) {
      return;
    }
    window.removeEventListener("message", receiveChannel);
    bindPort(event.ports[0]!);
  };

  if (options.port) {
    bindPort(options.port);
  } else if (typeof window !== "undefined") {
    window.addEventListener("message", receiveChannel);
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

  const makeDatasetClient = (alias?: string): DatasetClient => {
    const scope = alias ? { dataset: alias } : {};
    return {
      invoke<T = unknown>(
        operation: string,
        input: unknown = {},
        idempotencyKey = `read:${crypto.randomUUID()}`,
      ): Promise<InvokeReply<T>> {
        return send(
          { op: "backend.invoke", ...scope, operation, idempotencyKey, input },
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
          { op: "backend.upload", ...scope, idempotencyKey, ...payload },
          transferTimeoutMs,
          (value) =>
            isRecord(value) && isFileMeta(value.file) && typeof value.replayed === "boolean",
        ) as Promise<UploadReply>;
      },
      file(fileId: string, operation: string, input: unknown = {}): Promise<FileReply> {
        return send(
          { op: "backend.file", ...scope, fileId, operation, input },
          transferTimeoutMs,
          (value) =>
            isRecord(value) && isFileMeta(value.file) && typeof value.bytesBase64 === "string",
        ) as Promise<FileReply>;
      },
      attempt(operation: string, request: AttemptRequest): Promise<AttemptResult> {
        return send(
          { op: "backend.attempt", ...scope, operation, request },
          invokeTimeoutMs,
          isAttemptResult,
        ) as Promise<AttemptResult>;
      },
    };
  };

  const root = makeDatasetClient();

  return {
    ...root,
    dataset(alias: string): DatasetClient {
      if (!ALIAS_PATTERN.test(alias)) {
        throw new Error(`Invalid dataset alias: ${alias}`);
      }
      return makeDatasetClient(alias);
    },
    close() {
      if (closed) return;
      closed = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("message", receiveChannel);
      }
      port?.close();
      for (const item of [...sent.values(), ...waiting]) {
        fail(item, 503);
      }
      sent.clear();
      waiting.length = 0;
    },
  };
}

const AppClientContext = createContext<AppClient | null>(null);

export interface AppProviderProps {
  readonly client?: AppClient;
  readonly children: ReactNode;
}

export function AppProvider({ client, children }: AppProviderProps) {
  const owned = useMemo(() => (client ? null : createAppClient()), [client]);
  const active = client ?? owned!;

  useEffect(() => {
    if (!owned) return;
    const onPageHide = () => owned.close();
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onPageHide, { once: true });
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
      owned.close();
    };
  }, [owned]);

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
  readonly dataset?: string;
  readonly enabled?: boolean;
}

export interface DatasetQueryState<T> {
  readonly data: T | undefined;
  readonly revision: number | null;
  readonly loading: boolean;
  readonly error: AppBackendError | null;
  reload(): void;
}

export function useDatasetQuery<T = unknown>(
  operation: string,
  input?: unknown,
  options?: DatasetQueryOptions,
): DatasetQueryState<T> {
  const client = useApp();
  const dataset = options?.dataset;
  const enabled = options?.enabled ?? true;
  const serializedInput = JSON.stringify(input ?? {});

  const [data, setData] = useState<T | undefined>(undefined);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<AppBackendError | null>(null);
  const [version, setVersion] = useState(0);
  const generation = useRef(0);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let alive = true;
    const token = ++generation.current;
    const parsedInput: unknown = JSON.parse(serializedInput);
    const target = dataset ? client.dataset(dataset) : client;
    setLoading(true);
    setError(null);
    target.invoke<T>(operation, parsedInput).then(
      (reply) => {
        if (!alive || token !== generation.current) return;
        setData(reply.result);
        setRevision(reply.revision);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!alive || token !== generation.current) return;
        setError(caught instanceof AppBackendError ? caught : new AppBackendError(503));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [client, dataset, enabled, operation, serializedInput, version]);

  return { data, revision, loading, error, reload };
}

export interface DatasetMutationOptions {
  readonly dataset?: string;
}

export interface DatasetMutationState<TInput, TResult> {
  mutate(input: TInput, idempotencyKey?: string): Promise<InvokeReply<TResult>>;
  retry(): Promise<InvokeReply<TResult> | null>;
  discardPending(): void;
  readonly pending: boolean;
  readonly uncertain: boolean;
  readonly error: AppBackendError | null;
}

export function useDatasetMutation<TInput = unknown, TResult = unknown>(
  operation: string,
  options?: DatasetMutationOptions,
): DatasetMutationState<TInput, TResult> {
  const client = useApp();
  const dataset = options?.dataset;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppBackendError | null>(null);
  const [retained, setRetained] = useState<{ input: TInput; key: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (input: TInput, key: string): Promise<InvokeReply<TResult>> => {
      setPending(true);
      setError(null);
      const target = dataset ? client.dataset(dataset) : client;
      try {
        const reply = await target.invoke<TResult>(operation, input, key);
        if (mounted.current) {
          setRetained(null);
          setPending(false);
        }
        return reply;
      } catch (caught) {
        const backendError = caught instanceof AppBackendError ? caught : new AppBackendError(503);
        if (mounted.current) {
          setError(backendError);
          setRetained(backendError.uncertain ? { input, key } : null);
          setPending(false);
        }
        throw backendError;
      }
    },
    [client, dataset, operation],
  );

  const mutate = useCallback(
    (input: TInput, idempotencyKey?: string) =>
      run(input, idempotencyKey ?? mutationKey(operation)),
    [operation, run],
  );

  const retry = useCallback(async () => {
    if (!retained) return null;
    return run(retained.input, retained.key);
  }, [retained, run]);

  const discardPending = useCallback(() => {
    setRetained(null);
    setError(null);
  }, []);

  return {
    mutate,
    retry,
    discardPending,
    pending,
    uncertain: retained !== null,
    error,
  };
}
