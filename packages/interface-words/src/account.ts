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
  couldNotSignIn: (server: string) =>
    `${server} could not sign this phone in. Try again or contact its administrator.`,
  sessionEnded: (server: string) =>
    `${server} ended this phone's session. Connect again to continue.`,
  // Scanning the QR code a computer shows under Connect a phone, in its Settings.
  scanCode: "Scan code",
  scanHint: "Scan the code under Connect a phone in your computer's Settings.",
  notServerCode:
    "This code isn't a server address. Scan the code under Connect a phone in your computer's Settings.",
  insecureCode: "This code's server doesn't use HTTPS. Contact its administrator.",
  cameraOff: "dohc can't use the camera. Allow it in Settings.",
  cameraFailed: "dohc could not open the camera. Enter the server address instead.",
  openSettings: "Open Settings",
  problem: (kind: ServerProblemKind, server: string): string => {
    switch (kind) {
      case "offline":
        return `dohc could not reach ${server}. Check your connection.`;
      case "server-busy":
        return `${server} is busy. Try again later.`;
      case "refused":
        return `${server} refused the request.`;
      case "invalid":
        return `dohc could not read the answer from ${server}.`;
    }
  },

  settings: "Settings",
  account: "Account",
  signOut: "Sign out",
  signOutTitle: (server: string) => `Sign out of ${server}?`,
  /**
   * Sign out's body: what it deletes from the phone's outbox, messages not sent and ones that may still send, or, when
   * the phone can't read its outbox, that it can't count them.
   */
  signOutBody: (
    counts: { readonly unsent: number; readonly maySend: number } | null,
    captures?: number | null,
  ): string => {
    if (counts === null || captures === null)
      return captures === undefined
        ? "dohc could not check this phone for unsent messages. Signing out deletes any it has."
        : "dohc could not check this phone for unsent messages or Inbox captures. Signing out deletes any it has.";
    const { unsent, maySend } = counts;
    const lines = [
      unsent === 1
        ? "1 message hasn't been sent. Signing out deletes it."
        : unsent > 1
          ? `${unsent} messages haven't been sent. Signing out deletes them.`
          : null,
      maySend === 1
        ? "1 message may still send."
        : maySend > 1
          ? `${maySend} messages may still send.`
          : null,
      captures === 1
        ? "1 Inbox capture hasn't been sent. Signing out deletes it."
        : captures && captures > 1
          ? `${captures} Inbox captures haven't been sent. Signing out deletes them.`
          : null,
    ].filter((line) => line !== null);
    return lines.length > 0
      ? lines.join(" ")
      : "This phone stops reading your workspaces. Your work stays where it is.";
  },
  /** Sign out stopped because the phone couldn't delete its unsent messages safely; it stays signed in. */
  signOutFailed: "dohc could not delete the messages waiting on this phone, so it didn't sign out.",
  /**
   * On Connect, with Try again: a Sign out's delete failed on a phone already signed out, as after the server ended its
   * session. Only memory holds them back, so a relaunch keeps them.
   */
  signOutDeleteFailed:
    "dohc could not delete the messages waiting on this phone. They may send if you close dohc and sign in again.",
  /** On Connect: Sign out waits for the server to end this phone's session, and with Try again once it couldn't. */
  signingOut: "Signing out…",
  signOutUnfinished: (server: string) => `dohc could not finish signing out of ${server}.`,
  signOutNotStarted: "dohc could not start signing out, so this phone is still signed in.",
  savedUnreadable: "dohc could not read what it saved on this phone.",

  alerts: "Alerts",
  alertsDetail: "Mentions, direct messages, replies, and agent answers, with their text.",
  alertsUnavailable: (server: string) =>
    `${server} isn't set up to send alerts. Contact its administrator.`,
  alertsDenied: "dohc can't show alerts. Allow them in Settings.",
  alertsNotSaved: "dohc could not change alerts on this phone.",

  showOnPhone: "Show on phone",
  showOnPhoneLabel: (workspace: string) => `Show ${workspace} on phone`,
  unnamedWorkspace: "Unnamed workspace",
  noWorkspaces: (server: string) =>
    `No workspaces on ${server} yet. Turn on sync for one on your computer.`,
  noneShown: "No workspaces show on this phone. Turn on Show on phone in Settings.",
  /** A workspace that shows on the phone, but whose computer hasn't set up its sync, so the server can't open it. */
  notSyncedYet: "Not synced yet",
  noneSynced: "No workspace on this phone is synced yet. Turn on sync for one on your computer.",
  workspaces: "Workspaces",
  /** Headings that split the workspace list once the account has joined someone else's workspace. */
  yourWorkspaces: "Your workspaces",
  sharedWithYou: "Shared with you",
  roles: { admin: "Admin", member: "Member" },

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
