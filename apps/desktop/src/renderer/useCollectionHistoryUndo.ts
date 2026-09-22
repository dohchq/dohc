import { useLayoutEffect, useRef, useState } from "react";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";

/** The Collection owns uncertain writes so closing History never loses their retry identity. */
export function useCollectionHistoryUndo(props: {
  workspaceId: string;
  datasetId: string;
  invoke(input: TransactionalInvoke, signal: AbortSignal): Promise<unknown>;
  onChanged(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}) {
  const [pending, setPending] = useState<TransactionalInvoke | null>(null), [busy, setBusy] = useState(false);
  const pendingRef = useRef<TransactionalInvoke | null>(null), locked = useRef(false);
  const alive = useRef(true), active = useRef<AbortController | null>(null);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  async function run(input: TransactionalInvoke) {
    if (!alive.current || locked.current || pendingRef.current && pendingRef.current !== input ||
      input.workspaceId !== props.workspaceId || input.datasetId !== props.datasetId) return;
    locked.current = true; pendingRef.current = input; setPending(input); setBusy(true);
    const controller = new AbortController(); active.current = controller;
    try {
      await props.invoke(input, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      pendingRef.current = null; setPending(null); props.onChanged();
    } catch (error) {
      if (!alive.current || controller.signal.aborted) return;
      const refused = error !== null && typeof error === "object" && "code" in error && error.code === "operation_refused";
      if (refused) { pendingRef.current = null; setPending(null); }
      props.onError(refused ? "The Collection refused this undo. The record may have changed." : "dohc could not confirm this undo.", error, refused ? null : () => { void run(input); });
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return { pending, busy, run };
}
