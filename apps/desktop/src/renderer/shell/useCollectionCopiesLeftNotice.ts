import { useCallback, useEffect } from "react";
import type { CollectionCopiesLeft } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { workspaceName } from "../Titlebar";

const AND = new Intl.ListFormat("en", { type: "conjunction" });

/** The Notices row's words for what an account change left, or null for nothing. */
export function collectionCopiesLeftMessage(left: CollectionCopiesLeft): string | null {
  const names = AND.format(left.workspaces.map((rootPath) => workspaceName({ rootPath })));
  const removed = left.workspaces.length
    ? `dohc could not remove offline copies of Collections from a previous account. They are still in ${names}.`
    : null;
  // What dohc could not find out, as the end of a sentence that starts "dohc could not".
  const unknown = left.recordUnreadable && left.sweepPending
    ? "read its list of offline copies of Collections to remove, or check every workspace for them"
    : left.recordUnreadable ? "read its list of offline copies of Collections to remove"
    : left.sweepPending ? "check every workspace for offline copies of Collections from a previous account"
    : null;
  if (unknown === null) return removed;
  return removed ? `${removed} dohc also could not ${unknown}.` : `dohc could not ${unknown}. Some may still be on this computer.`;
}

// What this window filed last. Module state, because the shell remounts on
// every workspace switch: a dismissed row stays dismissed until what is left
// changes.
let shown: { key: string; dismissed: boolean } | null = null;

/**
 * Tells the person when an account change could not remove the offline
 * copies of its Collections, or dohc could not read its record of them or
 * check every workspace for them.
 * Reads when the shell mounts and whenever main says what is left changed.
 * Try again asks main to remove them again, and the row goes once none are
 * left.
 */
export function useCollectionCopiesLeftNotice(input: {
  report: (notice: { message: string; toast: boolean; retry: () => void }) => void;
  clear: () => void;
}): { noteDismissed: () => void } {
  const { report, clear } = input;
  useEffect(() => {
    let active = true;
    let latest = 0;
    const answer = (request: number, left: CollectionCopiesLeft, asked: boolean) => {
      if (!active || request !== latest) return;
      const message = collectionCopiesLeftMessage(left);
      if (message === null) {
        shown = null;
        clear();
        return;
      }
      const key = JSON.stringify(left);
      if (!asked && shown?.key === key && shown.dismissed) return;
      report({ message, toast: asked || shown?.key !== key, retry });
      shown = { key, dismissed: false };
    };
    const read = () => {
      const request = ++latest;
      void bridge().readCollectionCopiesLeft({}).then((left) => answer(request, left, false), () => undefined);
    };
    const retry = () => {
      const request = ++latest;
      void bridge().removeCollectionCopiesLeft({})
        .catch(() => bridge().readCollectionCopiesLeft({}))
        .then((left) => answer(request, left, true), () => undefined);
    };
    read();
    const unsubscribe = bridge().onCollectionCopiesLeftChanged(read);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [report, clear]);
  const noteDismissed = useCallback(() => {
    if (shown) shown.dismissed = true;
  }, []);
  return { noteDismissed };
}
