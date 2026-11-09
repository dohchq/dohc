// Words both apps show for Sharing, from the desktop's SharingView and #3227. The design lead owns them.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

export type ShareLevel = "view" | "comment" | "edit";
export type ShareLane = "granted" | "received";
/** A share that is no longer live, as its row's pill says it. */
export type ShareStatus = "ended" | "removed" | "damaged";

/** One live grant of a share: a named person, or anyone with a link. */
export interface ShareGrant {
  readonly via: "named" | "link";
  readonly level: ShareLevel;
  /** The person's email; unused for a link. */
  readonly who: string;
}

// What a level lets a person do, widest first.
const VERBS: readonly ShareLevel[] = ["edit", "comment", "view"];
const widest = (a: ShareGrant, b: ShareGrant) => VERBS.indexOf(a.level) - VERBS.indexOf(b.level);

// How many people have each level, widest first: "1 person can edit", "2 can view".
function countClauses(people: readonly ShareGrant[]): string[] {
  return VERBS.map(verb => ({ verb, count: people.filter(grant => grant.level === verb).length }))
    .filter(({ count }) => count > 0)
    .map(({ verb, count }, index) => index > 0 ? `${count} can ${verb}` : `${count} ${count === 1 ? "person" : "people"} can ${verb}`);
}

// How many links have each level, widest first: "1 link lets anyone edit".
function linkClauses(links: readonly ShareGrant[]): string[] {
  if (links.length === 1) return [`Anyone with the link can ${links[0]!.level}`];
  return VERBS.map(verb => ({ verb, count: links.filter(grant => grant.level === verb).length }))
    .filter(({ count }) => count > 0)
    .map(({ verb, count }) => `${count} ${count === 1 ? "link lets" : "links let"} anyone ${verb}`);
}

/** Who can do what with a share, as its row's second line says it: the desktop's SharingView `grantedWho`.
 * Anyone with a link has the widest link's level, so only people above it are counted beside it. Without a
 * link, one person goes by name and several by count. */
export function grantedWho(grants: readonly ShareGrant[]): string | null {
  const links = grants.filter(grant => grant.via === "link").sort(widest);
  const people = grants.filter(grant => grant.via === "named");
  const [link] = links;
  if (link) {
    const anyone = `with ${links.length === 1 ? "the" : "a"} link can ${link.level}`;
    const clauses = countClauses(people.filter(grant => VERBS.indexOf(grant.level) < VERBS.indexOf(link.level)));
    return clauses.length === 0 ? `Anyone ${anyone}` : [...clauses, `anyone ${anyone}`].join(", ");
  }
  const [only] = people;
  if (!only) return null;
  return people.length === 1 ? `${only.who} can ${only.level}` : countClauses(people).join(", ");
}

/** A share sent to you: what it lets you do while it's live and the level is known, else its sender alone. */
export function receivedWho(sender: string, level: ShareLevel | null): { text: string; spoken: string } {
  return level ? { text: `${sender} lets you ${level}`, spoken: `${sender} lets you ${level}` } : { text: `From ${sender}`, spoken: `from ${sender}` };
}

/** "a", "a and b", "a, b and c", or "N people" past three. */
export function namesOf(names: readonly string[], none: string): string {
  if (names.length > 3) return `${names.length} people`;
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? none;
}

export const sharingWords = {
  heading: "Sharing",
  lane: {
    granted: { label: "Shared by me", scope: "for this workspace", empty: "No shares from this workspace. Share a file from dohc on a computer." },
    received: { label: "Shared with me", scope: "for your account", empty: "No shares to your account." },
  },
  checked: "Checked",
  level: { view: "View", comment: "Comment", edit: "Edit" },
  status: { ended: "Ended", removed: "Removed", damaged: "Damaged" } satisfies Record<ShareStatus, string>,
  shareActions: "Share actions",
  copyInvitation: "Copy invitation",
  endShareMenu: "End share…",
  endShare: "End share",
  cancel: "Cancel",
  undo: "Undo",
  unnamedPerson: "Unnamed person",
  /** The phone's alert names what it ends, where the desktop asks "End this share?" beside the row. */
  endTitle: (file: string) => `End the share of ${file}?`,
  endBody: (recipients: readonly string[]) => recipients.length > 1
    ? `${namesOf(recipients, "the recipient")} keep read-only copies and stop receiving updates.`
    : `${namesOf(recipients, "the recipient")} keeps a read-only copy and stops receiving updates.`,
  /** With changes waiting from the people it's shared with, ending it declines them. */
  endWaitingTitle: (file: string, count: number, senders: readonly string[]) =>
    `End the share of ${file} and decline ${count === 1 ? "1 change" : `${count} changes`} ${namesOf(senders, "someone")} sent?`,
  endWaitingBody: (count: number) => `Undo restores the share, not the declined ${count === 1 ? "change" : "changes"}.`,
  /** "the share of trip/packing-list.md with sam@example.com" */
  subject: (title: string, recipients: readonly string[]) => `the share of ${title} with ${namesOf(recipients, "the recipient")}`,
  endedShare: (subject: string) => `Ended ${subject}.`,
  undoWindow: "You can undo this for 10 minutes.",
  restored: (subject: string) => `Restored ${subject}.`,
  alreadyEnded: (subject: string) => `${subject[0]?.toUpperCase() ?? ""}${subject.slice(1)} has already ended.`,
  endFailed: (subject: string) => `dohc could not end ${subject}.`,
  /** The Share hint: shares end from Sharing (#3227). */
  endAnytime: "You can end this share anytime from Sharing.",
} as const;
