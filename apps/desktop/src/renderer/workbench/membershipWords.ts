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

// The level inside a joined workspace, said once, in the workspace menu.
export function youCan(access: ShareAccess): string {
  return `You can ${access}`;
}
