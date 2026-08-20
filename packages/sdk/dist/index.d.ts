export declare const DOHC_SDK_PROTOCOL = "dohc:sdk:v1";
export declare const DohcSdkErrorCodes: {
    readonly hostUnavailable: "DOHC_HOST_UNAVAILABLE";
    readonly hostMissingOrigin: "DOHC_HOST_MISSING_ORIGIN";
    readonly hostTimeout: "DOHC_HOST_TIMEOUT";
    readonly badResponse: "DOHC_BAD_RESPONSE";
    readonly capabilityDisabled: "DOHC_CAPABILITY_DISABLED";
    readonly invalidInput: "DOHC_INVALID_INPUT";
    readonly aborted: "DOHC_ABORTED";
    readonly subscriptionsUnsupported: "DOHC_SUBSCRIPTIONS_UNSUPPORTED";
    readonly responseTruncated: "DOHC_RESPONSE_TRUNCATED";
};
export type DohcSdkErrorCode = (typeof DohcSdkErrorCodes)[keyof typeof DohcSdkErrorCodes] | (string & {});
/**
 * Capabilities describe what the current dohc context can do. They are an
 * availability map, not a permission-request API. Hosts may add capabilities
 * without requiring an SDK release.
 */
export type DohcCapabilityGroup = Record<string, boolean | undefined>;
export type DohcCapabilityMap = {
    files: DohcCapabilityGroup & {
        read: boolean;
        write: boolean;
        list?: boolean;
        watch?: boolean;
    };
    collections: DohcCapabilityGroup & {
        read: boolean;
        list?: boolean;
    };
    provenance: DohcCapabilityGroup & {
        record: boolean;
    };
    workspace?: DohcCapabilityGroup & {
        search?: boolean;
    };
    databases?: DohcCapabilityGroup & {
        read?: boolean;
        edit?: boolean;
    };
    ui?: DohcCapabilityGroup & {
        open?: boolean;
    };
    [namespace: string]: DohcCapabilityGroup | undefined;
};
export type DohcSdkRequestMessage = {
    protocol: typeof DOHC_SDK_PROTOCOL;
    id: string;
    method: string;
    params?: unknown;
};
export type DohcSdkEventMessage<T = unknown> = {
    protocol: typeof DOHC_SDK_PROTOCOL;
    type: "event";
    subscriptionId: string;
    event: string;
    data: T;
};
export type DohcSdkResponseMessage = {
    protocol: typeof DOHC_SDK_PROTOCOL;
    id: string;
    ok: true;
    result: unknown;
} | {
    protocol: typeof DOHC_SDK_PROTOCOL;
    id: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
export type DohcRequestOptions = {
    signal?: AbortSignal;
    /** Overrides the transport's default timeout for this request. */
    timeoutMs?: number;
};
export type DohcSubscriptionEvent<T = unknown> = {
    event: string;
    data: T;
};
export type DohcUnsubscribe = () => Promise<void>;
export interface DohcTransport {
    request(method: string, params?: unknown, options?: DohcRequestOptions): Promise<unknown>;
    subscribe?<T = unknown>(method: string, params: unknown, listener: (event: DohcSubscriptionEvent<T>) => void, options?: DohcRequestOptions): Promise<DohcUnsubscribe>;
}
export type DohcFileEntry = {
    path: string;
    name?: string;
    kind?: "file" | "directory" | (string & {});
    size?: number;
    modifiedAt?: number | string;
    [key: string]: unknown;
};
export type DohcFileReadResult = {
    text: string;
    /** True when the host returned only a bounded prefix of the file. */
    truncated: boolean;
};
export type DohcFileListOptions = {
    recursive?: boolean;
    includeHidden?: boolean;
    [key: string]: unknown;
};
export type DohcFileWriteOptions = {
    create?: boolean;
    overwrite?: boolean;
    [key: string]: unknown;
};
/**
 * One settled change to one workspace file.
 *
 * `operation` has exactly two members because that is what the host can
 * observe: it decides a path's operation by checking whether the file exists
 * once the workspace goes quiet, so a new file and an edited file both arrive
 * as `update`. There is no create, rename, or move.
 *
 * Events are settled, not raw: the host waits for a quiet window, folds the
 * repeated saves of one editor keystroke burst into one event per path, and
 * drops its own metadata writes. A burst of ten saves to one file is one
 * event.
 */
export type DohcFileWatchEvent = {
    path: string;
    operation: "update" | "delete";
    /** The file's content hash, when the host could read it. Absent on a
     * delete, and on a file the host could not read at settle time. */
    sha256?: string;
    [key: string]: unknown;
};
export type DohcSearchOptions = {
    path?: string;
    limit?: number;
    types?: string[];
    [key: string]: unknown;
};
export type DohcSearchResult = {
    path?: string;
    title?: string;
    excerpt?: string;
    score?: number;
    [key: string]: unknown;
};
export type DohcDatabaseReadRequest = {
    path: string;
    query?: string;
    params?: unknown[] | Record<string, unknown>;
    [key: string]: unknown;
};
export type DohcDatabaseEditRequest = {
    path: string;
    query?: string;
    params?: unknown[] | Record<string, unknown>;
    /** The production dohc host currently accepts exactly one structured operation per call. */
    operations?: [unknown];
    [key: string]: unknown;
};
export type DohcUiOpenOptions = {
    position?: "active" | "beside" | "new-tab" | (string & {});
    [key: string]: unknown;
};
export type DohcProvenanceRecord = {
    summary: string;
    [key: string]: unknown;
};
/**
 * The envelope dohc pushes when its appearance changes. Theme is styling
 * data: it carries no authority, gates on no capability, and a panel that
 * ignores these messages behaves exactly as it did before.
 */
export declare const DOHC_THEME_PROTOCOL = "dohc:theme:v1";
export type DohcThemeMode = "light" | "dark";
export type DohcThemeDensity = "comfortable" | "compact";
export type DohcTheme = {
    /** Which palette is on screen. dohc's "system" mode is already resolved. */
    mode: DohcThemeMode;
    density: DohcThemeDensity;
    reduceMotion: boolean;
    /**
     * CSS custom properties, spelled exactly as dohc's own stylesheet spells
     * them ("--dohc-ink", "--font-sans"). Write `var(--dohc-ink)` in panel CSS
     * and the panel matches the app.
     */
    tokens: Record<string, string>;
};
export type DohcThemeMessage = {
    protocol: typeof DOHC_THEME_PROTOCOL;
    theme: DohcTheme;
};
export type DohcApplyThemeOptions = DohcRequestOptions & {
    /** Defaults to this document's <html>. */
    root?: HTMLElement;
};
export declare function isDohcTheme(value: unknown): value is DohcTheme;
export declare function isDohcThemeMessage(value: unknown): value is DohcThemeMessage;
/**
 * Writes one theme onto an element, normally the guest document's <html>:
 * every token as a custom property, plus the three attributes dohc's own
 * stylesheet switches on, so a panel can write `[data-theme='dark']` rules
 * the same way dohc does.
 */
export declare function applyDohcTheme(theme: DohcTheme, root: HTMLElement): void;
export type CreateDohcClientOptions = {
    transport?: DohcTransport;
    timeoutMs?: number;
    targetOrigin?: string;
    currentWindow?: Window;
    targetWindow?: Window;
};
export declare class DohcSdkError extends Error {
    readonly code: DohcSdkErrorCode;
    constructor(code: DohcSdkErrorCode, message: string);
}
export declare function createPostMessageTransport(options?: Omit<CreateDohcClientOptions, "transport">): DohcTransport;
export declare function createDohcClient(options?: CreateDohcClientOptions): {
    capabilities: () => Promise<DohcCapabilityMap>;
    /** Generic escape hatch for host capabilities newer than this SDK. */
    request: <T = unknown>(method: string, params?: unknown, requestOptions?: DohcRequestOptions) => Promise<T>;
    /** Alias for request, suited to command-style host capabilities. */
    invoke: <T = unknown>(method: string, params?: unknown, requestOptions?: DohcRequestOptions) => Promise<T>;
    /** Generic event subscription escape hatch. */
    subscribe: <T = unknown>(method: string, params: unknown, listener: (event: DohcSubscriptionEvent<T>) => void, requestOptions?: DohcRequestOptions) => Promise<DohcUnsubscribe>;
    files: {
        readInfo: (path: string, requestOptions?: DohcRequestOptions) => Promise<DohcFileReadResult>;
        read: (path: string, requestOptions?: DohcRequestOptions) => Promise<string>;
        list: (path?: string, options?: DohcFileListOptions, requestOptions?: DohcRequestOptions) => Promise<DohcFileEntry[]>;
        write: (path: string, text: string, options?: DohcFileWriteOptions, requestOptions?: DohcRequestOptions) => Promise<unknown>;
        /**
         * Reports settled changes at or below `path`, which is a prefix: a file
         * to watch on its own, a folder to watch with everything under it, or
         * "." for the whole workspace. Changes outside it never arrive.
         *
         * Returns a function that stops the subscription. A subscription also
         * ends when its plugin stops, or when the panel that opened it closes or
         * changes its workspace, plugin, or panel identity. Same-origin in-frame
         * navigation inside an already-open panel does not end it today.
         */
        watch: (path: string, listener: (event: DohcSubscriptionEvent<DohcFileWatchEvent>) => void, requestOptions?: DohcRequestOptions) => Promise<DohcUnsubscribe>;
    };
    workspace: {
        search: (query: string, options?: DohcSearchOptions, requestOptions?: DohcRequestOptions) => Promise<DohcSearchResult[]>;
    };
    databases: {
        read: <T = unknown>(input: DohcDatabaseReadRequest, requestOptions?: DohcRequestOptions) => Promise<T>;
        edit: <T = unknown>(input: DohcDatabaseEditRequest, requestOptions?: DohcRequestOptions) => Promise<T>;
    };
    ui: {
        open: (target: string, options?: DohcUiOpenOptions, requestOptions?: DohcRequestOptions) => Promise<unknown>;
        /**
         * Opens one instance of this plugin's own per-instance web app in its
         * own tab. `instanceKey` names the thing the tab shows — a site root,
         * a record id, whatever the plugin serves — and comes back to the
         * plugin's `startWebApp`, which returns the origin for that instance.
         *
         * Only a panel may call this: opening a tab needs a renderer. The web
         * app must be declared in the manifest with `"instanced": true`.
         */
        openWebApp: (webAppId: string, instanceKey: string, requestOptions?: DohcRequestOptions) => Promise<unknown>;
        /**
         * dohc's design tokens as they are on screen right now. Read this to
         * color something CSS cannot reach — a canvas, a chart, an SVG fill.
         * To style a panel, prefer `applyTheme`.
         *
         * Theme is styling data, so this gates on no capability.
         */
        theme: (requestOptions?: DohcRequestOptions) => Promise<DohcTheme>;
        /**
         * The one line that makes a panel look native: it writes dohc's tokens
         * onto this document and keeps writing them when the user changes
         * theme, density, or reduced motion. Panel CSS then uses the same
         * names dohc uses — `color: var(--dohc-ink)`.
         *
         * Returns a function that stops following. A panel that never calls
         * this is unaffected; the host's messages are simply ignored.
         */
        applyTheme: (applyOptions?: DohcApplyThemeOptions) => Promise<() => void>;
    };
    collections: {
        list: (name: string, params?: Record<string, unknown>, requestOptions?: DohcRequestOptions) => Promise<Record<string, unknown>[]>;
        get: (name: string) => {
            list: (params?: Record<string, unknown>, requestOptions?: DohcRequestOptions) => Promise<Record<string, unknown>[]>;
        };
    };
    provenance: {
        record: (value: string | DohcProvenanceRecord, requestOptions?: DohcRequestOptions) => Promise<void>;
    };
};
export type DohcClient = ReturnType<typeof createDohcClient>;
export declare const dohc: {
    capabilities: () => Promise<DohcCapabilityMap>;
    /** Generic escape hatch for host capabilities newer than this SDK. */
    request: <T = unknown>(method: string, params?: unknown, requestOptions?: DohcRequestOptions) => Promise<T>;
    /** Alias for request, suited to command-style host capabilities. */
    invoke: <T = unknown>(method: string, params?: unknown, requestOptions?: DohcRequestOptions) => Promise<T>;
    /** Generic event subscription escape hatch. */
    subscribe: <T = unknown>(method: string, params: unknown, listener: (event: DohcSubscriptionEvent<T>) => void, requestOptions?: DohcRequestOptions) => Promise<DohcUnsubscribe>;
    files: {
        readInfo: (path: string, requestOptions?: DohcRequestOptions) => Promise<DohcFileReadResult>;
        read: (path: string, requestOptions?: DohcRequestOptions) => Promise<string>;
        list: (path?: string, options?: DohcFileListOptions, requestOptions?: DohcRequestOptions) => Promise<DohcFileEntry[]>;
        write: (path: string, text: string, options?: DohcFileWriteOptions, requestOptions?: DohcRequestOptions) => Promise<unknown>;
        /**
         * Reports settled changes at or below `path`, which is a prefix: a file
         * to watch on its own, a folder to watch with everything under it, or
         * "." for the whole workspace. Changes outside it never arrive.
         *
         * Returns a function that stops the subscription. A subscription also
         * ends when its plugin stops, or when the panel that opened it closes or
         * changes its workspace, plugin, or panel identity. Same-origin in-frame
         * navigation inside an already-open panel does not end it today.
         */
        watch: (path: string, listener: (event: DohcSubscriptionEvent<DohcFileWatchEvent>) => void, requestOptions?: DohcRequestOptions) => Promise<DohcUnsubscribe>;
    };
    workspace: {
        search: (query: string, options?: DohcSearchOptions, requestOptions?: DohcRequestOptions) => Promise<DohcSearchResult[]>;
    };
    databases: {
        read: <T = unknown>(input: DohcDatabaseReadRequest, requestOptions?: DohcRequestOptions) => Promise<T>;
        edit: <T = unknown>(input: DohcDatabaseEditRequest, requestOptions?: DohcRequestOptions) => Promise<T>;
    };
    ui: {
        open: (target: string, options?: DohcUiOpenOptions, requestOptions?: DohcRequestOptions) => Promise<unknown>;
        /**
         * Opens one instance of this plugin's own per-instance web app in its
         * own tab. `instanceKey` names the thing the tab shows — a site root,
         * a record id, whatever the plugin serves — and comes back to the
         * plugin's `startWebApp`, which returns the origin for that instance.
         *
         * Only a panel may call this: opening a tab needs a renderer. The web
         * app must be declared in the manifest with `"instanced": true`.
         */
        openWebApp: (webAppId: string, instanceKey: string, requestOptions?: DohcRequestOptions) => Promise<unknown>;
        /**
         * dohc's design tokens as they are on screen right now. Read this to
         * color something CSS cannot reach — a canvas, a chart, an SVG fill.
         * To style a panel, prefer `applyTheme`.
         *
         * Theme is styling data, so this gates on no capability.
         */
        theme: (requestOptions?: DohcRequestOptions) => Promise<DohcTheme>;
        /**
         * The one line that makes a panel look native: it writes dohc's tokens
         * onto this document and keeps writing them when the user changes
         * theme, density, or reduced motion. Panel CSS then uses the same
         * names dohc uses — `color: var(--dohc-ink)`.
         *
         * Returns a function that stops following. A panel that never calls
         * this is unaffected; the host's messages are simply ignored.
         */
        applyTheme: (applyOptions?: DohcApplyThemeOptions) => Promise<() => void>;
    };
    collections: {
        list: (name: string, params?: Record<string, unknown>, requestOptions?: DohcRequestOptions) => Promise<Record<string, unknown>[]>;
        get: (name: string) => {
            list: (params?: Record<string, unknown>, requestOptions?: DohcRequestOptions) => Promise<Record<string, unknown>[]>;
        };
    };
    provenance: {
        record: (value: string | DohcProvenanceRecord, requestOptions?: DohcRequestOptions) => Promise<void>;
    };
};
