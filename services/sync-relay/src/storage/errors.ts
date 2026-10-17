import { RelayError } from "../errors";

export class SyncRelayConflictError extends RelayError {
  constructor(message: string) {
    super("conflict", message);
  }
}

export class SyncRelayQuotaExceededError extends RelayError {
  constructor(message: string) {
    super("quota_exceeded", message);
  }
}

// A log append referenced a blob the relay does not hold. 422 (not 409): the
// push client reserves 409 for same-origin log divergence (rewind/probe
// recovery), so a blob-missing rejection must use a distinct retryable status
// the client surfaces as a generic failure and retries -- its next push
// re-uploads the missing blob (via /blobs/have) before re-posting the batch.
export class SyncRelayBlobMissingError extends RelayError {
  constructor(message: string) {
    super("blob_missing", message);
  }
}

/** A log append's answer for blobs it may not reference, whatever the reason. */
export function logBlobsMissing(missing: readonly string[]): SyncRelayBlobMissingError {
  return new SyncRelayBlobMissingError(
    `log append references ${missing.length} blob(s) not stored on the relay ` +
      `(first: ${missing[0]}); (re-)upload the blob(s) and retry`,
  );
}

export class LiveJournalAdmittedCapacityError extends Error {
  readonly source = "admitted-cut";
  readonly reason = "capacity-refused";
  constructor() { super("Admitted live update journal cut exceeds the validation policy."); }
}
