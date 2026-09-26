import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AutomationButtonState } from "../../automations/automationButtons";
import type { AutomationRunSettledEvent, AutomationRunWaitingEvent } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// Button fields for one Collection in one window: what each button shows,
// which presses are running, and the press itself. Main decides who may
// press and what runs; this only asks and shows the answer.
//
// The window keeps one store per workspace and Collection for as long as it
// runs, so a run started in the table still reports when it ends after the
// person opens another tab, and a failure's Try again still works. Each
// button subscribes to its own field and record, so a press re-renders only
// that button, and a table's cells keep their elements and focus.

export type ReportButtonError = (fallback: string, error: unknown, retry: (() => void) | null) => void;
/** Whose buttons a store shows: a document Collection's, or one table's of a dataset Collection. */
export type ButtonsOf = { collectionPath: string } | { datasetId: string; table: string };
export interface ButtonReporter {
  onError: ReportButtonError;
  onNotice: (message: string) => void;
}

/** What a button shows for one record. The same object until it changes. */
export interface ButtonView {
  /** Null until main has said what the button does. */
  state: AutomationButtonState | null;
  /** True from the press until its run settles. */
  running: boolean;
  /** Why the run waits, or what the last press found, for the button's description. */
  note: string | null;
}

export interface PressedRecord {
  id: string;
  /** The record's name as the table shows it, such as "Invoice 12". */
  label: string;
}

/** A press from this window that has not settled. */
interface Run {
  field: string;
  label: string;
  automationId: string | null;
  /** Null while main has not answered the press. */
  claimId: string | null;
  waiting: string | null;
}

type Outcome = Pick<AutomationRunSettledEvent, "outcome" | "error">;

const WAITING: Record<AutomationRunWaitingEvent["reason"], string> = {
  roster: "Waiting to check who can edit this Collection.",
  held: "Waiting for someone who can edit this Collection to allow a step.",
  busy: "Waiting for other automations to finish.",
  session: "Sign in to send this automation's chat messages.",
};
// Events that arrive before their press answer; only the newest are kept.
const EARLY_EVENTS = 20;
// Idle stores the window keeps for Collections it showed before.
const IDLE_STORES = 20;
// What the Fields dialog follows: every button's state at once.
const STATES_KEY = "";

const runKey = (field: string, recordId: string) => JSON.stringify([field, recordId]);

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > EARLY_EVENTS) map.delete(map.keys().next().value!);
}

export type AutomationButtons = ReturnType<typeof createAutomationButtons>;

// The toasts of the surface that showed a workspace's buttons last. They
// report for a run that ends after its tab closed. The shell's toasts belong
// to the workspace, so one reporter serves every Collection in it.
const reporters = new Map<string, ButtonReporter>();
// Rises when a workspace's buttons are torn down, so a reply or a Try again
// from before does nothing.
const generations = new Map<string, number>();
const generationOf = (workspaceId: string) => generations.get(workspaceId) ?? 0;
const silent: ButtonReporter = { onError: () => undefined, onNotice: () => undefined };

