import { AlertTriangle, Bell, Bot, Check, CheckCircle2, CloudOff, Copy, Download, GitPullRequestArrow, LogIn, MessageSquare, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ENGINE_STORE_BACKUP_DIR,
  ENGINE_STORE_UPDATE_NEXT_STEP,
  engineStoreRefusalRecovery,
  engineStoreRefusalSentence,
  type AutomationFailureNotice,
  type SyncStatusResult,
} from "../../ipc/bridgeContract";
import { useAllOrphanedDrafts } from "../orphanedDrafts";
import { RecoveryList } from "../RecoveryList";
import { requestGuardedUpdateInstall } from "../RecoveryCloseGuard";
import { useDesktopUpdateStateFeed } from "../useDesktopUpdateStateFeed";
import { CopyDetailsButton, errorDetails } from "../shell/copyDetails";
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
  // A report a person can paste: shown as a copy control on the row.
  copyText?: string;
  Icon: typeof Bell;
};

// A workspace error the shell reported. `details` is the report Copy puts
// on the clipboard; `seen` means its toast was closed and only the row in
// Notices remains.
export interface WorkspaceErrorNotice {
  tone?: "success";
  id: string;
  message: string;
  details: string;
  atMs: number;
  canRetry: boolean;
  seen: boolean;
}

// Mirrors of crates/dohc-engine-domain/src/automations.rs: the chain depth
// cap and the two engine-minted failure reasons a failed claim can carry.
const AUTOMATION_CHAIN_DEPTH_CAP = 4;
const AUTOMATION_CHAIN_STOPPED = "chain-stopped";
const AUTOMATION_RECLAIM_EXHAUSTED = "reclaim-exhausted";

