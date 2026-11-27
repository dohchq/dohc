import { notFound, relayError } from "./errors";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { relayLiveNotes } from "./storage/liveDocumentAuthority";

/**
 * `GET` lists a workspace owner's notes that are live on the relay, each with its object id, its
 * path and why: `activation`, `room-edits`, `pause` or `enrolment` while its last lineage is still
 * ending, and `session` while someone has it open for live editing through the relay.
 */
export type LiveNoteRoute = { route: "live-notes"; workspaceId: string };

export function createLiveNoteRoutes(
  storage: SyncRelayStorage,
  liveSessions: (workspaceId: string) => ReadonlySet<string>,
) {
  return (request: Request, route: LiveNoteRoute, ownerUserId: string): Response => {
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    if (request.method !== "GET") throw relayError("method_not_allowed");
    return Response.json(
      {
        notes: relayLiveNotes(
          storage as StorageContext,
          route.workspaceId,
          liveSessions(route.workspaceId),
        ),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  };
}
