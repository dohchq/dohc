import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  CloudOff,
  Download,
  GitPullRequestArrow,
  LogIn,
  MessageSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyncStatusResult, UpdateStateEvent } from "../../ipc/bridgeContract";
import { useAllOrphanedDrafts } from "../orphanedDrafts";
import { RecoveryList } from "../RecoveryList";
import { requestGuardedUpdateInstall } from "../RecoveryCloseGuard";
import { bridge } from "../bridge";
import type {
  AgentNotification,
  AgentNotificationKind,
} from "./agentNotifications";

type Notice = {
  // Sync/update notices use a fixed id; agent notices carry their own
  // per-(workspace, run, kind) id.
  id: string;
  tone: "danger" | "warning" | "success" | "neutral";
  title: string;
  body: string;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  // Explicit dismissal (0P-C gate fix): rendered as a small X on the notice
  // row. Only notices whose underlying state has a real ack path expose it.
  onDismiss?: () => void;
  // Agent notices carry when they happened; system notices are stateful
  // ("cloud disconnected") and render no time.
  timeMs?: number;
  Icon: typeof Bell;
};

// Coarse relative time for the notice ledger. Recomputed on every render;
// a 30s tick while the panel is open keeps labels honest between updates.
function relativeTime(thenMs: number): string {
  const elapsedMs = Math.max(0, Date.now() - thenMs);
  const deltaMinutes = Math.floor(elapsedMs / 60_000);
  if (deltaMinutes < 1) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return new Date(thenMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const AGENT_NOTICE_ICON: Record<AgentNotificationKind, typeof Bell> = {
  finished: CheckCircle2,
  "needs-input": Bot,
  asked: MessageSquare,
  error: AlertTriangle,
  "login-required": LogIn,
};

const AGENT_NOTICE_TONE: Record<AgentNotificationKind, Notice["tone"]> = {
  finished: "success",
  "needs-input": "warning",
  asked: "neutral",
  error: "danger",
  "login-required": "warning",
};

function toneClass(tone: Notice["tone"]): string {
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-warning";
  if (tone === "success") return "text-success";
  return "text-subtle";
}

export function NoticeCenter(props: {
  // Scopes the set-aside section: only the ACTIVE workspace's drafts show
  // here (#579 review, r6) — another workspace's paths must not leak across
  // a switch. The app-level close guard deliberately stays global.
  workspaceId: string;
  syncStatus: SyncStatusResult | null;
  agentActive: boolean;
  conflictSummaries: string[];
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  // Opens the conflict review dialog (0P-C): the notice's "Review" action
  // lands the user directly on the side-by-side choices.
  onOpenConflicts: () => void;
  // Opens the rebuild confirmation for a refused data store (#874). The
  // shell owns the dialog and the move; the notice only announces the
  // refusal and offers the way in.
  onRebuildEngineStore: () => void;
  // Changes a share recipient sent to this workspace, awaiting the granter
  // (#646 PR3a). One notice per submission, because each names its sender and
  // opens its own review — collapsing two senders into one row would have to
  // invent a title neither of them wrote.
  shareChangeNotices?: readonly { proposalId: string; sender: string }[];
  onReviewShareChanges?: (proposalId: string) => void;
  // Agent -> user notifications (finished / needs-input / asked / error).
  // Informational ledger entries: the History rail shows what the run did,
  // and a blocked run raises its own permission card. Dismiss acknowledges.
  agentNotifications?: readonly AgentNotification[];
  onDismissAgentNotification?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Relative-time labels ("3m ago") are computed at render; tick every 30s
  // while the panel is open so they can't sit stale between state updates.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(interval);
  }, [open]);
  const [updateState, setUpdateState] = useState<UpdateStateEvent | null>(null);
  const [dismissedUpdateToastKey, setDismissedUpdateToastKey] = useState<
    string | null
  >(null);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);
  const [installPending, setInstallPending] = useState(false);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const toastRef = useRef<HTMLDivElement | null>(null);
  const updateSubscriptionFiredRef = useRef(false);

  const applyUpdateState = useCallback((update: UpdateStateEvent) => {
    if (update.status === "ready") {
      setUpdateState(update);
      setUpdateActionError(null);
      return;
    }
    setUpdateState(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    updateSubscriptionFiredRef.current = false;
    void bridge()
      .getUpdateState()
      .then((update) => {
        if (!cancelled && !updateSubscriptionFiredRef.current) {
          applyUpdateState(update);
        }
      })
      .catch(() => undefined);
    const unsubscribe = bridge().onUpdateState((update) => {
      updateSubscriptionFiredRef.current = true;
      applyUpdateState(update);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyUpdateState]);

  const readyUpdateKey =
    updateState?.status === "ready"
      ? `${updateState.version ?? "unknown"}:${updateState.message}`
      : null;
  const updateToastVisible =
    updateState?.status === "ready" &&
    readyUpdateKey !== null &&
    readyUpdateKey !== dismissedUpdateToastKey;
  const installUpdate = useCallback(async () => {
    if (installPending) return;
    try {
      setInstallPending(true);
      setUpdateActionError(null);
      // Through the guard (#579 review, r8 + r10): with set-aside drafts
      // present the recovery dialog opens INSTEAD of the one-shot install,
      // and its confirm makes the only quitAndInstall call.
      const result = await requestGuardedUpdateInstall();
      if (result === null) return;
      if (!result.accepted || result.state.status === "error") {
        setUpdateActionError(
          result.state.status === "error"
            ? result.state.message
            : "Could not restart into the update.",
        );
      }
    } catch {
      setUpdateActionError("Could not restart into the update.");
    } finally {
      setInstallPending(false);
    }
  }, [installPending]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (centerRef.current?.contains(target)) return;
      if (toggleRef.current?.contains(target)) return;
      if (toastRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const agentNotifications = props.agentNotifications ?? [];
  const notices = useMemo<Notice[]>(() => {
    const next: Notice[] = [];
    const state = props.syncStatus?.state;
    const conflictCount = props.syncStatus?.conflictCount ?? 0;

    // Agent -> user notices lead: a run that finished, is blocked, asked a
    // question, or failed is the thing the user most needs to see. Newest
    // first so a fresh ask isn't buried under an older "finished".
    for (const notification of [...agentNotifications].sort(
      (a, b) => b.createdAtMs - a.createdAtMs,
    )) {
      next.push({
        id: notification.id,
        tone: AGENT_NOTICE_TONE[notification.kind],
        title: notification.title,
        body: notification.body,
        timeMs: notification.createdAtMs,
        Icon: AGENT_NOTICE_ICON[notification.kind],
        ...(props.onDismissAgentNotification
          ? { onDismiss: () => props.onDismissAgentNotification?.(notification.id) }
          : {}),
      });
    }

    // Above the sync notices: someone is waiting on the granter's decision,
    // and until it comes their work sits where nobody can use it.
    for (const sent of props.shareChangeNotices ?? []) {
      next.push({
        id: `share-changes-${sent.proposalId}`,
        tone: "neutral",
        title: `${sent.sender} sent you changes`,
        body: "Review them to choose what to keep.",
        ...(props.onReviewShareChanges
          ? {
              action: {
                label: "Review",
                onClick: () => props.onReviewShareChanges?.(sent.proposalId),
              },
            }
          : {}),
        Icon: GitPullRequestArrow,
      });
    }

    if (state === "conflict") {
      next.push({
        id: "sync-conflict",
        tone: "danger",
        title:
          conflictCount > 1
            ? `${conflictCount} files changed on two machines`
            : "A file changed on two machines",
        body:
          props.conflictSummaries[0] ??
          "Both copies are safe. Review the differences to choose what stays.",
        action: { label: "Review", onClick: props.onOpenConflicts },
        Icon: AlertTriangle,
      });
    } else if (state === "cloud-disconnected") {
      next.push({
        id: "cloud-disconnected",
        tone: "warning",
        title: "Cloud disconnected",
        body: "Local work is safe. Reconnect dohc Cloud when you want sync again.",
        Icon: CloudOff,
      });
    }

    for (const declined of props.syncStatus?.sharingDeclined ?? []) {
      next.push({
        id: `sharing-declined-${declined.path}`,
        tone: "warning",
        title: "File is too large to sync",
        body: `Your edit is saved on this machine. "${declined.path}" uses ${declined.observedBytes.toLocaleString("en-US")} bytes after encoding. Sync allows ${declined.limitBytes.toLocaleString("en-US")} bytes. Reduce the file to sync it.`,
        Icon: AlertTriangle,
      });
    }

    // #874: the engine refused to open this workspace's database — a
    // designed recovery outcome, not a generic capture failure. Say what was
    // found in the user's nouns and offer the real recovery; the
    // capture-failed copy below would claim recent changes "may be missing"
    // from a History that cannot open at all, and offers nothing.
    if (props.syncStatus?.engineStoreRefused) {
      next.push({
        id: "engine-store-refused",
        tone: "danger",
        title:
          props.syncStatus.engineStoreRefused === "unsupported-fingerprint"
            ? "Data store from an older dohc"
            : "Data store not created by dohc",
        body:
          props.syncStatus.engineStoreRefused === "unsupported-fingerprint"
            ? "This workspace's data store is from an older version of dohc. Your files are untouched."
            : "This workspace's data store was not created by dohc. Your files are untouched.",
        action: { label: "Rebuild", onClick: props.onRebuildEngineStore },
        Icon: AlertTriangle,
      });
    } else if (props.syncStatus?.historyCaptureFailed) {
      next.push({
        id: "history-capture-failed",
        tone: "warning",
        title: "History paused",
        body: "dohc couldn't record history for this workspace. Your files are safe on disk, but recent changes may be missing from History.",
        action: { label: "Open History", onClick: props.onOpenHistory },
        Icon: AlertTriangle,
      });
    }

    // Persistent while true (WS-H1 retirement Phase C): no engine capture
    // means NO history recorder exists at all — the legacy recorder is
    // retired. Honest, persistent, never spammy (both flags change only at
    // workspace open). Three causes end in no recorder, and only the LAST is
    // the user's Settings choice — so each earlier cause claims the notice
    // first. An unreadable settings file reads as opted out; a recorder that
    // failed to build never got that far. Naming Settings for either would be
    // a lie about a setting the user never touched.
    //
    // The causes come from ONE read — main's, at workspace open, riding the
    // status the renderer already consumes (#483). A second read here could
    // name a cause that never happened, or promise "no history" for a
    // workspace that is recording.
    //
    // A shared view leads the cascade (#540) and takes no notice at all, at
    // any level. At view and comment it gets no recorder BY DESIGN — a
    // capability, not an opt-out and not a failure. At edit (#646 PR3a) it
    // does get one, so there is nothing to warn about either. Both ways every
    // history-off body below would state a cause that is false here, and the
    // share banner already says what the surface is.
    if (props.syncStatus?.historyShareView) {
      // Nothing to warn about.
    } else if (props.syncStatus?.settingsWarning) {
      next.push({
        id: "workspace-settings-unreadable",
        tone: "warning",
        title: "History is off for this workspace",
        body: props.syncStatus.settingsWarning,
        action: { label: "Open Settings", onClick: props.onOpenSettings },
        Icon: AlertTriangle,
      });
    } else if (props.syncStatus?.historyRecordingUnavailable) {
      // #505: the recorder could not be BUILT at open. Nothing records, so
      // historyRecordingOff is true as well — but that branch names Settings
      // as the cause, and the user changed no setting. State the failure and
      // the one step that retries it: main builds the recorder once per
      // workspace per app session, so reopening the workspace re-reads nothing.
      next.push({
        id: "history-recording-unavailable",
        tone: "warning",
        title: "History is off for this workspace",
        body: "dohc could not start recording history for this workspace. Your files still save normally. Restart dohc to try again.",
        Icon: AlertTriangle,
      });
    } else if (props.syncStatus?.historyRecordingOff) {
      next.push({
        id: "history-recording-off",
        tone: "warning",
        title: "History is off for this workspace",
        body: "The workspace engine is turned off in Settings, so changes are not being recorded. Your files still save normally.",
        Icon: AlertTriangle,
      });
    }

    if (props.syncStatus?.syncFailing) {
      next.push({
        id: "cloud-sync-failing",
        tone: "warning",
        title: "Cloud sync is failing",
        body: "Cloud sync is failing for this workspace. Changes stay safe locally and sync will keep retrying.",
        Icon: AlertTriangle,
      });
    }

    if (props.agentActive) {
      next.push({
        id: "agent-active",
        tone: "success",
        title: "Agent running",
        body: "Workspace changes from this run will be attributed in history.",
        action: { label: "Open History", onClick: props.onOpenHistory },
        Icon: Bot,
      });
    }

    if (updateState?.status === "ready") {
      next.push({
        id: "update-ready",
        tone: "neutral",
        title: "Update ready",
        body: updateActionError ?? updateState.message,
        action: updateState.canInstall
          ? {
              label: installPending ? "Restarting" : "Restart",
              onClick: () => void installUpdate(),
              disabled: installPending,
            }
          : undefined,
        Icon: Download,
      });
    }

    return next;
  }, [
    agentNotifications,
    props.agentActive,
    props.conflictSummaries,
    props.onDismissAgentNotification,
    props.onOpenConflicts,
    props.onOpenHistory,
    props.onOpenSettings,
    props.onRebuildEngineStore,
    props.onReviewShareChanges,
    props.shareChangeNotices,
    props.syncStatus,
    installPending,
    installUpdate,
    updateActionError,
    updateState,
  ]);

  // Set-aside drafts (#567) count as one notice: they may belong to paths
  // that no longer exist (a deleted file's tab is gone), so this panel is
  // their always-reachable surface (#579 review, r5) — the list below offers
  // the same Copy/Dismiss the in-document notice does. Scoped to the active
  // workspace (#579 review, r6).
  const allRecoveryRows = useAllOrphanedDrafts();
  const recoveryRows = useMemo(
    () =>
      allRecoveryRows.filter((row) => row.workspaceId === props.workspaceId),
    [allRecoveryRows, props.workspaceId],
  );
  const count = notices.length + (recoveryRows.length > 0 ? 1 : 0);

  return (
    <>
      {updateToastVisible && updateState?.status === "ready" ? (
        <div
          ref={toastRef}
          data-testid="update-toast"
          role="status"
          className="dohc-popover dohc-pop-in fixed bottom-9 right-3 z-30 flex max-w-md items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
        >
          <span>{updateActionError ?? updateState.message}</span>
          {updateState.canInstall ? (
            <button
              type="button"
              disabled={installPending}
              onClick={() => void installUpdate()}
              className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
            >
              {installPending ? "Restarting" : "Restart"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => setDismissedUpdateToastKey(readyUpdateKey)}
            className="grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ) : null}

      {open ? (
        <div
          ref={centerRef}
          data-testid="notice-center"
          role="dialog"
          aria-label="Notices"
          className={`dohc-popover dohc-pop-in fixed right-3 z-20 flex w-[min(360px,calc(100vw-24px))] flex-col rounded-lg border border-line bg-panel text-xs text-ink ${
            updateToastVisible ? "bottom-20" : "bottom-9"
          }`}
        >
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <Bell size={13} aria-hidden className="text-subtle" />
            <span className="font-semibold uppercase tracking-wide text-muted">
              Notices
            </span>
            {count > 0 ? (
              <span
                data-testid="notice-center-count"
                className="ml-auto rounded-full border border-line bg-panel-2 px-1.5 text-[10px] font-medium leading-4 text-muted"
              >
                {count}
              </span>
            ) : null}
          </header>
          {count === 0 ? (
            <div className="flex h-20 items-center justify-center gap-2 px-3 text-subtle">
              <Check size={14} aria-hidden />
              All clear
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {recoveryRows.length > 0 ? (
                <section
                  data-testid="notice-set-aside-edits"
                  className="border-b border-line px-3 py-2"
                >
                  <p className="m-0 text-[12px] font-medium text-ink">
                    {recoveryRows.length === 1
                      ? "1 set-aside edit is waiting"
                      : `${recoveryRows.length} set-aside edits are waiting`}
                  </p>
                  <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted">
                    Copy an edit to keep its text. Dismiss deletes it for good.
                  </p>
                  <RecoveryList rows={recoveryRows} />
                </section>
              ) : null}
            <ul className="m-0 list-none p-0">
              {notices.map((notice) => (
                <li
                  key={notice.id}
                  data-testid={`notice-${notice.id}`}
                  className="dohc-pop-in flex gap-2 border-b border-line px-3 py-2 last:border-b-0"
                >
                  <notice.Icon
                    size={14}
                    aria-hidden
                    className={`mt-0.5 shrink-0 ${toneClass(notice.tone)}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[12px] font-medium text-ink">
                        {notice.title}
                      </span>
                      {notice.action ? (
                        <button
                          type="button"
                          disabled={notice.action.disabled}
                          onClick={() => {
                            notice.action?.onClick();
                            setOpen(false);
                          }}
                          className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-50"
                        >
                          {notice.action.label}
                        </button>
                      ) : null}
                      {notice.onDismiss ? (
                        <button
                          type="button"
                          data-testid={`notice-${notice.id}-dismiss`}
                          aria-label="Dismiss notice"
                          onClick={() => notice.onDismiss?.()}
                          className={`${notice.action ? "" : "ml-auto "}grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink`}
                        >
                          <X size={11} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                    <p className="m-0 mt-0.5 line-clamp-3 text-[11px] leading-snug text-muted">
                      {notice.body}
                    </p>
                    {notice.timeMs !== undefined ? (
                      <time
                        dateTime={new Date(notice.timeMs).toISOString()}
                        className="mt-1 block font-mono text-[10px] text-subtle"
                      >
                        {relativeTime(notice.timeMs)}
                      </time>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            </div>
          )}
        </div>
      ) : null}

      <button
        ref={toggleRef}
        type="button"
        data-testid="notice-center-toggle"
        aria-label={count > 0 ? `Notices (${count})` : "Notices"}
        title="Notices"
        onClick={() => setOpen((value) => !value)}
        className="relative grid size-5 place-items-center rounded-md text-muted transition-colors hover:bg-line/50 hover:text-ink"
      >
        <Bell size={13} aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 h-3 min-w-3 rounded-full bg-ink px-0.5 text-center text-[8px] font-semibold leading-3 text-bg"
          >
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>
    </>
  );
}
