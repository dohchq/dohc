import { createInterface } from "node:readline";
import { DohcSdkError, DohcSdkErrorCodes, createDohcClient, } from "./index.js";
import { abortedError, assertRequestOptions } from "./requestOptions.js";
export { createDohcClient };
const DEFAULT_TIMEOUT_MS = 10_000;
const streamBindings = new WeakMap();
let parentPortBinding = null;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRpcId(value) {
    return typeof value === "string" || typeof value === "number";
}
function createTransport(sendMessage, receiveMessages) {
    const handlers = new Map();
    const pending = new Map();
    let nextId = 1;
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
            send({ jsonrpc: "2.0", id, result });
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
        if (typeof message.method === "string" && isRpcId(message.id)) {
            void handleRequest(message);
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
    };
    receiveMessages(handleMessage);
    return transport;
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
