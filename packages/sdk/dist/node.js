import { createInterface } from "node:readline";
import { DohcSdkError, DohcSdkErrorCodes, createDohcClient, } from "./index.js";
import { abortedError, assertRequestOptions } from "./requestOptions.js";
export { createDohcClient };
export const PLUGIN_CHILD_PROCESS_METHODS = {
    spawn: "childProcesses.spawn",
    subscribeOutput: "childProcesses.output.subscribe",
    send: "childProcesses.send",
    logs: "childProcesses.logs",
    wait: "childProcesses.wait",
    terminate: "childProcesses.terminate",
    unsubscribe: "subscriptions.unsubscribe",
};
const DEFAULT_TIMEOUT_MS = 10_000;
const streamBindings = new WeakMap();
let parentPortBinding = null;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRpcId(value) {
    return typeof value === "string" || typeof value === "number";
}
function isSdkSubscriptionEvent(value) {
    return (isRecord(value) &&
        typeof value.subscriptionId === "string" &&
        value.subscriptionId.length > 0 &&
        typeof value.event === "string" &&
        value.event.length > 0 &&
        "data" in value);
}
function createTransport(sendMessage, receiveMessages) {
    const handlers = new Map();
    const pending = new Map();
    const subscriptionListeners = new Map();
    const queuedSubscriptionEvents = new Map();
    let nextId = 1;
    const queueSubscriptionEvent = (subscriptionId, event) => {
        const queued = queuedSubscriptionEvents.get(subscriptionId) ?? [];
        queued.push(event);
        if (queued.length > 200)
            queued.shift();
        queuedSubscriptionEvents.set(subscriptionId, queued);
    };
    const handleSdkEvent = (params) => {
        if (!isSdkSubscriptionEvent(params))
            return;
        const event = { event: params.event, data: params.data };
        const listener = subscriptionListeners.get(params.subscriptionId);
        if (listener)
            listener(event);
        else
            queueSubscriptionEvent(params.subscriptionId, event);
    };
    function send(message) {
        try {
            sendMessage(message);
            return true;
        }
        catch {
            return false;
        }
    }
    async function handleRequest(message) {
        const id = message.id;
        const method = message.method;
        const handler = handlers.get(method);
        if (!handler) {
            send({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Method not found: ${method}` },
            });
            return;
        }
        try {
            const result = await handler(message.params);
            if (!send({ jsonrpc: "2.0", id, result: result === undefined ? null : result })) {
                send({
                    jsonrpc: "2.0",
                    id,
                    error: {
                        code: -32603,
                        message: `JSON-RPC method "${method}" returned a result that was not serializable.`,
                    },
                });
            }
        }
        catch (error) {
            send({
                jsonrpc: "2.0",
                id,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : "JSON-RPC handler failed.",
                },
            });
        }
    }
    function handleMessage(message) {
        if (!isRecord(message) || message.jsonrpc !== "2.0")
            return;
        if (typeof message.method === "string") {
            if (isRpcId(message.id))
                void handleRequest(message);
            else if (message.method === "sdk.event")
                handleSdkEvent(message.params);
            return;
        }
        if ("method" in message || !isRpcId(message.id))
            return;
        const pendingRequest = pending.get(message.id);
        if (!pendingRequest)
            return;
        const hasResult = "result" in message;
        const hasError = "error" in message;
        if (hasResult === hasError)
            return;
        if (hasResult) {
            pendingRequest.resolve(message.result);
            return;
        }
        if (!isRecord(message.error))
            return;
        const { code, message: errorMessage } = message.error;
        if ((typeof code !== "string" && typeof code !== "number") || typeof errorMessage !== "string") {
            return;
        }
        pendingRequest.reject(new DohcSdkError(String(code), errorMessage));
    }
    const transport = {
        request(method, params, requestOptions) {
            assertRequestOptions(requestOptions);
            if (requestOptions?.signal?.aborted) {
                return Promise.reject(abortedError(method));
            }
            const id = nextId++;
            const timeoutMs = requestOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            return new Promise((resolve, reject) => {
                let settled = false;
                const timer = globalThis.setTimeout(() => {
                    finish(undefined, new DohcSdkError(DohcSdkErrorCodes.hostTimeout, `dohc host did not answer ${method} within ${timeoutMs}ms.`));
                }, timeoutMs);
                function cleanup() {
                    globalThis.clearTimeout(timer);
                    pending.delete(id);
                    requestOptions?.signal?.removeEventListener("abort", onAbort);
                }
                function finish(value, error) {
                    if (settled)
                        return;
                    settled = true;
                    cleanup();
                    if (error)
                        reject(error);
                    else
                        resolve(value);
                }
                function onAbort() {
                    finish(undefined, abortedError(method));
                }
                pending.set(id, {
                    resolve: (value) => finish(value),
                    reject: (error) => finish(undefined, error),
                });
                requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
                if (requestOptions?.signal?.aborted)
                    onAbort();
                if (settled)
                    return;
                const nestedParams = params === undefined ? { method } : { method, params };
                if (!send({
                    jsonrpc: "2.0",
                    id,
                    method: "sdk.request",
                    params: nestedParams,
                })) {
                    finish(undefined, new DohcSdkError(DohcSdkErrorCodes.hostUnavailable, `Failed to send dohc SDK request ${method}.`));
                }
            });
        },
        onRequest(method, handler) {
            handlers.set(method, handler);
        },
        notify(method, params) {
            send(params === undefined
                ? { jsonrpc: "2.0", method }
                : { jsonrpc: "2.0", method, params });
        },
        async subscribe(method, params, listener, requestOptions) {
            if (typeof listener !== "function") {
                throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Subscription listener must be a function.");
            }
            const result = await transport.request(method, params, requestOptions);
            if (!isRecord(result) ||
                typeof result.subscriptionId !== "string" ||
                result.subscriptionId.length === 0) {
                throw new DohcSdkError(DohcSdkErrorCodes.badResponse, `dohc host returned an invalid subscription response for ${method}.`);
            }
            const subscriptionId = result.subscriptionId;
            let active = true;
            let remoteClosed = false;
            let pendingClose = null;
            const untypedListener = listener;
            subscriptionListeners.set(subscriptionId, untypedListener);
            for (const event of queuedSubscriptionEvents.get(subscriptionId) ?? []) {
                untypedListener(event);
            }
            queuedSubscriptionEvents.delete(subscriptionId);
            const unsubscribe = async () => {
                if (active) {
                    active = false;
                    subscriptionListeners.delete(subscriptionId);
                    queuedSubscriptionEvents.delete(subscriptionId);
                    requestOptions?.signal?.removeEventListener("abort", onAbort);
                }
                if (remoteClosed)
                    return;
                if (pendingClose)
                    return pendingClose;
                pendingClose = transport
                    .request(PLUGIN_CHILD_PROCESS_METHODS.unsubscribe, { subscriptionId })
                    .then(() => {
                    remoteClosed = true;
                })
                    .finally(() => {
                    pendingClose = null;
                });
                return pendingClose;
            };
            const onAbort = () => {
                void unsubscribe().catch(() => undefined);
            };
            requestOptions?.signal?.addEventListener("abort", onAbort, { once: true });
            if (requestOptions?.signal?.aborted)
                onAbort();
            return unsubscribe;
        },
    };
    receiveMessages(handleMessage);
    return transport;
}
function isPluginChildProcessOutput(value) {
    return (isRecord(value) &&
        Number.isSafeInteger(value.sequence) &&
        (value.stream === "stdout" || value.stream === "stderr") &&
        typeof value.text === "string");
}
function pluginChildProcessExit(value, method) {
    if (!isRecord(value) ||
        (value.code !== null && !Number.isSafeInteger(value.code)) ||
        (value.reason !== "exited" && value.reason !== "terminated")) {
        throw new DohcSdkError(DohcSdkErrorCodes.badResponse, `dohc host returned an invalid child-process response for ${method}.`);
    }
    return value;
}
export function createPluginChildProcessClient(transport) {
    const handle = (childId) => ({
        id: childId,
        async onOutput(listener, options) {
            if (typeof listener !== "function") {
                throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Child-process output listener must be a function.");
            }
            if (!transport.subscribe) {
                throw new DohcSdkError(DohcSdkErrorCodes.subscriptionsUnsupported, "This dohc host transport does not support child-process output.");
            }
            return transport.subscribe(PLUGIN_CHILD_PROCESS_METHODS.subscribeOutput, { childId }, (event) => {
                if ((event.event === "stdout" || event.event === "stderr") &&
                    isPluginChildProcessOutput(event.data)) {
                    listener(event.data);
                }
            }, options);
        },
        async send(message, options) {
            await transport.request(PLUGIN_CHILD_PROCESS_METHODS.send, { childId, message }, options);
        },
        async logs(options) {
            const result = await transport.request(PLUGIN_CHILD_PROCESS_METHODS.logs, { childId }, options);
            if (!Array.isArray(result) || !result.every(isPluginChildProcessOutput)) {
                throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned invalid child-process logs.");
            }
            return result;
        },
        async wait(options) {
            return pluginChildProcessExit(await transport.request(PLUGIN_CHILD_PROCESS_METHODS.wait, { childId }, options), PLUGIN_CHILD_PROCESS_METHODS.wait);
        },
        async terminate(options) {
            return pluginChildProcessExit(await transport.request(PLUGIN_CHILD_PROCESS_METHODS.terminate, { childId }, options), PLUGIN_CHILD_PROCESS_METHODS.terminate);
        },
    });
    return {
        async spawn(input, options) {
            if (!isRecord(input)) {
                throw new DohcSdkError(DohcSdkErrorCodes.invalidInput, "Child-process spawn input must be an object.");
            }
            const result = await transport.request(PLUGIN_CHILD_PROCESS_METHODS.spawn, input, options);
            if (!isRecord(result) ||
                typeof result.childId !== "string" ||
                result.childId.length === 0) {
                throw new DohcSdkError(DohcSdkErrorCodes.badResponse, "dohc host returned an invalid child-process spawn response.");
            }
            return handle(result.childId);
        },
    };
}
function createParentPortTransport(port) {
    const transport = createTransport((message) => port.postMessage(message), (listener) => port.on("message", (event) => listener(event.data)));
    port.start?.();
    return transport;
}
function createStdioTransport(input, output) {
    return createTransport((message) => {
        output.write(`${JSON.stringify(message)}\n`);
    }, (listener) => {
        const lines = createInterface({ input });
        lines.on("line", (line) => {
            try {
                listener(JSON.parse(line));
            }
            catch {
                // Ignore malformed input and continue reading later lines.
            }
        });
    });
}
function getElectronParentPort() {
    return process.parentPort;
}
export function createProcessTransport(options = {}) {
    const parentPort = getElectronParentPort();
    if (parentPort) {
        if (!parentPortBinding || parentPortBinding.port !== parentPort) {
            parentPortBinding = {
                port: parentPort,
                transport: createParentPortTransport(parentPort),
            };
        }
        return parentPortBinding.transport;
    }
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const existing = streamBindings.get(input);
    if (existing && existing.output === output)
        return existing.transport;
    const transport = createStdioTransport(input, output);
    streamBindings.set(input, { output, transport });
    return transport;
}
