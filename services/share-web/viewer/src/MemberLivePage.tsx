import {useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode} from "react";
import {createPortal} from "react-dom";
import type {NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import {yDocToMarkdown} from "@dohc/ydoc-projection/browser-editor";
import {NamedDocumentEditor} from "./NamedDocumentEditor";
import {DiscardDraft} from "./DiscardDraft";
import {Toast} from "./Toast";
import {memberDocument, memberPageReady, openMemberPage, type MemberDocument} from "./memberLive";

/** How long a page waits for its owner's dohc, ring alone, before its toast. The desktop waits as long. */
export const LIVE_HOST_WAIT_REPORT_MS = 15_000;
const READY_RETRY_MS = 1_000, READY_RETRY_MAX_MS = 30_000;
const WAITS_FOR_HOST = "live-document-without-lineage";
// Why the host would not take a page, in the desktop's words. A code dohc does not know gets no reason.
const HOST_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  live_host_full: "The server is editing too many pages right now.",
  live_paused_by_owner: "The owner paused live editing for this page.",
  "document-unavailable": "The page moved or was deleted.",
  [WAITS_FOR_HOST]: "Editing starts once the owner's dohc is online.",
};

type Phase = {kind: "opening"} | {kind: "waiting"; reported: boolean} | {kind: "refused"; reason: string | null} | {kind: "live"};

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {clearTimeout(timer); signal.removeEventListener("abort", done); resolve();};
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, {once: true});
  });
}

/**
 * A member's page at Edit. The page's settled text shows until the live
 * editor has it. When the host will not take the page, the text stays and a
 * band under the header says so, with Try again, and a toast says why. A
 * page waiting for its owner's dohc shows a ring in that band, raises
 * its toast after LIVE_HOST_WAIT_REPORT_MS, and opens by itself once ready.
 * `leave` runs an action that would close the page, asking first when an
 * unsynced draft would go with it. When the page closes or opens again for any
 * other reason, such as Try again, a lower level, an ended membership or an
 * ended session, `onUnsent` gets the text that has not reached the workspace.
 */
