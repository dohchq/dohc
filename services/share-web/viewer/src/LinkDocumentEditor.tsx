import {useCallback, useEffect, useRef, useState} from "react";
import {NamedDocumentEditor, type NamedDocumentSession} from "./NamedDocumentEditor";
import {DiscardDraft} from "./DiscardDraft";
import {openLinkDocument} from "./linkLive";
import {LINK_REFUSALS} from "@dohc/security-contract/link-refusal";

/** Keep this mounted after access changes so the local draft remains recoverable. */
export function LinkDocumentEditor({discriminator, path, available, onClose}: {
  discriminator: string; path: string; available: boolean; onClose(): void;
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
        ? error.message : "dohc could not open this file for editing. Retry or ask the owner for access.");})
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
  const leave = (action: () => void) => {
    const state = current.current?.state();
    if (retainedDraft.current || state && (state.pendingUpdates || state.status === "quarantined")) setLeaving(() => action);
    else action();
  };
  return <div className="viewer">
    <header><div><p className="eyebrow">Shared by a dohc user</p><h1>{path}</h1></div>
      <button className="handoff-button secondary" onClick={() => leave(onClose)}>Back to shared files</button></header>
    {!available && <p role="alert">Editing is no longer available. Copy any unsynced changes before closing this file.</p>}
    {busy && <p role="status">Opening the file…</p>}
    {error && <div className="download-card"><p>{error}</p>
      {available && <button className="handoff-button secondary" onClick={open}>Retry</button>}</div>}
    {session && <NamedDocumentEditor key={session.doc.guid} session={session} path={path} link onState={receive}/>}
    {pending && <aside className="comments-panel" aria-label="Draft recovery"><h2>Review your draft</h2>
      <p>Your unsynced changes exist only in this tab. Closing or reloading loses them.</p>
      <p>Copy the changes you want to keep. Open the current file, then paste and review them.</p>
      {available && <button className="handoff-button secondary" onClick={() => leave(open)}>Open current file</button>}</aside>}
    {leaving && <DiscardDraft cancel={() => setLeaving(null)} confirm={() => {const action = leaving; setLeaving(null); action();}}/>}
  </div>;
}
