import type { SqliteDb } from "./types";

export interface RelayContinuity {
  /** Persist the expected relay marker before its transaction can commit. */
  reserve(previous: number): number;
  cancel(stamp: number, previous: number): void;
  close(): void;
}

const MARKER = "sync_relay_continuity";

/** Owns the sole synchronous write transaction and the lifetime of its responses. */
export class RelayWriteOwner {
  readonly #unavailable = new AbortController();
  #writing = false;
  #stamp: number;
  constructor(
    readonly db: SqliteDb,
    readonly continuity?: RelayContinuity,
    stamp = 0,
  ) { this.#stamp = stamp; }

  get unavailable(): AbortSignal { return this.#unavailable.signal; }

  captureStanding(): () => void {
    const check = () => {
      if (this.unavailable.aborted) throw new Error("Relay storage is unavailable.");
    };
    check();
    return check;
  }

  write<T>(operation: () => T): T {
    this.captureStanding();
    if (this.#writing) throw new Error("Nested relay transactions are not supported.");
    this.#writing = true;
    let began = false, reserved = false, committing = false;
    const previous = this.#stamp;
    let stamp = previous;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const before = this.continuity ? this.mutationState() : undefined;
      const result = operation();
      if (result !== null && (typeof result === "object" || typeof result === "function") &&
          "then" in result) throw new TypeError("Relay write callbacks must be synchronous.");
      this.captureStanding();
      if (this.continuity && this.mutationState() !== before) {
        // Refused and read-only callbacks do not incur durable sidecar writes.
        // A failed reservation may have committed. Do not cancel that uncertainty.
        try { stamp = this.continuity.reserve(previous); reserved = true; }
        catch (error) { this.invalidate(); throw error; }
        const changed = this.db.prepare(`UPDATE ${MARKER} SET stamp=? WHERE singleton=1 AND stamp=?`).run(stamp, previous);
        if (Number(changed.changes) !== 1) {
          this.invalidate();
          throw new Error("Relay continuity marker changed.");
        }
      }
      committing = true;
      this.db.exec("COMMIT");
      began = false;
      this.#stamp = stamp;
      return result;
    } catch (error) {
      if (committing) this.invalidate();
      if (began) {
        try {
          this.db.exec("ROLLBACK");
          if (reserved && !committing && !this.unavailable.aborted) this.continuity!.cancel(stamp, previous);
        } catch { this.invalidate(); }
      }
      throw error;
    } finally { this.#writing = false; }
  }

  private mutationState(): string {
    return JSON.stringify([
      this.db.prepare("SELECT total_changes() AS count").get()?.count,
      this.db.prepare("PRAGMA schema_version").get()?.schema_version,
    ]);
  }

  invalidate(): void { this.#unavailable.abort(); }

  close(): void {
    this.invalidate();
    // Keep deployment ownership if the database cannot close.
    this.db.close();
    this.continuity?.close();
  }
}
