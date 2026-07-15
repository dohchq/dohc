export const DOHC_SDK_PROTOCOL = "dohc:sdk:v1";
export const DohcSdkErrorCodes = {
    hostUnavailable: "DOHC_HOST_UNAVAILABLE",
    hostMissingOrigin: "DOHC_HOST_MISSING_ORIGIN",
    hostTimeout: "DOHC_HOST_TIMEOUT",
    badResponse: "DOHC_BAD_RESPONSE",
    capabilityDisabled: "DOHC_CAPABILITY_DISABLED",
    invalidInput: "DOHC_INVALID_INPUT",
    aborted: "DOHC_ABORTED",
    subscriptionsUnsupported: "DOHC_SUBSCRIPTIONS_UNSUPPORTED",
    responseTruncated: "DOHC_RESPONSE_TRUNCATED",
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
const MAX_COLLECTION_NAME_LENGTH = 200;
const MAX_PROVENANCE_SUMMARY_LENGTH = 5000;
const MAX_METHOD_LENGTH = 200;
const MAX_QUERY_LENGTH = 100_000;
function createRequestId() {
    let random;
    try {
        random =
            typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `fallback_${(++requestCounter).toString(36)}`;
    }
    catch {
        random = `fallback_${(++requestCounter).toString(36)}`;
    }
    return `dohc_${Date.now().toString(36)}_${random}`;
}
/**
 * Reads the dohc host origin injected into preview URLs. `file://` is accepted
 * only as the exact opaque host marker dohc emits; arbitrary file origins are
 * not normalized into broader trust.
 */
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
/**
 * Browser APIs require "*" for file:// postMessage targets. Source and
 * response-origin checks still guard replies, but request visibility is an
 * inherent file:// limitation.
 */
function postTargetOriginFor(targetOrigin) {
    return targetOrigin === "file://" ? "*" : targetOrigin;
}
/**
 * Browser file:// frames report response origins as "null"; map that back to
 * the exact dohc file host marker while still rejecting spoofed responses from
 * other origins/sources.
 */
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
function isDohcSdkEvent(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (candidate.protocol === DOHC_SDK_PROTOCOL &&
        candidate.type === "event" &&
        typeof candidate.subscriptionId === "string" &&
        candidate.subscriptionId.length > 0 &&
        typeof candidate.event === "string" &&
        candidate.event.length > 0 &&
        "data" in candidate);
}
function assertRequestOptions(options) {
    if (options?.timeoutMs !== undefined &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Request timeoutMs must be a positive finite number.");
    }
}
function abortedError(method) {
    return new DohcSdkError(DohcSdkErrorCodes.aborted, `dohc request ${method} was aborted.`);
}
/**
 * Applies caller-local cancellation to shared work. The wrapped promise is
 * deliberately never canceled: capability discovery is cached across callers,
 * so one impatient caller must not poison or restart the cache fill for peers.
 */
function waitWithRequestOptions(promise, requestOptions, label) {
    assertRequestOptions(requestOptions);
    if (requestOptions?.signal?.aborted) {
        return Promise.reject(abortedError(label));
    }
    if (!requestOptions?.signal && requestOptions?.timeoutMs === undefined)
        return promise;
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = requestOptions?.timeoutMs === undefined
            ? undefined
            : globalThis.setTimeout(() => {
                rejectOnce(new DohcSdkError(DohcSdkErrorCodes.hostTimeout, `dohc host did not answer ${label}.`));
            }, requestOptions.timeoutMs);
        function cleanup() {
            if (timer !== undefined)
                globalThis.clearTimeout(timer);
            requestOptions?.signal?.removeEventListener("abort", onAbort);
        }
        function resolveOnce(value) {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        }
        function rejectOnce(error) {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        }
        function onAbort() {
            rejectOnce(abortedError(label));
        }
        requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
        if (requestOptions?.signal?.aborted)
            onAbort();
        promise.then(resolveOnce, rejectOnce);
    });
}
export function createPostMessageTransport(options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Default timeoutMs must be a positive finite number.");
    }
    const transport = {
        request(method, params, requestOptions) {
            assertMethod(method);
            assertRequestOptions(requestOptions);
            if (requestOptions?.signal?.aborted) {
                return Promise.reject(abortedError(method));
            }
            const currentWindow = options.currentWindow ??
                (typeof window === "undefined" ? undefined : window);
            if (!currentWindow) {
                return Promise.reject(new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, "dohc SDK is not running in a browser window."));
            }
            const windowRef = currentWindow;
            const targetOrigin = options.targetOrigin ?? targetOriginFromLocation(windowRef);
            if (!targetOrigin) {
                return Promise.reject(new DohcSdkError(DohcSdkErrorCodes.hostMissingOrigin, "No dohc host origin is available for this site."));
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
                let settled = false;
                const timer = windowRef.setTimeout(() => {
                    finish(undefined, new DohcSdkError(DohcSdkErrorCodes.hostTimeout, `dohc host did not answer ${method}.`));
                }, requestOptions?.timeoutMs ?? timeoutMs);
                function finish(value, error) {
                    if (settled)
                        return;
                    settled = true;
                    windowRef.clearTimeout(timer);
                    windowRef.removeEventListener("message", onMessage);
                    requestOptions?.signal?.removeEventListener("abort", onAbort);
                    if (error)
                        reject(error);
                    else
                        resolve(value);
                }
                function onAbort() {
                    finish(undefined, abortedError(method));
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
                requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
                try {
                    targetWindow.postMessage(message, postTargetOriginFor(resolvedTargetOrigin));
                }
                catch (error) {
                    finish(undefined, new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, `Failed to send dohc SDK request: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
        },
    };
    transport.subscribe = async (method, params, listener, requestOptions) => {
        assertMethod(method);
        if (typeof listener !== "function") {
            throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Subscription listener must be a function.");
        }
        assertRequestOptions(requestOptions);
        const currentWindow = options.currentWindow ?? (typeof window === "undefined" ? undefined : window);
        if (!currentWindow) {
            throw new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, "dohc SDK is not running in a browser window.");
        }
        const targetWindow = options.targetWindow ??
            (currentWindow.parent && currentWindow.parent !== currentWindow
                ? currentWindow.parent
                : undefined);
        const targetOrigin = options.targetOrigin ?? targetOriginFromLocation(currentWindow);
        if (!targetWindow || !targetOrigin) {
            throw new DohcSdkError(targetOrigin
                ? DohcSdkErrorCodes.hostUnavailable
                : DohcSdkErrorCodes.hostMissingOrigin, targetOrigin
                ? "No dohc host window is available for this site."
                : "No dohc host origin is available for this site.");
        }
        const result = await transport.request(method, params, requestOptions);
        if (!isPlainRecord(result) ||
            typeof result.subscriptionId !== "string" ||
            result.subscriptionId.length === 0) {
            throw new DohcSdkError(DohcSdkErrorCodes.badResponse, `dohc host returned an invalid subscription response for ${method}.`);
        }
        const subscriptionId = result.subscriptionId;
        let localActive = true;
        let remoteClosed = false;
        let pendingRemoteClose = null;
        const onMessage = (event) => {
            if (!localActive || event.source !== targetWindow)
                return;
            if (!responseOriginMatches(event.origin, targetOrigin))
                return;
            if (!isDohcSdkEvent(event.data))
                return;
            if (event.data.subscriptionId !== subscriptionId)
                return;
            listener({ event: event.data.event, data: event.data.data });
        };
        currentWindow.addEventListener("message", onMessage);
        const unsubscribe = async () => {
            if (localActive) {
                localActive = false;
                currentWindow.removeEventListener("message", onMessage);
                requestOptions?.signal?.removeEventListener("abort", onAbort);
            }
            if (remoteClosed)
                return;
            if (pendingRemoteClose)
                return pendingRemoteClose;
            const attempt = transport
                .request("subscriptions.unsubscribe", { subscriptionId })
                .then(() => {
                remoteClosed = true;
            })
                .finally(() => {
                pendingRemoteClose = null;
            });
            pendingRemoteClose = attempt;
            return attempt;
        };
        const onAbort = () => {
            void unsubscribe().catch(() => undefined);
        };
        requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
        if (requestOptions?.signal?.aborted)
            onAbort();
        return unsubscribe;
    };
    return transport;
}
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasControlCharacter(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
function assertMethod(method) {
    if (typeof method !== "string" ||
        method.trim().length === 0 ||
        method.length > MAX_METHOD_LENGTH ||
        hasControlCharacter(method)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `Method must be a non-empty string of ${MAX_METHOD_LENGTH} characters or fewer with no control characters.`);
    }
}
function assertWorkspacePath(path, label = "File paths") {
    if (typeof path !== "string" || path.trim().length === 0 || hasControlCharacter(path)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `${label} must be a non-empty workspace-relative path with no control characters.`);
    }
    if (isAbsoluteWorkspacePath(path)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `${label} must be workspace-relative. Absolute paths are not allowed.`);
    }
}
function assertUiTarget(target) {
    if (typeof target !== "string" ||
        target.trim().length === 0 ||
        target.length > MAX_QUERY_LENGTH ||
        hasControlCharacter(target)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `UI target must be a non-empty string of ${MAX_QUERY_LENGTH} characters or fewer with no control characters.`);
    }
}
function assertOptionalWorkspacePath(path, label = "File path") {
    if (path !== undefined)
        assertWorkspacePath(path, label);
}
function assertQuery(query, label = "Query") {
    if (typeof query !== "string" ||
        query.trim().length === 0 ||
        query.length > MAX_QUERY_LENGTH ||
        query.includes("\u0000")) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `${label} must be a non-empty string of ${MAX_QUERY_LENGTH} characters or fewer with no null characters.`);
    }
}
function assertCollectionName(name) {
    if (typeof name !== "string" || name.trim().length === 0) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Collection name must be a non-empty string.");
    }
    if (name.length > MAX_COLLECTION_NAME_LENGTH || hasControlCharacter(name)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `Collection name must be ${MAX_COLLECTION_NAME_LENGTH} characters or fewer with no control characters.`);
    }
}
function assertProvenanceSummary(summary) {
    if (typeof summary !== "string" || summary.trim().length === 0) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Provenance summary must be a non-empty string.");
    }
    if (summary.length > MAX_PROVENANCE_SUMMARY_LENGTH || hasControlCharacter(summary)) {
        throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, `Provenance summary must be ${MAX_PROVENANCE_SUMMARY_LENGTH} characters or fewer with no control characters.`);
    }
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
    const hasLegacyFloor = (isBooleanRecord(candidate.files) &&
        hasBooleanEntry(candidate.files, "read") &&
        hasBooleanEntry(candidate.files, "write") &&
        isBooleanRecord(candidate.collections) &&
        hasBooleanEntry(candidate.collections, "read") &&
        isBooleanRecord(candidate.provenance) &&
        hasBooleanEntry(candidate.provenance, "record"));
    if (!hasLegacyFloor)
        return false;
    return Object.values(value).every((group) => isBooleanRecord(group));
}
export function createDohcClient(options = {}) {
    const transport = options.transport ??
        createPostMessageTransport({
            timeoutMs: options.timeoutMs,
            targetOrigin: options.targetOrigin,
            currentWindow: options.currentWindow,
            targetWindow: options.targetWindow,
        });
    let cachedCapabilities = null;
    let pendingCapabilities = null;
    const readCapabilities = async () => {
        if (cachedCapabilities)
            return cachedCapabilities;
        if (pendingCapabilities)
            return pendingCapabilities;
        pendingCapabilities = (async () => {
            const result = await transport.request("capabilities");
            if (!isCapabilityMap(result)) {
                throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid capabilities response.");
            }
            cachedCapabilities = result;
            return result;
        })();
        try {
            return await pendingCapabilities;
        }
        finally {
            if (!cachedCapabilities)
                pendingCapabilities = null;
        }
    };
    const refreshCapabilities = async () => {
        cachedCapabilities = null;
        pendingCapabilities = null;
        const result = await transport.request("capabilities");
        if (!isCapabilityMap(result)) {
            throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid capabilities response.");
        }
        cachedCapabilities = result;
        return result;
    };
    const request = (method, params, requestOptions) => {
        assertMethod(method);
        assertRequestOptions(requestOptions);
        return transport.request(method, params, requestOptions);
    };
    const subscribe = async (method, params, listener, requestOptions) => {
        assertMethod(method);
        assertRequestOptions(requestOptions);
        if (!transport.subscribe) {
            throw new DohcSdkError(DohcSdkErrorCodes.subscriptionsUnsupported, "This dohc host transport does not support subscriptions.");
        }
        return transport.subscribe(method, params, listener, requestOptions);
    };
    const requireCapability = async (namespace, capability, requestOptions) => {
        assertRequestOptions(requestOptions);
        if (requestOptions?.signal?.aborted) {
            throw abortedError(`capabilities for ${namespace}.${capability}`);
        }
        const capabilities = await waitWithRequestOptions(readCapabilities(), requestOptions, `capabilities for ${namespace}.${capability}`);
        if (capabilities[namespace]?.[capability] !== true) {
            throw new DohcSdkError(DohcSdkErrorCodes.capabilityDisabled, `dohc ${namespace}.${capability} capability is disabled by this host.`);
        }
    };
    const listCollection = async (name, params = {}, requestOptions) => {
        assertRequestOptions(requestOptions);
        assertCollectionName(name);
        await requireCapability("collections", "read", requestOptions);
        const result = await request("collections.list", { ...params, name }, requestOptions);
        if (!Array.isArray(result)) {
            throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid collection response.");
        }
        if (!result.every(isPlainRecord)) {
            throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned invalid collection item shapes.");
        }
        return result;
    };
    const readFileInfo = async (path, requestOptions) => {
        assertRequestOptions(requestOptions);
        assertWorkspacePath(path);
        await requireCapability("files", "read", requestOptions);
        const result = (await request("files.read", { path }, requestOptions));
        if (typeof result?.text !== "string" ||
            (result.truncated !== undefined && typeof result.truncated !== "boolean")) {
            throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid file read response.");
        }
        return { text: result.text, truncated: result.truncated === true };
    };
    return {
        capabilities: refreshCapabilities,
        /** Generic escape hatch for host capabilities newer than this SDK. */
        request,
        /** Alias for request, suited to command-style host capabilities. */
        invoke: request,
        /** Generic event subscription escape hatch. */
        subscribe,
        files: {
            readInfo: readFileInfo,
            read: async (path, requestOptions) => {
                const result = await readFileInfo(path, requestOptions);
                if (result.truncated) {
                    throw new DohcSdkError(DohcSdkErrorCodes.responseTruncated, "dohc host returned only a bounded prefix of this file. Use files.readInfo() to inspect truncation explicitly; do not use partial text for read-modify-write.");
                }
                return result.text;
            },
            list: async (path, options = {}, requestOptions) => {
                assertRequestOptions(requestOptions);
                assertOptionalWorkspacePath(path, "Directory path");
                await requireCapability("files", "list", requestOptions);
                const params = { ...options };
                delete params.path;
                if (path !== undefined)
                    params.path = path;
                const result = await request("files.list", params, requestOptions);
                if (!Array.isArray(result) ||
                    !result.every((entry) => isPlainRecord(entry) && typeof entry.path === "string")) {
                    throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid file list response.");
                }
                return result;
            },
            write: async (path, text, options = {}, requestOptions) => {
                assertRequestOptions(requestOptions);
                assertWorkspacePath(path);
                if (typeof text !== "string") {
                    throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "File contents must be a string.");
                }
                await requireCapability("files", "write", requestOptions);
                // Reserved fields are authoritative after validation. The permissive
                // options bag is intentionally forward-compatible, but must never be
                // able to replace the path/text that were just validated above.
                return request("files.write", { ...options, path, text }, requestOptions);
            },
            watch: async (path, listener, requestOptions) => {
                assertRequestOptions(requestOptions);
                assertWorkspacePath(path);
                await requireCapability("files", "watch", requestOptions);
                return subscribe("files.watch", { path }, listener, requestOptions);
            },
        },
        workspace: {
            search: async (query, options = {}, requestOptions) => {
                assertRequestOptions(requestOptions);
                assertQuery(query, "Search query");
                assertOptionalWorkspacePath(options.path, "Search path");
                await requireCapability("workspace", "search", requestOptions);
                const result = await request("workspace.search", { ...options, query }, requestOptions);
                if (!Array.isArray(result) || !result.every(isPlainRecord)) {
                    throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid workspace search response.");
                }
                return result;
            },
        },
        databases: {
            read: async (input, requestOptions) => {
                assertRequestOptions(requestOptions);
                if (!isPlainRecord(input)) {
                    throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Database read input must be an object.");
                }
                assertWorkspacePath(input.path, "Database path");
                if (input.query !== undefined)
                    assertQuery(input.query, "Database query");
                await requireCapability("databases", "read", requestOptions);
                return request("databases.read", input, requestOptions);
            },
            edit: async (input, requestOptions) => {
                assertRequestOptions(requestOptions);
                if (!isPlainRecord(input)) {
                    throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Database edit input must be an object.");
                }
                assertWorkspacePath(input.path, "Database path");
                if (input.query !== undefined)
                    assertQuery(input.query, "Database query");
                if (input.query === undefined && !Array.isArray(input.operations)) {
                    throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Database edit input must include a query or operations array.");
                }
                if (Array.isArray(input.operations) && input.operations.length !== 1) {
                    throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Database edit operations must contain exactly one operation per call.");
                }
                await requireCapability("databases", "edit", requestOptions);
                return request("databases.edit", input, requestOptions);
            },
        },
        ui: {
            open: async (target, options = {}, requestOptions) => {
                assertRequestOptions(requestOptions);
                assertUiTarget(target);
                await requireCapability("ui", "open", requestOptions);
                return request("ui.open", { ...options, target }, requestOptions);
            },
        },
        collections: {
            list: listCollection,
            get: (name) => ({
                list: async (params = {}, requestOptions) => {
                    // Authorization boundary: docs/security/authz-boundaries.md. The SDK
                    // never accepts caller-supplied workspace/user identity here; the
                    // host transport decides whether collections.read is available and
                    // enforces workspace scope server-side before returning rows.
                    return listCollection(name, params, requestOptions);
                },
            }),
        },
        provenance: {
            record: async (value, requestOptions) => {
                assertRequestOptions(requestOptions);
                const record = typeof value === "string" ? { summary: value } : value;
                if (!isPlainRecord(record)) {
                    throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Provenance record must be a summary string or record object.");
                }
                assertProvenanceSummary(record.summary);
                await requireCapability("provenance", "record", requestOptions);
                await request("provenance.record", record, requestOptions);
            },
        },
    };
}
function isAbsoluteWorkspacePath(path) {
    return (path.startsWith("/") ||
        path.startsWith("\\") ||
        /^[A-Za-z]:[\\/]/.test(path) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path));
}
// Browser-only convenience client. In SSR or Node.js, import createDohcClient
// and provide an explicit transport/currentWindow instead.
export const dohc = createDohcClient();
