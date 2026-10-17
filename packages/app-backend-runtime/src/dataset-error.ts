export class DatasetHostError extends Error {
  constructor(readonly code: "not_authorized" | "conflict" | "invalid", message: string) {
    super(message); this.name = "DatasetHostError";
  }
}
