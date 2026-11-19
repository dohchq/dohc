import type { AccessAnswer, AccessShareRow } from "@dohc/workspace-contracts/access";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import {
  ChevronRight,
  File,
  FileDiff,
  FolderInput,
  Layers,
  MessageSquare,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ShareAccess, ShareProposalRow, WorkspaceSummary } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { accessOptions } from "../EmailShareForm";
import { ipcErrorMessage } from "../ipcError";
import { opensForLiveEditing } from "../OpenSharedView";
import type { RelayShareTarget } from "../RelayShareDialog";
import { invitedByEmailWords, SHARE_ACCESS_WORDS, ShareAccessMenu } from "../shareAccess";
import { shareSenderParts } from "../ShareSender";
import { BROWSER_INVITATION_SECRET, SHARE_CODE_SECRET } from "../shareCopySecrets";
import { hasUnacknowledgedShareSkips, shareSkipNoticeLines } from "../shareSkipNotice";
import type { ShareRemovalNotices } from "../shell/useShareRemovalNotices";
import { ShellErrorReporter, ShellNoticeClear } from "../shell/useShellError";
import {
  DangerButton,
  EmptyState,
  GhostButton,
  Pill,
  RetryRow,
  SecondaryButton,
} from "../ui/controls";
import { COPY_WORDS, createCopy, type CopyFeedback, type CopySecret } from "../ui/CopyButton";
import { KindGlyph } from "../ui/KindGlyph";
import { Menu } from "../ui/Menu";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { NameLine } from "../ui/NameLine";
import { useRadioGroup } from "../ui/SegmentedControl";
import { SkeletonLines } from "../ui/SkeletonRows";
import { notSentWords } from "../notSentWords";
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
import { neutralPresentation } from "./actorPresentation";
import { ChatAvatar, LinkMark } from "./ChatAvatar";
import { EMPTY_ART } from "./EmptyArt";
import { shareSubject } from "./shareSubject";

// The Sharing view: what this workspace shares, by what is shared, and what
// was shared with the person's account, by who shared it. One list shows at
// a time. Each is pinned to what it covers and when main checked it, so an
// empty list means "none within this coverage", never "nothing is shared".

export type SharingLane = "granted" | "received";
export type ShareMount = NonNullable<WorkspaceSummary["shareMounts"]>[number];
export type ShareGroup = { shareId: string; rows: AccessShareRow[] };
export type WaitingChanges = {
  count: number;
  senders: string[];
  oldestProposalId: string;
  oldestAtMs: number;
};
// A row, or a lane's heading when no share is named, to focus on opening.
export type SharingFocus = { lane: SharingLane; shareId: string | null };
export type CopyWhat = "code" | "invitation";
export type ChangedAccess = { access: ShareAccess; generation: number };
export type AccessChange = { asked: ShareAccess | null; answered: ChangedAccess | null };
export type AccessChanges = Readonly<Record<string, AccessChange>>;
export type OpenedShare = { shareId: string; shareCode: string; liveEditing: boolean };
export type SharingLaneView =
  | AccessView
  | { status: "ready"; answer: AccessAnswer; moreFailed: true };
const accessNoticeIdentity = (grantId: string) => `share-access:${grantId}`;
// Whether a mount's skipped changes show, against what its record says:
// shown on request, or hidden up to the generation a Dismiss covered.
type SkipState = "shown" | number;
export type SkipView = ReadonlyMap<string, SkipState>;

