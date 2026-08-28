import type {
  InvokePluginCommandPayload,
  InvokePluginCommandResult,
} from "../ipc/bridgeContract";
import type {
  PluginHostCommandAuthority,
  PluginHostCommandRunOutcome,
} from "./pluginHostOwnership";

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

/** The pipeline code for a retryable host-ownership refusal. */
export const HOST_CHANGE_REFUSED_ERROR_CODE = "host-change-refused";

/** Maps a command's self-drain refusal to the retryable IPC result. */
export class PluginHostBusyError extends Error {
  constructor(pluginId: string) {
    super(`dohc is still working on plugin "${pluginId}". Try the command again in a moment.`);
    this.name = "PluginHostBusyError";
  }
}

export async function invokeRegisteredPluginCommand(options: {
  input: InvokePluginCommandPayload;
  plugin: PluginCommandRegistration;
  runCommand: (
    operation: (
      command: PluginHostCommandAuthority,
    ) => Promise<InvokePluginCommandResult>,
  ) => Promise<PluginHostCommandRunOutcome<InvokePluginCommandResult>>;
  ensureStarted: (
    command: PluginHostCommandAuthority,
  ) => Promise<PluginCommandHost>;
  ensureCurrent: () => void;
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

  try {
    const outcome = await options.runCommand(async (commandAuthority) => {
      let host: PluginCommandHost;
      try {
        host = await options.ensureStarted(commandAuthority);
      } catch (error) {
        if (error instanceof PluginHostBusyError) {
          return { status: "plugin-rebuilding", message: error.message };
        }
        return { status: "command-failed", message: errorMessage(error) };
      }
      try {
        options.ensureCurrent();
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
    });
    if (outcome.kind === "completed") return outcome.value;
    return outcome.reason === "change-in-progress"
      ? {
        status: "plugin-rebuilding",
        message: new PluginHostBusyError(input.pluginId).message,
      }
      : {
        status: "command-failed",
        message:
          `dohc stopped plugin "${input.pluginId}" before it could run the command. Try again.`,
      };
  } catch (error) {
    return { status: "command-failed", message: errorMessage(error) };
  }
}
