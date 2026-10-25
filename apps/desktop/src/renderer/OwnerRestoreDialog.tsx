import {useEffect, useMemo, useRef, useState} from "react";
import {bridge} from "./bridge";
import {Overlay} from "./Overlay";
import {DangerButton, PrimaryButton, SecondaryButton} from "./ui/controls";
import { SkeletonLines } from "./ui/SkeletonRows";
import {useRequestSequence} from "./useRequestSequence";
import {ipcErrorMessage} from "./ipcError";
import {ownerRestoreOutcomes} from "./ownerRestoreOutcomes";
import {AgentBadge} from "./workbench/AgentBadge";
import type {OwnerRestoreOptions, OwnerRestorePhase, OwnerRestorePlan, OwnerRestoreReview, OwnerRestoreStatus} from "../ipc/ownerRestoreContract";

type State = {kind: "loading"} | {kind: "options"; options: OwnerRestoreOptions}
  | {kind: "stop"; plan: OwnerRestorePlan} | {kind: "review"; review: OwnerRestoreReview}
  | {kind: "pending"; message: string} | {kind: "error"; message: string} | {kind: "complete"; moved: boolean} | {kind: "declined"} | {kind: "refused"};

// Where an unfinished restore waits: for the owner's decision while it can
// still be declined, for the host once live editing of the file stopped, and
// to finish once the restore was admitted. Null once it resumed or was declined.
export type UnfinishedRestoreStage = "decide" | "waiting" | "finishing";
export function unfinishedRestoreStage(phase: OwnerRestorePhase): UnfinishedRestoreStage | null {
  if (phase === "resumed" || phase === "declined") return null;
  if (phase === "authority-invalidated") return "decide";
  return phase === "fenced" || phase === "old-cut-applied" || phase === "native-fenced" ? "waiting" : "finishing";
}
// The owner can decline a restore until the relay admits it.
const beforeAdmission = (phase: OwnerRestorePhase) => {
  const stage = unfinishedRestoreStage(phase);
  return stage === "decide" || stage === "waiting";
};
const STAGE_MESSAGES: Record<UnfinishedRestoreStage, string> = {
  decide: "Access stopped for this restore. Review the restore, or decline it to keep the file unchanged.",
  waiting: "The restore has not finished. Live editing of this file stays stopped until it does. Retry to continue it.",
  finishing: "The restore has not finished. Retry to finish it.",
};
const QUOTA_MESSAGE = "This workspace has reached its limit on the server. Free some space, then retry the restore.";
const DECLINING_MESSAGE = "Declining has not finished. Live editing of this file stays stopped until it does. Retry to finish declining.";
/** A Decline the relay refused to end. Asking again gets the same refusal. */
export const DECLINE_REFUSED_MESSAGE = "Declining did not finish, and trying again will not finish it. Live editing of this file stays stopped.";
type Authority = OwnerRestoreReview["acceptedEvents"][number]["metadata"]["accepted"]["authority"];
// Account emails the relay resolved for this file's grants and authors, by account ID.
type Emails = ReadonlyMap<string, string>;
const recipient = (row: {principalKind: string; email: string | null; userId: string | null}, emails: Emails) =>
  row.principalKind === "link" ? "Anyone using this link"
    : row.email ?? (row.userId === null ? undefined : emails.get(row.userId)) ?? `Account ${row.userId}`;
// Who the relay accepted a change from. An account the relay could not name keeps its ID.
const author = (authority: Authority, emails: Emails) => authority.principalKind === "owner" ? "Owner"
  : authority.principalKind === "link" ? "Link participant" : emails.get(authority.principalId) ?? `Account ${authority.principalId}`;
