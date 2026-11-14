import type { ShareAccess } from "../../ipc/bridgeContract";

// How a membership reads wherever it is named: the role first, then what the
// owner lets members do. Sharing's row and the Open dialog say the same.
export function membershipWho(role: "admin" | "member" | undefined, sender: string, access: string | null | undefined): string {
  if (role === "admin") return `Admin · ${sender} owns this workspace`;
  return access ? `Member · ${sender} lets members ${access}` : `Member · from ${sender}`;
}

// A level change, in the Sharing row's form. View reads "view only", since
// "lets members view" alone could mean more.
export function levelChangedWords(access: ShareAccess, by: string | null | undefined): string {
  const what = access === "view" ? "view only" : access;
  return by ? `${by} now lets members ${what}.` : `Members can now ${what}.`;
}

// What a page says where its Edit toggle would be, when the level allows no
// editing: the browser's badge words, and who set the level in the tooltip.
// An ended membership leaves a copy that only reads.
export type LevelMark = { label: string; title: string };
export function levelMark(access: ShareAccess | null | undefined, ended: boolean, sender: string): LevelMark | null {
  if (ended) return { label: "Read-only", title: "Your membership ended. This copy stays on this computer." };
  if (access === "view") return { label: "View only", title: `${sender} lets members view only` };
  if (access === "comment") return { label: "Can comment", title: `${sender} lets members comment` };
  return null;
}

// The level inside a joined workspace, said once, in the workspace menu.
export function youCan(access: ShareAccess): string {
  return `You can ${access}`;
}
