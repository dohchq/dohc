// This file is the single source of truth for the plugin-host wire contract.
// The main process and plugin child share it across their process boundary.

import type {
  PluginAgentEvent,
  PluginAgentProbe,
  PluginJsonValue,
  PluginPermissionDecision,
} from "@dohc/sdk/node";
import type {
  DohcPluginManifest,
  PluginSettingValue,
} from "./pluginManifestSchema";

export const PLUGIN_HOST_METHODS = {
  activate: "plugin.activate",
  deactivate: "plugin.deactivate",
  invokeCommand: "plugin.invokeCommand",
  startWebApp: "plugin.startWebApp",
  stopWebApp: "plugin.stopWebApp",
  settingsChanged: "plugin.settingsChanged",
  sdkRequest: "sdk.request",
  sdkEvent: "sdk.event",
  log: "plugin.log",
  driverProbe: "driver.probe",
  driverStartSession: "driver.startSession",
  driverPrompt: "driver.prompt",
  driverCancel: "driver.cancel",
  driverAnswerPermission: "driver.answerPermission",
  driverAnswerUserInput: "driver.answerUserInput",
  driverSetModel: "driver.setModel",
  driverStop: "driver.stop",
  driverDispose: "driver.dispose",
  driverEvent: "driver.event",
} as const;

export interface PluginActivateParams {
  pluginId: string;
  pluginRoot: string;
  workspaceRoot: string;
  /** See PluginActivateContext.stateRoot in @dohc/sdk/node. */
  stateRoot: string;
  manifest: DohcPluginManifest;
  /** The plugin's settings as they stand right now, already resolved against
   * the manifest's declarations, so a plugin never activates without them. */
  settings: Record<string, PluginSettingValue>;
}

export interface PluginActivateResult {
  commands: string[];
  /** The driver ids the plugin registered. The host requires these to be
   * exactly the ids the manifest declares. */
  drivers: string[];
}

/**
 * The driver half of this contract, in one place.
 *
 * dohc's own agent-driver interface takes two values a process boundary
 * cannot carry: an `onEvent` callback and a `permissionPolicy` function. The
 * callback becomes the `driver.event` notification below. The policy stays in
 * the main process, where its one caller already lives — the host applies it
 * to an arriving permission request and answers the plugin through
 * `driver.answerPermission`, so a plugin driver obeys the same policy as a
 * built-in one without the function ever crossing.
 *
 * A session is addressed by `sessionKey`, which the host mints and sends with
 * the start request. The plugin's own `sessionId` comes back in the result.
 * The host cannot address a session by the plugin's id, because a driver
 * reports events (`starting`, and a failure to start) before it has one.
 */
export interface PluginDriverProbeParams {
  driverId: string;
}

export type PluginDriverProbeResult = PluginAgentProbe;

export interface PluginDriverStartSessionParams {
  driverId: string;
  sessionKey: string;
  workspaceRoot: string;
  mode: "approval-required" | "auto-accept-edits" | "full-access";
  model?: string;
  resumeCursor?: PluginJsonValue;
  mcp: { command: string; args: string[]; env?: Record<string, string> };
  logDir?: string;
}

export interface PluginDriverStartSessionResult {
  sessionId: string;
  resumeCursor?: PluginJsonValue;
  /** Which optional session members this session implements. dohc's session
   * interface makes `setModel` and `answerUserInput` optional, and callers
   * test for them, so the host must know which ones exist rather than offer
   * both and fail one at call time. */
  supports: { setModel: boolean; answerUserInput: boolean };
}

export interface PluginDriverSessionParams {
  sessionKey: string;
}

export interface PluginDriverPromptParams extends PluginDriverSessionParams {
  text: string;
  attachments?: Array<{ type: "image"; pathOrUrl: string }>;
}

export interface PluginDriverPromptResult {
  turnId: string;
}

export interface PluginDriverAnswerPermissionParams
  extends PluginDriverSessionParams {
  requestId: string;
  decision: PluginPermissionDecision;
}

export interface PluginDriverAnswerUserInputParams
  extends PluginDriverSessionParams {
  requestId: string;
  answers: Record<string, string | string[]>;
}

export interface PluginDriverSetModelParams extends PluginDriverSessionParams {
  modelId: string;
}

/** Plugin to host, one per event the driver reports. */
export interface PluginDriverEventParams extends PluginDriverSessionParams {
  event: PluginAgentEvent;
}

/**
 * A probe answers from a spawn of the harness executable. The built-in
 * drivers allow one such spawn 3 seconds; a driver plugin's probe runs the
 * version check and a login check, and answers over the plugin transport.
 * Measured on this machine (2026-08-17, three runs each): `claude --version`
 * 0.12–0.13 s, `codex --version` 0.42–0.43 s, `codex login status`
 * 0.43 s, `claude auth whoami` 0.22 s. Fifteen seconds clears two of the
 * slowest measured spawns many times over, and it exists so one unresponsive
 * plugin cannot hold up the whole probe list.
 */
export const PLUGIN_DRIVER_PROBE_TIMEOUT_MS = 15_000;

export interface PluginInvokeCommandParams {
  commandId: string;
}

export interface PluginStartWebAppParams {
  webAppId: string;
  /** Which instance to serve, for a web app the manifest marks `instanced`;
   * null for one that opens a single app. The plugin decides what the key
   * means and may serve a different origin for each one. */
  instanceKey: string | null;
}

/** The result's `url` may carry a one-time credential in its fragment. It
 * stays in memory between the plugin process and the main process; nothing
 * on this path logs it. */
export interface PluginStartWebAppResult {
  url: string;
  /** What to call this instance's tab. Absent means the manifest title, which
   * is the same for every instance of one id. */
  title?: string;
}

/** The reverse of a start. A start can hand the guest a one-time credential,
 * and the plugin has no way to learn that the guest never arrived — the host
 * says so with this. The plugin ends the session the start paired, so the
 * next start pairs again. */
export interface PluginStopWebAppParams {
  webAppId: string;
  /** The instance the matching start paired. Stopping one instance leaves the
   * plugin's other instances running. */
  instanceKey: string | null;
}

/**
 * Sent by the host whenever the user changes one of this plugin's settings.
 *
 * A request rather than a notification: every other host-to-plugin message
 * already travels that way, so this needs no new transport machinery, and the
 * reply tells the host the running plugin actually took the change. The host
 * does not wait on it — a slow plugin must never hold up a save.
 *
 * The values are complete and already resolved, never a patch: a plugin reads
 * its settings, it does not merge them.
 */
export interface PluginSettingsChangedParams {
  values: Record<string, PluginSettingValue>;
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

// A web app stop terminates the wrapper's server and clears its ownership
// record. The t3 bridge's terminate is a SIGTERM with a 2-second grace before
// SIGKILL; this sits above that grace plus the record's own file write.
export const PLUGIN_WEB_APP_STOP_TIMEOUT_MS = 10_000;

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
