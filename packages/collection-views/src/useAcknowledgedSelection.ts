import { useEffect, useRef, useState } from "react";
import type { CollectionValue } from "@dohc/workspace-contracts";

export type PendingSelection = {
  writeId: number;
  added: string[];
  removed: string[];
};

/**
 * One cell's saved changes that the index does not show yet. The table keeps
 * it, so the changes outlive the editor that made them and a second edit
 * starts from the first.
 */
export interface CarriedSelection {
  pending: PendingSelection[];
}

export function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

/** Retires a discarded change. Returns `pending` itself when it holds no such change. */
export function withoutDiscarded(pending: PendingSelection[], writeId: number): PendingSelection[] {
  const index = pending.findIndex((change) => change.writeId === writeId);
  if (index < 0) return pending;
  const kept = [...pending];
  const discarded = kept[index]!;
  const next = kept[index + 1];
  // The next queued full value includes this edit. Carry its net changes
  // forward while retaining delta replay against external updates.
  if (next) kept[index + 1] = {
    ...next,
    added: [...new Set([...discarded.added.filter(id => !next.removed.includes(id)), ...next.added])],
    removed: [...new Set([...discarded.removed.filter(id => !next.added.includes(id)), ...next.removed])],
  };
  kept.splice(index, 1);
  return kept;
}

/**
 * Each multi-select cell's saved picks that the index does not show yet, by
 * a key for the cell. They outlive the picker, so a second edit starts from
 * the first.
 */
export function useCarriedSelections(
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void,
): (key: string) => CarriedSelection {
  const cells = useRef(new Map<string, CarriedSelection>());
  useEffect(
    () =>
      subscribeToDiscardedWrites?.((writeId) => {
        for (const carried of cells.current.values()) carried.pending = withoutDiscarded(carried.pending, writeId);
      }),
    [subscribeToDiscardedWrites],
  );
  return (key) => {
    let carried = cells.current.get(key);
    if (!carried) cells.current.set(key, (carried = { pending: [] }));
    return carried;
  };
}

/** `observed` after each pending change in turn: the selection now, and every value on the way to it. */
export function replayedSelection(value: CollectionValue, observed: readonly string[], pending: readonly PendingSelection[]) {
  const previousValues: CollectionValue[] = [value];
  let selected = [...observed];
  for (const change of pending) {
    selected = [
      ...selected.filter((option) => !change.removed.includes(option)),
      ...change.added.filter((option) => !selected.includes(option)),
    ];
    previousValues.push(selected);
  }
  return { selected, previousValues };
}

export function useAcknowledgedSelection({ value, ids, acknowledgedWriteId, subscribeToDiscardedWrites, emit, carried }: {
  value: CollectionValue;
  ids: string[];
  acknowledgedWriteId: number;
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  emit: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
  /** Absent, the saved changes last only as long as this editor. */
  carried?: CarriedSelection;
}) {
  const [selection, setSelection] = useState(() => ({
    observed: ids,
    acknowledgedWriteId,
    pending: carried?.pending.filter((change) => change.writeId > acknowledgedWriteId) ?? [],
  }));
  useEffect(() => subscribeToDiscardedWrites?.((writeId) => {
    setSelection((current) => {
      const pending = withoutDiscarded(current.pending, writeId);
      return pending === current.pending ? current : { ...current, pending };
    });
  }), [subscribeToDiscardedWrites]);
  const observed = ids;
  let current = selection;
  if (acknowledgedWriteId !== selection.acknowledgedWriteId || !sameSelection(observed, selection.observed)) {
    current = {
      observed,
      acknowledgedWriteId,
      pending: selection.pending.filter((change) => change.writeId > acknowledgedWriteId),
    };
    setSelection(current);
  }
  const { selected, previousValues } = replayedSelection(value, current.observed, current.pending);
  /**
   * Saves `next`. `send` replaces `emit` for a save that goes another way,
   * such as one that adds an option first. A save that returns no edit id
   * is not replayed.
   */
  const select = (
    next: string[],
    send: (value: CollectionValue, previousValues: readonly CollectionValue[]) => number | void = emit,
  ) => {
    const writeId = send(next, previousValues);
    if (typeof writeId !== "number") return;
    const pending = [...current.pending, {
      writeId,
      added: next.filter((option) => !selected.includes(option)),
      removed: selected.filter((option) => !next.includes(option)),
    }];
    if (carried) carried.pending = pending;
    setSelection({ ...current, pending });
  };
  return { selected, select, previousValues };
}
