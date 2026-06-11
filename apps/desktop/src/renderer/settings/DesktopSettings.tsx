import { useCallback, useEffect, useState } from "react";
import { Bot, Check, Copy } from "lucide-react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// Settings surface (reached via the command-palette "Settings" command or the
// gear). It exposes the local agent integration: the workspace path, the MCP
// server status with an Enable toggle, a COPYABLE config snippet the user pastes
// into their AI tool, and a few usage examples. The MCP server is optional and
// user-controlled — nothing runs until the user enables it here.

// The shape the user pastes into ~/.claude.json or ~/.codex/config.toml.
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

const USAGE_EXAMPLES = [
  "Create a finance app that reads my budget notes.",
  "Import expenses.csv into a database and show me last month's total.",
  "Resolve the merge conflict in plans/roadmap.md.",
];

export function DesktopSettings(props: {
  workspaceId: string;
  workspacePath: string;
  onClose: () => void;
}) {
  const { workspaceId } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const [nextStatus, nextConfig] = await Promise.all([
      bridge().getAgentRunStatus({ workspaceId }),
      bridge().getMcpConfig({ workspaceId }),
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabled = status?.mcpEnabled ?? false;

  const toggle = useCallback(async () => {
    setBusy(true);
    try {
      if (enabled && status?.activeRun) {
        await bridge().endAgentRun({ workspaceId, runId: status.activeRun.id });
      } else {
        await bridge().startAgentRun({ workspaceId });
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [enabled, status, workspaceId, refresh]);

  const copyConfig = useCallback(async () => {
    if (!config) return;
    await navigator.clipboard.writeText(configSnippet(config));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [config]);

  return (
    <div
      data-testid="settings-panel"
      className="flex w-160 max-w-[90vw] flex-col gap-5 overflow-hidden rounded-lg border border-line bg-panel p-6 shadow-lg"
    >
      <header className="flex items-center gap-2">
        <Bot size={16} aria-hidden className="text-subtle" />
        <h2 className="m-0 text-sm font-semibold text-ink">Agents &amp; MCP</h2>
        <button
          type="button"
          onClick={props.onClose}
          className="ml-auto text-xs text-subtle hover:text-ink"
        >
          Close
        </button>
      </header>

      <section className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wide text-subtle">Workspace</span>
        <code className="rounded bg-panel-2 px-2 py-1 text-xs text-ink">{props.workspacePath}</code>
      </section>

      <section className="flex items-center justify-between gap-4 rounded border border-line px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] text-ink">dohc MCP server</span>
          <span data-testid="mcp-status" data-state={enabled ? "running" : "stopped"} className="text-[11px] text-subtle">
            {enabled ? "Running — your agent can use dohc tools" : "Stopped"}
          </span>
        </div>
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
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wide text-subtle">MCP config</span>
          <button
            type="button"
            onClick={() => void copyConfig()}
            className="ml-auto flex items-center gap-1 text-[11px] text-subtle hover:text-ink"
          >
            {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="m-0 text-[11px] text-subtle">
          Paste this into your AI tool (e.g. ~/.claude.json) to let it use this workspace.
        </p>
        <pre
          data-testid="mcp-config-snippet"
          className="m-0 overflow-x-auto rounded bg-panel-2 p-3 text-[11px] leading-relaxed text-ink"
        >
          {config ? configSnippet(config) : "…"}
        </pre>
      </section>

      <section className="flex flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-subtle">Try asking your agent</span>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
