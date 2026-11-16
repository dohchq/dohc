import { liveConnectionLimitMessage } from "@dohc/live-session-contract/live-connection";
import { LINK_REFUSALS } from "@dohc/security-contract/link-refusal";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import {
  namedLiveEditable,
  type createNamedLiveBrowserTransport,
  type NamedLiveBrowserState,
} from "@dohc/ydoc-projection/named-live-browser-transport";
import { quoteRemovedText } from "@dohc/ydoc-projection/removed-text";
import { Icon } from "./icons";
import { PropertiesAsWritten, useFrontmatterAsWritten } from "./PropertiesAsWritten";
import "./namedRecipient.css";

export type NamedDocumentSession = ReturnType<
  ReturnType<typeof createNamedLiveBrowserTransport>["select"]
>;
const OPENING = ["authorizing", "connecting", "syncing"];
// A disconnected page reconnects by itself and sends a pending change again, except for these reasons.
const NO_AUTOMATIC_RETRY = [
  "authority-unavailable",
  "access-removed",
  "link-full",
  "paused",
  "live-stopped",
];
// Trying again can't change these, so the page offers no Try again.
const FINAL = ["access-removed", "link-full"];
/** Editing stopped with a change the page will not send again by itself. */
export function draftNeedsReview(state: NamedLiveBrowserState): boolean {
  return (
    state.status === "quarantined" ||
    // Words typed ahead wait on an open that stopped, through the page's own retries until it is live.
    (state.typingAhead && state.typingStopped && state.pendingUpdates > 0) ||
    (state.pendingUpdates > 0 &&
      (state.status === "closed" ||
        (state.status === "disconnected" &&
          state.reason !== null &&
          NO_AUTOMATIC_RETRY.includes(state.reason))))
  );
}
function statusText(state: NamedLiveBrowserState, link: boolean): string {
  if (state.status === "live")
    return state.pendingUpdates
      ? "Saving changes…"
      : state.lastApplied
        ? "Changes saved"
        : "Ready to edit";
  if (OPENING.includes(state.status))
    return state.typingAhead && state.pendingUpdates
      ? "Not sent yet. Your changes are only in this tab."
      : "Opening the file…";
  const limit = liveConnectionLimitMessage(state.reason);
  if (limit) return limit;
  if (state.status === "quarantined")
    return "Editing stopped. Review your draft before opening the current file.";
  if (state.status === "refused")
    return link
      ? "This link cannot open the file. Ask the owner for access."
      : "This account cannot open the file. Sign in with the invited account.";
  if (state.status === "closed")
    return "Editing stopped. Copy any unsynced changes you want to keep.";
  if (state.reason === "access-removed") return "The owner removed your access.";
  if (state.reason === "link-full")
    return "This link cannot take more people. Ask the owner for a new link.";
  if (state.reason === "authority-unavailable")
    return "dohc could not open the file for editing. Try again.";
  if (state.reason === "live-stopped") return LINK_REFUSALS.link_live_stopped.error;
  if (state.reason === "host-unavailable")
    return "The server could not open the file for editing. dohc keeps trying.";
  return "Editing paused. Check your connection, then retry.";
}
type Removed = { id: string; text: string };

/**
 * Text someone else's change removed from this page without having seen it. The lasting copy
 * is the one the file's owner keeps in History.
 */