export default function MemberLivePage({grantId, accountId, path, readView, statusSlot, bandSlot, toastSlot, leave, onUnsent}: {
  grantId: string; accountId: string; path: string; readView: ReactNode; statusSlot: HTMLElement | null; bandSlot: HTMLElement | null;
  toastSlot: HTMLElement | null;
  leave: MutableRefObject<((action: () => void) => void) | null>;
  onUnsent(text: string): void;
}) {
  const [phase, setPhase] = useState<Phase>({kind: "opening"}), [editing, setEditing] = useState<MemberDocument | null>(null);
  const [live, setLive] = useState(false), [pending, setPending] = useState(false), [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // `discarded` is the one session whose draft the person chose to discard. Any other session's unsent text is kept.
  const current = useRef<MemberDocument | null>(null), request = useRef<AbortController | null>(null), discarded = useRef<MemberDocument | null>(null);
  const onUnsentRef = useRef(onUnsent); onUnsentRef.current = onUnsent;
  const name = path.slice(path.lastIndexOf("/") + 1);
  // The editor closes at once, so nothing more is sent. Text that had not reached the workspace stays with the person.
  const release = useCallback(() => {
    const closing = current.current, state = closing?.session.state();
    if (closing && state && (state.pendingUpdates || state.status === "quarantined") && discarded.current !== closing) onUnsentRef.current(yDocToMarkdown(closing.session.doc));
    request.current?.abort(); closing?.close(); current.current = null;
  }, []);

  const refuse = useCallback((code: string) => {
    if (code === WAITS_FOR_HOST) return;
    setPhase({kind: "refused", reason: Object.hasOwn(HOST_REFUSAL_REASONS, code) ? HOST_REFUSAL_REASONS[code]! : null}); setDismissed(false);
  }, []);
  const open = useCallback(() => {
    release();
    const controller = new AbortController(), {signal} = controller; request.current = controller;
    setEditing(null); setLive(false); setPending(false); setDismissed(false); setPhase({kind: "opening"});
    void (async () => {
      let delay = READY_RETRY_MS;
      for (;;) {
        const admitted = await openMemberPage(grantId, path, signal);
        if (signal.aborted) return;
        if (admitted.kind === "open") {
          const opened = memberDocument({grantId, path, accountId, admission: admitted, onRefused: code => {if (!signal.aborted) refuse(code);}});
          current.current = opened; setEditing(opened); void opened.session.reconnect();
          return;
        }
        if (admitted.code !== WAITS_FOR_HOST) {refuse(admitted.code); return;}
        // The owner's dohc starts the page's live history once it is online. The relay holds each wait open until then.
        setPhase(value => value.kind === "waiting" ? value : {kind: "waiting", reported: false});
        while (!signal.aborted && !await memberPageReady(grantId, path, signal).catch(() => false)) {
          await wait(delay, signal); delay = Math.min(delay * 2, READY_RETRY_MAX_MS);
        }
        if (signal.aborted) return;
      }
    })().catch(() => {if (!signal.aborted) setPhase({kind: "refused", reason: null});});
  }, [grantId, path, accountId, refuse, release]);

  useEffect(() => {
    open();
    return release;
  }, [open, release]);
  // A page that waits for its owner says so only once it has waited a while.
  const waiting = phase.kind === "waiting" && !phase.reported;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setPhase(value => value.kind === "waiting" ? {kind: "waiting", reported: true} : value), LIVE_HOST_WAIT_REPORT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  const receive = useCallback((state: NamedLiveBrowserState) => {
    if (state.status === "live") {setLive(true); setPhase({kind: "live"});}
    setPending(state.pendingUpdates > 0 || state.status === "quarantined");
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const state = current.current?.session.state();
      if (state && (state.pendingUpdates || state.status === "quarantined")) {event.preventDefault(); event.returnValue = "";}
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    leave.current = action => {
      const state = current.current?.session.state();
      if (state && (state.pendingUpdates || state.status === "quarantined")) setLeaving(() => action); else action();
    };
    return () => {leave.current = null;};
  }, [leave]);

  const reason = phase.kind === "refused" ? phase.reason : phase.kind === "waiting" ? HOST_REFUSAL_REASONS[WAITS_FOR_HOST]! : null;
  const toast = !dismissed && (phase.kind === "refused" || (phase.kind === "waiting" && phase.reported));
  const readable = phase.kind === "refused" || phase.kind === "waiting";
  // Waiting for the owner's dohc is a state dohc is fixing, not a failure. The desktop titles it the same.
  const toastTitle = phase.kind === "waiting" ? `Waiting to edit "${name}"` : `dohc could not open "${name}" for editing`;
  const toastBody = reason ? `${reason} You can still read it.` : "You can still read it.";
  // The band says why the page is read-only. While dohc waits for the owner's dohc it is already trying, so only a refusal offers Try again.
  const band = phase.kind === "waiting" ? HOST_REFUSAL_REASONS[WAITS_FOR_HOST]! : reason ? toastBody : `dohc could not open this page for editing. ${toastBody}`;
  return <>
    {statusSlot && !editing && phase.kind === "opening" && createPortal(<p className="named-document-status" role="status">Opening the file…</p>, statusSlot)}
    {bandSlot && !live && readable && createPortal(<>
      <p role="status">{phase.kind === "waiting" && <span className="live-ring" aria-hidden="true"/>}{band}</p>
      {phase.kind === "refused" && <button type="button" onClick={open}>Try again</button>}
    </>, bandSlot)}
    {!live && readView}
    {editing && <NamedDocumentEditor key={editing.session.doc.guid} session={editing.session} path={path} link statusSlot={statusSlot} quietWhenSaved
      bodyHidden={!live} onState={receive}/>}
    {pending && <aside className="draft-recovery" aria-label="Draft recovery"><h2>Review your draft</h2>
      <p>Your unsynced changes exist only in this tab. Closing or reloading loses them.</p>
      <p>Copy the changes you want to keep. Open the current file, then paste and review them.</p>
      <button className="handoff-button secondary" onClick={() => leave.current?.(open)}>Open current file</button></aside>}
    {toast && toastSlot && createPortal(<Toast title={toastTitle} body={toastBody} {...(phase.kind === "waiting" ? {tone: "warning" as const} : {})} onRetry={open} onDismiss={() => setDismissed(true)}/>, toastSlot)}
    {leaving && <DiscardDraft cancel={() => setLeaving(null)} confirm={() => {const action = leaving; setLeaving(null); discarded.current = current.current; action();}}/>}
  </>;
}
