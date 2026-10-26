import { useRequestSequence } from "../useRequestSequence";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import type { Agent, AgentProblem, AgentSettings, DesktopUserSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { AgentList } from "./AgentList";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { SettingRow } from "./SettingRow";

export function AgentsMcpSettings(props: {
  workspaceId: string;
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>) => void;
  settings: DesktopUserSettings;
  agentProblems?: readonly AgentProblem[];
  onSave: (settings: DesktopUserSettings) => Promise<void>;
  onOpenSettingsFile: () => void;
  agentName?: string;
  onAgentNameChange?: (name: string) => Promise<void>;
  // The first agent, or null before there is one.
  agent: Agent | null;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  onAgentChange: (fields: Pick<AgentSettings, "launch" | "enabled" | "timeoutMinutes">) => Promise<void>;
}) {
  const {
    workspaceId,
    agent,
    sharedView,
    sessionRecorderOn,
    onAgentChange,
    onError,
  } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  // Workspace async safety invariant: IPC responses are allowed to update this
  // panel only if they belong to the latest workspace/request version.
  const requestVersionRef = useRequestSequence();

  const isCurrentRequest = useCallback(
    (version: number) => requestVersionRef.isCurrent(version),
    [],
  );

  const refresh = useCallback(async (version: number): Promise<AgentRunStatusResult> => {
    const [nextStatus, nextConfig] = await Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
    ]);
    if (isCurrentRequest(version)) {
      setStatus(nextStatus);
      setConfig(nextConfig);
    }
    return nextStatus;
  }, [isCurrentRequest, workspaceId]);

  const loadSettings = useCallback((version: number) => {
    let inFlight: Promise<void> | null = null;
    const attempt = async (retrying: boolean) => {
      if (isCurrentRequest(version)) setBusy(true);
      try {
        await refresh(version);
        if (isCurrentRequest(version)) setRetry(null);
      } catch (cause) {
        if (!retrying && !isCurrentRequest(version)) return;
        const askAgain = () => execute(true);
        if (isCurrentRequest(version)) setRetry(() => askAgain);
        onError?.(ipcErrorMessage(cause, "dohc could not load agent settings."), cause, askAgain);
      } finally {
        if (isCurrentRequest(version)) setBusy(false);
      }
    };
    const execute = (retrying = false): Promise<void> => {
      if (inFlight) return retrying ? inFlight.then(() => execute(true)) : inFlight;
      inFlight = attempt(retrying).finally(() => { inFlight = null; });
      return inFlight;
    };
    void execute();
  }, [isCurrentRequest, onError, refresh]);

  useEffect(() => {
    const version = requestVersionRef.next();
    setStatus(null);
    setConfig(null);
    setRetry(null);
    setBusy(false);
    loadSettings(version);
    return () => {
      requestVersionRef.next();
    };
  }, [loadSettings, workspaceId]);

  const runActive = Boolean(status?.activeRun);

  const toggle = useCallback(async () => {
    const version = requestVersionRef.next();
    const renderedRunId = status?.activeRun?.id ?? null;
    const starting = renderedRunId === null;
    let attempted = false;
    let changed = false;
    let inFlight: Promise<void> | null = null;
    const attempt = async (retrying: boolean) => {
      if (isCurrentRequest(version)) setBusy(true);
      try {
        if (!attempted || (starting && !changed)) {
          const latestStatus = await refresh(version);
          if (!retrying && !isCurrentRequest(version)) return;
          const latestRun = latestStatus.activeRun;
          if ((latestRun?.id ?? null) !== renderedRunId) {
            // The run changed under the rendered label, so this click only
            // shows what the reread saw. Nothing was started or ended.
            if (isCurrentRequest(version)) setRetry(null);
            return;
          }
        }
        if (!changed) {
          attempted = true;
          if (renderedRunId !== null) {
            await bridge().endAgentRun({ workspaceId, runId: renderedRunId });
          } else {
            await bridge().startAgentRun({ workspaceId });
          }
          changed = true;
        }
        await refresh(version);
        if (isCurrentRequest(version)) setRetry(null);
      } catch (cause) {
        if (!retrying && !isCurrentRequest(version)) return;
        const askAgain = () => execute(true);
        if (isCurrentRequest(version)) setRetry(() => askAgain);
        const fallback = changed || !attempted
          ? "dohc could not load agent settings."
          : starting ? "dohc could not start an agent run in this workspace. Try again."
            : "dohc could not stop this workspace's agent run. Try again.";
        onError?.(ipcErrorMessage(cause, fallback), cause, askAgain);
        if (!attempted) return;
        // Reread live status alone: the config did not change, and a refusal
        // does not say whether the run changed.
        try {
          const observed = await bridge().getAgentRunStatus({ workspaceId });
          if (isCurrentRequest(version)) setStatus(observed);
        } catch {
          // The failure above is already this click's notice.
        }
      } finally {
        if (isCurrentRequest(version)) setBusy(false);
      }
    };
    const execute = (retrying = false): Promise<void> => {
      if (inFlight) return retrying ? inFlight.then(() => execute(true)) : inFlight;
      inFlight = attempt(retrying).finally(() => { inFlight = null; });
      return inFlight;
    };
    await execute();
  }, [workspaceId, refresh, isCurrentRequest, status?.activeRun?.id, onError]);

  return (
    <div className="flex flex-col">
      <AgentList
        workspaceId={workspaceId}
        settings={props.settings}
        agentProblems={props.agentProblems}
        config={config}
        sharedView={sharedView}
        sessionRecorderOn={sessionRecorderOn}
        onSave={props.onSave}
        onOpenSettingsFile={props.onOpenSettingsFile}
        onError={onError}
      />

      <RunnerSettingsCard
        key={workspaceId}
        onError={props.onError}
        workspaceId={workspaceId}
        agent={agent}
        agentName={props.agentName}
        onAgentNameChange={props.onAgentNameChange}
        sharedView={sharedView}
        sessionRecorderOn={sessionRecorderOn}
        onAgentChange={onAgentChange}
      />

      <SettingRow
        title="Agent run"
        description="While a run is active, history marks changes in this workspace as your agent's."
        testId="settings-row-mcp-server"
      >
        <span
          data-testid="mcp-status"
          data-state={runActive ? "running" : "stopped"}
          className="text-[11px] text-muted"
        >
          {runActive ? "Running" : "Stopped"}
        </span>
        <button
          type="button"
          data-testid="mcp-enable-toggle"
          disabled={busy}
          onClick={() => void toggle()}
          className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${
            runActive
              ? "border border-line bg-transparent text-muted hover:bg-hover hover:text-ink"
              : "bg-accent text-bg hover:opacity-90"
          } disabled:opacity-50`}
        >
          {runActive ? "Stop run" : "Start run"}
        </button>
      </SettingRow>

      {retry ? (
        <div
          data-testid="mcp-load-error"
          className="flex justify-end border-b border-line py-3 text-[11px]"
        >
          <button
            type="button"
            disabled={busy}
            onClick={retry}
            className="rounded-md border border-line px-2 py-1 text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      ) : null}

    </div>
  );
}