/** An error text as one sentence: the handler's message rarely ends one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

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

// The title and body for one automation's failure notice: what happened,
// why when the engine recorded a known reason, and the way forward. The two
// engine-recorded reason codes get their own honest sentences; every other
// error is the handler's own text. The copy must never claim the handler
// threw when it did not run at all (chain-stopped) or did not finish
// (reclaim-exhausted).
function automationFailureCopy(failure: AutomationFailureNotice): {
  title: string;
  body: string;
} {
  const count =
    failure.generation > 1 ? `${failure.generation} failures so far. ` : "";
  if (failure.error === AUTOMATION_CHAIN_STOPPED) {
    return {
      title: "An automation chain stopped",
      body:
        `${count}dohc stops a chain of automations after ${AUTOMATION_CHAIN_DEPTH_CAP} steps, so ` +
        `"${failure.automationId}" did not run. Open the plugin's source to ` +
        "shorten the chain.",
    };
  }
  if (failure.error === AUTOMATION_RECLAIM_EXHAUSTED) {
    return {
      title: `Automation "${failure.automationId}" did not finish`,
      body:
        `${count}dohc stopped retrying a run that did not finish. ` +
        "Open the plugin's source to check the handler.",
    };
  }
  return {
    title: `Automation "${failure.automationId}" failed`,
    body: `${count}${sentence(failure.error)} Open the plugin's source to fix the handler.`,
  };
}

// Owner live delivery, and only while it is retrying: what stopped, and the
// way forward. A stable reason is not a connection the engine can dial
// again, so it never offers Try again — resuming a document there would
// rebind an identity the user has not asked for. The transient case is the
// only one the retry command can help.
type LiveDeliveryRecovery = "retry" | "live-documents" | "restart";
function liveDeliveryCopy(
  reason: SyncStatusResult["ownerLiveDeliveryReason"],
): { title: string; body: string; recovery: LiveDeliveryRecovery } {
  if (reason === "document-unavailable") {
    return {
      title: "Live editing paused",
      body: "A document this workspace was editing live is no longer available. Open Live documents to review it.",
      recovery: "live-documents",
    };
  }
  if (reason === "workspace-changed") {
    return {
      title: "Live editing paused",
      body: "This workspace changed while live editing was running. Open Live documents to review affected documents.",
      recovery: "live-documents",
    };
  }
  if (reason === "restart-required") {
    return {
      title: "Live editing paused",
      body: "Restart dohc to enable live editing. Your edits are saved on this device.",
      recovery: "restart",
    };
  }
  return {
    title: "Live editing retrying",
    body: "dohc is retrying live editing for this workspace. Your edits are saved on this device.",
    recovery: "retry",
  };
}

// Owner live enrollment refusals: one workspace fact, however many shares it
// covers. Only the list can name them, so the notice sends the user there.
const OWNER_LIVE_REFUSALS_TITLE = "Some shares could not start live editing";
const OWNER_LIVE_REFUSALS_BODY =
  "Open Live documents to see which files are affected and try again.";

// Corner hosts need room above the bell; rail hosts use the bottom-right corner.
export type NoticeHostPlacement = "rail" | "corner";

const TOAST_STACK_CLASS: Record<NoticeHostPlacement, string> = {
  rail: "fixed bottom-3 right-3 z-40 flex flex-col items-end gap-2",
  // The corner toggle is 36px tall on an 8px inset; 56px clears it with a gap.
  corner: "fixed bottom-14 right-3 z-40 flex flex-col items-end gap-2",
};

const PANEL_POSITION_CLASS: Record<NoticeHostPlacement, string> = {
  rail: "bottom-12 left-14 w-[min(360px,calc(100vw-68px))]",
  corner: "bottom-14 right-3 w-[min(360px,calc(100vw-24px))]",
};

function toneClass(tone: Notice["tone"]): string {
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-warning";
  if (tone === "success") return "text-success";
  return "text-subtle";
}

export function NoticeCenter(props: {
  // Scopes the set-aside section: only the active workspace's drafts show
  // here — another workspace's paths must not leak across
  // a switch. The app-level close guard deliberately stays global.
  workspaceId: string;
  // Where the surface above mounts this center. Defaults to the workbench's
  // activity bar.
  host?: NoticeHostPlacement;
  syncStatus: SyncStatusResult | null;
  agentActive: boolean;
  conflictSummaries: string[];
  onOpenHistory: () => void;
  onOpenSettings: () => void;
  // Opens the conflict review dialog (0P-C): the notice's "Review" action
  // lands the user directly on the side-by-side choices.
  onOpenConflicts: () => void;
  onRefreshShareView: () => void;
  // Opens the rebuild confirmation for a refused data store. The
  // shell owns the dialog and the move; the notice only announces the
  // refusal and offers the way in.
  onRebuildEngineStore: (returnFocus: HTMLButtonElement) => void;
  // Opens the restart confirmation for a ready update. Without it the
  // notice center installs directly.
  onRestartToUpdate?: () => void;
  // Workspace errors the shell reported. Newest first in the list; the
  // newest unseen one is also a toast, so an error is noticed without
  // pushing the workspace around.
  workspaceErrors?: readonly WorkspaceErrorNotice[];
  onRetryWorkspaceError?: (id: string) => void;
  onHideWorkspaceError?: (id: string) => void;
  onDismissWorkspaceError?: (id: string) => void;
  // Owner live delivery: the shell's trusted retry command, and the way into
  // the live-document list. Both are derived from the status, so a snapshot
  // that repeats itself changes nothing here.
  onRetryLiveDelivery?: () => void;
  onOpenLiveDocuments?: () => void;
  // Changes a share recipient sent to this workspace, awaiting the granter.
  // One notice per submission, because each names its sender and
  // opens its own review — collapsing two senders into one row would have to
  // invent a title neither of them wrote.
  shareChangeNotices?: readonly { proposalId: string; sender: string }[];
  onReviewShareChanges?: (proposalId: string) => void;
  // Agent -> user notifications (finished / needs-input / asked / error).
  // Informational ledger entries: the History rail shows what the run did,
  // and a blocked run raises its own permission card. Dismiss acknowledges.
  agentNotifications?: readonly AgentNotification[];
  onDismissAgentNotification?: (id: string) => void;
  // Automation failures (ADR 0008): the engine's failed claim rows the
  // owner has not acknowledged, one notice per automation with the newest
  // error and a count. Durable — they come back after a restart until
  // dismissed, and a newer failure re-raises a dismissed one.
  automationFailures?: readonly AutomationFailureNotice[];
  onDismissAutomationFailure?: (
    automationId: string,
    generation: number,
  ) => void;
}) {
  const host: NoticeHostPlacement = props.host ?? "rail";
  const [open, setOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) centerRef.current?.focus({ preventScroll: true });
  }, [open]);
  // Relative-time labels ("3m ago") are computed at render; tick every 30s
  // while the panel is open so they can't sit stale between state updates.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(interval);
  }, [open]);
  const [dismissedUpdateToastKey, setDismissedUpdateToastKey] = useState<
    string | null
  >(null);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);
  const [installPending, setInstallPending] = useState(false);
  const { updateState: desktopUpdateState, acceptUpdateResult } =
    useDesktopUpdateStateFeed((update) => {
      setUpdateActionError(update.status === "error" ? update.message : null);
    });
  const updateState =
    desktopUpdateState?.status === "ready" ? desktopUpdateState : null;
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  const readyUpdateKey =
    updateState?.status === "ready"
      ? `${updateState.version ?? "unknown"}:${updateState.message}`
      : null;
  const updateToastVisible =
    updateActionError !== null ||
    (updateState?.status === "ready" &&
      readyUpdateKey !== null &&
      readyUpdateKey !== dismissedUpdateToastKey);

  // Derived from the status, never accumulated: a snapshot that repeats
  // itself renders the same notice, and delivery that recovers to active (or
  // reports nothing at all) leaves no notice and no toast behind.
  // The workspace is part of the key: a dismissal answers one workspace's
  // failure, so the same failure in another workspace is still news.
  const liveDeliveryReason = props.syncStatus?.ownerLiveDeliveryReason;
  const liveDeliveryKey =
    props.syncStatus?.ownerLiveDelivery === "retrying"
      ? `${props.workspaceId}:retrying:${liveDeliveryReason ?? "transient"}`
      : null;
  const [dismissedLiveDeliveryKey, setDismissedLiveDeliveryKey] = useState<
    string | null
  >(null);
  // Recovery forgets the dismissal, so the next failure is announced again
  // instead of staying silent behind an answer about an older one.
  if (liveDeliveryKey === null && dismissedLiveDeliveryKey !== null) {
    setDismissedLiveDeliveryKey(null);
  }
  // Keyed, so an unchanged status keeps one copy object: the notice list and
  // the toast below both hang off its identity.
  const liveDelivery = useMemo(
    () => (liveDeliveryKey ? liveDeliveryCopy(liveDeliveryReason) : null),
    [liveDeliveryKey, liveDeliveryReason],
  );
  // One report for the row and the toast, so a person who copies from either
  // pastes the same facts — including when this state was first observed.
  const liveDeliveryDetails = useMemo(
    () =>
      liveDelivery
        ? errorDetails([
            ["Live editing", liveDelivery.title],
            ["Detail", liveDelivery.body],
            ["Reason", liveDeliveryReason ?? "retrying"],
            ["Workspace id", props.workspaceId],
            ["Time", new Date().toISOString()],
          ])
        : "",
    [liveDelivery, liveDeliveryReason, props.workspaceId],
  );
  const { onOpenLiveDocuments, onRetryLiveDelivery } = props;
  // One control for the row and the toast, so they can never offer different
  // ways out of the same state. A restart has no command to call.
  const liveDeliveryAction = useMemo(() => {
    if (!liveDelivery) return null;
    if (liveDelivery.recovery === "retry") {
      return onRetryLiveDelivery
        ? { label: "Try again", onClick: onRetryLiveDelivery }
        : null;
    }
    if (liveDelivery.recovery === "live-documents") {
      return onOpenLiveDocuments
        ? { label: "Live documents", onClick: onOpenLiveDocuments }
        : null;
    }
    return null;
  }, [liveDelivery, onOpenLiveDocuments, onRetryLiveDelivery]);
  const liveDeliveryToastVisible =
    liveDeliveryKey !== null && liveDeliveryKey !== dismissedLiveDeliveryKey;

  // One status bit gives one workspace-keyed notice.
  const refusalsKey = props.syncStatus?.hasOwnerLiveRefusals
    ? `${props.workspaceId}:live-refusals`
    : null;
  const [dismissedRefusalsKey, setDismissedRefusalsKey] = useState<string | null>(
    null,
  );
  if (refusalsKey === null && dismissedRefusalsKey !== null) {
    setDismissedRefusalsKey(null);
  }
  const refusalsToastVisible =
    refusalsKey !== null && refusalsKey !== dismissedRefusalsKey;
  // The row and toast copy the same safe report.
  const refusalsDetails = useMemo(
    () =>
      refusalsKey
        ? errorDetails([
            ["Live editing", OWNER_LIVE_REFUSALS_TITLE],
            ["Detail", OWNER_LIVE_REFUSALS_BODY],
            ["Workspace id", props.workspaceId],
            ["Time", new Date().toISOString()],
          ])
        : "",
    [refusalsKey, props.workspaceId],
  );

  const installUpdate = useCallback(async () => {
    if (installPending) return;
    try {
      setInstallPending(true);
      // Through the guard: with set-aside drafts
      // present the recovery dialog opens instead of the one-shot install,
      // and its confirm makes the only quitAndInstall call.
      const result = await requestGuardedUpdateInstall();
      if (result === null) return;
      acceptUpdateResult(result.state);
      if (!result.accepted || result.state.status === "error") {
        setUpdateActionError(
          result.state.status === "error"
            ? result.state.message
            : "Could not restart into the update.",
        );
      } else {
        setUpdateActionError(null);
      }
    } catch {
      setUpdateActionError("Could not restart into the update.");
    } finally {
      setInstallPending(false);
    }
  }, [acceptUpdateResult, installPending]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (centerRef.current && path.includes(centerRef.current)) return;
      if (toggleRef.current && path.includes(toggleRef.current)) return;
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

    // Automation failures: durable until dismissed, like the share-refusal
    // banner. Dismissing acknowledges the generation on screen; a failure
    // recorded after this render has a higher generation and comes back.
    for (const error of [...(props.workspaceErrors ?? [])].sort(
      (a, b) => b.atMs - a.atMs,
    )) {
      next.push({
        id: error.id,
        tone: error.tone ?? "danger",
        title: error.message,
        body: "",
        ...(error.canRetry && props.onRetryWorkspaceError
          ? {
              action: {
                label: "Try again",
                onClick: () => props.onRetryWorkspaceError?.(error.id),
              },
            }
          : {}),
        ...(props.onDismissWorkspaceError
          ? { onDismiss: () => props.onDismissWorkspaceError?.(error.id) }
          : {}),
        timeMs: error.atMs,
        copyText: error.details,
        Icon: error.tone === "success" ? CheckCircle2 : AlertTriangle,
      });
    }
    for (const failure of props.automationFailures ?? []) {
      next.push({
        id: `automation-failure-${failure.automationId}`,
        tone: "warning",
        ...automationFailureCopy(failure),
        timeMs: failure.updatedAtMs,
        Icon: AlertTriangle,
        ...(props.onDismissAutomationFailure
          ? {
              onDismiss: () =>
                props.onDismissAutomationFailure?.(
                  failure.automationId,
                  failure.generation,
                ),
            }
          : {}),
      });
    }

    // Above the sync states: the local save is fine, and this says what is
    // not — live editing for the owner's own documents.
    if (liveDelivery) {
      next.push({
        id: "owner-live-delivery",
        tone: "warning",
        title: liveDelivery.title,
        body: liveDelivery.body,
        ...(liveDeliveryAction ? { action: liveDeliveryAction } : {}),
        copyText: liveDeliveryDetails,
        Icon: RefreshCw,
      });
    }

    // Enrollment refused for at least one share. Live documents lists them
    // with their files; nothing here promises a retry will succeed.
    if (refusalsKey) {
      next.push({
        id: "owner-live-refusals",
        tone: "warning",
        title: OWNER_LIVE_REFUSALS_TITLE,
        body: OWNER_LIVE_REFUSALS_BODY,
        ...(onOpenLiveDocuments
          ? { action: { label: "Live documents", onClick: onOpenLiveDocuments } }
          : {}),
        copyText: refusalsDetails,
        Icon: AlertTriangle,
      });
    }

    if (props.syncStatus?.shareProjection?.state === "pending") {
      next.push({
        id: "share-projection-pending",
        tone: "warning",
        title: "Shared files need repair",
        body:
          "Some shared files are not current in this folder. Refresh the shared view to repair them.",
        action: { label: "Refresh", onClick: props.onRefreshShareView },
        Icon: AlertTriangle,
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
        title: "Server disconnected",
        body: "Local work is safe. Reconnect your server when you want sync again.",
        Icon: CloudOff,
      });
    }

    for (const pending of props.syncStatus?.ownerAdmissionPending ?? []) {
      next.push({
        id: `owner-admission-pending-${pending.originId}-${pending.originSeq}`,
        tone: "warning",
        title: "Saved locally · Pending share",
        body: `Your edits to "${pending.path}" are saved on this device. The shared file update is pending.`,
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

    if (props.syncStatus?.engineStoreRefused) {
      const refusal = props.syncStatus.engineStoreRefused;
      // A store this build could not migrate is intact and offers no
      // action here: the workspace itself says what to do.
      const rebuild = engineStoreRefusalRecovery(refusal) === "rebuild";
      next.push({
        id: "engine-store-refused",
        tone: "danger",
        title: engineStoreRefusalSentence(refusal),
        body: rebuild
          ? `Your files are untouched. Rebuild moves the data store to ${ENGINE_STORE_BACKUP_DIR} and rebuilds history from your files.`
          : ENGINE_STORE_UPDATE_NEXT_STEP,
        ...(rebuild
          ? {
              action: {
                label: "Rebuild",
                onClick: () => {
                  if (toggleRef.current) props.onRebuildEngineStore(toggleRef.current);
                },
              },
            }
          : {}),
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

    // Persistent while true: no engine capture means no history recorder
    // exists at all. Never spammy: the flags change only at workspace open,
    // and the cause comes from main's own open-time decision, riding the
    // status the renderer already consumes.
    //
    // A shared view takes no notice at all: at view and comment it gets no
    // recorder by design, a capability, not a failure; at edit it
    // does get one. The share banner already says what the surface is.
    if (props.syncStatus?.historyShareView) {
      // Nothing to warn about.
    } else if (props.syncStatus?.historyRecordingUnavailable) {
      // The recorder could not be built at open. Main builds the
      // recorder once per workspace per app session, so reopening the
      // workspace re-reads nothing; a restart is the step that retries it.
      next.push({
        id: "history-recording-unavailable",
        tone: "warning",
        title: "History is off for this workspace",
        body: "dohc could not start recording history for this workspace. Your files still save normally. Restart dohc to try again.",
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
              onClick: () => {
                if (props.onRestartToUpdate) props.onRestartToUpdate();
                else void installUpdate();
              },
              disabled: installPending,
            }
          : undefined,
        Icon: Download,
      });
    } else if (updateActionError) {
      next.push({
        id: "update-error",
        tone: "danger",
        title: "Update failed",
        body: updateActionError,
        action: { label: "Open Settings", onClick: props.onOpenSettings },
        Icon: AlertTriangle,
      });
    }

    return next;
  }, [
    agentNotifications,
    props.agentActive,
    props.automationFailures,
    props.conflictSummaries,
    props.onDismissAgentNotification,
    props.onDismissAutomationFailure,
    props.workspaceErrors,
    props.onRetryWorkspaceError,
    props.onDismissWorkspaceError,
    props.onOpenConflicts,
    props.onOpenHistory,
    props.onRefreshShareView,
    props.onOpenSettings,
    props.onRebuildEngineStore,
    props.onReviewShareChanges,
    props.shareChangeNotices,
    props.syncStatus,
    liveDelivery,
    liveDeliveryAction,
    liveDeliveryDetails,
    onOpenLiveDocuments,
    refusalsDetails,
    refusalsKey,
    installPending,
    installUpdate,
    updateActionError,
    updateState,
  ]);

  // Set-aside drafts count as one notice: they may belong to paths
  // that no longer exist (a deleted file's tab is gone), so this panel is
  // their always-reachable surface — the list below offers
  // the same Copy/Dismiss the in-document notice does. Scoped to the active
  // workspace.
  const allRecoveryRows = useAllOrphanedDrafts();
  const recoveryRows = useMemo(
    () =>
      allRecoveryRows.filter((row) => row.workspaceId === props.workspaceId),
    [allRecoveryRows, props.workspaceId],
  );
  const count = notices.length + (recoveryRows.length > 0 ? 1 : 0);
  // The newest error whose toast is still open. One at a time: the rest
  // wait in Notices with the count.
  const errorToast = useMemo(
    () =>
      [...(props.workspaceErrors ?? [])]
        .filter((error) => !error.seen)
        .sort((a, b) => b.atMs - a.atMs)[0] ?? null,
    [props.workspaceErrors],
  );
  useEffect(() => {
    if (errorToast?.tone !== "success" || !props.onHideWorkspaceError) return;
    const timer = setTimeout(() => props.onHideWorkspaceError?.(errorToast.id), 6000);
    return () => clearTimeout(timer);
  }, [errorToast?.id, errorToast?.tone, props.onHideWorkspaceError]);

  return (
    <>
      {/* One stack in the window's bottom-right corner: the toasts lay
          themselves out in order instead of counting row heights. Opening
          Notices hides it — every row is in the panel, and a toast must never
          sit over it. */}
      {open ? null : (
        <div data-testid="notice-toasts" className={TOAST_STACK_CLASS[host]}>
          {errorToast ? (
            <div
              data-testid={errorToast.tone === "success" ? "workspace-shell-notice" : "workspace-shell-error"}
              role={errorToast.tone === "success" ? "status" : "alert"}
              className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              {errorToast.tone === "success" ? <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0 text-success" /> : <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />}
              <span className="min-w-0 flex-1 select-text cursor-text break-words leading-snug">
                {errorToast.message}
              </span>
              {errorToast.canRetry && props.onRetryWorkspaceError ? (
                <button
                  type="button"
                  data-testid="workspace-shell-error-retry"
                  onClick={() => props.onRetryWorkspaceError?.(errorToast.id)}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  Try again
                </button>
              ) : null}
              <CopyDetailsButton
                key={errorToast.id}
                iconOnly
                label={errorToast.tone === "success" ? "Copy notice details" : "Copy error details"}
                data-testid="workspace-shell-error-copy"
                details={() => errorToast.details}
              />
              {props.onHideWorkspaceError ? (
                <button
                  type="button"
                  aria-label={errorToast.tone === "success" ? "Dismiss workspace notice" : "Dismiss workspace error"}
                  onClick={() => props.onHideWorkspaceError?.(errorToast.id)}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
                >
                  <X size={12} aria-hidden />
                </button>
              ) : null}
            </div>
          ) : null}
          {liveDeliveryToastVisible && liveDelivery ? (
            <div
              data-testid="owner-live-delivery-toast"
              role="status"
              aria-live="polite"
              className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              <RefreshCw size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 select-text cursor-text break-words leading-snug">
                {liveDelivery.title}. {liveDelivery.body}
              </span>
              {liveDeliveryAction ? (
                <button
                  type="button"
                  data-testid="owner-live-delivery-toast-action"
                  onClick={liveDeliveryAction.onClick}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  {liveDeliveryAction.label}
                </button>
              ) : null}
              <CopyDetailsButton
                key={liveDeliveryKey}
                iconOnly
                label="Copy live editing details"
                data-testid="owner-live-delivery-toast-copy"
                details={() => liveDeliveryDetails}
              />
              <button
                type="button"
                aria-label="Dismiss live editing notice"
                onClick={() => setDismissedLiveDeliveryKey(liveDeliveryKey)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
          {refusalsToastVisible ? (
            <div
              data-testid="owner-live-refusals-toast"
              role="status"
              aria-live="polite"
              className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 select-text cursor-text break-words leading-snug">
                {OWNER_LIVE_REFUSALS_TITLE}. {OWNER_LIVE_REFUSALS_BODY}
              </span>
              {onOpenLiveDocuments ? (
                <button
                  type="button"
                  data-testid="owner-live-refusals-toast-action"
                  onClick={onOpenLiveDocuments}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  Live documents
                </button>
              ) : null}
              <CopyDetailsButton
                key={refusalsKey}
                iconOnly
                label="Copy share details"
                data-testid="owner-live-refusals-toast-copy"
                details={() => refusalsDetails}
              />
              {/* Closing ends the announcement; the row stays in Notices. */}
              <button
                type="button"
                aria-label="Dismiss live editing refusals notice"
                onClick={() => setDismissedRefusalsKey(refusalsKey)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
          {updateToastVisible ? (
            <div
              data-testid="update-toast"
              role="status"
              className="dohc-popover dohc-pop-in relative flex max-w-md items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              <span>{updateActionError ?? updateState?.message}</span>
              {updateState?.canInstall ? (
                <button
                  type="button"
                  disabled={installPending}
                  onClick={() => {
                    if (props.onRestartToUpdate) props.onRestartToUpdate();
                    else void installUpdate();
                  }}
                  className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
                >
                  {installPending ? "Restarting" : "Restart"}
                </button>
              ) : updateActionError ? (
                <button
                  type="button"
                  onClick={props.onOpenSettings}
                  className="shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-semibold text-bg hover:opacity-90"
                >
                  Open Settings
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Dismiss update notice"
                onClick={() => {
                  setUpdateActionError(null);
                  if (readyUpdateKey) {
                    setDismissedUpdateToastKey(readyUpdateKey);
                  }
                }}
                className="grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      )}

      {open ? (
        <div
          ref={centerRef}
          data-testid="notice-center"
          role="dialog"
          aria-label="Notices"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            toggleRef.current?.focus();
          }}
          className={`dohc-popover dohc-pop-in fixed ${PANEL_POSITION_CLASS[host]} z-20 flex max-h-[calc(100vh-100px)] flex-col rounded-lg border border-line bg-panel text-xs text-ink`}
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
            <div className="min-h-0 max-h-80 overflow-y-auto">
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
                            toggleRef.current?.focus({ preventScroll: true });
                            notice.action?.onClick();
                            setOpen(false);
                          }}
                          className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-50"
                        >
                          {notice.action.label}
                        </button>
                      ) : null}
                      {notice.copyText !== undefined ? (
                        <CopyDetailsButton
                          iconOnly
                          label="Copy error details"
                          data-testid={`notice-${notice.id}-copy`}
                          details={() => notice.copyText ?? ""}
                        />
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
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="relative grid size-9 shrink-0 place-items-center rounded-lg text-subtle transition-colors duration-100 hover:bg-line/50 hover:text-ink"
      >
        <Bell size={18} strokeWidth={1.9} aria-hidden />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 h-3 min-w-3 rounded-full bg-ink px-0.5 text-center text-[8px] font-semibold leading-3 text-bg"
          >
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>
    </>
  );
}
