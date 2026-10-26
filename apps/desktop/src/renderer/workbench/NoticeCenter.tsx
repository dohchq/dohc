import { useFocusReturn, useFocusSurface } from "../ui/focusReturn";
import { modalReturnTarget } from "../modalFocus";
import { createPortal } from "react-dom";
import { automationReachCopy } from "../automationReachCopy";
import { AlertTriangle, Bell, Bot, Check, CheckCircle2, ChevronDown, CloudOff, Download, GitPullRequestArrow, Info, LogIn, MessageSquare, RefreshCw, Sparkles, User, X, Zap } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
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
import { errorDetails } from "../shell/copyDetails";
import { CopyButton } from "../ui/CopyButton";
import type { AutomationHoldNotice, AutomationStopNotice } from "../shell/useAutomationHolds";
import { relativeTime } from "../relativeTime";
import { UPDATE_REQUIRED_LABEL, titleBarNamesServer } from "./WorkspaceSyncStatus";

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
  // A line after the body that no clamp hides, such as how many more
  // files a list leaves out.
  lastLine?: string;
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
  filePaths?: readonly string[];
  // A terminal command the body asks the person to run, shown with its copy.
  command?: string;
  // Closes the notice's toast once its row is read. The row stays.
  onRead?: () => void;
  Icon: typeof Bell;
};

// A workspace error the shell reported. `details` is the report Copy puts
// on the clipboard; `seen` means its toast was closed and only the row in
// Notices remains.
export interface WorkspaceErrorNotice {
  copyLabel?: string;
  // Omitted for a failure. A warning needs the person, though nothing failed.
  tone?: "success" | "warning";
  // A success toast that stays until it is closed, rather than fading.
  stays?: boolean;
  id: string;
  title?: string;
  message: string;
  lastLine?: string;
  details: string;
  filePaths?: readonly string[];
  atMs: number;
  canRetry: boolean;
  // A step that fixes the cause, such as opening the file it names.
  actionLabel?: string;
  additionalActionLabels?: string[];
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
  // A failed run on the owner's self-hosted server, in this workspace: Try
  // again runs it there.
  retryable: boolean;
}

// Notices about one automation, whose Open goes to the automation.
export const AUTOMATION_NOTICE_KINDS: ReadonlySet<string> = new Set([
  "schedule-skipped", "automation-failed", "automation-switched-off",
]);

// A failed run's notice offers Try again on the computer that ran it, which
// holds the run. Anywhere else its text names that computer instead.
const retriesRun = (notice: NoticeRow): boolean =>
  notice.kind === "automation-failed" && notice.postedHere && Boolean(notice.target?.automation && notice.target.run);

// A failed automation run, or an agent run that says why it didn't start. Its
// toast shows the body and stays until closed, and Copy sits beside its text.
const isFailure = (notice: NoticeRow): boolean =>
  notice.kind === "automation-failed" || (notice.kind === "agent-run" && notice.body !== "");

