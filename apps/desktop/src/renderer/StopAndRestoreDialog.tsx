import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StopAndRestorePersonResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { useRequestSequence } from "./useRequestSequence";

// Stop and restore (ADR 0013): the owner picks a person they shared this
// workspace with and confirms once. dohc stops their Edit access, puts back
// every file they wrote directly, and lists each file it left as it is, with
// why. Undo puts the files back as the person left them; access stays
// stopped. Failures go to the shell's toast and Notices row, with Try again.

interface Person {
  userId: string;
  label: string;
}

type Restored = Extract<StopAndRestorePersonResult, { status: "restored" }>;
type Receipt = Restored["restored"][number];
type State =
  | { kind: "loading" }
  | { kind: "choose"; people: Person[] }
  | { kind: "working"; people: Person[] }
  | { kind: "waiting"; people: Person[] }
  | { kind: "done"; people: Person[]; result: Restored; undone: boolean };

/** What the dialog runs as it opens: a Try again from the Notices row. */
export type StopAndRestoreStart = "stop" | "undo" | null;

export interface StopAndRestoreSession {
  workspaceId: string;
  person: Person;
  start: StopAndRestoreStart;
  /** A new key opens the dialog afresh. */
  key: number;
}

/** What the dialog last showed for a person: their outcome, and whether it was undone. */
interface Shown {
  result: Restored;
  undone: boolean;
}

/**
 * The shell's hold on Stop and restore: which dialog is open, and per person
 * every file put back and the outcome the dialog last showed. A Try again
 * from the Notices row after the dialog closed opens it again on that
 * outcome, with Undo for every file, and a retry that fails leaves it there.
 */
