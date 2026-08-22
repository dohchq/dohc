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

/**
 * Thrown by an `ensureStarted` implementation that rechecked the command
 * claims barrier right at its own pipeline-enqueue point and found it
 * raised — a stopping action started queuing after this command's own
 * earlier check passed, before it claimed. Mapped to the same retryable
 * "plugin-rebuilding" status that check already returns, not a generic
 * command failure: this call never reached anything, so retrying it costs
 * nothing (round-17 finding 2).
 */
export class PluginClaimsDrainingError extends Error {
  constructor(pluginId: string) {
    super(`Plugin "${pluginId}" isn't available right now. Try the command again in a moment.`);
    this.name = "PluginClaimsDrainingError";
  }
}

export async function invokeRegisteredPluginCommand(options: {
  input: InvokePluginCommandPayload;
  plugin: PluginCommandRegistration;
  ensureStarted: () => Promise<PluginCommandHost>;
  ensureCurrent?: () => void;
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
    if (error instanceof PluginClaimsDrainingError) {
      return { status: "plugin-rebuilding", message: error.message };
    }
    return { status: "command-failed", message: errorMessage(error) };
  }
  try {
    options.ensureCurrent?.();
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
