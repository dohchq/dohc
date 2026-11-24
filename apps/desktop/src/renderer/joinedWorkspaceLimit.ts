// dohc lists a workspace someone joined but cannot open it yet. Every
// statement of that limit comes from here, so the change that opens joined
// workspaces deletes this file and the compiler finds each place it was said.
export const JOINED_WORKSPACE_LIMIT = {
  // Members settings, for the owner and admins, beside Member level.
  members: "Members can't open this workspace in this version of dohc yet.",
  // The disabled Open on a joined workspace's row in Sharing.
  open: "This version of dohc can't open a workspace you joined yet.",
} as const;
