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
    /**
     * Plugin-built-root-relative working directory, or
     * `{ workspaceRoot: true }` for the canonical workspace root — the one
     * location outside the plugin's built root a wrapper's server may run in
     * (its provider sessions work on the workspace). Defaults to the built
     * root.
     */
    cwd?: string | {
        workspaceRoot: true;
    };
    /** String environment overrides merged over the host environment. */
    env?: Record<string, string>;
}
export interface PluginChildProcessHandle {
    readonly id: string;
    /** The child's OS pid at spawn time, or null if it exited before one was
     * observed. Wrapper plugins record it beside their server's state so a
     * later start can tell a live orphan from a stale runtime file. */
    readonly pid: number | null;
    onOutput(listener: (output: PluginChildProcessOutput) => void, options?: DohcRequestOptions): Promise<DohcUnsubscribe>;
    send(message: unknown, options?: DohcRequestOptions): Promise<void>;
    logs(options?: DohcRequestOptions): Promise<PluginChildProcessOutput[]>;
    wait(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
    terminate(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
}
/**
 * Spawns child processes for one plugin activation.
 *
 * Retention: an exited child's handle stays readable so `logs()` and `wait()`
 * still work after it exits, but the host retains at most 200 exited children
 * per activation and discards the oldest first. A handle discarded that way
 * fails with a "was not found" error that names the limit. Read a child's
 * logs and exit result before spawning more.
 */
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
    /**
     * The plugin's durable per-workspace data directory, under the app's own
     * userData beside the built plugin — never inside the workspace. It
     * survives rebuilds and reinstalls; uninstalling the plugin deletes it,
     * and the uninstall warning names it. The host only computes the path;
     * a plugin that wants it creates it.
     */
    stateRoot: string;
    client: DohcClient;
    childProcesses: PluginChildProcessClient;
    commands: {
        register(id: string, run: (...args: unknown[]) => unknown): void;
    };
}
/** What PluginHandler.startWebApp returns: the URL the host navigates the
 * guest WebContentsView to. It may carry a one-time credential in its
 * fragment, so it crosses process boundaries in memory only — never logs. */
export interface PluginWebAppStart {
    url: string;
}
export interface PluginHandler {
    activate(ctx: PluginActivateContext): Promise<void> | void;
    /**
     * Starts (or reuses) the embedded web app declared under the manifest's
     * `webApps` and returns the loopback URL to show. Called on demand when
     * the user opens the web app's tab, never during activate — a wrapper's
     * server start is exactly the long-running readiness work activation must
     * not await.
     */
    startWebApp?(webAppId: string): Promise<PluginWebAppStart> | PluginWebAppStart;
    /**
     * Ends the session the matching `startWebApp` began, so the next start
     * pairs from scratch. The host calls this when the guest it started the app
     * for never arrived: a start URL's one-time credential is spent by then, and
     * only the plugin can retire the session it paired. A handler that
     * implements `startWebApp` must implement this too — the host reports a
     * handler that does not.
     */
    stopWebApp?(webAppId: string): Promise<void> | void;
    deactivate?(): Promise<void> | void;
}
export declare function createPluginChildProcessClient(transport: ProcessTransport): PluginChildProcessClient;
export declare function createProcessTransport(options?: CreateProcessTransportOptions): ProcessTransport;
