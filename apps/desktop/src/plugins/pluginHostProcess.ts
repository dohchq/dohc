import {
  activatePlugin,
  createDohcClient,
  createProcessTransport,
  getActivatedPluginHandler,
  type PluginActivateContext,
  type PluginHandler,
} from "@dohc/sdk/node";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PLUGIN_HOST_METHODS,
  type PluginActivateParams,
} from "./pluginHostProtocol.ts";

const transport = createProcessTransport();
const client = createDohcClient({ transport });
const commandRuns = new Map<string, (...args: unknown[]) => unknown>();
let activeHandler: PluginHandler | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

transport.onRequest(PLUGIN_HOST_METHODS.activate, async (rawParams) => {
  const params = rawParams as PluginActivateParams;
  await import(
    pathToFileURL(join(params.pluginRoot, params.manifest.entry)).href
  );
  const handler = getActivatedPluginHandler();
  if (!handler) {
    throw new Error(
      `Plugin entry "${params.manifest.entry}" did not call activatePlugin().`,
    );
  }

  const registeredCommandIds: string[] = [];
  const ctx: PluginActivateContext = {
    pluginId: params.pluginId,
    workspaceRoot: params.workspaceRoot,
    pluginRoot: params.pluginRoot,
    client,
    commands: {
      register(id, run) {
        registeredCommandIds.push(id);
        commandRuns.set(id, run);
      },
    },
  };

  await handler.activate(ctx);
  activeHandler = handler;

  // PR1a has no remote command-invocation method. This fixture-only hook lets
  // real-process tests run a registered command until that surface exists.
  const triggerId = process.env.DOHC_PLUGIN_FIXTURE_TRIGGER_COMMAND;
  if (triggerId && commandRuns.has(triggerId)) {
    try {
      await Promise.resolve(commandRuns.get(triggerId)!());
    } catch (error) {
      transport.notify(PLUGIN_HOST_METHODS.log, {
        level: "error",
        message: errorMessage(error),
      });
    }
  }

  return { commands: registeredCommandIds };
});

transport.onRequest(PLUGIN_HOST_METHODS.deactivate, async () => {
  await activeHandler?.deactivate?.();
  return {};
});

process.on("uncaughtException", (error) => {
  transport.notify(PLUGIN_HOST_METHODS.log, {
    level: "error",
    message: error.message,
  });
});

process.on("unhandledRejection", (reason) => {
  transport.notify(PLUGIN_HOST_METHODS.log, {
    level: "error",
    message: errorMessage(reason),
  });
});
