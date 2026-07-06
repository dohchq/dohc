import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  CloudOff,
  Download,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyncStatusResult, UpdateStateEvent } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

type Notice = {
  id:
    | "sync-conflict"
    | "sync-review"
    | "cloud-disconnected"
    | "cloud-sync-failing"
    | "history-capture-failed"
    | "history-recording-off"
    | "agent-active"
    | "update-ready";
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
  Icon: typeof Bell;
};

function toneClass(tone: Notice["tone"]): string {
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-warning";
  if (tone === "success") return "text-success";
  return "text-subtle";
}

export function NoticeCenter(props: {
  syncStatus: SyncStatusResult | null;
  agentActive: boolean;
  conflictSummaries: string[];
  onOpenHistory: () => void;
  onOpenAgent: () => void;
  // Opens the conflict review dialog (0P-C): the notice's "Review" action
  // lands the user directly on the side-by-side choices.
  onOpenConflicts: () => void;
  // Dismisses the sync-review notice (0P-C gate fix): clears the engine's
  // pending remote-resolve set after the user has taken their look.
  onDismissSyncReview?: () => void;
}) {
  const [open, setOpen] = useState(false);
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
      const result = await bridge().installUpdate();
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

  const notices = useMemo<Notice[]>(() => {
    const next: Notice[] = [];
    const state = props.syncStatus?.state;
    const conflictCount = props.syncStatus?.conflictCount ?? 0;

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

    // 0P-C honest minimum for cross-machine conflict resolution: another
    // machine resolved a conflict that no longer matches this workspace's
    // state (the file moved on here first). Nothing was changed silently —
    // point the user at History for the affected files.
    if ((props.syncStatus?.unmatchedRemoteResolves ?? 0) > 0) {
      next.push({
        id: "sync-review",
        tone: "warning",
        title: "A choice made on another machine needs a look",
        body: "Another machine chose what to keep for a file that has changed here since. Your local copy stays as it is — check History if something looks off.",
        action: { label: "Open History", onClick: props.onOpenHistory },
        // Live state, not a forever-notice: it clears by itself when the
        // affected conflict resolves, and the X lets the user acknowledge a
        // resolve that matched nothing local.
        ...(props.onDismissSyncReview ? { onDismiss: props.onDismissSyncReview } : {}),
        Icon: AlertTriangle,
      });
    }

    // Persistent while true (PR 0M-7): the flagged workspace's engine capture
    // is its sole history recorder, so a failing capture means History is
    // silently incomplete. Main clears the flag when a later capture
    // succeeds; one notice per workspace by construction (per-workspace flag).
    if (props.syncStatus?.historyCaptureFailed) {
      next.push({
        id: "history-capture-failed",
        tone: "warning",
        title: "History paused",
        body: "dohc couldn't record history for this workspace. Your files are safe on disk, but recent changes may be missing from History.",
        action: { label: "Open History", onClick: props.onOpenHistory },
        Icon: AlertTriangle,
      });
    }

    // Persistent while true (WS-H1 retirement Phase C): an engine opt-out
    // means NO history recorder exists at all — the legacy recorder is
    // retired. Same pattern as the capture-failure notice above: honest,
    // persistent, never spammy (the flag only changes at workspace open).
    if (props.syncStatus?.historyRecordingOff) {
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
        action: { label: "Open", onClick: props.onOpenAgent },
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
    props.agentActive,
    props.conflictSummaries,
    props.onOpenAgent,
    props.onOpenConflicts,
    props.onOpenHistory,
    props.onDismissSyncReview,
    props.syncStatus,
    installPending,
    installUpdate,
    updateActionError,
    updateState,
  ]);

  const count = notices.length;

  return (
    <>
      {updateToastVisible && updateState?.status === "ready" ? (
        <div
          ref={toastRef}
          data-testid="update-toast"
          role="status"
          className="fixed bottom-9 right-3 z-30 flex max-w-md items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink shadow-sm"
        >
          <span>{updateActionError ?? updateState.message}</span>
          {updateState.canInstall ? (
            <button
              type="button"
              disabled={installPending}
              onClick={() => void installUpdate()}
              className="shrink-0 rounded bg-ink px-2 py-1 text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
            >
              {installPending ? "Restarting" : "Restart"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => setDismissedUpdateToastKey(readyUpdateKey)}
            className="grid size-4 shrink-0 place-items-center rounded text-subtle hover:text-ink"
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
          className={`fixed right-3 z-20 flex w-[min(360px,calc(100vw-24px))] flex-col rounded-md border border-line bg-panel text-xs text-ink shadow-sm ${
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
                className="ml-auto rounded-full bg-ink px-1.5 text-[10px] font-semibold leading-4 text-bg"
              >
                {count}
              </span>
            ) : null}
          </header>
          {count === 0 ? (
            <div className="flex h-20 items-center gap-2 px-3 text-subtle">
              <Check size={14} aria-hidden />
              All clear
            </div>
          ) : (
            <ul className="m-0 max-h-80 list-none overflow-y-auto p-0">
              {notices.map((notice) => (
                <li
                  key={notice.id}
                  data-testid={`notice-${notice.id}`}
                  className="flex gap-2 border-b border-line px-3 py-2 last:border-b-0"
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
                          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
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
                          className={`${notice.action ? "" : "ml-auto "}grid size-4 shrink-0 place-items-center rounded text-subtle hover:text-ink`}
                        >
                          <X size={11} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                    <p className="m-0 mt-0.5 line-clamp-3 text-[11px] leading-snug text-muted">
                      {notice.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
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
        className="relative grid size-5 place-items-center rounded text-muted hover:bg-line/50 hover:text-ink"
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
