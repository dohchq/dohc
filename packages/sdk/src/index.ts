export const DOHC_SDK_PROTOCOL = "dohc:sdk:v1";
export const DohcSdkErrorCodes = {
  hostUnavailable: "DOHC_HOST_UNAVAILABLE",
  hostMissingOrigin: "DOHC_HOST_MISSING_ORIGIN",
  hostTimeout: "DOHC_HOST_TIMEOUT",
  badResponse: "DOHC_BAD_RESPONSE",
  capabilityDisabled: "DOHC_CAPABILITY_DISABLED",
} as const;
export type DohcSdkErrorCode =
  (typeof DohcSdkErrorCodes)[keyof typeof DohcSdkErrorCodes] | (string & {});

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
  readonly code: DohcSdkErrorCode;

  constructor(code: DohcSdkErrorCode, message: string) {
    super(message);
    this.name = "DohcSdkError";
    this.code = code;
  }
}

let requestCounter = 0;

function createRequestId(): string {
  let random: string;
  try {
    random =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `fallback_${(++requestCounter).toString(36)}`;
  } catch {
    random = `fallback_${(++requestCounter).toString(36)}`;
  }
  return `dohc_${Date.now().toString(36)}_${random}`;
}

/**
 * Reads the dohc host origin injected into preview URLs. `file://` is accepted
 * only as the exact opaque host marker dohc emits; arbitrary file origins are
 * not normalized into broader trust.
 */
function targetOriginFromLocation(currentWindow: Window): string | null {
  try {
    const href = currentWindow.location?.href;
    if (!href) return null;
    const url = new URL(href);
    const origin = url.searchParams.get("dohcHostOrigin");
    if (!origin) return null;
    const parsed = new URL(origin);
    if (parsed.protocol === "file:" && origin === "file://") return origin;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {
    return null;
  }
  return null;
}

/**
 * Browser APIs require "*" for file:// postMessage targets. Source and
 * response-origin checks still guard replies, but request visibility is an
 * inherent file:// limitation.
 */
function postTargetOriginFor(targetOrigin: string): string {
  return targetOrigin === "file://" ? "*" : targetOrigin;
}

/**
 * Browser file:// frames report response origins as "null"; map that back to
 * the exact dohc file host marker while still rejecting spoofed responses from
 * other origins/sources.
 */
function responseOriginMatches(eventOrigin: string, targetOrigin: string): boolean {
  return eventOrigin === targetOrigin || (targetOrigin === "file://" && eventOrigin === "null");
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

  return {
    request(method, params) {
      const currentWindow =
        options.currentWindow ??
        (typeof window === "undefined" ? undefined : window);
      if (!currentWindow) {
        return Promise.reject(
          new DohcSdkError(
            DohcSdkErrorCodes.hostUnavailable,
            "dohc SDK is not running in a browser window.",
          ),
        );
      }
      const windowRef = currentWindow;
      const targetOrigin = options.targetOrigin ?? targetOriginFromLocation(windowRef);
      if (!targetOrigin) {
        return Promise.reject(
          new DohcSdkError(
            DohcSdkErrorCodes.hostMissingOrigin,
            "No dohc host origin is available for this site.",
          ),
        );
      }
      const resolvedTargetOrigin = targetOrigin;

      const targetWindow =
        options.targetWindow ??
        (windowRef.parent && windowRef.parent !== windowRef
          ? windowRef.parent
          : undefined);
      if (!targetWindow) {
        return Promise.reject(
          new DohcSdkError(
            DohcSdkErrorCodes.hostUnavailable,
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
              DohcSdkErrorCodes.hostTimeout,
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
          if (!responseOriginMatches(event.origin, resolvedTargetOrigin)) return;
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
        try {
          targetWindow.postMessage(message, postTargetOriginFor(resolvedTargetOrigin));
        } catch (error) {
          finish(
            undefined,
            new DohcSdkError(
              DohcSdkErrorCodes.hostUnavailable,
              `Failed to send dohc SDK request: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    isPlainRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

function hasBooleanEntry(value: Record<string, boolean>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isCapabilityMap(value: unknown): value is DohcCapabilityMap {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DohcCapabilityMap>;
  return (
    isBooleanRecord(candidate.files) &&
    hasBooleanEntry(candidate.files, "read") &&
    hasBooleanEntry(candidate.files, "write") &&
    isBooleanRecord(candidate.collections) &&
    hasBooleanEntry(candidate.collections, "read") &&
    isBooleanRecord(candidate.provenance) &&
    hasBooleanEntry(candidate.provenance, "record")
  );
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

  const readCapabilities = async () => {
    const result = await transport.request("capabilities");
    if (!isCapabilityMap(result)) {
      throw new DohcSdkError(
        DohcSdkErrorCodes.badResponse,
        "dohc host returned an invalid capabilities response.",
      );
    }
    return result;
  };

  return {
    capabilities: readCapabilities,
    files: {
      read: async (path: string) => {
        if (isAbsoluteWorkspacePath(path)) {
          throw new DohcSdkError(
            DohcSdkErrorCodes.badResponse,
            "File paths must be workspace-relative. Absolute paths are not allowed.",
          );
        }
        const capabilities = await readCapabilities();
        if (!capabilities.files.read) {
          throw new DohcSdkError(
            DohcSdkErrorCodes.capabilityDisabled,
            "dohc files.read capability is disabled by this host.",
          );
        }
        const result = (await transport.request("files.read", { path })) as {
          text?: unknown;
        };
        if (typeof result?.text !== "string") {
          throw new DohcSdkError(
            DohcSdkErrorCodes.badResponse,
            "dohc host returned an invalid file read response.",
          );
        }
        return result.text;
      },
    },
    collections: {
      get: (name: string) => ({
        list: async () => {
          // Authorization boundary: docs/security/authz-boundaries.md. The SDK
          // never accepts caller-supplied workspace/user identity here; the
          // host transport decides whether collections.read is available and
          // enforces workspace scope server-side before returning rows.
          const capabilities = await readCapabilities();
          if (!capabilities.collections.read) {
            throw new DohcSdkError(
              DohcSdkErrorCodes.capabilityDisabled,
              "dohc collections.read capability is disabled by this host.",
            );
          }
          const result = await transport.request("collections.list", { name });
          if (!Array.isArray(result)) {
            throw new DohcSdkError(
              DohcSdkErrorCodes.badResponse,
              "dohc host returned an invalid collection response.",
            );
          }
          if (!result.every(isPlainRecord)) {
            throw new DohcSdkError(
              DohcSdkErrorCodes.badResponse,
              "dohc host returned invalid collection item shapes.",
            );
          }
          return result;
        },
      }),
    },
    provenance: {
      record: async (summary: string) => {
        const capabilities = await readCapabilities();
        if (!capabilities.provenance.record) {
          throw new DohcSdkError(
            DohcSdkErrorCodes.capabilityDisabled,
            "dohc provenance.record capability is disabled by this host.",
          );
        }
        await transport.request("provenance.record", { summary });
      },
    },
  };
}

function isAbsoluteWorkspacePath(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(path)
  );
}

export type DohcClient = ReturnType<typeof createDohcClient>;

// Browser-only convenience client. In SSR or Node.js, import createDohcClient
// and provide an explicit transport/currentWindow instead.
export const dohc = createDohcClient();
