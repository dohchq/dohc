import * as Y from "yjs";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveMarkdownRegistrationEvidence } from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import { createLiveMarkdownRegistrationValidator } from "../../../../packages/ydoc-projection/src/liveDocumentValidation";
import type { OrderedLiveUpdateCutPolicy } from "../../../../packages/ydoc-projection/src/orderedLiveUpdateCut";

// A live validation process loads this module, so it imports nothing that reads storage.
/** A capture past a read or work budget. The same capture refuses the same way, so activation waits for it to change. */
export class ServiceActivationHistoryOverBudget extends Error {}
/** A capture's validation. One the relay already retains checks only its baseline. */
export interface OrdinaryActivationWork {
  readonly document: LiveDocumentKey;
  readonly currentPath: string;
  readonly baselineBytes: Uint8Array;
  readonly fullState?: Uint8Array;
}
export type OrdinaryActivationBaseline = Pick<
  LiveMarkdownRegistrationEvidence,
  "projectedMarkdownSha256" | "projectedMarkdownByteLength"
> & {
  readonly checkpoint: Pick<
    LiveMarkdownRegistrationEvidence["checkpoint"],
    "updateDigest" | "ranges"
  >;
};
export type OrdinaryActivationValidation =
  | { kind: "accepted"; baseline: OrdinaryActivationBaseline }
  | { kind: "refused"; message: string }
  | { kind: "baseline-refused"; message: string }
  | { kind: "capacity-refused" }
  | { kind: "retry"; reason: "admission-unavailable" };
/**
 * `hasCapacity` says whether a validation slot is free now, so a pass captures nothing while the pool is busy.
 * `waitForCapacity` settles once one may be free, which another operation can still take first.
 */
export type OrdinaryActivationValidator = ((
  work: OrdinaryActivationWork,
  signal?: AbortSignal,
) => Promise<OrdinaryActivationValidation>) & {
  readonly hasCapacity?: () => boolean;
  readonly waitForCapacity?: (signal?: AbortSignal) => Promise<void>;
};
function applyingLeavesUnchanged(whole: Uint8Array, part: Uint8Array): boolean {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, whole);
    const before = Y.snapshot(doc);
    Y.applyUpdate(doc, part);
    return (
      doc.store.pendingStructs === null &&
      doc.store.pendingDs === null &&
      Y.equalSnapshots(before, Y.snapshot(doc))
    );
  } finally {
    doc.destroy();
  }
}
/**
 * Validates a capture's baseline and full state, each as a standalone live document, and that the full state contains
 * the baseline. Runs in a validation process; it reads no storage. Each refusal message is the one activation reports.
 */
export function validateOrdinaryActivation(
  work: OrdinaryActivationWork,
  policy: OrderedLiveUpdateCutPolicy,
): Exclude<OrdinaryActivationValidation, { kind: "capacity-refused" | "retry" }> {
  const { document, currentPath, baselineBytes, fullState } = work,
    validateRegistration = createLiveMarkdownRegistrationValidator(policy);
  const base = validateRegistration({ document, currentPath, checkpoint: baselineBytes });
  if (base.kind !== "accepted")
    return {
      kind: "baseline-refused",
      message: "Native activation does not match the ordinary source.",
    };
  const baseline = {
    checkpoint: {
      updateDigest: base.evidence.checkpoint.updateDigest,
      ranges: base.evidence.checkpoint.ranges,
    },
    projectedMarkdownSha256: base.evidence.projectedMarkdownSha256,
    projectedMarkdownByteLength: base.evidence.projectedMarkdownByteLength,
  };
  if (!fullState) return { kind: "accepted", baseline };
  if (validateRegistration({ document, currentPath, checkpoint: fullState }).kind !== "accepted")
    return {
      kind: "refused",
      message: "Native activation is not a complete standalone CRDT state.",
    };
  if (!applyingLeavesUnchanged(fullState, baselineBytes))
    return { kind: "refused", message: "Native activation does not contain its baseline." };
  return { kind: "accepted", baseline };
}
