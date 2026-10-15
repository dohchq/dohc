import { configuredRunnerCommand } from "../../agents/agentToolCatalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
) {
  // Each answer keeps the workspace it was read for, so the render between a
  // switch and its reset never pairs one workspace's run with another.
  const [agentRunStatus, setAgentRunStatus] = useState<{ workspaceId: string; run: AgentRunStatusResult } | null>(null);
  const agentSetupRequestRef = useRef(0);
  const bootstrapAgentStatusRead = useRef<Promise<AgentRunStatusResult> | null>(null);

  const agentSetup = useMemo<AgentSetupSummary | null>(() => {
    if (!userSettings || agentRunStatus?.workspaceId !== workspaceId) return null;
    return {
      workspaceId,
      preferredName: userSettings.settings.profile.preferredName,
      agentName: userSettings.settings.profile.agentName,
      runnerConfigured:
        configuredRunnerCommand(userSettings.settings.runner).length > 0,
      runnerEnabled: userSettings.settings.runner.enabled,
      agentRunActive: agentRunStatus.run.activeRun !== null,
    };
  }, [agentRunStatus, userSettings, workspaceId]);

  // The workspace-scoped half of the setup snapshot is also the initial
  // agent-status answer for the history lane. Both consumers share this promise.
  useEffect(() => {
    const version = agentSetupRequestRef.current + 1;
    agentSetupRequestRef.current = version;
    setAgentRunStatus(null);
    const read = bridge().getAgentRunStatus({
      workspaceId,
    });
    bootstrapAgentStatusRead.current = read;
    void read
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
  }, [workspaceId]);

  const previousSettingsSection = useRef<SettingsSectionId | null>(null);
  useEffect(() => {
    const wasOpen = previousSettingsSection.current !== null;
    previousSettingsSection.current = settingsSection;
    if (!wasOpen || settingsSection !== null) return;
    bootstrapAgentStatusRead.current = null;
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
  }, [workspaceId, settingsSection]);

  const readAgentStatusForHistory = useCallback(() => {
    const bootstrapRead = bootstrapAgentStatusRead.current;
    if (bootstrapRead) {
      bootstrapAgentStatusRead.current = null;
      return bootstrapRead;
    }
    return bridge().getAgentRunStatus({ workspaceId });
  }, [workspaceId]);

  return { agentSetup, readAgentStatusForHistory };
}