export function useStopAndRestore(workspaceId: string) {
  const [session, setSession] = useState<StopAndRestoreSession | null>(null);
  const receipts = useRef(new Map<string, Receipt[]>());
  const shown = useRef(new Map<string, Shown>());
  const key = useRef(0);
  const retry = useCallback((forWorkspace: string, person: Person, start: StopAndRestoreStart) => {
    key.current += 1;
    setSession({ workspaceId: forWorkspace, person, start, key: key.current });
  }, []);
  const open = useCallback((person: Person) => retry(workspaceId, person, null), [retry, workspaceId]);
  const close = useCallback(() => setSession(null), []);
  const store = useMemo(() => ({
    get: (forWorkspace: string, userId: string): Receipt[] => receipts.current.get(JSON.stringify([forWorkspace, userId])) ?? [],
    set: (forWorkspace: string, userId: string, list: Receipt[]): void => {
      receipts.current.set(JSON.stringify([forWorkspace, userId]), list);
    },
    shown: (forWorkspace: string, userId: string): Shown | null => shown.current.get(JSON.stringify([forWorkspace, userId])) ?? null,
    show: (forWorkspace: string, userId: string, value: Shown): void => {
      shown.current.set(JSON.stringify([forWorkspace, userId]), value);
    },
  }), []);
  return {
    session: session?.workspaceId === workspaceId ? session : null,
    open,
    retry,
    close,
    receipts: store,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function StopAndRestoreDialog({
  workspaceId, person, start, receipts, onRetry, onClose, onBeforeRestore, onRestored, onOpenFile, onError,
}: {
  workspaceId: string;
  /** The person History showed, picked first, with History's label until the relay lists them. */
  person: Person;
  start: StopAndRestoreStart;
  /** Files put back and the outcome shown, per person, kept by the shell across tries and closes. */
  receipts: ReturnType<typeof useStopAndRestore>["receipts"];
  /** Opens the dialog again for `person` and runs `action`. */
  onRetry(workspaceId: string, person: Person, action: "stop" | "undo"): void;
  onClose(): void;
  onBeforeRestore(): Promise<() => void>;
  onRestored(): void;
  onOpenFile(path: string): void;
  /** The shell's toast and Notices row, with Try again. */
  onError(fallback: string, error: unknown, retry: () => void): void;
}) {
  // Opened again by a Try again, the dialog starts on what it last showed.
  const [state, setState] = useState<State>(() => {
    const last = start === null ? null : receipts.shown(workspaceId, person.userId);
    return last ? { kind: "done", people: [person], ...last } : { kind: "loading" };
  });
  // A failure goes back to what the dialog showed before it.
  const stateRef = useRef(state);
  stateRef.current = state;
  const [userId, setUserId] = useState(person.userId);
  const request = useRequestSequence([workspaceId]);
  const running = useRef(false);

  useEffect(() => {
    const token = request.next();
    // Everyone with Edit on this workspace, whose access is current or ended.
    void bridge().listRelayShares().then((listing) => {
      if (!request.isCurrent(token)) return;
      const people = new Map<string, Person>([[person.userId, person]]);
      for (const row of listing.granted) {
        if (row.workspaceId !== workspaceId || row.recipientUserId === null || row.access !== "edit") continue;
        // The relay's email names them better than History's label does.
        if (row.recipientEmail !== null || !people.has(row.recipientUserId)) {
          people.set(row.recipientUserId, { userId: row.recipientUserId, label: row.recipientEmail ?? row.recipientUserId });
        }
      }
      listed([...people.values()]);
    }, () => {
      // The person History showed can still be stopped.
      if (request.isCurrent(token)) listed([person]);
    });
    // A run started as the dialog opened keeps its own state.
    const listed = (list: Person[]) =>
      setState((current) => current.kind === "loading" ? { kind: "choose", people: list } : { ...current, people: list });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  // A Try again from the Notices row runs as the dialog opens again.
  useEffect(() => {
    if (start === "stop") void stop();
    if (start === "undo") void undo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const people = state.kind === "loading" ? [person] : state.people;
  const chosen = people.find((candidate) => candidate.userId === userId) ?? person;

  async function perform(fallback: string, action: "stop" | "undo", work: (token: number) => Promise<void>): Promise<void> {
    if (running.current) return;
    running.current = true;
    const token = request.next();
    const before = stateRef.current;
    setState({ kind: "working", people });
    // Open editors settle first, and wait until the files are back.
    let release: (() => void) | null = null;
    try {
      release = await onBeforeRestore();
      await work(token);
    } catch (error) {
      if (request.isCurrent(token)) setState(before.kind === "loading" ? { kind: "choose", people } : before);
      onError(fallback, error, () => onRetry(workspaceId, chosen, action));
    } finally {
      release?.();
      running.current = false;
    }
  }

  const stopFailed = `dohc could not stop ${chosen.label} and restore their changes.`;
  const stop = (): Promise<void> => perform(stopFailed, "stop", async (token) => {
    const result = await bridge().stopAndRestorePerson({ workspaceId, userId: chosen.userId });
    if (result.status === "restored") {
      receipts.set(workspaceId, chosen.userId, [...receipts.get(workspaceId, chosen.userId), ...result.restored]);
      onRestored();
      if (result.errorMessage !== null) {
        onError(stopFailed, new Error(result.errorMessage), () => onRetry(workspaceId, chosen, "stop"));
      }
    }
    if (!request.isCurrent(token)) return;
    if (result.status === "waiting") {
      setState({ kind: "waiting", people });
      return;
    }
    const outcome = { result: { ...result, restored: receipts.get(workspaceId, chosen.userId) }, undone: false };
    receipts.show(workspaceId, chosen.userId, outcome);
    setState({ kind: "done", people, ...outcome });
  });

  const undo = (): Promise<void> => perform("dohc could not undo the restore.", "undo", async (token) => {
    const restored = receipts.get(workspaceId, chosen.userId);
    if (restored.length > 0) {
      await bridge().undoStopAndRestore({ workspaceId, restoredMomentIds: restored.map((file) => file.restoredMomentId) });
    }
    receipts.set(workspaceId, chosen.userId, []);
    onRestored();
    const last = receipts.shown(workspaceId, chosen.userId);
    const outcome = {
      result: last ? { ...last.result, restored } : { status: "restored" as const, restored, review: [], runsUndone: 0, runsLeft: 0, errorMessage: null },
      undone: true,
    };
    receipts.show(workspaceId, chosen.userId, outcome);
    if (request.isCurrent(token)) setState({ kind: "done", people, ...outcome });
  });

  return (
    <Overlay onClose={onClose} panelProps={{
      role: "dialog", "aria-modal": true, "aria-labelledby": "stop-and-restore-title", "data-testid": "stop-and-restore-dialog",
      className: "dohc-elevated dohc-pop-in w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5",
    }}>
      <h2 id="stop-and-restore-title" className="m-0 text-sm font-semibold text-ink">Stop and restore</h2>
      {state.kind === "loading" || state.kind === "choose" || state.kind === "working" ? (
        <div className="mt-3 space-y-3">
          {people.length > 1 ? (
            <label className="block text-[12px] text-muted">
              Person
              <select
                aria-label="Person to stop"
                disabled={state.kind !== "choose"}
                value={chosen.userId}
                onChange={(event) => setUserId(event.target.value)}
                className="mt-1 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-ink"
              >
                {people.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.label}</option>)}
              </select>
            </label>
          ) : <p className="m-0 font-mono text-[12px] text-ink">{chosen.label}</p>}
          <p className="m-0 text-[13px] text-muted">
            {chosen.label} loses Edit access to this workspace. Share again to give it back.
          </p>
          <p className="m-0 text-[13px] text-muted">
            Each file they changed directly goes back to how it was before their first change. Collections they created are removed. You can undo the file changes.
          </p>
        </div>
      ) : null}
      <div role="status" aria-live="polite">
        {state.kind === "working" ? <p className="text-[12px] text-muted">Stopping access and restoring files…</p> : null}
        {state.kind === "waiting" ? (
          <p className="text-[13px] text-muted">
            Access stopped. dohc has not received all of {chosen.label}'s changes yet. Try again in a moment.
          </p>
        ) : null}
      </div>
      {state.kind === "done" ? <Outcome person={chosen.label} result={state.result} undone={state.undone} onOpenFile={onOpenFile} /> : null}
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

function Outcome({ person, result, undone, onOpenFile }: {
  person: string;
  result: Restored;
  undone: boolean;
  onOpenFile(path: string): void;
}) {
  const files = plural(result.restored.length, "file", "files");
  return (
    <div className="mt-3 space-y-3" data-testid="stop-and-restore-outcome">
      <p className="m-0 text-[13px] text-ink">
        {undone
          ? `Put back ${files} as ${person} left them. Their access stays stopped.`
          : `Stopped ${person}'s access and restored ${files}.`}
      </p>
      {result.runsUndone > 0 ? (
        <p className="m-0 text-[13px] text-muted">Undid {plural(result.runsUndone, "run", "runs")} of automations {person} wrote.</p>
      ) : null}
      {result.runsLeft > 0 ? (
        <p className="m-0 text-[13px] text-muted">
          dohc could not undo {plural(result.runsLeft, "run", "runs")} of their automations. Undo each from its Collection's run history.
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
                <p className="m-0 px-1 text-[12px] text-muted">{reviewReason(file, person)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function reviewReason(file: Restored["review"][number], person: string): string {
  if (file.reason === "changed-since") return `Someone changed it after ${person}.`;
  if (file.reason === "folder-in-use") return "This Collection holds files someone else added.";
  return `dohc could not restore it. ${file.detail}`;
}
