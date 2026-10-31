// What explains an Access answer that covers nothing. `checking` waits for
// the workspace's server connection to be read; it claims nothing.
export type AccessReason = "checking" | "not-synced" | "signed-out" | "other-account" | "unexplained";

// What this computer knows about the workspace's server connection, from the
// shell's cloud status: "checking" while it is read, and "unreadable" once
// reading it failed, which the shell reports on its own.
export type AccessFacts = {
  cloud: { connected: boolean; workspaceSynced: boolean; workspaceSyncConnected: boolean } | "checking" | "unreadable";
  shareView: boolean;
};
export type AccessContext = {
  facts: AccessFacts;
  // The server this workspace syncs with, when it syncs.
  server?: string | null;
  openSyncSettings: () => void;
  connect: () => void;
  // Opens the Share dialog for a file this workspace owns.
  share?: (path: string) => void;
  // The Share dialog is open. Access reads again when it closes.
  sharing?: boolean;
};

// A server by its host, as a person reads its address: sync.example.org.
export function serverName(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

// The cause for a whole list: the workspace's own shares, or the account's
// received ones. Share asks it for the workspace's own.
export function accessReasonForLane(facts: AccessFacts, lane: "granted" | "received"): AccessReason {
  const { cloud } = facts;
  if (cloud === "checking") return "checking";
  if (cloud === "unreadable") return "unexplained";
  if (lane === "received") return cloud.connected ? "unexplained" : "signed-out";
  if (!cloud.workspaceSynced) return "not-synced";
  if (!cloud.connected) return "signed-out";
  if (!cloud.workspaceSyncConnected) return "other-account";
  return "unexplained";
}

// A server by its host, as a person reads its address: sync.example.org.
export function serverName(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
