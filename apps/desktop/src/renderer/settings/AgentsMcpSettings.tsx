import { configuredRunnerCommand } from "../../agents/agentToolCatalog";
import { useRequestSequence } from "../useRequestSequence";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot } from "lucide-react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import type { RunnerSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
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
    void refresh(version).catch(() => {
      if (isCurrentRequest(version)) {
        setLoadError("Could not load MCP settings.");
      }
    });
  }, [isCurrentRequest, refresh]);

  useEffect(() => {
    const version = requestVersionRef.next();
    setStatus(null);
    setConfig(null);
    setLoadError(null);
    setBusy(false);
    void refresh(version).catch(() => {
      if (isCurrentRequest(version)) {
        setLoadError("Could not load MCP settings.");
      }
    });
    return () => {
      requestVersionRef.next();
    };
  }, [isCurrentRequest, refresh, workspaceId]);

  const enabled = status?.mcpEnabled ?? false;
  const runnerConfigured = configuredRunnerCommand(runner).length > 0;
  // Each way of connecting reports its own state; neither one is required. The
  // runner dispatches only with an agent name to post as. An enabled MCP server
  // is only available to connect to: no trusted signal proves that an external
  // client copied the configuration, so this never claims one is connected.
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
      if (latestRun) {
        await bridge().endAgentRun({ workspaceId, runId: latestRun.id });
      } else {
        await bridge().startAgentRun({ workspaceId });
      }
      const finalStatus = await refresh(version);
      if (isCurrentRequest(version)) {
        onAgentActiveChange?.({ active: finalStatus.activeRun !== null, mutated: true });
      }
    } catch {
      if (isCurrentRequest(version)) {
        setLoadError("Could not update MCP server.");
      }
    } finally {
      if (isCurrentRequest(version)) setBusy(false);
    }
  }, [workspaceId, refresh, isCurrentRequest, status?.activeRun?.id, onAgentActiveChange]);

  // The guide's Enable MCP hands focus to the config's Copy once the server
  // runs. The guide button disables for the toggle, which drops focus in
  // Chromium, and is gone once the server runs, so focus moves explicitly.
  const configCopyRef = useRef<HTMLButtonElement>(null);
  const focusCopyWhenRunning = useRef(false);
  useEffect(() => {
    if (busy || !focusCopyWhenRunning.current) return;
    focusCopyWhenRunning.current = false;
    if (enabled) configCopyRef.current?.focus();
  }, [busy, enabled]);

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
              Enable the workspace-scoped MCP server. Then copy the MCP config below into your
              existing agent. Sign-in status stays with that provider.
            </p>
            {status ? (
              <span
                data-testid="agent-setup-mcp-state"
                data-state={enabled ? "running" : "stopped"}
                className="mt-2 block text-[10px] font-medium text-muted"
              >
                {enabled ? "Server running" : "Server stopped"}
              </span>
            ) : null}
            {/* Disable stays on the server row below, and Copy stays beside the MCP config. */}
            {enabled ? null : (
              <button
                type="button"
                data-testid="agent-setup-mcp-action"
                disabled={busy}
                onClick={() => {
                  focusCopyWhenRunning.current = true;
                  void toggle();
                }}
                className="mt-2 rounded-md border border-line bg-bg px-2.5 py-1 text-[10px] font-medium text-muted hover:text-ink disabled:opacity-50"
              >
                Enable MCP
              </button>
            )}
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
        title="dohc MCP server"
        description="Enable this only when you want local agents to use dohc tools for this workspace."
        testId="settings-row-mcp-server"
      >
        <span
          data-testid="mcp-status"
          data-state={enabled ? "running" : "stopped"}
          className="text-[11px] text-muted"
        >
          {enabled ? "Running" : "Stopped"}
        </span>
        <button
          type="button"
          data-testid="mcp-enable-toggle"
          aria-pressed={enabled}
          disabled={busy}
          onClick={() => void toggle()}
          className={`rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${
            enabled
              ? "border border-line bg-transparent text-muted hover:bg-hover hover:text-ink"
              : "bg-accent text-bg hover:opacity-90"
          } disabled:opacity-50`}
        >
          {enabled ? "Disable" : "Enable"}
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
            onClick={retryRefresh}
            className="rounded-md border border-line px-2 py-1 text-muted transition-colors hover:bg-hover hover:text-ink"
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
            ref={configCopyRef}
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
