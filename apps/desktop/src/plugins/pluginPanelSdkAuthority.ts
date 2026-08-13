import {
  createSdkAuthorityRegistry,
  type SdkAuthorityAuthorization,
} from "../workspaces/sdkAuthorityRegistry";

export interface PluginPanelSdkGrantInput {
  senderId: number;
  generation: number;
  workspaceId: string;
  pluginId: string;
  panelId: string;
  writable: boolean;
}

export interface PluginPanelSdkGrant extends PluginPanelSdkGrantInput {
  spawnId: string;
  signal: AbortSignal;
}

interface PluginPanelSubject {
  workspaceId: string;
  pluginId: string;
  panelId: string;
}

function subjectKey(input: PluginPanelSubject): string {
  return `${input.workspaceId}\0${input.pluginId}\0${input.panelId}`;
}

export function createPluginPanelSdkAuthorityRegistry() {
  const registry = createSdkAuthorityRegistry<
    PluginPanelSdkGrantInput,
    SdkAuthorityAuthorization<PluginPanelSubject> & {
      panelRunning: boolean;
      liveSpawnId: string | undefined;
    }
  >(
    {
      label: "Plugin panel SDK",
      subject: "panel",
      stale: "Plugin panel SDK authority is stale.",
    },
    subjectKey,
    (input) => input.panelRunning && Boolean(input.liveSpawnId),
  );

  return {
    register: registry.register,
    authorize(
      input: Parameters<typeof registry.authorize>[0],
    ): PluginPanelSdkGrant {
      const grant = registry.authorize(input);
      if (!input.liveSpawnId) {
        throw new Error("Plugin panel SDK authority is stale.");
      }
      return { ...grant, spawnId: input.liveSpawnId };
    },
    revokePanel: (workspaceId: string, pluginId: string, panelId: string) =>
      registry.revokeSubject(subjectKey({ workspaceId, pluginId, panelId })),
    revokeSender: registry.revokeSender,
    revokeAll: registry.revokeAll,
  };
}

export type PluginPanelSdkAuthorityRegistry = ReturnType<
  typeof createPluginPanelSdkAuthorityRegistry
>;