const time = (ms: number) => new Date(ms).toLocaleString();
// One line per restore point: when, and who made the change. Points that read
// the same gain their order, oldest first, so no two choices look alike.
function pointLabels(points: OwnerRestoreOptions["points"], emails: Emails): Map<number, string> {
  const base = new Map(points.map(p => [p.cursor, p.authority === null ? "Before accepted edits" : `${time(p.receivedAtMs!)} · ${author(p.authority, emails)}`]));
  const labels = new Map<number, string>();
  for (const label of new Set(base.values())) {
    const same = [...base].filter(([, other]) => other === label).map(([cursor]) => cursor).sort((a, b) => a - b);
    same.forEach((cursor, index) => labels.set(cursor, same.length === 1 ? label : `${label} (${index + 1} of ${same.length})`));
  }
  return labels;
}

function ChangeList({label, events, emails}: {label: string; events: OwnerRestoreReview["acceptedEvents"]; emails: Emails}) {
  const [page, setPage] = useState(0), start = page * 50;
  if (!events.length) return null;
  return <details className="border-t border-line py-3">
    <summary className="cursor-pointer text-[13px] text-ink">{label} <span className="font-mono">({events.length})</span></summary>
    <ol className="space-y-2 pl-5 text-[12px] text-muted" start={start + 1}>
      {events.slice(start, start + 50).map(({metadata}) => {
        const {authority, receipt, receivedAtMs} = metadata.accepted;
        const agent = metadata.authorSnapshot?.find(entry => entry.kind === "agent");
        return <li key={receipt.deliveryId}>
          {author(authority, emails)}
          {agent ? <span className="inline-flex max-w-full items-center gap-1"> · <AgentBadge testIdPrefix="owner-restore-change"
            author={{authorDisplayName: agent.agentName ?? agent.agentId, authorOwnerDisplayName: "Owner"}} />
            <span className="min-w-0 break-all text-agent">{agent.agentName ?? agent.agentId}</span></span> : null}
          <span> · {time(receivedAtMs)}</span>
          <details><summary className="cursor-pointer">Change details</summary><pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(metadata, null, 2)}</pre></details>
        </li>;
      })}
    </ol>
    {events.length > 50 && <div className="flex gap-2"><SecondaryButton disabled={page === 0} onClick={() => setPage(page - 1)}>Previous changes</SecondaryButton><SecondaryButton disabled={start + 50 >= events.length} onClick={() => setPage(page + 1)}>More changes</SecondaryButton></div>}
  </details>;
}
function SourceList({label, sources}: {label: string; sources: OwnerRestoreReview["nativeSources"]}) {
  const [page, setPage] = useState(0), start = page * 50;
  if (!sources.length) return null;
  return <details className="border-t border-line py-3"><summary className="cursor-pointer text-[13px] text-ink">{label} <span className="font-mono">({sources.length})</span></summary>
    <p className="text-[12px] text-muted">These records identify local owner work. Their times do not establish an order against accepted changes.</p>
    <ul className="space-y-2 pl-5 text-[12px] text-muted">{sources.slice(start, start + 50).map(source => <li key={source.source.deliveryId}><details><summary className="cursor-pointer">Local owner work <span className="font-mono">{source.source.deliveryId}</span></summary><pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(source, null, 2)}</pre></details></li>)}</ul>
    {sources.length > 50 && <div className="flex gap-2"><SecondaryButton disabled={page === 0} onClick={() => setPage(page - 1)}>Previous records</SecondaryButton><SecondaryButton disabled={start + 50 >= sources.length} onClick={() => setPage(page + 1)}>More records</SecondaryButton></div>}
  </details>;
}
function Review({review, emails}: {review: OwnerRestoreReview; emails: Emails}) {
  const outcomes = useMemo(() => ownerRestoreOutcomes(review), [review]);
  return <>
    <p className="text-[12px] text-muted" data-journal-cursor={review.point.journalCursor}>Restore point: {review.point.journalCursor === 0 ? "Before accepted edits" :
      <><time dateTime={new Date(review.selectedPointReceivedAtMs!).toISOString()}>{time(review.selectedPointReceivedAtMs!)}</time> · {author(review.selectedPointAuthority!, emails)}</>}</p>
    <p className="text-[13px] text-muted">Restoring removes the changes listed below from this file.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-[12px] text-muted">Current file<textarea aria-label="Current file before restore" readOnly value={review.content.frozenMarkdown} className="mt-1 h-56 w-full rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-ink" /></label>
      <label className="text-[12px] text-muted">After restoring<textarea aria-label="File after restore" readOnly value={review.content.restoredMarkdown} className="mt-1 h-56 w-full rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-ink" /></label>
    </div>
    <ChangeList label="Removed by this restore" events={outcomes.removed} emails={emails} />
    <SourceList label="Local owner work removed by this restore" sources={outcomes.local} />
    <ChangeList label="Already excluded by an earlier restore" events={outcomes.excluded} emails={emails} />
    <SourceList label="Local owner work already excluded" sources={outcomes.earlierLocal} />
    <p className="text-[12px] text-muted">This restore keeps the selected version of the file.</p>
    <SourceList label="Kept at or before the selected point" sources={outcomes.kept} />
  </>;
}

