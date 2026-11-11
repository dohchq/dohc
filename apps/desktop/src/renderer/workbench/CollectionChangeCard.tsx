import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, CircleAlert, LoaderCircle, LockKeyhole } from "lucide-react";
import type { ChatMessageRecord } from "../../ipc/bridgeContract";
import { isDatasetOwnerOnly, isDatasetServerNotFound } from "../../ipc/errorWords";
import {
  collectionApplyLabel, collectionChangeDeletes, collectionChangeNoteRow, collectionDeletesMore, describeCollectionChangeRow, historyCanUndoCollectionChange, sameCollectionChange,
  type CollectionChangeProposal, type CollectionChangeRow,
} from "../../workspaces/collectionChange";
import { bridge } from "../bridge";
import {
  applyCollectionChange, applyCollectionChangeReview, loadCollectionChange, readCollectionChangeProposal, recordCollectionChange, undoCollectionChange,
  type CollectionChange,
} from "../collections/collectionChangeFlow";
import { ipcErrorMessage } from "../ipcError";
import { formatClock } from "../time";
import { CopyButton } from "../ui/CopyButton";
import { DangerButton, PrimaryButton, SecondaryButton } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { CHANGE_ICONS, CHANGE_LOSS, CollectionChangeReviewDialog } from "./CollectionChangeReviewDialog";
/** Not now is one person's choice on one device. It posts nothing. */
const notNowKey = (workspaceId: string, messageId: string) => `dohc:change-card:not-now:${workspaceId}:${messageId}`;
const readNotNow = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const by = (name: string, atMs: number | null) => atMs === null ? name : `${name} · ${formatClock(atMs)}`;
/**
 * What a failed Apply says. Someone who sees the Collection through a share can't change its rules, which no retry fixes.
 * The server answers "not found" for a Collection the caller can't change, so a 404 names the server.
 */
export const collectionApplyFailure = (name: string) => (error: unknown) => isDatasetOwnerOnly(error)
  ? { words: `You can't apply changes to ${name}. Ask its owner to apply it.`, retry: false, ownerOnly: true }
  : isDatasetServerNotFound(error)
  ? { words: `The server that keeps ${name} refused this change. Nothing changed. Ask its owner to apply it.`, retry: false }
  : { words: ipcErrorMessage(error, `dohc could not apply the change to ${name}.`), retry: true };
/** What Apply says when it holds a change that records made delete more than the card shows. */
export const collectionDeletesMoreFailure = (was: { records: number; values: number }, now: { records: number; values: number }) => ({
  words: `Records changed after it was sent, and it would now delete ${collectionDeletesMore(was, now)}. Review the source change to apply it.`, retry: false });

export type CollectionChangeCardPhase = { kind: "idle" } | { kind: "applying"; words: "Applying…" | "Undoing…" }
  // `ownerOnly`: the person can't make this change, which no retry fixes.
  | { kind: "failed"; words: string; retry: boolean; ownerOnly?: boolean };

// The last change each card showed this session, so a card the chat list
// draws again, as it scrolls back into view, keeps its height from the start.
const shownChanges = new Map<string, CollectionChange>();
const remember = (key: string, change: CollectionChange | null) => {
  shownChanges.delete(key);
  if (change === null) return;
  shownChanges.set(key, change);
  if (shownChanges.size > 200) shownChanges.delete(shownChanges.keys().next().value!);
};

/**
 * A message's attached change to a Collection's rules: what applying it does
 * and who made each part, with Apply and Not now while it waits. Apply posts
 * a reply as the person who clicked, which answers the message's question.
 */
