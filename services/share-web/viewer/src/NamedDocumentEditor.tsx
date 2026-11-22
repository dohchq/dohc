import { liveConnectionLimitMessage } from "@dohc/live-session-contract/live-connection";
import { LINK_REFUSALS } from "@dohc/security-contract/link-refusal";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  mountLiveBodyEditor,
  type LiveBodyEditorHandle,
  type LiveEditorToolbarState,
} from "@dohc/ydoc-projection/browser-editor";
import {
  NAMED_LIVE_NO_AUTOMATIC_RETRY,
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
          NAMED_LIVE_NO_AUTOMATIC_RETRY.includes(state.reason))))
  );
}
function statusText(state: NamedLiveBrowserState, link: boolean): string {
  if (state.status === "live")
    return state.pendingUpdates
      ? "Saving changes…"
      : state.lastApplied
        ? "Changes saved"
        : "Ready to edit";
  const limit = liveConnectionLimitMessage(state.reason);
  if (limit) return limit;
  const takesEdits = namedLiveEditable(state);
  if (state.typingAhead && state.pendingUpdates && (takesEdits || OPENING.includes(state.status)))
    return "Not sent yet. Your changes are only in this tab.";
  if (OPENING.includes(state.status)) return "Opening the file…";
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
  return takesEdits
    ? "Reconnecting. You can keep typing."
    : "Editing paused. Check your connection, then retry.";
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
  resolveImage,
}: {
  session: NamedDocumentSession;
  path: string;
  link?: boolean;
  statusSlot?: HTMLElement | null;
  bodyHidden?: boolean;
  resolveImage?: (src: string) => string | null;
  onState(state: NamedLiveBrowserState): void;
}) {
  const element = useRef<HTMLDivElement>(null),
    editorRef = useRef<LiveBodyEditorHandle | null>(null),
    resolveImageRef = useRef(resolveImage),
    autoFocusedRef = useRef(false),
    [state, setState] = useState(session.state()),
    [toolbar, setToolbar] = useState<LiveEditorToolbarState | null>(null);
  resolveImageRef.current = resolveImage;
  const frontmatter = useFrontmatterAsWritten(session.doc);
  useEffect(() => {
    if (!element.current) return;
    autoFocusedRef.current = false;
    const editor = mountLiveBodyEditor(element.current, {
      body: session.body,
      label: "Shared file editor",
      canEdit: () => namedLiveEditable(session.state()),
      edit: session.edit,
      resolveImage: (src) => resolveImageRef.current?.(src) ?? null,
    });
    editorRef.current = editor;
    const unsubscribeToolbar = editor.subscribeToolbar(setToolbar);
    const receive = (value: NamedLiveBrowserState) => {
      setState(value);
      editor.refresh();
      onState(value);
    };
    receive(session.state());
    const unsubscribe = session.subscribe(receive);
    return () => {
      unsubscribe();
      unsubscribeToolbar();
      editorRef.current = null;
      editor.destroy();
    };
  }, [session, onState]);
  const editable = namedLiveEditable(state);
  useEffect(() => {
    if (!link || !editable || bodyHidden || autoFocusedRef.current) return;
    autoFocusedRef.current = true;
    editorRef.current?.focus();
  }, [link, editable, bodyHidden]);
  const working =
    state.status === "live" || (OPENING.includes(state.status) && !state.pendingUpdates);
  const status = (
    <p
      className={working ? "named-document-status" : "named-document-status stopped"}
      role="status"
    >
      {statusText(state, link)}
    </p>
  );
  const showToolbar = editable && !bodyHidden && toolbar !== null;
  const keepSelection = (event: { preventDefault(): void }) => event.preventDefault();
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
      {showToolbar && (
        <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
          <button
            type="button"
            className="toolbar-button"
            aria-label="Bold"
            title="Bold (Ctrl+B)"
            aria-pressed={toolbar.bold}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleMark("bold")}
          >
            <Icon name="bold" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Italic"
            title="Italic (Ctrl+I)"
            aria-pressed={toolbar.italic}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleMark("italic")}
          >
            <Icon name="italic" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Strikethrough"
            title="Strikethrough (Ctrl+Shift+X)"
            aria-pressed={toolbar.strike}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleMark("strike")}
          >
            <Icon name="strikethrough" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Inline code"
            title="Inline code (Ctrl+E)"
            aria-pressed={toolbar.code}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleMark("code")}
          >
            <Icon name="code" size={15} />
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-button"
            aria-label="Heading 1"
            title="Heading 1 (Ctrl+Alt+1)"
            aria-pressed={toolbar.heading === 1}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.setHeading(1)}
          >
            <Icon name="heading-1" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Heading 2"
            title="Heading 2 (Ctrl+Alt+2)"
            aria-pressed={toolbar.heading === 2}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.setHeading(2)}
          >
            <Icon name="heading-2" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Heading 3"
            title="Heading 3 (Ctrl+Alt+3)"
            aria-pressed={toolbar.heading === 3}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.setHeading(3)}
          >
            <Icon name="heading-3" size={15} />
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-button"
            aria-label="Bullet list"
            title="Bullet list"
            aria-pressed={toolbar.bulletList}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleBulletList()}
          >
            <Icon name="list" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Numbered list"
            title="Numbered list"
            aria-pressed={toolbar.orderedList}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleOrderedList()}
          >
            <Icon name="list-ordered" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="To-do list"
            title="To-do list"
            aria-pressed={toolbar.taskList}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleTaskList()}
          >
            <Icon name="list-todo" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Quote"
            title="Quote"
            aria-pressed={toolbar.blockquote}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleBlockquote()}
          >
            <Icon name="quote" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Code block"
            title="Code block"
            aria-pressed={toolbar.codeBlock}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.toggleCodeBlock()}
          >
            <Icon name="square-code" size={15} />
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            className="toolbar-button"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            disabled={!toolbar.canUndo}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.undo()}
          >
            <Icon name="undo" size={15} />
          </button>
          <button
            type="button"
            className="toolbar-button"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!toolbar.canRedo}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.redo()}
          >
            <Icon name="redo" size={15} />
          </button>
        </div>
      )}
      {!bodyHidden && <PropertiesAsWritten block={frontmatter} collapsed={link} />}
      <div className="named-body-editor" ref={element} hidden={bodyHidden} />
    </section>
  );
}
