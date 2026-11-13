import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { failureSentence, ipcWireError, withErrorWords, type FailureWords } from "../ipc/errorWords";
import type { Failure, Recovery, VersionsRead } from "./failure";
import { NoticeOwner, type NoticeSink } from "./noticeOwner";

// What the shell's Notices shows for each report: the toast's words as the
// shell writes them, whether a new toast shows, and whether Try again does.
type Shown = { words: string; toast: boolean; tryAgain: boolean } | { cleared: true };

const SCOPE = "ws-1";
const RECOVERY: Recovery = { retry: "read-versions-again", input: { page: "page-1" } };
const read = (which: VersionsRead | "several", cause: unknown = new Error("engine went away")): Failure =>
  ({ code: "versions-reads", facts: { read: which }, cause });

// One cause's notice, as the owner and each copy of older logic take it.
interface Filer {
  fail(failure: Failure, occurrence: number): void;
  works(): void;
  // The person dismisses the row.
  dismiss(): void;
}

function owner(): { filer: Filer; shown: Shown[]; notices: NoticeOwner } {
  const shown: Shown[] = [];
  let dismissRow = () => {};
  const notices = new NoticeOwner(SCOPE, {
    report(words, cause, retry, _identity, quiet, onDismiss) {
      shown.push({ words: withErrorWords(words, cause), toast: !quiet, tryAgain: typeof retry === "function" });
      dismissRow = onDismiss;
    },
    clear: () => shown.push({ cleared: true }),
  });
  return {
    shown,
    notices,
    filer: {
      fail: (failure, occurrence) => notices.reportFailure(SCOPE, { failure, target: "page-1", recovery: RECOVERY, occurrence }),
      works: () => notices.resolve(SCOPE, { code: "versions-reads", target: "page-1" }),
      dismiss: () => dismissRow(),
    },
  };
}

// The Versions page before #3582: one row it filed and changed, with no way
// to learn the person dismissed it.
function before3582(): { filer: Filer; shown: Shown[] } {
  const shown: Shown[] = [];
  let filed: string | null = null;
  return {
    shown,
    filer: {
      fail(failure) {
        const words = failureSentence(failure);
        if (words === filed) return;
        shown.push({ words: withErrorWords(words, failure.cause), toast: filed === null, tryAgain: true });
        filed = words;
      },
      works() {
        if (filed !== null) shown.push({ cleared: true });
        filed = null;
      },
      dismiss() {},
    },
  };
}

// The Versions page before #3285: each failing read told the shell once,
// with no Try again, and nothing took its row back when the read worked.
function before3285(): { filer: Filer; shown: Shown[] } {
  const shown: Shown[] = [];
  const failing = new Set<string>();
  return {
    shown,
    filer: {
      fail(failure) {
        if (failing.has(failure.facts.read)) return;
        failing.add(failure.facts.read);
        shown.push({ words: withErrorWords(failureSentence(failure), failure.cause), toast: true, tryAgain: false });
      },
      works: () => failing.clear(),
      dismiss() {},
    },
  };
}

// A notice before #3192: a row in Notices only, with no toast and no Try again.
function before3192(): { filer: Filer; shown: Shown[] } {
  const shown: Shown[] = [];
  return {
    shown,
    filer: {
      fail: (failure) => shown.push({ words: failureSentence(failure), toast: false, tryAgain: false }),
      works: () => shown.push({ cleared: true }),
      dismiss() {},
    },
  };
}

// The words before #1261 and #2611: the caller's sentence, then the error's
// message as it arrived.
function beforeErrorWords(): { filer: Filer; shown: Shown[] } {
  const shown: Shown[] = [];
  return {
    shown,
    filer: {
      fail: (failure) => shown.push({
        words: `${failureSentence(failure)} ${failure.cause instanceof Error ? failure.cause.message : String(failure.cause)}`,
        toast: true,
        tryAgain: true,
      }),
      works: () => shown.push({ cleared: true }),
      dismiss() {},
    },
  };
}

// An error as the renderer receives it from main.
const acrossIpc = (error: unknown, channel: string) =>
  new Error(`Error invoking remote method '${channel}': ${String(ipcWireError(error))}`);

const LAST_CHANGES = "dohc could not read when each version last changed.";
const SEVERAL = "dohc could not finish loading Versions.";