export function CollectionChangeCard(props: {
  workspaceId: string;
  message: ChatMessageRecord;
  /** The message's change file, or the one the reply that applied it attached when a review applied another change. */
  path: string;
  /** The reply that answered the message, which applied the change. */
  appliedBy?: ChatMessageRecord;
  /** The later reply that undid it. */
  undoneBy?: ChatMessageRecord;
  locked: boolean;
  onOpenPath?: (path: string) => void;
  /** Posts the reply that applying or undoing the change makes, attaching `attach` when given. Resolves once it posts. */
  onReply: (input: { body: string; resolves: boolean; attach?: string }) => Promise<void>;
  onError: (message: string, cause?: unknown, retry?: () => void) => void;
  /** Says what Apply or Undo did when it finishes after the chat closed, since its reply posts out of sight. */
  onNotice?: (message: string) => void;
  /** Where its reply posts, as a reply that fails to post names it: "#planning" or "your chat with Claude". */
  chatName: string;
  testIdPrefix: string;
}) {
  const { workspaceId, message, path } = props;
  const shownKey = `${workspaceId}\n${message.id}\n${path}`;
  // A change file the applying reply attached names who made each part up to that reply.
  const since = props.appliedBy?.attachments?.some(attachment => attachment.pathHint === path) ? props.appliedBy.createdAtMs : message.createdAtMs;
  // The attached file names the Collection, so the card's frame and heading draw once it answers.
  const [proposal, setProposal] = useState<CollectionChangeProposal | null>(() => shownChanges.get(shownKey)?.proposal ?? null);
  const [change, setChange] = useState<CollectionChange | null>(() => shownChanges.get(shownKey) ?? null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [phase, setPhase] = useState<CollectionChangeCardPhase>({ kind: "idle" });
  const key = notNowKey(workspaceId, message.id);
  const [notNow, setNotNow] = useState(() => readNotNow(key));
  const [reload, setReload] = useState(0);
  // Apply found the files no longer make the change shown.
  const [stale, setStale] = useState(false);
  // The change as the card showed it when Review opened.
  const [reviewing, setReviewing] = useState<CollectionChange | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let current = true;
    setLoadFailure(null);
    const api = bridge();
    void (async () => {
      const read = await readCollectionChangeProposal(api, workspaceId, path);
      if (!current) return;
      setProposal(read);
      if (read === null) { remember(shownKey, null); setChange(null); return; }
      try {
        const loaded = await loadCollectionChange(api, { workspaceId, proposal: read, postedAtMs: since });
        if (!current) return;
        remember(shownKey, loaded);
        setChange(loaded);
      } catch (error) { if (current) setLoadFailure(ipcErrorMessage(error, "dohc could not read this change.")); }
    })();
    return () => { current = false; };
  }, [workspaceId, path, shownKey, since, reload, props.appliedBy?.id, props.undoneBy?.id]);

  // A failure stays on the card while it shows. Once the chat closed it goes to the shell's toasts,
  // where Try again runs the same Apply or Undo again.
  const fail = (failure: { words: string; retry: boolean; ownerOnly?: boolean }, error: unknown, again: () => void) => {
    if (mounted.current) setPhase({ kind: "failed", ...failure });
    else props.onError(failure.words, error, failure.retry ? again : undefined);
  };
  // A reply that didn't post can be posted again from its notice, so the message still gets its answer.
  const posted = (body: string, resolves: boolean, words: string, attach?: string) => {
    const post = (): Promise<void> => props.onReply({ body, resolves, ...(attach ? { attach } : {}) })
      .catch((error: unknown) => props.onError(ipcErrorMessage(error, words), error, () => void post()));
    return post();
  };
  // When what was applied isn't exactly what was asked, the reply attaches a file that records it, so the card shows it.
  const recorded = (asked: CollectionChangeProposal, applied: CollectionChangeProposal) =>
    applied.changeSha256 === asked.changeSha256 && sameCollectionChange(asked.rows, applied.rows) ? Promise.resolve(undefined)
      : recordCollectionChange(bridge(), workspaceId, applied).catch((error: unknown) => {
        props.onError(ipcErrorMessage(error, "dohc applied the change but could not save which change it applied."), error);
        return undefined;
      });
  // Once the chat closed, a notice says what Apply or Undo did, since its reply posts out of sight
  // and may not post at all.
  const settled = (done?: string) => {
    if (mounted.current) { setPhase({ kind: "idle" }); setReload(value => value + 1); }
    else if (done) props.onNotice?.(done);
  };

  // Apply prepares the change from the Collection as it is now, so Try again does too.
  const apply = async (shown: CollectionChange) => {
    const again = () => void apply(shown);
    const done = `Applied the change to ${shown.proposal.name}`;
    setPhase({ kind: "applying", words: "Applying…" });
    try {
      const result = await applyCollectionChange(bridge(), workspaceId, shown);
      if (result.kind === "deletes-more") return fail(collectionDeletesMoreFailure(result.was, result.now), null, again);
      if (result.kind === "edited") {
        if (!mounted.current) return fail({ words: "Its files changed after it was sent. Review the change to apply it.", retry: false }, null, again);
        setStale(true);
        return settled();
      }
      await posted(`${done}.`, true, `dohc applied the change to ${shown.proposal.name} but could not post its reply in ${props.chatName}.`, await recorded(shown.proposal, result.proposal));
      settled(done);
    } catch (error) { fail(collectionApplyFailure(shown.proposal.name)(error), error, again); }
  };

  const undo = async (shown: CollectionChange) => {
    const done = `Undid the change to ${shown.proposal.name}`;
    setPhase({ kind: "applying", words: "Undoing…" });
    try {
      await undoCollectionChange(bridge(), workspaceId, shown.proposal);
      await posted(`${done}.`, false, `dohc undid the change to ${shown.proposal.name} but could not post its reply in ${props.chatName}.`);
      settled(done);
    } catch (error) { fail({ words: ipcErrorMessage(error, `dohc could not undo the change to ${shown.proposal.name}.`), retry: true }, error, () => void undo(shown)); }
  };

  if (proposal === null) return null;
  const putOff = () => { try { localStorage.setItem(key, "1"); } catch { /* It shows again next time. */ } setNotNow(true); };
  const unfold = () => { try { localStorage.removeItem(key); } catch { /* Not now lasts only as long as storage does. */ } setNotNow(false); };
  const failure = collectionApplyFailure(proposal.name);
  // Apply found the files no longer make the change shown, so the card says they changed.
  const shown = change !== null && stale && change.state.kind === "waiting" ? { ...change, state: { kind: "edited" as const, by: null, atMs: null } } : change;
  return <>
    <CollectionChangeCardView message={message} proposal={proposal} change={shown} loadFailure={loadFailure} phase={phase} notNow={notNow}
      appliedBy={props.appliedBy} undoneBy={props.undoneBy} locked={props.locked} onOpenPath={props.onOpenPath} testIdPrefix={props.testIdPrefix}
      onApply={() => { if (change) void apply(change); }} onUndo={() => { if (change) void undo(change); }} onReview={() => setReviewing(change)}
      onNotNow={putOff} onUnfold={unfold} onRetryLoad={() => setReload(value => value + 1)} />
    {reviewing ? createPortal(<CollectionChangeReviewDialog workspaceId={workspaceId} asked={reviewing} locked={props.locked} failure={failure}
      testIdPrefix={props.testIdPrefix} onClose={() => setReviewing(null)} onNotNow={putOff}
      onApply={async review => {
        try { await applyCollectionChangeReview(bridge(), workspaceId, review); } catch (error) {
          if (!mounted.current) props.onError(failure(error).words, error);
          throw error;
        }
        // A review can apply another change than the one asked.
        await posted(`Applied the change to ${proposal.name}.`, true, `dohc applied the change to ${proposal.name} but could not post its reply in ${props.chatName}.`, await recorded(reviewing.proposal, review.change.proposal));
        if (mounted.current) setStale(false);
        settled(`Applied the change to ${proposal.name}`);
      }} />, document.body) : null}
  </>;
}

