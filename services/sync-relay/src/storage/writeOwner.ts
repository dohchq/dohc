import { randomUUID } from "node:crypto";
import type { SqliteDb } from "./types";

export interface RelayContinuity {
  confirm(stamp: number, nonce: string, previousNonce: string): void;
  close(): void;
}

const MARKER = "sync_relay_continuity";

/** Owns the sole synchronous write transaction and the lifetime of its responses. */
export class RelayWriteOwner {
  readonly #unavailable = new AbortController();
  #writing = false;
  #stamp: number;
  #nonce: string;
  readonly #changes;
  readonly #schema;
  constructor(
    readonly db: SqliteDb,
    readonly continuity?: RelayContinuity,
    stamp = 0,
    nonce = "",
  ) {
    this.#stamp = stamp;
    this.#nonce = nonce;
    this.#changes = continuity ? db.prepare("SELECT total_changes() AS count") : undefined;
    this.#schema = continuity ? db.prepare("PRAGMA schema_version") : undefined;
  }

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
    let began = false, changed = false, committing = false;
    const previous = this.#stamp;
    let stamp = previous, nonce = this.#nonce;
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
        stamp = previous + 1;
        if (!Number.isSafeInteger(stamp)) throw new Error("Relay continuity stamp is exhausted.");
        nonce = randomUUID();
        changed = true;
        const updated = this.db.prepare(`UPDATE ${MARKER} SET stamp=?,nonce=?,previous_nonce=? WHERE singleton=1 AND stamp=? AND nonce=?`)
          .run(stamp, nonce, this.#nonce, previous, this.#nonce);
        if (Number(updated.changes) !== 1) {
          this.invalidate();
          throw new Error("Relay continuity marker changed.");
        }
      }
      committing = true;
      this.db.exec("COMMIT");
      began = false;
      if (changed) this.continuity!.confirm(stamp, nonce, this.#nonce);
      this.#stamp = stamp;
      this.#nonce = nonce;
      return result;
    } catch (error) {
      if (began) {
        try {
          this.db.exec("ROLLBACK");
        } catch { this.invalidate(); }
      }
      if (committing) this.invalidate();
      throw error;
    } finally { this.#writing = false; }
  }

  private mutationState(): string {
    return JSON.stringify([
      this.#changes!.get()?.count,
      this.#schema!.get()?.schema_version,
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
