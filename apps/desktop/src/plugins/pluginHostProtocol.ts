// This file is the single source of truth for the plugin-host wire contract.
// The main process and plugin child share it across their process boundary.

import type { DohcPluginManifest } from "@dohc/workspace-contracts/plugin-manifest";

export const PLUGIN_HOST_METHODS = {
  activate: "plugin.activate",
  deactivate: "plugin.deactivate",
  sdkRequest: "sdk.request",
  log: "plugin.log",
} as const;

export interface PluginActivateParams {
  pluginId: string;
  pluginRoot: string;
  workspaceRoot: string;
  manifest: DohcPluginManifest;
  hostGeneration: number;
}

export interface PluginActivateResult {
  commands: string[];
}

export interface SdkRequestParams {
  method: string;
  params?: unknown;
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

// Disable a plugin after this many consecutive fast failures or crashes.
// Each failure must occur within this window after its own spawn.
export const PLUGIN_CRASH_LOOP_THRESHOLD = 3;
export const PLUGIN_FAST_FAILURE_WINDOW_MS = 60_000;

export interface PluginTransport {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
}
