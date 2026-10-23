export class DatasetHostError extends Error {
  constructor(readonly code: "not_authorized" | "conflict" | "invalid", message: string) {
    super(message); this.name = "DatasetHostError";
  }
}

export class DatasetBindingPendingAttemptError extends DatasetHostError {
  constructor() {
    super("conflict", "A response is pending in another app. Confirm it there before publishing this app.");
    this.name = "DatasetBindingPendingAttemptError";
  }
}
