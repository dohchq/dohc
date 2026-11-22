import { automationAgent, listAgents, runnableAgents } from "../../settings/userSettings";
import { useEffect, useMemo, useRef } from "react";
import type { DesktopUserSettingsResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { SettingsSectionId } from "../settings/settingsRegistry";
import type { AgentSetupSummary } from "../workbench/ChatsView";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";

export function useAgentSetup(
  workspaceId: string,
  userSettings: DesktopUserSettingsResult | null,
  settingsSection: SettingsSectionId | null,
  workspaceIsReady: boolean,
) {
  const run = useWorkspaceQuery(useWorkspaceSession(), {
    key: JSON.stringify([workspaceId, workspaceIsReady]),
    manual: !workspaceIsReady,
    load: () =>
      bridge()
        .getAgentRunStatus({ workspaceId })
        .catch(() => null),
  });
  const { value: agentRunStatus, retry } = run;

  const agentSetup = useMemo<AgentSetupSummary | null>(() => {
    if (!userSettings || !agentRunStatus) return null;
    // The agent Chats sets up is the first one dohc starts; an agent you run may come before it.
    const runner = automationAgent(userSettings.settings);
    return {
      workspaceId,
      preferredName: userSettings.settings.profile.preferredName,
      agentName: runner?.name,
      runnerConfigured: runner !== null,
      runnerEnabled: runnableAgents(userSettings.settings).length > 0,
      agentRunActive: agentRunStatus.activeRun !== null,
      agents: listAgents(userSettings.settings).flatMap(({ id, name, enabled, launch }) =>
        launch ? [{ id, name, enabled }] : [],
      ),
    };
  }, [agentRunStatus, userSettings, workspaceId]);

  const previousSettingsSection = useRef<SettingsSectionId | null>(null);
  useEffect(() => {
    const wasOpen = previousSettingsSection.current !== null;
    previousSettingsSection.current = settingsSection;
    if (!workspaceIsReady || !wasOpen || settingsSection !== null) return;
    void retry();
  }, [retry, settingsSection, workspaceIsReady]);

  return { agentSetup };
}
