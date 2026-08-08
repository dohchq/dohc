import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, Copy, RefreshCw } from "lucide-react";
import type {
  AgentPanelSnapshotResult,
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import type { RunnerSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { PreferredNameControl } from "./PreferredNameControl";
import { RunnerSettingsCard } from "./RunnerSettingsCard";
import { SettingRow } from "./SettingRow";

export function configSnippet(config: McpConfigResult): string {
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
  workspacePath: string;
  preferredName?: string;
  onPreferredNameChange: (preferredName: string | undefined) => Promise<void>;
  runner: RunnerSettings;
  engineEnabled: boolean;
  sharedView?: boolean;
  sessionRecorderOn: boolean | undefined;
  onRunnerChange: (runner: RunnerSettings) => Promise<void>;
  onAgentActiveChange?: (update: {
    active: boolean;
    /**
     * True only when this panel started or ended the run itself. An
     * OBSERVATION may be older than a refresh the shell already has in
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
    engineEnabled,
    sharedView,
    sessionRecorderOn,
    onRunnerChange,
    onAgentActiveChange,
  } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<AgentPanelSnapshotResult["drivers"] | null>(null);
  const [probeError, setProbeError] = useState(false);
  const [probing, setProbing] = useState(false);
  const mountedRef = useRef(false);
  // Workspace async safety invariant: IPC responses are allowed to update this
  // panel only if they belong to the latest workspace/request version.
  const requestVersionRef = useRef(0);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCopyResetTimer = useCallback(() => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }
  }, []);

  const isCurrentRequest = useCallback(
    (version: number) => mountedRef.current && requestVersionRef.current === version,
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
    const version = requestVersionRef.current;
    setLoadError(null);
    void refresh(version).catch(() => {
      if (isCurrentRequest(version)) {
        setLoadError("Could not load MCP settings.");
      }
    });
  }, [isCurrentRequest, refresh]);

  const probeDrivers = useCallback(async (version: number) => {
    setProbing(true);
    setProbeError(false);
    try {
      const panel = await bridge().probeAgentDrivers({ workspaceId });
      if (isCurrentRequest(version)) setDrivers(panel.drivers);
    } catch {
      if (isCurrentRequest(version)) setProbeError(true);
    } finally {
      if (isCurrentRequest(version)) setProbing(false);
    }
  }, [isCurrentRequest, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    const version = requestVersionRef.current + 1;
    requestVersionRef.current = version;
    setStatus(null);
    setConfig(null);
    setCopied(false);
    setCopyError(null);
    setLoadError(null);
    setDrivers(null);
    setProbeError(false);
    setProbing(false);
    setBusy(false);
    void refresh(version).catch(() => {
      if (isCurrentRequest(version)) {
        setLoadError("Could not load MCP settings.");
      }
    });
    void probeDrivers(version);
    return () => {
      requestVersionRef.current += 1;
      mountedRef.current = false;
      clearCopyResetTimer();
    };
  }, [clearCopyResetTimer, isCurrentRequest, probeDrivers, refresh, workspaceId]);

  const enabled = status?.mcpEnabled ?? false;
  const runnerConfigured = runner.command.trim().length > 0;
  // An enabled MCP server only means it is available to connect to. We do not
  // have a trusted session signal proving that an external client copied the
  // configuration and connected, so only the in-app runner can make this
  // guide ready.
  const setupReady = Boolean(preferredName) && runner.enabled;

  const toggle = useCallback(async () => {
    const version = requestVersionRef.current;
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

  const copyConfig = useCallback(async () => {
    if (!config) return;
    const version = requestVersionRef.current;
    const text = configSnippet(config);
    try {
      if (window.dohcDesktop?.writeClipboardText) {
        await bridge().writeClipboardText({ text });
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      if (isCurrentRequest(version)) {
        clearCopyResetTimer();
        setCopied(false);
        setCopyError("Could not copy MCP config.");
      }
      return;
    }
    if (!isCurrentRequest(version)) return;
    clearCopyResetTimer();
    setCopyError(null);
    setCopied(true);
    copyResetTimerRef.current = setTimeout(() => {
      copyResetTimerRef.current = null;
      if (isCurrentRequest(version)) setCopied(false);
    }, 1500);
  }, [clearCopyResetTimer, config, isCurrentRequest]);

  return (
    <div className="flex flex-col">
      <section
        data-testid="agent-setup-guide"
        data-state={setupReady ? "ready" : "needs-setup"}
        className="my-4 overflow-hidden rounded-lg border border-line bg-panel-2"
        aria-labelledby="agent-setup-title"
      >
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-bg text-agent">
            <Bot size={14} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="agent-setup-title" className="m-0 text-[13px] font-medium text-ink">
                Set up your agent
              </h3>
              <span
                data-testid="agent-setup-status"
                data-state={setupReady ? "ready" : "needs-setup"}
                className="rounded-full border border-line bg-bg px-2 py-0.5 text-[10px] uppercase tracking-wide text-subtle"
              >
                {setupReady ? "Ready" : "Needs setup"}
              </span>
            </div>
            <p className="m-0 mt-1 text-[11px] leading-relaxed text-muted">
              Choose how a local agent connects to this workspace. Provider names describe
              the connection; messages are always attributed to you.
            </p>
          </div>
        </div>

        <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
          <div>
            <p className="m-0 mb-1.5 text-[11px] font-medium text-ink">1. Your name</p>
            <PreferredNameControl
              value={preferredName}
              onChange={onPreferredNameChange}
              testIdPrefix="agent-preferred-name"
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <p className="m-0 text-[11px] font-medium text-ink">2. Local tools</p>
              <button
                type="button"
                data-testid="agent-probe-refresh"
                aria-label="Check local agents again"
                title="Check again"
                disabled={probing}
                onClick={() => void probeDrivers(requestVersionRef.current)}
                className="ml-auto grid size-6 place-items-center rounded text-subtle hover:bg-bg hover:text-ink disabled:opacity-50"
              >
                <RefreshCw size={12} aria-hidden className={probing ? "animate-spin" : undefined} />
              </button>
            </div>
            {drivers === null && !probeError ? (
              <p data-testid="agent-probes-loading" className="m-0 text-[11px] text-subtle">
                Checking Codex, Claude, and ACP…
              </p>
            ) : probeError ? (
              <p data-testid="agent-probes-error" className="m-0 text-[11px] text-danger">
                Could not check local agents. You can still configure either connection below.
              </p>
            ) : (
              <ul data-testid="agent-probe-list" className="m-0 grid list-none gap-1 p-0">
                {drivers?.map((driver) => (
                  <li
                    key={driver.id}
                    data-testid="agent-probe-row"
                    data-installed={driver.installed ? "true" : "false"}
                    className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5"
                  >
                    <span className={`size-1.5 rounded-full ${driver.installed ? "bg-success" : "bg-line"}`} />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                      {driver.displayName}
                    </span>
                    <span className="text-[10px] text-subtle">
                      {driver.installed
                        ? driver.auth.status === "authenticated"
                          ? "Installed · signed in"
                          : "Installed · sign-in not verified"
                        : "Not found"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
              data-state={runner.enabled ? "ready" : runnerConfigured ? "configured" : "missing"}
              className="mt-2 inline-block text-[10px] font-medium text-muted"
            >
              {runner.enabled ? "Dispatch ready" : runnerConfigured ? "Configured · dispatch off" : "Runner command needed"}
            </span>
          </div>
          <div className="px-4 py-3">
            <p className="m-0 text-[11px] font-medium text-ink">Connect an existing agent</p>
            <p className="m-0 mt-1 text-[10px] leading-relaxed text-subtle">
              Enable the workspace-scoped MCP server, then copy its configuration into your
              existing agent. Sign-in status stays with that provider.
            </p>
            <button
              type="button"
              data-testid="agent-setup-mcp-action"
              disabled={busy}
              onClick={() => void toggle()}
              className="mt-2 rounded-md border border-line bg-bg px-2.5 py-1 text-[10px] font-medium text-muted hover:text-ink disabled:opacity-50"
            >
              {enabled ? "MCP enabled · copy config below" : "Enable MCP"}
            </button>
          </div>
        </div>
      </section>

      <RunnerSettingsCard
        workspaceId={workspaceId}
        runner={runner}
        engineEnabled={engineEnabled}
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
              ? "border border-line bg-transparent text-muted hover:bg-panel-2 hover:text-ink"
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
            className="rounded-md border border-line px-2 py-1 text-muted transition-colors hover:bg-panel-2 hover:text-ink"
          >
            Retry
          </button>
        </div>
      ) : null}

      <section className="border-b border-line py-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="m-0 text-[13px] font-medium text-ink">MCP config</h3>
          <button
            type="button"
            disabled={!config}
            onClick={() => void copyConfig()}
            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="m-0 mb-2 text-[11px] text-muted">
          Paste this into your AI tool to let it use this workspace.
        </p>
        {copyError ? (
          <p data-testid="mcp-copy-error" className="m-0 mb-2 text-[11px] text-danger">
            {copyError}
          </p>
        ) : null}
        <pre
          data-testid="mcp-config-snippet"
          className="m-0 max-h-56 overflow-auto rounded-md border border-line bg-panel-2 p-3 font-mono text-[11px] leading-relaxed text-ink"
        >
          {config ? configSnippet(config) : "..."}
        </pre>
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
