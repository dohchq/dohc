import type { ChangeAuthor, MomentAuthor } from "@dohc/workspace-contracts/engine";
import {
  assertRawTextWritable,
  invokeWorkspaceSdkHost,
  record,
  sdkWorkspacePath,
  type WorkspaceSdkHostContext,
} from "../workspaces/workspaceSdkHost";
import { isPluginChildProcessMethod } from "./pluginChildProcessBroker";
import {
  hasControlCharacter,
  MAX_PLUGIN_WEB_APP_INSTANCE_KEY_CHARS,
  requireDeclaredWebApp,
  type DeclaredWebApp,
} from "./pluginWebAppInstances";

const ABORTED_ERROR_CODE = "DOHC_ABORTED";

/**
 * The authority an automation run's collection writes carry, derived
 * main-side from the claim the executor is running on this exact spawn —
 * never from the plugin's request. `depth` is the depth the writes carry:
 * one greater than the claim's own (the trigger's) depth.
 */
export interface PluginAutomationRunAuthority {
  claimId: string;
  /** The engine subscription id: "<plugin name>/<automation id>". */
  automationId: string;
  onBehalfOf: string;
  depth: number;
  /** The claim's attempt number: the engine counts each time it hands the claim out. */
  attempt: number;
  /**
   * Writes this run has issued so far. Each write's idempotency key is the
   * claim id, the attempt, and this ordinal, so a handler that writes twice
   * does not reuse a key, and a re-run never reuses an earlier attempt's.
   */
  writes: number;
}

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
  /** Main-supplied owner-aware read authority; plugins cannot supply or widen it. */
  reads: WorkspaceSdkHostContext["reads"];
  /** Main-supplied structured database writer. */
  editDatabase: WorkspaceSdkHostContext["editDatabase"];
  /**
   * Main-supplied collection record writer (the desktop's one main-side
   * collection write seam). Absent when the invocation path cannot reach an
   * engine capture; the advertised collections.edit capability follows it.
   */
  editCollections?: WorkspaceSdkHostContext["editCollections"];
  /**
   * The web apps this plugin's manifest declares, so `ui.openWebApp` can
   * refuse an id the plugin never contributed and one whose shape does not
   * match the request. The caller reads it from the registered manifest —
   * never from the plugin's own request.
   */
  declaredWebApps?: readonly DeclaredWebApp[];
  /**
   * Aborts either because the renderer's panel authority went stale, or
   * because this exact plugin spawn stopped, crashed, or was replaced —
   * the caller (main.ts) supplies whichever applies to its own invocation
   * path; this module treats both the same way.
   */
  signal?: AbortSignal;
  /**
   * The claim id this request declared itself part of (the SDK transport
   * tags every request made inside a running automation handler), and
   * main's resolution of it against the runs the executor actually started
   * on this exact spawn. A declared claim that no longer resolves is a
   * settled or foreign run: a collection write then refuses rather than
   * silently downgrading to plugin attribution. Both absent for every
   * other request.
   */
  automationClaimId?: string;
  automationRun?: PluginAutomationRunAuthority;
  /** Absent for panel-driven SDK calls; only a plugin's own routeSdkRequest
   * path supplies this, since only the plugin's own process may broker
   * child processes on its behalf. */
  invokeChildProcess?: (method: string, params?: unknown) => Promise<unknown>;
  /**
   * Opens a workspace file subscription. Absent for panel-driven SDK calls:
   * a subscription needs a channel to push events back on, and only the
   * plugin's own process has one. A panel asks its plugin instead.
   */
  subscribeFileWatch?: (params: unknown) => { subscriptionId: string };
  /**
   * Opens a collection record subscription. Absent for the same reason
   * subscribeFileWatch is: a subscription needs a channel to push events
   * back on.
   */
  subscribeRecordWatch?: (
    params: unknown,
    readable?: ReadonlySet<string>,
  ) => { subscriptionId: string };
  /**
   * Ends a workspace subscription (file watch or record watch — one registry
   * owns both kinds), reporting whether that registry owned the id. A false
   * means the id belongs to the child-process broker, which serves the same
   * `subscriptions.unsubscribe` method.
   */
  unsubscribeWorkspaceEvents?: (params: unknown) => boolean;
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
  fileWatchAvailable: boolean;
  databaseEditAvailable: boolean;
  collectionEditAvailable: boolean;
  childProcessesAvailable: boolean;
  uiOpenAvailable: boolean;
}) {
  const childProcesses = input.childProcessesAvailable;
  return {
    // watch reflects this exact request path, like childProcesses below: a
    // panel has no channel to receive events on, so it reads false there.
    files: {
      read: true,
      list: true,
      write: input.fileWriteAvailable,
      watch: input.fileWatchAvailable,
    },
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
    // claims.
    childProcesses: {
      spawn: childProcesses,
      output: childProcesses,
      send: childProcesses,
      terminate: childProcesses,
    },
    // Collection reads ride the same main-supplied read port as file reads,
    // so they share its workspace authority; edits additionally need the
    // main-side write seam and a writable workspace, like databases.edit.
    // collections.watch, like files.watch, refuses per request path itself.
    collections: { read: true, edit: input.collectionEditAvailable },
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
  const hostContext: WorkspaceSdkHostContext = {
    workspaceRoot: context.workspaceRoot,
    writable: context.isWritable(),
    signal: context.signal,
    author: pluginDatabaseAuthor(context.pluginId),
    reads: context.reads,
    editDatabase: context.editDatabase,
    ...(context.editCollections
      ? { editCollections: context.editCollections }
      : {}),
  };

  switch (method) {
    case "capabilities": {
      const writeAvailable =
        context.isWritable() && (await context.writeAvailable());
      return pluginCapabilities({
        fileWriteAvailable: writeAvailable && context.isWritable(),
        fileWatchAvailable: context.subscribeFileWatch !== undefined,
        databaseEditAvailable: context.isWritable(),
        collectionEditAvailable:
          context.isWritable() && context.editCollections !== undefined,
        childProcessesAvailable: context.invokeChildProcess !== undefined,
        uiOpenAvailable: context.requestPath === "panel",
      });
    }
    case "files.read":
    case "files.list":
    case "workspace.search":
    case "databases.read":
    case "collections.list":
    case "collections.get":
    case "collections.query":
    case "collections.getRecord":
      return waitForOperation(
        context.signal,
        invokeWorkspaceSdkHost(hostContext, method, params),
      );
    // The core host refuses a collection write on a read-only workspace
    // itself (hostContext.writable), so the writes need no gate here — but a
    // write made inside an automation run takes the run's own authority: the
    // automation as author on behalf of the owner, at the chain depth main
    // derived from the claim, keyed by the claim id, attempt, and write
    // ordinal. A plugin handler has no stable step identity, so its creates
    // take new random record ids.
    case "collections.setFields":
    case "collections.createRecord": {
      const run = context.automationRun;
      if (context.automationClaimId !== undefined && run === undefined) {
        throw new Error(
          "This write's automation run is no longer active, so it was not applied.",
        );
      }
      const writeContext: WorkspaceSdkHostContext = run
        ? {
            ...hostContext,
            author: {
              kind: "automation",
              automationId: run.automationId,
              onBehalfOf: run.onBehalfOf,
              depth: run.depth,
            },
            collectionWriteIdempotencyKey: `${run.claimId}/${run.attempt}/${run.writes++}`,
          }
        : hostContext;
      return waitForOperation(
        context.signal,
        invokeWorkspaceSdkHost(writeContext, method, params),
      );
    }
    case "databases.edit": {
      if (!context.isWritable()) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      return waitForOperation(
        context.signal,
        invokeWorkspaceSdkHost(hostContext, method, params),
      );
    }
    case "files.watch": {
      if (!context.subscribeFileWatch) {
        throw new Error(
          'files.watch is unavailable for this request path (requestPath "panel"). A subscription needs a channel to push events on, and only a plugin\'s own process has one.',
        );
      }
      // A subscription outlives the call that opens it, so an ended owner
      // must be refused here rather than left holding one until teardown.
      if (context.signal?.aborted) throw abortError();
      return context.subscribeFileWatch(params);
    }
    case "collections.watch": {
      if (!context.subscribeRecordWatch) {
        throw new Error(
          `collections.watch is unavailable for this request path (requestPath "${context.requestPath}"). This surface has no channel to push record events on.`,
        );
      }
      // Same refusal as files.watch: a subscription outlives the call that
      // opens it, so an ended owner must not be handed one.
      if (context.signal?.aborted) throw abortError();
      // A watch on one collection needs the read scope a read of it needs,
      // so the port refuses before any subscription exists. A watch on "."
      // takes the collections the port lists now as its delivery set.
      const watchPath =
        typeof params === "object" && params !== null && "path" in params
          ? (params as { path?: unknown }).path
          : undefined;
      if (typeof watchPath !== "string" || watchPath === ".") {
        const listed = (await waitForOperation(
          context.signal,
          invokeWorkspaceSdkHost(hostContext, "collections.list", {}),
        )) as { collections: Array<{ path: string }> };
        return context.subscribeRecordWatch(
          params,
          new Set(listed.collections.map((collection) => collection.path)),
        );
      }
      await waitForOperation(
        context.signal,
        invokeWorkspaceSdkHost(hostContext, "collections.get", { path: watchPath }),
      );
      return context.subscribeRecordWatch(params);
    }
    // The renderer answers this for a panel before it reaches main, so a
    // request arriving here has no window to read a theme from.
    case "ui.theme":
      throw new Error(
        `ui.theme is unavailable for this request path (requestPath "${context.requestPath}"). dohc answers it in the renderer showing the panel, and a plugin process has no UI to theme.`,
      );
    case "ui.open": {
      if (context.requestPath !== "panel") {
        throw new Error(
          'ui.open is unavailable for this request path (requestPath "plugin-process"). Opening a tab needs a renderer, so a plugin opens one from its panel.',
        );
      }
      return waitForOperation(
        context.signal,
        invokeWorkspaceSdkHost(hostContext, method, params),
      );
    }
    // A plugin opens one of its own web apps, naming the instance it wants.
    // This is the only caller that can: the plugin's page in dohc knows the
    // manifest ids and nothing about what an instance is. The plugin id comes
    // from the panel grant this request arrived under, never from the request,
    // so a panel cannot open another plugin's app.
    case "ui.openWebApp": {
      if (context.requestPath !== "panel") {
        throw new Error(
          'ui.openWebApp is unavailable for this request path (requestPath "plugin-process"). Opening a tab needs a renderer, so a plugin opens one from its panel.',
        );
      }
      throwIfAborted(context.signal);
      const input = record(params);
      if (typeof input.webAppId !== "string" || input.webAppId.length === 0) {
        throw new Error("ui.openWebApp webAppId must be a non-empty string.");
      }
      const instance = input.instanceKey;
      if (typeof instance !== "string" || instance.length === 0) {
        throw new Error(
          "ui.openWebApp instanceKey must be a non-empty string. A web app that opens a single tab is opened from the plugin's page instead.",
        );
      }
      if (instance.length > MAX_PLUGIN_WEB_APP_INSTANCE_KEY_CHARS) {
        throw new Error(
          `ui.openWebApp instanceKey is ${instance.length} characters, past the limit of ${MAX_PLUGIN_WEB_APP_INSTANCE_KEY_CHARS} characters for an instance key.`,
        );
      }
      if (hasControlCharacter(instance)) {
        throw new Error(
          "ui.openWebApp instanceKey must not contain control characters (U+0000 to U+001F, or U+007F).",
        );
      }
      requireDeclaredWebApp(
        context.pluginId,
        context.declaredWebApps,
        input.webAppId,
        instance,
      );
      return { webAppId: input.webAppId, instanceKey: instance };
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
      const path = sdkWorkspacePath(input.path, "write");
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
      // Every subscription kind is closed by the one SDK method, so the
      // workspace-event registry (file and record watches) gets first refusal
      // on its own ids; anything else is the broker's, which answers unknown
      // ids itself.
      if (
        method === "subscriptions.unsubscribe" &&
        context.unsubscribeWorkspaceEvents?.(params) === true
      ) {
        return {};
      }
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
