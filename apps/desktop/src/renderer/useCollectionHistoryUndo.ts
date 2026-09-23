import { useLayoutEffect, useRef, useState } from "react";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";

/** The Collection owns uncertain writes so closing History never loses their retry identity. */
export function useCollectionHistoryUndo(props: {
  workspaceId: string;
  datasetId: string;
  revision: number | undefined;
  revisionSha256: string | undefined;
  invoke(input: TransactionalInvoke, signal: AbortSignal): Promise<unknown>;
  onChanged(): void;
  onError(fallback: string, error: unknown, retry: (() => void) | null): void;
}) {
  const [pending, setPending] = useState<TransactionalInvoke | null>(null), [busy, setBusy] = useState(false);
  const pendingRef = useRef<TransactionalInvoke | null>(null), locked = useRef(false);
  const alive = useRef(true), active = useRef<AbortController | null>(null);
  const currentRevision = useRef({ revision: props.revision, revisionSha256: props.revisionSha256 });
  const invalidated = useRef(new WeakSet<TransactionalInvoke>());
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  useLayoutEffect(() => {
    currentRevision.current = { revision: props.revision, revisionSha256: props.revisionSha256 };
    const input = pendingRef.current;
    if (!input || props.revision === undefined || props.revisionSha256 === undefined ||
      input.revision === props.revision && input.revisionSha256 === props.revisionSha256) return;
    invalidated.current.add(input); active.current?.abort();
    pendingRef.current = null; setPending(null); locked.current = false; setBusy(false);
    props.onError("The Collection's rules changed. Check the records before undoing another edit.", new Error("The Collection's rules changed before this undo was confirmed. Check the records before undoing another edit."), null);
  }, [props.revision, props.revisionSha256]);
  async function run(input: TransactionalInvoke) {
    if (!alive.current || invalidated.current.has(input) || input.revision !== currentRevision.current.revision || input.revisionSha256 !== currentRevision.current.revisionSha256 ||
      locked.current || pendingRef.current && pendingRef.current !== input ||
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
    } finally { if (!invalidated.current.has(input)) { locked.current = false; if (alive.current) setBusy(false); } }
  }
  return { pending, busy, run };
}