/** The card as it draws in one state, which the states page shows without a workspace. */
export function CollectionChangeCardView(props: {
  message: ChatMessageRecord;
  proposal: CollectionChangeProposal;
  /** Null while History and the Collection answer. */
  change: CollectionChange | null;
  loadFailure: string | null;
  phase: CollectionChangeCardPhase;
  notNow: boolean;
  appliedBy?: ChatMessageRecord;
  undoneBy?: ChatMessageRecord;
  locked: boolean;
  onOpenPath?: (path: string) => void;
  onApply: () => void;
  onUndo: () => void;
  onReview: () => void;
  onNotNow: () => void;
  onUnfold: () => void;
  onRetryLoad: () => void;
  testIdPrefix: string;
}) {
  const { message, proposal, change, phase } = props;
  const testId = (part: string) => `${props.testIdPrefix}-change-${part}`;
  const state = change?.state ?? null;
  const busy = phase.kind === "applying";
  // Folded until it's known to be applied. Its line says Waiting once that's known.
  if (props.notNow && !busy && state?.kind !== "applied") {
    return <button type="button" data-testid={testId("not-now")} onClick={props.onUnfold}
      className="mt-2 flex h-[38px] w-full max-w-[740px] items-center gap-2 rounded-lg border border-line bg-panel px-3.5 text-left text-[13px] text-muted transition-colors hover:bg-panel-2">
      <ChevronRight size={14} strokeWidth={1.9} aria-hidden className="shrink-0" />
      {state ? <><span className="font-medium text-ink">Waiting</span><span className="min-w-0 truncate">· Change to {proposal.name}</span></>
        : <span className="min-w-0 truncate">Change to {proposal.name}</span>}
    </button>;
  }
  const heading = (status?: ReactNode) => <div className="flex min-h-11 items-center gap-2.5 border-b border-line px-3.5 py-2.5">
    <span className="font-semibold text-ink">Change to {props.onOpenPath
      ? <button type="button" onClick={() => props.onOpenPath?.(proposal.datasetPath)} className="font-semibold text-ink underline decoration-subtle underline-offset-[3px]">{proposal.name}</button>
      : proposal.name}</span>
    {status}
  </div>;
  if (change === null || state === null) {
    const loadFailure = props.loadFailure;
    // The rows wait for History and the Collection. Only a failed read offers Try again.
    return <div data-testid={testId("loading")} className="mt-2 w-full max-w-[740px] overflow-hidden rounded-lg border border-line bg-panel">
      {heading()}
      {loadFailure !== null ? <div data-testid={testId("load-failed")} className="flex items-start gap-2 px-3.5 py-2.5 text-[12px] text-ink">
        <CircleAlert size={14} strokeWidth={1.9} aria-hidden className="mt-px shrink-0 text-danger" />
        <span className="min-w-0">{loadFailure}</span>
        <CopyButton iconOnly label="Copy" pinName getText={() => loadFailure} />
        <SecondaryButton size="row" className="ml-auto shrink-0" onClick={props.onRetryLoad}>Try again</SecondaryButton>
      </div> : <div className="flex min-h-8 items-center py-1.5 pl-10 pr-3.5">
        <SkeletonRows rows={1} className="w-full" label={`Loading the change to ${proposal.name}`} />
      </div>}
    </div>;
  }
  const { rows } = change;
  const undone = state.kind === "applied" && !state.current && props.undoneBy;
  const deletes = collectionChangeDeletes(rows);
  const undoable = historyCanUndoCollectionChange(rows);
  const applyLabel = collectionApplyLabel(deletes);
  const ApplyButton = deletes.records || deletes.values ? DangerButton : PrimaryButton;
  const tense = state.kind === "applied" ? "past" : "present";
  const noteAt = proposal.note === null ? -1 : collectionChangeNoteRow(rows);
  const note = proposal.note === null ? null : `${message.authorDisplayName}'s note: "${proposal.note}"`;
  const review = <button type="button" data-testid={testId("review")} onClick={props.onReview}
    className="ml-4 shrink-0 text-[12px] text-muted underline underline-offset-[3px] hover:text-ink">Review source change</button>;
  const later = <SecondaryButton data-testid={testId("not-now-button")} disabled={props.locked} onClick={props.onNotNow}>Not now</SecondaryButton>;
  const status = undone ? { label: "Undone", dot: "bg-subtle", reply: props.undoneBy }
    : state.kind === "applied" ? { label: "Applied", dot: "bg-success", reply: props.appliedBy } : null;

  let footer: ReactNode = null;
  if (busy) {
    footer = <Footer><LoaderCircle size={14} strokeWidth={1.9} aria-hidden className="shrink-0 animate-spin text-ink" /><span className="text-[12px] text-muted">{phase.words}</span></Footer>;
  } else if (state.kind === "edited") {
    footer = <Footer><PrimaryButton data-testid={testId("review-button")} onClick={props.onReview}>Review source change</PrimaryButton>{later}</Footer>;
  } else if (state.kind === "waiting") {
    const retry = phase.kind !== "failed" || phase.retry;
    footer = <Footer>
      {retry ? <ApplyButton data-testid={testId("apply")} disabled={props.locked} onClick={props.onApply}>{phase.kind === "failed" ? "Try again" : applyLabel}</ApplyButton> : null}
      {later}
      {undoable ? <span className="flex-1" /> : <span className="min-w-0 flex-1 text-[12px] text-muted">{CHANGE_LOSS}</span>}
      {review}
    </Footer>;
  } else if (!undone && state.current && undoable) {
    footer = <Footer><SecondaryButton data-testid={testId("undo")} disabled={props.locked} onClick={props.onUndo}>Undo</SecondaryButton></Footer>;
  } else if (!undone && !undoable) {
    footer = <Footer><span className="min-w-0 flex-1 text-[12px] text-muted">{CHANGE_LOSS}</span></Footer>;
  }

  return <div data-testid={testId("card")} data-state={undone ? "undone" : busy ? "applying" : phase.kind === "failed" ? "failed" : state.kind}
    className="mt-2 w-full max-w-[740px] overflow-hidden rounded-lg border border-line bg-panel">
    {heading(status ? <span className="ml-auto flex items-center gap-2 text-[12px] text-muted">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2 py-px text-[11px] text-ink">
        <span className={`size-1.5 rounded-full ${status.dot}`} aria-hidden />{status.label}
      </span>
      {status.reply ? <span>by {by(status.reply.authorDisplayName, status.reply.createdAtMs)}</span> : null}
    </span> : null)}
    <ul className="py-1">
      {rows.map((row, index) => <ChangeRow key={row.key} row={row} tense={tense} note={index === noteAt ? note : null} message={message} />)}
    </ul>
    {note !== null && noteAt === -1 ? <p className="mx-3.5 mb-2 text-[12px] text-muted">{note}</p> : null}
    {phase.kind === "failed" && !busy ? <div role="alert" data-testid={testId("failed")} className="mx-3.5 mb-2.5 mt-0.5 flex items-start gap-2 rounded-md border border-danger/45 bg-bg px-2.5 py-2 text-[12px] text-ink">
      {phase.ownerOnly ? <LockKeyhole size={14} strokeWidth={1.9} aria-hidden data-testid={testId("owner-only")} className="mt-px shrink-0 text-muted" />
        : <CircleAlert size={14} strokeWidth={1.9} aria-hidden className="mt-px shrink-0 text-danger" />}
      <span className="min-w-0">{phase.words}</span>
      <CopyButton iconOnly label="Copy" pinName getText={() => phase.words} />
    </div> : null}
    {state.kind === "edited" && !busy ? <p data-testid={testId("edited")} className="mx-3.5 mb-2.5 mt-0.5 flex items-center gap-1.5 text-[12px] text-warning">
      <CircleAlert size={14} strokeWidth={1.9} aria-hidden className="shrink-0" />
      <span>{state.atMs === null ? "Its files changed after it was sent." : state.by ? `${state.by.name} changed these files at ${formatClock(state.atMs)}.` : `These files changed at ${formatClock(state.atMs)}.`} Review the change to apply it.</span>
    </p> : null}
    {footer}
  </div>;
}

