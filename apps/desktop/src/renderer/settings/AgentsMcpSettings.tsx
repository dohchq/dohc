import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
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
  onAgentActiveChange?: (active: boolean) => void;
}) {
  const { workspaceId, workspacePath, onAgentActiveChange } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const mountedRef = useRef(false);
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

  useEffect(() => {
    mountedRef.current = true;
    const version = requestVersionRef.current + 1;
    requestVersionRef.current = version;
    setStatus(null);
    setConfig(null);
    setCopied(false);
    setCopyError(null);
    setLoadError(null);
    setBusy(false);
    void refresh(version).catch(() => {
      if (isCurrentRequest(version)) {
        setLoadError("Could not load MCP settings.");
      }
    });
    return () => {
      requestVersionRef.current += 1;
      mountedRef.current = false;
      clearCopyResetTimer();
    };
  }, [clearCopyResetTimer, isCurrentRequest, refresh, workspaceId]);

  const enabled = status?.mcpEnabled ?? false;

  const toggle = useCallback(async () => {
    const version = requestVersionRef.current;
    const renderedRunId = status?.activeRun?.id ?? null;
    setBusy(true);
    try {
      const latestStatus = await refresh(version);
      if (!isCurrentRequest(version)) return;
      const latestRun = latestStatus.activeRun;
      if ((latestRun?.id ?? null) !== renderedRunId) {
        onAgentActiveChange?.(latestRun !== null);
        return;
      }
      if (latestRun) {
        await bridge().endAgentRun({ workspaceId, runId: latestRun.id });
      } else {
        await bridge().startAgentRun({ workspaceId });
      }
      const finalStatus = await refresh(version);
      if (isCurrentRequest(version)) {
        onAgentActiveChange?.(finalStatus.activeRun !== null);
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
      <SettingRow
        title="Workspace"
        description="The local folder exposed to this workspace-scoped MCP server."
        testId="settings-row-workspace-path"
      >
        <code className="max-w-sm truncate rounded bg-panel-2 px-2 py-1 text-xs text-ink">
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
          className={`rounded px-3 py-1 text-xs ${
            enabled ? "bg-panel-2 text-ink" : "bg-accent text-bg"
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
            className="rounded border border-line px-2 py-1 text-muted hover:bg-panel-2 hover:text-ink"
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
            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
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
          className="m-0 max-h-56 overflow-auto rounded bg-panel-2 p-3 text-[11px] leading-relaxed text-ink"
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
            <li key={example} className="rounded bg-panel-2 px-2 py-1 text-[12px] text-muted">
              {example}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
