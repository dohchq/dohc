import type { ChangeAuthor, MomentAuthor } from "@dohc/workspace-contracts/engine";
import {
  assertRawTextWritable,
  invokeSiteSdkHost,
  record,
  siteSdkWorkspacePath,
  type SiteSdkHostContext,
} from "../workspaces/siteSdkHost";
import { isPluginChildProcessMethod } from "./pluginChildProcessBroker";

const ABORTED_ERROR_CODE = "DOHC_ABORTED";

class PluginSdkAbortError extends Error {
  readonly code = ABORTED_ERROR_CODE;
}

export interface PluginSdkHostContext {
  pluginId: string;
  workspaceRoot: string;
  /** The uuid PluginHost assigned this plugin at spawn time (agentRunId). */
  spawnId: string;
  /**
   * Which caller this request arrived from. "panel" is a renderer showing the
   * plugin's panel, so it can act on a returned ui.open target; the plugin's
   * own process has no renderer and cannot. Both paths otherwise carry the
   * same plugin authority.
   */
  requestPath: "panel" | "plugin-process";
  isWritable: () => boolean;
  writeAvailable: () => Promise<boolean>;
  /**
   * Aborts either because the renderer's panel authority went stale, or
   * because this exact plugin spawn stopped, crashed, or was replaced —
   * the caller (main.ts) supplies whichever applies to its own invocation
   * path; this module treats both the same way.
   */
  signal?: AbortSignal;
  /** Absent for panel-driven SDK calls; only a plugin's own routeSdkRequest
   * path supplies this, since only the plugin's own process may broker
   * child processes on its behalf. */
  invokeChildProcess?: (method: string, params?: unknown) => Promise<unknown>;
  /**
   * Performs the actual authored write. The host derives and stamps the
   * author; plugin code never supplies identity.
   */
  writeAuthoredText: (
    path: string,
    text: string,
    options: { overwrite: boolean; author: MomentAuthor },
  ) => Promise<{ path: string }>;
}

/** The one agent identity every authored plugin operation is recorded under. */
function pluginAgentId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * A plugin's database edits name the plugin, not the user running it.
 * ChangeAuthor carries no agentRunId, so the op log records which plugin
 * wrote a row; a file write records the spawn as well.
 */
function pluginDatabaseAuthor(pluginId: string): ChangeAuthor {
  return { kind: "agent", agentId: pluginAgentId(pluginId), onBehalfOf: "local" };
}

function abortError(): PluginSdkAbortError {
  return new PluginSdkAbortError(
    "The plugin spawn ended before the SDK operation completed.",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function waitForOperation<T>(
  signal: AbortSignal | undefined,
  operation: Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (result: { value: T } | { error: unknown }): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };
    const onAbort = (): void => finish({ error: abortError() });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
}

function pluginCapabilities(input: {
  fileWriteAvailable: boolean;
  databaseEditAvailable: boolean;
  childProcessesAvailable: boolean;
  uiOpenAvailable: boolean;
}) {
  const childProcesses = input.childProcessesAvailable;
  return {
    files: { read: true, list: true, write: input.fileWriteAvailable, watch: false },
    workspace: { search: true },
    // Database edits are written and logged directly, so unlike files.write
    // they do not need a running engine capture — only workspace authority.
    databases: { read: true, edit: input.databaseEditAvailable },
    // Opening a tab is a renderer action; see requestPath.
    ui: { open: input.uiOpenAvailable },
    // Reflects whether this exact request path can actually broker child
    // processes, not just whether the plugin's own activated code could —
    // invokeChildProcess is absent for panel-driven SDK calls, which get a
    // real "unavailable for this request path" error from every
    // childProcesses.* method below regardless of what capabilities()
    // claims (#779 round 3 finding 7).
    childProcesses: {
      spawn: childProcesses,
      output: childProcesses,
      send: childProcesses,
      terminate: childProcesses,
    },
    collections: { read: false },
    provenance: { record: false },
  };
}

export async function invokePluginSdkHost(
  context: PluginSdkHostContext,
  method: string,
  params?: unknown,
): Promise<unknown> {
  // No pre-dispatch abort check here: each case below owns its own signal
  // handling (files.write's own read-only/panel-stale message, or
  // waitForOperation's generic DOHC_ABORTED for reads/searches/child
  // processes) — a single check here would win over files.write's more
  // specific "Plugin panel is no longer active." message.
  const siteContext: SiteSdkHostContext = {
    workspaceRoot: context.workspaceRoot,
    scopeRoot: null,
    writable: context.isWritable(),
    signal: context.signal,
    author: pluginDatabaseAuthor(context.pluginId),
  };

  switch (method) {
    case "capabilities": {
      const writeAvailable =
        context.isWritable() && (await context.writeAvailable());
      return pluginCapabilities({
        fileWriteAvailable: writeAvailable && context.isWritable(),
        databaseEditAvailable: context.isWritable(),
        childProcessesAvailable: context.invokeChildProcess !== undefined,
        uiOpenAvailable: context.requestPath === "panel",
      });
    }
    case "files.read":
    case "files.list":
    case "workspace.search":
    case "databases.read":
      return waitForOperation(
        context.signal,
        invokeSiteSdkHost(siteContext, method, params),
      );
    case "databases.edit": {
      if (!context.isWritable()) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      return waitForOperation(
        context.signal,
        invokeSiteSdkHost(siteContext, method, params),
      );
    }
    case "ui.open": {
      if (context.requestPath !== "panel") {
        throw new Error(
          'ui.open is unavailable for this request path (requestPath "plugin-process"). Opening a tab needs a renderer, so a plugin opens one from its panel.',
        );
      }
      return waitForOperation(
        context.signal,
        invokeSiteSdkHost(siteContext, method, params),
      );
    }
    case "files.write": {
      if (!context.isWritable()) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      if (!(await context.writeAvailable())) {
        throw new Error("Plugin file writes are unavailable in this workspace.");
      }
      if (context.signal?.aborted) {
        throw new Error("Plugin panel is no longer active.");
      }
      const input = record(params);
      const path = siteSdkWorkspacePath(null, input.path, "write");
      assertRawTextWritable(path);
      if (typeof input.text !== "string") {
        throw new Error("files.write text must be a string.");
      }
      const overwrite = input.overwrite;
      if (overwrite !== undefined && typeof overwrite !== "boolean") {
        throw new Error(
          `files.write overwrite must be a boolean; received a value of type "${typeof overwrite}".`,
        );
      }

      const author: MomentAuthor = {
        kind: "agent",
        agentId: pluginAgentId(context.pluginId),
        onBehalfOf: "local",
        agentRunId: context.spawnId,
      };
      // No generic abort-normalizing catch here: the caller's own
      // writeAuthoredText already names the specific reason a queued write
      // was cancelled (e.g. "Plugin panel is no longer active." from the
      // real engine capture, per PluginHost.test.ts's
      // "aborts a queued panel write when the plugin crashes") — wrapping
      // that in a generic DOHC_ABORTED would throw away the more useful
      // message.
      return await context.writeAuthoredText(
        path,
        input.text,
        { overwrite: overwrite === undefined ? true : overwrite, author },
      );
    }
    default:
      if (isPluginChildProcessMethod(method)) {
        if (!context.invokeChildProcess) {
          throw new Error(
            `Plugin child processes are unavailable for this request path (method "${method}").`,
          );
        }
        return waitForOperation(
          context.signal,
          context.invokeChildProcess(method, params),
        );
      }
      throw new Error(`Unsupported dohc SDK method: ${method}`);
  }
}
