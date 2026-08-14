import { createDohcClient, type DohcClient, type DohcRequestOptions, type DohcSubscriptionEvent, type DohcTransport, type DohcUnsubscribe } from "./index.js";
export { createDohcClient };
export type { DohcClient };
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export declare const PLUGIN_CHILD_PROCESS_METHODS: {
    readonly spawn: "childProcesses.spawn";
    readonly subscribeOutput: "childProcesses.output.subscribe";
    readonly send: "childProcesses.send";
    readonly logs: "childProcesses.logs";
    readonly wait: "childProcesses.wait";
    readonly terminate: "childProcesses.terminate";
    readonly unsubscribe: "subscriptions.unsubscribe";
};
export type PluginChildProcessStream = "stdout" | "stderr";
export interface PluginChildProcessOutput {
    sequence: number;
    stream: PluginChildProcessStream;
    text: string;
}
export interface PluginChildProcessExit {
    code: number | null;
    reason: "exited" | "terminated";
}
export interface PluginChildProcessSpawnOptions {
    /** Plugin-built-root-relative JavaScript entry passed to utilityProcess.fork(). */
    modulePath: string;
    args?: string[];
    /** Plugin-built-root-relative working directory. Defaults to the built root. */
    cwd?: string;
    /** String environment overrides merged over the host environment. */
    env?: Record<string, string>;
}
export interface PluginChildProcessHandle {
    readonly id: string;
    onOutput(listener: (output: PluginChildProcessOutput) => void, options?: DohcRequestOptions): Promise<DohcUnsubscribe>;
    send(message: unknown, options?: DohcRequestOptions): Promise<void>;
    logs(options?: DohcRequestOptions): Promise<PluginChildProcessOutput[]>;
    wait(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
    terminate(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
}
export interface PluginChildProcessClient {
    spawn(input: PluginChildProcessSpawnOptions, options?: DohcRequestOptions): Promise<PluginChildProcessHandle>;
}
export interface ProcessTransport extends DohcTransport {
    subscribe<T = unknown>(method: string, params: unknown, listener: (event: DohcSubscriptionEvent<T>) => void, options?: DohcRequestOptions): Promise<DohcUnsubscribe>;
    /** Registers a handler for an incoming request from the parent host (e.g. "plugin.activate"). */
    onRequest(method: string, handler: RequestHandler): void;
    /** Sends a one-way notification to the parent host (e.g. "plugin.log"). */
    notify(method: string, params?: unknown): void;
}
export interface CreateProcessTransportOptions {
    /** Stdio-binding-only. Defaults to process.stdin. Ignored under the message-channel binding. Injectable for tests. */
    input?: NodeJS.ReadableStream;
    /** Stdio-binding-only. Defaults to process.stdout. Ignored under the message-channel binding. Injectable for tests. */
    output?: NodeJS.WritableStream;
}
export interface PluginActivateContext {
    pluginId: string;
    workspaceRoot: string;
    pluginRoot: string;
    client: DohcClient;
    childProcesses: PluginChildProcessClient;
    commands: {
        register(id: string, run: (...args: unknown[]) => unknown): void;
    };
}
export interface PluginHandler {
    activate(ctx: PluginActivateContext): Promise<void> | void;
    deactivate?(): Promise<void> | void;
}
export declare function createPluginChildProcessClient(transport: ProcessTransport): PluginChildProcessClient;
export declare function createProcessTransport(options?: CreateProcessTransportOptions): ProcessTransport;
