import { failureSentence } from "../ipc/errorWords";
import type { Failure, FailureCode, Recovery } from "./failure";

// The shell's Notices, which draws a toast and a row from each notice. A
// notice is filed under its identity. `quiet` changes the row where it stands,
// with no new toast. `onDismiss` runs when the person dismisses the row, and
// `clear` takes the row back.
export interface NoticeSink {
  report(words: string, cause: unknown, retry: () => void, identity: string, quiet: boolean, onDismiss: () => void): void;
  clear(identity: string): void;
}

interface Filed {
  failure: Failure;
  words: string;
  occurrence: number;
}

const noticeIdentity = (code: FailureCode, target: string) => `${code}:${target}`;
const retryKey = (recovery: Recovery) => `${recovery.retry}\n${JSON.stringify(recovery.input)}`;

// One notice for each cause in one workspace: a failure code about one target.
// The toast and the Notices row both come from that one record. Filing the
// same words again changes nothing, and new words change the row where it
// stands. A dismissed notice stays gone until the cause fails again, and a
// later success takes the row back.
export class NoticeOwner {
  private readonly filed = new Map<string, Filed>();
  // Each dismissed cause, with the occurrence the person dismissed.
  private readonly dismissed = new Map<string, number>();
  // What a Try again runs, registered by the view that can run it while that
  // view is mounted. A notice keeps only the reference.
  private readonly retries = new Map<string, () => void>();

  constructor(private readonly scope: string, private readonly sink: NoticeSink) {}

  // `occurrence` grows with each new failure of this target, so a report after
  // a dismissal files again only for a failure the person has not dismissed.
  reportFailure(scope: string, report: { failure: Failure; target: string; recovery: Recovery; occurrence: number }): void {
    if (scope !== this.scope) return;
    const { failure, recovery, occurrence } = report;
    const identity = noticeIdentity(failure.code, report.target);
    const dismissedAt = this.dismissed.get(identity);
    if (dismissedAt !== undefined) {
      if (occurrence <= dismissedAt) return;
      this.dismissed.delete(identity);
    }
    const words = failureSentence(failure);
    const standing = this.filed.get(identity);
    if (standing?.words === words) {
      standing.occurrence = occurrence;
      return;
    }
    this.filed.set(identity, { failure, words, occurrence });
    this.sink.report(words, failure.cause, () => this.retry(identity, recovery), identity, standing !== undefined, () => this.dismiss(identity));
  }

  // The cause works again, or its view went away.
  resolve(scope: string, cause: { code: FailureCode; target: string }): void {
    if (scope !== this.scope) return;
    const identity = noticeIdentity(cause.code, cause.target);
    this.dismissed.delete(identity);
    if (this.filed.delete(identity)) this.sink.clear(identity);
  }

  // The failure a cause's notice shows now, if it shows one.
  filedFailure<Code extends FailureCode>(code: Code, target: string): Extract<Failure, { code: Code }> | undefined {
    // The identity names the code, so the failure filed under it has that code.
    return this.filed.get(noticeIdentity(code, target))?.failure as Extract<Failure, { code: Code }> | undefined;
  }

  // Registers what a Try again with this recovery runs. Returns the unregister.
  handle(recovery: Recovery, run: () => void): () => void {
    const key = retryKey(recovery);
    this.retries.set(key, run);
    return () => {
      if (this.retries.get(key) === run) this.retries.delete(key);
    };
  }

  // Notices takes the row away once Try again runs.
  private retry(identity: string, recovery: Recovery): void {
    this.filed.delete(identity);
    this.retries.get(retryKey(recovery))?.();
  }

  private dismiss(identity: string): void {
    const standing = this.filed.get(identity);
    if (standing === undefined) return;
    this.filed.delete(identity);
    this.dismissed.set(identity, standing.occurrence);
  }
}
