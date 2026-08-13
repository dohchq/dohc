import { createDohcClient, type DohcClient, type DohcTransport } from "./index.js";
export { createDohcClient };
export type { DohcClient };
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export interface ProcessTransport extends DohcTransport {
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
    commands: {
        register(id: string, run: (...args: unknown[]) => unknown): void;
    };
}
export interface PluginHandler {
    activate(ctx: PluginActivateContext): Promise<void> | void;
    deactivate?(): Promise<void> | void;
}
export declare function createProcessTransport(options?: CreateProcessTransportOptions): ProcessTransport;
/** Called by a plugin's entry module (typically at module top level) to register its lifecycle. */
export declare function activatePlugin(handler: PluginHandler): void;
/** Used by the plugin-host loader to retrieve the lifecycle registered by the imported entry module. */
export declare function getActivatedPluginHandler(): PluginHandler | null;