const LANE = {
  granted: {
    label: "Shared by me",
    scope: "for this workspace",
    empty: "Nothing shared from this workspace yet.",
    unexplained:
      "Access information is unavailable for this workspace. This does not mean that nothing is shared.",
    signedOut: SIGNED_OUT_ACCESS,
    failed: "dohc could not check the shares from this workspace.",
    moreFailed: "dohc could not load more shares from this workspace.",
  },
  // What others shared with the account. It needs a signed-in account, never
  // this workspace's sync, so signed out is the only cause it names.
  received: {
    label: "Shared with me",
    scope: "for your account",
    empty: "Nothing shared with you yet.",
    unexplained:
      "Access information is unavailable for your account. This does not mean that nothing is shared with you.",
    signedOut: "Connect a server to get what others share with you.",
    failed: "dohc could not check the shares to your account.",
    moreFailed: "dohc could not load more shares to your account.",
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
export function waitingByShare(
  proposals: readonly ShareProposalRow[],
): Map<string, WaitingChanges> {
  const waiting = new Map<string, WaitingChanges>();
  for (const proposal of proposals) {
    const seen = waiting.get(proposal.shareId);
    const older = !seen || proposal.createdAtMs < seen.oldestAtMs;
    // The relay may not know who sent a change; it stays counted.
    const sender = proposal.proposedByEmail ?? "someone";
    waiting.set(proposal.shareId, {
      count: (seen?.count ?? 0) + 1,
      senders: seen?.senders.includes(sender) ? seen.senders : [...(seen?.senders ?? []), sender],
      oldestProposalId: older ? proposal.proposalId : seen.oldestProposalId,
      oldestAtMs: older ? proposal.createdAtMs : seen.oldestAtMs,
    });
  }
  return waiting;
}

type Subject = { glyph: ReactNode; name: string; folder: string | null; title: string };
const GLYPH_CLASS = "shrink-0 text-subtle";

// What a share covers: its glyph, its name, and the folder it sits in.
function subjectOf(row: AccessShareRow): Subject {
  const subject = shareSubject(row);
  const glyph =
    subject.kind === "damaged" ? (
      <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" />
    ) : subject.kind === "chat" ? (
      <MessageSquare size={15} aria-hidden className={GLYPH_CLASS} />
    ) : subject.kind === "version" ? (
      <Layers size={15} aria-hidden className={GLYPH_CLASS} />
    ) : subject.path ? (
      <KindGlyph kind={fileKindForPath(subject.path)} size={15} className="text-subtle" />
    ) : (
      <File size={15} aria-hidden className={GLYPH_CLASS} />
    );
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
const shareAccessOf = (access: Level): ShareAccess =>
  access === "read-only" ? "view" : access === "read-write" ? "edit" : access;
const levelWords = (access: Level) => SHARE_ACCESS_WORDS[shareAccessOf(access)];

function filesOf(row: AccessShareRow) {
  const selector = row.selector;
  return selector !== null && selector.kind === undefined ? selector : null;
}

export function sharedItemKey(row: AccessShareRow): string {
  const selector = row.selector;
  if (!selector) return `share\0${row.shareId}`;
  if (selector.kind === "chat" || selector.kind === "group")
    return `${selector.kind}\0${selector.channelWireId}`;
  return ["files", selector.versionId ?? "", ...[...new Set(selector.paths)].sort()].join("\0");
}

export const endedGroupKey = (lane: SharingLane) => `ended\0${lane}`;
export const endConfirmKey = (shareId: string) => `end\0${shareId}`;
const removeConfirmKey = (grantId: string) => `remove\0${grantId}`;
const leaveConfirmKey = (shareId: string) => `leave\0${shareId}`;

function shareTargetOf(row: AccessShareRow): RelayShareTarget | null {
  const files = filesOf(row);
  if (!files) return null;
  const [first, ...rest] = files.paths;
  if (first === undefined) return { kind: "version", versionId: files.versionId ?? "main" };
  return files.versionId === null ? { kind: "paths", paths: [first, ...rest] } : null;
}

// Who can do what, as a row's second line says it, wrapped whole. The title names each.
type Who = { text: string; title: string };

// How many links have each level, widest first: "1 link lets anyone edit".
function linkClauses(links: readonly LeveledRow[]): string[] {
  if (links.length === 1) return [`Anyone with the link can ${verbOf(links[0]!.access)}`];
  return VERBS.map((verb) => ({
    verb,
    count: links.filter((row) => verbOf(row.access) === verb).length,
  }))
    .filter(({ count }) => count > 0)
    .map(({ verb, count }) => `${count} ${count === 1 ? "link lets" : "links let"} anyone ${verb}`);
}

const widestFirst = (a: LeveledRow, b: LeveledRow) =>
  VERBS.indexOf(verbOf(a.access)) - VERBS.indexOf(verbOf(b.access));

function itemWho(people: readonly LeveledRow[], links: readonly LeveledRow[]): Who | null {
  const names = [...new Set(people.map(recipientOf))];
  const title = [
    ...(links.length > 0 ? linkClauses(links) : []),
    ...people.map((row) => `${recipientOf(row)} can ${verbOf(row.access)}`),
  ].join("\n");
  const [link] = links;
  const [widest] = people.toSorted(widestFirst);
  if (!link) {
    if (!widest) return null;
    return {
      text:
        names.length === 1 ? `${names[0]} can ${verbOf(widest.access)}` : `${names.length} people`,
      title,
    };
  }
  const article = links.length === 1 ? "the" : "a";
  if (names.length === 0)
    return { text: `Anyone with ${article} link can ${verbOf(link.access)}`, title };
  return {
    text: `${names.length} ${names.length === 1 ? "person" : "people"} and anyone with ${article} link`,
    title,
  };
}

/** The names a list shows more than once: those rows show their folder too. */
function repeatedNames(names: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

// A row's name, after its folder when another row in its list has the name too.
function shownName(subject: Subject, repeated: ReadonlySet<string>): string {
  return repeated.has(subject.name) && subject.folder
    ? `${subject.folder}${subject.name}`
    : subject.name;
}

// The grant a share's row speaks for: a live one, else one that still says
// what the share covered. An ended grant comes back without its selector.
function liveGrant(group: ShareGroup): AccessShareRow {
  return (
    group.rows.find((row) => row.status === "active" && row.selector !== null) ??
    group.rows.find((row) => row.selector !== null) ??
    group.rows[0]!
  );
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
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
    : (names[0] ?? none);
}
function recipientsOf(group: ShareGroup): string {
  return namesOf(recipientNames(group), "the recipient");
}

// A path or version share named to people ends here, and so does one dohc
// cannot read. Links and chats end where they were made.
function endable(group: ShareGroup): boolean {
  if (!group.rows.every((row) => row.via === "named")) return false;
  if (group.rows.some((row) => row.status === "damaged")) return true;
  return filesOf(liveGrant(group)) !== null && group.rows.some((row) => row.status === "active");
}

// A named person's browser invitation, where the server makes one: a live
// edit of files (`isLiveEditShareSelector` on the relay).
function invitable(row: AccessShareRow): boolean {
  const files = filesOf(row);
  return (
    row.status === "active" &&
    row.via === "named" &&
    row.access === "edit" &&
    files !== null &&
    files.versionId === null &&
    files.paths.length > 0
  );
}

function copyable(row: AccessShareRow): boolean {
  return (
    row.status === "active" &&
    filesOf(row) !== null &&
    (row.via === "named" || row.via === "dependent")
  );
}

function retunable(row: LeveledRow): row is LeveledRow & { access: ShareAccess } {
  return row.via === "named" && filesOf(row) !== null && row.access in SHARE_ACCESS_WORDS;
}

const listedSince = (row: AccessShareRow, changed: ChangedAccess) =>
  row.generation !== null && row.generation >= changed.generation;

function levelNow(row: LeveledRow, change: AccessChange | undefined): Level {
  if (change?.asked) return change.asked;
  const answered = change?.answered;
  return answered && !listedSince(row, answered) ? answered.access : row.access;
}

const changingAccess = (change: AccessChange | undefined) => !!change?.asked;
const writeUnderWay = (change: AccessChange | undefined, shareBusy: boolean) =>
  changingAccess(change) || shareBusy;
const CHANGING_ACCESS = "dohc is changing this access.";

const END_LINKS_IN_SHARE = "End links in Share.";
const NOT_ALL_SHOWN = "Not every share is shown yet. Any others stay as they are.";
const HELD_WHO: Who = {
  text: "Show more to see who has it",
  title: "dohc has not loaded all of this share yet.",
};

function endConfirmWords(
  group: ShareGroup,
  waiting: WaitingChanges | undefined,
  also: { more: boolean; link: boolean; unseen: boolean },
): string {
  const names = recipientNames(group);
  const several = also.more || names.length > 1;
  const people = also.more
    ? `${names.length} or more people`
    : several
      ? `${names.length} people`
      : "1 person";
  const link = `${also.link ? ` Anyone with the link keeps access. ${END_LINKS_IN_SHARE}` : ""}${
    also.unseen ? ` ${NOT_ALL_SHOWN}` : ""
  }`;
  if (!waiting) {
    const who = also.more || names.length > 3 ? "They" : namesOf(names, "The recipient");
    return `End this share with ${people}? ${who} ${
      several ? "keep read-only copies and stop" : "keeps a read-only copy and stops"
    } receiving updates.${link}`;
  }
  const senders = namesOf(waiting.senders, "someone");
  return `End this share with ${people} and decline ${
    waiting.count === 1 ? "1 change" : `${waiting.count} changes`
  } ${senders} sent? Undo restores the share, not the declined ${
    waiting.count === 1 ? "change" : "changes"
  }.${link}`;
}

const removable = (grant: AccessShareRow) =>
  (grant.via === "named" || grant.via === "dependent") && filesOf(grant) !== null;
const invitedOnly = (grant: AccessShareRow) =>
  grant.via === "named" && grant.recipientUserId === null;

function removalConfirmWords(grant: AccessShareRow, item: string): string {
  const what =
    grant.via === "dependent"
      ? "This ends the access they got by joining through a link. They can join again while the link is active. End the link in Share to keep them out."
      : invitedOnly(grant)
        ? "This ends the email invitation they have not used yet."
        : "This ends the access their email invitation gave. Copies they already made stay with them.";
  return `Remove ${recipientOf(grant)}'s access to ${item}? ${what}`;
}

function removalSubject(grant: AccessShareRow, title: string): string {
  return `${recipientOf(grant)}'s ${invitedOnly(grant) ? "email invitation" : "access"} to ${title}`;
}

function waitingFor(
  shares: readonly ShareGroup[],
  waiting: ReadonlyMap<string, WaitingChanges>,
): WaitingChanges | undefined {
  const found = shares.flatMap((share) => waiting.get(share.shareId) ?? []);
  const [first, ...rest] = found;
  if (!first) return undefined;
  const oldest = rest.reduce((a, b) => (b.oldestAtMs < a.oldestAtMs ? b : a), first);
  return {
    count: found.reduce((count, each) => count + each.count, 0),
    senders: [...new Set(found.flatMap((each) => each.senders))],
    oldestProposalId: oldest.oldestProposalId,
    oldestAtMs: oldest.oldestAtMs,
  };
}

type GrantedItem = {
  key: string;
  shares: ShareGroup[];
  first: AccessShareRow;
  subject: Subject;
  name: string;
  people: LeveledRow[];
  links: LeveledRow[];
  waiting: WaitingChanges | undefined;
  held: boolean;
  unfinishedShareId: string | undefined;
};
type EndedShare = {
  group: ShareGroup;
  first: AccessShareRow;
  subject: Subject;
  name: string;
  unfinished: boolean;
};

function listGranted(
  rows: AccessAnswer["rows"],
  waiting: ReadonlyMap<string, WaitingChanges>,
  more: boolean,
): { items: GrantedItem[]; ended: EndedShare[] } {
  const byKey = new Map<string, ShareGroup[]>();
  const over: ShareGroup[] = [];
  const groups = groupShares(rows);
  const unfinishedShareId = more ? groups.at(-1)?.shareId : undefined;
  for (const group of groups) {
    const live = group.rows.some((row) => row.status === "active");
    const held =
      group.shareId === unfinishedShareId && !group.rows.some((row) => row.status === "damaged");
    if (!live && !held) {
      over.push(group);
      continue;
    }
    const key = sharedItemKey(liveGrant(group));
    byKey.set(key, [...(byKey.get(key) ?? []), group]);
  }
  const drafts = [...byKey].map(([key, shares]) => {
    const first = liveGrant(shares[0]!);
    const live = shares
      .flatMap((share) => share.rows)
      .filter((row): row is LeveledRow => row.status === "active" && row.access !== null);
    return {
      key,
      shares,
      first,
      subject: subjectOf(first),
      people: live.filter((row) => row.via !== "link"),
      links: live.filter((row) => row.via === "link").sort(widestFirst),
      waiting: waitingFor(shares, waiting),
      held: !shares.some((share) => share.rows.some((row) => row.status === "active")),
      unfinishedShareId,
    };
  });
  const repeated = repeatedNames(drafts.map((draft) => draft.subject.name));
  const items = drafts
    .map((draft) => ({ ...draft, name: shownName(draft.subject, repeated) }))
    .sort(
      (a, b) =>
        Number(b.waiting !== undefined) - Number(a.waiting !== undefined) ||
        a.name.localeCompare(b.name),
    );
  const endedDrafts = over.map((group) => {
    const first = liveGrant(group);
    return { group, first, subject: subjectOf(first) };
  });
  const endedRepeated = repeatedNames(endedDrafts.map((draft) => draft.subject.name));
  return {
    items,
    ended: endedDrafts.map((draft) => ({
      ...draft,
      name: shownName(draft.subject, endedRepeated),
      unfinished: draft.group.shareId === unfinishedShareId,
    })),
  };
}

type ReceivedEntry = {
  key: string;
  shareId: string;
  row: AccessShareRow | null;
  mount: ShareMount | undefined;
  subject: Subject;
  sender: { key: string; name: string; heading: string; full: string };
  status: string;
  active: boolean;
  removed: boolean;
  damaged: boolean;
  ended: boolean;
  files: boolean;
};

// A share sent to the account, or a mount the relay no longer lists (`row`
// null). A mount with no live grant behind it reads as removed once the
// whole listing was read.
function receivedEntry(
  row: AccessShareRow | null,
  mount: ShareMount | undefined,
  listed: boolean,
): ReceivedEntry {
  const shareId = row?.shareId ?? mount!.shareId;
  const endedCopy = mount?.ended === true;
  const removed = endedCopy || (row ? row.status === "removed" : listed);
  const damaged = row ? row.status === "damaged" : mount?.damaged === true;
  const active = row?.status === "active" && !endedCopy;
  // A grant that no longer says what it covered goes by its folder's name.
  const subject: Subject =
    mount && !row?.selector
      ? {
          glyph: damaged ? (
            <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" />
          ) : (
            <File size={15} aria-hidden className={GLYPH_CLASS} />
          ),
          name: mount.label,
          folder: null,
          title: `shared-with-me/${mount.label}`,
        }
      : subjectOf(row!);
  const parts = shareSenderParts(row?.sharerName, row?.granterEmail ?? mount?.granterEmail);
  const shown = parts.displayName ?? parts.full;
  return {
    key: row ? `${row.shareId}\0${row.grantId}` : `mount\0${mount!.shareId}`,
    shareId,
    row,
    mount,
    subject,
    sender: {
      key: row?.granterUserId
        ? `user:${row.granterUserId}`
        : `label:${(parts.address ?? parts.full).toLowerCase()}`,
      name: shown,
      heading: parts.address ? shown : `${shown[0]!.toUpperCase()}${shown.slice(1)}`,
      full: parts.full,
    },
    status: endedCopy
      ? "removed"
      : (row?.status ?? (damaged ? "damaged" : removed ? "removed" : "unlisted")),
    active,
    removed,
    damaged,
    ended: removed || (row !== null && !active && !damaged),
    files: row !== null && filesOf(row) !== null,
  };
}

class NoLongerShared extends Error {}

const knownAnswer = (view: AccessView): AccessAnswer | null =>
  view.status === "ready" &&
  view.answer.freshness !== "unknown" &&
  view.answer.coverage.kind !== "unavailable"
    ? view.answer
    : null;

type SenderGroup = { sender: ReceivedEntry["sender"]; entries: ReceivedEntry[] };

function listReceived(view: AccessView, mounts: readonly ShareMount[]) {
  const known = knownAnswer(view);
  const rows =
    view.status === "ready"
      ? view.answer.rows.filter((row): row is AccessShareRow => row.kind === "share")
      : [];
  // Only a whole listing can say the relay no longer lists a mount; a
  // partial one may on a later page.
  const whole = known?.nextCursor === null;
  const entries = [
    ...(known
      ? rows.map((row) =>
          receivedEntry(
            row,
            mounts.find((mount) => mount.shareId === row.shareId),
            true,
          ),
        )
      : []),
    ...(view.status === "loading"
      ? []
      : mounts
          .filter((mount) => !rows.some((row) => row.shareId === mount.shareId))
          .map((mount) => receivedEntry(null, mount, whole))),
  ];
  const repeated = repeatedNames(entries.map((entry) => entry.subject.name));
  const bySender = new Map<string, SenderGroup>();
  for (const entry of entries) {
    if (entry.ended) continue;
    const group = bySender.get(entry.sender.key) ?? { sender: entry.sender, entries: [] };
    group.entries.push(entry);
    bySender.set(entry.sender.key, group);
  }
  const sameHeading = repeatedNames([...bySender.values()].map((group) => group.sender.heading));
  const groups = [...bySender.values()]
    .map((group) => ({
      sender: sameHeading.has(group.sender.heading)
        ? { ...group.sender, heading: group.sender.full }
        : group.sender,
      entries: group.entries.toSorted((a, b) =>
        shownName(a.subject, repeated).localeCompare(shownName(b.subject, repeated)),
      ),
    }))
    .sort(
      (a, b) =>
        a.sender.heading.localeCompare(b.sender.heading) ||
        a.sender.key.localeCompare(b.sender.key),
    );
  return {
    groups,
    ended: entries.filter((entry) => entry.ended),
    repeated,
    total: entries.length,
    live: entries.filter((entry) => entry.active).length,
  };
}

function DamagedPill() {
  return (
    <span data-testid="sharing-row-status" className="mr-1">
      <Pill tone="danger">Damaged</Pill>
    </span>
  );
}

const CARD = "mb-1 flex flex-col gap-2 rounded-lg border border-line bg-bg p-3";
const ROW_MENU_WIDTH = 200;
const ROW =
  "group relative flex w-full gap-2 rounded-md px-2 py-0.5 text-left text-[13px] text-muted transition-colors duration-75 keyboard:focus-within:bg-hover has-[[aria-haspopup=menu][aria-expanded=true]]:bg-hover";
const MARK_COLUMN = "flex h-5 w-[18px] shrink-0 items-center justify-center";
const CHEVRON_COLUMN = "flex h-5 w-3 shrink-0 items-center justify-center text-subtle";
const QUIET_LEVEL = "shrink-0 text-[12px] text-muted";

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

function Chevron(props: { open: boolean }) {
  return (
    <span className={CHEVRON_COLUMN}>
      <ChevronRight
        size={12}
        aria-hidden
        className={`transition-transform duration-150 ease-out ${props.open ? "rotate-90" : ""}`}
      />
    </span>
  );
}

function ConfirmCard(props: {
  testId: "sharing-end" | "sharing-leave";
  words: ReactNode;
  verb: string;
  running: string;
  busy: boolean;
  held?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const heldId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    cancelRef.current?.focus();
  }, []);
  const cancel = () => {
    props.onCancel();
    if (opener.current?.isConnected) opener.current.focus();
  };
  return (
    <div
      data-testid={`${props.testId}-confirm`}
      onKeyDown={(event) => {
        if (event.key === "Escape") cancel();
      }}
      className={CARD}
    >
      <p className="m-0 text-[12px] leading-4 text-ink">{props.words}</p>
      <div className="flex items-center justify-end gap-2">
        {props.held ? (
          <span
            id={heldId}
            data-testid={`${props.testId}-held`}
            className="mr-auto min-w-0 text-[12px] leading-4 text-muted"
          >
            {props.held}
          </span>
        ) : null}
        <SecondaryButton
          ref={cancelRef}
          size="compact"
          data-testid={`${props.testId}-cancel`}
          onClick={cancel}
        >
          Cancel
        </SecondaryButton>
        <DangerButton
          size="compact"
          data-testid={props.testId}
          disabled={props.busy || !!props.held}
          aria-describedby={props.held ? heldId : undefined}
          onClick={props.onConfirm}
        >
          {props.busy ? props.running : props.verb}
        </DangerButton>
      </div>
    </div>
  );
}

export type SharingActions = {
  retry: (lane: SharingLane) => void;
  more: (lane: SharingLane, answer: AccessAnswer) => void;
  reviewChanges: (proposalId: string) => void;
  startEnd: (confirmKey: string) => void;
  cancelEnd: () => void;
  end: (shares: readonly ShareGroup[]) => void;
  removePerson: (grant: AccessShareRow, title: string) => void;
  retune: (grant: AccessShareRow, access: ShareAccess, title: string) => void;
  share: ((target: RelayShareTarget) => void) | null;
  mount: (shareId: string) => void;
  unmount: (mount: ShareMount) => void;
  openToEdit: ((shareId: string) => void) | null;
  startLeave: (confirmKey: string) => void;
  leave: (shareId: string, mount: ShareMount | undefined) => void;
  clear: (shareId: string, mount: ShareMount | undefined) => void;
  // The text a copy hands out, read at the click; null when there is none.
  copy: (grant: AccessShareRow, what: CopyWhat) => Promise<string | null>;
  dismissSkips: (mount: ShareMount) => void;
  showSkips: (shareId: string) => void;
  reviewConflicts: () => void;
};

type PersonCopy = {
  id: string;
  label: string;
  secret: CopySecret;
  getText: () => Promise<string | null>;
};
type PersonRemoval = { disabled: boolean; why: string | null; onSelect: () => void };

function PersonMenu(props: {
  name: string;
  grantId: string;
  copies: readonly PersonCopy[];
  removal: PersonRemoval | null;
}) {
  const report = useContext(ShellErrorReporter);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ id: string; words: CopyFeedback } | null>(null);
  const latest = useRef({ copies: props.copies, report });
  latest.current = { copies: props.copies, report };
  const pickedId = useRef<string | null>(null);
  const answered = useRef(false);
  const usingKeyboard = useRef(false);
  const status = useRef<HTMLSpanElement>(null);
  const action = useRef<ReturnType<typeof createCopy<void>> | null>(null);
  useLayoutEffect(() => {
    const picked = () => latest.current.copies.find((copy) => copy.id === pickedId.current);
    const made = createCopy({
      getText: () => picked()?.getText() ?? null,
      report: () => latest.current.report,
      secret: () => picked()?.secret,
      show: (next) => {
        if (next && pickedId.current !== null) {
          answered.current = true;
          setFeedback({ id: pickedId.current, words: next });
          return;
        }
        if (!answered.current) return;
        answered.current = false;
        setFeedback(null);
        const focusInside =
          status.current?.closest('[role="menu"]')?.contains(document.activeElement) === true;
        if (!(usingKeyboard.current && focusInside)) setOpen(false);
      },
    });
    action.current = made;
    return () => made.dispose();
  }, []);
  const { copies, removal } = props;
  if (copies.length === 0 && !removal) return null;
  return (
    <span
      className="contents"
      onKeyDown={() => {
        usingKeyboard.current = true;
      }}
      onPointerDown={() => {
        usingKeyboard.current = false;
      }}
    >
      <Menu
        label={`Options for ${props.name}`}
        testId={`sharing-person-menu-${props.grantId}`}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) return;
          answered.current = false;
          setFeedback(null);
        }}
        closeOnPick={false}
        width={ROW_MENU_WIDTH}
        items={[
          ...copies.map((copy) => ({
            id: copy.id,
            label: feedback?.id === copy.id ? COPY_WORDS[feedback.words] : copy.label,
            onSelect: () => {
              pickedId.current = copy.id;
              void action.current?.copy();
            },
          })),
          ...(removal
            ? [
                {
                  id: "remove",
                  label: "Remove access",
                  danger: true,
                  disabled: removal.disabled,
                  ...(removal.why ? { description: removal.why } : {}),
                  onSelect: () => {
                    setOpen(false);
                    removal.onSelect();
                  },
                },
              ]
            : []),
        ]}
      >
        <span ref={status} role="status" aria-live="polite" className="sr-only">
          {feedback ? COPY_WORDS[feedback.words] : ""}
        </span>
      </Menu>
    </span>
  );
}

