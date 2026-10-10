import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { shareSubjectFallback } from "@dohc/security-contract/share-labels";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { File, FileDiff, FolderInput, Layers, MessageSquare, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ShareProposalRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { basenameOf } from "../path";
import { shareSenderParts } from "../ShareSender";
import type { ShareRemovalNotices } from "../shell/useShareRemovalNotices";
import { DangerButton, SecondaryButton } from "../ui/controls";
import { KindGlyph } from "../ui/KindGlyph";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { SkeletonLines } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import {
  ABOUT_ROW,
  AboutNote,
  AboutRetry,
  AccessChecked,
  accessReasonForLane,
  AccessUnknown,
  LEVELS,
  LinkMark,
  useSectionRead,
  type AboutNotices,
  type AccessContext,
  type AccessSetup,
  type AccessView,
} from "./About";
import { ChatAvatar } from "./ChatAvatar";

// The Sharing view: the shares this workspace granted, and the shares sent
// to the person's account. Each list is pinned to what it covers and when
// main checked it, so an empty list means "none within this coverage", never
// "nothing is shared". Its rows carry the actions Settings offers on a share.

export type SharingLane = "granted" | "received";
export type ShareMount = NonNullable<WorkspaceSummary["shareMounts"]>[number];
export type ShareGroup = { shareId: string; rows: AccessShareRow[] };
export type WaitingChanges = { count: number; oldestProposalId: string };

const LANE = {
  granted: {
    label: "Shared by me",
    empty: "No shares from this workspace. Right-click a file and choose Share… to share it.",
    unexplained: "Access information is unavailable for this workspace. This does not mean that nothing is shared.",
    failed: "dohc could not check the shares from this workspace.",
  },
  received: {
    label: "Shared with me",
    empty: "No shares to your account.",
    unexplained: "Access information is unavailable for your account. This does not mean that nothing is shared with you.",
    failed: "dohc could not check the shares to your account.",
  },
} as const;

/** One row per share. The inventory sorts by share, so a share's grants are
 * adjacent, also across pages. */
export function groupShares(rows: AccessAnswer["rows"]): ShareGroup[] {
  const groups: ShareGroup[] = [];
  for (const row of rows) {
    if (row.kind !== "share") continue;
    const last = groups.at(-1);
    if (last?.shareId === row.shareId) last.rows.push(row);
    else groups.push({ shareId: row.shareId, rows: [row] });
  }
  return groups;
}

/** Changes waiting per share: how many, and the oldest, which Review opens. */
export function waitingByShare(proposals: readonly ShareProposalRow[]): Map<string, WaitingChanges> {
  const waiting = new Map<string, WaitingChanges & { at: number }>();
  for (const proposal of proposals) {
    const seen = waiting.get(proposal.shareId);
    const older = !seen || proposal.createdAtMs < seen.at;
    waiting.set(proposal.shareId, {
      count: (seen?.count ?? 0) + 1,
      oldestProposalId: older ? proposal.proposalId : seen.oldestProposalId,
      at: older ? proposal.createdAtMs : seen.at,
    });
  }
  return waiting;
}

// What a share covers: its glyph, its name, and the folder it sits in.
function subjectOf(row: AccessShareRow): { glyph: ReactNode; name: string; folder: string | null; title: string } {
  const glyphClass = "text-subtle";
  const selector = row.selector;
  // Ended and removed grants come without what they covered; only a damaged
  // one is a fault.
  if (!selector) {
    const damaged = row.status === "damaged";
    const name = row.subjectName ?? (damaged ? "Unreadable share" : "Ended share");
    const glyph = damaged
      ? <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" />
      : <File size={15} aria-hidden className={`shrink-0 ${glyphClass}`} />;
    return { glyph, name, folder: null, title: name };
  }
  if (selector.kind === "chat" || selector.kind === "group") {
    const name = row.subjectName ?? shareSubjectFallback(selector);
    return { glyph: <MessageSquare size={15} aria-hidden className={`shrink-0 ${glyphClass}`} />, name, folder: null, title: name };
  }
  const [first, ...rest] = selector.paths;
  if (first === undefined) {
    const version = selector.versionId === null || selector.versionId === "main" ? "Main" : selector.versionId;
    const name = row.subjectName ?? `Version ${version}`;
    return { glyph: <Layers size={15} aria-hidden className={`shrink-0 ${glyphClass}`} />, name, folder: null, title: name };
  }
  const slash = first.lastIndexOf("/");
  return {
    glyph: <KindGlyph kind={fileKindForPath(first)} size={15} className={glyphClass} />,
    name: rest.length > 0 ? `${basenameOf(first)} +${rest.length}` : basenameOf(first),
    folder: slash > 0 ? `${first.slice(0, slash)}/` : null,
    title: selector.paths.join(", "),
  };
}

function recipientOf(row: AccessShareRow): string {
  return row.recipientEmail ?? row.recipientUserId ?? "Unnamed person";
}

// Settings ends a share it lists: a path or version share named to people.
// Links and chats end where they were made.
function endable(group: ShareGroup): boolean {
  const selector = group.rows[0]?.selector;
  return !!selector && selector.kind === undefined && group.rows.every((row) => row.via === "named")
    && group.rows.some((row) => row.status === "active");
}

function endConfirmWords(recipient: string, waiting: WaitingChanges | undefined): string {
  if (!waiting) return `End this share? ${recipient} keeps a read-only copy and stops receiving updates.`;
  return waiting.count === 1
    ? `End this share and decline 1 change ${recipient} sent? Undo restores the share, not the declined change.`
    : `End this share and decline ${waiting.count} changes ${recipient} sent? Undo restores the share, not the declined changes.`;
}

function StatusWord(props: { status: AccessShareRow["status"] }) {
  return (
    <span data-testid="sharing-row-status" className="shrink-0 font-mono text-[11px] text-subtle">
      {props.status === "damaged" ? "damaged" : "ended"}
    </span>
  );
}

function LevelMark(props: { access: AccessShareRow["access"] | undefined }) {
  const level = props.access ? LEVELS[props.access] : null;
  if (!level) return null;
  return (
    <span role="img" aria-label={level.label} title={level.label} className="shrink-0 text-subtle">
      <level.icon size={13} aria-hidden />
    </span>
  );
}

// A row: the glyph, the name over its folder or sender, then the trail and
// the row's menu, which shows on hover and on keyboard focus.
function ShareRow(props: {
  lane: SharingLane;
  shareId: string;
  status: string;
  subject: ReturnType<typeof subjectOf>;
  sub: string | null;
  trail: ReactNode;
  menu: readonly MoreMenuItem[];
  children?: ReactNode;
}) {
  const { subject } = props;
  return (
    <li data-testid={`sharing-${props.lane}-row`} data-share-id={props.shareId} data-status={props.status}>
      <div className={`group ${ABOUT_ROW} h-10 hover:bg-hover`}>
        {subject.glyph}
        <span className="flex min-w-0 flex-1 flex-col" title={subject.title}>
          <span className="truncate">{subject.name}</span>
          {props.sub ? <span className="truncate text-[11px] text-subtle">{props.sub}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">{props.trail}</span>
        {/* Every row keeps the menu's place, so the trails line up. */}
        {props.menu.length > 0 ? (
          <span data-testid={`sharing-${props.lane}-actions`}
            className="opacity-0 transition-opacity duration-75 focus-within:opacity-100 group-hover:opacity-100">
            <MoreMenu label="Share actions" testId={`sharing-${props.lane}-menu`} items={props.menu} />
          </span>
        ) : <span aria-hidden className="size-6 shrink-0" />}
      </div>
      {props.children}
    </li>
  );
}

function Faces(props: { rows: readonly AccessShareRow[] }) {
  const active = props.rows.filter((row) => row.status === "active");
  const people = active.filter((row) => row.via !== "link").slice(0, 3);
  return (
    <span className="flex items-center">
      {active.some((row) => row.via === "link") ? <LinkMark /> : null}
      {people.map((row, index) => (
        <span key={row.grantId} className={index > 0 || active.some((r) => r.via === "link") ? "-ml-1.5" : undefined}>
          <ChatAvatar name={recipientOf(row)} kind="human" size="strip" />
        </span>
      ))}
    </span>
  );
}

export type SharingActions = {
  retry: (lane: SharingLane) => void;
  more: (lane: SharingLane, answer: AccessAnswer) => void;
  reviewChanges: (proposalId: string) => void;
  startEnd: (shareId: string) => void;
  cancelEnd: () => void;
  end: (group: ShareGroup) => void;
  mount: (shareId: string) => void;
  unmount: (mount: ShareMount) => void;
  reviewConflicts: () => void;
};

function GrantedRow(props: {
  group: ShareGroup;
  waiting: WaitingChanges | undefined;
  confirming: boolean;
  busy: boolean;
  actions: SharingActions;
}) {
  const { group, waiting, actions } = props;
  const first = group.rows.find((row) => row.selector !== null) ?? group.rows[0]!;
  const active = group.rows.find((row) => row.status === "active");
  const subject = subjectOf(first);
  const canEnd = endable(group);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.confirming) cancelRef.current?.focus();
  }, [props.confirming]);
  const menu: MoreMenuItem[] = [
    ...(waiting ? [{ label: waiting.count > 1 ? `Review changes (${waiting.count})` : "Review changes", onSelect: () => actions.reviewChanges(waiting.oldestProposalId) }] : []),
    ...(canEnd ? [{ label: "End share…", onSelect: () => actions.startEnd(group.shareId), disabled: props.busy }] : []),
  ];
  return (
    <ShareRow
      lane="granted"
      shareId={group.shareId}
      status={active ? "active" : first.status}
      subject={subject}
      sub={subject.folder}
      menu={menu}
      trail={
        <>
          {waiting ? (
            <button
              type="button"
              data-testid="sharing-review"
              aria-label={waiting.count > 1 ? `Review changes (${waiting.count})` : "Review changes"}
              title="Review changes"
              onClick={() => actions.reviewChanges(waiting.oldestProposalId)}
              className="flex h-5 items-center gap-1 rounded-full border border-line bg-panel-2 px-1.5 font-mono text-[11px] text-muted hover:bg-hover hover:text-ink"
            >
              <FileDiff size={11} aria-hidden />
              {waiting.count}
            </button>
          ) : null}
          <Faces rows={group.rows} />
          {active ? <LevelMark access={active.access} /> : <StatusWord status={first.status} />}
        </>
      }
    >
      {props.confirming && active ? (
        <div
          data-testid="sharing-end-confirm"
          onKeyDown={(event) => {
            if (event.key === "Escape") actions.cancelEnd();
          }}
          className="mx-2 mb-1 flex flex-col gap-2 rounded-md bg-panel-2 px-2 py-2"
        >
          <p className="m-0 text-[12px] leading-4 text-muted">{endConfirmWords(recipientOf(active), waiting)}</p>
          <div className="flex justify-end gap-2">
            <SecondaryButton ref={cancelRef} size="compact" data-testid="sharing-end-cancel" onClick={actions.cancelEnd}>
              Cancel
            </SecondaryButton>
            <DangerButton size="compact" data-testid="sharing-end" disabled={props.busy} onClick={() => actions.end(group)}>
              {props.busy ? "Ending…" : "End share"}
            </DangerButton>
          </div>
        </div>
      ) : null}
    </ShareRow>
  );
}

