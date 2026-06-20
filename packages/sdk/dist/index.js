export const DOHC_SDK_PROTOCOL = "dohc:sdk:v1";
export const DohcSdkErrorCodes = {
    hostUnavailable: "DOHC_HOST_UNAVAILABLE",
    hostTimeout: "DOHC_HOST_TIMEOUT",
    badResponse: "DOHC_BAD_RESPONSE",
};
export class DohcSdkError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "DohcSdkError";
        this.code = code;
    }
}
let requestCounter = 0;
function createRequestId() {
    const random = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `fallback_${(++requestCounter).toString(36)}`;
    return `dohc_${Date.now().toString(36)}_${random}`;
}
function targetOriginFromLocation(currentWindow) {
    try {
        const href = currentWindow.location?.href;
        if (!href)
            return null;
        const url = new URL(href);
        const origin = url.searchParams.get("dohcHostOrigin");
        if (!origin)
            return null;
        const parsed = new URL(origin);
        if (parsed.protocol === "file:" && origin === "file://")
            return origin;
        if (parsed.protocol === "http:" || parsed.protocol === "https:")
            return parsed.origin;
    }
    catch {
        return null;
    }
    return null;
}
function postTargetOriginFor(targetOrigin) {
    // Browser APIs require "*" for file:// postMessage targets. The paired source
    // and response-origin checks below still guard replies, but request visibility
    // is an inherent file:// limitation.
    return targetOrigin === "file://" ? "*" : targetOrigin;
}
function responseOriginMatches(eventOrigin, targetOrigin) {
    return eventOrigin === targetOrigin || (targetOrigin === "file://" && eventOrigin === "null");
}
function isDohcSdkResponse(value, id) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    if (candidate.protocol !== DOHC_SDK_PROTOCOL || candidate.id !== id)
        return false;
    if (candidate.ok === true)
        return "result" in candidate;
    if (candidate.ok === false) {
        const error = candidate.error;
        if (!error || typeof error !== "object")
            return false;
        const shaped = error;
        return typeof shaped.code === "string" && typeof shaped.message === "string";
    }
    return false;
}
export function createPostMessageTransport(options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    return {
        request(method, params) {
            const currentWindow = options.currentWindow ??
                (typeof window === "undefined" ? undefined : window);
            if (!currentWindow) {
                return Promise.reject(new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, "dohc SDK is not running in a browser window."));
            }
            const windowRef = currentWindow;
            const targetOrigin = options.targetOrigin ?? targetOriginFromLocation(windowRef);
            if (!targetOrigin) {
                return Promise.reject(new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, "No dohc host origin is available for this site."));
            }
            const resolvedTargetOrigin = targetOrigin;
            const targetWindow = options.targetWindow ??
                (windowRef.parent && windowRef.parent !== windowRef
                    ? windowRef.parent
                    : undefined);
            if (!targetWindow) {
                return Promise.reject(new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, "No dohc host window is available for this site."));
            }
            const id = createRequestId();
            const message = {
                protocol: DOHC_SDK_PROTOCOL,
                id,
                method,
                params,
            };
            return new Promise((resolve, reject) => {
                const timer = windowRef.setTimeout(() => {
                    windowRef.removeEventListener("message", onMessage);
                    reject(new DohcSdkError(DohcSdkErrorCodes.hostTimeout, `dohc host did not answer ${method}.`));
                }, timeoutMs);
                function finish(value, error) {
                    windowRef.clearTimeout(timer);
                    windowRef.removeEventListener("message", onMessage);
                    if (error)
                        reject(error);
                    else
                        resolve(value);
                }
                function onMessage(event) {
                    if (event.source !== targetWindow)
                        return;
                    if (!responseOriginMatches(event.origin, resolvedTargetOrigin))
                        return;
                    if (!isDohcSdkResponse(event.data, id))
                        return;
                    if (event.data.ok)
                        finish(event.data.result);
                    else {
                        finish(undefined, new DohcSdkError(event.data.error.code, event.data.error.message));
                    }
                }
                windowRef.addEventListener("message", onMessage);
                targetWindow.postMessage(message, postTargetOriginFor(resolvedTargetOrigin));
            });
        },
    };
}
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isBooleanRecord(value) {
    return (isPlainRecord(value) &&
        Object.values(value).every((entry) => typeof entry === "boolean"));
}
function hasBooleanEntry(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isCapabilityMap(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (isBooleanRecord(candidate.files) &&
        hasBooleanEntry(candidate.files, "read") &&
        hasBooleanEntry(candidate.files, "write") &&
        isBooleanRecord(candidate.collections) &&
        hasBooleanEntry(candidate.collections, "read") &&
        isBooleanRecord(candidate.provenance) &&
        hasBooleanEntry(candidate.provenance, "record"));
}
export function createDohcClient(options = {}) {
    const transport = options.transport ??
        createPostMessageTransport({
            timeoutMs: options.timeoutMs,
            targetOrigin: options.targetOrigin,
            currentWindow: options.currentWindow,
            targetWindow: options.targetWindow,
        });
    return {
        capabilities: async () => {
            const result = await transport.request("capabilities");
            if (!isCapabilityMap(result)) {
                throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid capabilities response.");
            }
            return result;
        },
        files: {
            read: async (path) => {
                const result = (await transport.request("files.read", { path }));
                if (typeof result?.text !== "string") {
                    throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid file read response.");
                }
                return result.text;
            },
        },
        collections: {
            get: (name) => ({
                list: async () => {
                    const result = await transport.request("collections.list", { name });
                    if (!Array.isArray(result)) {
                        throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid collection response.");
                    }
                    if (!result.every(isPlainRecord)) {
                        throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned invalid collection item shapes.");
                    }
                    return result;
                },
            }),
        },
        provenance: {
            record: async (summary) => {
                await transport.request("provenance.record", { summary });
            },
        },
    };
}
export const dohc = createDohcClient();