function PersonRow(props: {
  grant: LeveledRow;
  item: string;
  title: string;
  target: RelayShareTarget | null;
  change: AccessChange | undefined;
  confirmKey: string | null;
  busy: boolean;
  invitations: boolean;
  actions: SharingActions;
}) {
  const { grant, actions } = props;
  const name = recipientOf(grant);
  const nameId = useId();
  const access = levelNow(grant, props.change);
  const changing = changingAccess(props.change);
  const writing = writeUnderWay(props.change, props.busy);
  const offered: ReadonlyArray<{ value: ShareAccess; description?: string }> = props.target
    ? accessOptions(props.target).map(({ value, description }) => ({ value, description }))
    : [{ value: "view" }, { value: "edit" }];
  const options = (
    access === "comment"
      ? [offered[0]!, { value: "comment" as const }, ...offered.slice(1)]
      : offered
  ).map((option) => ({
    ...option,
    testId: `sharing-person-access-${grant.grantId}-${option.value}`,
  }));

  const confirmKey = removeConfirmKey(grant.grantId);
  const detail =
    filesOf(grant) === null
      ? ""
      : grant.via === "named"
        ? invitedByEmailWords(grant.recipientUserId !== null)
        : grant.via === "dependent"
          ? "Joined through a link"
          : "";
  const browserLink = invitable({ ...grant, access });
  const invitation = props.invitations && browserLink;
  const copies: PersonCopy[] = copyable(grant)
    ? [
        {
          id: "copy",
          label: grant.via === "named" ? "Copy invitation" : "Copy code",
          secret: invitation ? BROWSER_INVITATION_SECRET : SHARE_CODE_SECRET,
          getText: () => actions.copy(grant, invitation ? "invitation" : "code"),
        },
        ...(browserLink
          ? [
              {
                id: "copy-code",
                label: "Copy share code",
                secret: SHARE_CODE_SECRET,
                getText: () => actions.copy(grant, "code"),
              },
            ]
          : []),
      ]
    : [];
  return (
    <li data-testid="sharing-person" data-grant-id={grant.grantId} className="flex flex-col gap-1">
      <div className="flex min-h-8 items-center gap-2">
        <ChatAvatar presentation={neutralPresentation} name={name} kind="human" size="strip" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            id={nameId}
            data-testid="sharing-person-name"
            title={name}
            className="truncate text-[13px] text-ink"
          >
            {name}
          </span>
          <span className="text-[12px] text-subtle">{detail}</span>
        </span>
        {retunable({ ...grant, access }) ? (
          <ShareAccessMenu
            label={`Access for ${name}`}
            describedBy={nameId}
            access={shareAccessOf(access)}
            options={options}
            disabled={writing}
            testId={`sharing-person-access-${grant.grantId}`}
            width={288}
            align="end"
            onPick={(next) => {
              if (next !== access) actions.retune(grant, next, props.title);
            }}
          />
        ) : (
          <span className={QUIET_LEVEL}>{levelWords(access)}</span>
        )}
        <PersonMenu
          name={name}
          grantId={grant.grantId}
          copies={copies}
          removal={
            removable(grant)
              ? {
                  disabled: writing,
                  why: changing ? CHANGING_ACCESS : null,
                  onSelect: () => actions.startEnd(confirmKey),
                }
              : null
          }
        />
      </div>
      {removable(grant) && props.confirmKey === confirmKey ? (
        <ConfirmCard
          testId="sharing-end"
          words={removalConfirmWords(grant, props.item)}
          verb="Remove access"
          running="Removing…"
          busy={props.busy}
          held={changing ? CHANGING_ACCESS : null}
          onCancel={actions.cancelEnd}
          onConfirm={() => actions.removePerson(grant, props.title)}
        />
      ) : null}
    </li>
  );
}

