import { liveConnectionLimitMessage } from "@dohc/live-session-contract/live-connection";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  mountLiveBodyEditor,
  type LiveBodyEditorHandle,
  type LiveEditorToolbarState,
} from "@dohc/ydoc-projection/browser-editor";
import { documentWords } from "@dohc/interface-words/documents";
import type { BodySequenceUnwritten } from "@dohc/ydoc-projection/body-sequence-editor";
import { readsBodySequence } from "@dohc/ydoc-projection/body-sequence-yjs";
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
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl+";
const MOD_ALT_KEY = IS_MAC ? "⌘⌥" : "Ctrl+Alt+";
const MOD_SHIFT_KEY = IS_MAC ? "⌘⇧" : "Ctrl+Shift+";
const FINAL = [
  "access-removed",
  "link-full",
  "live-starting",
  "live-stopped",
  "document-gone",
  "note-format-off",
];
export const LIVE_OFF = "Live editing of this file is off. Only its owner can start it again.";
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
function statusText(state: NamedLiveBrowserState, link: boolean, band: boolean): string {
  if (state.status === "live")
    return state.pendingUpdates
      ? "Saving changes…"
      : state.lastApplied
        ? "Changes saved"
        : "Ready to edit";
  const limit = liveConnectionLimitMessage(state.reason);
  if (limit) return limit;
  // In the band, the unsent edits show above the page with their own Copy, Download and Discard.
  if (band && (state.status === "quarantined" || state.status === "closed"))
    return state.status === "quarantined"
      ? "Editing stopped. dohc could not send your unsent edits. Copy or download them, then discard them to keep editing."
      : "Editing stopped.";
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
  if (state.reason === "authority-unavailable") return "dohc could not open the file for editing.";
  if (state.reason === "live-starting") return "Live editing is starting.";
  if (state.reason === "live-stopped")
    return link ? `${LIVE_OFF} You can still read and comment here.` : LIVE_OFF;
  if (state.reason === "document-gone")
    return "This file moved or was removed. Ask its owner to share it again.";
  if (state.reason === "note-format-off")
    return `Live editing is off because the server turned off the newer note format this file uses. Ask the server's operator to turn it back on.${link ? " You can still read and comment here." : ""}`;
  if (state.reason === "host-unavailable")
    return "The server could not open the file for editing. dohc keeps trying.";
  return takesEdits
    ? "Reconnecting. You can keep typing."
    : "Editing paused. Check your connection.";
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

export function editingOf(session: NamedDocumentSession, doc: NamedDocumentSession["doc"]) {
  return {
    canEdit: () => session.doc === doc && namedLiveEditable(session.state()),
    edit: (change: () => void) => session.doc === doc && session.edit(change),
  };
}

/** The page's unsaved words, read again as the note or the session changes. */
function useUnsentText(session: NamedDocumentSession) {
  const [unsent, setUnsent] = useState(() => session.unsentText());
  const doc = session.doc;
  useEffect(() => {
    const read = () => setUnsent(session.unsentText());
    read();
    doc.on("update", read);
    const unsubscribe = session.subscribe(read);
    return () => {
      doc.off("update", read);
      unsubscribe();
    };
  }, [session, doc]);
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
 * text out of view while the page still shows its own copy. With `quietWhenSaved`, the bar shows
 * nothing while every edit is saved, so the page's own level stays the only word there. With `bandSlot`,
 * a state that stops editing goes to that band with the warning mark, and the page shows refusals itself.
 */
export function NamedDocumentEditor({
  session,
  path,
  onState,
  link = false,
  statusSlot,
  bandSlot,
  bodyHidden = false,
  quietWhenSaved = false,
  resolveImage,
}: {
  session: NamedDocumentSession;
  path: string;
  link?: boolean;
  statusSlot?: HTMLElement | null;
  bandSlot?: HTMLElement | null;
  bodyHidden?: boolean;
  quietWhenSaved?: boolean;
  resolveImage?: (src: string) => string | null;
  onState(state: NamedLiveBrowserState): void;
}) {
  const element = useRef<HTMLDivElement>(null),
    editorRef = useRef<LiveBodyEditorHandle | null>(null),
    resolveImageRef = useRef(resolveImage),
    autoFocusedRef = useRef(false),
    [state, setState] = useState(session.state()),
    [format, setFormat] = useState<1 | 2 | null>(null),
    [unwritten, setUnwritten] = useState<BodySequenceUnwritten | null>(null),
    [toolbar, setToolbar] = useState<LiveEditorToolbarState | null>(null);
  resolveImageRef.current = resolveImage;
  const doc = session.doc;
  const frontmatter = useFrontmatterAsWritten(doc);
  useEffect(() => {
    const read = () => setFormat(session.state().holds ? (readsBodySequence(doc) ? 2 : 1) : null);
    const receive = (value: NamedLiveBrowserState) => {
      setState(value);
      read();
      editorRef.current?.refresh();
      onState(value);
    };
    receive(session.state());
    const unsubscribe = session.subscribe(receive);
    doc.on("update", read);
    return () => {
      doc.off("update", read);
      unsubscribe();
    };
  }, [session, doc, onState]);
  useEffect(() => {
    if (!element.current || format === null) return;
    autoFocusedRef.current = false;
    const editor = mountLiveBodyEditor(element.current, {
      doc,
      label: "Shared file editor",
      ...editingOf(session, doc),
      unwritten: (why) => why !== "guarded" && setUnwritten(why),
      resolveImage: (src) => resolveImageRef.current?.(src) ?? null,
    });
    editorRef.current = editor;
    const unsubscribeToolbar = editor.subscribeToolbar(setToolbar);
    return () => {
      unsubscribeToolbar();
      editorRef.current = null;
      editor.destroy();
      setUnwritten(null);
    };
  }, [session, doc, format]);
  const editable = namedLiveEditable(state);
  useEffect(() => {
    if (!link || !editable || bodyHidden || autoFocusedRef.current || !editorRef.current) return;
    autoFocusedRef.current = true;
    editorRef.current.focus();
  }, [link, editable, bodyHidden, format]);
  const working =
    state.status === "live" ||
    state.reason === "live-starting" ||
    (OPENING.includes(state.status) && !state.pendingUpdates);
  const status = (
    <p
      className={working ? "named-document-status" : "named-document-status stopped"}
      role="status"
    >
      {statusText(state, link, false)}
    </p>
  );
  const retryLabel =
    state.reason === "authority-unavailable" ||
    state.reason === "host-unavailable" ||
    liveConnectionLimitMessage(state.reason)
      ? "Try again"
      : "Retry connection";
  const retry =
    state.status === "disconnected" &&
    !FINAL.includes(state.reason ?? "") &&
    (() => void session.reconnect());
  const inBand = bandSlot !== undefined && !working;
  const showToolbar = editable && !bodyHidden && toolbar !== null;
  const keepSelection = (event: { preventDefault(): void }) => event.preventDefault();
  return (
    <section
      className={link ? "named-document" : "content named-document"}
      aria-label="Shared file"
    >
      {!link && <h1>{path}</h1>}
      {inBand
        ? bandSlot &&
          state.status !== "refused" &&
          createPortal(
            <>
              <p role="status">
                <Icon name="triangle-alert" size={14} />
                {statusText(state, link, true)}
              </p>
              {retry && (
                <button type="button" onClick={retry}>
                  {retryLabel}
                </button>
              )}
            </>,
            bandSlot,
          )
        : statusSlot && working
          ? quietWhenSaved && state.status === "live" && !state.pendingUpdates
            ? null
            : createPortal(status, statusSlot)
          : status}
      {!inBand && retry && (
        <button className="handoff-button secondary" onClick={retry}>
          {retryLabel}
        </button>
      )}
      <RemovedTextNotice session={session} />
      {unwritten && (
        <div className="edit-notice" role="alert" data-testid="unwritten-notice">
          <p>
            {unwritten === "overtaken" ? documentWords.unwrittenOvertaken : documentWords.unwritten}
          </p>
          <button className="handoff-button secondary" onClick={() => setUnwritten(null)}>
            {documentWords.dismiss}
          </button>
        </div>
      )}
      {showToolbar && (
        <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
          <button
            type="button"
            className="toolbar-button"
            aria-label="Bold"
            title={`Bold (${MOD_KEY}B)`}
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
            title={`Italic (${MOD_KEY}I)`}
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
            title={`Strikethrough (${MOD_SHIFT_KEY}X)`}
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
            title={`Inline code (${MOD_KEY}E)`}
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
            title={`Heading 1 (${MOD_ALT_KEY}1)`}
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
            title={`Heading 2 (${MOD_ALT_KEY}2)`}
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
            title={`Heading 3 (${MOD_ALT_KEY}3)`}
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
            title={`Undo (${MOD_KEY}Z)`}
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
            title={`Redo (${MOD_SHIFT_KEY}Z)`}
            disabled={!toolbar.canRedo}
            onMouseDown={keepSelection}
            onClick={() => editorRef.current?.redo()}
          >
            <Icon name="redo" size={15} />
          </button>
        </div>
      )}
      {!bodyHidden && <PropertiesAsWritten block={frontmatter} collapsed />}
      <div className="named-body-editor" ref={element} hidden={bodyHidden} />
    </section>
  );
}
