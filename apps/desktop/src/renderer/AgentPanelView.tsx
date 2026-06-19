import { Bot, Check, Copy, Play, ShieldAlert, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentPanelSnapshotResult,
  AgentPermissionDecision,
  AgentRunStatusResult,
  McpConfigResult,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";

type SessionSnapshot = NonNullable<AgentPanelSnapshotResult["session"]>;
const AGENT_POLL_INTERVAL_MS = 300;

function configSnippet(config: McpConfigResult): string {
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

function isActiveSession(session: SessionSnapshot | null): boolean {
  return !!session && ["starting", "ready", "running", "waiting-permission"].includes(session.status);
}

function statusLabel(session: SessionSnapshot | null, runStatus: AgentRunStatusResult | null): string {
  if (session) return session.status.replace("-", " ");
  return runStatus?.activeRun ? "running" : "stopped";
}

function permissionDecision(kind: string): AgentPermissionDecision {
  if (
    kind === "allow_once" ||
    kind === "allow_always" ||
    kind === "reject_once" ||
    kind === "reject_always"
  ) {
    return kind;
  }
  return "cancel";
}

export function AgentPanelView(props: {
  workspaceId: string;
  refreshKey?: number;
  onAgentActiveChange?: (active: boolean) => void;
}) {
  const { workspaceId, refreshKey, onAgentActiveChange } = props;
  const [runStatus, setRunStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [panel, setPanel] = useState<AgentPanelSnapshotResult | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string>("codex-app-server");
  const [prompt, setPrompt] = useState("Summarize this workspace and create a short next-step note.");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestEpochRef = useRef(0);
  const session = panel?.session ?? null;
  const activeSession = isActiveSession(session);
  const runActive = runStatus?.activeRun !== null;
  const externalRun = !session ? runStatus?.activeRun ?? null : null;
  const activeAgent = activeSession || externalRun !== null;
  const configText = useMemo(() => (config ? configSnippet(config) : ""), [config]);
  const status = statusLabel(session, runStatus);
  const canToggleRun = useMemo(() => {
    if (busy || panel === null) return false;
    if (activeAgent) return true;
    return panel.drivers.some((driver) => driver.id === selectedDriver && driver.installed);
  }, [activeAgent, busy, panel, selectedDriver]);

  const applyPanel = useCallback(
    (nextPanel: AgentPanelSnapshotResult, nextRunActive: boolean) => {
      setPanel(nextPanel);
      setSelectedDriver((current) => {
        const installedSelected = nextPanel.drivers.some(
          (driver) => driver.id === current && driver.installed,
        );
        if (installedSelected) return current;
        const firstInstalled = nextPanel.drivers.find((driver) => driver.installed);
        return firstInstalled?.id ?? current;
      });
      onAgentActiveChange?.(isActiveSession(nextPanel.session) || nextRunActive);
    },
    [onAgentActiveChange],
  );

  const refresh = useCallback(async (epoch = requestEpochRef.current): Promise<AgentPanelSnapshotResult | null> => {
    const [nextRunStatus, nextConfig, nextPanel] = await Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
      bridge().getAgentSessionState({ workspaceId }),
    ]);
    if (epoch !== requestEpochRef.current) return null;
    setRunStatus(nextRunStatus);
    setConfig(nextConfig);
    applyPanel(nextPanel, nextRunStatus.activeRun !== null);
    return nextPanel;
  }, [applyPanel, workspaceId]);

  useEffect(() => {
    const epoch = requestEpochRef.current + 1;
    requestEpochRef.current = epoch;
    setRunStatus(null);
    setConfig(null);
    setPanel(null);
    setBusy(false);
    setMessage(null);
    onAgentActiveChange?.(false);
    Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
      bridge().probeAgentDrivers({ workspaceId }),
    ])
      .then(([nextRunStatus, nextConfig, nextPanel]) => {
        if (epoch !== requestEpochRef.current) return;
        setRunStatus(nextRunStatus);
        setConfig(nextConfig);
        applyPanel(nextPanel, nextRunStatus.activeRun !== null);
      })
      .catch((error) => {
        if (epoch === requestEpochRef.current) {
          setMessage(error instanceof Error ? error.message : "Agent panel failed.");
        }
      });
    return () => {
      if (requestEpochRef.current === epoch) requestEpochRef.current += 1;
    };
  }, [workspaceId, refreshKey, applyPanel, onAgentActiveChange]);

  useEffect(() => {
    if (!activeSession && !runActive) return;
    const epoch = requestEpochRef.current;
    const timer = window.setInterval(() => {
      void refresh(epoch).catch((error) => {
        if (epoch === requestEpochRef.current) {
          setMessage(error instanceof Error ? error.message : "Agent refresh failed.");
        }
      });
    }, AGENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeSession, refresh, runActive]);

  async function startSession() {
    if (!selectedDriver || !prompt.trim()) return;
    setBusy(true);
    setMessage(null);
    const epoch = requestEpochRef.current;
    try {
      const nextPanel = await bridge().startAgentSession({
        workspaceId,
        driverId: selectedDriver,
        prompt: prompt.trim(),
      });
      if (epoch !== requestEpochRef.current) return;
      applyPanel(nextPanel, runActive);
      await refresh(epoch);
    } catch (error) {
      if (epoch === requestEpochRef.current) {
        setMessage(error instanceof Error ? error.message : "Agent session failed.");
      }
    } finally {
      if (epoch === requestEpochRef.current) setBusy(false);
    }
  }

  async function stopSession() {
    setBusy(true);
    setMessage(null);
    const epoch = requestEpochRef.current;
    try {
      const nextPanel = await bridge().stopAgentSession({ workspaceId });
      if (epoch !== requestEpochRef.current) return;
      applyPanel(nextPanel, false);
      await refresh(epoch);
    } catch (error) {
      if (epoch === requestEpochRef.current) {
        setMessage(error instanceof Error ? error.message : "Agent stop failed.");
      }
    } finally {
      if (epoch === requestEpochRef.current) setBusy(false);
    }
  }

  async function stopExternalRun() {
    if (!externalRun) return;
    setBusy(true);
    setMessage(null);
    const epoch = requestEpochRef.current;
    try {
      await bridge().endAgentRun({ workspaceId, runId: externalRun.id });
      await refresh(epoch);
    } catch (error) {
      if (epoch === requestEpochRef.current) {
        setMessage(error instanceof Error ? error.message : "Agent stop failed.");
      }
    } finally {
      if (epoch === requestEpochRef.current) setBusy(false);
    }
  }

  async function answerPermission(requestId: string, decision: AgentPermissionDecision) {
    setBusy(true);
    setMessage(null);
    const epoch = requestEpochRef.current;
    try {
      const nextPanel = await bridge().answerAgentPermission({ workspaceId, requestId, decision });
      if (epoch !== requestEpochRef.current) return;
      applyPanel(nextPanel, runActive);
      await refresh(epoch);
    } catch (error) {
      if (epoch === requestEpochRef.current) {
        setMessage(error instanceof Error ? error.message : "Permission response failed.");
      }
    } finally {
      if (epoch === requestEpochRef.current) setBusy(false);
    }
  }

  async function copyConfig() {
    if (!configText) return;
    if (!navigator.clipboard) {
      setMessage("Clipboard unavailable.");
      return;
    }
    try {
      await navigator.clipboard.writeText(configText);
      setMessage("Copied MCP config.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Clipboard copy failed.");
    }
  }

  return (
    <div data-testid="agent-panel" className="flex flex-1 flex-col gap-3 overflow-auto p-3">
      <section className="rounded border border-line bg-panel p-3">
        <div className="mb-3 flex items-center gap-2">
          <Bot size={14} aria-hidden className="text-muted" />
          <h3 className="m-0 text-[13px] font-medium text-ink">Agent session</h3>
          <span
            data-testid="agent-panel-status"
            data-state={session?.status ?? (runStatus?.activeRun ? "running" : "stopped")}
            className="ml-auto text-[11px] capitalize text-subtle"
          >
            {status}
          </span>
        </div>

        <div className="grid gap-2">
          <label className="grid gap-1 text-[11px] text-subtle">
            Driver
            <select
              data-testid="agent-driver-picker"
              value={selectedDriver}
              disabled={busy || activeAgent}
              onChange={(event) => setSelectedDriver(event.currentTarget.value)}
              className="h-8 rounded border border-line bg-bg px-2 text-[12px] text-ink"
            >
              {(panel?.drivers ?? []).map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.displayName} {driver.installed ? "" : "(not found)"}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[11px] text-subtle">
            Prompt
            <textarea
              data-testid="agent-prompt-input"
              value={prompt}
              disabled={busy || activeAgent}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              className="min-h-20 resize-none rounded border border-line bg-bg p-2 text-[12px] leading-5 text-ink"
            />
          </label>
          <button
            type="button"
            data-testid="agent-run-toggle"
            disabled={!canToggleRun}
            onClick={activeSession ? stopSession : externalRun ? stopExternalRun : startSession}
            className="inline-flex h-8 w-fit items-center gap-2 rounded border border-line bg-bg px-2 text-[12px] text-ink hover:bg-line/40 disabled:opacity-50"
          >
            {activeAgent ? <Square size={13} aria-hidden /> : <Play size={13} aria-hidden />}
            {activeAgent ? "Stop" : "Start"}
          </button>
          {session?.runId || externalRun ? (
            <div data-testid="agent-active-run" className="text-[12px] text-subtle">
              {session ? `${session.driverName} · ${session.runId}` : `${externalRun?.agentId} · ${externalRun?.status}`}
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded border border-line bg-panel p-3">
        <h3 className="mb-2 mt-0 text-[13px] font-medium text-ink">Drivers</h3>
        <div className="grid gap-1">
          {(panel?.drivers ?? []).map((driver) => (
            <div
              key={driver.id}
              data-testid="agent-driver-row"
              data-driver-id={driver.id}
              className="flex items-center justify-between rounded border border-line bg-bg px-2 py-1.5"
            >
              <span className="text-[12px] text-ink">{driver.displayName}</span>
              <span data-testid="agent-driver-state" className="text-[11px] text-subtle">
                {driver.installed ? driver.version ?? "installed" : "not found"}
              </span>
            </div>
          ))}
        </div>
      </section>

      {session ? (
        <section className="rounded border border-line bg-panel p-3">
          <h3 className="mb-2 mt-0 text-[13px] font-medium text-ink">Stream</h3>
          <div data-testid="agent-stream" className="grid gap-2">
            {session.messages.map((entry) => (
              <div key={entry.id} className="rounded border border-line bg-bg p-2">
                <div className="mb-1 text-[11px] capitalize text-subtle">{entry.role}</div>
                <div className="whitespace-pre-wrap text-[12px] leading-5 text-ink">{entry.text}</div>
              </div>
            ))}
            {session.items.map((item) => (
              <div key={item.id} data-testid="agent-tool-card" className="rounded border border-line bg-bg p-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink">{item.title}</span>
                  <span className="ml-auto text-[11px] text-subtle">{item.status}</span>
                </div>
                {item.detail ? <div className="mt-1 text-[11px] text-subtle">{item.detail}</div> : null}
              </div>
            ))}
            {session.authNotices.map((notice) => (
              <div key={notice} data-testid="agent-auth-notice" className="text-[12px] text-subtle">
                {notice}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {session?.pendingPermissions.map((request) => (
        <section
          key={request.requestId}
          data-testid="agent-permission-request"
          className="rounded border border-line bg-panel p-3"
        >
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert size={14} aria-hidden className="text-muted" />
            <h3 className="m-0 text-[13px] font-medium text-ink">{request.title}</h3>
          </div>
          {request.detail ? <div className="mb-2 text-[12px] text-subtle">{request.detail}</div> : null}
          {request.locations && request.locations.length > 0 ? (
            <div
              data-testid="agent-permission-locations"
              className="mb-2 grid gap-1 text-[11px] text-subtle"
            >
              {request.locations.map((location) => (
                <code key={location} className="rounded bg-bg px-1.5 py-0.5 text-ink">
                  {location}
                </code>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {request.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                data-testid={`agent-permission-${option.kind}`}
                disabled={busy}
                onClick={() => answerPermission(request.requestId, permissionDecision(option.kind))}
                className="inline-flex h-8 items-center gap-2 rounded border border-line bg-bg px-2 text-[12px] text-ink hover:bg-line/40 disabled:opacity-50"
              >
                {option.kind.startsWith("allow") ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
                {option.name}
              </button>
            ))}
          </div>
        </section>
      ))}

      <section className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="m-0 text-[13px] font-medium text-ink">MCP</h3>
          <button
            type="button"
            data-testid="agent-copy-mcp"
            aria-label="Copy MCP config"
            title="Copy MCP config"
            onClick={copyConfig}
            className="ml-auto grid size-7 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
          >
            <Copy size={13} aria-hidden />
          </button>
        </div>
        <pre
          data-testid="agent-mcp-config"
          className="max-h-44 overflow-auto rounded bg-panel-2 p-2 text-[11px] text-muted"
        >
          {configText || "Loading..."}
        </pre>
      </section>

      {message ? (
        <div data-testid="agent-panel-message" className="text-[12px] text-subtle">
          {message}
        </div>
      ) : null}
    </div>
  );
}
