import { useFocusReturn, useFocusSurface } from "../ui/focusReturn";
import { automationReachCopy } from "../automationReachCopy";
import { AlertTriangle, Bell, Bot, Check, CheckCircle2, CloudOff, Download, GitPullRequestArrow, Info, LogIn, MessageSquare, RefreshCw, Sparkles, User, X, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import {
  ENGINE_STORE_BACKUP_DIR,
  ENGINE_STORE_UPDATE_NEXT_STEP,
  engineStoreRefusalRecovery,
  engineStoreRefusalSentence,
  type NoticeRow,
  type SyncStatusResult,
} from "../../ipc/bridgeContract";
import { RELAY_API_VERSION_CAUSE } from "@dohc/workspace-contracts/relay";
import { SectionLabel } from "../ui/controls";
import { useAllOrphanedDrafts } from "../orphanedDrafts";
import { RecoveryList } from "../RecoveryList";
import { requestGuardedUpdateInstall } from "../RecoveryCloseGuard";
import { useDesktopUpdateStateFeed } from "../useDesktopUpdateStateFeed";
import { CopyDetailsButton, errorDetails } from "../shell/copyDetails";
import type { AutomationHoldNotice, AutomationStopNotice } from "../shell/useAutomationHolds";
import { relativeTime } from "../relativeTime";
import { UPDATE_REQUIRED_LABEL } from "./WorkspaceSyncStatus";

export type NoticeAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

export type Notice = {
  // Sync/update notices use a fixed id; agent notices carry their own
  // per-(workspace, run, kind) id.
  id: string;
  tone: "danger" | "warning" | "success" | "neutral";
  title: string;
  body: string;
  actions?: readonly NoticeAction[];
  // Explicit dismissal (0P-C gate fix): rendered as a small X on the notice
  // row. Only notices whose underlying state has a real ack path expose it.
  onDismiss?: () => void;
  // Agent notices carry when they happened; system notices are stateful
  // ("cloud disconnected") and render no time.
  timeMs?: number;
  // A report a person can paste: shown as a copy control on the row.
  copyText?: string;
  copyLabel?: string;
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
  // A step that fixes the cause, such as opening the file it names.
  actionLabel?: string;
  seen: boolean;
}

// The crash report main keeps on this computer. `text` is the whole report,
// what Copy report copies. Send report asks main, which shows the text in
// its own dialog before anything leaves.
export interface CrashReportNotice {
  revision: number;
  title: string;
  body: string;
  text: string;
  atMs: number;
}

// A notice sent to this person, as the shell resolved it on this computer.
export interface SentNotice {
  notice: NoticeRow;
  // The folder that names the notice's Collection, when it comes from
  // another workspace than this one.
  folder: string | null;
  // Open has somewhere to go, or something to say about why it cannot.
  openable: boolean;
}

// Notices about one automation, whose Open goes to the automation.
export const AUTOMATION_NOTICE_KINDS: ReadonlySet<string> = new Set([
  "schedule-skipped", "automation-failed", "automation-switched-off",
]);

// A failed run's notice offers Try again on the computer that ran it, which
// holds the run. Anywhere else its text names that computer instead.
const retriesRun = (notice: NoticeRow): boolean =>
  notice.kind === "automation-failed" && notice.postedHere && Boolean(notice.target?.automation && notice.target.run);

// What Copy puts on the clipboard for a failed run's notice.
const failureDetails = (notice: NoticeRow): string =>
  errorDetails([
    ["Notice", notice.title],
    ["Details", notice.body],
    ["Automation", notice.target?.automation ?? ""],
    ["Run", notice.target?.run ?? ""],
    ["Time", new Date(notice.createdAtMs).toISOString()],
  ]);

// Sent rows show this many at a time.
export const SENT_NOTICE_PAGE = 50;

// How long a toast for something finished or sent stays before it fades.
const FADING_TOAST_MS = 6000;

// The sender's shape: round for a person, a rounded square for an agent,
// and the bare lightning mark for an automation, as in chat. Shape is
// visual only; the screen reader hears who sent it.
const SENDER_NAME = {
  person: "From a person",
  agent: "From an agent",
  automation: "From an automation",
} as const;
function SenderMark(props: { kind: NoticeRow["senderKind"] }) {
  if (props.kind === null) {
    return <Info size={14} aria-hidden className="mt-0.5 shrink-0 text-subtle" />;
  }
  if (props.kind === "automation") {
    return (
      <span className="mt-0.5 shrink-0">
        <Zap size={14} aria-hidden data-sender-shape="zap" className="text-muted" />
        <span className="sr-only">{SENDER_NAME.automation}</span>
      </span>
    );
  }
  const person = props.kind === "person";
  return (
    <span className="mt-0.5 shrink-0">
      <span
        aria-hidden
        data-sender-shape={person ? "round" : "square"}
        className={`grid size-4 place-items-center border ${
          person
            ? "rounded-full border-line bg-panel-2 text-muted"
            : "rounded-md border-agent/50 bg-bg text-agent"
        }`}
      >
        {person ? <User size={10} aria-hidden /> : <Sparkles size={10} aria-hidden />}
      </span>
      <span className="sr-only">{SENDER_NAME[props.kind]}</span>
    </span>
  );
}

// A sent notice as one account's list showed it. Another account's notice
// with the same id has another key.
const sentKey = (account: string | null, { store, noticeId }: NoticeRow): string =>
  JSON.stringify([account, store, noticeId]);

// Arrow keys move between rows; a row is any element marked with this.
const NOTICE_ROW = "[data-notice-row]";
const ROW_CLASS =
  "dohc-pop-in flex gap-2 border-b border-line px-3 py-2 last:border-b-0 focus-visible:-outline-offset-2";

// The one notice for every step a narrower share stopped. It names each
// automation it will dismiss, with its file, and who cannot reach what.
function automationStopsCopy(stops: readonly AutomationStopNotice[]): { title: string; body: string } {
  const automations = new Map<string, { name: string; file: string; reasons: Set<string> }>();
  for (const stop of stops) {
    const entry = automations.get(stop.automationId) ??
      { name: stop.automationName, file: `${stop.collectionPath}/automations.yaml`, reasons: new Set<string>() };
    const who = stop.stoppedFor ?? "Someone you shared with";
    entry.reasons.add(`${who} cannot ${automationReachCopy(stop, true)}.`);
    automations.set(stop.automationId, entry);
  }
  const [only] = automations.values();
  if (automations.size === 1 && only) {
    return {
      title: `Automation "${only.name}" stopped`,
      body: `${[...only.reasons].join(" ")} Open ${only.file} to change the step.`,
    };
  }
  const named = [...automations.values()]
    .map((entry) => `"${entry.name}" in ${entry.file}: ${[...entry.reasons].join(" ")}`);
  return {
    title: `${automations.size} automations stopped`,
    body: `${named.join(" ")} Open each file to change its steps.`,
  };
}

// The notice, and the ⚡ panel, when dohc cannot read which steps were allowed.
export const AUTOMATION_HOLDS_UNREADABLE =
  "dohc cannot read .dohc/automations/reach.json, which records the automation steps you allowed. Reset holds to allow each step again, or open the folder to fix the file.";

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

// The toast for the newest workspace error, or the notice that something
// finished. The states page renders it too, so it is its own piece.
export function WorkspaceErrorToast(props: {
  error: WorkspaceErrorNotice;
  onAction?: (id: string) => void;
  onRetry?: (id: string) => void;
  onHide?: (id: string) => void;
}) {
  const { error } = props;
  return (
    <div
      data-testid={error.tone === "success" ? "workspace-shell-notice" : "workspace-shell-error"}
      role={error.tone === "success" ? "status" : "alert"}
      className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
    >
      {error.tone === "success" ? <CheckCircle2 size={14} aria-hidden className="mt-0.5 shrink-0 text-success" /> : <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />}
      <span className="min-w-0 flex-1 select-text cursor-text break-words leading-snug">
        {error.message}
      </span>
      {error.actionLabel && props.onAction ? (
        <button
          type="button"
          data-testid="workspace-shell-error-action"
          onClick={() => props.onAction?.(error.id)}
          className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          {error.actionLabel}
        </button>
      ) : null}
      {error.canRetry && props.onRetry ? (
        <button
          type="button"
          data-testid="workspace-shell-error-retry"
          onClick={() => props.onRetry?.(error.id)}
          className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          Try again
        </button>
      ) : null}
      <CopyDetailsButton
        key={error.id}
        iconOnly
        label={error.tone === "success" ? "Copy notice details" : "Copy error details"}
        data-testid="workspace-shell-error-copy"
        details={() => error.details}
      />
      {props.onHide ? (
        <button
          type="button"
          aria-label={error.tone === "success" ? "Dismiss workspace notice" : "Dismiss workspace error"}
          onClick={() => props.onHide?.(error.id)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
        >
          <X size={12} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

// One row under "On this computer". The states page renders it too.
export function LocalNoticeRow(props: {
  notice: Notice;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onAction: (action: NoticeAction) => void;
  onDismiss: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { notice } = props;
  return (
    <li
      data-testid={`notice-${notice.id}`}
      data-notice-row=""
      tabIndex={-1}
      onKeyDown={props.onKeyDown}
      className={ROW_CLASS}
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
          {(notice.actions ?? []).map((action, index) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={() => props.onAction(action)}
              className={`${index === 0 ? "ml-auto " : ""}shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50`}
            >
              {action.label}
            </button>
          ))}
          {notice.copyText !== undefined ? (
            <CopyDetailsButton
              iconOnly
              label={notice.copyLabel ?? "Copy error details"}
              data-testid={`notice-${notice.id}-copy`}
              details={() => notice.copyText ?? ""}
            />
          ) : null}
          {notice.onDismiss ? (
            <button
              type="button"
              data-testid={`notice-${notice.id}-dismiss`}
              aria-label="Dismiss notice"
              onClick={props.onDismiss}
              className={`${notice.actions?.length ? "" : "ml-auto "}grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink`}
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
  );
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
  onWorkspaceErrorAction?: (id: string) => void;
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
  // A crash report waiting on this computer. Send report is absent when this
  // build has no report server; main owns the dialog it opens.
  crashReport?: CrashReportNotice | null;
  onSendCrashReport?: () => void;
  onDismissCrashReport?: () => void;
  // Automation steps that reach more now only because an editor left. Each
  // waits for someone who can edit the Collection to allow it.
  automationHolds?: readonly AutomationHoldNotice[];
  onAllowAutomationHold?: (hold: AutomationHoldNotice) => void;
  // dohc could not read which steps were allowed, so every automation waits.
  automationHoldsUnreadable?: boolean;
  onResetAutomationHolds?: () => void;
  onRevealAutomationHolds?: () => void;
  // Notices sent to this person, newest first. They follow this computer's
  // own rows under their own heading.
  sentNotices?: readonly SentNotice[];
  // The newest sent notice that arrived while dohc was open. Its toast
  // fades; the row stays.
  sentNoticeToast?: SentNotice | null;
  onHideSentNoticeToast?: () => void;
  // The first list has not answered yet: the panel shows no "All clear".
  sentNoticesLoading?: boolean;
  // The signed-in account the sent notices belong to.
  sentNoticesAccount?: string | null;
  // Marks the notice read and opens it. Resolves to null once it opened, or
  // to a sentence that says why it could not. Opens nothing once `signal`
  // aborts.
  onOpenSentNotice?: (notice: NoticeRow, signal: AbortSignal) => Promise<string | null>;
  onDismissSentNotice?: (notice: NoticeRow) => void;
  // Run now on a skipped schedule's notice. Resolves to null once the run
  // started here, or to a sentence that says why it did not.
  onRunSentNoticeNow?: (notice: NoticeRow) => Promise<string | null>;
  // Try again on a failed run's notice. The shell asks first when the run
  // would start over, and reports why it did not run.
  onRetrySentNotice?: (notice: NoticeRow) => void;
  onReadAllSentNotices?: () => void;
  // Automation steps a narrower share stopped, shown as one notice until
  // someone dismisses it.
  automationStops?: readonly AutomationStopNotice[];
  onDismissAutomationStops?: (stops: readonly AutomationStopNotice[]) => void;
}) {
  const host: NoticeHostPlacement = props.host ?? "rail";
  const [open, setOpen] = useState(false);
  const centerRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const toastsRef = useRef<HTMLDivElement>(null);
  useFocusReturn(open, centerRef, () => toggleRef.current);
  useFocusSurface(toastsRef, () => toggleRef.current);
  useFocusSurface(centerRef, () => centerRef.current);
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

  const sentNotices = props.sentNotices ?? [];
  const unreadSent = sentNotices.filter(({ notice }) => notice.readAtMs === null).length;
  // Each opening starts at the newest page.
  const [sentShown, setSentShown] = useState(SENT_NOTICE_PAGE);
  // Why a sent notice could not open, shown on its row. Keyed by store and
  // id, and cleared when the panel closes.
  const [sentNotes, setSentNotes] = useState<ReadonlyMap<string, string>>(new Map());
  // The Open on its way, if any. Closing the panel, dismissing that notice,
  // or a newer Open cancels it, so a late answer opens nothing.
  const opening = useRef<{ key: string; controller: AbortController } | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const cancelOpen = useCallback((key?: string) => {
    if (!opening.current || (key !== undefined && opening.current.key !== key)) return;
    opening.current.controller.abort();
    opening.current = null;
    setOpeningKey(null);
  }, []);
  useEffect(() => {
    if (open) return;
    cancelOpen();
    setSentShown(SENT_NOTICE_PAGE);
    setSentNotes(new Map());
  }, [cancelOpen, open]);
  // Another account's list: its Open and its row sentences go with it.
  const sentAccount = props.sentNoticesAccount ?? null;
  useEffect(() => {
    cancelOpen();
    setSentNotes(new Map());
  }, [cancelOpen, sentAccount]);
  // The Run now on its way, by row key: another waits until it answers.
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const { onRunSentNoticeNow } = props;
  const runSentNoticeNow = useCallback(
    async (notice: NoticeRow) => {
      if (!onRunSentNoticeNow) return;
      const key = sentKey(sentAccount, notice);
      setRunningKey(key);
      let note: string | null;
      try {
        note = await onRunSentNoticeNow(notice);
      } catch (error) {
        note = error instanceof Error ? error.message : "The automation did not start.";
      } finally {
        setRunningKey((current) => (current === key ? null : current));
      }
      if (note !== null) setSentNotes((current) => new Map(current).set(key, note));
    },
    [onRunSentNoticeNow, sentAccount],
  );
  const { onOpenSentNotice } = props;
  const openSentNotice = useCallback(
    async (notice: NoticeRow) => {
      if (!onOpenSentNotice) return;
      const key = sentKey(sentAccount, notice);
      // A second Open of the same notice waits for the first.
      if (opening.current?.key === key) return;
      cancelOpen();
      const controller = new AbortController();
      opening.current = { key, controller };
      setOpeningKey(key);
      setSentNotes((current) => {
        if (!current.has(key)) return current;
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      let note: string | null;
      try {
        note = await onOpenSentNotice(notice, controller.signal);
      } finally {
        if (opening.current?.controller === controller) {
          opening.current = null;
          setOpeningKey(null);
        }
      }
      if (controller.signal.aborted) return;
      if (note === null) {
        toggleRef.current?.focus({ preventScroll: true });
        setOpen(false);
        return;
      }
      setOpen(true);
      setSentNotes((current) => new Map(current).set(key, note));
    },
    [cancelOpen, onOpenSentNotice, sentAccount],
  );
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

  // Closing the toast keeps the row. A newer problem is a new revision, so
  // its toast shows again.
  const [closedCrashRevision, setClosedCrashRevision] = useState<number | null>(null);
  const crashReport = props.crashReport ?? null;
  const crashToastVisible =
    crashReport !== null && crashReport.revision !== closedCrashRevision;

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

  const notices = useMemo<Notice[]>(() => {
    const next: Notice[] = [];
    const state = props.syncStatus?.state;
    const conflictCount = props.syncStatus?.conflictCount ?? 0;

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
              actions: [{
                label: "Review",
                onClick: () => props.onReviewShareChanges?.(sent.proposalId),
              }],
            }
          : {}),
        Icon: GitPullRequestArrow,
      });
    }

    if (crashReport) {
      next.push({
        id: "crash-report",
        tone: "danger",
        title: crashReport.title,
        body: crashReport.body,
        ...(props.onSendCrashReport
          ? { action: { label: "Send report", onClick: props.onSendCrashReport } }
          : {}),
        ...(props.onDismissCrashReport ? { onDismiss: props.onDismissCrashReport } : {}),
        timeMs: crashReport.atMs,
        copyText: crashReport.text,
        copyLabel: "Copy report",
        Icon: AlertTriangle,
      });
    }

    // Automation failures: durable until dismissed, like the share-refusal
    // banner. Dismissing acknowledges the generation on screen; a failure
    // recorded after this render has a higher generation and comes back.
    for (const error of [...(props.workspaceErrors ?? [])].reverse().sort(
      (a, b) => b.atMs - a.atMs,
    )) {
      next.push({
        id: error.id,
        tone: error.tone ?? "danger",
        title: error.message,
        body: "",
        actions: [
          ...(error.actionLabel && props.onWorkspaceErrorAction
            ? [{
                label: error.actionLabel,
                onClick: () => props.onWorkspaceErrorAction?.(error.id),
              }]
            : []),
          ...(error.canRetry && props.onRetryWorkspaceError
            ? [{
                label: "Try again",
                onClick: () => props.onRetryWorkspaceError?.(error.id),
              }]
            : []),
        ],
        ...(props.onDismissWorkspaceError
          ? { onDismiss: () => props.onDismissWorkspaceError?.(error.id) }
          : {}),
        timeMs: error.atMs,
        copyText: error.details,
        Icon: error.tone === "success" ? CheckCircle2 : AlertTriangle,
      });
    }
    if (props.automationHoldsUnreadable) {
      next.push({
        id: "automation-holds-unreadable",
        tone: "warning",
        title: "Automations are waiting",
        body: AUTOMATION_HOLDS_UNREADABLE,
        Icon: AlertTriangle,
        actions: [
          ...(props.onResetAutomationHolds ? [{ label: "Reset holds", onClick: props.onResetAutomationHolds }] : []),
          ...(props.onRevealAutomationHolds ? [{ label: "Open folder", onClick: props.onRevealAutomationHolds }] : []),
        ],
      });
    }
    for (const hold of props.automationHolds ?? []) {
      const reach = automationReachCopy(hold);
      next.push({
        id: `automation-hold-${hold.automationId}-${hold.step}${hold.recipient ? `-${hold.recipient}` : ""}`,
        tone: "warning",
        title: `Automation "${hold.automationName}" is waiting`,
        body: hold.stoppedFor
          ? `A step in ${hold.collection} can now ${reach}. It stopped before because ${hold.stoppedFor} could not. Allow it to run?`
          : hold.fileUnread
            ? `A step in ${hold.collection} can ${reach}. dohc cannot read ${hold.collection}'s automations file in one version of the workspace. New steps there wait for you. Allow it to run?`
            : `A step in ${hold.collection} can ${reach}. Allow it to run?`,
        Icon: AlertTriangle,
        ...(props.onAllowAutomationHold
          ? { actions: [{ label: "Allow", onClick: () => props.onAllowAutomationHold?.(hold) }] }
          : {}),
      });
    }
    const stops = props.automationStops ?? [];
    if (stops.length > 0) {
      next.push({
        id: "automation-stops",
        tone: "warning",
        ...automationStopsCopy(stops),
        Icon: AlertTriangle,
        ...(props.onDismissAutomationStops
          ? { onDismiss: () => props.onDismissAutomationStops?.(stops) }
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
        ...(liveDeliveryAction ? { actions: [liveDeliveryAction] } : {}),
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
          ? { actions: [{ label: "Live documents", onClick: onOpenLiveDocuments }] }
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
        actions: [{ label: "Refresh", onClick: props.onRefreshShareView }],
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
        actions: [{ label: "Review", onClick: props.onOpenConflicts }],
        Icon: AlertTriangle,
      });
    } else if (props.syncStatus?.updateRequired) {
      const update = props.syncStatus.updateRequired;
      next.push({
        id: "relay-update-required",
        tone: "warning",
        title: UPDATE_REQUIRED_LABEL[update],
        body: `${RELAY_API_VERSION_CAUSE[update]} ${
          update === "app"
            ? "Update dohc to sync again."
            : "Ask the person who runs it to update it. Then restart dohc."
        } Your changes stay on this computer.`,
        Icon: CloudOff,
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
              actions: [{
                label: "Rebuild",
                onClick: () => {
                  if (toggleRef.current) props.onRebuildEngineStore(toggleRef.current);
                },
              }],
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
        actions: [{ label: "Open History", onClick: props.onOpenHistory }],
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

    if (props.agentActive) {
      next.push({
        id: "agent-active",
        tone: "success",
        title: "Agent running",
        body: "Workspace changes from this run will be attributed in history.",
        actions: [{ label: "Open History", onClick: props.onOpenHistory }],
        Icon: Bot,
      });
    }

    if (updateState?.status === "ready") {
      next.push({
        id: "update-ready",
        tone: "neutral",
        title: "Update ready",
        body: updateActionError ?? updateState.message,
        ...(updateState.canInstall
          ? {
              actions: [{
                label: installPending ? "Restarting" : "Restart",
                onClick: () => {
                  if (props.onRestartToUpdate) props.onRestartToUpdate();
                  else void installUpdate();
                },
                disabled: installPending,
              }],
            }
          : {}),
        Icon: Download,
      });
    } else if (updateActionError) {
      next.push({
        id: "update-error",
        tone: "danger",
        title: "Update failed",
        body: updateActionError,
        actions: [{ label: "Open Settings", onClick: props.onOpenSettings }],
        Icon: AlertTriangle,
      });
    }

    return next;
  }, [
    crashReport,
    props.onSendCrashReport,
    props.onDismissCrashReport,
    props.agentActive,
    props.automationHolds,
    props.onAllowAutomationHold,
    props.automationHoldsUnreadable,
    props.onResetAutomationHolds,
    props.onRevealAutomationHolds,
    props.automationStops,
    props.onDismissAutomationStops,
    props.conflictSummaries,
    props.workspaceErrors,
    props.onRetryWorkspaceError,
    props.onWorkspaceErrorAction,
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
  // This computer's rows count while they stand; sent rows while unread.
  const localCount = notices.length + (recoveryRows.length > 0 ? 1 : 0);
  const count = localCount + unreadSent;
  // The newest error whose toast is still open. One at a time: the rest
  // wait in Notices with the count. The list is in arrival order, so two
  // messages in the same millisecond show the later one.
  const errorToast = useMemo(
    () =>
      [...(props.workspaceErrors ?? [])]
        .filter((error) => !error.seen)
        .reverse()
        .sort((a, b) => b.atMs - a.atMs)[0] ?? null,
    [props.workspaceErrors],
  );
  useEffect(() => {
    if (errorToast?.tone !== "success" || !props.onHideWorkspaceError) return;
    const timer = setTimeout(() => props.onHideWorkspaceError?.(errorToast.id), FADING_TOAST_MS);
    return () => clearTimeout(timer);
  }, [errorToast?.id, errorToast?.tone, props.onHideWorkspaceError]);
  const sentToast = props.sentNoticeToast ?? null;
  const sentToastKey = sentToast ? sentKey(sentAccount, sentToast.notice) : null;
  const { onHideSentNoticeToast } = props;
  // A failure's toast stays until it is closed; any other fades.
  const sentToastFades = sentToast !== null && sentToast.notice.kind !== "automation-failed";
  useEffect(() => {
    if (sentToastKey === null || !sentToastFades || !onHideSentNoticeToast) return;
    const timer = setTimeout(onHideSentNoticeToast, FADING_TOAST_MS);
    return () => clearTimeout(timer);
  }, [sentToastKey, sentToastFades, onHideSentNoticeToast]);

  // A row about to go takes focus to the next row, or the one before, or
  // the panel, so the keyboard keeps its place in the list.
  const focusPastRow = (element: Element) => {
    const row = element.closest<HTMLElement>(NOTICE_ROW);
    const rows = [...(centerRef.current?.querySelectorAll<HTMLElement>(NOTICE_ROW) ?? [])];
    const index = row ? rows.indexOf(row) : -1;
    (rows[index + 1] ?? rows[index - 1] ?? centerRef.current)?.focus();
  };
  // Rows answer Enter and Delete while they hold focus themselves, not a
  // control inside them.
  const rowKeys = (actions: { open?: () => void; dismiss?: () => void }) =>
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" && actions.open) {
        event.preventDefault();
        actions.open();
      } else if ((event.key === "Delete" || event.key === "Backspace") && actions.dismiss) {
        event.preventDefault();
        focusPastRow(event.currentTarget);
        actions.dismiss();
      }
    };
  const moveBetweenRows = (event: KeyboardEvent<HTMLElement>) => {
    const rows = [...(centerRef.current?.querySelectorAll<HTMLElement>(NOTICE_ROW) ?? [])];
    if (rows.length === 0) return;
    const current = document.activeElement?.closest<HTMLElement>(NOTICE_ROW) ?? null;
    const index = current ? rows.indexOf(current) : -1;
    const next = event.key === "ArrowDown"
      ? rows[Math.min(index + 1, rows.length - 1)]
      : rows[index < 0 ? rows.length - 1 : Math.max(index - 1, 0)];
    event.preventDefault();
    next?.focus();
  };
  const runLocalAction = (action: NoticeAction) => {
    toggleRef.current?.focus({ preventScroll: true });
    action.onClick();
    setOpen(false);
  };
  // Enter on a row runs its first action that can run, as that button would.
  const firstAction = (notice: Notice) => {
    const action = notice.actions?.find((candidate) => !candidate.disabled);
    return action ? () => runLocalAction(action) : undefined;
  };
  const sentShownRows = sentNotices.slice(0, sentShown);
  const sentHidden = sentNotices.length - sentShownRows.length;

  return (
    <>
      {/* One stack in the window's bottom-right corner: the toasts lay
          themselves out in order instead of counting row heights. Opening
          Notices hides it — every row is in the panel, and a toast must never
          sit over it. */}
      {open ? null : (
        <div ref={toastsRef} data-testid="notice-toasts" className={TOAST_STACK_CLASS[host]}>
          {errorToast ? (
            <WorkspaceErrorToast
              error={errorToast}
              onAction={props.onWorkspaceErrorAction}
              onRetry={props.onRetryWorkspaceError}
              onHide={props.onHideWorkspaceError}
            />
          ) : null}
          {sentToast ? (
            <div
              data-testid="sent-notice-toast"
              role={sentToastFades ? "status" : "alert"}
              className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              <SenderMark kind={sentToast.notice.senderKind} />
              <span className="min-w-0 flex-1 break-words leading-snug">
                {sentToast.notice.title}
              </span>
              {retriesRun(sentToast.notice) && props.onRetrySentNotice ? (
                <button
                  type="button"
                  data-testid="sent-notice-toast-retry"
                  onClick={() => {
                    onHideSentNoticeToast?.();
                    props.onRetrySentNotice?.(sentToast.notice);
                  }}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Try again
                </button>
              ) : null}
              {sentToast.notice.kind === "automation-failed" ? (
                <CopyDetailsButton
                  key={sentToastKey}
                  iconOnly
                  label="Copy error details"
                  data-testid="sent-notice-toast-copy"
                  details={() => failureDetails(sentToast.notice)}
                />
              ) : null}
              {sentToast.openable && props.onOpenSentNotice ? (
                <button
                  type="button"
                  data-testid="sent-notice-toast-open"
                  onClick={() => {
                    onHideSentNoticeToast?.();
                    void openSentNotice(sentToast.notice);
                  }}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Open
                </button>
              ) : null}
              {onHideSentNoticeToast ? (
                <button
                  type="button"
                  aria-label="Close"
                  onClick={onHideSentNoticeToast}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
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
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
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
                className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
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
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
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
                className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
          {crashToastVisible && crashReport ? (
            <div
              data-testid="crash-report-toast"
              role="alert"
              className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 select-text cursor-text break-words leading-snug">
                {crashReport.title}
              </span>
              {props.onSendCrashReport ? (
                <button
                  type="button"
                  data-testid="crash-report-toast-send"
                  onClick={props.onSendCrashReport}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Send report
                </button>
              ) : null}
              <CopyDetailsButton
                key={crashReport.revision}
                iconOnly
                label="Copy report"
                data-testid="crash-report-toast-copy"
                details={() => crashReport.text}
              />
              {/* Closing ends the announcement; the row stays in Notices. */}
              <button
                type="button"
                aria-label="Close crash report notice"
                onClick={() => setClosedCrashRevision(crashReport.revision)}
                className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
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
                className="grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
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
          data-focus-surface="notices"
          data-testid="notice-center"
          role="dialog"
          aria-label="Notices"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              moveBetweenRows(event);
              return;
            }
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
          className={`dohc-popover dohc-pop-in fixed ${PANEL_POSITION_CLASS[host]} z-20 flex max-h-[calc(100vh-100px)] flex-col rounded-lg border border-line bg-panel text-xs text-ink`}
        >
          <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <Bell size={13} aria-hidden className="text-subtle" />
            <span className="font-semibold uppercase tracking-wide text-muted">
              Notices
            </span>
            {unreadSent > 0 && props.onReadAllSentNotices ? (
              <button
                type="button"
                data-testid="notice-center-read-all"
                onClick={() => {
                  centerRef.current?.focus();
                  props.onReadAllSentNotices?.();
                }}
                className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                Mark all read
              </button>
            ) : null}
            {count > 0 ? (
              <span
                data-testid="notice-center-count"
                className={`${unreadSent > 0 && props.onReadAllSentNotices ? "" : "ml-auto "}rounded-full border border-line bg-panel-2 px-1.5 text-[10px] font-medium leading-4 text-muted`}
              >
                {count}
              </span>
            ) : null}
          </header>
          {localCount === 0 && sentNotices.length === 0 ? (
            // Nothing to say until the first list of sent notices answers.
            props.sentNoticesLoading ? null : (
              <div className="flex h-20 items-center justify-center gap-2 px-3 text-subtle">
                <Check size={14} aria-hidden />
                All clear
              </div>
            )
          ) : (
            <div className="min-h-0 max-h-80 overflow-y-auto">
              {localCount > 0 ? (
                <section data-testid="notice-group-local">
                  <SectionLabel as="h3" className="m-0 px-3 pb-1 pt-2">
                    On this computer
                  </SectionLabel>
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
                <LocalNoticeRow
                  key={notice.id}
                  notice={notice}
                  onKeyDown={rowKeys({
                    open: firstAction(notice),
                    dismiss: notice.onDismiss,
                  })}
                  onAction={runLocalAction}
                  onDismiss={(event) => {
                    focusPastRow(event.currentTarget);
                    notice.onDismiss?.();
                  }}
                />
              ))}
            </ul>
                </section>
              ) : null}
              {sentNotices.length > 0 ? (
                <section
                  data-testid="notice-group-sent"
                  className={localCount > 0 ? "border-t border-line" : undefined}
                >
                  <SectionLabel as="h3" className="m-0 px-3 pb-1 pt-2">
                    Sent to you
                  </SectionLabel>
                  <ul className="m-0 list-none p-0">
                    {sentShownRows.map(({ notice, folder, openable }) => {
                      const key = sentKey(sentAccount, notice);
                      const unread = notice.readAtMs === null;
                      const note = sentNotes.get(key);
                      const busy = openingKey === key;
                      const openNotice = openable && props.onOpenSentNotice
                        ? () => void openSentNotice(notice)
                        : undefined;
                      const runNow = notice.kind === "schedule-skipped" && props.onRunSentNoticeNow
                        ? () => void runSentNoticeNow(notice)
                        : undefined;
                      const retry = retriesRun(notice) && props.onRetrySentNotice
                        ? () => props.onRetrySentNotice?.(notice)
                        : undefined;
                      const copies = notice.kind === "automation-failed";
                      const running = runningKey === key;
                      const dismissNotice = props.onDismissSentNotice
                        ? () => {
                            cancelOpen(key);
                            props.onDismissSentNotice?.(notice);
                          }
                        : undefined;
                      return (
                        <li
                          key={key}
                          data-testid={`sent-notice-${notice.noticeId}`}
                          data-notice-row=""
                          tabIndex={-1}
                          onKeyDown={rowKeys({ open: openNotice, dismiss: dismissNotice })}
                          className={ROW_CLASS}
                        >
                          <SenderMark kind={notice.senderKind} />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span
                                title={notice.title}
                                className={`truncate text-[12px] ${unread ? "font-medium text-ink" : "text-muted"}`}
                              >
                                {notice.title}
                              </span>
                              {unread ? (
                                <span data-testid={`sent-notice-${notice.noticeId}-unread`} className="shrink-0">
                                  <span aria-hidden className="block size-1.5 rounded-full bg-accent" />
                                  <span className="sr-only">Unread</span>
                                </span>
                              ) : null}
                              {runNow ? (
                                <button
                                  type="button"
                                  data-testid={`sent-notice-${notice.noticeId}-run-now`}
                                  aria-busy={running || undefined}
                                  disabled={runningKey !== null}
                                  onClick={runNow}
                                  className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                                >
                                  {running ? "Starting…" : "Run now"}
                                </button>
                              ) : null}
                              {retry ? (
                                <button
                                  type="button"
                                  data-testid={`sent-notice-${notice.noticeId}-retry`}
                                  onClick={retry}
                                  className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
                                >
                                  Try again
                                </button>
                              ) : null}

                              {openNotice ? (
                                <button
                                  type="button"
                                  data-testid={`sent-notice-${notice.noticeId}-open`}
                                  aria-busy={busy || undefined}
                                  onClick={openNotice}
                                  className={`${runNow || retry ? "" : "ml-auto "}shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink aria-busy:opacity-50`}
                                >
                                  {busy ? "Opening…" : AUTOMATION_NOTICE_KINDS.has(notice.kind) ? "Open automation" : "Open"}
                                </button>
                              ) : null}
                              {copies ? (
                                <span className={`${openNotice || runNow || retry ? "" : "ml-auto "}flex shrink-0`}>
                                  <CopyDetailsButton
                                    iconOnly
                                    label="Copy error details"
                                    data-testid={`sent-notice-${notice.noticeId}-copy`}
                                    details={() => failureDetails(notice)}
                                  />
                                </span>
                              ) : null}
                              {dismissNotice ? (
                                <button
                                  type="button"
                                  data-testid={`sent-notice-${notice.noticeId}-dismiss`}
                                  aria-label="Dismiss notice"
                                  onClick={(event) => {
                                    focusPastRow(event.currentTarget);
                                    dismissNotice();
                                  }}
                                  className={`${openNotice || runNow || retry || copies ? "" : "ml-auto "}grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink`}
                                >
                                  <X size={11} aria-hidden />
                                </button>
                              ) : null}
                            </div>
                            {notice.body ? (
                              <p className="m-0 mt-0.5 line-clamp-3 text-[11px] leading-snug text-muted">
                                {notice.body}
                              </p>
                            ) : null}
                            <p className="m-0 mt-1 flex min-w-0 gap-2 font-mono text-[10px] text-subtle">
                              <time dateTime={new Date(notice.createdAtMs).toISOString()}>
                                {relativeTime(notice.createdAtMs)}
                              </time>
                              {folder ? <span className="truncate">{folder}</span> : null}
                            </p>
                            {note ? (
                              <p role="status" className="m-0 mt-1 text-[11px] leading-snug text-ink">
                                {note}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {sentHidden > 0 ? (
                    <button
                      type="button"
                      data-testid="sent-notices-more"
                      onClick={() => setSentShown((shown) => shown + SENT_NOTICE_PAGE)}
                      className="w-full border-t border-line px-3 py-2 text-left text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
                    >
                      Show {Math.min(SENT_NOTICE_PAGE, sentHidden)} more
                    </button>
                  ) : null}
                </section>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      <button
        ref={toggleRef}
        type="button"
        data-testid="notice-center-toggle"
        aria-label={count > 0 ? `Notices, ${count} unread` : "Notices"}
        title="Notices"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="relative grid size-9 shrink-0 place-items-center rounded-lg text-subtle transition-colors duration-100 hover:bg-hover hover:text-ink"
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
