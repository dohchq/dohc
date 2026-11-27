import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { NamedLiveBrowserState } from "@dohc/ydoc-projection/named-live-browser-transport";
import { yDocToMarkdown } from "@dohc/ydoc-projection/browser-editor";
import { NamedDocumentEditor } from "./NamedDocumentEditor";
import { DiscardDraft, UNSENT_EDITS } from "./DiscardDraft";
import { UnsentEditsRow } from "./UnsentEdits";
import { Toast } from "./Toast";
import { memberDocument, memberPageReady, openMemberPage, type MemberDocument } from "./memberLive";
import type { LivePageTarget } from "./memberLive";

/** How long a page waits for its owner's dohc, ring alone, before its toast. The desktop waits as long. */
export const LIVE_HOST_WAIT_REPORT_MS = 15_000;
const READY_RETRY_MS = 1_000,
  READY_RETRY_MAX_MS = 30_000;
const WAITS_FOR_HOST = "live-document-without-lineage",
  WAITING = "Editing starts once the owner's dohc is online.";
// Why the host would not take a page, in the desktop's words. A code dohc does not know gets no reason.
const HOST_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  live_host_full: "The server is editing too many pages right now.",
  live_paused_by_owner: "The owner paused live editing for this page.",
  "document-unavailable": "The page moved or was deleted.",
  [WAITS_FOR_HOST]: "Open this page on a computer once to edit it here.",
  paused: "Live editing is paused for this page. Resume it in dohc to edit here.",
  "conflict-parent-withheld":
    "A conflict was resolved in this page, so live editing can't resume. Open Live documents in dohc to make a copy that can go live.",
  "session-host-diverged":
    "The server's copy of this workspace no longer matches the synced one, so live editing stopped. Contact the server's operator.",
  "note-format-off":
    "The server turned off the newer note format this page uses. Ask the server's operator to turn it back on.",
};
const READ_ONLY = "live_hosting_unsupported";

type Phase =
  | { kind: "opening" }
  | { kind: "waiting"; reported: boolean }
  | { kind: "refused"; reason: string | null }
  | { kind: "read" }
  | { kind: "live" };

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * A member's page at Edit. The page's settled text shows until the live
 * editor has it. When the host will not take the page, the text stays and a
 * band under the header says so, with Try again, and a toast says why. A
 * page waiting for its owner's dohc shows a ring in that band, raises
 * its toast after LIVE_HOST_WAIT_REPORT_MS, and opens by itself once ready.
 * `leave` runs an action that would close the page, asking first when an
 * unsent edits would go with them. While dohc cannot send them, they show in
 * `draftSlot`, above the page, named `draftName`, with Copy, Download and Discard. Discard
 * acts at once and hands the text to `onUnsent` as discarded, whose row offers Undo. When the
 * page closes or opens again for any other reason, such as Try again, a lower level, an ended
 * membership or an ended session, `onUnsent` gets the text that has not reached the workspace.
 */
