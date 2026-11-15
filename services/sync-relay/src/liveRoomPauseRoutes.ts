import { SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { badRequest, notFound, relayError } from "./errors";
import { readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import {
  liveRoomPauseCopy,
  liveRoomPauses,
  recordLiveRoomCopyWritten,
  resumeLiveRoom,
} from "./storage/liveRoomPauses";

/**
 * A workspace owner's paused notes: `GET` lists them, `GET <pause>/copy` is one pause's copy,
 * `POST <pause>/copy-written` with its digest deletes that copy once the desktop has written it
 * next to the note, and `POST <pause>/resume` ends the pause after that.
 */
export type LiveRoomPauseRoute = {
  route: "live-pauses";
  workspaceId: string;
  pauseId?: string;
  action?: "copy" | "copy-written" | "resume";
};
export const LIVE_PAUSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PRIVATE = { "cache-control": "private, no-store" } as const;

export function createLiveRoomPauseRoutes(storage: SyncRelayStorage) {
  const context = storage as StorageContext;
  return async (
    request: Request,
    route: LiveRoomPauseRoute,
    ownerUserId: string,
  ): Promise<Response> => {
    if (!storage.workspaceIsOwnedBy(route.workspaceId, ownerUserId)) throw notFound();
    const { workspaceId, pauseId, action } = route;
    const method = action === undefined || action === "copy" ? "GET" : "POST";
    if (request.method !== method) throw relayError("method_not_allowed");
    if (pauseId === undefined || action === undefined)
      return Response.json({ pauses: liveRoomPauses(context, workspaceId) }, { headers: PRIVATE });
    if (action === "copy") {
      const copy = liveRoomPauseCopy(context, workspaceId, pauseId);
      if (!copy) throw notFound();
      return new Response(copy, {
        headers: { ...PRIVATE, "content-type": "application/octet-stream" },
      });
    }
    if (action === "copy-written") {
      const body = await readJsonObject(request);
      if (
        Object.keys(body).join() !== "sha256" ||
        typeof body.sha256 !== "string" ||
        !SHA256_HEX_PATTERN.test(body.sha256)
      )
        throw badRequest("Invalid copy digest.");
      const recorded = recordLiveRoomCopyWritten(context, workspaceId, pauseId, body.sha256);
      if (recorded === "none") throw notFound();
      if (recorded === "mismatch") throw relayError("conflict", "The copy's digest differs.");
      return Response.json({ ok: true }, { headers: PRIVATE });
    }
    const resumed = resumeLiveRoom(context, workspaceId, pauseId);
    if (resumed === "none") throw notFound();
    if (resumed === "copy-unwritten")
      throw relayError("conflict", "Write the paused note's copy next to it before resuming it.");
    return Response.json({ ok: true }, { headers: PRIVATE });
  };
}
