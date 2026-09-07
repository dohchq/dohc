import { ArrowLeft, Bot } from "lucide-react";
import type * as React from "react";
import type { JoinedSharedChannelRow } from "../../ipc/bridgeContract";
import type { AgentPresenceActivity } from "../../collab/agentPresence";
import type { AgentNotification } from "./agentNotifications";
import { SectionLabel } from "../ui/controls";

// Why a committed share read carried no rows. "unreachable" covers both a
// relay that did not answer and a listing the IPC rejected outright: dohc
// could not read it, and a retry is the honest next step. "over-limit" is the
// answer that did arrive and that dohc cannot list — retrying repeats it
// exactly, so the surface owes the count and the limit instead of a button.
export type ShareReadFailure =
  | { kind: "unreachable" }
  | {
      kind: "over-limit";
      lanes: ReadonlyArray<{ lane: "granted" | "received"; rows: number }>;
      limit: number;
    };

export function AgentPresenceHint(props: {
  activity: AgentPresenceActivity | null;
  testId: string;
}) {
  if (props.activity === null) return null;
  const working = props.activity === "working";
  return (
    <span
      data-testid={props.testId}
      aria-label={`Agent is ${props.activity}`}
      title={`Agent is ${props.activity}`}
      className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-subtle"
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          working ? "bg-agent" : "border border-agent/60 bg-transparent"
        }`}
      />
      {props.activity}
    </span>
  );
}

export function UnreadPill(props: { count: number; testId: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      data-testid={props.testId}
      aria-label={`${props.count} unread`}
      className="min-w-4 shrink-0 rounded-full bg-ink px-1 text-center text-[10px] font-semibold leading-4 text-bg"
    >
      {props.count > 99 ? "99+" : props.count}
    </span>
  );
}

// One sentence per over-limit lane, counting what the lane actually holds.
//
// The unit is SHARES, not channels. A relay lane carries one row per grant and
// nothing deduplicates the channel — mapRelayShareListing keeps every row,
// because each carries its own recipient — so one channel shared with 4097
// people is 4097 rows. Saying "you share 4097 channels" names the wrong thing
// and sends the user to reduce channels when the excess is grants on a single
// channel they own. It is the same unit slip that made the deleted account
// fixture wrong, arriving at the surface.
//
// The joined lane counts the other unit — mergeJoinedChannel matches on
// channelWireId as well as shareId, so those rows really are one per channel —
// and it has no limit to report at all now that it is read per channel.
function overLimitSentences(failure: {
  lanes: ReadonlyArray<{ lane: "granted" | "received"; rows: number }>;
  limit: number;
}): string[] {
  return failure.lanes.map(({ lane, rows }) =>
    lane === "granted"
      ? `You have ${rows} shares of your channels; the limit is ${failure.limit}.`
      : `You have ${rows} shares from other people; the limit is ${failure.limit}.`,
  );
}

// What the sharing surface says when a committed share read carried no rows.
// Without it the surface renders an empty list, which reads as "you have no
// shares".
//
// The two reasons owe different things. An outage owes a retry, because the
// next request can answer. A listing over dohc's own cap owes the count and
// the limit and NO retry: the same request answers the same way forever, and a
// button that cannot work is the defect this notice exists to remove.
export function ShareReadFailureNotice(props: {
  testId: string;
  failure: ShareReadFailure;
  // True when rows are still on screen from an earlier read: they are real,
  // they are just older than this failure.
  stale: boolean;
  onRetry: () => void;
}) {
  const staleLine = props.stale ? " This list may be out of date." : "";
  return (
    <div
      data-testid={props.testId}
      data-failure={props.failure.kind}
      className="flex items-start gap-1.5 border-b border-line px-3 py-2"
    >
      <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted">
        {props.failure.kind === "unreachable"
          ? `dohc could not read your shares.${staleLine}`
          : `dohc cannot list this many shares. ${overLimitSentences(
              props.failure,
            ).join(" ")}${staleLine}`}
      </span>
      {props.failure.kind === "unreachable" ? (
        <button
          type="button"
          data-testid={`${props.testId}-retry`}
          onClick={props.onRetry}
          className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function BackHeader(props: {
  label: string;
  testId: string;
  onBack: () => void;
  icon?: React.ReactNode;
  // Optional calm trailing slot (e.g. presence faces of who else is here).
  trailing?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
      <button
        type="button"
        data-testid={`${props.testId}-back`}
        aria-label="Back"
        title="Back"
        onClick={props.onBack}
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
      >
        <ArrowLeft size={13} aria-hidden />
      </button>
      {props.icon}
      <span
        data-testid={`${props.testId}-title`}
        className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink"
      >
        {props.label}
      </span>
      {props.action}
      {props.trailing}
    </div>
  );
}

// One line describing who a joined channel came from — calm, not a banner.
export function joinedChannelLabel(joined: JoinedSharedChannelRow): string {
  const from = joined.granterEmail ?? "someone else";
  const suffix = joined.ended
    ? " — no longer shared"
    : joined.access === "read-only"
      ? " — read-only"
      : "";
  return `Shared by ${from}${suffix}`;
}

// The read-only / ended composer replacement: honest and quiet.
export function ComposerNotice(props: { testId: string; children: React.ReactNode }) {
  return (
    <p
      data-testid={props.testId}
      className="m-0 shrink-0 border-t border-line px-3 py-2 text-[11px] text-subtle"
    >
      {props.children}
    </p>
  );
}

// "Addressed to me" inbox: the calm, in-context list of things the agent is
// waiting on the user for (asks + needs-input). It reuses the agent
// notification model rather than a heavy new surface, and stays hidden when
// there's nothing to answer.
//
// The rows are informational, and a notification is why: it carries a
// workspace, a run, and copy — never a conversation or a message. The user
// acts where the run does: a blocked run raises its own permission card, and
// the History rail says what it did.
export function AddressedToMe(props: { notifications: readonly AgentNotification[] }) {
  const waiting = props.notifications.filter(
    (notification) => notification.kind === "asked" || notification.kind === "needs-input",
  );
  if (waiting.length === 0) return null;
  return (
    <section
      data-testid="chats-addressed-to-me"
      aria-label="Addressed to me"
      className="border-b border-line bg-panel-2/40"
    >
      <SectionLabel as="p" className="mb-0 px-3 pt-2">
        Addressed to me
      </SectionLabel>
      <ul className="m-0 list-none p-0">
        {waiting.map((notification) => (
          <li key={notification.id}>
            <div
              data-testid="chats-addressed-item"
              className="flex w-full items-start gap-1.5 px-3 py-2 text-left"
            >
              <Bot size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">
                  {notification.title}
                </span>
                <span className="block truncate text-[11px] text-muted">{notification.body}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
