import type {OrderedLiveUpdateCutPolicy} from "@dohc/ydoc-projection/live-journal-validation";

/** Calibrated for the validation worker's 512 MB heap. */
export const WORKER_LIVE_VALIDATION_POLICY: OrderedLiveUpdateCutPolicy = Object.freeze({
  maxStructVisits: 400_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 100_000_000,
});
