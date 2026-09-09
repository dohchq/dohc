import {useEffect, useRef, useState} from "react";
import {mountLiveBodyEditor} from "@dohc/ydoc-projection/browser-editor";
import type {createNamedLiveBrowserTransport, NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import "./namedRecipient.css";

export type NamedDocumentSession = ReturnType<ReturnType<typeof createNamedLiveBrowserTransport>["select"]>;
function statusText(state: NamedLiveBrowserState): string {
  if (state.status === "live") return state.pendingUpdates ? "Saving changes…" : state.lastApplied ? "Changes saved" : "Ready to edit";
  if (["authorizing", "connecting", "syncing"].includes(state.status)) return "Opening the file…";
  if (state.status === "quarantined") return "Editing stopped. Review your draft before opening the current file.";
  if (state.status === "refused") return "This account cannot open the file. Sign in with the invited account.";
  return "Editing paused. Check your connection, then retry.";
}
export function NamedDocumentEditor({session, path, onState}: {session: NamedDocumentSession; path: string;
  onState(state: NamedLiveBrowserState): void}) {
  const element = useRef<HTMLDivElement>(null), [state, setState] = useState(session.state());
  useEffect(() => {
    if (!element.current) return;
    const editor = mountLiveBodyEditor(element.current, {body: session.body, label: "Shared file editor",
      canEdit: () => session.state().status === "live", edit: session.edit});
    const receive = (value: NamedLiveBrowserState) => {setState(value); editor.refresh(); onState(value);};
    receive(session.state());
    const unsubscribe = session.subscribe(receive);
    return () => {unsubscribe(); editor.destroy();};
  }, [session, onState]);
  return <section className="content named-document" aria-label="Shared file">
    <h1>{path}</h1>
    <p className="named-document-status" role="status">{statusText(state)}</p>
    {state.status === "disconnected" && <button className="handoff-button secondary" onClick={() => void session.reconnect()}>Retry connection</button>}
    <div className="named-body-editor" ref={element} />
  </section>;
}
