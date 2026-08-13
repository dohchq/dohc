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
  spawnId: string;
  writable: boolean;
}

export interface PluginPanelSdkGrant extends PluginPanelSdkGrantInput {
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
    SdkAuthorityAuthorization<PluginPanelSubject> & { panelRunning: boolean }
  >(
    {
      label: "Plugin panel SDK",
      subject: "panel",
      stale: "Plugin panel SDK authority is stale.",
    },
    subjectKey,
    (input) => input.panelRunning,
  );

  return {
    register: registry.register,
    authorize: registry.authorize,
    revokePanel: (workspaceId: string, pluginId: string, panelId: string) =>
      registry.revokeSubject(subjectKey({ workspaceId, pluginId, panelId })),
    revokeSender: registry.revokeSender,
    revokeAll: registry.revokeAll,
  };
}

export type PluginPanelSdkAuthorityRegistry = ReturnType<
  typeof createPluginPanelSdkAuthorityRegistry
>;
