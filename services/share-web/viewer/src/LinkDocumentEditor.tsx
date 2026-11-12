import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {NamedDocumentEditor, type NamedDocumentSession} from "./NamedDocumentEditor";
import {DiscardDraft} from "./DiscardDraft";
import {Icon} from "./icons";
import {openLinkDocument} from "./linkLive";
import {LINK_REFUSALS} from "@dohc/security-contract/link-refusal";

const COULD_NOT_OPEN = "dohc could not open this file for editing. Retry in a moment. If it keeps happening, ask the owner.";

/**
 * Keep this mounted after access changes so the local draft remains recoverable.
 * `barSlot` is the page's bar, where Done and the saved state go. `onOpenChange` hears when the
 * editor has the file, so the page can stop showing its read-only text. `otherWay` is offered
 * beside Try again when editing could not start.
 */
export function LinkDocumentEditor({discriminator, path, available, onClose, barSlot, onOpenChange, otherWay}: {
  discriminator: string; path: string; available: boolean; onClose(): void;
  barSlot?: HTMLElement | null; onOpenChange?(open: boolean): void; otherWay?: ReactNode;
}) {
  const current = useRef<NamedDocumentSession | null>(null), request = useRef<AbortController | null>(null);
  const retainedDraft = useRef(false);
  const [session, setSession] = useState<NamedDocumentSession | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [leaving, setLeaving] = useState<(() => void) | null>(null);
  const receive = useCallback(() => {
    const state = current.current?.state(); setPending(retainedDraft.current || !!state && (state.pendingUpdates > 0 || state.status === "quarantined"));
  }, []);
  const open = () => {
    if (!available) return;
    request.current?.abort(); current.current?.close(); current.current = null; retainedDraft.current = false; setSession(null); setPending(false);
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
    void openLinkDocument(discriminator, path, controller.signal).then(value => {
      if (controller.signal.aborted || request.current !== controller) {value.close(); return;}
      current.current = value; setSession(value); void value.reconnect();
    }).catch((error: unknown) => {if (!controller.signal.aborted && request.current === controller) setError(
      error instanceof Error && Object.values(LINK_REFUSALS).some(value => value.error === error.message)
        ? error.message : COULD_NOT_OPEN);})
      .finally(() => {if (!controller.signal.aborted) setBusy(false);});
  };
  useEffect(() => {
    open();
    return () => {request.current?.abort(); current.current?.close(); current.current = null;};
  }, [discriminator, path]);
  useEffect(() => {
    if (!available) {
      const state = current.current?.state();
      retainedDraft.current ||= !!state && (state.pendingUpdates > 0 || state.status === "quarantined");
      request.current?.abort(); current.current?.close(); setBusy(false); receive();
    }
  }, [available, receive]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = current.current?.state();
      if (retainedDraft.current || state && (state.pendingUpdates || state.status === "quarantined")) {event.preventDefault(); event.returnValue = "";}
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const hasFile = session !== null;
  useEffect(() => {onOpenChange?.(hasFile);}, [hasFile, onOpenChange]);
  const leave = (action: () => void) => {
    const state = current.current?.state();
    if (retainedDraft.current || state && (state.pendingUpdates || state.status === "quarantined")) setLeaving(() => action);
    else action();
  };
  // The server gives one answer whether the page is still being prepared or will never go live,
  // so this says what the person can still do and keeps Try again.
  const unavailable = error === LINK_REFUSALS.link_live_unavailable.error;
  const bar = <>
    {busy && <p className="named-document-status" role="status">Opening the file…</p>}
    <button className="handoff-button secondary" onClick={() => leave(onClose)}>Done</button>
  </>;
  return <>
    {barSlot ? createPortal(bar, barSlot) : <div className="header-actions">{bar}</div>}
    {!available && <p className="edit-alert" role="alert">Editing is no longer available. Copy any unsynced changes before closing this file.</p>}
    {error && <div className="edit-notice" role="alert"><span className="tile bad"><Icon name="alert"/></span><div>
      <p className="edit-notice-title">{unavailable ? "dohc could not start editing this page." : error}</p>
      {unavailable && <p>You can still read and comment here.</p>}
      <div className="edit-notice-actions">
        {available && <button className="handoff-button secondary" onClick={open}>Try again</button>}
        {otherWay}
      </div></div></div>}
    {session && <NamedDocumentEditor key={session.doc.guid} session={session} path={path} link statusSlot={barSlot} onState={receive}/>}
    {pending && <aside className="draft-recovery" aria-label="Draft recovery"><h2>Review your draft</h2>
      <p>Your unsynced changes exist only in this tab. Closing or reloading loses them.</p>
      <p>Copy the changes you want to keep. Open the current file, then paste and review them.</p>
      {available && <button className="handoff-button secondary" onClick={() => leave(open)}>Open current file</button>}</aside>}
    {leaving && <DiscardDraft cancel={() => setLeaving(null)} confirm={() => {const action = leaving; setLeaving(null); action();}}/>}
  </>;
}
