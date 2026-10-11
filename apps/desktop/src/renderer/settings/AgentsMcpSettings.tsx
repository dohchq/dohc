import { configuredRunnerCommand } from "../../agents/agentToolCatalog";
import { useRequestSequence } from "../useRequestSequence";
import { useCallback, useEffect, useState } from "react";
import { Bot } from "lucide-react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import type { RunnerSettings } from "../../settings/userSettings";
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
  onError?: (message: string, cause?: unknown) => void;
  workspacePath: string;
  preferredName?: string;
  agentName?: string;
  onAgentNameChange?: (name: string) => Promise<void>;
  onPreferredNameChange: (preferredName: string | undefined) => Promise<void>;
  runner: RunnerSettings;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  onRunnerChange: (runner: RunnerSettings) => Promise<void>;
  onAgentActiveChange?: (update: {
    active: boolean;
    /**
     * True only when this panel started or ended the run itself. An
     * observation may be older than a refresh the shell already has in
     * flight, so it must never supersede one.
     */
    mutated: boolean;
  }) => void;
}) {
  const {
    workspaceId,
    workspacePath,
    preferredName,
    onPreferredNameChange,
    runner,
    sharedView,
    sessionRecorderOn,
    onRunnerChange,
    onAgentActiveChange,
    onError,
  } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      setLoadError(null);
    }
    return nextStatus;
  }, [isCurrentRequest, workspaceId]);

  const retryRefresh = useCallback(() => {
    const version = requestVersionRef.current();
    setLoadError(null);
    // Busy keeps a toggle from starting while this older read can still paint.
    setBusy(true);
    void refresh(version)
      .catch((cause: unknown) => {
        if (isCurrentRequest(version)) {
          setLoadError("Could not load agent settings.");
          onError?.(ipcErrorMessage(cause, "dohc could not load agent settings."), cause);
        }
      })
      .finally(() => {
        if (isCurrentRequest(version)) setBusy(false);
      });
  }, [isCurrentRequest, onError, refresh]);

  useEffect(() => {
    const version = requestVersionRef.next();
    setStatus(null);
    setConfig(null);
    setLoadError(null);
    setBusy(false);
    void refresh(version).catch((cause: unknown) => {
      if (isCurrentRequest(version)) {
        setLoadError("Could not load agent settings.");
        onError?.(ipcErrorMessage(cause, "dohc could not load agent settings."), cause);
      }
    });
    return () => {
      requestVersionRef.next();
    };
  }, [isCurrentRequest, onError, refresh, workspaceId]);

  const runActive = Boolean(status?.activeRun);
  const runnerConfigured = configuredRunnerCommand(runner).length > 0;
  // Each way of connecting reports its own state; neither one is required. The
  // runner dispatches only with an agent name to post as. An active agent run
  // only marks changes as the agent's: no trusted signal proves that an
  // external client copied the configuration, so this never claims one is
  // connected.
  const runnerState = runner.enabled
    ? props.agentName
      ? { state: "ready", label: "Dispatch ready" }
      : { state: "unnamed", label: "Agent name needed" }
    : runnerConfigured
      ? { state: "configured", label: "Configured · dispatch off" }
      : { state: "missing", label: "No runner command" };

  const toggle = useCallback(async () => {
    const version = requestVersionRef.current();
    const renderedRunId = status?.activeRun?.id ?? null;
    const starting = renderedRunId === null;
    let attempted = false;
    let changed = false;
    setBusy(true);
    try {
      const latestStatus = await refresh(version);
      if (!isCurrentRequest(version)) return;
      const latestRun = latestStatus.activeRun;
      if ((latestRun?.id ?? null) !== renderedRunId) {
        // The run changed under the rendered label, so this click only
        // reports what the reread saw. Nothing was started or ended.
        onAgentActiveChange?.({ active: latestRun !== null, mutated: false });
        return;
      }
      attempted = true;
      if (latestRun) {
        await bridge().endAgentRun({ workspaceId, runId: latestRun.id });
      } else {
        await bridge().startAgentRun({ workspaceId });
      }
      changed = true;
      const finalStatus = await refresh(version);
      if (isCurrentRequest(version)) {
        onAgentActiveChange?.({ active: finalStatus.activeRun !== null, mutated: true });
      }
    } catch (cause) {
      if (!isCurrentRequest(version)) return;
      if (changed || !attempted) {
        // Only a read failed: the one before the start or end, or the one after it.
        setLoadError("Could not load agent settings.");
        onError?.(ipcErrorMessage(cause, "dohc could not load agent settings."), cause);
      } else if (starting) {
        setLoadError("Could not start the agent run.");
        onError?.(ipcErrorMessage(cause, "dohc could not start an agent run in this workspace. Try again."), cause);
      } else {
        setLoadError("Could not stop the agent run.");
        onError?.(ipcErrorMessage(cause, "dohc could not stop this workspace's agent run. Try again."), cause);
      }
      if (!attempted) return;
      // Reread live status alone: the config did not change. After a refusal
      // it is only an observation, since a refusal does not say whether the
      // run changed.
      try {
        const observed = await bridge().getAgentRunStatus({ workspaceId });
        if (!isCurrentRequest(version)) return;
        setStatus(observed);
        onAgentActiveChange?.({ active: observed.activeRun !== null, mutated: changed });
      } catch {
        // The failure above is already this click's notice. A run that did
        // change still needs the shell to reread it, so report an observation.
        if (changed && isCurrentRequest(version)) {
          onAgentActiveChange?.({ active: starting, mutated: false });
        }
      }
    } finally {
      if (isCurrentRequest(version)) setBusy(false);
    }
  }, [workspaceId, refresh, isCurrentRequest, status?.activeRun?.id, onAgentActiveChange, onError]);

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
        runner={runner}
        agentName={props.agentName}
        onAgentNameChange={props.onAgentNameChange}
        sharedView={sharedView}
        sessionRecorderOn={sessionRecorderOn}
        onRunnerChange={onRunnerChange}
      />

      <SettingRow
        title="Workspace"
        description="The local folder exposed to this workspace-scoped MCP server."
        testId="settings-row-workspace-path"
      >
        <code className="max-w-sm truncate rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink">
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

      {loadError ? (
        <div
          data-testid="mcp-load-error"
          className="flex items-center justify-between gap-3 border-b border-line py-3 text-[11px] text-danger"
        >
          <span>{loadError}</span>
          <button
            type="button"
            disabled={busy}
            onClick={retryRefresh}
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
