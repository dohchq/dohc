import { Bot, Copy, Play, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentRunStatusResult, McpConfigResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

const DRIVER_ROWS = [
  { id: "codex-app-server", label: "Codex", detail: "app-server" },
  { id: "claude-acp", label: "Claude", detail: "ACP" },
  { id: "generic-acp", label: "Generic", detail: "ACP" },
];

export function AgentPanelView(props: {
  workspaceId: string;
  refreshKey?: number;
  onAgentActiveChange?: (active: boolean) => void;
}) {
  const { workspaceId, refreshKey, onAgentActiveChange } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const activeRun = status?.activeRun ?? null;
  const configText = useMemo(() => {
    if (!config) return "";
    return JSON.stringify(
      {
        mcpServers: {
          dohc: { command: config.command, args: config.args },
        },
      },
      null,
      2,
    );
  }, [config]);

  async function refresh(): Promise<AgentRunStatusResult> {
    const [nextStatus, nextConfig] = await Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    onAgentActiveChange?.(nextStatus.activeRun !== null);
    return nextStatus;
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
    ])
      .then(([nextStatus, nextConfig]) => {
        if (cancelled) return;
        setStatus(nextStatus);
        setConfig(nextConfig);
        onAgentActiveChange?.(nextStatus.activeRun !== null);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Agent panel failed.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey, onAgentActiveChange]);

  async function toggleRun() {
    const renderedRunId = activeRun?.id ?? null;
    setBusy(true);
    setMessage(null);
    try {
      const latestStatus = await refresh();
      const latestRun = latestStatus.activeRun;
      if ((latestRun?.id ?? null) !== renderedRunId) {
        setMessage("Agent status changed. Try again.");
        return;
      }
      if (latestRun) {
        await bridge().endAgentRun({ workspaceId, runId: latestRun.id });
      } else {
        await bridge().startAgentRun({ workspaceId });
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function copyConfig() {
    if (!configText) return;
    if (!navigator.clipboard) {
      setMessage("Clipboard unavailable.");
      return;
    }
    await navigator.clipboard.writeText(configText);
    setMessage("Copied MCP config.");
  }

  return (
    <div data-testid="agent-panel" className="flex flex-1 flex-col gap-3 overflow-auto p-3">
      <section className="rounded border border-line bg-panel p-3">
        <div className="mb-3 flex items-center gap-2">
          <Bot size={14} aria-hidden className="text-muted" />
          <h3 className="m-0 text-[13px] font-medium text-ink">Agent session</h3>
          <span
            data-testid="agent-panel-status"
            data-state={activeRun ? "running" : "stopped"}
            className="ml-auto text-[11px] text-subtle"
          >
            {activeRun ? "Running" : "Stopped"}
          </span>
        </div>
        <button
          type="button"
          data-testid="agent-run-toggle"
          disabled={busy || status === null}
          onClick={toggleRun}
          className="inline-flex h-8 items-center gap-2 rounded border border-line bg-bg px-2 text-[12px] text-ink hover:bg-line/40 disabled:opacity-50"
        >
          {activeRun ? <Square size={13} aria-hidden /> : <Play size={13} aria-hidden />}
          {activeRun ? "Stop" : "Start"}
        </button>
        {activeRun ? (
          <div data-testid="agent-active-run" className="mt-3 text-[12px] text-subtle">
            {activeRun.agentId} · {activeRun.status}
          </div>
        ) : null}
      </section>

      <section className="rounded border border-line bg-panel p-3">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="m-0 text-[13px] font-medium text-ink">Drivers</h3>
        </div>
        <div className="grid gap-1">
          {DRIVER_ROWS.map((driver) => (
            <div
              key={driver.id}
              data-testid="agent-driver-row"
              data-driver-id={driver.id}
              className="flex items-center justify-between rounded border border-line bg-bg px-2 py-1.5"
            >
              <span className="text-[12px] text-ink">{driver.label}</span>
              <span className="text-[11px] text-subtle">{driver.detail}</span>
            </div>
          ))}
        </div>
      </section>

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
