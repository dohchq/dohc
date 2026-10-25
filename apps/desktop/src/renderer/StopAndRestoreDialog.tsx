import { retainedCollectionFieldWritePaths } from "./collections/recordFieldWrites";
import { retainedOrphanedDraftPaths } from "./orphanedDrafts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StopAndRestoreResult, StopAndRestoreTarget, UndoStopAndRestoreResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { DangerButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { useRequestSequence } from "./useRequestSequence";
import { restoreRulesUnreadableWords } from "./workbench/HistoryPolicyStates";

// Stop and restore (ADR 0013): the owner picks a person they shared this
// workspace with, or an Edit share link, and confirms once. dohc stops that
// access, puts back every file written directly through it, and lists each
// file it left as it is, with why, then undoes runs of the automations
// changed through that access. Undo puts the files back as they were left;
// access stays stopped. Failures go to the shell's toast and Notices row,
// with Try again; a try that stopped part way also says in the dialog what
// it has not finished. A link is ended as a whole: stopping one of the
// browsers that hold it would leave the others writing.

/** A person or an Edit share link, as the dialog shows it. */
export interface StopTarget {
  target: StopAndRestoreTarget;
  label: string;
}

const keyOf = (target: StopAndRestoreTarget): string =>
  target.kind === "person" ? `person:${target.userId}` : `link:${target.grantId}`;

type Restored = Extract<StopAndRestoreResult, { status: "restored" }>;
type Receipt = Restored["restored"][number];
type State =
  | { kind: "loading" }
  | { kind: "choose"; targets: StopTarget[] }
  | { kind: "working"; targets: StopTarget[] }
  | { kind: "waiting"; targets: StopTarget[] }
  | { kind: "done"; targets: StopTarget[]; result: Restored; undone: boolean };

/** What the dialog runs as it opens: a Try again from the Notices row. */
export type StopAndRestoreStart = "stop" | "undo" | null;

export interface StopAndRestoreSession {
  workspaceId: string;
  target: StopTarget;
  start: StopAndRestoreStart;
  /** A new key opens the dialog afresh. */
  key: number;
}

/** Runs of automations a person or link changed that stop and restore undid, the fields on records gone from their Collection, and the other changes they left. */
interface RunTotals {
  runsUndone: number;
  fieldsMissing: number;
  otherKept: number;
}

/** What the dialog last showed for a target: its outcome, and whether it was undone. */
interface Shown {
  result: Restored;
  undone: boolean;
}

/**
 * The shell's hold on Stop and restore: which dialog is open, and per person
 * or link every file put back and the outcome the dialog last showed. A Try again
 * from the Notices row after the dialog closed opens it again on that
 * outcome, with Undo for every file, and a retry that fails leaves it there.
 */
