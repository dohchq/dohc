import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { NamedLiveBrowserState } from "@dohc/ydoc-projection/named-live-browser-transport";
import {
  draftNeedsReview,
  DraftReview,
  LIVE_OFF,
  NamedDocumentEditor,
  type NamedDocumentSession,
} from "./NamedDocumentEditor";
import { DiscardDraft } from "./DiscardDraft";
import { Icon } from "./icons";
import { openLinkDocument } from "./linkLive";
import { linkRefusalCode } from "./namedRecipient";
import { LINK_REFUSALS, type LinkRefusalCode } from "@dohc/security-contract/link-refusal";

const FILE_GONE = "This file moved or was removed. Ask its owner for a new link.";
const COULD_NOT_OPEN =
  "dohc could not open this file for editing. Retry in a moment. If it keeps happening, ask the owner.";

/**
 * Keep this mounted after access changes so the local draft remains recoverable.
 * `barSlot` is the page's bar, where Done and the saved state go. `onOpenChange` hears when the
 * file is first live in the editor, so the page shows its read-only text until then. `otherWay` is offered
 * beside Try again when editing could not start. `gone` says the shared files no longer list it.
 */
export function LinkDocumentEditor({
  discriminator,
  path,
  available,
  gone,
  onClose,
  barSlot,
  onOpenChange,
  otherWay,
  resolveImage,
}: {
  discriminator: string;
  path: string;
  available: boolean;
  gone?: boolean;
  onClose(): void;
  barSlot?: HTMLElement | null;
  onOpenChange?(open: boolean): void;
  otherWay?: ReactNode;
  resolveImage?: (src: string) => string | null;
}) {
  const current = useRef<NamedDocumentSession | null>(null),
    request = useRef<AbortController | null>(null);
  const retainedDraft = useRef(false);
  const [session, setSession] = useState<NamedDocumentSession | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<LinkRefusalCode | "could-not-open" | null>(null);
  const [review, setReview] = useState(false),
    [leaving, setLeaving] = useState<(() => void) | null>(null);
  // A session exists before it is authorized and synced. Its text is there once it has the host's early state or
  // has been live.
  const [live, setLive] = useState(false);
  const receive = useCallback((reported?: NamedLiveBrowserState) => {
    if (reported?.status === "live" || reported?.typingAhead) setLive(true);
    const state = current.current?.state();
    setReview(retainedDraft.current || (!!state && draftNeedsReview(state)));
  }, []);
  const open = () => {
    if (!available) return;
    request.current?.abort();
    current.current?.close();
    current.current = null;
    retainedDraft.current = false;
    setSession(null);
    setLive(false);
    setReview(false);
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    void openLinkDocument(discriminator, path, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || request.current !== controller) {
          value.close();
          return;
        }
        current.current = value;
        setSession(value);
        void value.reconnect();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && request.current === controller)
          setError(linkRefusalCode(error) ?? "could-not-open");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };
  useEffect(() => {
    open();
    return () => {
      request.current?.abort();
      current.current?.close();
      current.current = null;
    };
  }, [discriminator, path]);
  useEffect(() => {
    if (!available) {
      const state = current.current?.state();
      retainedDraft.current ||=
        !!state && (state.pendingUpdates > 0 || state.status === "quarantined");
      request.current?.abort();
      current.current?.close();
      setBusy(false);
      receive();
    }
  }, [available, receive]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = current.current?.state();
      if (
        retainedDraft.current ||
        (state && (state.pendingUpdates || state.status === "quarantined"))
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const hasFile = session !== null && live;
  useEffect(() => {
    onOpenChange?.(hasFile);
  }, [hasFile, onOpenChange]);
  const leave = (action: () => void) => {
    const state = current.current?.state();
    if (
      retainedDraft.current ||
      (state && (state.pendingUpdates || state.status === "quarantined"))
    )
      setLeaving(() => action);
    else action();
  };
  const readable = error === "link_live_unavailable" || error === "link_live_stopped";
  const bar = (
    <>
      {busy && (
        <p className="named-document-status" role="status">
          Opening the file…
        </p>
      )}
      <button className="handoff-button secondary" onClick={() => leave(onClose)}>
        Done
      </button>
    </>
  );
  return (
    <>
      {barSlot ? createPortal(bar, barSlot) : <div className="header-actions">{bar}</div>}
      {!available && (
        <p className="edit-alert" role="alert">
          {gone
            ? FILE_GONE
            : "Editing is no longer available. Copy any unsynced changes before closing this file."}
        </p>
      )}
      {error && !gone && (
        <div className="edit-notice" role="alert">
          <span className="tile bad">
            <Icon name="alert" />
          </span>
          <div>
            <p className="edit-notice-title">
              {error === "could-not-open"
                ? COULD_NOT_OPEN
                : error === "link_live_unavailable"
                  ? "dohc could not start editing this page."
                  : error === "link_live_stopped"
                    ? LIVE_OFF
                    : LINK_REFUSALS[error].error}
            </p>
            {readable && <p>You can still read and comment here.</p>}
            <div className="edit-notice-actions">
              {available && (
                <button className="handoff-button secondary" onClick={open}>
                  Try again
                </button>
              )}
              {otherWay}
              <button
                type="button"
                className="handoff-button secondary"
                onClick={() => (session ? setError(null) : leave(onClose))}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {session && (
        <NamedDocumentEditor
          key={session.id}
          session={session}
          path={path}
          link
          statusSlot={barSlot}
          bodyHidden={!live}
          resolveImage={resolveImage}
          onState={receive}
        />
      )}
      {review && session && (
        <DraftReview session={session} className="draft-recovery">
          {available && (
            <button className="handoff-button secondary" onClick={() => leave(open)}>
              Open current file
            </button>
          )}
        </DraftReview>
      )}
      {leaving && (
        <DiscardDraft
          cancel={() => setLeaving(null)}
          confirm={() => {
            const action = leaving;
            setLeaving(null);
            action();
          }}
        />
      )}
    </>
  );
}
