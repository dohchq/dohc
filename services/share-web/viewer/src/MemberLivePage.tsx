import {useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode} from "react";
import {createPortal} from "react-dom";
import type {NamedLiveBrowserState} from "@dohc/ydoc-projection/named-live-browser-transport";
import {NamedDocumentEditor} from "./NamedDocumentEditor";
import {DiscardDraft} from "./DiscardDraft";
import {Icon} from "./icons";
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
 * toast says why; a page waiting for its owner's dohc shows a ring, raises
 * its toast after LIVE_HOST_WAIT_REPORT_MS, and opens by itself once ready.
 * `leave` runs an action that would close the page, asking first when an
 * unsynced draft would go with it.
 */
export default function MemberLivePage({grantId, accountId, path, readView, statusSlot, toastSlot, leave}: {
  grantId: string; accountId: string; path: string; readView: ReactNode; statusSlot: HTMLElement | null; toastSlot: HTMLElement | null;
  leave: MutableRefObject<((action: () => void) => void) | null>;
}) {
  const [phase, setPhase] = useState<Phase>({kind: "opening"}), [editing, setEditing] = useState<MemberDocument | null>(null);
  const [live, setLive] = useState(false), [pending, setPending] = useState(false), [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const current = useRef<MemberDocument | null>(null), request = useRef<AbortController | null>(null);
  const name = path.slice(path.lastIndexOf("/") + 1);

  const refuse = useCallback((code: string) => {
    if (code === WAITS_FOR_HOST) return;
    setPhase({kind: "refused", reason: Object.hasOwn(HOST_REFUSAL_REASONS, code) ? HOST_REFUSAL_REASONS[code]! : null}); setDismissed(false);
  }, []);
  const open = useCallback(() => {
    request.current?.abort(); current.current?.close(); current.current = null;
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
  }, [grantId, path, accountId, refuse]);

  useEffect(() => {
    open();
    return () => {request.current?.abort(); current.current?.close(); current.current = null;};
  }, [open]);
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
  return <>
    {statusSlot && !live && (!editing || readable) && createPortal(phase.kind === "opening"
      ? <p className="named-document-status" role="status">Opening the file…</p>
      : readable ? <p className="named-document-status" role="status">{phase.kind === "waiting" && <span className="live-ring" aria-hidden="true"/>}You can read this page.</p>
      : null, statusSlot)}
    {!live && readView}
    {editing && <NamedDocumentEditor key={editing.session.doc.guid} session={editing.session} path={path} link statusSlot={statusSlot}
      bodyHidden={!live} onState={receive}/>}
    {pending && <aside className="draft-recovery" aria-label="Draft recovery"><h2>Review your draft</h2>
      <p>Your unsynced changes exist only in this tab. Closing or reloading loses them.</p>
      <p>Copy the changes you want to keep. Open the current file, then paste and review them.</p>
      <button className="handoff-button secondary" onClick={() => leave.current?.(open)}>Open current file</button></aside>}
    {toast && toastSlot && createPortal(<div className="edit-notice workspace-toast" role="alert">
      <span className="tile bad"><Icon name="alert"/></span>
      <div>
        <p className="edit-notice-title">dohc could not open "{name}" for editing</p>
        <p>{reason ? `${reason} You can still read it.` : "You can still read it."}</p>
        <div className="edit-notice-actions"><button className="handoff-button secondary" onClick={open}>Try again</button></div>
      </div>
      <button className="icon-button toast-close" type="button" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(true)}><Icon name="x"/></button>
    </div>, toastSlot)}
    {leaving && <DiscardDraft cancel={() => setLeaving(null)} confirm={() => {const action = leaving; setLeaving(null); action();}}/>}
  </>;
}
