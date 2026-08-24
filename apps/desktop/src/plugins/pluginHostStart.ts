import type { PluginHostStartOutcome } from "./pluginHostOwnership";
import {
  PluginHostOwnership,
  type OwnedPluginHost,
  type PluginHostSurfaceLease,
} from "./pluginHostOwnership";
import {
  HOST_CHANGE_REFUSED_ERROR_CODE,
  PluginHostBusyError,
} from "./pluginCommandInvocation";

interface ActivatingPluginHost {
  activationOf(pluginId: string): Promise<void> | undefined;
}

type PluginStartActionResult =
  | { ok: true }
  | { ok: false; error: { code?: string; message: string } };

function admissionError(
  pluginId: string,
  refusal: { reason: "change-in-progress" | "closed" },
): Error {
  return refusal.reason === "change-in-progress"
    ? new PluginHostBusyError(pluginId)
    : new Error(
      `dohc stopped plugin "${pluginId}" before it could start. Try again.`,
    );
}

export function acquirePluginSurfaceLease<H extends OwnedPluginHost>(
  ownership: PluginHostOwnership<H>,
  pluginId: string,
): PluginHostSurfaceLease {
  const acquired = ownership.acquireSurface(pluginId);
  if ("kind" in acquired) throw admissionError(pluginId, acquired);
  return acquired;
}

// The owner admits the start and consumes its exact evidence. The caller does
// not receive the host until activation finishes.
export async function ensurePluginStarted<H extends ActivatingPluginHost>(
  host: H,
  pluginId: string,
  start: () => Promise<PluginHostStartOutcome<PluginStartActionResult>>,
): Promise<H> {
  const outcome = await start();
  if (outcome.kind === "refused") {
    throw admissionError(pluginId, outcome);
  }
  if (!outcome.value.ok) {
    if (outcome.value.error.code === HOST_CHANGE_REFUSED_ERROR_CODE) {
      throw new PluginHostBusyError(pluginId);
    }
    throw new Error(outcome.value.error.message);
  }
  await host.activationOf(pluginId);
  return host;
}
