import type { ListedLink, RosterListing } from "@dohc/automation-executor/roster-listing";

/**
 * Each workspace's new notes whose first file waits for their open editor to
 * be left, as the engine answered after the last sync pass, so a status read
 * never asks the engine. A failed read keeps the last answer.
 */
export function createNotSentWhileOpen() {
  const paths = new Map<string, readonly string[]>();
  return {
    // Answers whether the paths changed.
    async read(workspaceId: string, read: () => Promise<readonly string[]>): Promise<boolean> {
      try {
        const next = await read();
        if (next.join("\0") === (paths.get(workspaceId) ?? []).join("\0")) return false;
        if (next.length) paths.set(workspaceId, next);
        else paths.delete(workspaceId);
        return true;
      } catch (error) {
        console.error("[desktop] notes not sent read failed:", error);
        return false;
      }
    },
    paths: (workspaceId: string): readonly string[] => paths.get(workspaceId) ?? [],
  };
}

/**
 * Whether `listing` has a share that shows `path` to someone else: a live link
 * or a person's share of the note or of a folder holding it. A share of a
 * version names no new note. A Group's files are not counted.
 */
export function sharedByListing(listing: RosterListing | null, path: string): boolean {
  if (!listing || listing.grants === null) return false;
  const shows = (grant: ListedLink["grant"]) => {
    const selector = grant.selector;
    return (
      grant.status === "active" &&
      selector.kind === undefined &&
      selector.versionId === null &&
      selector.paths.some((root) => path === root || path.startsWith(`${root}/`))
    );
  };
  return (
    listing.grants.some(shows) || listing.links.some(({ grant, ended }) => !ended && shows(grant))
  );
}
