import { failureSentence } from "../ipc/errorWords";
import type { FailureCode, FailureFacts } from "./failure";

// The shell's Notices, which draws a toast and a row from each notice. A
// notice is filed under its identity. `quiet` changes the row where it stands,
// with no new toast. `onDismiss` runs when the person dismisses the row, and
// `clear` takes the row back.
export interface NoticeSink {
  report(
    words: string,
    cause: unknown,
    retry: () => void,
    identity: string,
    quiet: boolean,
    onDismiss: () => void,
  ): void;
  clear(identity: string): void;
}

// One cause's notice, which only `NoticeOwner.open` makes.
export interface CauseNotice<Code extends FailureCode> {
  // A failure of this cause arrived. Call it when the failure arrives, before
  // deciding what to show, so a dismissal after that moment covers it.
  failed(): void;
  // Files the notice, or changes its words where it stands. The same words
  // again change nothing. After a dismissal, it files only if the cause
  // failed again since. `cause` is the error as it arrived, for Copy details.
  show(facts: FailureFacts[Code], cause: unknown): void;
  // The facts last filed, if a notice is filed. The shell can drop a report,
  // so a filed notice may have no row.
  shown(): FailureFacts[Code] | undefined;
  // The cause works again: the row goes, and so does a dismissal.
  resolve(): void;
  // The view went away: the row goes, and Try again runs nothing from now on.
  close(): void;
}

// Each notice's identity is unique across every owner.
let opened = 0;

// The notices of one workspace, one for each cause a view opens. The owner
// decides when a cause's notice is filed, changed, or taken back, and whether
// a failure after a dismissal is new. The shell's row still decides whether a
// toast shows and whether the row is unread. The shell can also drop a report,
// as for a stopped workspace's read, or its Try again, for an error that
// cannot be retried.
export class NoticeOwner {
  constructor(private readonly sink: NoticeSink) {}

  // Opens a cause's notice with what its Try again runs. Only the view that
  // can run it opens one, and it closes the notice when it goes.
  open<Code extends FailureCode>(code: Code, retry: () => void): CauseNotice<Code> {
    const sink = this.sink;
    const identity = `${code}:${(opened += 1)}`;
    let run: (() => void) | null = retry;
    let failures = 0;
    // The failure count when the person dismissed the row.
    let dismissedAt: number | null = null;
    let filed: { facts: FailureFacts[Code]; words: string } | null = null;
    const notice: CauseNotice<Code> = {
      failed: () => {
        failures += 1;
      },
      show: (facts, cause) => {
        if (run === null) return;
        if (dismissedAt !== null && failures <= dismissedAt) return;
        const words = failureSentence({ code, facts });
        if (filed?.words === words) return;
        const quiet = filed !== null;
        filed = { facts, words };
        sink.report(
          words,
          cause,
          () => {
            // Notices takes the row away once Try again runs.
            filed = null;
            run?.();
          },
          identity,
          quiet,
          () => {
            if (filed === null) return;
            filed = null;
            dismissedAt = failures;
          },
        );
      },
      shown: () => filed?.facts,
      resolve: () => {
        dismissedAt = null;
        if (filed === null) return;
        filed = null;
        sink.clear(identity);
      },
      close: () => {
        notice.resolve();
        run = null;
      },
    };
    return notice;
  }
}
