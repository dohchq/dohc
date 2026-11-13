import type { ShareAccess } from "../../ipc/bridgeContract";

// How a membership reads wherever it is named: the role first, then what the
// owner lets members do. Sharing's row and the Open dialog say the same.
export function membershipWho(role: "admin" | "member" | undefined, sender: string, access: string | null | undefined): string {
  if (role === "admin") return `Admin · ${sender} owns this workspace`;
  return access ? `Member · ${sender} lets members ${access}` : `Member · from ${sender}`;
}

// The level inside a joined workspace, said once, in the workspace menu.
export function youCan(access: ShareAccess): string {
  return `You can ${access}`;
}
