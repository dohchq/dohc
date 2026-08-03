import { Bot, Cloud, Settings, SunMoon } from "lucide-react";
import type { SyncStatusResult } from "../../ipc/bridgeContract";
import type { AgentNotification } from "./agentNotifications";
import { NoticeCenter } from "./NoticeCenter";

// Extracted shell footer (Phase E2). The sync-status testid + data-state,
// the "Connect dohc Cloud" button name, and the open-settings testid are
// pinned by many specs — they move here VERBATIM. New: conflict count,
// agent-run indicator, theme toggle, and the auto-update "ready" toast
// (updateMachine's user-visible message finally gets its surface).

const SYNC_LABEL: Record<SyncStatusResult["state"], string> = {
  synced: "Local · saved",
  syncing: "Saving…",
  "local-changes": "Local changes",
  conflict: "Conflict",
  "cloud-disconnected": "Cloud disconnected",
};

const SYNC_DOT: Record<SyncStatusResult["state"], string> = {
  synced: "bg-success",
  syncing: "bg-warning",
  "local-changes": "bg-warning",
  conflict: "bg-danger",
  "cloud-disconnected": "bg-subtle",
};

export function StatusBar(props: {
  // Scopes the notice center's set-aside section to the active workspace.
  workspaceId: string;
  workspaceName: string;
  syncStatus: SyncStatusResult | null;
  agentActive: boolean;
  conflictSummaries: string[];
  onConnectCloud: () => void;
  onOpenHistory: () => void;
  onOpenConflicts: () => void;
  onDismissSyncReview?: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onContextMenu: () => void;
  agentNotifications?: readonly AgentNotification[];
  onDismissAgentNotification?: (id: string) => void;
}) {
  const state = props.syncStatus?.state ?? "synced";
  const conflictCount = props.syncStatus?.conflictCount ?? 0;

  return (
    <footer
      className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-panel-2 px-3"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu();
      }}
    >
      <div className="flex items-center gap-3">
        <span
          data-testid="status-workspace"
          className="max-w-44 truncate font-mono text-[11px] text-subtle"
        >
          {props.workspaceName}
        </span>
        <span
          data-testid="sync-status"
          data-state={state}
          className="flex items-center gap-1.5 text-[11px] text-muted"
        >
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 rounded-full ${SYNC_DOT[state]}`}
          />
          {SYNC_LABEL[state]}
          {state === "conflict" && conflictCount > 0 ? ` (${conflictCount})` : ""}
        </span>
        {props.agentActive ? (
          <span
            data-testid="agent-run-indicator"
            className="flex items-center gap-1.5 text-[11px] text-agent"
          >
            <Bot size={12} aria-hidden />
            Agent running
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <NoticeCenter
          workspaceId={props.workspaceId}
          syncStatus={props.syncStatus}
          agentActive={props.agentActive}
          conflictSummaries={props.conflictSummaries}
          onOpenHistory={props.onOpenHistory}
          onOpenSettings={props.onOpenSettings}
          onOpenConflicts={props.onOpenConflicts}
          {...(props.onDismissSyncReview
            ? { onDismissSyncReview: props.onDismissSyncReview }
            : {})}
          {...(props.agentNotifications ? { agentNotifications: props.agentNotifications } : {})}
          {...(props.onDismissAgentNotification
            ? { onDismissAgentNotification: props.onDismissAgentNotification }
            : {})}
        />
        <button
          type="button"
          onClick={props.onConnectCloud}
          className="flex items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-ink"
        >
          <Cloud size={12} aria-hidden />
          Connect dohc Cloud
        </button>
        <button
          type="button"
          data-testid="toggle-theme"
          aria-label="Toggle theme"
          onClick={props.onToggleTheme}
          className="flex items-center text-muted transition-colors hover:text-ink"
        >
          <SunMoon size={13} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="open-settings"
          aria-label="Settings"
          onClick={props.onOpenSettings}
          className="flex items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-ink"
        >
          <Settings size={12} aria-hidden />
          Settings
        </button>
      </div>
    </footer>
  );
}
