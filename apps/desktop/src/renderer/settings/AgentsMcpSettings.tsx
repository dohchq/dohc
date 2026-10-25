import { useRequestSequence } from "../useRequestSequence";
import { useCallback, useEffect, useState } from "react";
import { Bot } from "lucide-react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import type { AgentSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { CopyButton } from "../ui/CopyButton";
import { PreferredNameControl } from "./PreferredNameControl";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { SettingRow } from "./SettingRow";

function configSnippet(
  config: Extract<McpConfigResult, { command: string }>,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        dohc: { command: config.command, args: config.args },
      },
    },
    null,
    2,
  );
}

const USAGE_EXAMPLES = [
  "Create a finance app that reads my budget notes.",
  "Import expenses.csv into a database and show me last month's total.",
  "Resolve the merge conflict in plans/roadmap.md.",
];

export function AgentsMcpSettings(props: {
  workspaceId: string;
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>) => void;
  workspacePath: string;
  preferredName?: string;
  agentName?: string;
  onAgentNameChange?: (name: string) => Promise<void>;
  onPreferredNameChange: (preferredName: string | undefined) => Promise<void>;
  // The first agent, or null before there is one.
  agent: AgentSettings | null;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  onAgentChange: (fields: Pick<AgentSettings, "launch" | "enabled" | "timeoutMinutes">) => Promise<void>;
}) {
  const {
    workspaceId,
    workspacePath,
    preferredName,
    onPreferredNameChange,
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
  // Each way of connecting reports its own state; neither one is required. An
  // active agent run only marks changes as the agent's: no trusted signal
  // proves that an external client copied the configuration, so this never
  // claims one is connected.
  const runnerState = agent?.launch && agent.enabled
    ? { state: "ready", label: "Dispatch ready" }
    : agent?.launch
      ? { state: "configured", label: "Configured · dispatch off" }
      : { state: "missing", label: "No runner command" };

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
      <section
        data-testid="agent-setup-guide"
        className="my-4 overflow-hidden rounded-lg border border-line bg-panel-2"
        aria-labelledby="agent-setup-title"
      >
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-bg text-agent">
            <Bot size={14} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="agent-setup-title" className="m-0 text-[13px] font-medium text-ink">
              Set up your agent
            </h3>
            <p className="m-0 mt-1 text-[11px] leading-relaxed text-muted">
              Choose how a local agent connects to this workspace. Provider names describe
              the connection; messages are always attributed to you.
            </p>
          </div>
        </div>

        <div className="px-4 py-3">
          <p className="m-0 mb-1.5 text-[11px] font-medium text-ink">Your name</p>
          <PreferredNameControl
            value={preferredName}
            onChange={onPreferredNameChange}
            testIdPrefix="agent-preferred-name"
          />
        </div>

        <div className="grid border-t border-line md:grid-cols-2">
          <div className="border-b border-line px-4 py-3 md:border-b-0 md:border-r">
            <p className="m-0 text-[11px] font-medium text-ink">Run from dohc</p>
            <p className="m-0 mt-1 text-[10px] leading-relaxed text-subtle">
              Configure the chat runner below. dohc starts it when My agent receives work and
              keeps permission requests visible.
            </p>
            <span
              data-testid="agent-setup-runner-state"
              data-state={runnerState.state}
              className="mt-2 inline-block text-[10px] font-medium text-muted"
            >
              {runnerState.label}
            </span>
          </div>
          <div className="px-4 py-3">
            <p className="m-0 text-[11px] font-medium text-ink">Connect an existing agent</p>
            <p className="m-0 mt-1 text-[10px] leading-relaxed text-subtle">
              Copy the MCP config below into your existing agent. Sign-in status stays with
              that provider.
            </p>
          </div>
        </div>
      </section>

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
        title="Workspace"
        description="The local folder exposed to this workspace-scoped MCP server."
        testId="settings-row-workspace-path"
      >
        <code title={workspacePath} className="max-w-70 truncate rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink">
          {workspacePath}
        </code>
      </SettingRow>

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

      <section className="border-b border-line py-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="m-0 text-[13px] font-medium text-ink">MCP config</h3>
          <CopyButton
            key={workspaceId}
            disabled={!config || "unavailable" in config}
            getText={() => (config && !("unavailable" in config) ? configSnippet(config) : null)}
          />
        </div>
        <p className="m-0 mb-2 text-[11px] text-muted">
          Paste this into your AI tool to let it use this workspace.
        </p>
        {config && "unavailable" in config ? (
          <p data-testid="mcp-unavailable" className="m-0 text-[11px] text-danger">
            {config.message}
          </p>
        ) : (
          <pre
            data-testid="mcp-config-snippet"
            className="m-0 max-h-56 overflow-auto rounded-md border border-line bg-panel-2 p-3 font-mono text-[11px] leading-relaxed text-ink"
          >
            {config ? configSnippet(config) : "..."}
          </pre>
        )}
      </section>

      <section className="py-4">
        <h3 className="m-0 mb-2 text-[13px] font-medium text-ink">
          Try asking your agent
        </h3>
        <ul className="m-0 grid list-none gap-1 p-0">
          {USAGE_EXAMPLES.map((example) => (
            <li key={example} className="rounded-md bg-panel-2 px-2.5 py-1.5 text-[12px] text-muted">
              {example}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