// What Copy puts on the clipboard for a failed run's notice. The notice store
// already bounds the body, so Copy keeps all of the text the person sees.
const failureDetails = (notice: NoticeRow): string =>
  errorDetails([
    ["Notice", notice.title],
    ["Details", notice.body, Number.POSITIVE_INFINITY],
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
// A toast sets the mark on its text's first line; a row passes its own place.
function SenderMark(props: { kind: NoticeRow["senderKind"]; className?: string }) {
  const place = props.className ?? "mt-0.5 shrink-0";
  if (props.kind === null) {
    return <Info size={14} aria-hidden className={`${place} text-subtle`} />;
  }
  if (props.kind === "automation") {
    return (
      <span className={place}>
        <Zap size={14} aria-hidden data-sender-shape="zap" className="block text-muted" />
        <span className="sr-only">{SENDER_NAME.automation}</span>
      </span>
    );
  }
  const person = props.kind === "person";
  return (
    <span className={place}>
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
// A row's first line is as tall as its tallest control, so a title that
// wraps leaves its controls where they were.
const ROW_CONTROLS_CLASS = "ml-auto flex h-6 shrink-0 items-center gap-2";

// A row counts as read once the pointer or keyboard focus rests on it this
// long: longer than crossing a row on the way to another, about when a
// tooltip would show.
const READ_REST_MS = 600;

type RestSource = "pointer" | "focus";
type RestHandlers = Pick<HTMLAttributes<HTMLElement>, "onPointerEnter" | "onPointerLeave" | "onFocus" | "onBlur">;

// A read row of this computer's is remembered by what it says, so one whose
// words or time change is unread again.
const localReadKey = (workspaceId: string, notice: Notice): string =>
  JSON.stringify([workspaceId, notice.id, notice.timeMs ?? null, notice.title, notice.body]);

// Every row keeps this column at its left edge, so unread rows line up and a
// row that turns read does not move.
function UnreadMark(props: { unread: boolean; testId: string; className?: string }) {
  return (
    <span className={`-ml-1.5 flex w-1.5 shrink-0 items-center ${props.className ?? "h-6"}`}>
      {props.unread ? (
        <span data-testid={props.testId} className="block size-1.5 rounded-full bg-accent">
          <span className="sr-only">Unread</span>
        </span>
      ) : null}
    </span>
  );
}

// A notice's title and text, in its row or its toast, clipped to fit. A
// click on clipped text, or Show more, shows all of it in place, wrapped
// and selectable. A body with one fact per line shows its first 3 facts
// whole, so none is cut in half; prose clamps at 3 lines.
function NoticeText(props: {
  title: string;
  // The title's weight and color.
  titleClass: string;
  body: string;
  // Off for a body that is already shown whole.
  clamp?: boolean;
  // A last line shown with the whole body, such as how many more files a
  // list leaves out.
  after?: string;
  onOpenChange?: (open: boolean) => void;
  testId: string;
  children: (text: { title: ReactNode; body: ReactNode }) => ReactNode;
}) {
  const id = useId();
  const titleRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const clamp = props.clamp ?? true;
  const facts = props.body.split("\n");
  const byFacts = clamp && facts.length > 1;
  const { onOpenChange } = props;
  const show = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  useLayoutEffect(() => {
    if (open) return;
    const title = titleRef.current;
    const body = bodyRef.current;
    // A pixel of slack: rounding alone can make fitting text look a pixel over.
    // Hidden text has no height, so it keeps what it last showed.
    const measure = () => {
      if (title?.clientHeight === 0) return;
      setClipped(
        (title !== null && title.scrollHeight > title.clientHeight + 1) ||
        (clamp && !byFacts && body !== null && body.scrollHeight > body.clientHeight + 1),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (title) observer.observe(title);
    if (body) observer.observe(body);
    return () => observer.disconnect();
  }, [open, clamp, byFacts, props.title, props.body]);
  const hidden = clipped || (byFacts && facts.length > 3);
  // A click that ends a selection, or the second of a double click, opens nothing.
  const openOnClick = hidden && !open
    ? (event: MouseEvent<HTMLElement>) => {
        if (event.detail > 1 || window.getSelection()?.isCollapsed === false) return;
        show(true);
      }
    : undefined;
  const pointer = open ? " cursor-text" : openOnClick ? " cursor-pointer" : "";
  return props.children({
    title: (
      <span
        ref={titleRef}
        id={`${id}-title`}
        title={props.title}
        onClick={openOnClick}
        className={`min-w-0 my-1 whitespace-pre-line wrap-anywhere text-[12px] leading-4 ${props.titleClass}${open ? "" : " line-clamp-2"}${pointer}`}
      >
        {props.title}
      </span>
    ),
    body: (
      <>
        {props.body ? (
          <p
            ref={bodyRef}
            id={`${id}-body`}
            onClick={openOnClick}
            className={`m-0 mt-0.5 whitespace-pre-line wrap-anywhere text-[11px] leading-snug text-muted${clamp && !byFacts && !open ? " line-clamp-3" : ""}${pointer}`}
          >
            {byFacts && !open ? facts.slice(0, 3).join("\n") : props.body}
          </p>
        ) : null}
        {props.after && (open || !hidden) ? (
          <p className="m-0 mt-0.5 whitespace-pre-line wrap-anywhere text-[11px] leading-snug text-muted">{props.after}</p>
        ) : null}
        {hidden || open ? (
          <button
            type="button"
            data-testid={`${props.testId}-more`}
            aria-expanded={open}
            aria-controls={props.body ? `${id}-title ${id}-body` : `${id}-title`}
            onClick={() => show(!open)}
            className="-ml-1 mt-0.5 flex items-center gap-0.5 rounded-md px-1 text-[11px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
          >
            {open ? "Show less" : "Show more"}
            <ChevronDown size={12} strokeWidth={1.9} aria-hidden className={`transition-transform duration-150 ease-out${open ? " rotate-180" : ""}`} />
          </button>
        ) : null}
      </>
    ),
  });
}

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
  "dohc cannot read .dohc/local/automations/reach.json, which records the automation steps you allowed. Reset holds to allow each step again, or open the folder to fix the file.";

// Owner live delivery, and only while it is retrying: what stopped, and the
// way forward. A stable reason is not a connection the engine can dial
// again, so it never offers Try again — resuming a document there would
// rebind an identity the user has not asked for. The transient case is the
// only one the retry command can help.
type LiveDeliveryRecovery = "retry" | "live-documents" | "restart";
function liveDeliveryCopy(
  reason: SyncStatusResult["ownerLiveDeliveryReason"],
): { title: string; body: string; recovery: LiveDeliveryRecovery; Icon: typeof Bell } {
  if (reason === "document-unavailable") {
    return {
      title: "Live editing paused",
      body: "A document this workspace was editing live is no longer available. Open Live documents to review it.",
      recovery: "live-documents",
      Icon: RefreshCw,
    };
  }
  if (reason === "workspace-changed") {
    return {
      title: "Live editing paused",
      body: "This workspace changed while live editing was running. Open Live documents to review affected documents.",
      recovery: "live-documents",
      Icon: RefreshCw,
    };
  }
  // Resume in Live documents is the owner's Try again for this document.
  // Nothing retries until then, so it shows the warning, not the retry mark.
  if (reason === "session-host-refused") {
    return {
      title: "Live editing stopped",
      body: "The server stopped live editing for a document in this workspace. Your copy and its history are unchanged. People you shared it with can't edit it live for now. Open Live documents to try again.",
      recovery: "live-documents",
      Icon: AlertTriangle,
    };
  }
  // Nothing the owner does in dohc continues a server copy that diverged, so
  // nothing offers a Resume. Live documents shows which documents it stopped.
  if (reason === "session-host-diverged") {
    return {
      title: "Live editing stopped",
      body: "The server stopped live editing because its copy of this workspace no longer matches the synced one. Edits people made live may not have reached your files. People you shared its documents with can't edit them live. Contact the server's operator.",
      recovery: "live-documents",
      Icon: AlertTriangle,
    };
  }
  // A Resume alone fails again: the server can start only a document that
  // dohc has opened once, so the owner's first step is to open it.
  if (reason === "live-document-without-lineage") {
    return {
      title: "Live editing can't start",
      body: "The server can't start live editing for a document in this workspace until you open it once in dohc. Open Live documents to see which document. After you open it, resume live editing there.",
      recovery: "live-documents",
      Icon: AlertTriangle,
    };
  }
  // The server's copy misses an edit made while live editing was off, and
  // nothing the owner does in dohc fixes that yet, so nothing offers a Resume.
  if (reason === "live-edit-unadmitted") {
    return {
      title: "Live editing can't resume",
      body: "A document in this workspace changed while live editing was off, so the server can't resume live editing for it. You can keep editing it in dohc. People you shared it with can't edit it live. Open Live documents to see which document.",
      recovery: "live-documents",
      Icon: AlertTriangle,
    };
  }
  if (reason === "restart-required") {
    return {
      title: "Live editing paused",
      body: "Restart dohc to enable live editing. Your edits are saved on this device.",
      recovery: "restart",
      Icon: RefreshCw,
    };
  }
  return {
    title: "Live editing retrying",
    body: "Your edits are saved on this device.",
    recovery: "retry",
    Icon: RefreshCw,
  };
}

// A retry dohc is still fixing by itself toasts and adds a row only once its
// ring has shown in the title bar this long.
const QUIET_RETRY_MS = 15_000;

// Whether `key` has stayed the same, and not null, for `ms`. A key that
// changes or clears starts the wait again.
function useLasted(key: string | null, ms: number): boolean {
  const [lasted, setLasted] = useState<string | null>(null);
  if (lasted !== null && lasted !== key) setLasted(null);
  useEffect(() => {
    if (key === null || ms === 0) return;
    const timer = setTimeout(() => setLasted(key), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && (ms === 0 || lasted === key);
}

// Owner live enrollment refusals: one workspace fact, however many shares it
// covers. Only the list can name them, so the notice sends the user there.
const OWNER_LIVE_REFUSALS_TITLE = "Some shares could not start live editing";
const OWNER_LIVE_REFUSALS_BODY =
  "Open Live documents to see which files are affected and try again.";

// An oversized unclaimed lineage shares its latest saved file at each push,
// never its live edits. An open copy elsewhere takes it only after closing.
type SharingDeclined = NonNullable<SyncStatusResult["sharingDeclined"]>[number];
const SHARING_DECLINED_TITLE = "Too large to edit live with others";
function sharingDeclinedBody(declined: SharingDeclined): string {
  const fileName = declined.path.split("/").pop() ?? declined.path;
  return `People you share ${fileName} with get your saved edits when dohc syncs. If they have it open in dohc, they see your edits after they close it. Close ${fileName} and open it again to fix this.`;
}
function sharingDeclinedDetails(workspaceId: string, declined: SharingDeclined): string {
  return errorDetails([
    ["Notice", SHARING_DECLINED_TITLE],
    ["Detail", sharingDeclinedBody(declined)],
    ["File", declined.path],
    ["Size", `${declined.observedBytes} bytes`],
    ["Limit", `${declined.limitBytes} bytes`],
    ["Constraint", declined.constraint],
    ["Object id", declined.objectId],
    ["Version id", declined.versionId],
    ["Saved file sha256", declined.headBlobSha256],
    ["Workspace id", workspaceId],
  ]);
}
// One refusal of one saved file: a rename keeps it, and a refusal after a new
// save is announced again. The head is null only before the first save.
const sharingDeclinedKey = (workspaceId: string, declined: SharingDeclined): string =>
  JSON.stringify([workspaceId, declined.objectId, declined.versionId, declined.headBlobSha256]);

// Corner hosts need room above the bell; rail hosts use the bottom-right corner.
export type NoticeHostPlacement = "rail" | "corner";

function inToastLayer(host: NoticeHostPlacement, stack: ReactElement): ReactNode {
  return host === "corner" ? createPortal(stack, document.body) : stack;
}

// Toasts sit above every dialog and its scrim (z-30, warning z-50), so a
// failure in a dialog is seen where it happens. A dialog keeps its actions
// clear of them with scroll room (Overlay), and F6 reaches them from the
// dialog's focus trap (modalFocus). Their rows stay in Notices.
const TOAST_STACK_CLASS: Record<NoticeHostPlacement, string> = {
  rail: "fixed bottom-3 right-3 z-60 flex flex-col items-end gap-2",
  // The corner toggle is 36px tall on an 8px inset; 56px clears it with a gap.
  corner: "fixed bottom-14 right-3 z-60 flex flex-col items-end gap-2",
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
  onAction?: (id: string, index?: number) => void;
  onRetry?: (id: string) => void;
  onHide?: (id: string) => void;
}) {
  const { error, onHide } = props;
  // A success or a warning is a notice: nothing failed.
  const notice = error.tone !== undefined;
  // A toast for something finished fades, but not while the person reads it.
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [open, setOpen] = useState(false);
  const fades = error.tone === "success" && !error.stays;
  const held = pointer || focus || open;
  useEffect(() => {
    if (!fades || held || !onHide) return;
    const timer = setTimeout(() => onHide(error.id), FADING_TOAST_MS);
    return () => clearTimeout(timer);
  }, [fades, held, onHide, error.id]);
  return (
    <div
      data-testid={notice ? "workspace-shell-notice" : "workspace-shell-error"}
      role={notice ? "status" : "alert"}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
      }}
      className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
    >
      <span className="flex h-6 shrink-0 items-center">
        {error.tone === "success"
          ? <CheckCircle2 size={14} aria-hidden className="text-success" />
          : <AlertTriangle size={14} aria-hidden className={error.tone === "warning" ? "text-warning" : "text-danger"} />}
      </span>
      <NoticeText
        title={error.title ?? error.message}
        titleClass={error.title ? "font-medium text-ink" : "text-ink"}
        body={error.title ? error.message : ""}
        after={error.lastLine}
        onOpenChange={setOpen}
        testId="workspace-shell-toast"
      >
        {(text) => (
          <div className="min-w-0 flex-1 select-text">
            <div className="flex min-w-0">{text.title}</div>
            {text.body}
          </div>
        )}
      </NoticeText>
      {(error.actionLabel && props.onAction) || (error.additionalActionLabels?.length && props.onAction) || (error.canRetry && props.onRetry) ? <div className="flex shrink-0 flex-col gap-1">
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
      {props.onAction ? error.additionalActionLabels?.map((label, index) => (
        <button type="button" key={label} data-testid="workspace-shell-error-additional-action"
          onClick={() => props.onAction?.(error.id, index + 1)}
          className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink">
          {label}
        </button>
      )) : null}
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
      </div> : null}
      {error.filePaths === undefined || error.filePaths.length > 0 ? <CopyButton
        key={error.id}
        iconOnly
        pinName
        label={error.copyLabel ?? (notice ? "Copy notice details" : "Copy error details")}
        testId="workspace-shell-error-copy"
        getText={() => error.details}
      /> : null}
      {props.onHide ? (
        <button
          type="button"
          aria-label={notice ? "Dismiss workspace notice" : "Dismiss workspace error"}
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
  unread: boolean;
  rest?: RestHandlers;
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
      {...props.rest}
      className={ROW_CLASS}
    >
      <UnreadMark unread={props.unread} testId={`notice-${notice.id}-unread`} />
      <span className="flex h-6 w-4 shrink-0 items-center justify-center">
        <notice.Icon size={14} aria-hidden className={toneClass(notice.tone)} />
      </span>
      <NoticeText
        title={notice.title}
        titleClass={props.unread ? "font-medium text-ink" : "text-muted"}
        body={notice.body}
        clamp={notice.filePaths === undefined}
        after={notice.lastLine}
        testId={`notice-${notice.id}`}
      >
        {(text) => (
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start gap-2">
              {text.title}
              <span className={ROW_CONTROLS_CLASS}>
                {(notice.actions ?? []).map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    disabled={action.disabled}
                    onClick={() => props.onAction(action)}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                  >
                    {action.label}
                  </button>
                ))}
                {notice.copyText !== undefined && !notice.filePaths?.length ? (
                  <CopyButton
                    iconOnly
                    pinName
                    label={notice.copyLabel ?? "Copy error details"}
                    testId={`notice-${notice.id}-copy`}
                    getText={() => notice.copyText ?? ""}
                  />
                ) : null}
                {notice.onDismiss ? (
                  <button
                    type="button"
                    data-testid={`notice-${notice.id}-dismiss`}
                    aria-label="Dismiss notice"
                    onClick={props.onDismiss}
                    className="grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
                  >
                    <X size={11} aria-hidden />
                  </button>
                ) : null}
              </span>
            </div>
            {text.body}
            {notice.command ? (
              <div className="mt-1 flex items-start gap-2">
                <code data-testid={`notice-${notice.id}-command`} className="min-w-0 flex-1 select-text break-all font-mono text-[12px] text-muted">
                  {notice.command}
                </code>
                <CopyButton iconOnly pinName label="Copy command" testId={`notice-${notice.id}-command-copy`}
                  getText={() => notice.command ?? ""} />
              </div>
            ) : null}
            {notice.filePaths?.length ? (
              <div className="mt-1 flex items-start gap-2">
                <ul className="m-0 min-w-0 flex-1 list-none p-0 text-[12px] text-muted">
                  {notice.filePaths.slice(0, 5).map(path => <li key={path} className="select-text break-all">{path}</li>)}
                  {notice.filePaths.length > 5 ? <li>{notice.filePaths.length - 5} more</li> : null}
                </ul>
                {notice.copyText !== undefined ? (
                  <CopyButton iconOnly pinName label={notice.copyLabel ?? "Copy error details"}
                    testId={`notice-${notice.id}-copy`} getText={() => notice.copyText ?? ""} />
                ) : null}
              </div>
            ) : null}
            {notice.timeMs !== undefined ? (
              <time
                dateTime={new Date(notice.timeMs).toISOString()}
                className="mt-1 block text-[10px] text-subtle"
              >
                {relativeTime(notice.timeMs)}
              </time>
            ) : null}
          </div>
        )}
      </NoticeText>
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
  // Files in this workspace whose save failed. The title bar names them
  // ahead of a disconnected server.
  failedSaves?: number;
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
  onWorkspaceErrorAction?: (id: string, index?: number) => void;
  onHideWorkspaceError?: (id: string) => void;
  onDismissWorkspaceError?: (id: string) => void;
  // Told each time an error's toast comes on screen.
  onWorkspaceErrorShown?: (id: string) => void;
  // Owner live delivery: the shell's trusted retry command, and the way into
  // the live-document list. Both are derived from the status, so a snapshot
  // that repeats itself changes nothing here.
  onRetryLiveDelivery?: () => void;
  onOpenLiveDocuments?: () => void;
  // Opens the refused document by version and object.
  onOpenSharingDeclined?: (versionId: string, objectId: string) => void;
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
  // Marks one notice read: the pointer or keyboard focus rested on its row.
  onReadSentNotice?: (notice: NoticeRow) => void;
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
  // A toast removed under focus hands it back to the open dialog, if there is
  // one, at the control F6 left from: the toggle sits behind the dialog,
  // outside its focus trap.
  useFocusSurface(toastsRef, () => modalReturnTarget() ?? toggleRef.current);
  // How far the toasts reach up from the window's bottom edge: the room an
  // open dialog leaves below its content (Overlay). None while none show.
  useLayoutEffect(() => {
    const stack = toastsRef.current;
    if (!stack) return;
    const root = document.documentElement;
    const measure = () => {
      const room = stack.offsetHeight > 0 ? Math.ceil(window.innerHeight - stack.getBoundingClientRect().top) : 0;
      root.style.setProperty("--dohc-toast-room", `${room}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(stack);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--dohc-toast-room");
    };
  }, [open]);
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

  // Derived from the status, never accumulated: a snapshot that repeats
  // itself renders the same notice, and delivery that recovers to active (or
  // reports nothing at all) leaves no notice and no toast behind.
  // The workspace is part of the key: a dismissal answers one workspace's
  // failure, so the same failure in another workspace is still news. While
  // the title bar names the server, the server's own toast and row report
  // the outage, so live editing files nothing and its open toast closes.
  // A retry with no reason waits QUIET_RETRY_MS, counted from when its ring
  // shows; a named reason stays until someone acts, so it shows at once.
  const liveDeliveryReason = props.syncStatus?.ownerLiveDeliveryReason;
  const liveRetryKey =
    props.syncStatus?.ownerLiveDelivery === "retrying"
      ? `${props.workspaceId}:retrying:${liveDeliveryReason ?? "transient"}`
      : null;
  const serverNamed = titleBarNamesServer(props.syncStatus, props.failedSaves ?? 0);
  const liveDeliveryKey = useLasted(
    serverNamed ? null : liveRetryKey,
    liveDeliveryReason ? 0 : QUIET_RETRY_MS,
  )
    ? liveRetryKey
    : null;
  const [dismissedLiveDeliveryKey, setDismissedLiveDeliveryKey] = useState<
    string | null
  >(null);
  // Recovery forgets the dismissal, so the next failure is announced again
  // instead of staying silent behind an answer about an older one.
  if (liveRetryKey === null && dismissedLiveDeliveryKey !== null) {
    setDismissedLiveDeliveryKey(null);
  }
  // Keyed, so an unchanged status keeps one copy object: the notice list and
  // the toast below both hang off its identity.
  const liveDelivery = useMemo(
    () => (liveDeliveryKey ? liveDeliveryCopy(liveDeliveryReason) : null),
    [liveDeliveryKey, liveDeliveryReason],
  );
  // One report for the row and the toast, so a person who copies from either
  // pastes the same facts — including when the notice was raised.
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

  // Closing a toast keeps its row; dismissing the row removes both.
  const [closedDeclines, setClosedDeclines] = useState<ReadonlySet<string>>(new Set());
  const [dismissedDeclines, setDismissedDeclines] = useState<ReadonlySet<string>>(new Set());
  const sharingDeclined = useMemo(
    () =>
      (props.syncStatus?.sharingDeclined ?? []).filter(
        (declined) => !dismissedDeclines.has(sharingDeclinedKey(props.workspaceId, declined)),
      ),
    [dismissedDeclines, props.syncStatus?.sharingDeclined, props.workspaceId],
  );
  const declineToast =
    sharingDeclined.find(
      (declined) => !closedDeclines.has(sharingDeclinedKey(props.workspaceId, declined)),
    ) ?? null;
  const closeDecline = useCallback(
    (declined: SharingDeclined) =>
      setClosedDeclines((current) =>
        new Set(current).add(sharingDeclinedKey(props.workspaceId, declined)),
      ),
    [props.workspaceId],
  );
  const { onOpenSharingDeclined } = props;

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
      // Main says why an install failed when it knows, such as a Linux password prompt that was closed.
      if (!result.accepted || result.state.status === "error") {
        setUpdateActionError(
          result.reason ?? (result.state.status === "error" ? result.state.message : "Could not restart into the update."),
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
        onRead: () => setClosedCrashRevision(crashReport.revision),
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
        title: error.title ?? error.message,
        body: error.title ? error.message : "",
        ...(error.lastLine ? { lastLine: error.lastLine } : {}),
        actions: [
          ...(error.actionLabel && props.onWorkspaceErrorAction
            ? [{
                label: error.actionLabel,
                onClick: () => props.onWorkspaceErrorAction?.(error.id),
              }]
            : []),
          ...(props.onWorkspaceErrorAction ? (error.additionalActionLabels ?? []).map((label, index) => ({
            label, onClick: () => props.onWorkspaceErrorAction?.(error.id, index + 1),
          })) : []),
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
        ...(!error.seen && props.onHideWorkspaceError
          ? { onRead: () => props.onHideWorkspaceError?.(error.id) }
          : {}),
        timeMs: error.atMs,
        copyText: error.filePaths?.length === 0 ? undefined : error.details,
        copyLabel: error.copyLabel ?? (error.tone === "warning" ? "Copy notice details" : undefined),
        filePaths: error.filePaths,
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
        id: `automation-hold-${hold.onServer ? "server-" : ""}${hold.automationId}-${hold.step}${hold.recipient ? `-${hold.recipient}` : ""}`,
        tone: "warning",
        title: `Automation "${hold.automationName}" is waiting${hold.onServer ? " on your server" : ""}`,
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
        onRead: () => setDismissedLiveDeliveryKey(liveDeliveryKey),
        copyText: liveDeliveryDetails,
        Icon: liveDelivery.Icon,
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
        onRead: () => setDismissedRefusalsKey(refusalsKey),
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

    for (const declined of sharingDeclined) {
      next.push({
        id: `sharing-declined-${encodeURIComponent(declined.versionId)}:${encodeURIComponent(declined.objectId)}`,
        tone: "warning",
        title: SHARING_DECLINED_TITLE,
        body: sharingDeclinedBody(declined),
        ...(onOpenSharingDeclined
          ? {
              actions: [{
                label: "Open document",
                onClick: () => {
                  closeDecline(declined);
                  onOpenSharingDeclined(declined.versionId, declined.objectId);
                },
              }],
            }
          : {}),
        onDismiss: () =>
          setDismissedDeclines((current) =>
            new Set(current).add(sharingDeclinedKey(props.workspaceId, declined)),
          ),
        onRead: () => closeDecline(declined),
        copyText: sharingDeclinedDetails(props.workspaceId, declined),
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
        ...(updateState.installCommand ? { command: updateState.installCommand } : {}),
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
    props.onHideWorkspaceError,
    props.onOpenConflicts,
    props.onOpenHistory,
    props.onRefreshShareView,
    props.onOpenSettings,
    props.onRebuildEngineStore,
    props.onReviewShareChanges,
    props.shareChangeNotices,
    props.syncStatus,
    props.workspaceId,
    sharingDeclined,
    closeDecline,
    onOpenSharingDeclined,
    liveDelivery,
    liveDeliveryAction,
    liveDeliveryDetails,
    liveDeliveryKey,
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
  const localCount = notices.length + (recoveryRows.length > 0 ? 1 : 0);
  // This computer's rows read in this window. A row that goes and comes back
  // is unread again.
  const [localRead, setLocalRead] = useState<ReadonlySet<string>>(new Set());
  const setAsideKey = recoveryRows.length > 0
    ? JSON.stringify([props.workspaceId, "set-aside", recoveryRows.map((row) => [row.path, row.draft.id])])
    : null;
  useEffect(() => {
    const present = new Set(notices.map((notice) => localReadKey(props.workspaceId, notice)));
    if (setAsideKey !== null) present.add(setAsideKey);
    setLocalRead((current) => {
      const kept = [...current].filter((key) => present.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [notices, props.workspaceId, setAsideKey]);
  const unreadNotices = notices.filter((notice) => !localRead.has(localReadKey(props.workspaceId, notice)));
  const setAsideUnread = setAsideKey !== null && !localRead.has(setAsideKey);
  const unreadLocal = unreadNotices.length + (setAsideUnread ? 1 : 0);
  // The update toast closes once its row is read.
  const updateRow = notices.find((notice) => notice.id === "update-ready" || notice.id === "update-error");
  const updateToastVisible = updateRow !== undefined && unreadNotices.includes(updateRow) &&
    (updateActionError !== null || readyUpdateKey !== dismissedUpdateToastKey);
  // Every row counts until it is read.
  const count = unreadLocal + unreadSent;
  const canReadAll = unreadLocal > 0 || (unreadSent > 0 && props.onReadAllSentNotices !== undefined);
  // Reading a row of this computer's keeps the row and closes its toast.
  const readLocal = (rows: readonly Notice[], setAside: boolean) => {
    setLocalRead((current) => {
      const next = new Set(current);
      for (const row of rows) next.add(localReadKey(props.workspaceId, row));
      if (setAside && setAsideKey !== null) next.add(setAsideKey);
      return next;
    });
    for (const row of rows) row.onRead?.();
  };
  // How to read each unread row as it is now, by a name that stays with the
  // row while its words change. A rest that ends reads what the row says then.
  const readers = new Map<string, () => void>();
  for (const notice of unreadNotices) readers.set(`local:${notice.id}`, () => readLocal([notice], false));
  if (setAsideUnread) readers.set("set-aside", () => readLocal([], true));
  for (const { notice } of sentNotices) {
    if (notice.readAtMs === null && props.onReadSentNotice) {
      readers.set(`sent:${sentKey(sentAccount, notice)}`, () => props.onReadSentNotice?.(notice));
    }
  }
  const latestReaders = useRef(readers);
  // The row the pointer rests on and the row holding focus, each waiting to
  // be read. Closing the panel reads neither.
  const rests = useRef<Record<RestSource, { row: string; timer: ReturnType<typeof setTimeout> } | null>>({ pointer: null, focus: null });
  const stopRest = (by: RestSource) => {
    const rest = rests.current[by];
    if (rest) clearTimeout(rest.timer);
    rests.current[by] = null;
  };
  // A row that goes away or is read stops its rest, which a removed row
  // cannot do by blur or pointer leave. A row that returns waits again.
  useLayoutEffect(() => {
    latestReaders.current = readers;
    for (const by of ["pointer", "focus"] as const) {
      const row = rests.current[by]?.row;
      if (row !== undefined && !readers.has(row)) stopRest(by);
    }
  });
  useEffect(() => {
    const current = rests.current;
    return () => {
      if (current.pointer) clearTimeout(current.pointer.timer);
      if (current.focus) clearTimeout(current.focus.timer);
      current.pointer = null;
      current.focus = null;
    };
  }, [open]);
  const restReads = (row: string): RestHandlers => {
    const start = (by: RestSource) => {
      if (rests.current[by]?.row === row) return;
      stopRest(by);
      const timer = setTimeout(() => {
        rests.current[by] = null;
        // One read per rest, even when the pointer and focus both wait on the row.
        const other = by === "pointer" ? "focus" : "pointer";
        if (rests.current[other]?.row === row) stopRest(other);
        latestReaders.current.get(row)?.();
      }, READ_REST_MS);
      rests.current[by] = { row, timer };
    };
    const end = (by: RestSource) => {
      if (rests.current[by]?.row === row) stopRest(by);
    };
    return {
      onPointerEnter: () => start("pointer"),
      onPointerLeave: () => end("pointer"),
      onFocus: () => start("focus"),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) end("focus");
      },
    };
  };
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
  // Open Notices hides the toasts.
  const shownErrorToastId = open ? null : (errorToast?.id ?? null);
  const { onWorkspaceErrorShown } = props;
  useEffect(() => {
    if (shownErrorToastId !== null) onWorkspaceErrorShown?.(shownErrorToastId);
  }, [shownErrorToastId, onWorkspaceErrorShown]);
  const sentToast = props.sentNoticeToast ?? null;
  const sentToastKey = sentToast ? sentKey(sentAccount, sentToast.notice) : null;
  const { onHideSentNoticeToast } = props;
  // A failure's toast stays until it is closed; any other fades.
  const sentToastFails = sentToast !== null && isFailure(sentToast.notice);
  const sentToastFades = sentToast !== null && !sentToastFails;
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
          sit over it. A corner host renders the stack at the body, outside
          its fixed wrapper's stacking context, so the toasts rise above
          dialogs there too. */}
      {open ? null : inToastLayer(host, (
        <div ref={toastsRef} data-testid="notice-toasts" data-dohc-toasts className={TOAST_STACK_CLASS[host]}>
          {errorToast ? (
            <WorkspaceErrorToast
              key={errorToast.id}
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
                {/* About four lines, then it scrolls, so a long reason never
                    pushes the title and controls out of a short window. */}
                {sentToastFails && sentToast.notice.body ? (
                  <span
                    data-testid="sent-notice-toast-body"
                    className="mt-0.5 block max-h-[5.5em] overflow-y-auto overscroll-contain text-[11px] text-muted"
                  >
                    {sentToast.notice.body}
                  </span>
                ) : null}
              </span>
              {(retriesRun(sentToast.notice) || sentToast.retryable) && props.onRetrySentNotice ? (
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
              {sentToastFails ? (
                <CopyButton
                  key={sentToastKey}
                  iconOnly
                  pinName
                  label="Copy error details"
                  testId="sent-notice-toast-copy"
                  getText={() => failureDetails(sentToast.notice)}
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
              <liveDelivery.Icon size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
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
              <CopyButton
                key={liveDeliveryKey}
                iconOnly
                pinName
                label="Copy live editing details"
                testId="owner-live-delivery-toast-copy"
                getText={() => liveDeliveryDetails}
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
              <CopyButton
                key={refusalsKey}
                iconOnly
                pinName
                label="Copy share details"
                testId="owner-live-refusals-toast-copy"
                getText={() => refusalsDetails}
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
          {declineToast ? (
            <div
              data-testid="sharing-declined-toast"
              role="status"
              aria-live="polite"
              className="dohc-popover dohc-pop-in relative flex w-[min(420px,calc(100vw-24px))] items-start gap-2 rounded-md border border-line bg-panel px-3 py-2 text-xs text-ink"
            >
              <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 select-text cursor-text break-words leading-snug">
                {SHARING_DECLINED_TITLE}. {sharingDeclinedBody(declineToast)}
              </span>
              {onOpenSharingDeclined ? (
                <button
                  type="button"
                  data-testid="sharing-declined-toast-open"
                  onClick={() => {
                    closeDecline(declineToast);
                    onOpenSharingDeclined(declineToast.versionId, declineToast.objectId);
                  }}
                  className="h-6 shrink-0 rounded border border-line px-2 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Open document
                </button>
              ) : null}
              <CopyButton
                key={sharingDeclinedKey(props.workspaceId, declineToast)}
                iconOnly
                pinName
                label="Copy error details"
                testId="sharing-declined-toast-copy"
                getText={() => sharingDeclinedDetails(props.workspaceId, declineToast)}
              />
              {/* Closing ends the announcement; the row stays in Notices. */}
              <button
                type="button"
                aria-label={`Close notice for ${declineToast.path}`}
                onClick={() => closeDecline(declineToast)}
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
              <CopyButton
                key={crashReport.revision}
                iconOnly
                pinName
                label="Copy report"
                testId="crash-report-toast-copy"
                getText={() => crashReport.text}
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
              <span className="min-w-0">
                {updateActionError ?? updateState?.message}
                {updateState?.installCommand ? (
                  <code data-testid="update-toast-install-command" className="mt-1 block select-text break-all font-mono text-[11px] text-muted">
                    {updateState.installCommand}
                  </code>
                ) : null}
              </span>
              {updateState?.installCommand ? (
                <CopyButton iconOnly pinName label="Copy command" testId="update-toast-install-command-copy"
                  getText={() => updateState.installCommand ?? ""} />
              ) : null}
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
      ))}

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
            <span className="text-sm font-semibold text-ink">
              Notices
            </span>
            {canReadAll ? (
              <button
                type="button"
                data-testid="notice-center-read-all"
                onClick={() => {
                  centerRef.current?.focus();
                  readLocal(unreadNotices, true);
                  if (unreadSent > 0) props.onReadAllSentNotices?.();
                }}
                className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
              >
                Mark all read
              </button>
            ) : null}
            {count > 0 ? (
              <span
                data-testid="notice-center-count"
                className={`${canReadAll ? "" : "ml-auto "}rounded-full border border-line bg-panel-2 px-1.5 text-[10px] font-medium leading-4 text-muted`}
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
            <div className="min-h-0 max-h-[28rem] overflow-y-auto">
              {localCount > 0 ? (
                <section data-testid="notice-group-local">
                  <SectionLabel as="h3" className="m-0 px-3 pb-1 pt-2">
                    On this computer
                  </SectionLabel>
              {recoveryRows.length > 0 ? (
                <section
                  data-testid="notice-set-aside-edits"
                  {...restReads("set-aside")}
                  className="flex gap-2 border-b border-line px-3 py-2"
                >
                  <UnreadMark unread={setAsideUnread} testId="notice-set-aside-edits-unread" className="h-4" />
                  <div className="min-w-0 flex-1">
                    <p className={`m-0 text-[12px] ${setAsideUnread ? "font-medium text-ink" : "text-muted"}`}>
                      {recoveryRows.length === 1
                        ? "1 set-aside edit is waiting"
                        : `${recoveryRows.length} set-aside edits are waiting`}
                    </p>
                    <p className="m-0 mt-0.5 text-[11px] leading-snug text-muted">
                      Copy an edit to keep its text. Dismiss deletes it for good.
                    </p>
                    <RecoveryList rows={recoveryRows} />
                  </div>
                </section>
              ) : null}
            <ul className="m-0 list-none p-0">
              {notices.map((notice) => (
                <LocalNoticeRow
                  key={notice.id}
                  notice={notice}
                  unread={unreadNotices.includes(notice)}
                  rest={restReads(`local:${notice.id}`)}
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
                    {sentShownRows.map(({ notice, folder, openable, retryable }) => {
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
                      const retry = (retriesRun(notice) || retryable) && props.onRetrySentNotice
                        ? () => props.onRetrySentNotice?.(notice)
                        : undefined;
                      const copies = isFailure(notice);
                      const running = runningKey === key;
                      // A wake from the server waits for one of this person's computers to run it; dismissing it would cancel it.
                      const dismissNotice = props.onDismissSentNotice && notice.kind !== "automation-wake"
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
                          {...restReads(`sent:${key}`)}
                          className={ROW_CLASS}
                        >
                          <UnreadMark unread={unread} testId={`sent-notice-${notice.noticeId}-unread`} />
                          <span className="flex h-6 w-4 shrink-0 items-center justify-center">
                            <SenderMark kind={notice.senderKind} className="shrink-0" />
                          </span>
                          <NoticeText
                            title={notice.title}
                            titleClass={unread ? "font-medium text-ink" : "text-muted"}
                            body={notice.body}
                            testId={`sent-notice-${notice.noticeId}`}
                          >
                            {(text) => (
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-start gap-2">
                                  {text.title}
                                  <span className={ROW_CONTROLS_CLASS}>
                                    {runNow ? (
                                      <button
                                        type="button"
                                        data-testid={`sent-notice-${notice.noticeId}-run-now`}
                                        aria-busy={running || undefined}
                                        disabled={runningKey !== null}
                                        onClick={runNow}
                                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
                                      >
                                        {running ? "Starting…" : "Run now"}
                                      </button>
                                    ) : null}
                                    {retry ? (
                                      <button
                                        type="button"
                                        data-testid={`sent-notice-${notice.noticeId}-retry`}
                                        onClick={retry}
                                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink"
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
                                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hover hover:text-ink aria-busy:opacity-50"
                                      >
                                        {busy ? "Opening…" : AUTOMATION_NOTICE_KINDS.has(notice.kind) ? "Open automation" : "Open"}
                                      </button>
                                    ) : null}
                                    {copies ? (
                                      <CopyButton
                                        iconOnly
                                        pinName
                                        label="Copy error details"
                                        testId={`sent-notice-${notice.noticeId}-copy`}
                                        getText={() => failureDetails(notice)}
                                      />
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
                                        className="grid size-5 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
                                      >
                                        <X size={11} aria-hidden />
                                      </button>
                                    ) : null}
                                  </span>
                                </div>
                                {text.body}
                                <p className="m-0 mt-1 flex min-w-0 gap-2 text-[10px] text-subtle">
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
                            )}
                          </NoticeText>
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
