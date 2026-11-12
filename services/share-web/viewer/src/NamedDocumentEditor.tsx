import {liveConnectionLimitMessage} from "@dohc/live-session-contract/live-connection";
import {useEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {mountLiveBodyEditor} from "@dohc/ydoc-projection/browser-editor";
import type {createNamedLiveBrowserTransport, NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import {PropertiesAsWritten, useFrontmatterAsWritten} from "./PropertiesAsWritten";
import "./namedRecipient.css";

export type NamedDocumentSession = ReturnType<ReturnType<typeof createNamedLiveBrowserTransport>["select"]>;
const OPENING = ["authorizing", "connecting", "syncing"];
/** Editing stopped with a change the page will not send again by itself. In every other state it still sends a pending change. */
export function draftNeedsReview(state: NamedLiveBrowserState): boolean {
  return state.status === "quarantined" || state.pendingUpdates > 0 &&
    (state.status === "closed" || state.status === "disconnected" && state.reason === "authority-unavailable");
}
function statusText(state: NamedLiveBrowserState, link: boolean): string {
  if (state.status === "live") return state.pendingUpdates ? "Saving changes…" : state.lastApplied ? "Changes saved" : "Ready to edit";
  if (OPENING.includes(state.status)) return "Opening the file…";
  const limit = liveConnectionLimitMessage(state.reason);
  if (limit) return limit;
  if (state.status === "quarantined") return "Editing stopped. Review your draft before opening the current file.";
  if (state.status === "refused") return link ? "This link cannot open the file. Ask the owner for access." : "This account cannot open the file. Sign in with the invited account.";
  if (state.status === "closed") return "Editing stopped. Copy any unsynced changes you want to keep.";
  if (state.reason === "authority-unavailable") return "dohc could not open the file for editing. Try again.";
  return "Editing paused. Check your connection, then retry.";
}
/**
 * A live document's editor. The link page draws the title and bar itself, so with `link` this
 * shows neither. Its saved state goes to `statusSlot`, in that bar, while editing works; a state
 * that stops editing stays above the text, where its sentence has room. `bodyHidden` keeps the
 * text out of view while the page still shows its own copy.
 */
export function NamedDocumentEditor({session, path, onState, link = false, statusSlot, bodyHidden = false}: {session: NamedDocumentSession; path: string; link?: boolean;
  statusSlot?: HTMLElement | null; bodyHidden?: boolean; onState(state: NamedLiveBrowserState): void}) {
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
  const working = state.status === "live" || OPENING.includes(state.status);
  const status = <p className={working ? "named-document-status" : "named-document-status stopped"} role="status">{statusText(state, link)}</p>;
  return <section className={link ? "named-document" : "content named-document"} aria-label="Shared file">
    {!link && <h1>{path}</h1>}
    {statusSlot && working ? createPortal(status, statusSlot) : status}
    {state.status === "disconnected" && <button className="handoff-button secondary" onClick={() => void session.reconnect()}>
      {state.reason === "authority-unavailable" || liveConnectionLimitMessage(state.reason) ? "Try again" : "Retry connection"}</button>}
    {!bodyHidden && <PropertiesAsWritten block={frontmatter} collapsed={link}/>}
    <div className="named-body-editor" ref={element} hidden={bodyHidden} />
  </section>;
}
