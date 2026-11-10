import { useRequestSequence } from "../useRequestSequence";
import { useCallback, useEffect, useState } from "react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import type { AgentProblem, DesktopUserSettings, DesktopUserSettingsResult } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import type { ErrorDetailField } from "../shell/copyDetails";
import { AgentList } from "./AgentList";

export function AgentsMcpSettings(props: {
  workspaceId: string;
  // What the open workspace goes by, for its agent link.
  workspaceName: string;
  // The personal agent whose page opens, by id, such as one a notice names.
  openAgent?: { agentId: string };
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>, details?: ReadonlyArray<ErrorDetailField>, identity?: string) => void;
  onClearError?: (identity: string) => void;
  settings: DesktopUserSettings;
  agentProblems?: readonly AgentProblem[];
  onSave: (settings: DesktopUserSettings) => Promise<DesktopUserSettingsResult | null>;
  onOrder: (order: readonly string[], failure?: string) => Promise<boolean>;
  onNotice?: (message: string, undo?: () => void) => void;
  onOpenSettingsFile: () => void;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  trust?: { trusted: boolean | null; asking: boolean; onTrust: () => void };
}) {
  const { workspaceId, sharedView, sessionRecorderOn, onError } = props;
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

  // Starts a run for this agent, or stops the run that is on, whichever agent it is for.
  const toggle = useCallback(async (agentId: string) => {
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
            await bridge().startAgentRun({ workspaceId, agentId });
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
        workspaceName={props.workspaceName}
        {...(props.openAgent ? { openAgent: props.openAgent } : {})}
        settings={props.settings}
        agentProblems={props.agentProblems}
        config={config}
        sharedView={sharedView}
        sessionRecorderOn={sessionRecorderOn}
        onSave={props.onSave}
        onOrder={props.onOrder}
        onOpenSettingsFile={props.onOpenSettingsFile}
        onError={onError}
        {...(props.onClearError ? { onClearError: props.onClearError } : {})}
        {...(props.trust ? { trust: props.trust } : {})}
        {...(props.onNotice ? { onNotice: props.onNotice } : {})}
        run={{
          activeRun: status?.activeRun ? { id: status.activeRun.id, agentId: status.activeRun.agentId } : null,
          busy,
          onToggle: (agentId) => void toggle(agentId),
        }}
      />

      {retry ? (
        <div
          data-testid="mcp-load-error"
          className="mt-3 flex justify-end text-[11px]"
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
