import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StopAndRestoreResult, StopAndRestoreTarget } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { useRequestSequence } from "./useRequestSequence";

// Stop and restore (ADR 0013): the owner picks a person they shared this
// workspace with, or an Edit share link, and confirms once. dohc stops that
// access, puts back every file written directly through it, and lists each
// file it left as it is, with why. Undo puts the files back as they were
// left; access stays stopped. Failures go to the shell's toast and Notices
// row, with Try again. A link is ended as a whole: stopping one of the
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

/** Runs of automations a person or link wrote that stop and restore undid, and the changes they left. */
interface RunTotals {
  runsUndone: number;
  runChangesKept: number;
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
export function useStopAndRestore(workspaceId: string) {
  const [session, setSession] = useState<StopAndRestoreSession | null>(null);
  const receipts = useRef(new Map<string, Receipt[]>());
  const runs = useRef(new Map<string, RunTotals>());
  const shown = useRef(new Map<string, Shown>());
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
        receipts.current.set(id(forWorkspace, target), list);
      },
      /**
       * Runs undone across every try. A later try passes over runs an
       * earlier one undid, and Undo puts back only files, so these add up.
       */
      runs: (forWorkspace: string, target: StopAndRestoreTarget): RunTotals =>
        runs.current.get(id(forWorkspace, target)) ?? { runsUndone: 0, runChangesKept: 0 },
      addRuns: (forWorkspace: string, target: StopAndRestoreTarget, more: RunTotals): RunTotals => {
        const before = runs.current.get(id(forWorkspace, target)) ?? { runsUndone: 0, runChangesKept: 0 };
        const after = {
          runsUndone: before.runsUndone + more.runsUndone,
          runChangesKept: before.runChangesKept + more.runChangesKept,
        };
        runs.current.set(id(forWorkspace, target), after);
        return after;
      },
      shown: (forWorkspace: string, target: StopAndRestoreTarget): Shown | null => shown.current.get(id(forWorkspace, target)) ?? null,
      show: (forWorkspace: string, target: StopAndRestoreTarget, value: Shown): void => {
        shown.current.set(id(forWorkspace, target), value);
      },
    };
  }, []);
  return {
    session: session?.workspaceId === workspaceId ? session : null,
    open,
    retry,
    close,
    receipts: store,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// The owner's links in pages of 1,000; the dialog reads this many at most.
const MAX_LINK_PAGES = 5;

export function StopAndRestoreDialog({
  workspaceId, target: first, start, receipts, onRetry, onClose, onBeforeRestore, onRestored, onOpenFile, onError,
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
  /** The shell's toast and Notices row, with Try again. */
  onError(fallback: string, error: unknown, retry: () => void): void;
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
      onError(fallback, error, () => onRetry(workspaceId, chosen, action));
    } finally {
      release?.();
      running.current = false;
    }
  }

  const stop = (): Promise<void> => perform(words.stopFailed, "stop", async (token) => {
    const result = await bridge().stopAndRestore({ workspaceId, target: chosen.target });
    if (result.status === "waiting") {
      if (request.isCurrent(token)) setState((current) => ({ kind: "waiting", targets: listedTargets(current) }));
      return;
    }
    // Kept even when the dialog closed meanwhile, so a later try shows them.
    receipts.set(workspaceId, chosen.target, [...receipts.get(workspaceId, chosen.target), ...result.restored]);
    const totals = receipts.addRuns(workspaceId, chosen.target, result);
    const outcome = { result: { ...result, restored: receipts.get(workspaceId, chosen.target), ...totals }, undone: false };
    receipts.show(workspaceId, chosen.target, outcome);
    onRestored();
    if (result.errorMessage !== null) {
      onError(words.stopFailed, new Error(result.errorMessage), () => onRetry(workspaceId, chosen, "stop"));
    }
    if (request.isCurrent(token)) setState((current) => ({ kind: "done", targets: listedTargets(current), ...outcome }));
  });

  const undo = (): Promise<void> => perform("dohc could not undo the restore.", "undo", async (token) => {
    const restored = receipts.get(workspaceId, chosen.target);
    if (restored.length > 0) {
      await bridge().undoStopAndRestore({ workspaceId, restoredMomentIds: restored.map((file) => file.restoredMomentId) });
    }
    receipts.set(workspaceId, chosen.target, []);
    onRestored();
    const last = receipts.shown(workspaceId, chosen.target);
    const outcome = {
      result: last
        ? { ...last.result, restored }
        : {
            status: "restored" as const, restored, review: [], runsLeft: 0, ...receipts.runs(workspaceId, chosen.target),
            wroteAutomations: false, sendsMessages: false, errorMessage: null,
          },
      undone: true,
    };
    receipts.show(workspaceId, chosen.target, outcome);
    if (request.isCurrent(token)) setState((current) => ({ kind: "done", targets: listedTargets(current), ...outcome }));
  });

  return (
    <Overlay onClose={onClose} panelProps={{
      role: "dialog", "aria-modal": true, "aria-labelledby": "stop-and-restore-title", "data-testid": "stop-and-restore-dialog",
      className: "dohc-elevated dohc-pop-in w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5",
    }}>
      <h2 id="stop-and-restore-title" className="m-0 text-sm font-semibold text-ink">Stop and restore</h2>
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
      {state.kind === "done" ? <Outcome words={words} result={state.result} undone={state.undone} onOpenFile={onOpenFile} /> : null}
      <div className="mt-4 flex justify-end gap-2">
        <SecondaryButton onClick={onClose}>{state.kind === "choose" ? "Cancel" : "Close"}</SecondaryButton>
        {state.kind === "done" && !state.undone && state.result.restored.length > 0 ? (
          <SecondaryButton data-testid="stop-and-restore-undo" onClick={() => void undo()}>Undo</SecondaryButton>
        ) : null}
        {state.kind === "choose" ? (
          <PrimaryButton data-testid="stop-and-restore-confirm" onClick={() => void stop()}>Stop and restore</PrimaryButton>
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
      restores: "Each file they changed directly goes back to how it was before their first change. Collections they created are removed. You can undo the file changes.",
      stopFailed: `dohc could not stop ${label} and restore their changes.`,
      waiting: `Access stopped. dohc has not received all of ${label}'s changes yet. Try again in a moment.`,
      stopped: (files: string) => `Stopped ${label}'s access and restored ${files}.`,
      undone: (files: string) => `Put back ${files} as ${label} left them. Their access stays stopped.`,
      wrote: `automations ${label} wrote`,
      after: label,
    };
  }
  return {
    loses: `${label} stops working for everyone who has it, including people who opened it in dohc. Share again to give access back.`,
    restores: "Each file changed through it goes back to how it was before its first change. Collections created through it are removed. You can undo the file changes.",
    stopFailed: `dohc could not end ${label} and restore its changes.`,
    waiting: "Link ended. dohc has not received every change made through it yet. Try again in a moment.",
    stopped: (files: string) => `Ended ${label} and restored ${files}.`,
    undone: (files: string) => `Put back ${files} as ${label} left them. The link stays ended.`,
    wrote: `automations written through ${label}`,
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

function Outcome({ words, result, undone, onOpenFile }: {
  words: Words;
  result: Restored;
  undone: boolean;
  onOpenFile(path: string): void;
}) {
  const files = plural(result.restored.length, "file", "files");
  return (
    <div className="mt-3 space-y-3" data-testid="stop-and-restore-outcome">
      <p className="m-0 text-[13px] text-ink">{undone ? words.undone(files) : words.stopped(files)}</p>
      {result.runsUndone > 0 ? (
        <p className="m-0 text-[13px] text-muted">Undid {plural(result.runsUndone, "run", "runs")} of {words.wrote}.</p>
      ) : null}
      {result.runsLeft > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          dohc could not undo {plural(result.runsLeft, "run", "runs")} of {words.wrote}. Undo each from its Collection's run history.
        </p>
      ) : null}
      {result.runChangesKept > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          {plural(result.runChangesKept, "change", "changes")} from those runs stay as they are. Undo cannot reverse them, or someone changed them since.
        </p>
      ) : null}
      {result.sendsMessages ? (
        <p className="m-0 text-[13px] text-muted">Messages and notices from {words.wrote} stay sent.</p>
      ) : null}
      {result.wroteAutomations ? (
        <p className="m-0 text-[13px] text-muted">
          Runs on your other computers are not undone here. Undo them from the run history on each computer.
        </p>
      ) : null}
      {result.review.length > 0 ? (
        <div>
          <p className="m-0 text-[13px] text-muted">dohc left these files as they are. Check them:</p>
          <ul className="mt-1 max-h-48 list-none space-y-1 overflow-auto p-0">
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
  if (file.reason === "changed-since") return `Someone changed it after ${after}.`;
  if (file.reason === "folder-in-use") return "This Collection holds files someone else added.";
  return `dohc could not restore it. ${file.detail}`;
}
