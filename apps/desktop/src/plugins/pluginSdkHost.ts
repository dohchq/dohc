import type { MomentAuthor } from "@dohc/workspace-contracts/engine";
import {
  assertRawTextWritable,
  invokeSiteSdkHost,
  record,
  siteSdkWorkspacePath,
  type SiteSdkHostContext,
} from "../workspaces/siteSdkHost";

export interface PluginSdkHostContext {
  pluginId: string;
  workspaceRoot: string;
  /** The uuid PluginHost assigned this plugin at spawn time (agentRunId). */
  spawnId: string;
  isWritable: () => boolean;
  writeAvailable: () => Promise<boolean>;
  signal?: AbortSignal;
  writeAuthoredText: (
    path: string,
    text: string,
    options: { overwrite: boolean; author: MomentAuthor },
  ) => Promise<{ path: string }>;
}

function pluginCapabilities(writable: boolean) {
  return {
    files: { read: true, list: true, write: writable, watch: false },
    workspace: { search: true },
    collections: { read: false },
    provenance: { record: false },
  };
}

export async function invokePluginSdkHost(
  context: PluginSdkHostContext,
  method: string,
  params?: unknown,
): Promise<unknown> {
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
      return pluginCapabilities(writeAvailable && context.isWritable());
    }
    case "files.read":
    case "files.list":
    case "workspace.search":
      return invokeSiteSdkHost(siteContext, method, params);
    case "files.write": {
      if (!context.isWritable()) {
        throw new Error("This plugin has read-only workspace authority.");
      }
      if (!(await context.writeAvailable())) {
        throw new Error("Plugin file writes are unavailable in this workspace.");
      }
      if (!context.isWritable()) {
        throw new Error("This plugin has read-only workspace authority.");
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
      return context.writeAuthoredText(
        path,
        input.text,
        { overwrite: overwrite === undefined ? true : overwrite, author },
      );
    }
    default:
      throw new Error(`Unsupported dohc SDK method: ${method}`);
  }
}