/** The store behind one Collection's buttons in this window. */
export function createAutomationButtons(scope: { workspaceId: string; of: ButtonsOf }) {
  const { workspaceId, of } = scope;
  let states: ReadonlyMap<string, AutomationButtonState> | null = null;
  const generation = generationOf(workspaceId);
  let closed = false;
  // A press is recorded in the pressing event, before any render, so a
  // second press on the same button and record does nothing.
  const runs = new Map<string, Run>();
  const notes = new Map<string, string>();
  const earlySettles = new Map<string, Outcome>();
  const earlyWaits = new Map<string, string>();
  // One listener set and one cached view per field and record.
  const listeners = new Map<string, Set<() => void>>();
  const views = new Map<string, ButtonView>();
  // Surfaces that read again what this store's runs changed.
  const settledListeners = new Set<() => void>();
  let requests = 0;

  const notify = (key: string) => {
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };
  const changed = (key: string) => {
    views.delete(key);
    notify(key);
  };
  const everyChanged = () => {
    views.clear();
    for (const key of [...listeners.keys()]) notify(key);
  };
  const report = (): ButtonReporter => (closed ? silent : reporters.get(workspaceId) ?? silent);
  // Every Try again goes through the window's live store for this
  // Collection, since this one may be dropped while the notice waits, and
  // does nothing once the workspace closed.
  const live = (): AutomationButtons | null =>
    generationOf(workspaceId) === generation ? automationButtonsFor(workspaceId, of) : null;

  function finish(key: string): void {
    runs.delete(key);
    changed(key);
  }

  function settle(key: string, run: Run, outcome: Outcome): void {
    finish(key);
    for (const listener of [...settledListeners]) listener();
    const { onError, onNotice } = report();
    if (outcome.outcome === "done") onNotice(`Ran ${run.field} on ${run.label}`);
    else if (outcome.outcome === "skipped") onNotice(`${run.field} made no changes to ${run.label}`);
    // A press sent again after its run record was trimmed: it ended, and dohc cannot say how.
    else if (outcome.outcome === "ended") onNotice(`${run.field} finished on ${run.label}`);
    else {
      const { automationId, claimId } = run;
      const retry = automationId === null || claimId === null ? null : () => void live()?.runAgain(key, { ...run, automationId, claimId });
      onError(`${run.field} did not finish.`, new Error(outcome.error ?? ""), retry);
    }
  }

  /** Try again on a failed run: the same claim runs again, for the person who pressed it. */
  async function runAgain(key: string, run: Run & { automationId: string; claimId: string }): Promise<void> {
    if (closed || runs.has(key)) return;
    runs.set(key, { ...run, waiting: null });
    changed(key);
    try {
      const result = await bridge().retryCollectionAutomation({ workspaceId, automationId: run.automationId, claimId: run.claimId, startOver: false });
      if (closed || result.status === "queued") return;
      finish(key);
      const reason = result.status === "refused" ? result.reason : `${run.field} changed since it ran. Run it again from Automations.`;
      report().onError(`${run.field} did not run again.`, new Error(reason), null);
    } catch (error) {
      if (closed) return;
      finish(key);
      report().onError(`${run.field} did not run again.`, error, () => void live()?.runAgain(key, run));
    }
  }

  const find = (claimId: string) => [...runs].find(([, run]) => run.claimId === claimId);
  const stopSettled = bridge().onAutomationRunSettled((event) => {
    if (closed || event.workspaceId !== workspaceId) return;
    const found = find(event.claimId);
    if (found) settle(found[0], found[1], event);
    else remember(earlySettles, event.claimId, event);
  });
  const stopWaiting = bridge().onAutomationRunWaiting((event) => {
    if (closed || event.workspaceId !== workspaceId) return;
    const found = find(event.claimId);
    if (!found) {
      remember(earlyWaits, event.claimId, WAITING[event.reason]);
      return;
    }
    found[1].waiting = WAITING[event.reason];
    changed(found[0]);
  });

  return {
    workspaceId,
    runAgain,

    /** Follows one field on one record, or every button's state with no key. */
    subscribe(key: string, listener: () => void): () => void {
      const set = listeners.get(key) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },

    states: () => states,

    /** Calls `listener` each time one of this store's runs ends, however it ended. */
    onSettled(listener: () => void): () => void {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },

    /** Whether nothing shows or runs these buttons, so the window may drop the store. */
    idle: () => listeners.size === 0 && runs.size === 0,

    /** Shows states another answer carried, such as the record view's. */
    show(buttons: readonly { field: string; state: AutomationButtonState }[]): void {
      requests += 1;
      notes.clear();
      states = new Map(buttons.map(({ field, state }) => [field, state]));
      everyChanged();
    },

    /** Reads what each button shows. An older answer never replaces a newer one. */
    async refresh(): Promise<void> {
      const request = ++requests;
      try {
        const { buttons } = await bridge().listAutomationButtons("collectionPath" in of
          ? { workspaceId, collectionPath: of.collectionPath }
          : { workspaceId, datasetId: of.datasetId });
        if (closed || request !== requests) return;
        notes.clear();
        // A dataset lists every table's buttons; this store shows one table's.
        const shown = "table" in of ? buttons.filter((button) => button.table === of.table) : buttons;
        states = new Map(shown.map(({ field, state }) => [field, state]));
        everyChanged();
      } catch (error) {
        if (closed || request !== requests) return;
        report().onError("dohc could not read this Collection's buttons.", error, () => void live()?.refresh());
      }
    },

    /**
     * Presses a button on one record. The press id stays with this press, so
     * Try again after a lost answer sends the same press, not a second one.
     */
    async press(field: string, record: PressedRecord, pressId: string = crypto.randomUUID()): Promise<void> {
      const key = runKey(field, record.id);
      if (closed || runs.has(key)) return;
      const state = states?.get(field);
      const run: Run = { field, label: record.label, automationId: state?.kind === "ready" ? state.automationId : null, claimId: null, waiting: null };
      runs.set(key, run);
      notes.delete(key);
      changed(key);
      try {
        const result = await bridge().pressAutomationButton({ workspaceId, ...of, field, recordId: record.id, pressId });
        if (closed) return;
        if (result.busy) {
          notes.set(key, result.reason);
          finish(key);
          return;
        }
        if ("relayed" in result) {
          // The owner's computer runs it. Its changes arrive as synced
          // edits, and a failure as a notice, so the button is free again.
          finish(key);
          report().onNotice(`Sent ${field} for ${record.label}`);
          return;
        }
        run.claimId = result.claimId;
        const settled = result.settled ?? earlySettles.get(result.claimId);
        earlySettles.delete(result.claimId);
        run.waiting = earlyWaits.get(result.claimId) ?? null;
        earlyWaits.delete(result.claimId);
        if (settled) settle(key, run, settled);
        else changed(key);
      } catch (error) {
        if (closed) return;
        finish(key);
        report().onError(`${field} did not start.`, error, () => void live()?.press(field, record, pressId));
      }
    },

    /** What one button shows, the same object until it changes. */
    view(field: string, recordId: string): ButtonView {
      const key = runKey(field, recordId);
      let view = views.get(key);
      if (!view) {
        const run = runs.get(key);
        view = { state: states?.get(field) ?? null, running: run !== undefined, note: run?.waiting ?? notes.get(key) ?? null };
        views.set(key, view);
      }
      return view;
    },

    key: runKey,

    /** Stops listening and forgets its runs; the window dropped this store. */
    close(): void {
      closed = true;
      stopSettled();
      stopWaiting();
      runs.clear();
      notes.clear();
      earlySettles.clear();
      earlyWaits.clear();
      everyChanged();
      listeners.clear();
      settledListeners.clear();
    },
  };
}

