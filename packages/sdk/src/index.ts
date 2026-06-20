export const DOHC_SDK_PROTOCOL = "dohc:sdk:v1";

export type DohcCapabilityMap = {
  files: { read: boolean; write: boolean };
  collections: { read: boolean };
  provenance: { record: boolean };
};

export type DohcSdkRequestMessage = {
  protocol: typeof DOHC_SDK_PROTOCOL;
  id: string;
  method: string;
  params?: unknown;
};

export type DohcSdkResponseMessage =
  | {
      protocol: typeof DOHC_SDK_PROTOCOL;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      protocol: typeof DOHC_SDK_PROTOCOL;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface DohcTransport {
  request(method: string, params?: unknown): Promise<unknown>;
}

export type CreateDohcClientOptions = {
  transport?: DohcTransport;
  timeoutMs?: number;
  targetOrigin?: string;
  currentWindow?: Window;
  targetWindow?: Window;
};

export class DohcSdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DohcSdkError";
    this.code = code;
  }
}

function createRequestId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `dohc_${Date.now().toString(36)}_${random}`;
}

function isDohcSdkResponse(
  value: unknown,
  id: string,
): value is DohcSdkResponseMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DohcSdkResponseMessage>;
  if (candidate.protocol !== DOHC_SDK_PROTOCOL || candidate.id !== id) return false;
  if (candidate.ok === true) return "result" in candidate;
  if (candidate.ok === false) {
    const error = (candidate as { error?: unknown }).error;
    if (!error || typeof error !== "object") return false;
    const shaped = error as { code?: unknown; message?: unknown };
    return typeof shaped.code === "string" && typeof shaped.message === "string";
  }
  return false;
}

export function createPostMessageTransport(
  options: Omit<CreateDohcClientOptions, "transport"> = {},
): DohcTransport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const targetOrigin = options.targetOrigin ?? "*";

  return {
    request(method, params) {
      const currentWindow =
        options.currentWindow ??
        (typeof window === "undefined" ? undefined : window);
      if (!currentWindow) {
        return Promise.reject(
          new DohcSdkError(
            "DOHC_HOST_UNAVAILABLE",
            "dohc SDK is not running in a browser window.",
          ),
        );
      }
      const windowRef = currentWindow;

      const targetWindow =
        options.targetWindow ??
        (windowRef.parent && windowRef.parent !== windowRef
          ? windowRef.parent
          : undefined);
      if (!targetWindow) {
        return Promise.reject(
          new DohcSdkError(
            "DOHC_HOST_UNAVAILABLE",
            "No dohc host window is available for this site.",
          ),
        );
      }

      const id = createRequestId();
      const message: DohcSdkRequestMessage = {
        protocol: DOHC_SDK_PROTOCOL,
        id,
        method,
        params,
      };

      return new Promise((resolve, reject) => {
        const timer = windowRef.setTimeout(() => {
          windowRef.removeEventListener("message", onMessage);
          reject(
            new DohcSdkError(
              "DOHC_HOST_TIMEOUT",
              `dohc host did not answer ${method}.`,
            ),
          );
        }, timeoutMs);

        function finish(value: unknown, error?: DohcSdkError) {
          windowRef.clearTimeout(timer);
          windowRef.removeEventListener("message", onMessage);
          if (error) reject(error);
          else resolve(value);
        }

        function onMessage(event: MessageEvent) {
          if (event.source !== targetWindow) return;
          if (targetOrigin !== "*" && event.origin !== targetOrigin) return;
          if (!isDohcSdkResponse(event.data, id)) return;
          if (event.data.ok) finish(event.data.result);
          else {
            finish(
              undefined,
              new DohcSdkError(event.data.error.code, event.data.error.message),
            );
          }
        }

        windowRef.addEventListener("message", onMessage);
        targetWindow.postMessage(message, targetOrigin);
      });
    },
  };
}

export function createDohcClient(options: CreateDohcClientOptions = {}) {
  const transport =
    options.transport ??
    createPostMessageTransport({
      timeoutMs: options.timeoutMs,
      targetOrigin: options.targetOrigin,
      currentWindow: options.currentWindow,
      targetWindow: options.targetWindow,
    });

  return {
    capabilities: async () =>
      (await transport.request("capabilities")) as DohcCapabilityMap,
    files: {
      read: async (path: string) => {
        const result = (await transport.request("files.read", { path })) as {
          text?: unknown;
        };
        if (typeof result?.text !== "string") {
          throw new DohcSdkError(
            "DOHC_BAD_RESPONSE",
            "dohc host returned an invalid file read response.",
          );
        }
        return result.text;
      },
    },
    collections: {
      get: (name: string) => ({
        list: async () =>
          (await transport.request("collections.list", { name })) as unknown[],
      }),
    },
    provenance: {
      record: (summary: string) =>
        transport.request("provenance.record", { summary }),
    },
  };
}

export type DohcClient = ReturnType<typeof createDohcClient>;

export const dohc = createDohcClient();
