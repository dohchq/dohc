import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  type LiveUpdateReceipt,
} from "@dohc/live-session-contract/live-update-admission";
import {EngineRequestError} from "@dohc/workspace-engine-client/daemon";

export interface CommittedSettlement {
  /** Null when nothing was accepted since the owner's handover or the first baseline, so nothing was recorded or published. */
  settlementId: string | null;
  previousCursor: number;
  terminalCursor: number;
  applicationCount: number;
  localYDocSequence: number;
  momentId: string;
  markdownDigest: string;
  materialized: boolean;
  collectionReconcileRequired: boolean;
}

export type PendingSettlement = {kind: "pending"; reason: "markdown-write-held" | "markdown-witness-check-pending"};
export type SettlementOutcome = CommittedSettlement | PendingSettlement;

export function settlementPending(value: SettlementOutcome): value is PendingSettlement {
  return "kind" in value && value.kind === "pending";
}

export async function settlementResponse(operation: Promise<{result: unknown}>, terminal: LiveUpdateReceipt | null): Promise<SettlementOutcome> {
  try { return settlementResult((await operation).result, terminal); }
  catch (error) {
    if (error instanceof EngineRequestError && error.wireError &&
      (error.wireError.message === "markdown-write-held" || error.wireError.message === "markdown-witness-check-pending")) {
      return {kind: "pending", reason: error.wireError.message};
    }
    throw error;
  }
}

export function settlementResult(value: unknown, terminal: LiveUpdateReceipt | null): SettlementOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native settlement response.");
  const response = value as Record<string, unknown>;
  if (Object.keys(response).sort().join() === "reason,status" && response.status === "pending" &&
    (response.reason === "markdown-write-held" || response.reason === "markdown-witness-check-pending")) {
    return {kind: "pending", reason: response.reason};
  }
  if (Object.keys(response).sort().join() !== "settlement,status" || response.status !== "settled" || !response.settlement || typeof response.settlement !== "object" || Array.isArray(response.settlement)) throw new Error("Invalid native settlement response.");
  const row = response.settlement as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "applicationCount,collectionReconcileRequired,localYDocSequence,markdownDigest,materialized,momentId,previousCursor,settlementId,terminalCursor") throw new Error("Invalid native settlement fields.");
  for (const key of ["previousCursor", "terminalCursor", "applicationCount", "localYDocSequence"]) {
    if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("Invalid native settlement integer.");
  }
  if (row.terminalCursor !== (terminal?.journalCursor ?? 0) || Number(row.previousCursor) > Number(row.terminalCursor) || Number(row.applicationCount) > Number(row.terminalCursor) - Number(row.previousCursor) || typeof row.materialized !== "boolean" || typeof row.collectionReconcileRequired !== "boolean") throw new Error("Native settlement coverage mismatch.");
  if (row.settlementId === null && row.previousCursor !== row.terminalCursor) throw new Error("Native settlement coverage mismatch.");
  return { settlementId: row.settlementId === null ? null : parseLiveUpdateIdentifier(row.settlementId,"settlement ID"), previousCursor: Number(row.previousCursor), terminalCursor: Number(row.terminalCursor), applicationCount: Number(row.applicationCount), localYDocSequence: Number(row.localYDocSequence), momentId: parseLiveUpdateIdentifier(row.momentId,"moment ID"), markdownDigest: parseLiveUpdateDigest(row.markdownDigest), materialized: row.materialized, collectionReconcileRequired: row.collectionReconcileRequired };
}
