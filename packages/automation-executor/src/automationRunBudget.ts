import type { StoredRun, StoredStep } from "./automationRunStore";

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Reserve the prepared output, normal progress and bounded dataset replans. */
export function stepReservationBytes(step: StoredStep, maxReplans: number): number {
  const replans = step.effects.reduce((bytes, effect) => {
    if (effect.kind !== "dataset-edit") return bytes;
    const kept = effect.fields.map((field) => ({ kind: "dataset-kept", datasetId: effect.rules.datasetId,
      tableId: effect.tableId, recordId: effect.target.recordId, fieldId: field.fieldId, field: field.field,
      planned: field.after, current: field.before }));
    return bytes + maxReplans * bytesOf({ kind: "replan", effect: Number.MAX_SAFE_INTEGER,
      replan: maxReplans, version: Number.MAX_SAFE_INTEGER, fields: effect.fields, kept });
  }, 0);
  // Per-effect room covers progress envelopes, identities and Add receipts.
  // Dataset operation receipts are independently bounded to 256 KiB.
  const actions = step.effects.filter((effect) => effect.kind === "dataset-action").length * 256 * 1024;
  return 2 * bytesOf(step) + 1024 * (step.effects.length + 1) + replans + actions;
}

export function runReservationBytes(run: StoredRun, maxReplans: number): number {
  const { steps, applied, created, replans, undoRequests, undoCalls, undoCovers, ...header } = run;
  const planned = steps.reduce((bytes, step) => bytes + stepReservationBytes(step, maxReplans), 0);
  const recorded = bytesOf({ steps, applied, created, replans, undoRequests, undoCalls, undoCovers });
  return bytesOf(header) + Math.max(planned, recorded);
}