describe("past notice bugs, rebuilt", () => {
  // #3582: a failure after a dismissal changed a row that was gone.
  it("files a new toast when a read fails again after the person dismissed its row", () => {
    const run = (made: { filer: Filer; shown: Shown[] }) => {
      made.filer.fail(read("last-changes"), 1);
      made.filer.dismiss();
      made.filer.fail(read("last-changes"), 2);
      return made.shown.slice(1);
    };
    const shown = { words: `${LAST_CHANGES} engine went away`, toast: true, tryAgain: true };
    expect(run(before3582())).toEqual([]);
    expect(run(owner())).toEqual([shown]);
  });

  it("shows a toast for new words after the person dismissed the row", () => {
    const run = (made: { filer: Filer; shown: Shown[] }) => {
      made.filer.fail(read("last-changes"), 1);
      made.filer.dismiss();
      made.filer.fail(read("several"), 2);
      return made.shown.slice(1);
    };
    expect(run(before3582())).toEqual([{ words: `${SEVERAL} engine went away`, toast: false, tryAgain: true }]);
    expect(run(owner())).toEqual([{ words: `${SEVERAL} engine went away`, toast: true, tryAgain: true }]);
  });

  it("keeps a dismissed row gone while the same failure stands", () => {
    const made = owner();
    made.filer.fail(read("last-changes"), 1);
    made.filer.dismiss();
    made.filer.fail(read("last-changes"), 1);
    made.filer.fail(read("several"), 1);
    expect(made.shown).toHaveLength(1);
  });

  // #3285: a failed read had no Try again, and its row stayed after it worked.
  it("gives a failure Try again, and takes its row back once the cause works", () => {
    const run = (made: { filer: Filer; shown: Shown[] }) => {
      made.filer.fail(read("last-changes"), 1);
      made.filer.works();
      return made.shown;
    };
    expect(run(before3285())).toEqual([{ words: `${LAST_CHANGES} engine went away`, toast: true, tryAgain: false }]);
    expect(run(owner())).toEqual([{ words: `${LAST_CHANGES} engine went away`, toast: true, tryAgain: true }, { cleared: true }]);
  });

  it("changes one row where it stands when the same cause gets new words", () => {
    const made = owner();
    made.filer.fail(read("last-changes"), 1);
    made.filer.fail(read("several"), 2);
    made.filer.fail(read("several"), 3);
    expect(made.shown).toEqual([
      { words: `${LAST_CHANGES} engine went away`, toast: true, tryAgain: true },
      { words: `${SEVERAL} engine went away`, toast: false, tryAgain: true },
    ]);
  });

  // #3192: a failure showed only as a row, with no toast and no Try again.
  it("shows a new failure as a toast with Try again", () => {
    const run = (made: { filer: Filer; shown: Shown[] }) => {
      made.filer.fail(read("counts", null), 1);
      return made.shown;
    };
    const words = "dohc could not count the files that differ from Main.";
    expect(run(before3192())).toEqual([{ words, toast: false, tryAgain: false }]);
    expect(run(owner())).toEqual([{ words, toast: true, tryAgain: true }]);
  });

  // #1261: the toast named an error class instead of saying what failed.
  it("says what failed in words, not an error class", () => {
    const deadline = Object.assign(new Error("listVersionLastChanges took longer than 10000 ms"), { name: "EngineRequestDeadlineError" });
    const run = (made: { filer: Filer; shown: Shown[] }) => {
      made.filer.fail(read("last-changes", acrossIpc(deadline, "desktop:list-version-last-changes")), 1);
      return made.shown.map((shown) => "words" in shown && shown.words);
    };
    expect(run(beforeErrorWords())).toEqual([
      `${LAST_CHANGES} Error invoking remote method 'desktop:list-version-last-changes': EngineRequestDeadlineError: listVersionLastChanges took longer than 10000 ms`,
    ]);
    expect(run(owner())).toEqual([`${LAST_CHANGES} dohc did not answer in time. Try again.`]);
  });

  // #2611: a validation dump that crossed IPC showed after the sentence.
  it("keeps a validation dump out of the words", () => {
    const invalid = z.uuid().safeParse("not-an-id").error!;
    const run = (made: { filer: Filer; shown: Shown[] }) => {
      made.filer.fail(read("conflicts", acrossIpc(invalid, "desktop:count-workspace-version-conflicts")), 1);
      return made.shown.map((shown) => "words" in shown && shown.words);
    };
    const [before] = run(beforeErrorWords());
    expect(before).toContain('"code": "invalid_format"');
    expect(run(owner())).toEqual(["dohc could not read which merges have files to decide."]);
  });
});

describe("NoticeOwner", () => {
  it("files nothing for another workspace", () => {
    const made = owner();
    made.notices.reportFailure("ws-2", { failure: read("counts"), target: "page-1", recovery: RECOVERY, occurrence: 1 });
    made.notices.resolve("ws-2", { code: "versions-reads", target: "page-1" });
    expect(made.shown).toEqual([]);
  });

  it("runs what the view registered for Try again, and nothing once the view is gone", () => {
    const retries: Array<() => void> = [];
    const sink: NoticeSink = { report: (_words, _cause, retry) => retries.push(retry), clear: () => {} };
    const notices = new NoticeOwner(SCOPE, sink);
    const run = vi.fn();
    const unregister = notices.handle(RECOVERY, run);
    notices.reportFailure(SCOPE, { failure: read("counts"), target: "page-1", recovery: RECOVERY, occurrence: 1 });
    retries[0]!();
    expect(run).toHaveBeenCalledOnce();
    // Try again took the row back, so the next failure toasts again.
    expect(notices.filedFailure("versions-reads", "page-1")).toBeUndefined();
    unregister();
    retries[0]!();
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not compile a failure code without words, or a report without a recovery", () => {
    // @ts-expect-error Every failure code needs words.
    const missing: FailureWords = {};
    const notices = new NoticeOwner(SCOPE, { report: () => {}, clear: () => {} });
    // @ts-expect-error A report names what Try again runs.
    const withoutRecovery = () => notices.reportFailure(SCOPE, { failure: read("counts"), target: "page-1", occurrence: 1 });
    expect([missing, withoutRecovery]).toHaveLength(2);
  });
});
