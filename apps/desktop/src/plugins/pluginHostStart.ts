import type { PluginPipeline } from "./PluginPipeline";
import type { PluginSurfaceHostLease, PluginPanelHostLease, PluginWebAppHostLease } from "./pluginSurfaces";
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

function createPluginSurfaceHostLease(
  pipeline: PluginPipeline,
  pluginId: string,
): PluginSurfaceHostLease {
  const host = pipeline.host;
  const lease = acquirePluginSurfaceLease(pipeline.hostOwnership, pluginId);
  return {
    start: async () => {
      const startedHost = await ensurePluginStarted(
        host,
        pluginId,
        () =>
          lease.start((authority) =>
            pipeline.ensureStarted(pluginId, authority),
          ),
      );
      const spawnId = startedHost.getSpawnId(pluginId);
      if (!spawnId) {
        throw new Error(`Plugin "${pluginId}" has no active process.`);
      }
      return spawnId;
    },
    currentSpawnId: () => host.getSpawnId(pluginId),
    release: () => lease.release(),
  };
}

export function createPluginPanelSurfaceHostLease(
  pipeline: PluginPipeline,
  pluginId: string,
): PluginPanelHostLease {
  const host = pipeline.host;
  const lease = createPluginSurfaceHostLease(pipeline, pluginId);
  return {
    ...lease,
    currentRecord: () => host.currentRecord(pluginId),
    startPanel: async (panelId) => {
      const spawnId = await lease.start();
      const ready = host.readyPanelsForSpawn(pluginId, spawnId);
      const panel = ready?.panels.find((candidate) => candidate.id === panelId);
      if (!ready || !panel) {
        throw new Error(
          `Plugin "${pluginId}" does not declare panel "${panelId}" in its active runtime.`,
        );
      }
      return { spawnId, hostRecord: ready.record, panel };
    },
  };
}

export function createPluginWebAppHostLease(
  pipeline: PluginPipeline,
  pluginId: string,
  webAppId: string,
  instanceKey: string | null,
): PluginWebAppHostLease {
  const host = pipeline.host;
  return {
    ...createPluginSurfaceHostLease(pipeline, pluginId),
    startWebApp: () => host.startWebApp(pluginId, webAppId, instanceKey),
    unpair: (expectedSpawnId) => {
      if (host.getSpawnId(pluginId) !== expectedSpawnId) return Promise.resolve();
      return host.stopWebApp(pluginId, webAppId, instanceKey);
    },
  };
}