function Footer(props: { children: ReactNode }) {
  return <div className="flex items-center gap-2.5 border-t border-line px-3.5 py-2.5">{props.children}</div>;
}

/** One part of the change. A part someone other than the message's author made names them on the right. */
function ChangeRow(props: { row: CollectionChangeRow; tense: "present" | "past"; note: string | null; message: ChatMessageRecord }) {
  const words = describeCollectionChangeRow(props.row, props.tense);
  const { icon: Icon, tone } = CHANGE_ICONS[words.icon];
  const author = props.row.source?.author;
  const other = author && (author.name !== props.message.authorDisplayName || author.agent !== (props.message.authorKind === "agent"));
  const effect = props.note ?? words.effect;
  return <li className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2 px-3.5 py-1.5">
    <span className={`grid size-[18px] place-items-center ${tone}`}><Icon size={14} strokeWidth={1.9} aria-hidden /></span>
    <div className="min-w-0">
      <div className="font-medium text-ink">{words.text}{words.type ? <span className="font-normal text-muted"> {words.type}</span> : null}</div>
      {effect ? <div className={`flex items-center gap-1.5 text-[12px] ${words.danger && !props.note ? "text-danger" : "text-muted"}`}>
        {words.danger && !props.note ? <CircleAlert size={12} strokeWidth={1.9} aria-hidden className="shrink-0" /> : null}
        <span className={words.file && !props.note ? "font-mono text-[11px]" : undefined}>{effect}</span>
      </div> : null}
    </div>
    {other ? <span className="mt-0.5 text-[11px] text-subtle">{by(author.name, props.row.source?.atMs ?? null)}</span> : <span />}
  </li>;
}
