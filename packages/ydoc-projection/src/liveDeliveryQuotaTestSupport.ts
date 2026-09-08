import type { DatabaseSync } from "node:sqlite";
import { HOST_CONTROL_IDENTIFIER_MAX_BYTES } from "@dohc/live-session-contract/host-control";
import { LIVE_UPDATE_IDENTIFIER_MAX_BYTES, type LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";

export function liveDeliveryBookkeepingBytes(db: DatabaseSync): number {
  const sum = (table: string, expression: string) => Number(db.prepare(
    `SELECT COALESCE(SUM(${expression}),0) AS bytes FROM ${table} WHERE workspace_id='workspace'`,
  ).get()!.bytes);
  return sum("sync_relay_live_delivery_hosts", "accounted_bytes")
    + sum("sync_relay_live_delivery_documents", "accounted_bytes")
    + sum("sync_relay_live_delivery_reservations", "reserved_bytes + accounted_bytes")
    + sum("sync_relay_live_delivery_bootstraps", "accounted_bytes")
    + sum("sync_relay_live_delivery_edges", "accounted_bytes");
}

export function liveDeliveryEventReservationBytes(document: LiveDocumentKey, hostId: string,
  event: { journalCursor: number; deliveryId: string; updateDigest: string; acceptingHostEpoch: number }): number {
  const maximum = Number.MAX_SAFE_INTEGER;
  const identifier = "\\".repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES);
  const hostIdentifier = "\\".repeat(HOST_CONTROL_IDENTIFIER_MAX_BYTES);
  const acknowledgement = [identifier, document.workspaceId, event.journalCursor, maximum,
    event.deliveryId, event.updateDigest, event.acceptingHostEpoch, maximum, "service", maximum,
    hostIdentifier, hostIdentifier];
  const reservationRow = [document.workspaceId, document.mainVersionId, document.objectId,
    document.lineageClaimId, hostId, event.journalCursor, maximum];
  return Buffer.byteLength(JSON.stringify(acknowledgement)) + Buffer.byteLength(JSON.stringify(reservationRow));
}
