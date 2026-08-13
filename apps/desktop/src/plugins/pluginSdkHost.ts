import type { AgentAuthor } from "@dohc/workspace-engine-client";
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
  /**
   * Performs the actual authored write. PR1a ships no production
   * implementation of this. A later PR wires it to the versioned engine.
   */
  writeAuthoredText: (
    workspaceRoot: string,
    path: string,
    text: string,
    options: { overwrite: boolean; author: AgentAuthor },
  ) => Promise<{ path: string }>;
}

const PLUGIN_CAPABILITIES = {
  files: { read: true, list: true, write: true, watch: false },
  workspace: { search: true },
  collections: { read: false },
  provenance: { record: false },
};

export async function invokePluginSdkHost(
  context: PluginSdkHostContext,
  method: string,
  params?: unknown,
): Promise<unknown> {
  const siteContext: SiteSdkHostContext = {
    workspaceRoot: context.workspaceRoot,
    scopeRoot: null,
    writable: true,
  };

  switch (method) {
    case "capabilities":
      return PLUGIN_CAPABILITIES;
    case "files.read":
    case "files.list":
    case "workspace.search":
      return invokeSiteSdkHost(siteContext, method, params);
    case "files.write": {
      const input = record(params);
      const path = siteSdkWorkspacePath(null, input.path, "write");
      assertRawTextWritable(path);
      if (typeof input.text !== "string") {
        throw new Error("files.write text must be a string.");
      }

      const author: AgentAuthor = {
        kind: "agent",
        agentId: `plugin:${context.pluginId}`,
        onBehalfOf: "local",
        agentRunId: context.spawnId,
      };
      return context.writeAuthoredText(
        context.workspaceRoot,
        path,
        input.text,
        { overwrite: input.overwrite !== false, author },
      );
    }
    default:
      throw new Error(`Unsupported dohc SDK method: ${method}`);
  }
}