function ItemRow(props: {
  item: GrantedItem;
  open: boolean;
  onToggle: () => void;
  waitingByShare: ReadonlyMap<string, WaitingChanges>;
  notSentWhileOpen: readonly string[];
  accessChanges: AccessChanges;
  confirmKey: string | null;
  busyShareIds: ReadonlySet<string>;
  invitations: boolean;
  actions: SharingActions;
}) {
  const { item, actions } = props;
  const { first, subject, waiting } = item;
  const panelId = useId();
  const noteId = `${panelId}-note`;
  const who = item.held
    ? HELD_WHO
    : itemWho(
        item.people.map((row) => ({
          ...row,
          access: levelNow(row, props.accessChanges[row.grantId]),
        })),
        item.links,
      );
  const files = filesOf(first);
  // The engine names held notes by path only, so a share of a version has none.
  const notSent =
    files && files.versionId === null ? notSentWords(files.paths, props.notSentWhileOpen) : null;
  const ending = item.shares.filter(endable);
  const busy = item.shares.some((share) => props.busyShareIds.has(share.shareId));
  const confirmKey = endConfirmKey(item.shares[0]!.shareId);
  const target = shareTargetOf(first);
  const share = actions.share;
  const linksOnly = item.links.length > 0 && ending.length === 0;
  const hasPanel =
    item.people.length + item.links.length > 0 || (target !== null && share !== null);
  const review = waiting
    ? waiting.count > 1
      ? `Review changes (${waiting.count})`
      : "Review changes"
    : null;
  const body = (
    <>
      <span className={MARK_COLUMN}>{subject.glyph}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <NameLine name={item.name} title={subject.title} className="h-5 leading-5 text-ink" />
        {who ? (
          <span
            data-testid="sharing-row-who"
            title={who.title}
            className="mt-1 text-[12px] leading-4 wrap-anywhere"
          >
            {who.text}
          </span>
        ) : null}
        {notSent ? (
          <span id={noteId} data-testid="sharing-row-note" className="mt-1 text-[12px] leading-4">
            {notSent.state} {notSent.next}
          </span>
        ) : null}
      </span>
    </>
  );
  const menu: MoreMenuItem[] = [
    ...(waiting && review
      ? [{ label: review, onSelect: () => actions.reviewChanges(waiting.oldestProposalId) }]
      : []),
    ...(ending.length > 0
      ? [
          {
            label: "End share…",
            onSelect: () => actions.startEnd(confirmKey),
            disabled: busy,
            danger: true,
          },
        ]
      : []),
  ];
  return (
    <li
      data-testid="sharing-granted-row"
      data-share-id={item.shares[0]!.shareId}
      data-share-ids={item.shares.map((each) => each.shareId).join(" ")}
      data-status={item.held ? "unconfirmed" : "active"}
    >
      <div
        role="group"
        aria-label={[item.name, who?.text].filter(Boolean).join(", ")}
        {...(hasPanel
          ? {}
          : {
              tabIndex: 0,
              "data-sharing-row-focus": true,
              "aria-describedby": notSent ? noteId : undefined,
            })}
        className={`${ROW} min-h-10 ${hasPanel ? "dohc-row-open" : "hover:bg-hover dohc-focus-row"} ${who || notSent ? "items-start" : "items-center"}`}
      >
        {hasPanel ? (
          <button
            type="button"
            data-sharing-row-focus
            data-testid="sharing-item-toggle"
            title={subject.title}
            aria-expanded={props.open}
            aria-controls={props.open ? panelId : undefined}
            aria-describedby={notSent ? noteId : undefined}
            onClick={props.onToggle}
            className="dohc-row-open-target flex min-w-0 flex-1 items-start gap-2 text-left"
          >
            <Chevron open={props.open} />
            {body}
          </button>
        ) : (
          <span title={subject.title} className="flex min-w-0 flex-1 items-start gap-2">
            <span className={CHEVRON_COLUMN} />
            {body}
          </span>
        )}
        {waiting && review ? (
          <button
            type="button"
            data-testid="sharing-review"
            aria-label={review}
            title="Review changes"
            onClick={() => actions.reviewChanges(waiting.oldestProposalId)}
            className="flex h-5 shrink-0 items-center gap-1 rounded-full border border-line bg-panel-2 px-1.5 text-[11px] tabular-nums text-muted hover:bg-hover hover:text-ink"
          >
            <FileDiff size={11} aria-hidden />
            {waiting.count}
          </button>
        ) : null}
        {menu.length > 0 ? (
          <span data-testid="sharing-granted-actions" className={ROW_ACTIONS}>
            <MoreMenu
              label="Share actions"
              testId="sharing-granted-menu"
              items={menu}
              width={ROW_MENU_WIDTH}
            />
          </span>
        ) : null}
      </div>
      {props.confirmKey === confirmKey && ending.length > 0 ? (
        <ConfirmCard
          testId="sharing-end"
          words={endConfirmWords(
            { shareId: confirmKey, rows: ending.flatMap((each) => each.rows) },
            waitingFor(ending, props.waitingByShare),
            {
              more: ending.some((each) => each.shareId === item.unfinishedShareId),
              link: item.links.length > 0,
              unseen: item.unfinishedShareId !== undefined,
            },
          )}
          verb="End share"
          running="Ending…"
          busy={busy}
          onCancel={actions.cancelEnd}
          onConfirm={() => actions.end(ending)}
        />
      ) : null}
      {props.open && hasPanel ? (
        <div
          id={panelId}
          data-testid="sharing-item-people"
          className="mb-2 ml-5 flex flex-col gap-1 pl-2 pr-1"
        >
          <ul aria-label={`Who has ${item.name}`} className="m-0 flex list-none flex-col p-0">
            {item.people.map((grant) => (
              <PersonRow
                key={grant.grantId}
                grant={grant}
                item={item.name}
                title={subject.title}
                target={target}
                change={props.accessChanges[grant.grantId]}
                confirmKey={props.confirmKey}
                busy={props.busyShareIds.has(grant.shareId)}
                invitations={props.invitations}
                actions={actions}
              />
            ))}
            {item.links.map((link) => (
              <li
                key={link.grantId}
                data-testid="sharing-link"
                className="flex min-h-8 items-center gap-2"
              >
                <LinkMark />
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
                  Anyone with the link
                </span>
                <span className={QUIET_LEVEL}>{levelWords(link.access)}</span>
              </li>
            ))}
          </ul>
          {linksOnly ? (
            <p data-testid="sharing-links-note" className="m-0 text-[12px] leading-4 text-muted">
              {END_LINKS_IN_SHARE}
            </p>
          ) : null}
          {target && share ? (
            <GhostButton
              data-testid="sharing-open-share"
              className="-ml-2 self-start"
              onClick={() => share(target)}
            >
              Open Share…
            </GhostButton>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function EndedGrantedRow(props: {
  ended: EndedShare;
  waiting: WaitingChanges | undefined;
  confirmKey: string | null;
  busy: boolean;
  actions: SharingActions;
}) {
  const { group, first, subject, name } = props.ended;
  const { actions } = props;
  const damaged = first.status === "damaged";
  const confirmKey = endConfirmKey(group.shareId);
  const canEnd = endable(group);
  const people = [...new Set(group.rows.filter((row) => row.via !== "link").map(recipientOf))];
  const who =
    people.length > 0
      ? `With ${namesOf(people, "")}`
      : group.rows.some((row) => row.via === "link")
        ? "With anyone who had the link"
        : null;
  return (
    <li
      data-testid="sharing-granted-row"
      data-share-id={group.shareId}
      data-share-ids={group.shareId}
      data-status={first.status}
    >
      <div
        role="group"
        aria-label={[name, damaged ? "Damaged" : null, who].filter(Boolean).join(", ")}
        data-sharing-row-focus
        className={`${ROW} min-h-8 items-start pl-7 hover:bg-hover dohc-focus-row`}
      >
        <span className={MARK_COLUMN}>{subject.glyph}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <NameLine name={name} title={subject.title} className="h-5 leading-5" />
          {damaged || who ? (
            <span className="mt-1 text-[12px] leading-4 wrap-anywhere">
              {damaged ? <DamagedPill /> : null}
              {who ? <span data-testid="sharing-row-who">{who}</span> : null}
            </span>
          ) : null}
        </span>
        {canEnd ? (
          <span data-testid="sharing-granted-actions" className={ROW_ACTIONS}>
            <MoreMenu
              label="Share actions"
              testId="sharing-granted-menu"
              width={ROW_MENU_WIDTH}
              items={[
                {
                  label: "End share…",
                  onSelect: () => actions.startEnd(confirmKey),
                  disabled: props.busy,
                  danger: true,
                },
              ]}
            />
          </span>
        ) : null}
      </div>
      {props.confirmKey === confirmKey && group.rows.some(endsOnEnd) ? (
        <ConfirmCard
          testId="sharing-end"
          words={endConfirmWords(group, props.waiting, {
            more: props.ended.unfinished,
            link: false,
            unseen: false,
          })}
          verb="End share"
          running="Ending…"
          busy={props.busy}
          onCancel={actions.cancelEnd}
          onConfirm={() => actions.end([group])}
        />
      ) : null}
    </li>
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
      <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
        {shareSkipNoticeLines(skipped, props.mount.granterEmail).map((line) => (
          <li
            key={line.kind}
            data-testid="sharing-skipped"
            data-kind={line.kind}
            className="flex items-start gap-1.5"
          >
            <TriangleAlert size={13} aria-hidden className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 leading-4" title={line.detail ?? line.text}>
              {line.text}
            </span>
          </li>
        ))}
      </ul>
      <SecondaryButton
        size="compact"
        className="self-end"
        data-testid="sharing-skipped-dismiss"
        aria-label="Dismiss skipped changes"
        onClick={(event) => {
          const row = event.currentTarget.closest("li");
          (
            row?.querySelector<HTMLElement>('[data-testid="sharing-received-menu"]') ??
            row?.querySelector<HTMLElement>('[data-testid="sharing-row-primary"]')
          )?.focus();
          props.actions.dismissSkips(props.mount);
        }}
      >
        Dismiss
      </SecondaryButton>
    </div>
  );
}

type RowAction = { label: string; onSelect: () => void };

function receivedActions(
  entry: ReceivedEntry,
  skipsHidden: boolean,
  actions: SharingActions,
): { primary: RowAction | null; menu: MoreMenuItem[] } {
  const { row, mount, shareId } = entry;
  const showSkips: MoreMenuItem[] =
    mount?.skippedOps && skipsHidden
      ? [{ label: "Show skipped changes", onSelect: () => actions.showSkips(shareId) }]
      : [];
  if (entry.ended) {
    const primary = mount
      ? {
          label: "Remove from workspace",
          onSelect: () =>
            row?.status === "removed" ? actions.clear(shareId, mount) : actions.unmount(mount),
        }
      : row && entry.removed
        ? { label: "Remove from list", onSelect: () => actions.clear(shareId, undefined) }
        : null;
    return { primary, menu: showSkips };
  }
  const live = entry.files && entry.active;
  const openToEdit = actions.openToEdit;
  const files = row ? filesOf(row) : null;
  const editable =
    live &&
    openToEdit !== null &&
    row?.access === "edit" &&
    (files?.versionId === null || files?.versionId === "main");
  const add: RowAction | null =
    live && !mount ? { label: "Add to workspace", onSelect: () => actions.mount(shareId) } : null;
  return {
    primary: editable ? { label: "Open to edit", onSelect: () => openToEdit(shareId) } : add,
    menu: [
      ...(editable && add ? [add] : []),
      ...(mount
        ? [{ label: "Remove from workspace", onSelect: () => actions.unmount(mount) }]
        : []),
      ...showSkips,
      ...(live
        ? [
            {
              label: "Leave share…",
              onSelect: () => actions.startLeave(leaveConfirmKey(shareId)),
              danger: true,
            },
          ]
        : []),
    ],
  };
}

function ReceivedRow(props: {
  entry: ReceivedEntry;
  repeated: ReadonlySet<string>;
  skipsShown: boolean;
  confirming: boolean;
  busy: boolean;
  actions: SharingActions;
}) {
  const { entry, actions } = props;
  const { row, mount, subject, sender, shareId } = entry;
  const name = shownName(subject, props.repeated);
  // A mounted share shows its pinned level: the pin is what its pulls enforce.
  const access = entry.ended ? null : mount ? (mount.damaged ? null : mount.access) : row?.access;
  const { primary, menu } = receivedActions(entry, !props.skipsShown, actions);
  const where =
    mount && !entry.ended
      ? access === "edit" || row?.access === "edit"
        ? "In this workspace as a read-only copy"
        : "In this workspace"
      : null;
  const from = entry.ended ? `From ${sender.name}` : null;
  const note = entry.removed
    ? [row?.removalMessage, mount ? "Your copy stays readable but won't update." : null]
        .filter(Boolean)
        .join(" ") || null
    : null;
  const noteId = `${useId()}-note`;
  const second = entry.damaged || from;
  return (
    <li data-testid="sharing-received-row" data-share-id={shareId} data-status={entry.status}>
      <div
        role="group"
        aria-label={[
          name,
          entry.damaged ? "Damaged" : null,
          access ? levelWords(access) : null,
          `from ${sender.name}`,
          where,
        ]
          .filter(Boolean)
          .join(", ")}
        aria-describedby={note ? noteId : undefined}
        data-sharing-row-focus
        className={`${ROW} min-h-8 hover:bg-hover dohc-focus-row ${entry.ended ? "pl-7" : ""} ${second || where || note || primary ? "items-start" : "items-center"}`}
      >
        <span className={MARK_COLUMN}>{subject.glyph}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <NameLine
              name={name}
              title={subject.title}
              className={`flex-1 leading-5 ${entry.ended ? "" : "text-ink"}`}
            />
            {access ? (
              <span data-testid="sharing-row-level" className={QUIET_LEVEL}>
                {levelWords(access)}
              </span>
            ) : null}
          </span>
          {second ? (
            <span className="mt-1 text-[12px] leading-4 wrap-anywhere">
              {entry.damaged ? <DamagedPill /> : null}
              {from ? (
                <span data-testid="sharing-row-who" title={`From ${sender.full}`}>
                  {from}
                </span>
              ) : null}
            </span>
          ) : null}
          {where ? (
            <span
              data-testid="sharing-mounted"
              title={`shared-with-me/${mount!.label}`}
              className="mt-1 flex items-start gap-1 text-[12px] leading-4"
            >
              <FolderInput size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
              {where}
            </span>
          ) : null}
          {note ? (
            <span id={noteId} data-testid="sharing-row-note" className="mt-1 text-[12px] leading-4">
              {note}
            </span>
          ) : null}
          {primary ? (
            <SecondaryButton
              size="row"
              data-testid="sharing-row-primary"
              className="my-1 self-start"
              disabled={props.busy}
              onClick={primary.onSelect}
            >
              {primary.label}
            </SecondaryButton>
          ) : null}
        </span>
        {menu.length > 0 ? (
          <span data-testid="sharing-received-actions" className="flex h-5 shrink-0 items-center">
            <MoreMenu
              label="Share actions"
              testId="sharing-received-menu"
              items={menu.map((item) => ({
                ...item,
                disabled: props.busy && item.label !== "Show skipped changes",
              }))}
              width={ROW_MENU_WIDTH}
            />
          </span>
        ) : entry.ended ? null : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
      </div>
      {mount && props.skipsShown ? <SkippedChanges mount={mount} actions={actions} /> : null}
      {props.confirming && entry.files && entry.active ? (
        <ConfirmCard
          testId="sharing-leave"
          words={`Leave this share? You lose access to ${subject.name}${
            mount ? ", and its folder leaves this workspace" : ""
          }. ${sender.heading} can share it with you again.`}
          verb="Leave share"
          running="Leaving…"
          busy={props.busy}
          onCancel={actions.cancelEnd}
          onConfirm={() => actions.leave(shareId, mount)}
        />
      ) : null}
    </li>
  );
}

function SenderRows(props: { group: SenderGroup; children: ReactNode }) {
  const { sender } = props.group;
  const headingId = useId();
  return (
    <li data-testid="sharing-sender" data-sender={sender.key} className="not-first:mt-3">
      <h4
        id={headingId}
        title={sender.full}
        className="m-0 flex h-7 items-center gap-2 px-2 text-[12px] font-medium text-muted"
      >
        <ChatAvatar
          presentation={neutralPresentation}
          name={sender.heading}
          kind="human"
          size="strip"
        />
        <span className="min-w-0 truncate">{sender.heading}</span>
      </h4>
      <ul aria-labelledby={headingId} className="m-0 list-none p-0">
        {props.children}
      </ul>
    </li>
  );
}

function EndedGroup(props: {
  lane: SharingLane;
  count: number;
  open: boolean;
  onToggle: () => void;
  damaged?: number;
  children: ReactNode;
}) {
  const listId = useId();
  if (props.count === 0) return null;
  const damaged = props.damaged ?? 0;
  return (
    <div data-testid={`sharing-${props.lane}-ended`} className="mt-4">
      <button
        type="button"
        data-testid={`sharing-${props.lane}-ended-toggle`}
        aria-expanded={props.open}
        aria-controls={props.open ? listId : undefined}
        onClick={props.onToggle}
        className="dohc-focus-row flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
      >
        <Chevron open={props.open} />
        Ended
        <span
          data-testid={`sharing-${props.lane}-ended-count`}
          className="text-[11px] font-normal tabular-nums"
        >
          {props.count}
        </span>
        {damaged > 0 ? (
          <span
            role="img"
            aria-label={damaged === 1 ? "1 damaged share" : `${damaged} damaged shares`}
            title={damaged === 1 ? "1 damaged share" : `${damaged} damaged shares`}
            className="flex text-danger"
          >
            <TriangleAlert size={12} aria-hidden />
          </span>
        ) : null}
      </button>
      {props.open ? (
        <ul id={listId} aria-label="Ended" className="m-0 list-none p-0">
          {props.children}
        </ul>
      ) : null}
    </div>
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
  return (
    hasUnacknowledgedShareSkips(skipped) &&
    !(typeof state === "number" && state >= skipped.generation)
  );
}

const LANES: ReadonlyArray<{ value: SharingLane; label: string }> = [
  { value: "granted", label: LANE.granted.label },
  { value: "received", label: LANE.received.label },
];

// What a lane shows now, apart from its Ended group. "24+" while more can
// load, read as "24 or more shares".
function LaneCount(props: { lane: SharingLane; count: number; more: boolean }) {
  return (
    <span
      data-testid={`sharing-${props.lane}-count`}
      className="text-[11px] font-normal tabular-nums text-muted"
    >
      {props.more ? (
        <>
          <span aria-hidden>{props.count}+</span>
          <span className="sr-only">{props.count} or more shares</span>
        </>
      ) : (
        props.count
      )}
    </span>
  );
}

function LaneSwitch(props: {
  lane: SharingLane;
  onChange: (lane: SharingLane) => void;
  counts: Record<SharingLane, ReactNode>;
}) {
  const group = useRadioGroup({ value: props.lane, options: LANES, onChange: props.onChange });
  return (
    <div
      role="radiogroup"
      aria-label="Sharing"
      data-testid="sharing-lanes"
      onKeyDown={group.onKeyDown}
      className="mx-3 mb-2 flex rounded-lg border border-line bg-panel-2 p-0.5"
    >
      {LANES.map((option, index) => (
        <button
          key={option.value}
          {...group.radio(index)}
          data-testid={`sharing-lane-${option.value}`}
          data-sharing-lane-focus={option.value}
          className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
            props.lane === option.value ? "bg-bg text-ink shadow-sm" : "text-muted hover:text-ink"
          }`}
        >
          <span className="truncate">{option.label}</span>
          {props.counts[option.value]}
        </button>
      ))}
    </div>
  );
}

function Lane(props: {
  lane: SharingLane;
  view: SharingLaneView;
  setup: AccessSetup;
  actions: SharingActions;
  heading: ReactNode;
  empty: boolean;
  local?: ReactNode;
  ended?: ReactNode;
  children: ReactNode;
}) {
  const { lane, view, actions } = props;
  const words = LANE[lane];
  return (
    <section data-testid={`sharing-${lane}`} aria-label={words.label}>
      {props.heading}
      <div className="px-1 pb-1">
        {view.status === "loading" ? (
          <SkeletonLines rows={2} className="px-2 py-1" />
        ) : view.status === "failed" ? (
          <>
            <RetryRow testId={`sharing-${lane}-failed`} onRetry={() => actions.retry(lane)}>
              {words.failed}
            </RetryRow>
            {props.local}
          </>
        ) : (
          <div
            data-testid={`sharing-${lane}-answer`}
            data-freshness={view.answer.freshness}
            data-coverage={view.answer.coverage.kind}
          >
            {knownAnswer(view) === null ? (
              <>
                <AccessUnknown
                  testId={`sharing-${lane}`}
                  unexplained={words.unexplained}
                  signedOut={words.signedOut}
                  answer={view.answer}
                  setup={props.setup}
                  onRetry={() => actions.retry(lane)}
                />
                {props.local}
              </>
            ) : (
              <>
                <AccessChecked
                  testId={`sharing-${lane}-freshness`}
                  answer={view.answer}
                  scope={words.scope}
                />
                {props.empty ? (
                  <div className="flex py-4">
                    <EmptyState
                      data-testid={`sharing-${lane}-empty`}
                      picture={EMPTY_ART.shares}
                      title={words.empty}
                    />
                  </div>
                ) : (
                  props.children
                )}
                {view.answer.nextCursor === null ? null : "moreFailed" in view ? (
                  <RetryRow
                    testId={`sharing-${lane}-more-failed`}
                    onRetry={() => actions.more(lane, view.answer)}
                  >
                    {words.moreFailed}
                  </RetryRow>
                ) : (
                  <button
                    type="button"
                    data-testid={`sharing-${lane}-more`}
                    onClick={() => actions.more(lane, view.answer)}
                    className={`${ABOUT_ROW} dohc-focus-row h-7 cursor-pointer text-[12px] hover:bg-hover hover:text-ink`}
                  >
                    Show more
                  </button>
                )}
                {props.ended}
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
  granted: SharingLaneView | null;
  received: SharingLaneView;
  grantedSetup: AccessSetup;
  receivedSetup: AccessSetup;
  conflictCount: number | null;
  waiting: ReadonlyMap<string, WaitingChanges>;
  notSentWhileOpen: readonly string[];
  mounts: readonly ShareMount[];
  skipView: SkipView;
  invitations: boolean;
  accessChanges: AccessChanges;
  confirmKey: string | null;
  busyShareIds: ReadonlySet<string>;
  actions: SharingActions;
  focus?: SharingFocus | null;
  onFocused?: () => void;
  onLaneShown?: (lane: SharingLane) => void;
  initialLane?: SharingLane;
  initialOpen?: readonly string[];
}) {
  const { actions, focus, onFocused, onLaneShown } = props;
  const panel = useRef<HTMLDivElement>(null);
  const [chosen, setLane] = useState<SharingLane>(props.initialLane ?? "granted");
  const lane = props.granted ? chosen : "received";
  useEffect(() => {
    onLaneShown?.(lane);
  }, [lane, onLaneShown]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(props.initialOpen));
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const grantedView = props.granted;
  const granted = useMemo(() => {
    const known = grantedView && knownAnswer(grantedView);
    return listGranted(
      known?.rows ?? [],
      props.waiting,
      known != null && known.nextCursor !== null,
    );
  }, [grantedView, props.waiting]);
  const received = useMemo(
    () => listReceived(props.received, props.mounts),
    [props.mounts, props.received],
  );

  const focusView = focus ? (focus.lane === "granted" ? props.granted : props.received) : null;
  const focusEnded =
    focus?.shareId != null &&
    (focus.lane === "granted"
      ? granted.ended.some((each) => each.group.shareId === focus.shareId)
      : received.ended.some((each) => each.shareId === focus.shareId));
  const endedOpen = focus ? open.has(endedGroupKey(focus.lane)) : false;
  useEffect(() => {
    if (!focus || !focusView || focusView.status === "loading") return;
    if (lane !== focus.lane) {
      setLane(focus.lane);
      return;
    }
    if (focusEnded && !endedOpen) {
      setOpen((current) => new Set(current).add(endedGroupKey(focus.lane)));
      return;
    }
    const root = panel.current;
    const row =
      focus.shareId === null
        ? null
        : [
            ...(root?.querySelectorAll<HTMLElement>(`[data-testid="sharing-${focus.lane}-row"]`) ??
              []),
          ].find((element) =>
            (element.dataset.shareIds ?? element.dataset.shareId ?? "")
              .split(" ")
              .includes(focus.shareId!),
          );
    const rowTarget = row?.querySelector<HTMLElement>("[data-sharing-row-focus]");
    const target =
      rowTarget ??
      root?.querySelector<HTMLElement>(`[data-sharing-lane-focus="${focus.lane}"]`) ??
      null;
    // A row that is not a control takes focus only for this jump, so a click never leaves it selected.
    if (rowTarget && rowTarget.tabIndex < 0) {
      rowTarget.tabIndex = -1;
      rowTarget.addEventListener("blur", () => rowTarget.removeAttribute("tabindex"), {
        once: true,
      });
    }
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused?.();
  }, [endedOpen, focus, focusEnded, focusView, lane, onFocused]);

  const count = (which: SharingLane) => {
    const view = which === "granted" ? props.granted : props.received;
    const known = view && knownAnswer(view);
    if (!known) return null;
    return (
      <LaneCount
        lane={which}
        count={
          which === "granted" ? granted.items.filter((item) => !item.held).length : received.live
        }
        more={known.nextCursor !== null}
      />
    );
  };

  const receivedRow = (entry: ReceivedEntry) => (
    <ReceivedRow
      key={entry.key}
      entry={entry}
      repeated={received.repeated}
      skipsShown={skipsShown(entry.mount, props.skipView)}
      confirming={props.confirmKey === leaveConfirmKey(entry.shareId)}
      busy={props.busyShareIds.has(entry.shareId)}
      actions={actions}
    />
  );
  const senders =
    received.groups.length > 0 ? (
      <ul className="m-0 list-none p-0">
        {received.groups.map((group) => (
          <SenderRows key={group.sender.key} group={group}>
            {group.entries.map(receivedRow)}
          </SenderRows>
        ))}
      </ul>
    ) : null;
  const receivedEnded = (
    <EndedGroup
      lane="received"
      count={received.ended.length}
      open={open.has(endedGroupKey("received"))}
      onToggle={() => toggle(endedGroupKey("received"))}
    >
      {received.ended.map(receivedRow)}
    </EndedGroup>
  );

  return (
    <div
      ref={panel}
      data-testid="sharing-view"
      className="min-h-0 flex-1 overflow-y-auto pb-2 pt-2 [&_:focus-visible]:-outline-offset-2"
    >
      {props.conflictCount !== null ? (
        <div
          data-testid="sharing-conflicts"
          className="mx-1 mb-2 flex min-h-10 items-center gap-2 rounded-md px-2 py-1.5 text-[13px]"
        >
          <TriangleAlert size={15} aria-hidden className="shrink-0 text-danger" />
          <span className="min-w-0 flex-1 leading-4 text-ink">
            {props.conflictCount > 1
              ? `${props.conflictCount} files changed on two machines`
              : "A file changed on two machines"}
          </span>
          <SecondaryButton
            size="compact"
            data-testid="sharing-conflicts-review"
            onClick={actions.reviewConflicts}
          >
            Review
          </SecondaryButton>
        </div>
      ) : null}
      {props.granted ? (
        <LaneSwitch
          lane={lane}
          onChange={setLane}
          counts={{ granted: count("granted"), received: count("received") }}
        />
      ) : null}
      {props.granted && lane === "granted" ? (
        <Lane
          lane="granted"
          view={props.granted}
          setup={props.grantedSetup}
          actions={actions}
          heading={null}
          empty={granted.items.length === 0 && granted.ended.length === 0}
          ended={
            <EndedGroup
              lane="granted"
              count={granted.ended.length}
              open={open.has(endedGroupKey("granted"))}
              onToggle={() => toggle(endedGroupKey("granted"))}
              damaged={granted.ended.filter((each) => each.first.status === "damaged").length}
            >
              {granted.ended.map((each) => (
                <EndedGrantedRow
                  key={each.group.shareId}
                  ended={each}
                  waiting={props.waiting.get(each.group.shareId)}
                  confirmKey={props.confirmKey}
                  busy={props.busyShareIds.has(each.group.shareId)}
                  actions={actions}
                />
              ))}
            </EndedGroup>
          }
        >
          {granted.items.length > 0 ? (
            <ul className="m-0 list-none p-0">
              {granted.items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  open={open.has(item.key)}
                  onToggle={() => toggle(item.key)}
                  waitingByShare={props.waiting}
                  notSentWhileOpen={props.notSentWhileOpen}
                  accessChanges={props.accessChanges}
                  confirmKey={props.confirmKey}
                  busyShareIds={props.busyShareIds}
                  invitations={props.invitations}
                  actions={actions}
                />
              ))}
            </ul>
          ) : null}
        </Lane>
      ) : null}
      {lane === "received" ? (
        <Lane
          lane="received"
          view={props.received}
          setup={props.receivedSetup}
          actions={actions}
          heading={
            props.granted ? null : (
              <h3
                tabIndex={-1}
                data-sharing-lane-focus="received"
                className="dohc-section-label m-0 flex h-6 items-center justify-between rounded-md px-3"
              >
                {LANE.received.label}
                {count("received")}
              </h3>
            )
          }
          empty={received.total === 0}
          local={
            <>
              {senders}
              {receivedEnded}
            </>
          }
          ended={receivedEnded}
        >
          {senders}
        </Lane>
      ) : null}
    </div>
  );
}

// One lane's read, held to the workspace it was asked for.
function useSharingLane(
  workspaceId: string,
  lane: SharingLane,
  notices: AboutNotices,
  refresh: () => Promise<void>,
) {
  const read = useSectionRead<SharingLaneView>(
    `${workspaceId}\0${lane}`,
    `sharing-${lane}`,
    notices,
  );
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
        const answer = await bridge().listSharingAccess({
          workspaceId,
          lane,
          ...(cursor ? { cursor } : {}),
        });
        // Main refuses a cursor from a listing that changed: read from the start.
        if (options.after && answer.coverage.kind === "unavailable") {
          if (request.current()) void load({});
          return;
        }
        request.settle({
          status: "ready",
          answer: options.after
            ? { ...answer, rows: [...options.after.rows, ...answer.rows] }
            : answer,
        });
      } catch (error) {
        const after = options.after;
        request.fail(
          after ? { status: "ready", answer: after, moreFailed: true } : { status: "failed" },
          ipcErrorMessage(error, after ? LANE[lane].moreFailed : LANE[lane].failed),
          error,
          () => void load(after ? { after } : { refreshed: refresh() }),
        );
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
  sharesRevision: number;
  reportError: (fallback: string, error: unknown, retry: () => void, identity?: string) => void;
  // What to focus once its lane answers, as Settings search asked.
  focus: SharingFocus | null;
  onFocused: () => void;
  // New notes the server has no file for until their open editor is left.
  notSentWhileOpen?: readonly string[];
  onShare?: (target: RelayShareTarget) => void;
  onOpenShare?: (share: OpenedShare) => void;
}) {
  const { workspaceId, context, onShare, onOpenShare } = props;
  const { facts, openSyncSettings, connect } = context;
  const refresh = useCallback(
    () =>
      bridge()
        .requestAccessRefresh({ workspaceId, reason: "sharing-open" })
        .catch(() => undefined),
    [workspaceId],
  );
  const granted = useSharingLane(workspaceId, "granted", props.notices, refresh);
  const received = useSharingLane(workspaceId, "received", props.notices, refresh);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmNow = useRef(confirmKey);
  confirmNow.current = confirmKey;
  const clearNotice = useContext(ShellNoticeClear);
  const [busyShareIds, setBusyShareIds] = useState<ReadonlySet<string>>(new Set());
  const busyNow = useRef(busyShareIds);
  const setBusy = (shareId: string, busy: boolean) => {
    const next = new Set(busyNow.current);
    if (busy) next.add(shareId);
    else next.delete(shareId);
    busyNow.current = next;
    setBusyShareIds(next);
  };
  const [skipView, setSkipView] = useState<SkipView>(new Map());
  const [accessChanges, setAccessChanges] = useState<AccessChanges>({});
  const [changesFor, setChangesFor] = useState(workspaceId);
  if (changesFor !== workspaceId) {
    setChangesFor(workspaceId);
    setAccessChanges({});
  }
  const changesNow = useRef(accessChanges);
  changesNow.current = accessChanges;
  const changeAccess = (
    grantId: string,
    next: (held: AccessChange | undefined) => AccessChange,
  ) => {
    changesNow.current = { ...changesNow.current, [grantId]: next(changesNow.current[grantId]) };
    setAccessChanges(changesNow.current);
  };
  const writing = (grant: AccessShareRow) =>
    writeUnderWay(changesNow.current[grant.grantId], busyNow.current.has(grant.shareId));
  // Bumped when the view closes, so a late answer leaves the view's own state alone.
  const epoch = useRequestSequence([workspaceId]);
  const openLookups = useRequestSequence([workspaceId]);

  // Copy invitation hands out a browser invitation only once this server has
  // made one: the relay makes them only when its browser deployment is set
  // up. One probe per view open, for the first person who could have one;
  // only the answer's yes or no is kept, never the link.
  const [invitations, setInvitations] = useState(false);
  const probed = useRef(false);
  // Mount-only, so StrictMode's replay sets it again before the probe answers.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const grantedView = granted.view;
  useEffect(() => {
    if (probed.current || grantedView.status !== "ready") return;
    const grant = grantedView.answer.rows.find(
      (row): row is AccessShareRow => row.kind === "share" && invitable(row),
    );
    if (!grant) return;
    // A started probe stands for the view's life; a lane reload does not ask again.
    probed.current = true;
    bridge()
      .getShareCopyDetails({ shareId: grant.shareId, grantId: grant.grantId })
      .then(
        (details) => {
          if (mounted.current)
            setInvitations(details.status === "active" && !!details.browserInvitationUrl);
        },
        () => undefined,
      );
  }, [grantedView]);

  // As About's Access: ask main to check again when the view opens, and when
  // the server connection it was asked under changes.
  const connection =
    typeof facts.cloud === "string"
      ? facts.cloud
      : `${facts.cloud.connected}:${facts.cloud.workspaceSynced}:${facts.cloud.workspaceSyncConnected}`;
  const refreshedUnder = useRef<string | null>(null);
  const loadGranted = granted.load,
    loadReceived = received.load;
  const cancelGranted = granted.cancel,
    cancelReceived = received.cancel;
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
  }, [
    cancelGranted,
    cancelReceived,
    connection,
    loadGranted,
    loadReceived,
    props.shareView,
    refresh,
  ]);
  // A share ended or came back while the view was open, from any surface or
  // from a Notices Try again or Undo.
  const readRevision = useRef(props.sharesRevision);
  useEffect(() => {
    if (readRevision.current === props.sharesRevision) return;
    readRevision.current = props.sharesRevision;
    if (!props.shareView) void loadGranted({ refreshed: refresh() });
  }, [loadGranted, props.shareView, props.sharesRevision, refresh]);

  const setupFor = useCallback(
    (lane: SharingLane): AccessSetup => ({
      reason: accessReasonForLane(facts, lane),
      openSyncSettings,
      connect,
    }),
    [connect, facts, openSyncSettings],
  );
  const waiting = useMemo(() => waitingByShare(props.proposals), [props.proposals]);
  const closeConfirm = (key: string | null) =>
    setConfirmKey((confirming) => (confirming === key ? null : confirming));

  // An action's outcome reaches the shell even after the view closes; the
  // shell lives for one workspace. Only the view's own state checks `epoch`.
  async function endShare(group: ShareGroup): Promise<boolean> {
    if (!group.rows.some(endsOnEnd)) return true;
    const token = epoch.current();
    const subject = `the share of ${subjectOf(liveGrant(group)).title} with ${recipientsOf(group)}`;
    setBusy(group.shareId, true);
    try {
      const result = await bridge().revokeRelayShare({ shareId: group.shareId });
      // The shell counts the removal and its Undo; the open view reads again then.
      props.shareRemovals.removed({
        workspaceId,
        shareId: group.shareId,
        undo: result.undo,
        message: result.undo
          ? `Ended ${subject}.`
          : `${subject[0]!.toUpperCase()}${subject.slice(1)} has already ended.`,
        restoredMessage: `Restored ${subject}.`,
      });
      return true;
    } catch (cause) {
      props.shareRemovals.failed({
        workspaceId,
        message: `dohc could not end ${subject}.`,
        cause,
        retry: () => void endShare(group),
      });
      return false;
    } finally {
      if (epoch.isCurrent(token)) setBusy(group.shareId, false);
    }
  }

  async function end(shares: readonly ShareGroup[]) {
    const token = epoch.current();
    const asked = confirmNow.current;
    const ended = await Promise.all(shares.map(endShare));
    if (epoch.isCurrent(token) && ended.every(Boolean)) closeConfirm(asked);
  }

  async function removePerson(grant: AccessShareRow, title: string) {
    if (writing(grant)) return;
    const token = epoch.current();
    const asked = confirmNow.current;
    const subject = removalSubject(grant, title);
    setBusy(grant.shareId, true);
    try {
      const result = await bridge().revokeRelayShareGrant({
        workspaceId,
        shareId: grant.shareId,
        grantId: grant.grantId,
      });
      props.shareRemovals.removed({
        workspaceId,
        shareId: grant.shareId,
        undo: result.undo,
        message: `Removed ${subject}.`,
        restoredMessage: `Restored ${subject}.`,
      });
      if (epoch.isCurrent(token)) closeConfirm(asked);
    } catch (cause) {
      props.shareRemovals.failed({
        workspaceId,
        message: `dohc could not remove ${subject}.`,
        cause,
        retry: () => void removePerson(grant, title),
      });
    } finally {
      if (epoch.isCurrent(token)) setBusy(grant.shareId, false);
    }
  }

  async function retune(grant: AccessShareRow, access: ShareAccess, title: string) {
    if (writing(grant)) return;
    const token = epoch.current();
    const identity = accessNoticeIdentity(grant.grantId);
    changeAccess(grant.grantId, (held) => ({ asked: access, answered: held?.answered ?? null }));
    try {
      const changed = await bridge().retuneRelayShareGrant({
        workspaceId,
        shareId: grant.shareId,
        grantId: grant.grantId,
        access,
      });
      clearNotice?.(identity);
      if (!epoch.isCurrent(token)) return;
      changeAccess(grant.grantId, (held) => ({
        asked: null,
        answered:
          held?.answered && held.answered.generation > changed.generation
            ? held.answered
            : { access: changed.access, generation: changed.generation },
      }));
      void loadGranted({ refreshed: refresh() });
    } catch (cause) {
      if (epoch.isCurrent(token))
        changeAccess(grant.grantId, (held) => ({ asked: null, answered: held?.answered ?? null }));
      props.reportError(
        `dohc could not change ${recipientOf(grant)}'s access to ${title}.`,
        cause,
        () => void retune(grant, access, title),
        identity,
      );
    }
  }

  async function receivedFiles(shareId: string) {
    const found = await bridge().getRelayReceivedShare({ shareId });
    if (!found.found)
      throw new NoLongerShared(
        found.removed?.message ?? "This share is no longer shared with you.",
      );
    if ("chats" in found) throw new Error("Join this from Chats.");
    return found.share;
  }

  async function mount(shareId: string) {
    const token = epoch.current();
    setBusy(shareId, true);
    try {
      const share = await receivedFiles(shareId);
      await bridge().mountShare({ workspaceId, shareCode: share.shareCode });
      props.onMountsChanged();
    } catch (cause) {
      props.reportError(
        "dohc could not add this share to the workspace.",
        cause,
        () => void mount(shareId),
      );
    } finally {
      if (epoch.isCurrent(token)) setBusy(shareId, false);
    }
  }

  async function openToEdit(shareId: string, open: (share: OpenedShare) => void) {
    const token = epoch.current();
    const lookup = openLookups.next();
    const retry = () => void openToEdit(shareId, open);
    setBusy(shareId, true);
    try {
      const share = await receivedFiles(shareId);
      if (!openLookups.isCurrent(lookup)) return;
      if (!opensForLiveEditing(share)) {
        const message = "The owner changed your access to this share. It no longer opens to edit.";
        props.reportError(message, new Error(message), retry);
        void loadReceived({ refreshed: refresh() });
        return;
      }
      open({ shareId: share.shareId, shareCode: share.shareCode, liveEditing: true });
    } catch (cause) {
      if (!openLookups.isCurrent(lookup)) return;
      if (cause instanceof NoLongerShared) {
        props.reportError(cause.message, cause, retry);
        void loadReceived({ refreshed: refresh() });
      } else props.reportError("dohc could not open this share.", cause, retry);
    } finally {
      if (epoch.isCurrent(token)) setBusy(shareId, false);
    }
  }

  async function unmount(target: ShareMount) {
    const token = epoch.current();
    setBusy(target.shareId, true);
    try {
      await props.onUnmount(`shared-with-me/${target.label}`);
    } finally {
      if (epoch.isCurrent(token)) setBusy(target.shareId, false);
    }
  }

  async function leave(shareId: string, mounted: ShareMount | undefined, ended: boolean) {
    const token = epoch.current();
    setBusy(shareId, true);
    try {
      if (ended && mounted) await props.onUnmount(`shared-with-me/${mounted.label}`);
      const { left } = await bridge().leaveRelayShare({ shareId, ended });
      if (!ended && left && mounted) await props.onUnmount(`shared-with-me/${mounted.label}`);
      if (epoch.isCurrent(token)) {
        closeConfirm(leaveConfirmKey(shareId));
        void loadReceived({ refreshed: refresh() });
      }
    } catch (cause) {
      props.reportError(
        ended
          ? "dohc could not take this share off your list."
          : "dohc could not leave this share.",
        cause,
        () => void leave(shareId, ended ? undefined : mounted, ended),
      );
    } finally {
      if (epoch.isCurrent(token)) setBusy(shareId, false);
    }
  }

  // A share that ended since the list was read has nothing to copy. The row
  // is stale, not the person's to fix: read the list again, copy nothing.
  async function copy(grant: AccessShareRow, what: CopyWhat): Promise<string | null> {
    const token = epoch.current();
    const details = await bridge().getShareCopyDetails({
      shareId: grant.shareId,
      grantId: grant.grantId,
    });
    // The view closed while main answered: hand out nothing, read nothing.
    if (!epoch.isCurrent(token)) return null;
    if (details.status === "ended") {
      void loadGranted({ refreshed: refresh() });
      return null;
    }
    if (what === "code") return details.shareCode;
    if (!details.browserInvitationUrl)
      throw new Error("This server does not make browser invitations.");
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
      await bridge().dismissShareSkips({
        workspaceId,
        shareId: target.shareId,
        generation: skipped.generation,
      });
      props.onMountsChanged();
    } catch (cause) {
      if (epoch.isCurrent(token)) setSkip(target.shareId, null);
      props.reportError(
        "dohc could not dismiss the skipped changes.",
        cause,
        () => void dismissSkips(target),
      );
    }
  }

  const actions: SharingActions = {
    retry: (lane) =>
      void (lane === "granted" ? loadGranted : loadReceived)({ refreshed: refresh() }),
    more: (lane, answer) =>
      void (lane === "granted" ? loadGranted : loadReceived)({ after: answer }),
    reviewChanges: props.onReviewChanges,
    startEnd: setConfirmKey,
    cancelEnd: () => setConfirmKey(null),
    end: (shares) => void end(shares),
    removePerson: (grant, title) => void removePerson(grant, title),
    retune: (grant, access, title) => void retune(grant, access, title),
    share: onShare ?? null,
    mount: (shareId) => void mount(shareId),
    unmount: (target) => void unmount(target),
    openToEdit: onOpenShare ? (shareId) => void openToEdit(shareId, onOpenShare) : null,
    startLeave: setConfirmKey,
    leave: (shareId, mounted) => void leave(shareId, mounted, false),
    clear: (shareId, mounted) => void leave(shareId, mounted, true),
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
      notSentWhileOpen={props.notSentWhileOpen ?? []}
      mounts={props.mounts}
      skipView={skipView}
      invitations={invitations}
      accessChanges={accessChanges}
      confirmKey={confirmKey}
      busyShareIds={busyShareIds}
      actions={actions}
      focus={props.focus}
      onFocused={props.onFocused}
      onLaneShown={openLookups.next}
    />
  );
}
