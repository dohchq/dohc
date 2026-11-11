/** Where a change to a Data Collection reports how it ended: a toast, and a row in Notices. */
export interface CollectionChangeReports {
  /** `identity` names one row in Notices, which a newer report with it replaces. */
  onError(fallback: string, error: unknown, retry: (() => void) | null, identity?: string): void;
  /** Removes the row in Notices a report with this identity left. */
  onSettled?(identity: string): void;
  onNotice?(message: string): void;
}

// The open shell's reports, by workspace. A window shows one workspace, so a
// workspace with none here is not the one it shows.
const shells = new Map<string, CollectionChangeReports>();
const resumers = new Set<(workspaceId: string) => void>();

/**
 * A workspace's shell opened in this window. Its Collections' queued changes
 * send only while it is open, and report to it once their page has closed.
 * Returns what closes it.
 */
export function openCollectionChangeShell(workspaceId: string, reports: CollectionChangeReports): () => void {
  shells.set(workspaceId, reports);
  // A shell that closes late leaves a newer shell of its workspace open.
  return () => { if (shells.get(workspaceId) === reports) shells.delete(workspaceId); };
}
/** The reports of the workspace's open shell, or undefined while the window shows another workspace. */
export function collectionChangeShell(workspaceId: string): CollectionChangeReports | undefined {
  return shells.get(workspaceId);
}
/**
 * The workspace's open shell can list notices now. Each of its tables whose
 * changes need the person files one row, and changes that waited while the
 * window showed another workspace go on.
 */
export function resumeCollectionChanges(workspaceId: string): void {
  for (const resume of resumers) resume(workspaceId);
}
/** Calls `resume` each time a workspace's changes go on. */
export function onCollectionChangesResumed(resume: (workspaceId: string) => void): void {
  resumers.add(resume);
}
/** Tests start with no shell open. */
export function closeCollectionChangeShellsForTests(): void {
  shells.clear();
}
