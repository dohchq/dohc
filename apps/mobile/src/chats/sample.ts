import type { IdentityHue } from "../theme";

// Sample data for design review only. The real list comes from the server's chat operations.
export type ChatKind = "group" | "person" | "agent" | "comment";

export interface ChatRowData {
  readonly id: string;
  readonly kind: ChatKind;
  readonly name: string;
  readonly unread: boolean;
  /** Unread messages: ink when you were addressed (a direct message or your agent), quiet for a group you follow. */
  readonly count?: number;
  readonly muted?: boolean;
  readonly online?: boolean;
  /** Agents only: a connected agent, one dohc does not start, which shows the plug in place of the sparkle. */
  readonly connected?: boolean;
  /** Agents only: the agent's chosen identity colour; none takes the agent olive. */
  readonly agentHue?: IdentityHue;
  /** People only: initials and colour. */
  readonly initials?: string;
  readonly hue?: string;
}

export interface ChatSection {
  readonly key: string;
  readonly title: string;
  readonly rows: readonly ChatRowData[];
}

export interface SampleWorkspace {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly color: string;
  readonly sections: readonly ChatSection[];
}
export const sampleMe = { initials: "IV", hue: "#3f7f86" };

const lisbonSections: readonly ChatSection[] = [
  { key: "groups", title: "Groups", rows: [
    { id: "g-planning", kind: "group", name: "planning", unread: true, count: 2 },
    { id: "g-food", kind: "group", name: "food", unread: true },
    { id: "g-general", kind: "group", name: "general", unread: false },
    { id: "g-photos", kind: "group", name: "photos", unread: false, muted: true },
  ] },
  { key: "shared", title: "Shared with you", rows: [
    { id: "s-fundraiser", kind: "group", name: "fundraiser-volunteers", unread: false },
  ] },
  { key: "people", title: "People", rows: [
    { id: "p-maya", kind: "person", name: "Maya Chen", unread: true, count: 1, online: true, initials: "MC", hue: "#b4583e" },
    { id: "p-sam", kind: "person", name: "Sam Ortiz", unread: false, initials: "SO", hue: "#4f6aa8" },
    { id: "p-priya", kind: "person", name: "Priya Raman", unread: false, online: true, initials: "PR", hue: "#8a5aa0" },
  ] },
  { key: "agents", title: "Agents", rows: [
    { id: "a-nova", kind: "agent", name: "Nova", unread: true, count: 1 },
    { id: "a-scout", kind: "agent", name: "Scout", unread: false, connected: true, agentHue: "amber" },
  ] },
  { key: "files", title: "Files", rows: [
    { id: "c-budget", kind: "comment", name: "budget.md", unread: true },
    { id: "c-packing", kind: "comment", name: "packing-list.md", unread: false },
  ] },
];

const fundraiserSections: readonly ChatSection[] = [
  { key: "groups", title: "Groups", rows: [
    { id: "f-volunteers", kind: "group", name: "volunteers", unread: false },
    { id: "f-logistics", kind: "group", name: "logistics", unread: false },
  ] },
  { key: "people", title: "People", rows: [
    { id: "f-sam", kind: "person", name: "Sam Ortiz", unread: false, initials: "SO", hue: "#4f6aa8" },
  ] },
  { key: "files", title: "Files", rows: [
    { id: "f-budget", kind: "comment", name: "budget.md", unread: false },
  ] },
];

// The workspaces on this phone, in the order the switcher lists them.
export const sampleWorkspaces: readonly SampleWorkspace[] = [
  { id: "lisbon", name: "Lisbon trip", initial: "L", color: "#38684e", sections: lisbonSections },
  { id: "fundraiser", name: "Fundraiser", initial: "F", color: "#8a5a2e", sections: fundraiserSections },
];

/** A chat in this phone's sample, by its id. */
export function sampleChat(id: string): ChatRowData | undefined {
  for (const workspace of sampleWorkspaces) for (const section of workspace.sections) {
    const row = section.rows.find(candidate => candidate.id === id);
    if (row) return row;
  }
  return undefined;
}
