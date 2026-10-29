import { firstAgent, firstAgentWithLaunch, listAgents } from "../../settings/userSettings";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRunStatusResult,
  DesktopUserSettingsResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { SettingsSectionId } from "../settings/settingsRegistry";
import type { AgentSetupSummary } from "../workbench/ChatsView";

export function useAgentSetup(
  workspaceId: string,
  userSettings: DesktopUserSettingsResult | null,
  settingsSection: SettingsSectionId | null,
  workspaceIsReady: boolean,
) {
  // Each answer keeps the workspace it was read for, so the render between a
  // switch and its reset never pairs one workspace's run with another.
  const [agentRunStatus, setAgentRunStatus] = useState<{ workspaceId: string; run: AgentRunStatusResult } | null>(null);
  const agentSetupRequestRef = useRef(0);

  const agentSetup = useMemo<AgentSetupSummary | null>(() => {
    if (!workspaceIsReady || !userSettings || agentRunStatus?.workspaceId !== workspaceId) return null;
    const agent = firstAgent(userSettings.settings);
    const runner = firstAgentWithLaunch(userSettings.settings);
    return {
      workspaceId,
      preferredName: userSettings.settings.profile.preferredName,
      agentName: agent?.name,
      runnerConfigured: runner !== null,
      runnerEnabled: runner?.enabled === true,
      agentRunActive: agentRunStatus.run.activeRun !== null,
      agents: listAgents(userSettings.settings)
        .flatMap(({ id, name, enabled, launch }) => launch ? [{ id, name, enabled }] : []),
    };
  }, [agentRunStatus, userSettings, workspaceId, workspaceIsReady]);

  // The workspace-scoped half of the setup snapshot.
  useEffect(() => {
    const version = agentSetupRequestRef.current + 1;
    agentSetupRequestRef.current = version;
    setAgentRunStatus(null);
    if (!workspaceIsReady) return;
    void bridge()
      .getAgentRunStatus({ workspaceId })
      .then((run) => {
        if (agentSetupRequestRef.current !== version) return;
        setAgentRunStatus({ workspaceId, run });
      })
      .catch(() => {
        if (agentSetupRequestRef.current === version) setAgentRunStatus(null);
      });
    return () => {
      if (agentSetupRequestRef.current === version) agentSetupRequestRef.current += 1;
    };
  }, [workspaceId, workspaceIsReady]);

  const previousSettingsSection = useRef<SettingsSectionId | null>(null);
  useEffect(() => {
    const wasOpen = previousSettingsSection.current !== null;
    previousSettingsSection.current = settingsSection;
    if (!workspaceIsReady || !wasOpen || settingsSection !== null) return;
    const version = agentSetupRequestRef.current + 1;
    agentSetupRequestRef.current = version;
    void bridge()
      .getAgentRunStatus({ workspaceId })
      .then((run) => {
        if (agentSetupRequestRef.current === version) setAgentRunStatus({ workspaceId, run });
      })
      .catch(() => {
        if (agentSetupRequestRef.current === version) setAgentRunStatus(null);
      });
  }, [workspaceId, settingsSection, workspaceIsReady]);

  return { agentSetup };
}
