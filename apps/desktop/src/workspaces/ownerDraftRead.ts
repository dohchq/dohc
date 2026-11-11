import { EngineRequestError, type EngineClient } from "@dohc/workspace-engine-client/daemon";

type DraftReader = Pick<EngineClient, "ownerYDocListDrafts" | "ownerYDocOpenDraft">;

/**
 * The owner's current text of a shared note that no editor holds: the
 * server's accepted state plus the edits still waiting to reach it. The file
 * catches up only when the server settles them, so a read of the file alone
 * misses edits this device already kept. Null when the note has no draft to
 * read, and the file is its text.
 */
export async function readOwnerDraftState(client: DraftReader, workspace: string, path: string,
  activeVersionId: () => Promise<string>, signal?: AbortSignal): Promise<Uint8Array | null> {
  const request = () => ({ id: 0, workspace, deadlineMs: 30_000 });
  // An edit that lands between the list and the open changes the revision.
  for (let attempt = 0; ; attempt++) {
    let after: Parameters<EngineClient["ownerYDocListDrafts"]>[1]["after"] = null, draft;
    try {
      do {
        const page = await client.ownerYDocListDrafts(request(), { after, limit: 64 }, signal);
        // A quarantined draft does not open; its file and recovery row stand.
        draft = page.drafts.find(candidate => candidate.binding.currentPath === path && candidate.state !== "quarantined");
        after = page.next;
      } while (!draft && after);
    } catch {
      // Without owner delivery there is no draft to read, and a note that was
      // never shared reads from its file as before.
      return null;
    }
    // Drafts belong to main; another active version keeps its own file.
    if (!draft || await activeVersionId() !== draft.binding.mainVersionId) return null;
    try {
      const opened = await client.ownerYDocOpenDraft(request(), { binding: draft.binding, expectedRevision: draft.revision }, signal);
      return new Uint8Array(opened.initialUpdate);
    } catch (error) {
      if (attempt > 0 || !(error instanceof EngineRequestError && error.message === "owner-outbox-parent-mismatch")) throw error;
    }
  }
}
