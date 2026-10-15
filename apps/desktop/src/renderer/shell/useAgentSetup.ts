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
  workspaceIsReady: boolean,
) {
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatusResult | null>(null);
  const agentSetupRequestRef = useRef(0);
  const bootstrapAgentStatusRead = useRef<Promise<AgentRunStatusResult> | null>(null);

  const agentSetup = useMemo<AgentSetupSummary | null>(() => {
    if (!workspaceIsReady || !userSettings || !agentRunStatus) return null;
    return {
      preferredName: userSettings.settings.profile.preferredName,
      agentName: userSettings.settings.profile.agentName,
      runnerConfigured:
        configuredRunnerCommand(userSettings.settings.runner).length > 0,
      runnerEnabled: userSettings.settings.runner.enabled,
      agentRunActive: agentRunStatus.activeRun !== null,
    };
  }, [agentRunStatus, userSettings, workspaceIsReady]);

  // The workspace-scoped half of the setup snapshot is also the initial
  // agent-status answer for the history lane. Both consumers share this promise.
  useEffect(() => {
    const version = agentSetupRequestRef.current + 1;
    agentSetupRequestRef.current = version;
    setAgentRunStatus(null);
    bootstrapAgentStatusRead.current = null;
    if (!workspaceIsReady) return;
    const read = bridge().getAgentRunStatus({
      workspaceId,
    });
    bootstrapAgentStatusRead.current = read;
    void read
      .then((run) => {
        if (agentSetupRequestRef.current !== version) return;
        setAgentRunStatus(run);
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
    bootstrapAgentStatusRead.current = null;
    const version = agentSetupRequestRef.current + 1;
    agentSetupRequestRef.current = version;
    void bridge()
      .getAgentRunStatus({ workspaceId })
      .then((run) => {
        if (agentSetupRequestRef.current === version) setAgentRunStatus(run);
      })
      .catch(() => {
        if (agentSetupRequestRef.current === version) setAgentRunStatus(null);
      });
  }, [workspaceId, settingsSection, workspaceIsReady]);

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
