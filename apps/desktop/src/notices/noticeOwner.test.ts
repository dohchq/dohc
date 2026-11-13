import { describe, expect, it, vi } from "vitest";
import { withErrorWords, type FailureWords } from "../ipc/errorWords";
import { NoticeOwner } from "./noticeOwner";

// What the shell's Notices shows for each report: the toast's words as the
// shell writes them, and whether a new toast shows.
type Shown = { words: string; toast: boolean } | { cleared: true };

const CAUSE = new Error("engine went away");
const LAST_CHANGES = "dohc could not read when each version last changed. engine went away";
const SEVERAL = "dohc could not finish loading Versions. engine went away";

// One cause's notice, and the buttons on the row it last filed.
function opened() {
  const shown: Shown[] = [];
  const row = { dismiss: () => {}, tryAgain: () => {} };
  const notices = new NoticeOwner({
    report(words, cause, retry, _identity, quiet, onDismiss) {
      shown.push({ words: withErrorWords(words, cause), toast: !quiet });
      row.dismiss = onDismiss;
      row.tryAgain = retry;
    },
    clear: () => shown.push({ cleared: true }),
  });
  const retry = vi.fn();
  return { shown, row, retry, notices, notice: notices.open("versions-reads", retry) };
}

describe("NoticeOwner", () => {
  // #3582: a failure after a dismissal changed a row that was gone.
  it("files a new toast when the cause fails again after the person dismissed its row", () => {
    const { shown, row, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    row.dismiss();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    expect(shown).toEqual([{ words: LAST_CHANGES, toast: true }, { words: LAST_CHANGES, toast: true }]);
  });

  it("files new words after a dismissal as a new toast", () => {
    const { shown, row, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    row.dismiss();
    notice.failed();
    notice.show({ read: "several" }, CAUSE);
    expect(shown).toEqual([{ words: LAST_CHANGES, toast: true }, { words: SEVERAL, toast: true }]);
  });

  it("keeps a dismissed row gone until the cause fails again", () => {
    const { shown, row, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    row.dismiss();
    notice.show({ read: "last-changes" }, CAUSE);
    notice.show({ read: "several" }, CAUSE);
    expect(shown).toHaveLength(1);
  });

  it("counts a failure that arrived before the dismissal as dismissed", () => {
    const { shown, row, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    notice.failed();
    row.dismiss();
    notice.show({ read: "several" }, CAUSE);
    expect(shown).toHaveLength(1);
  });

  // #3285: a failed read had no Try again, and its row stayed after it worked.
  it("runs the registered Try again, and takes the row back once the cause works", () => {
    const { shown, row, retry, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    row.tryAgain();
    expect(retry).toHaveBeenCalledOnce();
    // Try again took the row back, so the next failure toasts again.
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    notice.resolve();
    expect(shown).toEqual([{ words: LAST_CHANGES, toast: true }, { words: LAST_CHANGES, toast: true }, { cleared: true }]);
  });

  it("changes one row where it stands when the same cause gets new words", () => {
    const { shown, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    notice.failed();
    notice.show({ read: "several" }, CAUSE);
    notice.show({ read: "several" }, CAUSE);
    expect(notice.shown()).toEqual({ read: "several" });
    expect(shown).toEqual([{ words: LAST_CHANGES, toast: true }, { words: SEVERAL, toast: false }]);
  });

  it("takes the row back and runs no Try again once the view closes", () => {
    const { shown, row, retry, notice } = opened();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    notice.close();
    row.tryAgain();
    notice.failed();
    notice.show({ read: "last-changes" }, CAUSE);
    expect(retry).not.toHaveBeenCalled();
    expect(shown).toEqual([{ words: LAST_CHANGES, toast: true }, { cleared: true }]);
  });

  it("files each opened notice under its own identity", () => {
    const identities: string[] = [];
    const notices = new NoticeOwner({ report: (_words, _cause, _retry, identity) => identities.push(identity), clear: () => {} });
    for (const notice of [notices.open("versions-reads", () => {}), notices.open("versions-reads", () => {})]) {
      notice.failed();
      notice.show({ read: "counts" }, CAUSE);
    }
    expect(new Set(identities).size).toBe(2);
  });

  it("does not compile a failure code without words, a notice without Try again, or a caller's count", () => {
    // @ts-expect-error Every failure code needs words.
    const missing: FailureWords = {};
    const notices = new NoticeOwner({ report: () => {}, clear: () => {} });
    // @ts-expect-error A notice names what Try again runs.
    const withoutRetry = () => notices.open("versions-reads");
    // @ts-expect-error Only the owner counts failures.
    const counted = () => notices.open("versions-reads", () => {}).failed(2);
    expect([missing, withoutRetry, counted]).toHaveLength(3);
  });
});