function ReceivedRow(props: { row: AccessShareRow; mount: ShareMount | undefined; busy: boolean; actions: SharingActions }) {
  const { row, mount, actions } = props;
  const subject = subjectOf(row);
  // The row names the sender as the drawing does; the full label is its title.
  const parts = shareSenderParts(row.sharerName, row.granterEmail);
  const sender = parts.displayName ?? parts.full;
  const senderTitle = parts.full;
  const files = row.selector !== null && row.selector.kind === undefined;
  // A mounted share shows its pinned level: the pin is what its pulls enforce.
  const access = mount ? (mount.damaged ? null : mount.access) : row.access;
  const menu: MoreMenuItem[] = mount
    ? [{ label: "Remove from workspace", onSelect: () => actions.unmount(mount), disabled: props.busy }]
    : files && row.status === "active"
      ? [{ label: "Add to workspace", onSelect: () => actions.mount(row.shareId), disabled: props.busy }]
      : [];
  return (
    <ShareRow
      lane="received"
      shareId={row.shareId}
      status={row.status}
      subject={subject}
      sub={`from ${sender}`}
      menu={menu}
      trail={
        <>
          {mount ? (
            <span role="img" aria-label={`In this workspace as shared-with-me/${mount.label}`}
              title={`shared-with-me/${mount.label}`} data-testid="sharing-mounted" className="shrink-0 text-subtle">
              <FolderInput size={13} aria-hidden />
            </span>
          ) : null}
          <span title={senderTitle} className="inline-flex"><ChatAvatar name={sender} kind="human" size="strip" /></span>
          {row.status === "active" ? <LevelMark access={access ?? null} /> : <StatusWord status={row.status} />}
        </>
      }
    />
  );
}

