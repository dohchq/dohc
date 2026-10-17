import { asRecord } from "@dohc/workspace-core";
import { stableJsonStringify } from "../canonicalJson";
import type { SqliteDb, SyncRelayLogInput } from "./types";

/**
 * Why the relay kept a row out of its projections. Clients never set it.
 * `refused`: the row is a relay-written refusal at the client's coordinate.
 * `departed`: a hosted document's publication accepted after the document
 * left its enrolled path. It keeps its history and attribution, and no
 * projection reads it, so it cannot bring the document back.
 */
export type RelayAdmission = "refused" | "departed";

/**
 * The op kind the relay writes at a coordinate it refused. The row keeps the
 * coordinate, the refused kind and a digest of its payload, never the payload.
 */
export const REFUSED_OP_KIND = "relay.refused";

export interface RelayRefusal {
  opKind: string;
  payloadSha256: string;
  reason: string;
}

const COLUMN = "relay_admission TEXT CHECK(relay_admission IS NULL OR relay_admission IN ('refused','departed'))";

/** Runs after every earlier `sync_relay_log` column, whose positions are checked. */
export function initializeRelayAdmissionColumn(db: SqliteDb): void {
  if (db.prepare("PRAGMA table_info(sync_relay_log)").all().some(column => column.name === "relay_admission")) return;
  db.exec(`ALTER TABLE sync_relay_log ADD COLUMN ${COLUMN}`);
}

/** Turns `op` into the row the relay keeps for refusing it, at the same coordinate and time. */
export function refuseOp(op: SyncRelayLogInput, refusal: RelayRefusal): void {
  op.opKind = REFUSED_OP_KIND;
  op.payloadJson = stableJsonStringify(refusal);
  op.relayAdmission = "refused";
  delete op.admittedAuthorSnapshot;
  delete op.settlementAdmission;
}

/** The refusal a relay-written row records, or null for any other row. */
export function readRefusal(row: Pick<SyncRelayLogInput, "opKind" | "payloadJson">): RelayRefusal | null {
  if (row.opKind !== REFUSED_OP_KIND) return null;
  const payload = asRecord(JSON.parse(row.payloadJson));
  if (typeof payload?.opKind !== "string" || typeof payload.payloadSha256 !== "string" || typeof payload.reason !== "string") {
    throw new Error("A relay refusal row is damaged.");
  }
  return { opKind: payload.opKind, payloadSha256: payload.payloadSha256, reason: payload.reason };
}
