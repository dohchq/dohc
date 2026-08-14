import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
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

function pluginCapabilities(writable: boolean, childProcessesAvailable: boolean) {
  return {
    files: { read: true, list: true, write: writable, watch: false },
    workspace: { search: true },
    // Reflects whether this exact request path can actually broker child
    // processes, not just whether the plugin's own activated code could —
    // invokeChildProcess is absent for panel-driven SDK calls, which get a
    // real "unavailable for this request path" error from every
    // childProcesses.* method below regardless of what capabilities()
    // claims (#779 round 3 finding 7).
    childProcesses: {
      spawn: childProcessesAvailable,
      output: childProcessesAvailable,
      send: childProcessesAvailable,
      terminate: childProcessesAvailable,
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
  };

  switch (method) {
    case "capabilities": {
      const writeAvailable =
        context.isWritable() && (await context.writeAvailable());
      return pluginCapabilities(
        writeAvailable && context.isWritable(),
        context.invokeChildProcess !== undefined,
      );
    }
    case "files.read":
    case "files.list":
    case "workspace.search":
      return waitForOperation(
        context.signal,
        invokeSiteSdkHost(siteContext, method, params),
      );
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
        agentId: `plugin:${context.pluginId}`,
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
