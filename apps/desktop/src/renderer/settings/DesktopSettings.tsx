import { useCallback, useEffect, useState } from "react";
import { Bot, Check, Copy, Download, RefreshCw } from "lucide-react";
import type {
  AgentRunStatusResult,
  McpConfigResult,
  UpdateStateEvent,
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
  onAgentActiveChange?: (active: boolean) => void;
}) {
  const { workspaceId, onAgentActiveChange } = props;
  const [status, setStatus] = useState<AgentRunStatusResult | null>(null);
  const [config, setConfig] = useState<McpConfigResult | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStateEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState<"check" | "install" | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
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
  useEffect(() => {
    let cancelled = false;
    void bridge()
      .getUpdateState()
      .then((next) => {
        if (!cancelled) {
          setUpdateError(null);
          setUpdateState(next);
        }
      })
      .catch(() => undefined);
    const unsubscribe = bridge().onUpdateState((next) => {
      setUpdateError(null);
      setUpdateState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
    await navigator.clipboard.writeText(configSnippet(config));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [config]);

  const checkForUpdates = useCallback(async () => {
    setUpdateBusy("check");
    setUpdateError(null);
    try {
      const result = await bridge().checkForUpdates();
      setUpdateState(result.state);
    } catch {
      setUpdateError("Could not check for updates.");
    } finally {
      setUpdateBusy(null);
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setUpdateBusy("install");
    setUpdateError(null);
    try {
      const result = await bridge().installUpdate();
      setUpdateState(result.state);
    } catch {
      setUpdateError("Could not restart into the update.");
    } finally {
      setUpdateBusy(null);
    }
  }, []);

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

      <section className="flex flex-col gap-3 rounded border border-line px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Download size={14} aria-hidden className="text-subtle" />
          <div className="min-w-0 flex-1">
            <span className="block text-[13px] text-ink">Desktop updates</span>
            <span
              data-testid="desktop-updates-status"
              data-state={updateState?.status ?? "unknown"}
              className="block truncate text-[11px] text-subtle"
            >
              {updateError ?? updateState?.message ?? "Update status unavailable."}
            </span>
          </div>
          <button
            type="button"
            data-testid="check-updates-button"
            disabled={updateBusy !== null || updateState?.canCheck === false}
            onClick={() => void checkForUpdates()}
            className="flex h-7 shrink-0 items-center gap-1 rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw size={12} aria-hidden />
            {updateBusy === "check" ? "Checking" : "Check"}
          </button>
          <button
            type="button"
            data-testid="install-update-button"
            disabled={updateBusy !== null || updateState?.canInstall !== true}
            onClick={() => void installUpdate()}
            className="h-7 shrink-0 rounded bg-ink px-2 text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
          >
            {updateBusy === "install" ? "Restarting" : "Restart"}
          </button>
        </div>
        <dl className="m-0 grid grid-cols-2 gap-2 text-[11px] text-muted">
          <div>
            <dt className="text-subtle">Version</dt>
            <dd data-testid="desktop-updates-version" className="m-0 text-ink">
              {updateState?.currentVersion ?? "unknown"}
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Channel</dt>
            <dd data-testid="desktop-updates-channel" className="m-0 text-ink">
              {updateState?.channel ?? "unknown"}
            </dd>
          </div>
        </dl>
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
