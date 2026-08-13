export interface PluginPanelSdkGrantInput {
  senderId: number;
  generation: number;
  workspaceId: string;
  pluginId: string;
  panelId: string;
  workspaceRoot: string;
  pluginRoot: string;
  spawnId: string;
  writable: boolean;
}

export interface PluginPanelSdkGrant extends PluginPanelSdkGrantInput {
  signal: AbortSignal;
}

interface StoredGrant extends PluginPanelSdkGrantInput {
  controller: AbortController;
}

function grantKey(
  senderId: number,
  workspaceId: string,
  pluginId: string,
  panelId: string,
): string {
  return `${senderId}\0${workspaceId}\0${pluginId}\0${panelId}`;
}

export function createPluginPanelSdkAuthorityRegistry() {
  const grants = new Map<string, StoredGrant>();

  const revoke = (key: string, grant: StoredGrant) => {
    grants.delete(key);
    grant.controller.abort();
  };

  return {
    register(input: PluginPanelSdkGrantInput): PluginPanelSdkGrant {
      for (const [key, grant] of grants) {
        if (
          grant.workspaceId === input.workspaceId &&
          grant.pluginId === input.pluginId &&
          grant.panelId === input.panelId
        ) {
          revoke(key, grant);
        }
      }
      const controller = new AbortController();
      grants.set(
        grantKey(
          input.senderId,
          input.workspaceId,
          input.pluginId,
          input.panelId,
        ),
        { ...input, controller },
      );
      return { ...input, signal: controller.signal };
    },

    authorize(input: {
      senderId: number;
      generation: number;
      activeWorkspaceId: string | undefined;
      workspaceId: string;
      pluginId: string;
      panelId: string;
      panelRunning: boolean;
    }): PluginPanelSdkGrant {
      if (input.activeWorkspaceId !== input.workspaceId) {
        throw new Error(
          "Plugin panel SDK request does not target this renderer's active workspace.",
        );
      }
      const key = grantKey(
        input.senderId,
        input.workspaceId,
        input.pluginId,
        input.panelId,
      );
      const grant = grants.get(key);
      if (!grant) {
        throw new Error(
          "Plugin panel SDK request does not belong to an active panel in this renderer.",
        );
      }
      if (grant.generation !== input.generation || !input.panelRunning) {
        revoke(key, grant);
        throw new Error("Plugin panel SDK authority is stale.");
      }
      return { ...grant, signal: grant.controller.signal };
    },

    revokePanel(workspaceId: string, pluginId: string, panelId: string): void {
      for (const [key, grant] of grants) {
        if (
          grant.workspaceId === workspaceId &&
          grant.pluginId === pluginId &&
          grant.panelId === panelId
        ) {
          revoke(key, grant);
        }
      }
    },

    revokeSender(senderId: number): void {
      for (const [key, grant] of grants) {
        if (grant.senderId === senderId) revoke(key, grant);
      }
    },

    revokeAll(): void {
      for (const [key, grant] of grants) revoke(key, grant);
    },
  };
}

export type PluginPanelSdkAuthorityRegistry = ReturnType<
  typeof createPluginPanelSdkAuthorityRegistry
>;