export function OwnerRestoreDialog({workspaceId, path, operationId, onClose, onBeforeRestore, onRestored, onError, onDeclineRefused, onSettled, onChanged}: {
  workspaceId: string; path: string;
  /** Opens this saved restore by its own status, without the choices for a new one. */
  operationId?: string;
  /** Closes the dialog with the restore it knows of, so an unfinished one stays in Notices. */
  onClose(operation: OwnerRestoreStatus | null): void;
  onBeforeRestore(): Promise<() => void>; onRestored(): void;
  /** Reports a refused start through the shell. The choice stays on screen. */
  onError(fallback: string, error: unknown): void;
  /** The relay refused to end this restore's Decline, so the shell offers no retry. */
  onDeclineRefused(operation: OwnerRestoreStatus): void;
  /** A start went through, so an earlier refusal no longer holds. */
  onSettled(): void;
  /** The restore began, was declined, or finished, even after the dialog closed. */
  onChanged(): void;
}) {
  const [state, setState] = useState<State>({kind: "loading"}), [busy, setBusy] = useState(false);
  // A Decline was asked for and has not ended the restore, so Retry asks again.
  const [declining, setDeclining] = useState(false);
  const [grantId, setGrantId] = useState(""), [point, setPoint] = useState("");
  // Kept across pages and steps, so the review names the people the choices named.
  const [emails, setEmails] = useState<Emails>(() => new Map());
  const request = useRequestSequence([workspaceId, path]), running = useRef(false), operation = useRef<OwnerRestoreStatus | null>(null);
  // Preparations in a row that did not finish, so a repeated one says so.
  const unprepared = useRef(0);
  const current = (token: number) => request.isCurrent(token);
  const close = () => onClose(operation.current);
  async function perform(work: (token: number) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); const token = request.next();
    try {await work(token);} catch (error) {if (current(token)) setState({kind: "error", message: ipcErrorMessage(error)});}
    finally {if (current(token)) {running.current = false; setBusy(false);}}
  }
  async function start(token: number, work: () => Promise<void>) {
    try {await work();} catch (error) {if (current(token)) onError(`dohc could not start restoring ${path}.`, error);}
  }
  async function load(token: number, beforeCursor?: number, grantCursor?: NonNullable<OwnerRestoreOptions["nextGrantCursor"]>) {
    const options = await bridge().ownerRestore({workspaceId, action: "options", path, ...(beforeCursor === undefined ? {} : {beforeCursor}), ...(grantCursor === undefined ? {} : {grantCursor})});
    if (!current(token)) return;
    setEmails(known => new Map([...known, ...[...options.grants, ...options.authors]
      .flatMap(row => row.userId !== null && row.email !== null ? [[row.userId, row.email] as const] : [])]));
    if (options.pendingOperation) await resume(token, options.pendingOperation.operationId);
    else {
      if (grantCursor === undefined) setPoint("");
      setState(previous => {
        if (previous.kind !== "options") return {kind: "options", options};
        if (grantCursor !== undefined) return {kind: "options", options: {...previous.options,
          grants: [...new Map([...previous.options.grants, ...options.grants].map(grant => [grant.grantId, grant])).values()],
          nextGrantCursor: options.nextGrantCursor}};
        if (beforeCursor !== undefined) return {kind: "options", options: {...options,
          grants: previous.options.grants, nextGrantCursor: previous.options.nextGrantCursor}};
        return {kind: "options", options};
      });
    }
  }
  // Where a saved restore stands, read by its own ID. It needs none of the
  // file's restore points, so it opens even after they are gone.
  async function resume(token: number, id: string) {
    const saved = await bridge().ownerRestore({workspaceId, action: "status", operationId: id});
    if (!current(token)) return;
    operation.current = saved;
    const stage = unfinishedRestoreStage(saved.phase);
    setState(stage ? {kind: "pending", message: STAGE_MESSAGES[stage]} : saved.phase === "declined" ? {kind: "declined"}
      : {kind: "error", message: "The restore changed. Close this review and open it again."});
  }
  useEffect(() => {
    const token = request.next();
    operation.current = null; setGrantId(""); setPoint(""); setEmails(new Map()); setDeclining(false); running.current = true; setBusy(true); setState({kind: "loading"});
    void (operationId === undefined ? load(token) : resume(token, operationId))
      .catch(error => {if (current(token)) setState({kind: "error", message: ipcErrorMessage(error)});})
      .finally(() => {if (current(token)) {running.current = false; setBusy(false);}});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path, operationId]);
  async function review(token: number) {
    const saved = await bridge().ownerRestore({workspaceId, action: "status", operationId: operation.current!.operationId});
    if (!current(token)) return;
    operation.current = saved;
    if (saved.phase === "declined") {setState({kind: "declined"}); return;}
    const resumablePhase = saved.phase === "relay-admitted" || saved.phase === "native-applied" || saved.phase === "settled" || saved.phase === "resumed";
    if (saved.proposalDigest && resumablePhase) {
      await confirm(token, saved.proposalDigest); return;
    }
    let proposalDigest = saved.proposalDigest;
    if (!proposalDigest) {
      const prepared = await bridge().ownerRestore({workspaceId, action: "prepare", operationId: saved.operationId});
      if (!current(token)) return;
      operation.current = prepared.status;
      if (prepared.status.phase === "declined") {setState({kind: "declined"}); return;}
      if (prepared.result.kind !== "prepared") {
        // The relay gives no cause beyond a full workspace, so a repeat says
        // only that it repeated and what stays stopped meanwhile.
        unprepared.current += 1;
        setState({kind: "pending", message: prepared.result.cause === "quota" ? QUOTA_MESSAGE
          : unprepared.current > 1 ? "dohc could not prepare the restore again. Live editing of this file stays stopped until it finishes. Retry later."
          : "dohc could not prepare the restore. Retry in a moment."});
        return;
      }
      unprepared.current = 0;
      proposalDigest = prepared.result.proposalDigest;
    }
    const checked = await bridge().ownerRestore({workspaceId, action: "review", operationId: saved.operationId});
    if (!current(token)) return;
    operation.current = checked.status;
    if (!checked.result || "kind" in checked.result) {setState({kind: "pending", message: "dohc could not prepare the full change review. Retry to review it again."}); return;}
    if (checked.result.operationId !== saved.operationId || checked.result.proposalDigest !== proposalDigest) throw Error("The restore review changed. Retry to review it again.");
    setState({kind: "review", review: checked.result});
  }
  async function confirm(token: number, proposalDigest: string) {
    const saved = operation.current!, release = await onBeforeRestore();
    try {
      if (!current(token)) return;
      const result = await bridge().ownerRestore({workspaceId, action: "confirm", operationId: saved.operationId, proposalDigest});
      const resumed = result.result.kind === "resumed" ? result.result : null;
      const finished = resumed !== null && result.status.phase === "resumed" && resumed.proposalDigest === proposalDigest;
      if (finished) onChanged();
      if (!current(token)) return;
      operation.current = result.status;
      if (finished) {
        setState({kind: "complete", moved: resumed.moved}); onRestored();
      } else setState({kind: "pending", message: result.result.kind !== "resumed" && result.result.cause === "quota" ? QUOTA_MESSAGE
        : result.result.kind === "review-required" ? "The restore needs a new review. Retry to review it again."
        : STAGE_MESSAGES.finishing});
    } finally {release();}
  }
  async function decline(token: number) {
    const saved = operation.current!;
    setDeclining(true);
    try {
      const {status, result} = await bridge().ownerRestore({workspaceId, action: "decline", operationId: saved.operationId});
      if (result.kind === "declined") onChanged();
      if (!current(token)) return;
      operation.current = status;
      if (result.kind === "declined") {setState({kind: "declined"}); return;}
      // The relay keeps the Decline and the fence. The shell files the refusal.
      setState({kind: "refused"});
      onDeclineRefused(status);
    } catch (error) {
      // The restore may have moved on in another window. Show where it stands.
      const latest = await bridge().ownerRestore({workspaceId, action: "status", operationId: saved.operationId}).catch(() => null);
      if (!latest || !current(token)) throw error;
      operation.current = latest;
      if (!beforeAdmission(latest.phase)) {setDeclining(false); throw error;}
      setState({kind: "pending", message: DECLINING_MESSAGE});
    }
  }
  // Decline is offered until the restore is admitted, wherever the dialog stopped.
  const declinable = !!operation.current && beforeAdmission(operation.current.phase) &&
    (state.kind === "pending" || state.kind === "error" || state.kind === "review");
  const labels = useMemo(() => state.kind === "options" ? pointLabels(state.options.points, emails) : new Map<number, string>(), [state, emails]);
  return <Overlay onClose={close} panelProps={{role: "dialog", "aria-modal": true, "aria-labelledby": "owner-restore-title", "data-testid": "owner-restore-dialog",
    className: "dohc-elevated dohc-pop-in w-[min(760px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5"}}>
    <h2 id="owner-restore-title" className="m-0 text-sm font-semibold text-ink">{state.kind === "stop" ? "Stop access before restoring?" : state.kind === "complete" ? state.moved ? "File moved before restoring" : "File restored"
      : state.kind === "declined" ? "Restore declined" : "Restore shared file"}</h2>
    <p className="break-all font-mono text-[12px] text-muted">{path}</p>
    {/* While the choices load, the lines show it and the status words are for the screen reader. */}
    <div role="status" aria-live="polite">{busy ? <p className={state.kind === "loading" ? "sr-only" : "text-[12px] text-muted"}>{state.kind === "loading" ? "Loading restore choices…" : "Preparing the restore…"}</p> : null}</div>
    {busy && state.kind === "loading" ? <SkeletonLines rows={2} className="my-3" /> : null}
    {state.kind === "options" && <div className="space-y-3">
      <p className="text-[13px] text-muted">Choose the access to stop and the change to restore to. Restoring keeps the file as it was after that change.</p>
      <label className="block text-[12px] text-muted">Access<select aria-label="Access to stop" disabled={busy} value={grantId} onChange={event => setGrantId(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-ink"><option value="">Choose access</option>{state.options.grants.map(grant => <option key={grant.grantId} value={grant.grantId}>{recipient(grant, emails)}</option>)}</select></label>
      <label className="block text-[12px] text-muted">Restore point<select aria-label="Shared restore point" disabled={busy} value={point} onChange={event => setPoint(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-ink"><option value="">Choose a change</option>{state.options.points.map(p => <option key={p.cursor} value={p.cursor}>{labels.get(p.cursor)}</option>)}</select></label>
      {!state.options.grants.length && state.options.nextGrantCursor === null && <p className="text-[12px] text-muted">No active edit access is available for this file. Close this review.</p>}
      {state.options.nextGrantCursor !== null && <SecondaryButton disabled={busy} onClick={() => void perform(token => load(token, undefined, state.options.nextGrantCursor!))}>More access choices</SecondaryButton>}
      {state.options.nextBeforeCursor !== null && <SecondaryButton disabled={busy} onClick={() => void perform(token => load(token, state.options.nextBeforeCursor!))}>Earlier changes</SecondaryButton>}
    </div>}
    {state.kind === "stop" && <>
      <p className="text-[13px] text-ink">This access stays stopped, even if you decline the restore.</p>
      {state.plan.recipients.some(row => row.principalKind === "link") && <p className="text-[13px] text-muted">The old link will stop working.</p>}
      <p className="text-[13px] text-muted">Restoring is a separate decision. If you decline, the file stays unchanged. Live editing through this access stays stopped until you share the file again.</p>
      <ul className="space-y-1 pl-5 text-[13px] text-muted">{state.plan.recipients.map(row => <li key={row.grantId}>{recipient(row, emails)}</li>)}</ul>
      <p className="text-[13px] text-muted">Next, review the changes to remove before restoring the file.</p>
    </>}
    {state.kind === "review" && <Review key={state.review.proposalDigest} review={state.review} emails={emails} />}
    {state.kind === "pending" || state.kind === "error" ? <p role="alert" className="text-[13px] text-muted">{state.message}</p> : null}
    {state.kind === "refused" && <p role="alert" className="text-[13px] text-muted">{DECLINE_REFUSED_MESSAGE}</p>}
    {operation.current && state.kind !== "complete" && state.kind !== "declined" && <p className="text-[12px] text-muted">{declinable
      ? "Access has stopped. Declining keeps the file unchanged. Live editing through this access stays stopped until you share the file again."
      : "Access has stopped. Closing this review does not restore the old access."}</p>}
    {state.kind === "complete" && <p className="text-[13px] text-muted">{state.moved
      ? "The file moved before the restore finished, so the renamed file is unchanged. Share again when you want to give access."
      : "The file has been restored. Share again when you want to give access."}</p>}
    {state.kind === "declined" && <p className="text-[13px] text-muted">The file stays unchanged. Live editing through this access stays stopped until you share the file again.</p>}
    <div className="mt-4 flex justify-end gap-2">
      <SecondaryButton onClick={close}>{state.kind === "stop" ? "Cancel" : "Close"}</SecondaryButton>
      {state.kind === "options" && <PrimaryButton disabled={busy || !grantId || point === ""} onClick={() => void perform(token => start(token, async () => {
        const selected = state.options.points.find(p => String(p.cursor) === point)!, grant = state.options.grants.find(g => g.grantId === grantId)!;
        const plan = await bridge().ownerRestore({workspaceId, action: "plan", document: state.options.document, shareId: grant.shareId, grantId,
          restorePointCursor: selected.cursor, restorePointReceiptDigest: selected.receiptDigest});
        if (!current(token)) return;
        onSettled(); setState({kind: "stop", plan});
      }))}>Review affected access</PrimaryButton>}
      {state.kind === "stop" && <DangerButton disabled={busy} onClick={() => void perform(async token => {
        let stopped: OwnerRestoreStatus | undefined;
        await start(token, async () => {stopped = await bridge().ownerRestore({workspaceId, action: "begin", intent: state.plan.intent});});
        if (stopped) onChanged();
        if (!stopped || !current(token)) return; operation.current = stopped; onSettled(); await review(token);
      })}>Stop access</DangerButton>}
      {state.kind === "review" && <PrimaryButton disabled={busy} onClick={() => void perform(token => confirm(token, state.review.proposalDigest))}>Restore file</PrimaryButton>}
      {declinable && !declining && <SecondaryButton disabled={busy} onClick={() => void perform(token => decline(token))}>Decline restore</SecondaryButton>}
      {(state.kind === "pending" || state.kind === "error") && <PrimaryButton disabled={busy} onClick={() => void perform(token => declining ? decline(token)
        : operation.current ? review(token) : operationId === undefined ? load(token) : resume(token, operationId))}>
        {!declining && operation.current?.phase === "authority-invalidated" ? "Review restore" : "Retry"}</PrimaryButton>}
    </div>
  </Overlay>;
}
