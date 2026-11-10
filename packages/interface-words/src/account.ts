// Words for signing in to a server, and for the phone's Settings: the account, its sessions, its agents and
// which workspaces show on the phone. The desktop's where it has them (file named beside each); the rest are the
// phone's. Change them here, never in a copy.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

/** Why a request to the server did not give an answer the app can use. */
export type ServerProblemKind = "offline" | "server-busy" | "refused" | "invalid";

export const accountWords = {
  // CloudLogin.tsx
  serverAddress: "Server address",
  serverAddressExample: "https://dohc.example.com",
  enterAddress: "Enter your server address.",
  enterHttps: "Enter an HTTPS server address.",
  enterAddressLike: "Enter a server address like https://dohc.example.com.",
  connectServer: "Connect server",
  connecting: "Connecting…",
  approveInBrowser: "Approve this device in your browser.",
  openBrowser: "Open browser",
  waitingForApproval: "Waiting for approval",
  denied: "The request was denied in the browser.",
  expired: "The code expired. Start again.",

  // The phone's.
  signingInTo: (server: string) => `Signing in to ${server}`,
  forgetFailed: "dohc could not delete the sign-in saved on this phone.",
  couldNotSignIn: (server: string) => `${server} could not sign this phone in. Try again or contact its administrator.`,
  sessionEnded: (server: string) => `${server} ended this phone's session. Connect again to continue.`,
  problem: (kind: ServerProblemKind, server: string): string => {
    switch (kind) {
      case "offline": return `dohc could not reach ${server}. Check your connection.`;
      case "server-busy": return `${server} is busy. Try again later.`;
      case "refused": return `${server} refused the request.`;
      case "invalid": return `dohc could not read the answer from ${server}.`;
    }
  },

  settings: "Settings",
  account: "Account",
  signOut: "Sign out",
  signOutTitle: (server: string) => `Sign out of ${server}?`,
  signOutBody: "This phone stops reading your workspaces. Your work stays where it is.",

  showOnPhone: "Show on phone",
  showOnPhoneLabel: (workspace: string) => `Show ${workspace} on phone`,
  unnamedWorkspace: "Unnamed workspace",
  noWorkspaces: (server: string) => `No workspaces on ${server} yet. Turn on sync for one on your computer.`,
  noneShown: "No workspaces show on this phone. Turn on Show on phone in Settings.",
  /** A workspace that shows on the phone, but whose computer hasn't set up its sync, so the server can't open it. */
  notSyncedYet: "Not synced yet",
  noneSynced: "No workspace on this phone is synced yet. Turn on sync for one on your computer.",
  workspaces: "Workspaces",

  sessions: "Sessions",
  thisPhone: "This phone",
  unknownDevice: "Unknown device",
  signedInOn: (date: string) => `Signed in ${date}`,
  endSession: "End session",
  endSessionTitle: (device: string) => `End the session on ${device}?`,
  endSessionBody: (server: string) => `It signs out of ${server}.`,

  agents: "Agents",
  noAgents: "No agents have signed in to this account.",
  agentStatus: { active: "Signed in", signedOut: "Signed out", removed: "Removed" },
  agentReach: (workspaces: readonly string[]) =>
    workspaces.length === 0 ? "Reaches no workspaces" : `Reaches ${workspaces.join(", ")}`,
  signOutAgentTitle: (agent: string) => `Sign out ${agent}?`,
  signOutAgentBody: "It stops reaching your workspaces until it signs in again.",
  removeAgent: "Remove",
  restoreAgent: "Restore",
} as const;