export default function MemberLivePage({
  target,
  accountId,
  path,
  draftName,
  readView,
  statusSlot,
  bandSlot,
  draftSlot,
  toastSlot,
  leave,
  onUnsent,
}: {
  target: LivePageTarget;
  accountId: string;
  path: string;
  draftName: string;
  readView: ReactNode;
  statusSlot: HTMLElement | null;
  bandSlot: HTMLElement | null;
  draftSlot: HTMLElement | null;
  toastSlot: HTMLElement | null;
  leave: MutableRefObject<((action: () => void) => void) | null>;
  onUnsent(text: string, discarded?: boolean): void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "opening" }),
    [editing, setEditing] = useState<MemberDocument | null>(null);
  const [live, setLive] = useState(false),
    [pending, setPending] = useState(false),
    [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // `discarded` is the one session whose draft the person chose to discard. Any other session's unsent text is kept.
  const current = useRef<MemberDocument | null>(null),
    request = useRef<AbortController | null>(null),
    discarded = useRef<MemberDocument | null>(null);
  const onUnsentRef = useRef(onUnsent);
  onUnsentRef.current = onUnsent;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const owner = "workspaceId" in target,
    place = owner ? target.workspaceId : target.grantId;
  // The editor closes at once, so nothing more is sent. Text that had not reached the workspace stays with the person.
  const release = useCallback(() => {
    const closing = current.current,
      state = closing?.session.state();
    if (
      closing &&
      state &&
      (state.pendingUpdates || state.status === "quarantined") &&
      discarded.current !== closing
    )
      onUnsentRef.current(yDocToMarkdown(closing.session.doc));
    request.current?.abort();
    closing?.close();
    current.current = null;
  }, []);

  const refuse = useCallback((code: string) => {
    if (code === READ_ONLY) return setPhase({ kind: "read" });
    setPhase({
      kind: "refused",
      reason: Object.hasOwn(HOST_REFUSAL_REASONS, code) ? HOST_REFUSAL_REASONS[code]! : null,
    });
    setDismissed(code === WAITS_FOR_HOST);
  }, []);
  const open = useCallback(() => {
    release();
    const controller = new AbortController(),
      { signal } = controller;
    request.current = controller;
    setEditing(null);
    setLive(false);
    setPending(false);
    setDismissed(false);
    setPhase({ kind: "opening" });
    const target = owner ? { workspaceId: place } : { grantId: place };
    void (async () => {
      let delay = READY_RETRY_MS;
      for (;;) {
        const admitted = await openMemberPage(target, path, signal);
        if (signal.aborted) return;
        if (admitted.kind === "open" || admitted.kind === "owner") {
          const opened = memberDocument({
            target,
            path,
            accountId,
            admission: admitted,
            onRefused: (code) => {
              if (!signal.aborted && (owner || code !== WAITS_FOR_HOST)) refuse(code);
            },
          });
          current.current = opened;
          setEditing(opened);
          void opened.session.reconnect();
          return;
        }
        if (admitted.kind === "preparing") {
          await wait(delay, signal);
          delay = Math.min(delay * 2, READY_RETRY_MAX_MS);
          continue;
        }
        if (admitted.code !== WAITS_FOR_HOST || owner) {
          refuse(admitted.code);
          return;
        }
        // The owner's dohc starts the page's live history once it is online. The relay holds each wait open until then.
        setPhase((value) =>
          value.kind === "waiting" ? value : { kind: "waiting", reported: false },
        );
        while (
          !signal.aborted &&
          !(await memberPageReady(place, path, signal).catch(() => false))
        ) {
          await wait(delay, signal);
          delay = Math.min(delay * 2, READY_RETRY_MAX_MS);
        }
        if (signal.aborted) return;
      }
    })().catch(() => {
      if (!signal.aborted) setPhase({ kind: "refused", reason: null });
    });
  }, [owner, place, path, accountId, refuse, release]);

  useEffect(() => {
    open();
    return release;
  }, [open, release]);
  // A page that waits for its owner says so only once it has waited a while.
  const waiting = phase.kind === "waiting" && !phase.reported;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(
      () =>
        setPhase((value) =>
          value.kind === "waiting" ? { kind: "waiting", reported: true } : value,
        ),
      LIVE_HOST_WAIT_REPORT_MS,
    );
    return () => clearTimeout(timer);
  }, [waiting]);

  const receive = useCallback((state: NamedLiveBrowserState) => {
    if (state.status === "live") {
      setLive(true);
      setPhase({ kind: "live" });
    }
    // A live session keeps saving, and the header says "Saving changes…". The person needs the draft only once dohc cannot send it.
    setPending(
      state.status === "quarantined" || (state.status !== "live" && state.pendingUpdates > 0),
    );
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = current.current?.session.state();
      if (state && (state.pendingUpdates || state.status === "quarantined")) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    leave.current = (action) => {
      const state = current.current?.session.state();
      if (state && (state.pendingUpdates || state.status === "quarantined"))
        setLeaving(() => action);
      else action();
    };
    return () => {
      leave.current = null;
    };
  }, [leave]);
  // The row's Discard needs no question: the discarded text keeps its Undo in the kept rows.
  const discardNow = () => {
    const closing = current.current;
    if (!closing) return;
    discarded.current = closing;
    onUnsentRef.current(yDocToMarkdown(closing.session.doc), true);
    open();
  };

  const reason =
    phase.kind === "refused" ? phase.reason : phase.kind === "waiting" ? WAITING : null;
  const toast =
    !dismissed && (phase.kind === "refused" || (phase.kind === "waiting" && phase.reported));
  // Waiting for the owner's dohc is a state dohc is fixing, not a failure. The desktop titles it the same.
  const toastTitle =
    phase.kind === "waiting"
      ? `Waiting to edit "${name}"`
      : `dohc could not open "${name}" for editing`;
  const toastBody = reason ? `${reason} You can still read it.` : "You can still read it.";
  // The band says why the page is read-only. While dohc waits for the owner's dohc it is already trying, so only a refusal offers Try again.
  const band =
    phase.kind === "waiting"
      ? WAITING
      : reason
        ? toastBody
        : `dohc could not open this page for editing. ${toastBody}`;
  return (
    <>
      {statusSlot &&
        !editing &&
        phase.kind === "opening" &&
        createPortal(
          <p className="named-document-status" role="status">
            Opening the file…
          </p>,
          statusSlot,
        )}
      {/* A refusal shows here even after the page went live. A stopped session puts its own state in the band. */}
      {bandSlot &&
        (phase.kind === "refused" || (phase.kind === "waiting" && !live)) &&
        createPortal(
          <>
            <p role="status">
              {phase.kind === "waiting" && <span className="live-ring" aria-hidden="true" />}
              {band}
            </p>
            {phase.kind === "refused" && (
              <button type="button" onClick={open}>
                Try again
              </button>
            )}
          </>,
          bandSlot,
        )}
      {!live && readView}
      {editing && (
        <NamedDocumentEditor
          key={editing.session.id}
          session={editing.session}
          path={path}
          link
          statusSlot={statusSlot}
          quietWhenSaved
          bandSlot={bandSlot}
          bodyHidden={!live}
          onState={receive}
        />
      )}
      {pending &&
        editing &&
        draftSlot &&
        createPortal(
          <UnsentEditsRow
            name={draftName}
            path={path}
            text={yDocToMarkdown(editing.session.doc)}
            onDiscard={discardNow}
          />,
          draftSlot,
        )}
      {toast &&
        toastSlot &&
        createPortal(
          <Toast
            title={toastTitle}
            body={toastBody}
            {...(phase.kind === "waiting" ? { tone: "warning" as const } : {})}
            onRetry={open}
            onDismiss={() => setDismissed(true)}
          />,
          toastSlot,
        )}
      {leaving && (
        <DiscardDraft
          words={UNSENT_EDITS}
          cancel={() => setLeaving(null)}
          confirm={() => {
            const action = leaving;
            setLeaving(null);
            discarded.current = current.current;
            action();
          }}
        />
      )}
    </>
  );
}
