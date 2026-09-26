import {useEffect, useRef, useState} from "react";
import {mountLiveBodyEditor} from "@dohc/ydoc-projection/browser-editor";
import type {createNamedLiveBrowserTransport, NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import {PropertiesAsWritten, useFrontmatterAsWritten} from "./PropertiesAsWritten";
import "./namedRecipient.css";

export type NamedDocumentSession = ReturnType<ReturnType<typeof createNamedLiveBrowserTransport>["select"]>;
function statusText(state: NamedLiveBrowserState, link: boolean): string {
  if (state.status === "live") return state.pendingUpdates ? "Saving changes…" : state.lastApplied ? "Changes saved" : "Ready to edit";
  if (["authorizing", "connecting", "syncing"].includes(state.status)) return "Opening the file…";
  if (state.status === "quarantined") return "Editing stopped. Review your draft before opening the current file.";
  if (state.status === "refused") return link ? "This link cannot open the file. Ask the owner for access." : "This account cannot open the file. Sign in with the invited account.";
  if (state.status === "closed") return "Editing stopped. Copy any unsynced changes you want to keep.";
  return "Editing paused. Check your connection, then retry.";
}
export function NamedDocumentEditor({session, path, onState, link = false}: {session: NamedDocumentSession; path: string; link?: boolean;
  onState(state: NamedLiveBrowserState): void}) {
  const element = useRef<HTMLDivElement>(null), [state, setState] = useState(session.state());
  const frontmatter = useFrontmatterAsWritten(session.doc);
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
    <p className="named-document-status" role="status">{statusText(state, link)}</p>
    {state.status === "disconnected" && <button className="handoff-button secondary" onClick={() => void session.reconnect()}>Retry connection</button>}
    <PropertiesAsWritten block={frontmatter}/>
    <div className="named-body-editor" ref={element} />
  </section>;
}
