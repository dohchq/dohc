import { createDohcClient, type DohcClient, type DohcRequestOptions, type DohcSubscriptionEvent, type DohcTransport, type DohcUnsubscribe } from "./index.js";
export { createDohcClient };
export type { DohcClient };
type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export declare const PLUGIN_CHILD_PROCESS_METHODS: {
    readonly spawn: "childProcesses.spawn";
    readonly spawnCommand: "childProcesses.command.spawn";
    readonly subscribeOutput: "childProcesses.output.subscribe";
    readonly send: "childProcesses.send";
    readonly write: "childProcesses.stdin.write";
    readonly endInput: "childProcesses.stdin.end";
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
/**
 * An executable to run as a supervised child.
 *
 * dohc runs the file this names and passes `args` as argv entries. There is
 * no shell and no command line: a whole command written into `command` is one
 * executable name that will not be found, not a script to interpret.
 */
export interface PluginChildProcessCommandOptions {
    /**
     * An absolute path to an executable, or a bare name (no path separator)
     * looked up on the child's PATH — where a harness CLI installed on the
     * machine lives.
     */
    command: string;
    args?: string[];
    /**
     * Plugin-built-root-relative working directory, or
     * `{ workspaceRoot: true }` for the canonical workspace root. Defaults to
     * the built root. Identical to a module child's rule: the executable may
     * come from anywhere, the directory it runs in may not.
     */
    cwd?: string | {
        workspaceRoot: true;
    };
    /** String environment overrides merged over the host environment. */
    env?: Record<string, string>;
}
interface PluginChildProcessHandleBase {
    readonly id: string;
    /** The child's OS pid at spawn time, or null if it exited before one was
     * observed. Wrapper plugins record it beside their server's state so a
     * later start can tell a live orphan from a stale runtime file. */
    readonly pid: number | null;
    onOutput(listener: (output: PluginChildProcessOutput) => void, options?: DohcRequestOptions): Promise<DohcUnsubscribe>;
    logs(options?: DohcRequestOptions): Promise<PluginChildProcessOutput[]>;
    wait(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
    terminate(options?: DohcRequestOptions): Promise<PluginChildProcessExit>;
}
/** A module child, started by `spawn`. Input is a structured message. */
export interface PluginChildProcessHandle extends PluginChildProcessHandleBase {
    send(message: unknown, options?: DohcRequestOptions): Promise<void>;
}
/** A command child, started by `spawnCommand`. Input is bytes on standard
 * input, which is how a harness CLI takes a prompt or speaks a protocol. */
export interface PluginChildProcessCommandHandle extends PluginChildProcessHandleBase {
    /** Writes to the child's standard input. */
    write(data: string, options?: DohcRequestOptions): Promise<void>;
    /** Closes the child's standard input, so a child that reads to end of file
     * sees one. Later writes fail. */
    endInput(options?: DohcRequestOptions): Promise<void>;
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
    /** Runs a JavaScript file from the plugin's own built root. */
    spawn(input: PluginChildProcessSpawnOptions, options?: DohcRequestOptions): Promise<PluginChildProcessHandle>;
    /**
     * Runs any executable the machine has, supervised the same way: dohc owns
     * the process tree and kills it when the plugin stops.
     */
    spawnCommand(input: PluginChildProcessCommandOptions, options?: DohcRequestOptions): Promise<PluginChildProcessCommandHandle>;
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
/** A setting's value. The manifest's declared type decides which of these. */
export type PluginSettingValue = string | number | boolean;
/**
 * The plugin's own settings, as declared in its manifest and answered by the
 * user. Two members and no more: read them now, and hear about it when they
 * change.
 *
 * Every declared key is always present and always the declared type, so a
 * plugin never checks whether a setting exists. A stored answer that no longer
 * fits the manifest never arrives — the host resolves it back to the declared
 * default first.
 */
export interface PluginSettings {
    /** This plugin's settings as they stand now. */
    get(): Record<string, PluginSettingValue>;
    /**
     * Runs the listener with the complete new settings each time the user
     * changes one. Returns a function that stops it.
     */
    onChange(listener: (values: Record<string, PluginSettingValue>) => void): () => void;
}
/** Data that survives JSON, which is what a driver's resume cursor is. */
export type PluginJsonValue = string | number | boolean | null | PluginJsonValue[] | {
    [key: string]: PluginJsonValue;
};
export type PluginPermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export interface PluginPermissionOption {
    optionId: string;
    name: string;
    kind: PluginPermissionKind;
}
export type PluginPermissionDecision = PluginPermissionKind | "cancel";
/**
 * What a driver tells dohc while a session runs.
 *
 * This is dohc's own normalized agent-event union, as it crosses the process
 * boundary: every member is data dohc renders itself. There is deliberately no
 * pass-through field for the harness's own message — a provider payload
 * carries tool arguments, file contents, and account detail, and dohc drops it
 * at this boundary rather than route it onward.
 */
export type PluginAgentEvent = {
    kind: "session-state";
    state: "starting" | "ready" | "running" | "error" | "closed";
    reason?: string;
} | {
    kind: "text-delta";
    itemId: string;
    stream: "assistant" | "reasoning";
    text: string;
} | {
    kind: "item";
    phase: "started" | "updated" | "completed";
    item: {
        id: string;
        type: "tool_call" | "command" | "file_change" | "mcp_tool_call" | "web_search" | "plan" | "other";
        title: string;
        detail?: string;
        status: "pending" | "in_progress" | "completed" | "failed";
        locations?: string[];
    };
} | {
    kind: "plan";
    steps: Array<{
        step: string;
        status: "pending" | "inProgress" | "completed";
    }>;
} | {
    kind: "permission-request";
    requestId: string;
    requestType: "command" | "file-change" | "file-read" | "tool" | "other";
    title: string;
    detail?: string;
    locations?: string[];
    options: PluginPermissionOption[];
} | {
    kind: "permission-resolved";
    requestId: string;
    decision: PluginPermissionDecision;
} | {
    kind: "token-usage";
    used: number;
    max?: number;
    input?: number;
    output?: number;
} | {
    kind: "turn-completed";
    turnId: string;
    status: "completed" | "failed" | "cancelled";
    errorMessage?: string;
} | {
    kind: "auth";
    event: "account-updated" | "rate-limits" | "mcp-oauth-completed" | "login-required";
    detail?: string;
} | {
    kind: "error";
    message: string;
    fatal: boolean;
};
export interface PluginAgentModel {
    id: string;
    name: string;
    planIncluded: boolean;
    options?: Array<{
        id: string;
        values: string[];
        default?: string;
    }>;
}
/**
 * What a driver reports about its harness on this machine.
 *
 * `auth.email` and `loginHint` are personal data. dohc keeps them out of its
 * renderer, its logs, and anything it stores; report the account only when the
 * harness itself already tells you, and never report a credential.
 */
export interface PluginAgentProbe {
    installed: boolean;
    version?: string;
    auth: {
        status: "authenticated" | "unauthenticated" | "unknown";
        label?: string;
        email?: string;
        loginHint?: string;
    };
    models: PluginAgentModel[];
    errorMessage?: string;
}
export interface PluginAgentSessionStartInput {
    /** The canonical workspace root. Run the harness here. */
    workspaceRoot: string;
    mode: "approval-required" | "auto-accept-edits" | "full-access";
    model?: string;
    /** A cursor a previous session of this driver returned, to resume it. */
    resumeCursor?: PluginJsonValue;
    /** dohc's own MCP server, for the harness to connect to the workspace. */
    mcp: {
        command: string;
        args: string[];
        env?: Record<string, string>;
    };
    logDir?: string;
    /** Reports one event to dohc. Safe to call until `dispose` returns. */
    onEvent(event: PluginAgentEvent): void;
}
export interface PluginAgentSession {
    /** The harness's own id for this session, for logs and resume. */
    sessionId: string;
    /** What a later session needs to continue this one, or nothing. */
    resumeCursor?: PluginJsonValue;
    prompt(input: {
        text: string;
        attachments?: Array<{
            type: "image";
            pathOrUrl: string;
        }>;
    }): Promise<{
        turnId: string;
    }> | {
        turnId: string;
    };
    cancel(): Promise<void> | void;
    answerPermission(requestId: string, decision: PluginPermissionDecision): Promise<void> | void;
    answerUserInput?(requestId: string, answers: Record<string, string | string[]>): Promise<void> | void;
    setModel?(modelId: string): Promise<void> | void;
    /** Ends the turn and the harness process. The session stays readable. */
    stop(): Promise<void> | void;
    /** Releases everything this session holds. */
    dispose(): Promise<void> | void;
}
/**
 * One harness dohc can talk to.
 *
 * dohc owns the conversation: it decides when to probe, when to start a
 * session, and what the workspace shows. A driver's job is to run the harness
 * and report what it says. dohc keeps the authority it already has over every
 * child a driver starts — it takes the harness's whole process tree down with
 * the plugin, without asking the driver.
 */
export interface PluginAgentDriver {
    probe(): Promise<PluginAgentProbe> | PluginAgentProbe;
    startSession(input: PluginAgentSessionStartInput): Promise<PluginAgentSession> | PluginAgentSession;
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
    settings: PluginSettings;
    commands: {
        register(id: string, run: (...args: unknown[]) => unknown): void;
    };
    /**
     * Registers the agent drivers this plugin's manifest declares. Register
     * every declared driver during activation: dohc lists a declared driver in
     * its own probe list, so one that never registers would be a row that can
     * never answer.
     */
    drivers: {
        register(id: string, driver: PluginAgentDriver): void;
    };
}
/** What PluginHandler.startWebApp returns: the URL the host navigates the
 * guest WebContentsView to. It may carry a one-time credential in its
 * fragment, so it crosses process boundaries in memory only — never logs. */
export interface PluginWebAppStart {
    url: string;
    /**
     * What to call this instance's tab. Every instance of one web app shares
     * the manifest title, so a plugin that opens a tab per site names each one
     * here. Omit it to use the manifest title. Titles longer than 120
     * characters are refused.
     */
    title?: string;
}
export interface PluginHandler {
    activate(ctx: PluginActivateContext): Promise<void> | void;
    /**
     * Starts (or reuses) the embedded web app declared under the manifest's
     * `webApps` and returns the loopback URL to show. Called on demand when
     * the user opens the web app's tab, never during activate — a wrapper's
     * server start is exactly the long-running readiness work activation must
     * not await.
     *
     * `instanceKey` is the instance the user opened, for a web app the manifest
     * marks `"instanced": true`, and null for one that opens a single app. dohc
     * holds no opinion about what an instance is: the key is whatever the
     * plugin's panel named when it opened the tab. Each instance is its own tab
     * over its own origin, so a handler may run one server per instance or one
     * server serving all of them — but it must return the URL that shows this
     * instance, because the guest is locked to that URL's origin.
     */
    startWebApp?(webAppId: string, instanceKey: string | null): Promise<PluginWebAppStart> | PluginWebAppStart;
    /**
     * Ends the session the matching `startWebApp` began, so the next start
     * pairs from scratch. The host calls this when the guest it started the app
     * for never arrived: a start URL's one-time credential is spent by then, and
     * only the plugin can retire the session it paired. A handler that
     * implements `startWebApp` must implement this too — the host reports a
     * handler that does not.
     *
     * It names one instance. Ending it must leave the plugin's other instances
     * of the same web app running.
     */
    stopWebApp?(webAppId: string, instanceKey: string | null): Promise<void> | void;
    deactivate?(): Promise<void> | void;
}
export declare function createPluginChildProcessClient(transport: ProcessTransport): PluginChildProcessClient;
export declare function createProcessTransport(options?: CreateProcessTransportOptions): ProcessTransport;
