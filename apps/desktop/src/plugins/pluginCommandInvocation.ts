import type {
  InvokePluginCommandPayload,
  InvokePluginCommandResult,
} from "../ipc/bridgeContract";

interface PluginCommandRegistration {
  manifest: {
    commands?: readonly { id: string; title: string }[];
  };
}

interface PluginCommandHost {
  getSpawnId(pluginId: string): string | undefined;
  invokeCommand(pluginId: string, commandId: string): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function invokeRegisteredPluginCommand<
  TPlugin extends PluginCommandRegistration,
>(options: {
  input: InvokePluginCommandPayload;
  plugin: TPlugin;
  ensureStarted: (plugin: TPlugin) => Promise<PluginCommandHost>;
}): Promise<InvokePluginCommandResult> {
  const { input, plugin } = options;
  const command = plugin.manifest.commands?.find(
    (candidate) => candidate.id === input.commandId,
  );
  if (!command) {
    return {
      status: "command-not-declared",
      message:
        `Plugin "${input.pluginId}" does not declare command "${input.commandId}".`,
    };
  }

  let host: PluginCommandHost;
  try {
    host = await options.ensureStarted(plugin);
  } catch (error) {
    return { status: "command-failed", message: errorMessage(error) };
  }
  if (!host.getSpawnId(input.pluginId)) {
    return {
      status: "plugin-not-found",
      message: `Plugin "${input.pluginId}" has no active process.`,
    };
  }

  try {
    const result = await host.invokeCommand(input.pluginId, input.commandId);
    return { status: "ok", result };
  } catch (error) {
    return { status: "command-failed", message: errorMessage(error) };
  }
}