function RemovedTextNotice({ session }: { session: NamedDocumentSession }) {
  const [removed, setRemoved] = useState<Removed[]>([]);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(
    () =>
      session.onRemovedText(({ text }) =>
        setRemoved((list) => [...list, { id: crypto.randomUUID(), text }]),
      ),
    [session],
  );
  const latest = removed[removed.length - 1];
  useEffect(() => setCopy("idle"), [latest?.id]);
  if (!latest) return null;
  const { quoted, more } = quoteRemovedText(latest.text);
  const dismiss = () => setRemoved((list) => list.filter((entry) => entry.id !== latest.id));
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(latest.text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className="edit-notice removed-text" role="alert" data-testid="removed-text-notice">
      <span className="tile">
        <Icon name="info" />
      </span>
      <div>
        <p className="edit-notice-title">Someone else's change removed this text</p>
        <blockquote className="removed-text-quote">{quoted}</blockquote>
        {more > 0 && (
          <p>And {more.toLocaleString()} more characters. Copy text copies all of it.</p>
        )}
        <p>The file's owner keeps a copy in History.</p>
        <div className="edit-notice-actions">
          <button className="handoff-button secondary" onClick={() => void copyText()}>
            {copy === "copied" ? "Copied" : copy === "failed" ? "Could not copy" : "Copy text"}
          </button>
          <button className="handoff-button secondary" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

/** The page's unsaved words, read again as the note or the session changes. */
function useUnsentText(session: NamedDocumentSession) {
  const [unsent, setUnsent] = useState(() => session.unsentText());
  useEffect(() => {
    const read = () => setUnsent(session.unsentText());
    read();
    session.doc.on("update", read);
    const unsubscribe = session.subscribe(read);
    return () => {
      session.doc.off("update", read);
      unsubscribe();
    };
  }, [session]);
  return unsent;
}

/**
 * The box a page shows when editing stopped with changes it will not send. It quotes the words
 * those changes typed, so the person can copy them into the current file. `children` are the
 * page's own actions, such as Open current file.
 */
export function DraftReview({
  session,
  className,
  children,
}: {
  session: NamedDocumentSession;
  className: string;
  children?: ReactNode;
}) {
  const unsent = useUnsentText(session);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const text = unsent?.text ?? "";
  useEffect(() => setCopy("idle"), [text]);
  const { quoted, more } = quoteRemovedText(text);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <aside className={className} aria-label="Draft recovery">
      <h2>Review your draft</h2>
      {unsent === null ? (
        <p>Nothing you typed is waiting to be saved.</p>
      ) : (
        <>
          <p>Your unsynced changes exist only in this tab. Closing or reloading loses them.</p>
          {text !== "" ? (
            <>
              <p>Copy what you typed. Open the current file, then paste and review it.</p>
              <blockquote className="removed-text-quote">{quoted}</blockquote>
              {more > 0 && (
                <p>And {more.toLocaleString()} more characters. Copy text copies all of it.</p>
              )}
            </>
          ) : (
            !unsent.deletes && (
              <p>They add no text you can copy. Make them again in the current file.</p>
            )
          )}
          {unsent.deletes && (
            <p>
              They also delete text. Delete it again in the current file if you still want it gone.
            </p>
          )}
        </>
      )}
      <div className="edit-notice-actions">
        {text !== "" && (
          <button className="handoff-button secondary" onClick={() => void copyText()}>
            {copy === "copied" ? "Copied" : copy === "failed" ? "Could not copy" : "Copy text"}
          </button>
        )}
        {children}
      </div>
    </aside>
  );
}

/**
 * A live document's editor. The link page draws the title and bar itself, so with `link` this
 * shows neither. Its saved state goes to `statusSlot`, in that bar, while editing works; a state
 * that stops editing stays above the text, where its sentence has room. `bodyHidden` keeps the
 * text out of view while the page still shows its own copy.
 */
export function NamedDocumentEditor({
  session,
  path,
  onState,
  link = false,
  statusSlot,
  bodyHidden = false,
}: {
  session: NamedDocumentSession;
  path: string;
  link?: boolean;
  statusSlot?: HTMLElement | null;
  bodyHidden?: boolean;
  onState(state: NamedLiveBrowserState): void;
}) {
  const element = useRef<HTMLDivElement>(null),
    [state, setState] = useState(session.state());
  const frontmatter = useFrontmatterAsWritten(session.doc);
  useEffect(() => {
    if (!element.current) return;
    const editor = mountLiveBodyEditor(element.current, {
      body: session.body,
      label: "Shared file editor",
      canEdit: () => namedLiveEditable(session.state()),
      edit: session.edit,
    });
    const receive = (value: NamedLiveBrowserState) => {
      setState(value);
      editor.refresh();
      onState(value);
    };
    receive(session.state());
    const unsubscribe = session.subscribe(receive);
    return () => {
      unsubscribe();
      editor.destroy();
    };
  }, [session, onState]);
  const working = state.status === "live" || OPENING.includes(state.status);
  const status = (
    <p
      className={working ? "named-document-status" : "named-document-status stopped"}
      role="status"
    >
      {statusText(state, link)}
    </p>
  );
  return (
    <section
      className={link ? "named-document" : "content named-document"}
      aria-label="Shared file"
    >
      {!link && <h1>{path}</h1>}
      {statusSlot && working ? createPortal(status, statusSlot) : status}
      {state.status === "disconnected" && !FINAL.includes(state.reason ?? "") && (
        <button className="handoff-button secondary" onClick={() => void session.reconnect()}>
          {state.reason === "authority-unavailable" ||
          state.reason === "host-unavailable" ||
          state.reason === "live-stopped" ||
          liveConnectionLimitMessage(state.reason)
            ? "Try again"
            : "Retry connection"}
        </button>
      )}
      <RemovedTextNotice session={session} />
      {!bodyHidden && <PropertiesAsWritten block={frontmatter} collapsed={link} />}
      <div className="named-body-editor" ref={element} hidden={bodyHidden} />
    </section>
  );
}
