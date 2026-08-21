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

export async function invokeRegisteredPluginCommand(options: {
  input: InvokePluginCommandPayload;
  plugin: PluginCommandRegistration;
  ensureStarted: () => Promise<PluginCommandHost>;
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
    host = await options.ensureStarted();
  } catch (error) {
    return { status: "command-failed", message: errorMessage(error) };
  }
  if (!host.getSpawnId(input.pluginId)) {
    return {
      status: "plugin-not-running",
      message: `Plugin "${input.pluginId}" has no active process.`,
    };
  }

  try {
    await host.invokeCommand(input.pluginId, input.commandId);
    return { status: "ok" };
  } catch (error) {
    return { status: "command-failed", message: errorMessage(error) };
  }
}
