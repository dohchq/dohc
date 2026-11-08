import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { File, FileDiff, FolderInput, Layers, Link, MessageSquare, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { ShareProposalRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { shareSenderParts } from "../ShareSender";
import { BROWSER_INVITATION_SECRET, SHARE_CODE_SECRET } from "../shareCopySecrets";
import { hasUnacknowledgedShareSkips, shareSkipNoticeLines } from "../shareSkipNotice";
import type { ShareRemovalNotices } from "../shell/useShareRemovalNotices";
import { DangerButton, EmptyState, Pill, RetryRow, SecondaryButton } from "../ui/controls";
import { CopyButton } from "../ui/CopyButton";
import { KindGlyph } from "../ui/KindGlyph";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { NameLine } from "../ui/NameLine";
import { SkeletonLines } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import {
  ABOUT_ROW,
  AccessChecked,
  AccessUnknown,
  LEVELS,
  SIGNED_OUT_ACCESS,
  useSectionRead,
  type AboutNotices,
  type AccessSetup,
  type AccessView,
} from "./About";
import { accessReasonForLane, type AccessContext } from "./accessReason";
import { EMPTY_ART } from "./EmptyArt";
import { shareSubject } from "./shareSubject";

// The Sharing view: the shares this workspace granted, and the shares sent
// to the person's account. Each list is pinned to what it covers and when
// main checked it, so an empty list means "none within this coverage", never
// "nothing is shared". Its rows carry every action on a share.

export type SharingLane = "granted" | "received";
export type ShareMount = NonNullable<WorkspaceSummary["shareMounts"]>[number];
export type ShareGroup = { shareId: string; rows: AccessShareRow[] };
export type WaitingChanges = { count: number; senders: string[]; oldestProposalId: string };
// A row, or a lane's heading when no share is named, to focus on opening.
export type SharingFocus = { lane: SharingLane; shareId: string | null };
export type CopyWhat = "code" | "invitation";
// Whether a mount's skipped changes show, against what its record says:
// shown on request, or hidden up to the generation a Dismiss covered.
type SkipState = "shown" | number;
export type SkipView = ReadonlyMap<string, SkipState>;

const LANE = {
  granted: {
    label: "Shared by me",
    // What each list covers, stated beside when it was checked.
    scope: "for this workspace",
    empty: "Nothing shared from this workspace yet.",
    unexplained: "Access information is unavailable for this workspace. This does not mean that nothing is shared.",
    signedOut: SIGNED_OUT_ACCESS,
    failed: "dohc could not check the shares from this workspace.",
  },
  // What others shared with the account. It needs a signed-in account, never
  // this workspace's sync, so signed out is the only cause it names.
  received: {
    label: "Shared with me",
    scope: "for your account",
    empty: "Nothing shared with you yet.",
    unexplained: "Access information is unavailable for your account. This does not mean that nothing is shared with you.",
    signedOut: "Connect a server to get what others share with you.",
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

/** Changes waiting per share: how many, who sent them, and the oldest, which Review opens. */
export function waitingByShare(proposals: readonly ShareProposalRow[]): Map<string, WaitingChanges> {
  const waiting = new Map<string, WaitingChanges & { at: number }>();
  for (const proposal of proposals) {
    const seen = waiting.get(proposal.shareId);
    const older = !seen || proposal.createdAtMs < seen.at;
    // The relay may not know who sent a change; it stays counted.
    const sender = proposal.proposedByEmail ?? "someone";
    waiting.set(proposal.shareId, {
      count: (seen?.count ?? 0) + 1,
      senders: seen?.senders.includes(sender) ? seen.senders : [...(seen?.senders ?? []), sender],
      oldestProposalId: older ? proposal.proposalId : seen.oldestProposalId,
      at: older ? proposal.createdAtMs : seen.at,
    });
  }
  return waiting;
}

type Subject = { glyph: ReactNode; name: string; folder: string | null; title: string };
const GLYPH_CLASS = "shrink-0 text-subtle";

// What a share covers: its glyph, its name, and the folder it sits in.
function subjectOf(row: AccessShareRow): Subject {
  const subject = shareSubject(row);
  const glyph = subject.kind === "damaged" ? <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" />
    : subject.kind === "chat" ? <MessageSquare size={15} aria-hidden className={GLYPH_CLASS} />
    : subject.kind === "version" ? <Layers size={15} aria-hidden className={GLYPH_CLASS} />
    : subject.path ? <KindGlyph kind={fileKindForPath(subject.path)} size={15} className="text-subtle" />
    : <File size={15} aria-hidden className={GLYPH_CLASS} />;
  return { glyph, name: subject.name, folder: subject.folder, title: subject.title };
}

function recipientOf(row: AccessShareRow): string {
  return row.recipientEmail ?? row.recipientUserId ?? "Unnamed person";
}

type Level = NonNullable<AccessShareRow["access"]>;
type LeveledRow = AccessShareRow & { access: Level };
// What a level lets a person do, widest first: the app's three verbs.
const VERBS: readonly string[] = ["edit", "comment", "view"];
const verbOf = (access: Level) => LEVELS[access].label.toLowerCase();

// Who can do what, as a row's second line says it, wrapped whole. `spoken`
// is how a row's name reads it, when that differs. The title names each.
type Who = { text: string; title: string; spoken?: string };
const sentenceOf = (who: Who) => who.spoken ?? who.text;

// How many people have each level, widest first: "1 person can edit", "2 can view".
function countClauses(people: readonly LeveledRow[]): string[] {
  return VERBS.map((verb) => ({ verb, count: people.filter((row) => verbOf(row.access) === verb).length }))
    .filter(({ count }) => count > 0)
    .map(({ verb, count }, index) => index > 0 ? `${count} can ${verb}`
      : `${count} ${count === 1 ? "person" : "people"} can ${verb}`);
}

// How many links have each level, widest first: "1 link lets anyone edit".
function linkClauses(links: readonly LeveledRow[]): string[] {
  if (links.length === 1) return [`Anyone with the link can ${verbOf(links[0]!.access)}`];
  return VERBS.map((verb) => ({ verb, count: links.filter((row) => verbOf(row.access) === verb).length }))
    .filter(({ count }) => count > 0)
    .map(({ verb, count }) => `${count} ${count === 1 ? "link lets" : "links let"} anyone ${verb}`);
}

// A share's live grants, widest level first. Anyone with a link has the
// widest link's level, so only people above it are counted beside it.
// Without a link, one person goes by name and several by count. The title
// names each.
function grantedWho(group: ShareGroup): Who | null {
  const live = group.rows.filter((row): row is LeveledRow => row.status === "active" && row.access !== null);
  const links = live.filter((row) => row.via === "link")
    .sort((a, b) => VERBS.indexOf(verbOf(a.access)) - VERBS.indexOf(verbOf(b.access)));
  const people = live.filter((row) => row.via !== "link");
  const title = [
    ...(links.length > 0 ? linkClauses(links) : []),
    ...people.map((row) => `${recipientOf(row)} can ${verbOf(row.access)}`),
  ].join("\n");
  const [link] = links;
  if (link) {
    const linkVerb = verbOf(link.access);
    const anyone = `with ${links.length === 1 ? "the" : "a"} link can ${linkVerb}`;
    const above = people.filter((row) => VERBS.indexOf(verbOf(row.access)) < VERBS.indexOf(linkVerb));
    const clauses = countClauses(above);
    return { text: clauses.length === 0 ? `Anyone ${anyone}` : [...clauses, `anyone ${anyone}`].join(", "), title };
  }
  const [only] = people;
  if (!only) return null;
  if (people.length === 1) return { text: `${recipientOf(only)} can ${verbOf(only.access)}`, title };
  return { text: countClauses(people).join(", "), title };
}

// A share sent to the account, by its sender alone.
function fromWho(sender: string, full: string): Who {
  return { text: `From ${sender}`, title: `From ${full}`, spoken: `from ${sender}` };
}

/** The names a list shows more than once: those rows show their folder too. */
function repeatedNames(names: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

// A row's name, after its folder when another row in its list has the name too.
function shownName(subject: Subject, repeated: ReadonlySet<string>): string {
  return repeated.has(subject.name) && subject.folder ? `${subject.folder}${subject.name}` : subject.name;
}

// The grant a share's row speaks for: a live one, else one that still says
// what the share covered. An ended grant comes back without its selector.
function liveGrant(group: ShareGroup): AccessShareRow {
  return group.rows.find((row) => row.status === "active" && row.selector !== null)
    ?? group.rows.find((row) => row.selector !== null) ?? group.rows[0]!;
}

// A grant ending can still stop: an active one, or one dohc cannot read,
// which stays endable so its reverse path does not disappear.
function endsOnEnd(row: AccessShareRow): boolean {
  return row.status === "active" || row.status === "damaged";
}

// Everyone ending the share removes: each person, or how many past three.
function recipientNames(group: ShareGroup): string[] {
  return [...new Set(group.rows.filter(endsOnEnd).map(recipientOf))];
}
function namesOf(names: readonly string[], none: string): string {
  if (names.length > 3) return `${names.length} people`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? none;
}
function recipientsOf(group: ShareGroup): string {
  return namesOf(recipientNames(group), "the recipient");
}

// A path or version share named to people ends here, and so does one dohc
// cannot read. Links and chats end where they were made.
function endable(group: ShareGroup): boolean {
  if (!group.rows.every((row) => row.via === "named")) return false;
  if (group.rows.some((row) => row.status === "damaged")) return true;
  const selector = liveGrant(group).selector;
  return !!selector && selector.kind === undefined && group.rows.some((row) => row.status === "active");
}

// What a row can hand out: the share's code from a live named or dependent
// grant, and a named person's browser invitation where the server makes one
// (a live edit of files, `isLiveEditShareSelector` on the relay). A link's
// grant and a damaged one have nothing to copy.
function copiesOf(group: ShareGroup): { code: AccessShareRow | null; invitation: AccessShareRow | null } {
  const files = group.rows.filter((row) => row.status === "active" && row.selector !== null
    && row.selector.kind === undefined && (row.via === "named" || row.via === "dependent"));
  const named = files.filter((row) => row.via === "named");
  // One invitation per person: a row that names several cannot say whose.
  const only = named.length === 1 ? named[0]! : null;
  const selector = only?.selector;
  const liveEdit = only?.access === "edit" && !!selector && selector.kind === undefined
    && selector.versionId === null && selector.paths.length > 0;
  return { code: files[0] ?? null, invitation: liveEdit ? only : null };
}

// The plain question names who loses the share; with changes waiting, it
// names who sent them.
function endConfirmWords(group: ShareGroup, waiting: WaitingChanges | undefined): string {
  if (!waiting) {
    const who = recipientsOf(group);
    return recipientNames(group).length > 1
      ? `End this share? ${who} keep read-only copies and stop receiving updates.`
      : `End this share? ${who} keeps a read-only copy and stops receiving updates.`;
  }
  const who = namesOf(waiting.senders, "someone");
  return waiting.count === 1
    ? `End this share and decline 1 change ${who} sent? Undo restores the share, not the declined change.`
    : `End this share and decline ${waiting.count} changes ${who} sent? Undo restores the share, not the declined changes.`;
}

type Word = "damaged" | "ended" | "removed";
const WORD_SHOWN: Record<Word, string> = { damaged: "Damaged", ended: "Ended", removed: "Removed" };

function StatusPill(props: { word: Word }) {
  return (
    <span data-testid="sharing-row-status" className="mr-1">
      <Pill tone={props.word === "damaged" ? "danger" : "muted"}>{WORD_SHOWN[props.word]}</Pill>
    </span>
  );
}

// A block under a row: the question that ends a share, or what a mount's pulls skipped.
const CARD = "mb-1 flex flex-col gap-2 rounded-lg border border-line bg-bg p-3";

// Wide enough for the rows' longest item, "Remove from workspace".
const ROW_MENU_WIDTH = 200;

// Over the end of the row's last line, on a 16px fade into the row's hover
// fill. Hidden at rest; shown on hover, keyboard focus, and while its menu
// is open. Inside the scroller, so its focus halos are inset.
const ROW_ACTIONS = [
  "pointer-events-none absolute bottom-0 right-1 flex h-6 items-center gap-0.5 pl-4 opacity-0 transition-opacity duration-75",
  "bg-[image:linear-gradient(to_right,transparent,var(--dohc-hover)_16px),linear-gradient(to_right,transparent,var(--dohc-panel)_16px)]",
  "[&_button:focus-visible]:-outline-offset-2",
  "group-hover:pointer-events-auto group-hover:opacity-100",
  "keyboard:group-focus-within:pointer-events-auto keyboard:group-focus-within:opacity-100",
  "has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100",
].join(" ");

// A row: the glyph, then the name and the marks that say what waits and
// where the share lives, over who can do what. An ended, removed or damaged
// row starts its second line with a pill that says so. The second line and
// the note wrap whole; no row changes height on hover, and the name line is
// never covered except on a row of one line. The view focuses a row when it
// opens on it, and the row is named for a screen reader by what it shows.
function ShareRow(props: {
  lane: SharingLane;
  shareId: string;
  status: string;
  subject: Subject;
  // The name the row shows: the subject's, after its folder when the list repeats it.
  name: string;
  who: Who | null;
  // Words a row must show whole, wrapped under the second line.
  note?: string | null;
  word?: Word | null;
  lead?: ReactNode;
  mark?: ReactNode;
  copies?: ReactNode;
  menu: readonly MoreMenuItem[];
  children?: ReactNode;
}) {
  const { subject, who } = props;
  const acts = props.copies !== undefined || props.menu.length > 0;
  const label = [props.name, who ? sentenceOf(who) : null, props.word].filter(Boolean).join(", ");
  // The note is sentences: it describes the row rather than joining its name.
  const noteId = `${useId()}-note`;
  const oneLine = !who && !props.word && !props.note;
  return (
    <li data-testid={`sharing-${props.lane}-row`} data-share-id={props.shareId} data-status={props.status}>
      <div role="group" aria-label={label} aria-describedby={props.note ? noteId : undefined} data-sharing-row-focus
        className={`group relative flex min-h-10 w-full gap-2 rounded-md px-2 py-0.5 text-left text-[13px] text-muted transition-colors duration-75 ${oneLine ? "items-center" : "items-start"} hover:bg-hover keyboard:focus-within:bg-hover has-[[aria-expanded=true]]:bg-hover dohc-focus-row`}>
        <span className="flex h-5 shrink-0 items-center">{subject.glyph}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <NameLine name={props.name} title={subject.title} className={`flex-1 leading-5 ${props.word ? "" : "text-ink"}`} />
            {props.lead || props.mark ? <span className="flex shrink-0 items-center gap-1">{props.lead}{props.mark}</span> : null}
          </span>
          {who || props.word ? (
            // 4px under the name line, so the 24px actions over the last line never reach it.
            <span className="mt-1 text-[12px] leading-4 wrap-anywhere">
              {props.word ? <StatusPill word={props.word} /> : null}
              {props.word && who ? " " : null}
              {who ? <span data-testid="sharing-row-who" title={who.title}>{who.text}</span> : null}
            </span>
          ) : null}
          {props.note ? <span id={noteId} data-testid="sharing-row-note" className="mt-1 text-[12px] leading-4">{props.note}</span> : null}
        </span>
        {acts ? (
          <span data-testid={`sharing-${props.lane}-actions`} className={ROW_ACTIONS}>
            {props.copies}
            {props.menu.length > 0 ? (
              <MoreMenu label="Share actions" testId={`sharing-${props.lane}-menu`} items={props.menu} width={ROW_MENU_WIDTH} />
            ) : null}
          </span>
        ) : null}
      </div>
      {props.children}
    </li>
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
  // The text a copy hands out, read at the click; null when there is none.
  copy: (grant: AccessShareRow, what: CopyWhat) => Promise<string | null>;
  dismissSkips: (mount: ShareMount) => void;
  showSkips: (shareId: string) => void;
  reviewConflicts: () => void;
};

function GrantedRow(props: {
  group: ShareGroup;
  // The names its list shows more than once.
  repeated: ReadonlySet<string>;
  waiting: WaitingChanges | undefined;
  confirming: boolean;
  busy: boolean;
  // Whether this server has shown that it makes browser invitations.
  invitations: boolean;
  actions: SharingActions;
}) {
  const { group, waiting, actions } = props;
  const first = liveGrant(group);
  const active = group.rows.find((row) => row.status === "active");
  const subject = subjectOf(first);
  const canEnd = endable(group);
  const copies = copiesOf(group);
  const code = copies.code;
  const invitation = props.invitations ? copies.invitation : null;
  const word: Word | null = active ? null : first.status === "damaged" ? "damaged" : "ended";
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.confirming) cancelRef.current?.focus();
  }, [props.confirming]);
  const menu: MoreMenuItem[] = [
    ...(waiting ? [{ label: waiting.count > 1 ? `Review changes (${waiting.count})` : "Review changes", onSelect: () => actions.reviewChanges(waiting.oldestProposalId) }] : []),
    ...(canEnd ? [{ label: "End share…", onSelect: () => actions.startEnd(group.shareId), disabled: props.busy, danger: true }] : []),
  ];
  return (
    <ShareRow
      lane="granted"
      shareId={group.shareId}
      status={active ? "active" : first.status}
      subject={subject}
      name={shownName(subject, props.repeated)}
      who={word ? null : grantedWho(group)}
      word={word}
      menu={menu}
      copies={code || invitation ? (
        <>
          {invitation ? (
            <CopyButton iconOnly icon={Link} testId="sharing-copy-invitation" label="Copy invitation"
              sensitive={BROWSER_INVITATION_SECRET} getText={() => actions.copy(invitation, "invitation")} />
          ) : null}
          {code ? (
            <CopyButton iconOnly testId="sharing-copy-code" label="Copy code"
              sensitive={SHARE_CODE_SECRET} getText={() => actions.copy(code, "code")} />
          ) : null}
        </>
      ) : undefined}
      lead={waiting ? (
        <button
          type="button"
          data-testid="sharing-review"
          aria-label={waiting.count > 1 ? `Review changes (${waiting.count})` : "Review changes"}
          title="Review changes"
          onClick={() => actions.reviewChanges(waiting.oldestProposalId)}
          className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-line bg-panel-2 px-1.5 text-[11px] tabular-nums text-muted hover:bg-hover hover:text-ink"
        >
          <FileDiff size={11} aria-hidden />
          {waiting.count}
        </button>
      ) : undefined}
    >
      {props.confirming && group.rows.some(endsOnEnd) ? (
        <div
          data-testid="sharing-end-confirm"
          onKeyDown={(event) => {
            if (event.key === "Escape") actions.cancelEnd();
          }}
          className={CARD}
        >
          <p className="m-0 text-[12px] leading-4 text-ink">{endConfirmWords(group, waiting)}</p>
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

// A mount's skipped changes, under its row: what the pulls skipped, then one
// Dismiss for all of them. The record stays, so the row's menu can show them
// again, and focus moves there.
function SkippedChanges(props: { mount: ShareMount; actions: SharingActions }) {
  const skipped = props.mount.skippedOps;
  if (!skipped) return null;
  return (
    <div className={`${CARD} text-[12px] text-warning`}>
      {/* The lines take the block's width; Dismiss sits under them at its end. */}
      <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
        {shareSkipNoticeLines(skipped, props.mount.granterEmail).map((line) => (
          <li key={line.kind} data-testid="sharing-skipped" data-kind={line.kind} className="flex items-start gap-1.5">
            <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 leading-4" title={line.detail ?? line.text}>{line.text}</span>
          </li>
        ))}
      </ul>
      <SecondaryButton size="compact" className="self-end" data-testid="sharing-skipped-dismiss" aria-label="Dismiss skipped changes"
        onClick={(event) => {
          // The lines go; the menu that shows them again takes focus.
          event.currentTarget.closest("li")?.querySelector<HTMLElement>('[data-testid="sharing-received-menu"]')?.focus();
          props.actions.dismissSkips(props.mount);
        }}>
        Dismiss
      </SecondaryButton>
    </div>
  );
}

// A share sent to the account, or a mount the relay no longer lists (`row`
// null). A mount with no live grant behind it reads as removed, in the
// relay's words when it has them, and keeps its Remove.
function ReceivedRow(props: {
  row: AccessShareRow | null;
  mount: ShareMount | undefined;
  repeated: ReadonlySet<string>;
  // Whether the relay's listing was read, so a missing grant means removed.
  listed: boolean;
  skipsShown: boolean;
  busy: boolean;
  actions: SharingActions;
}) {
  const { row, mount, actions } = props;
  const shareId = row?.shareId ?? mount!.shareId;
  const removed = row ? row.status === "removed" : props.listed;
  const damaged = row ? row.status === "damaged" : mount?.damaged === true;
  // A grant that no longer says what it covered goes by its folder's name.
  const subject: Subject = mount && !row?.selector ? {
    glyph: damaged ? <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" /> : <File size={15} aria-hidden className={GLYPH_CLASS} />,
    name: mount.label, folder: null, title: `shared-with-me/${mount.label}`,
  } : subjectOf(row!);
  // The row names the sender as the drawing does; the full label is its title.
  const parts = shareSenderParts(row?.sharerName, row?.granterEmail ?? mount?.granterEmail);
  const sender = parts.displayName ?? parts.full;
  const files = row !== null && row.selector !== null && row.selector.kind === undefined;
  // A mounted share shows its pinned level: the pin is what its pulls enforce.
  const access = mount ? (mount.damaged ? null : mount.access) : row?.access;
  const active = row?.status === "active";
  const skipped = mount?.skippedOps;
  const menu: MoreMenuItem[] = mount
    ? [
        { label: "Remove from workspace", onSelect: () => actions.unmount(mount), disabled: props.busy },
        ...(skipped && !props.skipsShown ? [{ label: "Show skipped changes", onSelect: () => actions.showSkips(mount.shareId) }] : []),
      ]
    : files && active
      ? [{ label: "Add to workspace", onSelect: () => actions.mount(shareId), disabled: props.busy }]
      : [];
  const word: Word | null = damaged ? "damaged" : removed ? "removed" : active || !row ? null : "ended";
  // The level only while the share is live and dohc knows it; else the sender alone.
  const who: Who = access && !word
    ? { text: `${sender} lets you ${verbOf(access)}`, title: `${parts.full} lets you ${verbOf(access)}` }
    : fromWho(sender, parts.full);
  const where = mount ? `In this workspace as shared-with-me/${mount.label}` : null;
  // A removal says it whole, in the relay's words, and what a copy still here does.
  const note = removed
    ? [row?.removalMessage, mount ? "Your copy stays readable but won't update." : null].filter(Boolean).join(" ") || null
    : null;
  return (
    <ShareRow
      lane="received"
      shareId={shareId}
      status={row?.status ?? (damaged ? "damaged" : removed ? "removed" : "unlisted")}
      subject={subject}
      name={shownName(subject, props.repeated)}
      who={who}
      note={note}
      word={word}
      menu={menu}
      mark={where ? (
        <span role="img" aria-label={where} title={where} data-testid="sharing-mounted" className="shrink-0 text-subtle">
          <FolderInput size={13} aria-hidden />
        </span>
      ) : undefined}
    >
      {mount && props.skipsShown ? <SkippedChanges mount={mount} actions={actions} /> : null}
    </ShareRow>
  );
}

/** Whether a mount's skipped changes show: unseen ones until dismissed, seen
 * ones once the row's menu asks for them. */
export function skipsShown(mount: ShareMount | undefined, view: SkipView): boolean {
  if (!mount?.skippedOps) return false;
  const skipped = mount.skippedOps;
  const state = view.get(mount.shareId);
  if (state === "shown") return true;
  // A change skipped after the Dismiss shows again on its own.
  return hasUnacknowledgedShareSkips(skipped) && !(typeof state === "number" && state >= skipped.generation);
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
  // Rows this computer knows without the listing: they show whatever it says.
  local?: (known: boolean) => ReactNode[];
}) {
  const { lane, view, actions } = props;
  const words = LANE[lane];
  const known = view.status === "ready" && view.answer.freshness !== "unknown" && view.answer.coverage.kind !== "unavailable";
  const local = view.status === "loading" ? [] : props.local?.(known) ?? [];
  const localList = local.length > 0 ? <ul className="m-0 list-none p-0">{local}</ul> : null;
  return (
    <section data-testid={`sharing-${lane}`} aria-label={words.label} className="not-first:mt-4">
      <h3 tabIndex={-1} data-sharing-lane-focus
        className="dohc-section-label m-0 flex h-6 items-center rounded-md px-3">
        {words.label}
        {known ? (
          <span data-testid={`sharing-${lane}-count`} className="ml-auto text-[11px] font-normal tabular-nums normal-case tracking-normal">
            {countOf(lane, view.answer)}
          </span>
        ) : null}
      </h3>
      <div className="px-1 pb-1">
        {view.status === "loading" ? (
          <SkeletonLines rows={2} className="px-2 py-1" />
        ) : view.status === "failed" ? (
          <>
            <RetryRow testId={`sharing-${lane}-failed`} onRetry={() => actions.retry(lane)}>{words.failed}</RetryRow>
            {localList}
          </>
        ) : (
          <div data-testid={`sharing-${lane}-answer`} data-freshness={view.answer.freshness} data-coverage={view.answer.coverage.kind}>
            {!known ? (
              <>
                <AccessUnknown testId={`sharing-${lane}`} unexplained={words.unexplained} signedOut={words.signedOut} answer={view.answer}
                  setup={props.setup} onRetry={() => actions.retry(lane)} />
                {localList}
              </>
            ) : (
              <>
                <AccessChecked testId={`sharing-${lane}-freshness`} answer={view.answer} scope={words.scope} />
                {view.answer.rows.length === 0 && local.length === 0 ? (
                  <div className="flex py-4">
                    <EmptyState data-testid={`sharing-${lane}-empty`} picture={EMPTY_ART.shares} title={words.empty} />
                  </div>
                ) : (
                  <ul className="m-0 list-none p-0">{props.children(view.answer)}{local}</ul>
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
  skipView: SkipView;
  invitations: boolean;
  confirmShareId: string | null;
  busyShareId: string | null;
  actions: SharingActions;
  ref?: Ref<HTMLDivElement>;
}) {
  const { actions, mounts, received } = props;
  const receivedRows = received.status === "ready" ? received.answer.rows.filter((row): row is AccessShareRow => row.kind === "share") : [];
  const mountOf = (shareId: string) => mounts.find((mount) => mount.shareId === shareId);
  // Mounts on this computer the listing does not name.
  const unlistedMounts = mounts.filter((mount) => !receivedRows.some((row) => row.shareId === mount.shareId));
  const receivedRepeated = repeatedNames([
    // A grant that no longer says what it covered goes by its folder's name, as its row does.
    ...receivedRows.map((row) => {
      const mount = mountOf(row.shareId);
      return mount && !row.selector ? mount.label : shareSubject(row).name;
    }),
    ...unlistedMounts.map((mount) => mount.label),
  ]);
  const receivedRow = (row: AccessShareRow | null, mount: ShareMount | undefined, listed: boolean) => (
    <ReceivedRow key={row ? `${row.shareId}\0${row.grantId}` : `mount\0${mount!.shareId}`} row={row} mount={mount}
      repeated={receivedRepeated} listed={listed} skipsShown={skipsShown(mount, props.skipView)}
      busy={props.busyShareId === (row?.shareId ?? mount!.shareId)} actions={actions} />
  );
  // Only a whole listing can say the relay no longer lists a mount; a
  // partial one may on a later page.
  const unlisted = (known: boolean) => {
    const listed = known && received.status === "ready" && received.answer.nextCursor === null;
    return unlistedMounts.map((mount) => receivedRow(null, mount, listed));
  };
  return (
    <div ref={props.ref} data-testid="sharing-view" className="min-h-0 flex-1 overflow-y-auto pb-2 pt-2">
      {props.conflictCount !== null ? (
        <div data-testid="sharing-conflicts" className="mx-1 flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
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
          {(answer) => {
            const groups = groupShares(answer.rows);
            const repeated = repeatedNames(groups.map((group) => shareSubject(liveGrant(group)).name));
            return groups.map((group) => (
              <GrantedRow key={group.shareId} group={group} repeated={repeated} waiting={props.waiting.get(group.shareId)}
                invitations={props.invitations} confirming={props.confirmShareId === group.shareId}
                busy={props.busyShareId === group.shareId} actions={actions} />
            ));
          }}
        </Section>
      ) : null}
      <Section lane="received" view={received} setup={props.receivedSetup} actions={actions} local={unlisted}>
        {() => receivedRows.map((row) => receivedRow(row, mountOf(row.shareId), true))}
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
  // A mount was added or its record changed: the shell reads mounts again.
  onMountsChanged: () => void;
  onUnmount: (path: string) => Promise<void>;
  shareRemovals: ShareRemovalNotices;
  // Counts the shell's share removals and Undos.
  sharesRevision: number;
  reportError: (fallback: string, error: unknown, retry: () => void) => void;
  // What to focus once its lane answers, as Settings search asked.
  focus: SharingFocus | null;
  onFocused: () => void;
}) {
  const { workspaceId, context, focus, onFocused } = props;
  const { facts, openSyncSettings, connect } = context;
  const refresh = useCallback(
    () => bridge().requestAccessRefresh({ workspaceId, reason: "sharing-open" }).catch(() => undefined),
    [workspaceId],
  );
  const granted = useSharingLane(workspaceId, "granted", props.notices, refresh);
  const received = useSharingLane(workspaceId, "received", props.notices, refresh);
  const [confirmShareId, setConfirmShareId] = useState<string | null>(null);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [skipView, setSkipView] = useState<SkipView>(new Map());
  // Bumped when the view closes, so a late answer leaves the view's own state alone.
  const epoch = useRequestSequence([workspaceId]);
  const panel = useRef<HTMLDivElement>(null);

  // Settings search opened the view on a row or a lane. Focus it once its
  // lane has answered; a share the lane no longer lists focuses the lane.
  const focusView = focus ? (focus.lane === "granted" ? granted.view : received.view) : null;
  useEffect(() => {
    if (!focus || !focusView || focusView.status === "loading") return;
    const lane = panel.current?.querySelector<HTMLElement>(`[data-testid="sharing-${focus.lane}"]`);
    const row = focus.shareId === null ? null : [...lane?.querySelectorAll<HTMLElement>(`[data-testid="sharing-${focus.lane}-row"]`) ?? []]
      .find((element) => element.dataset.shareId === focus.shareId);
    const rowTarget = row?.querySelector<HTMLElement>("[data-sharing-row-focus]");
    const target = rowTarget ?? lane?.querySelector<HTMLElement>("[data-sharing-lane-focus]");
    // A row takes focus only for this jump, so a click never leaves it selected.
    if (rowTarget) {
      rowTarget.tabIndex = -1;
      rowTarget.addEventListener("blur", () => rowTarget.removeAttribute("tabindex"), { once: true });
    }
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused();
  }, [focus, focusView, onFocused]);

  // Copy invitation shows only once this server has made one: the relay
  // makes them only when its browser deployment is set up. One probe per
  // view open, for the first row that could have one; only the answer's
  // yes or no is kept, never the link.
  const [invitations, setInvitations] = useState(false);
  const probed = useRef(false);
  // Mount-only, so StrictMode's replay sets it again before the probe answers.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const grantedView = granted.view;
  useEffect(() => {
    if (probed.current || grantedView.status !== "ready") return;
    const grant = groupShares(grantedView.answer.rows).map((group) => copiesOf(group).invitation).find((row) => row !== null);
    if (!grant) return;
    // A started probe stands for the view's life; a lane reload does not ask again.
    probed.current = true;
    bridge().getShareCopyDetails({ shareId: grant.shareId, grantId: grant.grantId }).then((details) => {
      if (mounted.current) setInvitations(details.status === "active" && !!details.browserInvitationUrl);
    }, () => undefined);
  }, [grantedView]);

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
  // A share ended or came back while the view was open, from any surface or
  // from a Notices Try again or Undo.
  const readRevision = useRef(props.sharesRevision);
  useEffect(() => {
    if (readRevision.current === props.sharesRevision) return;
    readRevision.current = props.sharesRevision;
    if (!props.shareView) void loadGranted({ refreshed: refresh() });
  }, [loadGranted, props.shareView, props.sharesRevision, refresh]);

  const setupFor = useCallback(
    (lane: SharingLane): AccessSetup => ({ reason: accessReasonForLane(facts, lane), openSyncSettings, connect }),
    [connect, facts, openSyncSettings],
  );
  const waiting = useMemo(() => waitingByShare(props.proposals), [props.proposals]);

  // An action's outcome reaches the shell even after the view closes; the
  // shell lives for one workspace. Only the view's own state checks `epoch`.
  async function end(group: ShareGroup) {
    if (!group.rows.some(endsOnEnd)) return;
    const token = epoch.current();
    const subject = `the share of ${subjectOf(liveGrant(group)).title} with ${recipientsOf(group)}`;
    setBusyShareId(group.shareId);
    try {
      const result = await bridge().revokeRelayShare({ shareId: group.shareId });
      // The shell counts the removal and its Undo; the open view reads again then.
      props.shareRemovals.removed({
        workspaceId,
        shareId: group.shareId,
        undo: result.undo,
        message: result.undo ? `Ended ${subject}.` : `${subject[0]!.toUpperCase()}${subject.slice(1)} has already ended.`,
        restoredMessage: `Restored ${subject}.`,
      });
      if (epoch.isCurrent(token)) setConfirmShareId(null);
    } catch (cause) {
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
      if ("chats" in found) throw new Error("Join this from Chats.");
      await bridge().mountShare({ workspaceId, shareCode: found.share.shareCode });
      props.onMountsChanged();
    } catch (cause) {
      props.reportError("dohc could not add this share to the workspace.", cause, () => void mount(shareId));
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

  // A share that ended since the list was read has nothing to copy. The row
  // is stale, not the person's to fix: read the list again, copy nothing.
  async function copy(grant: AccessShareRow, what: CopyWhat): Promise<string | null> {
    const token = epoch.current();
    const details = await bridge().getShareCopyDetails({ shareId: grant.shareId, grantId: grant.grantId });
    // The view closed while main answered: hand out nothing, read nothing.
    if (!epoch.isCurrent(token)) return null;
    if (details.status === "ended") {
      void loadGranted({ refreshed: refresh() });
      return null;
    }
    if (what === "code") return details.shareCode;
    if (!details.browserInvitationUrl) throw new Error("This server does not make browser invitations.");
    return details.browserInvitationUrl;
  }

  // Dismissing marks the skipped changes seen and keeps the record, so the
  // row's menu can show them again.
  const setSkip = (shareId: string, state: SkipState | null) =>
    setSkipView((view) => {
      const next = new Map(view);
      if (state === null) next.delete(shareId);
      else next.set(shareId, state);
      return next;
    });
  async function dismissSkips(target: ShareMount) {
    const skipped = target.skippedOps;
    if (!skipped) return;
    const token = epoch.current();
    setSkip(target.shareId, skipped.generation);
    if (!hasUnacknowledgedShareSkips(skipped)) return;
    try {
      await bridge().dismissShareSkips({ workspaceId, shareId: target.shareId, generation: skipped.generation });
      props.onMountsChanged();
    } catch (cause) {
      if (epoch.isCurrent(token)) setSkip(target.shareId, null);
      props.reportError("dohc could not dismiss the skipped changes.", cause, () => void dismissSkips(target));
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
    copy,
    dismissSkips: (target) => void dismissSkips(target),
    showSkips: (shareId) => setSkip(shareId, "shown"),
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
      skipView={skipView}
      invitations={invitations}
      confirmShareId={confirmShareId}
      busyShareId={busyShareId}
      actions={actions}
      ref={panel}
    />
  );
}
