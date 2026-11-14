import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { recordRelayWrite, relayMainThreadTimingOn } from "../relayMainThreadTiming";
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
  // The database file and when a checkpoint last wrote it. In WAL mode only a checkpoint writes the file.
  #file: string | null | undefined;
  #fileChangedNs: bigint | undefined;
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

  get unavailable(): AbortSignal {
    return this.#unavailable.signal;
  }

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
    let began = false,
      changed = false,
      committing = false;
    const previous = this.#stamp;
    let stamp = previous,
      nonce = this.#nonce;
    const timed = relayMainThreadTimingOn();
    const startedAt = timed ? performance.now() : 0;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      const before = this.continuity ? this.mutationState() : undefined;
      const result = operation();
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result
      )
        throw new TypeError("Relay write callbacks must be synchronous.");
      this.captureStanding();
      if (this.continuity && this.mutationState() !== before) {
        // Refused and read-only callbacks do not incur durable sidecar writes.
        stamp = previous + 1;
        if (!Number.isSafeInteger(stamp)) throw new Error("Relay continuity stamp is exhausted.");
        nonce = randomUUID();
        changed = true;
        const updated = this.db
          .prepare(
            `UPDATE ${MARKER} SET stamp=?,nonce=?,previous_nonce=? WHERE singleton=1 AND stamp=? AND nonce=?`,
          )
          .run(stamp, nonce, this.#nonce, previous, this.#nonce);
        if (Number(updated.changes) !== 1) {
          this.invalidate();
          throw new Error("Relay continuity marker changed.");
        }
      }
      committing = true;
      const commitAt = timed ? performance.now() : 0;
      this.db.exec("COMMIT");
      began = false;
      const committedAt = timed ? performance.now() : 0;
      if (changed) this.continuity!.confirm(stamp, nonce, this.#nonce);
      this.#stamp = stamp;
      this.#nonce = nonce;
      // Without continuity the owner cannot tell a write that changed nothing, so it counts every write.
      if (timed && (changed || !this.continuity)) {
        // A committed write must not fail, and invalidate storage, because measuring it failed.
        try {
          const endedAt = performance.now();
          recordRelayWrite({
            writeMs: endedAt - startedAt,
            commitMs: committedAt - commitAt,
            confirmMs: changed ? endedAt - committedAt : null,
            checkpoint: this.#checkpointed(),
          });
        } catch {
          /* The write stands. */
        }
      }
      return result;
    } catch (error) {
      if (began) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          this.invalidate();
        }
      }
      if (committing) this.invalidate();
      throw error;
    } finally {
      this.#writing = false;
    }
  }

  /** Whether a checkpoint wrote the database file since the last write, read from its change time. */
  #checkpointed(): boolean {
    try {
      if (this.#file === undefined) {
        const main = this.db.prepare("PRAGMA database_list").get() as
          | { file?: unknown }
          | undefined;
        this.#file = typeof main?.file === "string" && main.file !== "" ? main.file : null;
      }
      if (this.#file === null) return false;
      const changedNs = statSync(this.#file, { bigint: true, throwIfNoEntry: false })?.mtimeNs;
      const checkpointed = this.#fileChangedNs !== undefined && changedNs !== this.#fileChangedNs;
      this.#fileChangedNs = changedNs;
      return checkpointed;
    } catch {
      return false;
    }
  }

  private mutationState(): string {
    return JSON.stringify([this.#changes!.get()?.count, this.#schema!.get()?.schema_version]);
  }

  invalidate(): void {
    this.#unavailable.abort();
  }

  close(): void {
    this.invalidate();
    // Keep deployment ownership if the database cannot close.
    this.db.close();
    this.continuity?.close();
  }
}
