import { useCallback, useEffect, useState } from "react";
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
  const { workspaceId, onAgentActiveChange } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (): Promise<AgentRunStatusResult> => {
    const [nextStatus, nextConfig] = await Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    return nextStatus;
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabled = status?.mcpEnabled ?? false;

  const toggle = useCallback(async () => {
    const renderedRunId = status?.activeRun?.id ?? null;
    setBusy(true);
    try {
      const latestStatus = await refresh();
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
      const finalStatus = await refresh();
      onAgentActiveChange?.(finalStatus.activeRun !== null);
    } finally {
      setBusy(false);
    }
  }, [workspaceId, refresh, status?.activeRun?.id, onAgentActiveChange]);

  const copyConfig = useCallback(async () => {
    if (!config) return;
    const text = configSnippet(config);
    if (window.dohcDesktop?.writeClipboardText) {
      await bridge().writeClipboardText({ text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [config]);

  return (
    <div className="flex flex-col">
      <SettingRow
        title="Workspace"
        description="The local folder exposed to this workspace-scoped MCP server."
        testId="settings-row-workspace-path"
      >
        <code className="max-w-sm truncate rounded bg-panel-2 px-2 py-1 text-xs text-ink">
          {props.workspacePath}
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

      <section className="border-b border-line py-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="m-0 text-[13px] font-medium text-ink">MCP config</h3>
          <button
            type="button"
            onClick={() => void copyConfig()}
            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-ink"
          >
            {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="m-0 mb-2 text-[11px] text-muted">
          Paste this into your AI tool to let it use this workspace.
        </p>
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