export function useStopAndRestore(workspaceId: string, recovery?: {
  ready: boolean;
  onError(fallback: string, error: unknown, retry: () => void, identity: string): void;
}) {
  const [session, setSession] = useState<StopAndRestoreSession | null>(null);
  const receipts = useRef(new Map<string, Receipt[]>());
  const runs = useRef(new Map<string, RunTotals>());
  const shown = useRef(new Map<string, Shown>());
  const initialized = useRef(new Set<string>());
  const key = useRef(0);
  const retry = useCallback((forWorkspace: string, target: StopTarget, start: StopAndRestoreStart) => {
    key.current += 1;
    setSession({ workspaceId: forWorkspace, target, start, key: key.current });
  }, []);
  const open = useCallback((target: StopTarget) => retry(workspaceId, target, null), [retry, workspaceId]);
  const close = useCallback(() => setSession(null), []);
  const store = useMemo(() => {
    const id = (forWorkspace: string, target: StopAndRestoreTarget) => JSON.stringify([forWorkspace, keyOf(target)]);
    return {
      get: (forWorkspace: string, target: StopAndRestoreTarget): Receipt[] => receipts.current.get(id(forWorkspace, target)) ?? [],
      set: (forWorkspace: string, target: StopAndRestoreTarget, list: Receipt[]): void => {
        initialized.current.add(id(forWorkspace, target));
        receipts.current.set(id(forWorkspace, target), list);
      },
      /**
       * Runs undone across every try. A later try passes over runs an
       * earlier one undid, and Undo puts back only files, so these add up.
       */
      runs: (forWorkspace: string, target: StopAndRestoreTarget): RunTotals =>
        runs.current.get(id(forWorkspace, target)) ?? { runsUndone: 0, fieldsMissing: 0, otherKept: 0 },
      addRuns: (forWorkspace: string, target: StopAndRestoreTarget, more: RunTotals): RunTotals => {
        initialized.current.add(id(forWorkspace, target));
        const before = runs.current.get(id(forWorkspace, target)) ?? { runsUndone: 0, fieldsMissing: 0, otherKept: 0 };
        const after = {
          runsUndone: before.runsUndone + more.runsUndone,
          fieldsMissing: before.fieldsMissing + more.fieldsMissing,
          otherKept: before.otherKept + more.otherKept,
        };
        runs.current.set(id(forWorkspace, target), after);
        return after;
      },
      shown: (forWorkspace: string, target: StopAndRestoreTarget): Shown | null => shown.current.get(id(forWorkspace, target)) ?? null,
      show: (forWorkspace: string, target: StopAndRestoreTarget, value: Shown): void => {
        initialized.current.add(id(forWorkspace, target));
        shown.current.set(id(forWorkspace, target), value);
      },
      recover: (forWorkspace: string, target: StopAndRestoreTarget, list: Receipt[], value: Shown | null): boolean => {
        const key = id(forWorkspace, target);
        if (initialized.current.has(key)) return false;
        initialized.current.add(key);
        receipts.current.set(key, list);
        if (value) {
          shown.current.set(key, value);
          runs.current.set(key, {runsUndone: value.result.runsUndone, fieldsMissing: value.result.fieldsMissing, otherKept: otherKept(value.result)});
        }
        return true;
      },
      forget: (forWorkspace: string, target: StopAndRestoreTarget): void => {
        const key = id(forWorkspace, target);
        initialized.current.add(key);
        receipts.current.delete(key); runs.current.delete(key); shown.current.delete(key);
      },
    };
  }, []);
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  useEffect(() => {
    if (!recovery?.ready) return;
    let current = true;
    const recover = async () => {
      try {
        const pending = await bridge().pendingStopAndRestores({workspaceId});
        if (!current) return;
        for (const entry of pending) {
          const target = {target: entry.target, label: entry.label};
          if (!store.recover(workspaceId, entry.target, entry.receipts, entry.result.status === "restored"
            ? {result: entry.result, undone: entry.filesUndone} : null)) continue;
          const message = entry.result.status === "restored" && entry.result.unfinished?.step === "runs"
            ? "dohc has not finished undoing runs."
            : "dohc stopped before restoring every file.";
          recoveryRef.current?.onError(message, new Error(message), () => retry(workspaceId, target, entry.undoingFiles ? "undo" : "stop"),
            `stop-and-restore:${JSON.stringify([workspaceId, keyOf(entry.target)])}`);
        }
      } catch (error) {
        if (current) recoveryRef.current?.onError("dohc could not read unfinished Stop and restore progress.", error,
          () => void recover(), `stop-and-restore:recovery:${workspaceId}`);
      }
    };
    // Main answers nothing while the workspace is still opening, so read
    // again once its Collection automations open.
    const stop = bridge().onCollectionAutomationsChanged((event) => {
      if (event.workspaceId === workspaceId) void recover();
    });
    void recover();
    return () => {current = false; stop();};
  }, [workspaceId, recovery?.ready, store, retry]);
  return {
    session: session?.workspaceId === workspaceId ? session : null,
    open,
    retry,
    close,
    dismiss: async (identity: string): Promise<boolean> => {
      if (!identity.startsWith("stop-and-restore:")) return false;
      let parsed: unknown;
      try { parsed = JSON.parse(identity.slice("stop-and-restore:".length)); } catch { return false; }
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== workspaceId || typeof parsed[1] !== "string") return false;
      const key = parsed[1];
      const target: StopAndRestoreTarget | null = key.startsWith("person:") ? {kind: "person", userId: key.slice(7)}
        : key.startsWith("link:") ? {kind: "link", grantId: key.slice(5)} : null;
      if (target === null) return false;
      await bridge().dismissStopAndRestore({workspaceId, target});
      store.forget(workspaceId, target);
      setSession(current => current?.workspaceId === workspaceId && keyOf(current.target.target) === key ? null : current);
      return true;
    },
    receipts: store,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The changes runs kept other than fields; `runChangesKept` includes both field counts. */
const otherKept = (result: Restored): number => result.runChangesKept - result.keptFields.length - result.fieldsMissing;

// The owner's links in pages of 1,000; the dialog reads this many at most.
const MAX_LINK_PAGES = 5;

export function StopAndRestoreDialog({
  workspaceId, target: first, start, receipts, onRetry, onClose, onBeforeRestore, onRestored, onOpenFile, onOpenCollection, onError, onSettled,
}: {
  workspaceId: string;
  /** The person or link History showed, picked first, with History's label until the relay lists it. */
  target: StopTarget;
  start: StopAndRestoreStart;
  /** Files put back and the outcome shown, per person or link, kept by the shell across tries and closes. */
  receipts: ReturnType<typeof useStopAndRestore>["receipts"];
  /** Opens the dialog again for `target` and runs `action`. */
  onRetry(workspaceId: string, target: StopTarget, action: "stop" | "undo"): void;
  onClose(): void;
  onBeforeRestore(): Promise<() => void>;
  onRestored(): void;
  onOpenFile(path: string): void;
  onOpenCollection(path: string): void;
  /**
   * The shell's toast and Notices row, with Try again. Each person or link
   * has one row, `identity`, which a newer failure replaces.
   */
  onError(fallback: string, error: unknown, retry: () => void, identity: string): void;
  /** Removes the row of `identity`: what it reported has finished, or its Try again no longer applies. */
  onSettled(identity: string): void;
}) {
  // Opened again by a Try again, the dialog starts on what it last showed.
  const [state, setState] = useState<State>(() => {
    const last = start === null ? null : receipts.shown(workspaceId, first.target);
    return last ? { kind: "done", targets: [first], ...last } : { kind: "loading" };
  });
  // A failure goes back to what the dialog showed before it.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [key, setKey] = useState(keyOf(first.target));
  const request = useRequestSequence([workspaceId]);
  // Its own sequence, so an action that starts as the dialog opens does not drop the listing.
  const listingRequest = useRequestSequence([workspaceId]);
  const running = useRef(false);

  useEffect(() => {
    const token = listingRequest.next();
    // Everyone with Edit on this workspace, whose access is current or
    // ended, and every active Edit link. The relay's names are better than
    // History's label.
    void Promise.all([bridge().listRelayShares(), editLinks(workspaceId)]).then(([listing, links]) => {
      if (!listingRequest.isCurrent(token)) return;
      const targets = new Map<string, StopTarget>([[keyOf(first.target), first]]);
      for (const row of listing.granted) {
        if (row.workspaceId !== workspaceId || row.recipientUserId === null || row.access !== "edit") continue;
        const target = { kind: "person", userId: row.recipientUserId } as const;
        if (row.recipientEmail !== null || !targets.has(keyOf(target))) {
          targets.set(keyOf(target), { target, label: row.recipientEmail ?? row.recipientUserId });
        }
      }
      for (const link of links) targets.set(keyOf(link.target), link);
      listed([...targets.values()]);
    }, () => {
      // The person or link History showed can still be stopped.
      if (listingRequest.isCurrent(token)) listed([first]);
    });
    // A run started as the dialog opened keeps its own state.
    const listed = (list: StopTarget[]) =>
      setState((current) => current.kind === "loading" ? { kind: "choose", targets: list } : { ...current, targets: list });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // A Try again from the Notices row runs as the dialog opens again.
  useEffect(() => {
    if (start === "stop") void stop();
    if (start === "undo") void undo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targets = state.kind === "loading" ? [first] : state.targets;
  const chosen = targets.find((candidate) => keyOf(candidate.target) === key) ?? first;
  const words = wordsFor(chosen);
  const identity = `stop-and-restore:${JSON.stringify([workspaceId, keyOf(chosen.target)])}`;

  // The listing may land while an action runs; what it found stays.
  const listedTargets = (current: State): StopTarget[] => current.kind === "loading" ? targets : current.targets;

  async function perform(fallback: string, action: "stop" | "undo", work: (token: number) => Promise<void>): Promise<void> {
    if (running.current) return;
    running.current = true;
    const token = request.next();
    const before = stateRef.current;
    setState((current) => ({ kind: "working", targets: listedTargets(current) }));
    // Open editors settle first, and wait until the files are back.
    let release: (() => void) | null = null;
    try {
      release = await onBeforeRestore();
      await work(token);
    } catch (error) {
      if (request.isCurrent(token)) {
        setState((current) => before.kind === "loading"
          ? { kind: "choose", targets: listedTargets(current) }
          : { ...before, targets: listedTargets(current) });
      }
      onError(fallback, error, () => onRetry(workspaceId, chosen, action), identity);
    } finally {
      release?.();
      running.current = false;
    }
  }

  // A try that fails after an earlier one stopped access says access stays
  // stopped, and names what is still to finish.
  const stopFallback = (): string => {
    const last = receipts.shown(workspaceId, chosen.target);
    if (last !== null) return words.unfinished[last.result.unfinished?.step ?? "files"];
    return stateRef.current.kind === "waiting" ? words.unfinished.files : words.stopFailed;
  };

  const stop = (): Promise<void> => perform(stopFallback(), "stop", async (token) => {
    const filesUndone = receipts.shown(workspaceId, chosen.target)?.undone === true &&
      receipts.shown(workspaceId, chosen.target)?.result.unfinished !== null;
    const result = await bridge().stopAndRestore({ workspaceId, target: chosen.target, label: chosen.label, reviewPaths: [...new Set([...retainedCollectionFieldWritePaths(workspaceId), ...retainedOrphanedDraftPaths(workspaceId)])] });
    if (result.status === "waiting") {
      if (request.isCurrent(token)) setState((current) => ({ kind: "waiting", targets: listedTargets(current) }));
      return;
    }
    // A retry after file Undo restores no files. New receipts belong to a
    // fresh Stop and restore after access was granted again.
    const resumedFileUndo = filesUndone && result.restored.length === 0;
    if (filesUndone && !resumedFileUndo) receipts.forget(workspaceId, chosen.target);
    // Kept even when the dialog closed meanwhile, so a later try shows them.
    receipts.set(workspaceId, chosen.target, [...receipts.get(workspaceId, chosen.target), ...result.restored]);
    // Each try reports every field its runs keep now, but counts missing fields and other changes only for the runs it undid.
    const totals = receipts.addRuns(workspaceId, chosen.target, {
      runsUndone: result.runsUndone, fieldsMissing: result.fieldsMissing, otherKept: otherKept(result),
    });
    // A try that stopped before undoing runs may not have read every file
    // again, so the files to check stay as an earlier try found them, and so
    // does what the automations do while that try had not finished either.
    const earlier = result.unfinished?.step === "files" ? receipts.shown(workspaceId, chosen.target)?.result ?? null : null;
    const carried = earlier?.unfinished ? earlier : null;
    const outcome = {
      result: {
        ...result, restored: receipts.get(workspaceId, chosen.target), runsUndone: totals.runsUndone, fieldsMissing: totals.fieldsMissing,
        runChangesKept: totals.otherKept + result.keptFields.length + totals.fieldsMissing,
        ...(earlier === null ? {} : {
          review: [...new Map([...earlier.review, ...result.review].map((file) => [file.path, file])).values()]
            .sort((left, right) => left.path.localeCompare(right.path)),
          wroteAutomations: (carried?.wroteAutomations ?? false) || result.wroteAutomations,
          sendsMessages: (carried?.sendsMessages ?? false) || result.sendsMessages,
        }),
      },
      undone: resumedFileUndo,
    };
    receipts.show(workspaceId, chosen.target, outcome);
    onRestored();
    if (result.unfinished !== null) {
      onError(words.unfinished[result.unfinished.step], new Error(result.unfinished.message), () => onRetry(workspaceId, chosen, "stop"), identity);
    } else {
      onSettled(identity);
    }
    if (request.isCurrent(token)) setState((current) => ({ kind: "done", targets: listedTargets(current), ...outcome }));
  });

  const undo = (): Promise<void> => perform("dohc could not undo the restore.", "undo", async (token) => {
    let restored = receipts.get(workspaceId, chosen.target);
    const result: UndoStopAndRestoreResult = restored.length > 0 || receipts.shown(workspaceId, chosen.target)?.result.canUndoFiles === true
      ? await bridge().undoStopAndRestore({ workspaceId, target: chosen.target, reviewPaths: [...new Set([...retainedCollectionFieldWritePaths(workspaceId), ...retainedOrphanedDraftPaths(workspaceId)])], restoredMomentIds: restored.map((file) => file.restoredMomentId) })
      : { files: [], errorMessage: null };
    restored = [...new Map([...restored, ...(result.recovered ?? [])].map(file => [file.restoredMomentId, file])).values()];
    const completed = new Set(result.files.flatMap(file => file.kind === "restored" ? [file.momentId] : []));
    receipts.set(workspaceId, chosen.target, restored.filter(file => !completed.has(file.restoredMomentId)));
    onRestored();
    const last = receipts.shown(workspaceId, chosen.target);
    const runs = receipts.runs(workspaceId, chosen.target);
    const putBack = [...(last?.undone ? last.result.restored : []), ...restored.filter(file => completed.has(file.restoredMomentId))];
    const review = new Map(last?.result.review.map(file => [file.path, file]) ?? []);
    const originals = new Map(restored.map(file => [file.restoredMomentId, file]));
    for (const file of result.files) {
      const original = originals.get(file.momentId);
      if (!original) continue;
      if (file.kind === "restored") review.delete(original.path);
      else if (file.kind === "rules-unreadable") {
        review.set(original.path, { path: original.path, reason: "rules-unreadable", unreadable: file.unreadable });
      } else review.set(original.path, { path: original.path, reason: "restore-refused", detail: file.detail });
    }
    const reviewed = [...review.values()].sort((left, right) => left.path.localeCompare(right.path));
    const outcome = {
      result: last
        ? { ...last.result, restored: putBack, review: reviewed, canUndoFiles: receipts.get(workspaceId, chosen.target).length > 0 || result.errorMessage !== null }
        : {
            status: "restored" as const, restored: putBack, review: reviewed, runsLeft: 0, runsUndone: runs.runsUndone, fieldsMissing: runs.fieldsMissing,
            runChangesKept: runs.otherKept + runs.fieldsMissing,
            keptFields: [], wroteAutomations: false, sendsMessages: false, unfinished: null,
          },
      undone: true,
    };
    receipts.show(workspaceId, chosen.target, outcome);
    if (result.errorMessage !== null) {
      onError("dohc could not undo the restore.", new Error(result.errorMessage), () => onRetry(workspaceId, chosen, "undo"), identity);
    } else {
      if (outcome.result.unfinished !== null) {
        const message = outcome.result.unfinished.step === "runs"
          ? "dohc has not finished undoing runs."
          : "dohc stopped before restoring every file.";
        onError(message, new Error(message), () => onRetry(workspaceId, chosen, "stop"), identity);
      } else onSettled(identity);
    }
    if (request.isCurrent(token)) setState((current) => ({ kind: "done", targets: listedTargets(current), ...outcome }));
  });

  return (
    <Overlay onClose={onClose} panelProps={{
      role: "dialog", "aria-modal": true, "aria-labelledby": "stop-and-restore-title", "data-testid": "stop-and-restore-dialog",
      className: "dohc-elevated dohc-pop-in w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5",
    }}>
      <h2 id="stop-and-restore-title" className="m-0 text-base font-semibold text-ink">Stop and restore</h2>
      {state.kind === "loading" || state.kind === "choose" || state.kind === "working" ? (
        <div className="mt-3 space-y-3">
          {targets.length > 1 ? (
            <label className="block text-[12px] text-muted">
              Who
              <select
                aria-label="Who to stop"
                disabled={state.kind !== "choose"}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-ink"
              >
                {targets.map((candidate) => (
                  <option key={keyOf(candidate.target)} value={keyOf(candidate.target)}>{candidate.label}</option>
                ))}
              </select>
            </label>
          ) : <p className="m-0 font-mono text-[12px] text-ink">{chosen.label}</p>}
          <p className="m-0 text-[13px] text-muted">{words.loses}</p>
          <p className="m-0 text-[13px] text-muted">{words.restores}</p>
        </div>
      ) : null}
      <div role="status" aria-live="polite">
        {state.kind === "working" ? <p className="text-[12px] text-muted">Stopping access and restoring files…</p> : null}
        {state.kind === "waiting" ? <p className="text-[13px] text-muted">{words.waiting}</p> : null}
      </div>
      {state.kind === "done" ? <Outcome words={words} result={state.result} undone={state.undone} onOpenFile={onOpenFile} onOpenCollection={onOpenCollection} /> : null}
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{state.kind === "choose" ? "Cancel" : "Close"}</SecondaryButton>
        {state.kind === "done" && (receipts.get(workspaceId, chosen.target).length > 0 || state.result.canUndoFiles === true) ? (
          <SecondaryButton data-testid="stop-and-restore-undo" onClick={() => void undo()}>Undo</SecondaryButton>
        ) : null}
        {state.kind === "choose" ? (
          <DangerButton data-testid="stop-and-restore-confirm" onClick={() => void stop()}>Stop and restore</DangerButton>
        ) : null}
        {state.kind === "done" && state.result.unfinished !== null ? (
          <PrimaryButton onClick={() => void stop()}>Try again</PrimaryButton>
        ) : null}
        {state.kind === "waiting" ? <PrimaryButton onClick={() => void stop()}>Try again</PrimaryButton> : null}
      </div>
    </Overlay>
  );
}

// The words for a person or a link. A person is "they"; a link is "it", and
// it is ended as a whole.
function wordsFor({ target, label }: StopTarget) {
  if (target.kind === "person") {
    return {
      loses: `${label} loses Edit access to this workspace. Share again to give it back.`,
      restores: "Each file they changed directly goes back to how it was before their first change. Collections they created are removed. Runs of automations they changed are undone on this computer and your server. You can undo the file changes, not the runs.",
      stopFailed: `dohc could not stop ${label} and restore their changes.`,
      unfinished: {
        files: `Stopped ${label}'s access. dohc has not finished restoring their changes.`,
        runs: `Stopped ${label}'s access. dohc has not finished undoing runs of automations they changed.`,
      },
      waiting: `Access stopped. dohc has not received all of ${label}'s changes yet. Try again in a moment.`,
      stopped: (files: string) => `Stopped ${label}'s access and restored ${files}.`,
      undone: (files: string) => `Put back ${files} as ${label} left them. Their access stays stopped.`,
      automations: `automations ${label} changed`,
      after: label,
    };
  }
  return {
    loses: `${label} stops working for everyone who has it, including people who opened it in dohc. Share again to give access back.`,
    restores: "Each file changed through it goes back to how it was before its first change. Collections created through it are removed. Runs of automations changed through it are undone on this computer and your server. You can undo the file changes, not the runs.",
    stopFailed: `dohc could not end ${label} and restore its changes.`,
    unfinished: {
      files: `Ended ${label}. dohc has not finished restoring its changes.`,
      runs: `Ended ${label}. dohc has not finished undoing runs of automations changed through it.`,
    },
    waiting: "Link ended. dohc has not received every change made through it yet. Try again in a moment.",
    stopped: (files: string) => `Ended ${label} and restored ${files}.`,
    undone: (files: string) => `Put back ${files} as ${label} left them. The link stays ended.`,
    automations: `automations changed through ${label}`,
    after: "the link",
  };
}

type Words = ReturnType<typeof wordsFor>;

// The active Edit links on this workspace, named by the first path each shares.
async function editLinks(workspaceId: string): Promise<StopTarget[]> {
  const links: StopTarget[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LINK_PAGES; page += 1) {
    const listing = await bridge().listRelayShareLinks({ workspaceId, ...(cursor === undefined ? {} : { cursor }) });
    for (const link of listing.links) {
      if (link.damaged || link.status !== "active" || link.access !== "edit") continue;
      const path = link.selector.paths[0];
      links.push({ target: { kind: "link", grantId: link.grantId }, label: path ? `Edit link to ${path}` : "Edit link" });
    }
    cursor = listing.nextCursor;
    if (cursor === undefined) break;
  }
  return links;
}

function Outcome({ words, result, undone, onOpenFile, onOpenCollection }: {
  words: Words;
  result: Restored;
  undone: boolean;
  onOpenFile(path: string): void;
  onOpenCollection(path: string): void;
}) {
  const files = plural(result.restored.length, "file", "files");
  const fields = result.keptFields.length + result.fieldsMissing;
  const other = otherKept(result);
  return (
    <div className="mt-3 space-y-3" data-testid="stop-and-restore-outcome">
      <p className="m-0 text-[13px] text-ink">{undone ? words.undone(files) : words.stopped(files)}</p>
      {!undone && result.restored.some(file => file.removed) ? <p className="m-0 text-[13px] text-muted">
        Removed {plural(result.restored.filter(file => file.removed).length, "created file", "created files")}.
      </p> : null}
      {result.unfinished?.step === "files" && !undone ? (
        <p className="m-0 text-[13px] text-ink">dohc has not finished restoring files.</p>
      ) : null}
      {result.runsUndone > 0 ? (
        <p className="m-0 text-[13px] text-muted">Undid {plural(result.runsUndone, "run", "runs")} of {words.automations}.</p>
      ) : null}
        {result.sharedReversals?.some(write => write.state === "pending") ? (
          <p className="m-0 text-[13px] text-muted">Reversals saved on this computer. The shared host has not accepted them yet.</p>
        ) : null}
        {result.sharedReversals?.some(write => write.state === "not-accepted") ? (
          <p className="m-0 text-[13px] text-muted">Reversals saved on this computer. The shared host did not accept them. Try Undo again in Run History.</p>
        ) : null}
      {result.unfinished?.step === "runs" && result.wroteAutomations ? (
        <p className="m-0 text-[13px] text-ink">
          {`dohc has not finished undoing runs${result.runsUndone > 0 ? "" : ` of ${words.automations}`}.`}
        </p>
      ) : null}
      {result.runsLeft > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          dohc could not undo {plural(result.runsLeft, "run", "runs")} of {words.automations}. Undo each from its Collection's run history.
        </p>
      ) : null}
      {result.keptFields.length > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          {plural(result.keptFields.length, "field", "fields")} kept a later value.
        </p>
      ) : null}
      {result.fieldsMissing > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          {plural(result.fieldsMissing, "field was", "fields were")} on records no longer in their Collection.
        </p>
      ) : null}
      {other > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          Undo left {fields > 0 ? plural(other, "other change", "other changes") : plural(other, "change", "changes")} from those runs. Check each Collection's run history.
        </p>
      ) : null}
      {result.sendsMessages ? (
        <p className="m-0 text-[13px] text-muted">Messages and notices from {words.automations} stay sent.</p>
      ) : null}
      {result.wroteAutomations ? (
        <p className="m-0 text-[13px] text-muted">
          Runs on your other computers are not undone here. Undo them from the run history on each computer.
        </p>
      ) : null}
      {result.review.length > 0 || result.keptFields.length > 0 ? (
        <div>
          <p className="m-0 text-[13px] text-muted">dohc left these changes as they are. Check them:</p>
          <ul className="mt-1 max-h-48 list-none space-y-1 overflow-auto p-0">
            {result.keptFields.map((kept) => (
              <li key={`field:${kept.id}`}>
                {kept.path !== null ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (kept.path !== null) {
                        if (kept.recordId !== null) onOpenCollection(kept.path);
                        else onOpenFile(kept.path);
                      }
                    }}
                    className="max-w-full truncate rounded-md px-1 text-left font-mono text-[12px] text-ink hover:bg-hover"
                  >
                    {kept.path}
                  </button>
                ) : null}
                <p className="m-0 px-1 text-[13px] text-ink">{kept.recordId === null ? kept.field : `Record ${kept.recordId} · ${kept.field}`}</p>
                <p className="m-0 px-1 text-[12px] text-muted">
                  {kept.recordId !== null
                    ? "Check previous values in Collection History. Edit this record to restore the field."
                    : kept.path === null
                      ? "Find this record in its Collection to restore the field."
                      : "Restore it from this record's History."}
                </p>
              </li>
            ))}
            {result.review.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => onOpenFile(file.path)}
                  className="max-w-full truncate rounded-md px-1 text-left font-mono text-[12px] text-ink hover:bg-hover"
                >
                  {file.path}
                </button>
                <p className="m-0 px-1 text-[12px] text-muted">{reviewReason(file, words.after)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function reviewReason(file: Restored["review"][number], after: string): string {
  if (file.reason === "changed-since") return `${file.changedBy ?? "Another author"} changed it after ${after}.`;
  if (file.reason === "folder-in-use") return "This Collection holds files someone else added.";
  if (file.reason === "rules-unreadable") return restoreRulesUnreadableWords(file.unreadable);
  return `dohc could not restore it. ${file.detail}`;
}
