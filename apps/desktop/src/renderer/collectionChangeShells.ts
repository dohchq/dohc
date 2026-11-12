/** Where a change to a Data Collection reports how it ended: a toast, and a row in Notices. */
export interface CollectionChangeReports {
  /**
   * `identity` names one row in Notices, which a newer report with it replaces.
   * `quiet` changes that row where it stands, with no new toast.
   */
  onError(fallback: string, error: unknown, retry: (() => void) | null, identity?: string, quiet?: boolean): void;
  /** Removes the row in Notices a report with this identity left. */
  onSettled?(identity: string): void;
  onNotice?(message: string): void;
}

// The open shell's reports, by workspace, and whether main takes the
// workspace's requests. A window shows one workspace, so a workspace with no
// shell here is not the one it shows.
type Shell = { reports: CollectionChangeReports; admitted: boolean };
const shells = new Map<string, Shell>();
const resumers = new Set<(workspaceId: string) => void>();

/**
 * A workspace's shell opened in this window. Its Collections' changes report
 * to it once their page has closed. They are not sent yet: main still holds
 * the session of the workspace the window showed before. Returns what closes
 * the shell.
 */
export function openCollectionChangeShell(workspaceId: string, reports: CollectionChangeReports): () => void {
  const shell: Shell = { reports, admitted: false };
  shells.set(workspaceId, shell);
  // A shell that closes late leaves a newer shell of its workspace open.
  return () => { shell.admitted = false; if (shells.get(workspaceId) === shell) shells.delete(workspaceId); };
}
/** The reports of the workspace's open shell, or undefined while the window shows another workspace. */
export function collectionChangeShell(workspaceId: string): CollectionChangeReports | undefined {
  return shells.get(workspaceId)?.reports;
}
/** Whether main takes the workspace's requests: its shell is open, and main has admitted its session. */
export function collectionChangesAdmitted(workspaceId: string): boolean {
  return shells.get(workspaceId)?.admitted ?? false;
}
/**
 * Main admitted the session of the workspace's open shell, so it takes the
 * workspace's requests. Each of its tables whose changes need the person
 * files one row, and the changes that waited go on. Returns what ends the
 * admission, as when the shell closes or opens the workspace again.
 */
export function admitCollectionChanges(workspaceId: string): () => void {
  const shell = shells.get(workspaceId);
  if (!shell) return () => {};
  shell.admitted = true;
  for (const resume of resumers) resume(workspaceId);
  return () => { shell.admitted = false; };
}
/** Calls `resume` each time a workspace's changes go on. */
export function onCollectionChangesResumed(resume: (workspaceId: string) => void): void {
  resumers.add(resume);
}
/** Tests start with no shell open. */
export function closeCollectionChangeShellsForTests(): void {
  shells.clear();
}
