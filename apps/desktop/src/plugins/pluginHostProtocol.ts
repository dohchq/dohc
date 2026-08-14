// This file is the single source of truth for the plugin-host wire contract.
// The main process and plugin child share it across their process boundary.

import type { DohcPluginManifest } from "./pluginManifestSchema";

export const PLUGIN_HOST_METHODS = {
  activate: "plugin.activate",
  deactivate: "plugin.deactivate",
  invokeCommand: "plugin.invokeCommand",
  startWebApp: "plugin.startWebApp",
  sdkRequest: "sdk.request",
  sdkEvent: "sdk.event",
  log: "plugin.log",
} as const;

export interface PluginActivateParams {
  pluginId: string;
  pluginRoot: string;
  workspaceRoot: string;
  /** See PluginActivateContext.stateRoot in @dohc/sdk/node. */
  stateRoot: string;
  manifest: DohcPluginManifest;
}

export interface PluginActivateResult {
  commands: string[];
}

export interface PluginInvokeCommandParams {
  commandId: string;
}

export interface PluginStartWebAppParams {
  webAppId: string;
}

/** The result's `url` may carry a one-time credential in its fragment. It
 * stays in memory between the plugin process and the main process; nothing
 * on this path logs it. */
export interface PluginStartWebAppResult {
  url: string;
}

export interface SdkRequestParams {
  method: string;
  params?: unknown;
}

export interface SdkEventParams {
  subscriptionId: string;
  event: string;
  data: unknown;
}

export interface PluginLogParams {
  level: "info" | "warn" | "error";
  message: string;
}

export type PluginRuntimeStatus =
  | "starting"
  | "ready"
  | "failed"
  | "crashed"
  | "disabled";

// The t3-code spike's heaviest healthy activation took 4.5–7.4 seconds.
// A 30-second deadline leaves real headroom above that measured range.
export const PLUGIN_ACTIVATION_TIMEOUT_MS = 30_000;

// A web app start covers a wrapper server's spawn plus its readiness poll.
// The t3 bridge's own readiness deadline is 60 seconds (its measured healthy
// range is 2.8–7.4 seconds); this bound sits above that whole deadline plus
// spawn overhead, so it only fires when the plugin's own deadline failed to.
export const PLUGIN_WEB_APP_START_TIMEOUT_MS = 90_000;

// Disable a plugin after this many consecutive fast failures or crashes.
// Each failure must occur within this window after its own spawn.
export const PLUGIN_CRASH_LOOP_THRESHOLD = 3;
export const PLUGIN_FAST_FAILURE_WINDOW_MS = 60_000;

// Plugin hosts and their brokered children use the same bounded log history.
export const PLUGIN_PROCESS_LOG_LIMIT = 200;

export interface PluginTransport {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  // Required, not optional (CodeRabbit #779 R14): every shipping transport
  // implements this, and an optional method here is exactly the kind of
  // silently-no-op'd dead fallback path the repo's own rules say to remove.
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
}