// This window's stores, by workspace and Collection, oldest first.
const stores = new Map<string, AutomationButtons>();

/** The window's store for one Collection's buttons, made on first use. */
export function automationButtonsFor(workspaceId: string, of: ButtonsOf): AutomationButtons {
  const id = JSON.stringify("collectionPath" in of ? [workspaceId, of.collectionPath] : [workspaceId, of.datasetId, of.table]);
  let store = stores.get(id);
  if (store) {
    stores.delete(id);
  } else {
    store = createAutomationButtons({ workspaceId, of });
    const idle = [...stores].filter(([, candidate]) => candidate.idle());
    for (const [dropped, old] of idle.slice(0, Math.max(0, idle.length - IDLE_STORES + 1))) {
      old.close();
      stores.delete(dropped);
    }
  }
  stores.set(id, store);
  return store;
}

/** For tests: forget every store. */
export function resetAutomationButtonsForTests(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
  reporters.clear();
  generations.clear();
}

/**
 * The workspace closed, or the window moved to another: its buttons' stores
 * go, with their runs and toasts, and a reply or a Try again from before
 * does nothing.
 */
export function disposeAutomationButtons(workspaceId: string): void {
  generations.set(workspaceId, generationOf(workspaceId) + 1);
  reporters.delete(workspaceId);
  for (const [id, store] of [...stores]) {
    if (store.workspaceId !== workspaceId) continue;
    store.close();
    stores.delete(id);
  }
}

/** One Collection's button store, reporting through this surface's toasts while it shows. */
export function useAutomationButtons(input: {
  workspaceId: string;
  /** Null until the component knows which Collection, as for a record view still reading. */
  of: ButtonsOf | null;
  onError: ReportButtonError;
  onNotice: (message: string) => void;
}): AutomationButtons | null {
  const buttons = input.of === null ? null : automationButtonsFor(input.workspaceId, input.of);
  const reporter = useRef<ButtonReporter>({ onError: input.onError, onNotice: input.onNotice });
  reporter.current = { onError: input.onError, onNotice: input.onNotice };
  const { workspaceId } = input;
  useEffect(() => {
    // Calls through the ref, so a later render's callbacks report too.
    reporters.set(workspaceId, {
      onError: (...args) => reporter.current.onError(...args),
      onNotice: (message) => reporter.current.onNotice(message),
    });
  }, [workspaceId, buttons]);
  return buttons;
}

/** What one button shows, re-rendering only when it changes. */
export function useButtonView(buttons: AutomationButtons, field: string, recordId: string): ButtonView {
  const key = buttons.key(field, recordId);
  return useSyncExternalStore(
    (listener) => buttons.subscribe(key, listener),
    () => buttons.view(field, recordId),
  );
}

/** Every button's state, for the Fields dialog; null follows nothing. */
export function useButtonStates(buttons: AutomationButtons | null): ReadonlyMap<string, AutomationButtonState> | null {
  return useSyncExternalStore(
    (listener) => buttons?.subscribe(STATES_KEY, listener) ?? (() => undefined),
    () => buttons?.states() ?? null,
  );
}