function countOf(lane: SharingLane, answer: AccessAnswer): string {
  const active = lane === "granted"
    ? groupShares(answer.rows).filter((group) => group.rows.some((row) => row.status === "active")).length
    : answer.rows.filter((row) => row.kind === "share" && row.status === "active").length;
  return `${active}${answer.nextCursor ? "+" : ""}`;
}

function Section(props: {
  lane: SharingLane;
  view: AccessView;
  setup: AccessSetup;
  actions: SharingActions;
  children: (answer: AccessAnswer) => ReactNode;
}) {
  const { lane, view, actions } = props;
  const words = LANE[lane];
  const known = view.status === "ready" && view.answer.freshness !== "unknown" && view.answer.coverage.kind !== "unavailable";
  return (
    <section data-testid={`sharing-${lane}`} aria-label={words.label}>
      <h3 className="dohc-section-label m-0 flex items-center px-4 pb-1.5 pt-3.5">
        {words.label}
        {known ? (
          <span data-testid={`sharing-${lane}-count`} className="ml-auto font-mono text-[11px] font-normal normal-case tracking-normal">
            {countOf(lane, view.answer)}
          </span>
        ) : null}
      </h3>
      <div className="px-2 pb-1">
        {view.status === "loading" ? (
          <SkeletonLines rows={2} className="px-2 py-1" />
        ) : view.status === "failed" ? (
          <AboutRetry testId={`sharing-${lane}-failed`} onRetry={() => actions.retry(lane)} />
        ) : (
          <div data-testid={`sharing-${lane}-answer`} data-freshness={view.answer.freshness} data-coverage={view.answer.coverage.kind}>
            {!known ? (
              <AccessUnknown testId={`sharing-${lane}`} unexplained={words.unexplained} answer={view.answer}
                setup={props.setup} onRetry={() => actions.retry(lane)} />
            ) : (
              <>
                <AccessChecked testId={`sharing-${lane}-freshness`} answer={view.answer} />
                {view.answer.rows.length === 0 ? (
                  <AboutNote testId={`sharing-${lane}-empty`}>{words.empty}</AboutNote>
                ) : (
                  <ul className="m-0 list-none p-0">{props.children(view.answer)}</ul>
                )}
                {view.answer.nextCursor !== null ? (
                  <button
                    type="button"
                    data-testid={`sharing-${lane}-more`}
                    onClick={() => actions.more(lane, view.answer)}
                    className={`${ABOUT_ROW} h-7 cursor-pointer text-[12px] hover:bg-hover hover:text-ink`}
                  >
                    Show more
                  </button>
                ) : null}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** The panel for answers already in hand. The states page draws it. */
export function SharingPanel(props: {
  // null in a shared view: someone else's workspace grants nothing from here.
  granted: AccessView | null;
  received: AccessView;
  grantedSetup: AccessSetup;
  receivedSetup: AccessSetup;
  conflictCount: number | null;
  waiting: ReadonlyMap<string, WaitingChanges>;
  mounts: readonly ShareMount[];
  confirmShareId: string | null;
  busyShareId: string | null;
  actions: SharingActions;
}) {
  const { actions } = props;
  return (
    <div data-testid="sharing-view" className="min-h-0 flex-1 overflow-y-auto pb-2">
      {props.conflictCount !== null ? (
        <div data-testid="sharing-conflicts" className="mx-2 mt-2 flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
          <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 leading-4 text-ink">
            {props.conflictCount > 1 ? `${props.conflictCount} files changed on two machines` : "A file changed on two machines"}
          </span>
          <SecondaryButton size="compact" data-testid="sharing-conflicts-review" onClick={actions.reviewConflicts}>
            Review
          </SecondaryButton>
        </div>
      ) : null}
      {props.granted ? (
        <Section lane="granted" view={props.granted} setup={props.grantedSetup} actions={actions}>
          {(answer) => groupShares(answer.rows).map((group) => (
            <GrantedRow key={group.shareId} group={group} waiting={props.waiting.get(group.shareId)}
              confirming={props.confirmShareId === group.shareId} busy={props.busyShareId === group.shareId} actions={actions} />
          ))}
        </Section>
      ) : null}
      <Section lane="received" view={props.received} setup={props.receivedSetup} actions={actions}>
        {(answer) => answer.rows.flatMap((row) => row.kind === "share" ? [
          <ReceivedRow key={`${row.shareId}\0${row.grantId}`} row={row} busy={props.busyShareId === row.shareId}
            mount={props.mounts.find((mount) => mount.shareId === row.shareId)} actions={actions} />,
        ] : [])}
      </Section>
    </div>
  );
}

// One lane's read, held to the workspace it was asked for.
function useSharingLane(workspaceId: string, lane: SharingLane, notices: AboutNotices, refresh: () => Promise<void>) {
  const read = useSectionRead<AccessView>(`${workspaceId}\0${lane}`, `sharing-${lane}`, notices);
  const { begin, cancel } = read;
  const load = useCallback(
    async (options: { refreshed?: Promise<void>; after?: AccessAnswer }) => {
      const request = begin();
      try {
        if (options.refreshed) {
          await options.refreshed;
          if (!request.current()) return;
        }
        const cursor = options.after?.nextCursor ?? undefined;
        const answer = await bridge().listSharingAccess({ workspaceId, lane, ...(cursor ? { cursor } : {}) });
        // Main refuses a cursor from a listing that changed: read from the start.
        if (options.after && answer.coverage.kind === "unavailable") {
          if (request.current()) void load({});
          return;
        }
        request.settle({ status: "ready", answer: options.after ? { ...answer, rows: [...options.after.rows, ...answer.rows] } : answer });
      } catch (error) {
        const retry = () => void load({ refreshed: refresh() });
        request.fail({ status: "failed" }, ipcErrorMessage(error, LANE[lane].failed), error, retry);
      }
    },
    [begin, lane, refresh, workspaceId],
  );
  return { view: read.view, load, cancel };
}

export function SharingView(props: {
  workspaceId: string;
  shareView: boolean;
  context: AccessContext;
  notices: AboutNotices;
  conflictCount: number | null;
  onReviewConflicts: () => void;
  proposals: readonly ShareProposalRow[];
  onReviewChanges: (proposalId: string) => void;
  mounts: readonly ShareMount[];
  onMounted: () => void;
  onUnmount: (path: string) => Promise<void>;
  shareRemovals: ShareRemovalNotices;
  reportError: (fallback: string, error: unknown, retry: () => void) => void;
}) {
  const { workspaceId, context } = props;
  const { facts, openSyncSettings, connect } = context;
  const refresh = useCallback(
    () => bridge().requestAccessRefresh({ workspaceId, reason: "sharing-open" }).catch(() => undefined),
    [workspaceId],
  );
  const granted = useSharingLane(workspaceId, "granted", props.notices, refresh);
  const received = useSharingLane(workspaceId, "received", props.notices, refresh);
  const [confirmShareId, setConfirmShareId] = useState<string | null>(null);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  // Bumped by a workspace switch or unmount, so a late action answer lands nowhere.
  const epoch = useRequestSequence([workspaceId]);

  // As About's Access: ask main to check again when the view opens, and when
  // the server connection it was asked under changes.
  const connection = typeof facts.cloud === "string" ? facts.cloud
    : `${facts.cloud.connected}:${facts.cloud.workspaceSynced}:${facts.cloud.workspaceSyncConnected}`;
  const refreshedUnder = useRef<string | null>(null);
  const loadGranted = granted.load, loadReceived = received.load;
  const cancelGranted = granted.cancel, cancelReceived = received.cancel;
  useEffect(() => {
    const checking = connection === "checking";
    const refreshed = !checking && refreshedUnder.current !== connection ? refresh() : undefined;
    if (!checking) refreshedUnder.current = connection;
    if (!props.shareView) void loadGranted({ refreshed });
    void loadReceived({ refreshed });
    return () => {
      cancelGranted();
      cancelReceived();
    };
  }, [cancelGranted, cancelReceived, connection, loadGranted, loadReceived, props.shareView, refresh]);

  const setupFor = useCallback(
    (lane: SharingLane): AccessSetup => ({ reason: accessReasonForLane(facts, lane), openSyncSettings, connect }),
    [connect, facts, openSyncSettings],
  );
  const waiting = useMemo(() => waitingByShare(props.proposals), [props.proposals]);

  async function end(group: ShareGroup) {
    const active = group.rows.find((row) => row.status === "active");
    const first = group.rows[0];
    if (!active || !first) return;
    const token = epoch.current();
    const subject = `the share of ${subjectOf(first).title} with ${recipientOf(active)}`;
    setBusyShareId(group.shareId);
    try {
      const result = await bridge().revokeRelayShare({ shareId: group.shareId });
      props.shareRemovals.removed({
        workspaceId,
        shareId: group.shareId,
        undo: result.undo,
        message: result.undo ? `Ended ${subject}.` : `${subject[0]!.toUpperCase()}${subject.slice(1)} has already ended.`,
        restoredMessage: `Restored ${subject}.`,
        restored: () => {
          if (epoch.isCurrent(token)) void loadGranted({ refreshed: refresh() });
        },
      });
      if (!epoch.isCurrent(token)) return;
      setConfirmShareId(null);
      void loadGranted({ refreshed: refresh() });
    } catch (cause) {
      if (!epoch.isCurrent(token)) return;
      props.shareRemovals.failed({ workspaceId, message: `dohc could not end ${subject}.`, cause, retry: () => void end(group) });
    } finally {
      if (epoch.isCurrent(token)) setBusyShareId(null);
    }
  }

  async function mount(shareId: string) {
    const token = epoch.current();
    setBusyShareId(shareId);
    try {
      const found = await bridge().getRelayReceivedShare({ shareId });
      if (!found.found) throw new Error(found.removed?.message ?? "This share is no longer shared with you.");
      await bridge().mountShare({ workspaceId, shareCode: found.share.shareCode });
      if (epoch.isCurrent(token)) props.onMounted();
    } catch (cause) {
      if (epoch.isCurrent(token)) {
        props.reportError("dohc could not add this share to the workspace.", cause, () => void mount(shareId));
      }
    } finally {
      if (epoch.isCurrent(token)) setBusyShareId(null);
    }
  }

  async function unmount(target: ShareMount) {
    const token = epoch.current();
    setBusyShareId(target.shareId);
    try {
      await props.onUnmount(`shared-with-me/${target.label}`);
    } finally {
      if (epoch.isCurrent(token)) setBusyShareId(null);
    }
  }

  const actions: SharingActions = {
    retry: (lane) => void (lane === "granted" ? loadGranted : loadReceived)({ refreshed: refresh() }),
    more: (lane, answer) => void (lane === "granted" ? loadGranted : loadReceived)({ after: answer }),
    reviewChanges: props.onReviewChanges,
    startEnd: setConfirmShareId,
    cancelEnd: () => setConfirmShareId(null),
    end: (group) => void end(group),
    mount: (shareId) => void mount(shareId),
    unmount: (target) => void unmount(target),
    reviewConflicts: props.onReviewConflicts,
  };
  return (
    <SharingPanel
      granted={props.shareView ? null : granted.view}
      received={received.view}
      grantedSetup={setupFor("granted")}
      receivedSetup={setupFor("received")}
      conflictCount={props.conflictCount}
      waiting={waiting}
      mounts={props.mounts}
      confirmShareId={confirmShareId}
      busyShareId={busyShareId}
      actions={actions}
    />
  );
}
