import {
  isDatabaseFile,
  isDatabaseSidecar,
} from "@dohc/workspace-core";
import type { AgentAuthor } from "@dohc/workspace-engine-client";
import {
  invokeSiteSdkHost,
  siteSdkWorkspacePath,
  type SiteSdkHostContext,
} from "../workspaces/siteSdkHost";

type RecordValue = Record<string, unknown>;

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

const AUTHOR_FIELDS = [
  "author",
  "agentId",
  "onBehalfOf",
  "agentRunId",
  "kind",
] as const;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("parameters must be an object.");
  }
  return value as RecordValue;
}

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
      const writeParams = { ...input };
      for (const field of AUTHOR_FIELDS) delete writeParams[field];

      const path = siteSdkWorkspacePath(null, writeParams.path, "write");
      if (isDatabaseFile(path) || isDatabaseSidecar(path)) {
        throw new Error(
          "files.write cannot overwrite database files. Use databases.edit so structured transactions, history, and collaboration are preserved.",
        );
      }
      if (/\.(?:md|markdown)$/i.test(path)) {
        throw new Error(
          "files.write cannot overwrite canonical Markdown documents. Use a dohc document editing capability so locks, history, and collaboration are preserved.",
        );
      }
      if (typeof writeParams.text !== "string") {
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
        writeParams.text,
        { overwrite: writeParams.overwrite !== false, author },
      );
    }
    default:
      throw new Error(`Unsupported dohc SDK method: ${method}`);
  }
}
