import {
  createDohcClient,
  createPluginChildProcessClient,
  createProcessTransport,
  type PluginActivateContext,
  type PluginHandler,
} from "@dohc/sdk/node";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_HOST_METHODS,
  type PluginActivateParams,
  type PluginInvokeCommandParams,
  type PluginStartWebAppParams,
  type PluginStartWebAppResult,
  type PluginStopWebAppParams,
} from "./pluginHostProtocol.ts";
const transport = createProcessTransport();
const client = createDohcClient({ transport });
const childProcesses = createPluginChildProcessClient(transport);
const commandRuns = new Map<string, (...args: unknown[]) => unknown>();
let activeHandler: PluginHandler | null = null;

// Local on purpose, not pluginShared's: this file is a standalone child
// entry that plain Node also executes directly from source (PluginHost's
// tests fork it as-is), where an extension-less relative import does not
// resolve under type stripping.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPluginHandler(value: unknown): value is PluginHandler {
  return (
    typeof value === "object" &&
    value !== null &&
    "activate" in value &&
    typeof value.activate === "function"
  );
}

transport.onRequest(PLUGIN_HOST_METHODS.activate, async (rawParams) => {
  const params = rawParams as PluginActivateParams;
  const pluginModule = await import(
    pathToFileURL(join(params.pluginRoot, params.manifest.entry)).href
  ) as { default?: unknown };
  const handler = pluginModule.default;
  if (!isPluginHandler(handler)) {
    throw new Error(
      `Plugin entry "${params.manifest.entry}" must export a default object with an activate(ctx) function.`,
    );
  }

  const registeredCommandIds: string[] = [];
  const ctx: PluginActivateContext = {
    pluginId: params.pluginId,
    workspaceRoot: params.workspaceRoot,
    pluginRoot: params.pluginRoot,
    stateRoot: params.stateRoot,
    client,
    childProcesses,
    commands: {
      register(id, run) {
        registeredCommandIds.push(id);
        commandRuns.set(id, run);
      },
    },
  };

  await handler.activate(ctx);
  activeHandler = handler;

  return { commands: registeredCommandIds };
});

transport.onRequest(PLUGIN_HOST_METHODS.deactivate, async () => {
  await activeHandler?.deactivate?.();
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.startWebApp, async (rawParams) => {
  const params = rawParams as PluginStartWebAppParams;
  if (!activeHandler?.startWebApp) {
    throw new Error(
      "This plugin declares web apps but its handler does not implement startWebApp(webAppId).",
    );
  }
  const started = await activeHandler.startWebApp(params.webAppId);
  if (
    typeof started !== "object" ||
    started === null ||
    typeof started.url !== "string" ||
    started.url.length === 0
  ) {
    throw new Error(
      "startWebApp must return { url } with a non-empty string url.",
    );
  }
  return { url: started.url } satisfies PluginStartWebAppResult;
});

transport.onRequest(PLUGIN_HOST_METHODS.stopWebApp, async (rawParams) => {
  const params = rawParams as PluginStopWebAppParams;
  if (!activeHandler?.stopWebApp) {
    throw new Error(
      "This plugin implements startWebApp but its handler does not implement stopWebApp(webAppId).",
    );
  }
  await activeHandler.stopWebApp(params.webAppId);
  return {};
});

transport.onRequest(PLUGIN_HOST_METHODS.invokeCommand, async (rawParams) => {
  const params = rawParams as PluginInvokeCommandParams;
  const run = commandRuns.get(params.commandId);
  if (!run) {
    throw new Error(`Command "${params.commandId}" is not registered.`);
  }
  return run();
});

process.on("uncaughtException", (error) => {
  transport.notify(PLUGIN_HOST_METHODS.log, {
    level: "error",
    message: error.message,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  transport.notify(PLUGIN_HOST_METHODS.log, {
    level: "error",
    message: errorMessage(reason),
  });
  process.exit(1);
});
