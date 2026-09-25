import { useEffect, useState } from "react";
import type { CollectionValue } from "@dohc/workspace-contracts";

type PendingSelection = {
  writeId: number;
  added: string[];
  removed: string[];
};

function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((option, index) => option === right[index]);
}

export function useAcknowledgedSelection({ value, ids, acknowledgedWriteId, subscribeToDiscardedWrites, emit }: {
  value: CollectionValue;
  ids: string[];
  acknowledgedWriteId: number;
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  emit: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
}) {
  const [selection, setSelection] = useState(() => ({
    observed: ids,
    acknowledgedWriteId,
    pending: [] as PendingSelection[],
  }));
  useEffect(() => subscribeToDiscardedWrites?.((writeId) => {
    setSelection((current) => ({
      ...current,
      pending: current.pending.filter((change) => change.writeId !== writeId),
    }));
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
  const previousValues: CollectionValue[] = [value];
  let selected = current.observed;
  for (const change of current.pending) {
    selected = [
      ...selected.filter((option) => !change.removed.includes(option)),
      ...change.added.filter((option) => !selected.includes(option)),
    ];
    previousValues.push(selected);
  }
  const select = (next: string[]) => {
    const writeId = emit(next, previousValues);
    setSelection({
      ...current,
      pending: [...current.pending, {
        writeId,
        added: next.filter((option) => !selected.includes(option)),
        removed: selected.filter((option) => !next.includes(option)),
      }],
    });
  };
  return { selected, select, previousValues };
}
