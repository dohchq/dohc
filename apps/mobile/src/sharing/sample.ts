import type { ShareGrant, ShareLevel, ShareStatus } from "@dohc/interface-words/sharing";

// Sample data for design review only. The real lists come from the server's access answer (AccessShareRow),
// grouped by share as the desktop's Sharing view groups them.

export interface SamplePerson {
  readonly email: string;
  readonly initials: string;
  readonly hue: string;
}

export interface GrantedShare {
  readonly shareId: string;
  readonly kind: "file" | "folder" | "version";
  /** What the row is called: a file's name, "name +N" for several, or what the share is named. */
  readonly name: string;
  /** Everything it covers, for sentences: "trip/packing-list.md". */
  readonly title: string;
  /** Its live grants: each person it's named to, and any link. */
  readonly grants: readonly ShareGrant[];
  /** The faces beside it, one per person it's named to. */
  readonly people: readonly SamplePerson[];
  /** A browser invitation, for one named person with a live edit of files. */
  readonly invitation: string | null;
  /** Changes the people it's shared with sent, waiting for review. */
  readonly waiting: { readonly count: number; readonly senders: readonly string[] } | null;
}

export interface ReceivedShare {
  readonly shareId: string;
  readonly kind: "file" | "folder" | "chat";
  /** What it shares, never its share ID (#3227). */
  readonly name: string;
  /** The sharer, named once, by name where the server knows one. */
  readonly sender: string;
  readonly senderPerson: SamplePerson;
  /** Its level while it's live; null once it isn't. */
  readonly level: ShareLevel | null;
  readonly status: ShareStatus | null;
}

const sam = { email: "sam@example.com", initials: "SO", hue: "#4f6aa8" };
const maya = { email: "maya@example.com", initials: "MC", hue: "#b4583e" };
const priya = { email: "priya@example.com", initials: "PR", hue: "#8a5aa0" };
const leo = { email: "leo@example.com", initials: "LP", hue: "#5f7a3a" };

const named = (person: SamplePerson, level: ShareLevel): ShareGrant => ({ via: "named", level, who: person.email });

export const sampleGranted: readonly GrantedShare[] = [
  { shareId: "s-packing", kind: "file", name: "packing-list.md", title: "trip/packing-list.md",
    grants: [named(sam, "edit")], people: [sam], invitation: "https://drive.example.com/invite/sample-packing-list",
    waiting: { count: 2, senders: [sam.email] } },
  { shareId: "s-itinerary", kind: "file", name: "days.md +2", title: "itinerary/days.md, itinerary/stays.md, itinerary/food.md",
    grants: [named(maya, "edit"), named(priya, "view"), named(leo, "view")], people: [maya, priya, leo], invitation: null, waiting: null },
  { shareId: "s-budget", kind: "file", name: "budget.md", title: "trip/budget.md",
    grants: [{ via: "link", level: "comment", who: "" }], people: [], invitation: null, waiting: null },
];

export const sampleReceived: readonly ReceivedShare[] = [
  { shareId: "r-roster", kind: "folder", name: "Volunteer roster", sender: "Priya Raman", senderPerson: priya, level: "comment", status: null },
  { shareId: "r-photos", kind: "folder", name: "Photo picks", sender: "Maya Chen", senderPerson: maya, level: null, status: "ended" },
  { shareId: "r-garden", kind: "file", name: "garden-plan.md", sender: "Leo Park", senderPerson: leo, level: null, status: "damaged" },
];

/** Shares this phone can end: those named to people. Links and chats end where they were made. */
export const endable = (share: GrantedShare) => share.grants.length > 0 && share.grants.every(grant => grant.via === "named");
